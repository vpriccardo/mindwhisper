/**
 * Continuous TX engine: ambient profile stream + repeating watermark frames.
 * Ambient evolves continuously; watermark carriers never reset between frames.
 * Scheduling uses AudioContext.currentTime (not setTimeout per-symbol).
 *
 * ROOM-V1 ONLY — do not import from js/call/. Call (tx2/rx2) has its own engine.
 */

import {
  WATERMARK_CHANNELS,
  BANDWIDTH_HZ,
  CHANNEL_COUNT,
  SYMBOL_MS,
  CROSSFADE_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  FRAME_MS,
  FRAME_SYMBOLS,
  WATERMARK_DELTA_DB_DEFAULT,
  WATERMARK_NOISE_SEED_DEFAULT,
  AMBIENT_SEED_DEFAULT,
  buildTransmitSymbols,
  createXorshift32,
} from './protocol.js';
import {
  createAmbientStream,
  DEFAULT_AMBIENT_PROFILE,
  ALL_PROFILE_IDS,
  resolveProfileId,
} from './ambient-profiles.js';
import {
  designBandpass,
  designBandReject,
  createBiquadState,
  processBiquad,
} from './dsp-biquad.js';
import { applyFades, normalizePeak, measureRmsDbFs } from './ambient.js';
import {
  CrossfadeMusicEngine,
  decodeMeditationBuffer,
  ensureMeditationBytes,
  preloadMeditationAudio,
  getMeditationLoadMeta,
  MEDITATION_MUSIC_GAIN_DEFAULT,
  MUSIC_CROSSFADE_SECONDS,
  MUSIC_STOP_FADE_SECONDS,
} from './meditation-audio.js';

/** Quieter Air bed under meditation music (carriers stay at proven levels). */
export const MEDITATION_AMBIENT_GAIN = 0.42;
export const AIR_AMBIENT_GAIN = 1.55;

export { preloadMeditationAudio, getMeditationLoadMeta };

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function raisedCosine(x) {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
}

/**
 * Stateful renderer that can produce arbitrary-length chunks with continuous state.
 */
export class StreamingTxRenderer {
  constructor(opts) {
    const {
      message,
      sampleRate,
      profileId = DEFAULT_AMBIENT_PROFILE,
      deltaDb = WATERMARK_DELTA_DB_DEFAULT,
      neutral = false,
      ambientSeed = AMBIENT_SEED_DEFAULT,
      watermarkNoiseSeed = WATERMARK_NOISE_SEED_DEFAULT,
      carrierLevel = 0.05,
      ambientGain = 1.55,
      ambientDebug = null,
    } = opts;

    this.sampleRate = sampleRate;
    this.profileId = resolveProfileId(profileId);
    this.deltaDb = deltaDb;
    this.neutral = neutral;
    this.carrierLevel = carrierLevel;
    this.ambientGain = ambientGain;
    this.halfDelta = deltaDb / 2;
    this.ambientDebug = ambientDebug;

    const built = buildTransmitSymbols(message);
    this.encoded = built;
    // Single frame (preamble + data), repeated forever in continuous mode
    this.frameSymbols = built.frameSymbols;
    this.symbolSamples = Math.round((SYMBOL_MS / 1000) * sampleRate);
    this.crossfadeSamples = Math.max(
      1,
      Math.round((CROSSFADE_MS / 1000) * sampleRate)
    );
    this.frameSamples = this.symbolSamples * FRAME_SYMBOLS;

    this.ambient = createAmbientStream(
      this.profileId,
      sampleRate,
      ambientSeed,
      ambientDebug
    );
    this.noiseRng = createXorshift32(watermarkNoiseSeed);

    this.notches = [];
    this.notchStates = [];
    this.filtersA = [];
    this.filtersB = [];
    this.statesA = [];
    this.statesB = [];
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const [lowHz, highHz] = WATERMARK_CHANNELS[ch];
      this.notches.push(designBandReject(lowHz, sampleRate, BANDWIDTH_HZ * 1.35));
      this.notches.push(designBandReject(highHz, sampleRate, BANDWIDTH_HZ * 1.35));
      this.notchStates.push(createBiquadState(), createBiquadState());
      this.filtersA.push(designBandpass(lowHz, sampleRate, BANDWIDTH_HZ));
      this.filtersA.push(designBandpass(highHz, sampleRate, BANDWIDTH_HZ));
      this.filtersB.push(designBandpass(lowHz, sampleRate, BANDWIDTH_HZ));
      this.filtersB.push(designBandpass(highHz, sampleRate, BANDWIDTH_HZ));
      this.statesA.push(createBiquadState(), createBiquadState());
      this.statesB.push(createBiquadState(), createBiquadState());
    }

    this.bandGain = new Float32Array(16);
    this.bandGain.fill(1);
    this.watermarkNoiseSeed = watermarkNoiseSeed;
    // Keep calibration short — 2s of sampleRate blocked the Start tap on iPhone
    // long enough to lose audio unlock / feel broken.
    this._calibrateBandGains(Math.max(2048, Math.round(sampleRate * 0.12)));

    this.prevGain = new Float32Array(16);
    this.curGain = new Float32Array(16);
    this.prevGain.fill(1);
    this.curGain.fill(1);

    this.sampleIndex = 0; // absolute samples rendered (incl. lead-in)
    this.dataSampleIndex = 0; // samples during data-bearing regions only
    this.framesTransmitted = 0;
  }

  _calibrateBandGains(warmupSamples) {
    const acc = new Float64Array(16);
    for (let i = 0; i < warmupSamples; i++) {
      const x = this.noiseRng.nextGaussian();
      for (let b = 0; b < 16; b++) {
        const y1 = processBiquad(x, this.filtersA[b], this.statesA[b]);
        const y = processBiquad(y1, this.filtersB[b], this.statesB[b]);
        acc[b] += y * y;
      }
    }
    for (let b = 0; b < 16; b++) {
      const rms = Math.sqrt(acc[b] / warmupSamples);
      this.bandGain[b] = rms > 1e-12 ? 1 / rms : 1;
      this.statesA[b] = createBiquadState();
      this.statesB[b] = createBiquadState();
    }
    // Fresh carrier stream after calibration burn-in (session-stable seed)
    this.noiseRng = createXorshift32((this.watermarkNoiseSeed ^ 0x51f00d) >>> 0);
  }

  _setGainsFromSymbol(symbolBits) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const lowIdx = ch * 2;
      const highIdx = ch * 2 + 1;
      if (this.neutral) {
        this.curGain[lowIdx] = 1;
        this.curGain[highIdx] = 1;
      } else if (symbolBits) {
        const bit = symbolBits[ch];
        if (bit === 1) {
          this.curGain[lowIdx] = dbToLinear(+this.halfDelta);
          this.curGain[highIdx] = dbToLinear(-this.halfDelta);
        } else {
          this.curGain[lowIdx] = dbToLinear(-this.halfDelta);
          this.curGain[highIdx] = dbToLinear(+this.halfDelta);
        }
      } else {
        this.curGain[lowIdx] = 1;
        this.curGain[highIdx] = 1;
      }
    }
  }

  _symbolAt(globalSymbolIndex) {
    if (globalSymbolIndex < 0) return null;
    const idx = globalSymbolIndex % this.frameSymbols.length;
    return this.frameSymbols[idx];
  }

  /**
   * Render the next `lengthSamples` of continuous TX audio.
   */
  renderChunk(opts) {
    const {
      lengthSamples,
      fadeIn = false,
      fadeOut = false,
      ambientOnly = false,
      fadeInMs = FADE_IN_MS,
      fadeOutMs = FADE_OUT_MS,
    } = opts;

    const ambient = this.ambient.render(lengthSamples);
    const out = new Float32Array(lengthSamples);

    for (let i = 0; i < lengthSamples; i++) {
      let x = ambient[i];
      for (let b = 0; b < this.notches.length; b++) {
        x = processBiquad(x, this.notches[b], this.notchStates[b]);
      }
      // Ambient leads perceptually; carriers stay quiet under it.
      out[i] = x * this.ambientGain;
    }

    let lastSym = null;
    const bands = new Float32Array(16);

    for (let i = 0; i < lengthSamples; i++) {
      const drive = this.noiseRng.nextGaussian();
      for (let b = 0; b < 16; b++) {
        const y1 = processBiquad(drive, this.filtersA[b], this.statesA[b]);
        bands[b] = processBiquad(y1, this.filtersB[b], this.statesB[b]);
      }

      let symIndex = -1;
      let posInSym = this.crossfadeSamples;
      if (!ambientOnly) {
        symIndex = Math.floor(this.dataSampleIndex / this.symbolSamples);
        posInSym = this.dataSampleIndex % this.symbolSamples;
        this.dataSampleIndex++;
      }

      if (symIndex !== lastSym) {
        this.prevGain.set(this.curGain);
        this._setGainsFromSymbol(this._symbolAt(symIndex));
        lastSym = symIndex;
      }

      let wPrev = 0;
      let wCur = 1;
      if (!ambientOnly && posInSym < this.crossfadeSamples) {
        const x = raisedCosine(posInSym / this.crossfadeSamples);
        wPrev = 1 - x;
        wCur = x;
      }

      let wm = 0;
      for (let b = 0; b < 16; b++) {
        const g = wPrev * this.prevGain[b] + wCur * this.curGain[b];
        wm += bands[b] * this.bandGain[b] * g;
      }
      out[i] += wm * this.carrierLevel;
    }

    this.sampleIndex += lengthSamples;
    if (!ambientOnly) {
      this.framesTransmitted = Math.floor(
        this.dataSampleIndex / this.frameSamples
      );
    }

    if (fadeIn) applyFades(out, this.sampleRate, fadeInMs, 0);
    if (fadeOut) applyFades(out, this.sampleRate, 0, fadeOutMs);

    // Soft-clip instead of hard peak-rescale. Hard rescale was driven by
    // high-crest watermark carriers and crushed the low Tide/Elements bed,
    // making every profile sound like the same HF noise.
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const y = Math.tanh(out[i] * 1.15);
      out[i] = y;
      const a = Math.abs(y);
      if (a > peak) peak = a;
    }
    let scale = 1;
    if (peak > 0.92) {
      scale = 0.92 / peak;
      for (let i = 0; i < out.length; i++) out[i] *= scale;
      peak = 0.92;
    }

    return {
      samples: out,
      peak,
      scale,
      rmsDb: measureRmsDbFs(out),
      sampleIndex: this.sampleIndex,
      framesTransmitted: this.framesTransmitted,
    };
  }
}

/**
 * Live continuous transmitter using Web Audio clock for chunk scheduling.
 * Uses short PCM chunks + 2s lookahead so main-thread DSP never underruns.
 */
export class ContinuousTransmitter {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.musicBus = null;
    this.watermarkBus = null;
    this.musicEngine = null;
    this.renderer = null;
    this.playing = false;
    this.stopping = false;
    this.profileId = DEFAULT_AMBIENT_PROFILE;
    this.deltaDb = WATERMARK_DELTA_DB_DEFAULT;
    this.ambientSeed = AMBIENT_SEED_DEFAULT;
    this.watermarkNoiseSeed = WATERMARK_NOISE_SEED_DEFAULT;
    this.ambientDebug = null;
    this.message = '';
    this.nextScheduleTime = 0;
    this.timer = null;
    this.activeSources = new Set();
    this.sessionStartPerf = 0;
    this.framesScheduled = 0;
    this.onState = null;
    // Short chunks keep the main thread responsive; long lookahead absorbs DSP cost.
    this.LOOKAHEAD_S = 2.0;
    this.CHUNK_S = 0.4;
    this.FADE_IN_S = Math.max(0.6, FADE_IN_MS / 1000);
    this.FADE_OUT_S = Math.max(0.6, FADE_OUT_MS / 1000);
    this.leadInS = 0.8; // ambient-only before first preamble
    this.outputGain = 1.0;
    this.musicGain = MEDITATION_MUSIC_GAIN_DEFAULT;
    this.crossfadeSeconds = MUSIC_CROSSFADE_SECONDS;
    this.watermarkEnabled = true;
    this.musicOnly = false; // debug: meditation music, no watermark PCM
    this.meditationMeta = null;
  }

  /** Create context immediately (call from the tap handler before any long await). */
  createContextSync() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AC();
    }
    return this.ctx;
  }

  /**
   * Unlock iOS/Safari audio in the user-gesture turn.
   * Must run before heavy awaits or the context stays suspended → silent "Playing…".
   */
  async unlockAudio() {
    const ctx = this.createContextSync();
    // Play a tiny silent buffer through the destination — required unlock on some iOS builds.
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
      throw new Error(
        'Audio is blocked by the browser. Tap Start again, and make sure Silent Mode is off.'
      );
    }
    return ctx;
  }

  async ensureContext() {
    await this.unlockAudio();
    return this.ctx;
  }

  setProfile(id) {
    const resolved = resolveProfileId(id);
    if (!ALL_PROFILE_IDS.includes(resolved)) {
      throw new Error(`Unknown profile ${id}`);
    }
    if (this.playing) return;
    this.profileId = resolved;
  }

  /** Debug-only mix/solo params applied on next Start (new ambient session). */
  setAmbientDebug(debug) {
    if (this.playing) return;
    this.ambientDebug = debug;
  }

  setDeltaDb(db) {
    this.deltaDb = db;
  }

  setMusicGain(g) {
    this.musicGain = Math.max(0.4, Math.min(1.0, Number(g) || MEDITATION_MUSIC_GAIN_DEFAULT));
    if (this.musicEngine) this.musicEngine.setMusicGain(this.musicGain);
  }

  setCrossfadeSeconds(s) {
    this.crossfadeSeconds = Math.max(5, Math.min(12, Number(s) || MUSIC_CROSSFADE_SECONDS));
    if (this.musicEngine) this.musicEngine.setCrossfadeSeconds(this.crossfadeSeconds);
  }

  setWatermarkEnabled(on) {
    this.watermarkEnabled = !!on;
  }

  setMusicOnly(on) {
    this.musicOnly = !!on;
  }

  async start(message) {
    // Unlock FIRST — never await teardown before AudioContext.resume() on iOS.
    const ctx = await this.unlockAudio();

    // Tear down any previous session without going through another unlock race.
    await this._teardownImmediate({ emit: false });

    const useMusic = this.profileId === 'meditation';
    let decoded = null;
    if (useMusic) {
      this._emit('preparing');
      try {
        await ensureMeditationBytes();
        decoded = await decodeMeditationBuffer(ctx);
        this.meditationMeta = {
          ...getMeditationLoadMeta(),
          decodeMs: decoded.decodeMs,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
        };
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        console.warn('[meditation]', detail);
        this.playing = false;
        throw new Error(
          'Meditation sound is unavailable. Air remains available.'
        );
      }
    }

    this.message = message;
    this.playing = true;
    this.stopping = false;
    this.sessionStartPerf = performance.now();
    this.framesScheduled = 0;

    const ambientGain = this.musicOnly
      ? 0
      : useMusic
        ? MEDITATION_AMBIENT_GAIN
        : AIR_AMBIENT_GAIN;
    const carrierLevel =
      this.watermarkEnabled && !this.musicOnly ? 0.05 : 0;

    this.renderer = new StreamingTxRenderer({
      message,
      sampleRate: ctx.sampleRate,
      profileId: this.profileId,
      deltaDb: this.deltaDb,
      ambientSeed: this.ambientSeed,
      watermarkNoiseSeed: this.watermarkNoiseSeed,
      ambientDebug: this.ambientDebug,
      ambientGain,
      carrierLevel,
      neutral: !this.watermarkEnabled,
    });

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.outputGain;
    this.watermarkBus = ctx.createGain();
    this.watermarkBus.gain.value = 1;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.watermarkBus.connect(this.masterGain);
    this.musicBus.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // Re-check after heavy renderer init (calibration) — iOS can re-suspend.
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (ctx.state === 'suspended') {
      this.playing = false;
      this.renderer = null;
      this._disconnectBuses();
      throw new Error(
        'Audio context suspended. Tap Start again with Silent Mode off.'
      );
    }

    const t0 = ctx.currentTime + 0.05;

    if (useMusic && decoded) {
      this.musicEngine = new CrossfadeMusicEngine(ctx, this.musicBus, {
        crossfadeSeconds: this.crossfadeSeconds,
        musicGain: this.musicGain,
      });
      await this.musicEngine.prepare(decoded.buffer);
      this.musicEngine.start({ when: t0 });
    }

    if (!this.musicOnly) {
      const leadSamples = Math.round(this.leadInS * ctx.sampleRate);
      const lead = this.renderer.renderChunk({
        lengthSamples: leadSamples,
        fadeIn: true,
        fadeInMs: this.FADE_IN_S * 1000,
        ambientOnly: true,
      });
      this._scheduleBuffer(lead.samples, t0);
      this.nextScheduleTime = t0 + leadSamples / ctx.sampleRate;
      this._emit('playing');
      this._tick();
    } else {
      this.nextScheduleTime = t0;
      this._emit('playing');
    }
  }

  _tick() {
    if (!this.playing || this.stopping || !this.ctx || !this.renderer) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
      this.timer = setTimeout(() => this._tick(), 100);
      return;
    }

    const chunkSamples = Math.max(
      1,
      Math.round(this.CHUNK_S * ctx.sampleRate)
    );
    const horizon = ctx.currentTime + this.LOOKAHEAD_S;

    let rendered = 0;
    const maxChunksPerTick = 8;
    while (this.nextScheduleTime < horizon && rendered < maxChunksPerTick) {
      if (this.nextScheduleTime < ctx.currentTime + 0.02) {
        this.nextScheduleTime = ctx.currentTime + 0.05;
      }
      const chunk = this.renderer.renderChunk({
        lengthSamples: chunkSamples,
        ambientOnly: false,
      });
      this._scheduleBuffer(chunk.samples, this.nextScheduleTime);
      this.nextScheduleTime += chunk.samples.length / ctx.sampleRate;
      this.framesScheduled = this.renderer.framesTransmitted;
      rendered++;
    }

    this.timer = setTimeout(() => this._tick(), 50);
  }

  _scheduleBuffer(samples, when) {
    const ctx = this.ctx;
    const bus = this.watermarkBus || this.masterGain;
    if (!bus || !samples || samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    // getChannelData is more reliable than copyToChannel on some WebKit builds
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(bus);
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    };
    const startAt = when < ctx.currentTime ? ctx.currentTime : when;
    try {
      src.start(startAt);
    } catch {
      this.activeSources.delete(src);
    }
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
      this._cleanupSources();
      this._emit('stopped');
      return;
    }

    if (immediate) {
      await this._teardownImmediate({ emit: true });
      return;
    }

    const fadeS = Math.max(this.FADE_OUT_S, MUSIC_STOP_FADE_SECONDS);
    const now = ctx.currentTime;
    try {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(
        Math.max(0.0001, this.masterGain.gain.value),
        now
      );
      this.masterGain.gain.linearRampToValueAtTime(0, now + fadeS);
    } catch {
      /* ignore */
    }
    if (this.musicEngine) {
      // Parallel music fade; master fade covers the mix.
      this.musicEngine.stop({ fadeS }).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, fadeS * 1000 + 50));
    await this._teardownImmediate({ emit: true });
  }

  _disconnectBuses() {
    for (const node of [this.musicBus, this.watermarkBus, this.masterGain]) {
      if (!node) continue;
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.musicBus = null;
    this.watermarkBus = null;
    this.masterGain = null;
  }

  async _teardownImmediate({ emit = true } = {}) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    if (this.masterGain && ctx) {
      try {
        this.masterGain.gain.cancelScheduledValues(ctx.currentTime);
        this.masterGain.gain.value = 0;
      } catch {
        /* ignore */
      }
    }
    if (this.musicEngine) {
      try {
        await this.musicEngine.stop({ fadeS: 0 });
      } catch {
        /* ignore */
      }
      this.musicEngine = null;
    }
    this._cleanupSources();
    this._disconnectBuses();
    this.renderer = null;
    this.playing = false;
    this.stopping = false;
    if (emit) this._emit('stopped');
  }

  /** Resume context after iOS interruption without tearing down the session. */
  async resumeIfNeeded() {
    if (!this.playing || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
    if (!this.timer && this.playing && !this.stopping) {
      this._tick();
    }
  }

  _cleanupSources() {
    for (const src of this.activeSources) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.activeSources.clear();
  }

  _emit(state) {
    if (this.onState) this.onState(state, this);
  }

  getDebugInfo() {
    const music = this.musicEngine?.getDebugInfo() ?? null;
    return {
      profile: this.profileId,
      playing: this.playing,
      deltaDb: this.deltaDb,
      message: this.message,
      sampleRate: this.ctx?.sampleRate ?? null,
      audioContextState: this.ctx?.state ?? null,
      audioContextTime: this.ctx?.currentTime ?? null,
      nextFrameScheduledAt: this.nextScheduleTime,
      framesScheduled: this.framesScheduled,
      framesTransmitted: this.renderer?.framesTransmitted ?? 0,
      sessionDurationMs: this.playing
        ? performance.now() - this.sessionStartPerf
        : 0,
      ambientSeed: this.ambientSeed,
      activeSources: this.activeSources.size,
      frameMs: FRAME_MS,
      chunkS: this.CHUNK_S,
      lookaheadS: this.LOOKAHEAD_S,
      watermarkEnabled: this.watermarkEnabled,
      musicOnly: this.musicOnly,
      musicGain: this.musicGain,
      crossfadeSeconds: this.crossfadeSeconds,
      music,
      meditationMeta: this.meditationMeta,
      meditationLoad: getMeditationLoadMeta(),
    };
  }
}

/**
 * Offline render for tests / finite clips.
 * Structure: optional ambient lead-in → N frames (no inter-frame fades) → optional ambient trail.
 * Matches legacy TOTAL_TX_MS when frameCount=3 and fades enabled with default lead/trail.
 */
export function renderProfileTransmission(opts) {
  const {
    message,
    sampleRate,
    profileId = 'air',
    frameCount = 3,
    deltaDb = WATERMARK_DELTA_DB_DEFAULT,
    includeFadeIn = true,
    includeFadeOut = true,
    leadInMs = includeFadeIn ? FADE_IN_MS : 0,
    trailOutMs = includeFadeOut ? FADE_OUT_MS : 0,
    ...rest
  } = opts;

  const renderer = new StreamingTxRenderer({
    message,
    sampleRate,
    profileId,
    deltaDb,
    ...rest,
  });

  const parts = [];
  if (leadInMs > 0) {
    parts.push(
      renderer.renderChunk({
        lengthSamples: Math.round((leadInMs / 1000) * sampleRate),
        ambientOnly: true,
        fadeIn: includeFadeIn,
        fadeInMs: FADE_IN_MS,
      }).samples
    );
  }

  parts.push(
    renderer.renderChunk({
      lengthSamples: renderer.frameSamples * frameCount,
      ambientOnly: false,
    }).samples
  );

  if (trailOutMs > 0) {
    parts.push(
      renderer.renderChunk({
        lengthSamples: Math.round((trailOutMs / 1000) * sampleRate),
        ambientOnly: true,
        fadeOut: includeFadeOut,
        fadeOutMs: FADE_OUT_MS,
      }).samples
    );
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }

  // Match legacy peak normalize for finite clips used in tests
  const { peak, rms, scale } = normalizePeak(out, 0.85);
  return {
    samples: out,
    sampleRate,
    peak,
    rms,
    rmsDb: measureRmsDbFs(out),
    scale,
    deltaDb,
    profileId: renderer.profileId,
    encoded: renderer.encoded,
    fadeInSamples: includeFadeIn
      ? Math.round((FADE_IN_MS / 1000) * sampleRate)
      : 0,
    symbolSamples: renderer.symbolSamples,
    frameSamples: renderer.frameSamples,
    durationMs: (out.length / sampleRate) * 1000,
  };
}
