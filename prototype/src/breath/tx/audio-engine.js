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
    this.ambientGain = null;
    this.noiseNode = null;
    this.schedulerTimer = null;
    this.beaconTimer = null;
    this.nextScheduleTime = 0;
    this.scheduleAhead = 30.0;
    this.nextBeaconAt = 0;
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
    for (let i = 0; i < 6; i++) {
      const seed = hash + i * 1000;
      // Warm low–mid pad only (stays under bowl beacon band)
      params.baseFreqs.push(55 + this.seededRandom(seed) * 180);
      params.volumes.push(0.045 + this.seededRandom(seed + 100) * 0.06);
      params.detunes.push((this.seededRandom(seed + 200) - 0.5) * 18);
      params.lfoRates.push(0.05 + this.seededRandom(seed + 300) * 0.25);
    }
    return params;
  }

  playHandshake(at) {
    const P = MindwhisperProtocol;
    // Soft tick — quieter, shorter
    const tick = this.audioContext.createOscillator();
    const tickGain = this.audioContext.createGain();
    tick.connect(tickGain);
    tickGain.connect(this.masterGain);
    tick.frequency.value = P.TICK_FREQ;
    tickGain.gain.setValueAtTime(0, at);
    tickGain.gain.linearRampToValueAtTime(0.06, at + 0.01);
    tickGain.gain.exponentialRampToValueAtTime(0.001, at + 0.1);
    tick.start(at);
    tick.stop(at + 0.12);

    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const filter = this.audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    const g0 = at + P.HANDSHAKE_GLIDE_START;
    osc.type = "sine";
    osc.frequency.setValueAtTime(P.HANDSHAKE_START, g0);
    osc.frequency.exponentialRampToValueAtTime(
      P.HANDSHAKE_END,
      g0 + P.HANDSHAKE_GLIDE_DUR,
    );
    gain.gain.setValueAtTime(0, g0);
    gain.gain.linearRampToValueAtTime(0.14, g0 + 0.08);
    gain.gain.linearRampToValueAtTime(0.08, g0 + 0.45);
    gain.gain.exponentialRampToValueAtTime(0.001, g0 + P.HANDSHAKE_GLIDE_DUR + 0.35);
    osc.start(g0);
    osc.stop(g0 + P.HANDSHAKE_GLIDE_DUR + 0.4);
  }

  duckAmbientForBeacon(beaconStart, beaconEnd) {
    if (!this.ambientGain) return;
    const g = this.ambientGain.gain;
    const now = this.audioContext.currentTime;
    const t0 = Math.max(beaconStart - 0.15, now);
    g.cancelScheduledValues(t0);
    g.setValueAtTime(g.value, t0);
    // Gentle duck — keep pad present under bowls
    g.linearRampToValueAtTime(0.45, beaconStart);
    g.setValueAtTime(0.45, beaconEnd);
    g.linearRampToValueAtTime(1.0, beaconEnd + 0.6);
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
    filter.frequency.value = 480;
    filter.Q.value = 0.7;
    lfo.frequency.value = lfoRate;
    lfoGain.gain.value = volume * 0.35;
    gain.gain.value = volume * 0.65;

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
    noiseFilter.frequency.value = 220;
    noiseFilter.Q.value = 0.6;
    const noiseGain = this.audioContext.createGain();
    noiseGain.gain.value = 0.018;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.ambientGain);
    this.noiseNode = noise;
    this.gainNodes.push(noiseGain);
    noise.start(startTime);
  }

  playBreathCue(type, time) {
    // Soft bowl-ish breath cue (not a beep)
    const base = type === "inhale" ? 392 : 330; // G4 / E4
    const end = type === "inhale" ? 494 : 262; // B4 / C4
    const dur = 0.7;
    MindwhisperProtocol.playBowl(this.audioContext, this.masterGain, base, time, dur, 0.07);
    // Second partial slides gently
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base * 2, time);
    osc.frequency.linearRampToValueAtTime(end * 2, time + dur);
    osc.connect(gain);
    gain.connect(this.masterGain);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.025, time + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.start(time);
    osc.stop(time + dur + 0.05);
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

  beaconScheduler() {
    if (!this.isPlaying) return;
    const P = MindwhisperProtocol;
    const now = this.audioContext.currentTime;
    const lookAhead = 25;
    while (this.nextBeaconAt < now + lookAhead) {
      const start = this.nextBeaconAt;
      const end = P.playWordBeacon(
        this.audioContext,
        this.masterGain,
        this.normalizedWord,
        start,
      );
      this.duckAmbientForBeacon(start, end);
      this.nextBeaconAt += P.BEACON_INTERVAL;
    }
    this.beaconTimer = setTimeout(() => this.beaconScheduler(), 4000);
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

    const t0 = this.audioContext.currentTime;
    this.playHandshake(t0);

    // Ambient starts almost immediately — pad is the bed
    const ambientAt = t0 + 1.2;
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

    this.loopStartTime = ambientAt + 0.5;
    this.nextScheduleTime = this.loopStartTime;
    this.scheduler();

    this.nextBeaconAt = t0 + P.FIRST_BEACON_AT;
    this.beaconScheduler();
  }

  stop() {
    this.isPlaying = false;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.beaconTimer) {
      clearTimeout(this.beaconTimer);
      this.beaconTimer = null;
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
