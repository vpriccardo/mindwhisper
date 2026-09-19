/**
 * call-v2 TX: "the music itself is the carrier." Tiny self-cancelling
 * differential EQ modulation applied directly to the (already crossfaded)
 * Meditation music bus — no separate additive carrier bus, no independent
 * sound source (contrast with call-v1's CallCarrierBank).
 */

import { buildCallV2TransmitSymbols } from './call-v2-protocol.js';
import { CallV2EqBank } from './call-v2-dsp.js';
import {
  CALL_V2_PAIRS,
  CALL_V2_CHANNEL_COUNT,
  CALL_V2_Q_DEFAULT,
  CALL_V2_DEPTH_PRESETS,
  CALL_V2_DEFAULT_DEPTH,
  CALL_V2_SPEED_PRESETS,
  CALL_V2_DEFAULT_SPEED,
  CALL_V2_TRANSITION_MS,
  callV2SymbolMsForSpeed,
} from './call-v2-constants.js';
import {
  CrossfadeMusicEngine,
  decodeMeditationBuffer,
  preloadMeditationAudio,
  getMeditationLoadMeta,
  setMeditationMusicStats,
  MUSIC_CROSSFADE_SECONDS,
  MUSIC_STOP_FADE_SECONDS,
} from '../meditation-audio.js';
import { ACOUSTIC_CONFIG, measureAudioBufferStats, rampGainTo } from '../acoustic-config.js';

export { preloadMeditationAudio, getMeditationLoadMeta, ACOUSTIC_CONFIG };

export function callV2DepthDb(depthId) {
  return CALL_V2_DEPTH_PRESETS[depthId] ?? CALL_V2_DEPTH_PRESETS[CALL_V2_DEFAULT_DEPTH];
}

/**
 * Stateful offline/synthetic renderer: processes an existing music PCM
 * stream (already crossfaded — §49) sample-by-sample through the EQ bank,
 * continuously repeating the frame forever. Used by Node tests and by the
 * (non-realtime) A/B render path; the LIVE engine below uses the same
 * symbol timing logic but drives real BiquadFilterNode automation instead.
 */
export class CallV2StreamingProcessor {
  constructor(opts) {
    const {
      message,
      sampleRate,
      depthId = CALL_V2_DEFAULT_DEPTH,
      depthDb = null,
      speedId = CALL_V2_DEFAULT_SPEED,
      Q = CALL_V2_Q_DEFAULT,
      neutral = false,
    } = opts;

    this.sampleRate = sampleRate;
    this.depthId = depthId;
    this.totalDeltaDb = neutral ? 0 : depthDb != null ? depthDb : callV2DepthDb(depthId);
    this.halfDeltaDb = this.totalDeltaDb / 2;
    this.speedId = speedId;
    this.symbolMs = callV2SymbolMsForSpeed(speedId);
    this.Q = Q;
    this.neutral = neutral;

    const built = buildCallV2TransmitSymbols(message);
    this.encoded = built;
    this.frameSymbols = built.frameSymbols;
    this.symbolSamples = Math.round((this.symbolMs / 1000) * sampleRate);
    this.halfSamples = Math.round(this.symbolSamples / 2);
    this.transitionSamples = Math.max(
      1,
      Math.round((CALL_V2_TRANSITION_MS / 1000) * sampleRate)
    );
    this.frameSamples = this.symbolSamples * this.frameSymbols.length;

    this.eqBank = new CallV2EqBank(CALL_V2_PAIRS, sampleRate, Q);
    this.dataSampleIndex = 0;
    this.lastHalfKey = null;
    this.framesTransmitted = 0;
  }

  _symbolAt(i) {
    if (i < 0) return 0;
    return this.frameSymbols[i % this.frameSymbols.length];
  }

  /**
   * Process `musicInput` (the post-crossfade music bus PCM) through the
   * EQ bank, advancing the continuous symbol clock. Returns a new buffer;
   * `musicInput` is left untouched.
   */
  process(musicInput, opts = {}) {
    const { watermarkEnabled = true } = opts;
    const n = musicInput.length;
    const out = new Float32Array(n);
    const active = watermarkEnabled && !this.neutral && this.halfDeltaDb > 0;

    for (let i = 0; i < n; i++) {
      if (active) {
        const symIndex = Math.floor(this.dataSampleIndex / this.symbolSamples);
        const posInSym = this.dataSampleIndex % this.symbolSamples;
        const half = posInSym < this.halfSamples ? 0 : 1;
        const halfKey = symIndex * 2 + half;
        if (halfKey !== this.lastHalfKey) {
          const sym = this._symbolAt(symIndex);
          for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
            const bit = (sym >> (CALL_V2_CHANNEL_COUNT - 1 - p)) & 1;
            this.eqBank.scheduleSymbolHalf(p, bit, half, this.halfDeltaDb, this.transitionSamples);
          }
          this.lastHalfKey = halfKey;
        }
      } else if (this.lastHalfKey !== 'off') {
        this.eqBank.setAllGainsImmediate(0);
        this.lastHalfKey = 'off';
      }
      out[i] = this.eqBank.processSample(musicInput[i]);
      this.dataSampleIndex++;
    }
    this.framesTransmitted = Math.floor(this.dataSampleIndex / this.frameSamples);
    return out;
  }
}

/**
 * Offline render helper for tests: synthesizes (or accepts) a music PCM
 * buffer, repeats it to cover N frames, and watermarks it in one pass.
 */
export function renderCallV2Transmission(opts) {
  const {
    message,
    sampleRate,
    musicSamples, // Float32Array — real or synthetic "already-crossfaded" music
    frameCount = 2,
    depthId = CALL_V2_DEFAULT_DEPTH,
    depthDb = null,
    speedId = CALL_V2_DEFAULT_SPEED,
    Q = CALL_V2_Q_DEFAULT,
    neutral = false,
    watermarkEnabled = true,
  } = opts;

  const processor = new CallV2StreamingProcessor({
    message,
    sampleRate,
    depthId,
    depthDb,
    speedId,
    Q,
    neutral,
  });
  const totalSamples = processor.frameSamples * frameCount;
  // Loop the provided music buffer to reach totalSamples (tests may supply
  // a shorter real MP3 clip or a synthetic signal).
  const music = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    music[i] = musicSamples[i % musicSamples.length];
  }
  const watermarked = processor.process(music, { watermarkEnabled });

  let peak = 0;
  for (let i = 0; i < watermarked.length; i++) {
    const a = Math.abs(watermarked[i]);
    if (a > peak) peak = a;
  }

  return {
    samples: watermarked,
    musicSamples: music,
    sampleRate,
    peak,
    encoded: processor.encoded,
    symbolSamples: processor.symbolSamples,
    frameSamples: processor.frameSamples,
    symbolMs: processor.symbolMs,
    totalDeltaDb: processor.totalDeltaDb,
    durationMs: (watermarked.length / sampleRate) * 1000,
  };
}

// ---------------------------------------------------------------------------
// Live production engine — real BiquadFilterNode + AudioParam automation.
// ---------------------------------------------------------------------------

/**
 * Live continuous call-v2 transmitter. Audio routing (§24):
 *   Meditation AudioBuffer → CrossfadeMusicEngine → musicBus
 *     → [12 cascaded BiquadFilterNode('peaking')] → masterGain → destination
 * There is NO separate watermark bus/source — the EQ bank processes the
 * music signal in place. When watermarking is disabled, every filter gain
 * is 0 dB and the graph passes the original Meditation playback through
 * unmodified (§23).
 */
export class CallV2ContinuousTransmitter {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.musicBus = null; // pre-EQ (crossfade output)
    this.eqOutputGain = null; // post-EQ, feeds masterGain
    this.filterNodes = []; // 12 BiquadFilterNode, in series
    this.musicEngine = null;
    this.playing = false;
    this.stopping = false;

    this.message = '';
    this.depthId = CALL_V2_DEFAULT_DEPTH;
    this.speedId = CALL_V2_DEFAULT_SPEED;
    this.Q = CALL_V2_Q_DEFAULT;
    this.watermarkEnabled = true;
    this.musicOnly = false;

    this.encoded = null;
    this.frameSymbols = null;
    this.symbolMs = callV2SymbolMsForSpeed(this.speedId);
    this.symbolSamples = 0;
    this.halfSamples = 0;
    this.transitionS = CALL_V2_TRANSITION_MS / 1000;

    this.musicGain = ACOUSTIC_CONFIG.meditationMusicGain;
    this.crossfadeSeconds = MUSIC_CROSSFADE_SECONDS;
    this.meditationMeta = null;
    this.musicStats = null;

    this.nextSymbolIndex = 0;
    this.nextSymbolTime = 0;
    this.timer = null;
    this.LOOKAHEAD_S = 2.0;
    this.sessionStartPerf = 0;
    this.framesScheduled = 0;
    this.onState = null;
  }

  createContextSync() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.ctx;
  }

  async unlockAudio() {
    const ctx = this.createContextSync();
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    if (ctx.state === 'suspended') {
      throw new Error('Audio is blocked by the browser. Tap Start again, and make sure Silent Mode is off.');
    }
    return ctx;
  }

  async ensureContext() {
    await this.unlockAudio();
    return this.ctx;
  }

  /** Debug-only: symbol duration cannot change mid-transmission (§37). */
  setSpeed(speedId) {
    if (this.playing) return;
    this.speedId = speedId;
    this.symbolMs = callV2SymbolMsForSpeed(speedId);
  }

  setQ(q) {
    if (this.playing) return;
    this.Q = q;
  }

  /** Live-safe: smooth depth changes without restarting (§37). */
  setDepth(depthId) {
    this.depthId = depthId;
    if (this.playing) this._applyDepthLive();
  }

  setWatermarkEnabled(on) {
    this.watermarkEnabled = !!on;
    if (this.playing) this._applyDepthLive();
  }

  setMusicOnly(on) {
    this.musicOnly = !!on;
    if (this.playing) this._applyDepthLive();
  }

  setMusicGain(g) {
    this.musicGain = Math.max(0.4, Math.min(1.2, Number(g) || ACOUSTIC_CONFIG.meditationMusicGain));
    if (this.musicEngine) this.musicEngine.setMusicGain(this.musicGain);
  }

  setCrossfadeSeconds(s) {
    this.crossfadeSeconds = Math.max(5, Math.min(12, Number(s) || MUSIC_CROSSFADE_SECONDS));
    if (this.musicEngine) this.musicEngine.setCrossfadeSeconds(this.crossfadeSeconds);
  }

  _currentHalfDeltaDb() {
    if (!this.watermarkEnabled || this.musicOnly) return 0;
    return callV2DepthDb(this.depthId) / 2;
  }

  /** Ramp all 12 filter gains toward the CURRENT symbol's target smoothly (depth change, live). */
  _applyDepthLive() {
    if (!this.ctx || !this.filterNodes.length) return;
    // Recompute the currently-scheduled half-symbol targets at the new depth
    // and ramp there; the next natural half-symbol boundary will pick up
    // the new depth going forward automatically via _scheduleAhead.
    this._halfDeltaDb = this._currentHalfDeltaDb();
  }

  async start(message) {
    await this.stop({ immediate: true });
    const ctx = await this.ensureContext();

    this._emit('preparing');
    let decoded = null;
    try {
      decoded = await decodeMeditationBuffer(ctx);
      this.musicStats = measureAudioBufferStats(decoded.buffer);
      setMeditationMusicStats(this.musicStats);
      this.meditationMeta = {
        ...getMeditationLoadMeta(),
        decodeMs: decoded.decodeMs,
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        musicStats: this.musicStats,
      };
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      this.meditationMeta = { ...getMeditationLoadMeta(), error: detail };
      throw new Error(`Meditation asset unavailable: ${detail}`);
    }

    this.message = message;
    const built = buildCallV2TransmitSymbols(message);
    this.encoded = built;
    this.frameSymbols = built.frameSymbols;
    this.symbolSamples = Math.round((this.symbolMs / 1000) * ctx.sampleRate);
    this.halfSamples = Math.round(this.symbolSamples / 2);
    this.frameSamples = this.symbolSamples * this.frameSymbols.length;

    this.playing = true;
    this.stopping = false;
    this.sessionStartPerf = performance.now();
    this.framesScheduled = 0;
    this.nextSymbolIndex = 0;
    this._halfDeltaDb = this._currentHalfDeltaDb();

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = ACOUSTIC_CONFIG.masterGain;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;

    this.filterNodes = [];
    let lastNode = this.musicBus;
    for (const [lowHz, highHz] of CALL_V2_PAIRS) {
      const lowFilter = ctx.createBiquadFilter();
      lowFilter.type = 'peaking';
      lowFilter.frequency.value = lowHz;
      lowFilter.Q.value = this.Q;
      lowFilter.gain.value = 0;
      const highFilter = ctx.createBiquadFilter();
      highFilter.type = 'peaking';
      highFilter.frequency.value = highHz;
      highFilter.Q.value = this.Q;
      highFilter.gain.value = 0;
      lastNode.connect(lowFilter);
      lowFilter.connect(highFilter);
      lastNode = highFilter;
      this.filterNodes.push(lowFilter, highFilter);
    }
    lastNode.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    const t0 = ctx.currentTime + 0.05;
    this.musicEngine = new CrossfadeMusicEngine(ctx, this.musicBus, {
      crossfadeSeconds: this.crossfadeSeconds,
      musicGain: this.musicGain,
    });
    await this.musicEngine.prepare(decoded.buffer);
    this.musicEngine.start({ when: t0 });

    this.nextSymbolTime = t0;
    this._emit('playing');
    this._tick();
  }

  _symbolAt(i) {
    if (i < 0) return 0;
    return this.frameSymbols[i % this.frameSymbols.length];
  }

  _tick() {
    if (!this.playing || this.stopping || !this.ctx) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + this.LOOKAHEAD_S;
    const halfDurS = this.symbolMs / 1000 / 2;

    while (this.nextSymbolTime < horizon) {
      const symIndex = Math.floor(this.nextSymbolIndex / 2);
      const half = this.nextSymbolIndex % 2;
      const sym = this._symbolAt(symIndex);
      const halfDeltaDb = this._halfDeltaDb;
      const t = this.nextSymbolTime;

      for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
        const bit = (sym >> (CALL_V2_CHANNEL_COUNT - 1 - p)) & 1;
        const firstHalfSign = bit ? 1 : -1;
        const sign = half === 0 ? firstHalfSign : -firstHalfSign;
        const lowFilter = this.filterNodes[p * 2];
        const highFilter = this.filterNodes[p * 2 + 1];
        try {
          lowFilter.gain.cancelScheduledValues(t);
          lowFilter.gain.setValueAtTime(lowFilter.gain.value, t);
          lowFilter.gain.linearRampToValueAtTime(sign * halfDeltaDb, t + this.transitionS);
          highFilter.gain.cancelScheduledValues(t);
          highFilter.gain.setValueAtTime(highFilter.gain.value, t);
          highFilter.gain.linearRampToValueAtTime(-sign * halfDeltaDb, t + this.transitionS);
        } catch {
          /* ignore */
        }
      }

      this.nextSymbolTime += halfDurS;
      this.nextSymbolIndex++;
      if (this.nextSymbolIndex % (this.frameSymbols.length * 2) === 0) {
        this.framesScheduled++;
      }
    }
    this.timer = setTimeout(() => this._tick(), 250);
  }

  async stop({ immediate = false } = {}) {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) {
      this.playing = false;
      this.stopping = false;
      if (this.musicEngine) {
        await this.musicEngine.stop({ fadeS: 0 });
        this.musicEngine = null;
      }
      this._emit('stopped');
      return;
    }

    const fadeS = immediate ? 0 : Math.max(0.6, MUSIC_STOP_FADE_SECONDS);
    const now = ctx.currentTime;
    try {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
      this.masterGain.gain.linearRampToValueAtTime(0, now + fadeS);
    } catch {
      /* ignore */
    }
    if (this.musicEngine) this.musicEngine.stop({ fadeS }).catch(() => {});
    if (fadeS > 0) await new Promise((r) => setTimeout(r, fadeS * 1000 + 50));

    for (const node of this.filterNodes) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.filterNodes = [];
    for (const node of [this.musicBus, this.masterGain]) {
      try {
        node && node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.musicBus = null;
    this.masterGain = null;
    this.musicEngine = null;
    this.playing = false;
    this.stopping = false;
    this._emit('stopped');
  }

  _emit(state) {
    if (this.onState) this.onState(state, this);
  }

  getDebugInfo() {
    return {
      protocol: 'call-v2',
      playing: this.playing,
      message: this.message,
      depthId: this.depthId,
      depthDb: callV2DepthDb(this.depthId),
      speedId: this.speedId,
      symbolMs: this.symbolMs,
      Q: this.Q,
      watermarkEnabled: this.watermarkEnabled,
      musicOnly: this.musicOnly,
      sampleRate: this.ctx?.sampleRate ?? null,
      framesScheduled: this.framesScheduled,
      frameSymbolCount: this.frameSymbols?.length ?? null,
      frameMs: this.frameSymbols ? this.frameSymbols.length * this.symbolMs : null,
      musicGain: this.musicGain,
      crossfadeSeconds: this.crossfadeSeconds,
      meditationMeta: this.meditationMeta,
      musicRmsDb: this.musicStats?.rmsDb ?? null,
      sessionDurationMs: this.playing ? performance.now() - this.sessionStartPerf : 0,
    };
  }
}
