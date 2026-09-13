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
    this.dataController = null;
    this.masterGain = null;
    this.ambientGain = null;
    this.dataGain = null;
    this.noiseNodes = [];
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
    // Warm low cluster only (meditation-app style)
    for (let i = 0; i < 5; i++) {
      const seed = hash + i * 1000;
      params.baseFreqs.push(55 + this.seededRandom(seed) * 140);
      params.volumes.push(0.04 + this.seededRandom(seed + 100) * 0.05);
      params.detunes.push((this.seededRandom(seed + 200) - 0.5) * 12);
      params.lfoRates.push(0.03 + this.seededRandom(seed + 300) * 0.12);
    }
    return params;
  }

  playHandshake(at) {
    const P = MindwhisperProtocol;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const filter = this.audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
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
    gain.gain.linearRampToValueAtTime(0.06, g0 + 0.15);
    gain.gain.linearRampToValueAtTime(0.035, g0 + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.001, g0 + P.HANDSHAKE_GLIDE_DUR + 0.6);
    osc.start(g0);
    osc.stop(g0 + P.HANDSHAKE_GLIDE_DUR + 0.65);
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
    filter.frequency.value = 280;
    filter.Q.value = 0.5;
    lfo.frequency.value = lfoRate;
    lfoGain.gain.value = volume * 0.45;
    gain.gain.value = volume * 0.75;

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

  /** Soft pink-ish bed — calm app texture, not buzz. */
  createNoiseBed(startTime) {
    const bufferSize = this.audioContext.sampleRate * 4;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }

    const noise = this.audioContext.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const low = this.audioContext.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 240;
    low.Q.value = 0.4;

    const gain = this.audioContext.createGain();
    gain.gain.value = 0.035;

    // Slow “cloud” movement
    const lfo = this.audioContext.createOscillator();
    const lfoGain = this.audioContext.createGain();
    lfo.frequency.value = 0.05;
    lfoGain.gain.value = 0.012;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    noise.connect(low);
    low.connect(gain);
    gain.connect(this.ambientGain);
    lfo.start(startTime);
    noise.start(startTime);
    this.noiseNodes.push(noise);
    this.oscillators.push(lfo);
    this.gainNodes.push(gain);
  }

  playBreathCue(type, time) {
    MindwhisperProtocol.playBreathTaps(
      this.audioContext,
      this.masterGain,
      type,
      time,
    );
    this.notifyBreath(type, time);
  }

  scheduleBreathsForLoop(loopNumber) {
    const P = MindwhisperProtocol;
    const loopTime = this.loopStartTime + loopNumber * this.loopDuration;
    const inhaleTime = loopTime + P.INHALE_AT;
    const exhaleTime = loopTime + P.EXHALE_AT;
    if (inhaleTime > this.nextScheduleTime) {
      this.playBreathCue("inhale", inhaleTime);
    }
    if (exhaleTime > this.nextScheduleTime) {
      this.playBreathCue("exhale", exhaleTime);
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
    const P = MindwhisperProtocol;
    const now = this.audioContext.currentTime;
    if (now < this.loopStartTime) {
      return { phase: "opening", elapsed: 0, cycleProgress: 0 };
    }
    const elapsed = now - this.loopStartTime;
    const cycleTime = elapsed % this.loopDuration;
    let phase = "rest";
    if (cycleTime >= P.INHALE_AT && cycleTime < P.INHALE_AT + 4.5) phase = "inhale";
    else if (cycleTime >= P.EXHALE_AT && cycleTime < P.EXHALE_AT + 4.5) phase = "exhale";
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
    this.loopDuration = P.LOOP_DUR;

    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioContext.destination);

    this.ambientGain = this.audioContext.createGain();
    this.ambientGain.gain.value = 1.0;
    this.ambientGain.connect(this.masterGain);

    this.dataGain = this.audioContext.createGain();
    this.dataGain.gain.value = 0.85;
    this.dataGain.connect(this.masterGain);

    const t0 = this.audioContext.currentTime;
    this.playHandshake(t0);

    const ambientAt = t0 + 0.9;
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
    this.createNoiseBed(ambientAt);

    this.dataController = P.startDataMultiplex(
      this.audioContext,
      this.dataGain,
      this.normalizedWord,
      ambientAt + 0.6,
    );

    this.loopStartTime = ambientAt + 0.8;
    this.nextScheduleTime = this.loopStartTime;
    this.scheduler();
  }

  stop() {
    this.isPlaying = false;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.dataController) {
      this.dataController.stop();
      this.dataController = null;
    }
    this.oscillators.forEach((osc) => {
      try { osc.stop(); } catch (_) {}
    });
    this.noiseNodes.forEach((n) => {
      try { n.stop(); } catch (_) {}
    });
    this.oscillators = [];
    this.gainNodes = [];
    this.noiseNodes = [];
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
