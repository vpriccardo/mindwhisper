class MindwhisperEngine {
  constructor() {
    this.audioContext = null;
    this.isPlaying = false;
    this.loopStartTime = 0;
    this.loopDuration = 15;
    this.currentWord = "";
    this.normalizedWord = "";
    this.oscillators = [];
    this.spa = null;
    this.masterGain = null;
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

    const t0 = this.audioContext.currentTime;
    const ambientAt = t0 + 0.15;
    this.spa = new SpaAmbience(this.audioContext, this.masterGain);
    await this.spa.start(this.normalizedWord || word, ambientAt, "mist-grove");

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
    if (this.spa) {
      this.spa.stop();
      this.spa = null;
    }
    this.oscillators.forEach((osc) => {
      try { osc.stop(); } catch (_) {}
    });
    this.oscillators = [];
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
