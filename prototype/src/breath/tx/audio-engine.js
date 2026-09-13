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
    this.masterGain = null;
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
    for (let i = 0; i < 5; i++) {
      const seed = hash + i * 1000;
      params.baseFreqs.push(80 + this.seededRandom(seed) * 300);
      params.volumes.push(0.06 + this.seededRandom(seed + 100) * 0.09);
      params.detunes.push((this.seededRandom(seed + 200) - 0.5) * 20);
      params.lfoRates.push(0.1 + this.seededRandom(seed + 300) * 0.4);
    }
    return params;
  }

  playHandshake(at) {
    const P = MindwhisperProtocol;
    const tick = this.audioContext.createOscillator();
    const tickGain = this.audioContext.createGain();
    tick.connect(tickGain);
    tickGain.connect(this.masterGain);
    tick.frequency.value = P.TICK_FREQ;
    tickGain.gain.setValueAtTime(0, at);
    tickGain.gain.linearRampToValueAtTime(0.12, at + 0.005);
    tickGain.gain.exponentialRampToValueAtTime(0.001, at + 0.08);
    tick.start(at);
    tick.stop(at + 0.1);

    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(this.masterGain);
    const g0 = at + P.HANDSHAKE_GLIDE_START;
    osc.frequency.setValueAtTime(P.HANDSHAKE_START, g0);
    osc.frequency.exponentialRampToValueAtTime(
      P.HANDSHAKE_END,
      g0 + P.HANDSHAKE_GLIDE_DUR,
    );
    gain.gain.setValueAtTime(0, g0);
    gain.gain.linearRampToValueAtTime(0.28, g0 + 0.05);
    gain.gain.linearRampToValueAtTime(0.14, g0 + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.001, g0 + P.HANDSHAKE_GLIDE_DUR + 0.2);
    osc.start(g0);
    osc.stop(g0 + P.HANDSHAKE_GLIDE_DUR + 0.25);
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
    filter.frequency.value = 800;
    filter.Q.value = 1;
    lfo.frequency.value = lfoRate;
    lfoGain.gain.value = volume * 0.3;
    gain.gain.value = volume * 0.7;

    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

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
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.value = 200;
    const noiseGain = this.audioContext.createGain();
    noiseGain.gain.value = 0.015;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.masterGain);
    this.noiseNode = noise;
    this.gainNodes.push(noiseGain);
    noise.start(startTime);
  }

  playBreathCue(type, time) {
    const osc1 = this.audioContext.createOscillator();
    const osc2 = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const filter = this.audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2000;
    filter.Q.value = 2;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    const duration = 0.4;
    if (type === "inhale") {
      osc1.frequency.setValueAtTime(440, time);
      osc1.frequency.linearRampToValueAtTime(550, time + duration);
      osc2.frequency.setValueAtTime(880, time);
      osc2.frequency.linearRampToValueAtTime(1100, time + duration);
    } else {
      osc1.frequency.setValueAtTime(440, time);
      osc1.frequency.linearRampToValueAtTime(330, time + duration);
      osc2.frequency.setValueAtTime(880, time);
      osc2.frequency.linearRampToValueAtTime(660, time + duration);
    }
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.08, time + 0.08);
    gain.gain.linearRampToValueAtTime(0.05, time + duration * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
    osc1.type = "sine";
    osc2.type = "sine";
    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + duration + 0.1);
    osc2.stop(time + duration + 0.1);
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
      return { phase: "handshake", elapsed: now - (this.loopStartTime - MindwhisperProtocol.ambientStartOffset(this.normalizedWord)), cycleProgress: 0 };
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

    const t0 = this.audioContext.currentTime;
    this.playHandshake(t0);
    P.playWordPayload(
      this.audioContext,
      this.masterGain,
      this.normalizedWord,
      t0 + P.PAYLOAD_START_TIME,
    );

    const ambientAt = t0 + P.ambientStartOffset(this.normalizedWord);
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

    this.loopStartTime = ambientAt;
    this.nextScheduleTime = ambientAt;
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
    if (this.noiseNode) {
      try { this.noiseNode.stop(); } catch (_) {}
      this.noiseNode = null;
    }
    this.oscillators = [];
    this.gainNodes = [];
    this.breathCallbacks = [];
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
