class MindwhisperEngine {
  constructor() {
    this.audioContext = null;
    this.isPlaying = false;
    this.loopStartTime = 0;
    this.loopDuration = 15;
    this.currentWord = "";
    this.normalizedWord = "";
    this.oscillators = [];
    this.gainNodes = [];
    this.dataNodes = [];
    this.masterGain = null;
    this.ambientGain = null;
    this.dataGain = null;
    this.noiseNode = null;
    this.schedulerTimer = null;
    this.nextScheduleTime = 0;
    this.scheduleAhead = 30.0;
    this.breathCallbacks = [];
  }

  async initialize() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  seededRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  generateAmbienceParams(word) {
    const hash = this.simpleHash(word.toLowerCase());
    const params = { baseFreqs: [], volumes: [], detunes: [], lfoRates: [] };
    for (let i = 0; i < 7; i++) {
      const seed = hash + i * 1000;
      // Warm low pad only — below data band (~920+)
      params.baseFreqs.push(48 + this.seededRandom(seed) * 220);
      params.volumes.push(0.05 + this.seededRandom(seed + 100) * 0.07);
      params.detunes.push((this.seededRandom(seed + 200) - 0.5) * 16);
      params.lfoRates.push(0.04 + this.seededRandom(seed + 300) * 0.2);
    }
    return params;
  }

  playHandshake(at) {
    const P = MindwhisperProtocol;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const filter = this.audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    osc.type = "sine";
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    const g0 = at + P.HANDSHAKE_GLIDE_START;
    osc.frequency.setValueAtTime(P.HANDSHAKE_START, g0);
    osc.frequency.exponentialRampToValueAtTime(
      P.HANDSHAKE_END,
      g0 + P.HANDSHAKE_GLIDE_DUR,
    );
    gain.gain.setValueAtTime(0, g0);
    gain.gain.linearRampToValueAtTime(0.09, g0 + 0.12);
    gain.gain.linearRampToValueAtTime(0.05, g0 + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.001, g0 + P.HANDSHAKE_GLIDE_DUR + 0.5);
    osc.start(g0);
    osc.stop(g0 + P.HANDSHAKE_GLIDE_DUR + 0.55);
  }

  createAmbientLayer(frequency, volume, detune, lfoRate, startTime) {
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const lfoGain = this.audioContext.createGain();
    const lfo = this.audioContext.createOscillator();
    const filter = this.audioContext.createBiquadFilter();

    osc.type = "sine";
    osc.frequency.value = frequency;
    osc.detune.value = detune;
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.6;
    lfo.frequency.value = lfoRate;
    lfoGain.gain.value = volume * 0.4;
    gain.gain.value = volume * 0.7;

    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ambientGain);

    this.oscillators.push(osc, lfo);
    this.gainNodes.push(gain);
    lfo.start(startTime);
    return osc;
  }

  createNoiseLayer(startTime) {
    const bufferSize = this.audioContext.sampleRate * 2;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = this.audioContext.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const noiseFilter = this.audioContext.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 180;
    noiseFilter.Q.value = 0.5;
    const noiseGain = this.audioContext.createGain();
    noiseGain.gain.value = 0.022;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.ambientGain);
    this.noiseNode = noise;
    this.gainNodes.push(noiseGain);
    noise.start(startTime);
  }

  playBreathCue(type, time) {
    const base = type === "inhale" ? 196 : 147; // G3 / D3 — low, soft
    const dur = 1.1;
    const osc = this.audioContext.createOscillator();
    const osc2 = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const filter = this.audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 600;
    osc.type = "sine";
    osc2.type = "sine";
    osc.frequency.setValueAtTime(base, time);
    osc.frequency.linearRampToValueAtTime(
      type === "inhale" ? base * 1.25 : base * 0.8,
      time + dur,
    );
    osc2.frequency.value = base * 2;
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.045, time + 0.2);
    gain.gain.linearRampToValueAtTime(0.03, time + dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.start(time);
    osc2.start(time);
    osc.stop(time + dur + 0.05);
    osc2.stop(time + dur + 0.05);
  }

  scheduleBreathsForLoop(loopNumber) {
    const loopTime = this.loopStartTime + loopNumber * this.loopDuration;
    const inhaleTime = loopTime + 2;
    const exhaleTime = loopTime + 8.5;
    if (inhaleTime > this.nextScheduleTime) {
      this.playBreathCue("inhale", inhaleTime);
      this.notifyBreath("inhale", inhaleTime);
    }
    if (exhaleTime > this.nextScheduleTime) {
      this.playBreathCue("exhale", exhaleTime);
      this.notifyBreath("exhale", exhaleTime);
    }
  }

  scheduler() {
    if (!this.isPlaying) return;
    const now = this.audioContext.currentTime;
    while (this.nextScheduleTime < now + this.scheduleAhead) {
      const loopNumber = Math.floor(
        (this.nextScheduleTime - this.loopStartTime) / this.loopDuration,
      );
      this.scheduleBreathsForLoop(Math.max(0, loopNumber));
      this.nextScheduleTime += this.loopDuration;
    }
    this.schedulerTimer = setTimeout(() => this.scheduler(), 5000);
  }

  onBreath(callback) {
    this.breathCallbacks.push(callback);
  }

  notifyBreath(type, time) {
    this.breathCallbacks.forEach((cb) => cb(type, time));
  }

  getPhase() {
    if (!this.isPlaying || !this.audioContext) {
      return { phase: "idle", elapsed: 0, cycleProgress: 0 };
    }
    const now = this.audioContext.currentTime;
    if (now < this.loopStartTime) {
      return { phase: "opening", elapsed: 0, cycleProgress: 0 };
    }
    const elapsed = now - this.loopStartTime;
    const cycleTime = elapsed % this.loopDuration;
    let phase = "rest";
    if (cycleTime >= 2 && cycleTime < 7) phase = "inhale";
    else if (cycleTime >= 8.5 && cycleTime < 13.5) phase = "exhale";
    return {
      phase,
      elapsed,
      cycleTime,
      cycleProgress: cycleTime / this.loopDuration,
      loopNumber: Math.floor(elapsed / this.loopDuration),
    };
  }

  async start(word) {
    await this.initialize();
    if (this.isPlaying) this.stop();

    const P = MindwhisperProtocol;
    this.currentWord = word;
    this.normalizedWord = P.normalizeWord(word);
    this.isPlaying = true;
    this.breathCallbacks = [];

    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioContext.destination);

    this.ambientGain = this.audioContext.createGain();
    this.ambientGain.gain.value = 1.0;
    this.ambientGain.connect(this.masterGain);

    // Slow LFO on data bus so partials “breathe” with the pad
    this.dataGain = this.audioContext.createGain();
    this.dataGain.gain.value = 1.0;
    this.dataGain.connect(this.masterGain);
    const dataLfo = this.audioContext.createOscillator();
    const dataLfoGain = this.audioContext.createGain();
    dataLfo.frequency.value = 0.08;
    dataLfoGain.gain.value = 0.25;
    dataLfo.connect(dataLfoGain);
    dataLfoGain.connect(this.dataGain.gain);
    dataLfo.start();
    this.oscillators.push(dataLfo);

    const t0 = this.audioContext.currentTime;
    this.playHandshake(t0);

    const ambientAt = t0 + 0.8;
    const params = this.generateAmbienceParams(this.normalizedWord || word);
    for (let i = 0; i < params.baseFreqs.length; i++) {
      const osc = this.createAmbientLayer(
        params.baseFreqs[i],
        params.volumes[i],
        params.detunes[i],
        params.lfoRates[i],
        ambientAt,
      );
      osc.start(ambientAt);
    }
    this.createNoiseLayer(ambientAt);

    // Continuous quiet word chord — no beacons
    this.dataNodes = P.startDataChord(
      this.audioContext,
      this.dataGain,
      this.normalizedWord,
      ambientAt + 0.5,
    );

    this.loopStartTime = ambientAt + 1.0;
    this.nextScheduleTime = this.loopStartTime;
    this.scheduler();
  }

  stop() {
    this.isPlaying = false;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.oscillators.forEach((osc) => {
      try { osc.stop(); } catch (_) {}
    });
    this.dataNodes.forEach(({ osc, gain }) => {
      try {
        const t = this.audioContext ? this.audioContext.currentTime : 0;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0.001, t + 0.3);
        osc.stop(t + 0.35);
      } catch (_) {}
    });
    if (this.noiseNode) {
      try { this.noiseNode.stop(); } catch (_) {}
      this.noiseNode = null;
    }
    this.oscillators = [];
    this.gainNodes = [];
    this.dataNodes = [];
    this.breathCallbacks = [];
    if (this.dataGain) {
      this.dataGain.disconnect();
      this.dataGain = null;
    }
    if (this.ambientGain) {
      this.ambientGain.disconnect();
      this.ambientGain = null;
    }
    if (this.masterGain) {
      this.masterGain.disconnect();
      this.masterGain = null;
    }
  }

  getStatus() {
    return {
      isPlaying: this.isPlaying,
      word: this.currentWord,
      normalizedWord: this.normalizedWord,
      duration: this.loopDuration,
    };
  }
}
