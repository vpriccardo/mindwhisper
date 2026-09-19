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
  preloadMeditationAudio,
  getMeditationLoadMeta,
  getMeditationMusicStats,
  setMeditationMusicStats,
  MEDITATION_MUSIC_GAIN_DEFAULT,
  MUSIC_CROSSFADE_SECONDS,
  MUSIC_STOP_FADE_SECONDS,
} from './meditation-audio.js';
import {
  ACOUSTIC_CONFIG,
  roomCarrierDbForPreset,
  relativeDbToGain,
  measureFloat32Stats,
  measureAudioBufferStats,
  rampGainTo,
} from './acoustic-config.js';
import { buildRoomV2TransmitSymbols } from './room-v2/room-v2-protocol.js';
import {
  ROOM_V2_DEFAULT_SPEED,
  roomV2SymbolMsForSpeed,
  roomV2ResolveSpeedId,
} from './room-v2/room-v2-constants.js';

export { ROOM_V2_DEFAULT_SPEED, roomV2SymbolMsForSpeed, roomV2ResolveSpeedId };

/** Air profile only — Meditation emits no procedural ambience. */
export const AIR_AMBIENT_GAIN = 1.55;
/** Proven Air carrier bake-in (Meditation uses bus-relative dB instead). */
export const AIR_CARRIER_LEVEL = 0.05;

export { preloadMeditationAudio, getMeditationLoadMeta, ACOUSTIC_CONFIG };

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
      // room-v2 framing + variable symbol duration. Sound generation below
      // (bandpass banks, ambient mixing, calibration) is IDENTICAL for v1
      // and v2 — only which symbols get transmitted, and how long each
      // lasts, differs. Default here is 'v1' to keep this low-level class
      // and all existing callers/tests byte-for-byte unchanged; the live
      // production engine (ContinuousTransmitter below) explicitly opts
      // into 'v2' as ITS default, per the room-v2-is-production-default
      // requirement.
      protocolVersion = 'v1',
      speedId = ROOM_V2_DEFAULT_SPEED,
      symbolMs = null,
    } = opts;

    this.sampleRate = sampleRate;
    this.profileId = resolveProfileId(profileId);
    this.deltaDb = deltaDb;
    this.neutral = neutral;
    this.carrierLevel = carrierLevel;
    this.ambientGain = ambientGain;
    this.halfDelta = deltaDb / 2;
    this.ambientDebug = ambientDebug;
    this.protocolVersion = protocolVersion;

    const effectiveSymbolMs =
      protocolVersion === 'v2'
        ? symbolMs || roomV2SymbolMsForSpeed(speedId, message?.length)
        : SYMBOL_MS;
    this.symbolMs = effectiveSymbolMs;
    this.speedId =
      protocolVersion === 'v2' ? roomV2ResolveSpeedId(speedId, message?.length) : null;

    const built =
      protocolVersion === 'v2'
        ? buildRoomV2TransmitSymbols(message)
        : buildTransmitSymbols(message);
    this.encoded = built;
    // Single frame (preamble [+header] + data), repeated forever in continuous mode
    this.frameSymbols = built.frameSymbols;
    this.symbolSamples = Math.round((effectiveSymbolMs / 1000) * sampleRate);
    this.crossfadeSamples = Math.max(
      1,
      Math.round((CROSSFADE_MS / 1000) * sampleRate)
    );
    this.frameSamples = this.symbolSamples * this.frameSymbols.length;

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
      // Meditation: keep PCM in range; relative level is applied on watermarkBus.
      const pcmScale = this.ambientGain < 0.01 ? 0.05 : 1;
      out[i] += wm * this.carrierLevel * pcmScale;
    }

    this.sampleIndex += lengthSamples;
    if (!ambientOnly) {
      this.framesTransmitted = Math.floor(
        this.dataSampleIndex / this.frameSamples
      );
    }

    if (fadeIn) applyFades(out, this.sampleRate, fadeInMs, 0);
    if (fadeOut) applyFades(out, this.sampleRate, 0, fadeOutMs);

    // Soft-clip for loud ambient beds (Air / procedural). Meditation is
    // carrier-only into a GainNode bus — keep linear so relative-dB works.
    let peak = 0;
    let scale = 1;
    if (this.ambientGain > 0.01) {
      for (let i = 0; i < out.length; i++) {
        const y = Math.tanh(out[i] * 1.15);
        out[i] = y;
        const a = Math.abs(y);
        if (a > peak) peak = a;
      }
      if (peak > 0.92) {
        scale = 0.92 / peak;
        for (let i = 0; i < out.length; i++) out[i] *= scale;
        peak = 0.92;
      }
    } else {
      for (let i = 0; i < out.length; i++) {
        const a = Math.abs(out[i]);
        if (a > peak) peak = a;
      }
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
    this.watermarkBus = null; // roomWatermarkBus
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
    this.LOOKAHEAD_S = 2.0;
    this.CHUNK_S = 0.4;
    this.FADE_IN_S = Math.max(0.6, FADE_IN_MS / 1000);
    this.FADE_OUT_S = Math.max(0.6, FADE_OUT_MS / 1000);
    this.leadInS = 0.8;
    this.outputGain = 1.0;
    this.musicGain = ACOUSTIC_CONFIG.meditationMusicGain;
    this.crossfadeSeconds = MUSIC_CROSSFADE_SECONDS;
    this.watermarkEnabled = true;
    this.musicOnly = false;
    this.meditationMeta = null;
    this.roomPreset = ACOUSTIC_CONFIG.room.defaultPreset;
    this.roomCarrierRelativeDb = roomCarrierDbForPreset(this.roomPreset);
    this.musicStats = null;
    this.carrierRefStats = null;
    this.estimatedCarrierRmsDb = null;
    this.estimatedMasterPeak = null;
    // room-v2 is the production default; ?protocol=v1 selects the frozen
    // legacy framing (see acoustic/README.md / tx.html debug controls).
    this.protocolVersion = 'v2';
    this.speedId = ROOM_V2_DEFAULT_SPEED;
  }

  /** Debug-only: switch between room-v2 (default) and frozen room-v1 framing. */
  setProtocolVersion(v) {
    if (this.playing) return;
    this.protocolVersion = v === 'v1' ? 'v1' : 'v2';
  }

  /** room-v2 only. Requires Stop → setSpeed → Start (§37); no-op while playing. */
  setSpeed(speedId) {
    if (this.playing) return;
    this.speedId = speedId;
  }

  createContextSync() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AC();
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

  setAmbientDebug(debug) {
    if (this.playing) return;
    this.ambientDebug = debug;
  }

  setDeltaDb(db) {
    this.deltaDb = db;
  }

  setMusicGain(g) {
    this.musicGain = Math.max(0.4, Math.min(1.2, Number(g) || ACOUSTIC_CONFIG.meditationMusicGain));
    if (this.musicEngine) this.musicEngine.setMusicGain(this.musicGain);
  }

  setCrossfadeSeconds(s) {
    this.crossfadeSeconds = Math.max(5, Math.min(12, Number(s) || MUSIC_CROSSFADE_SECONDS));
    if (this.musicEngine) this.musicEngine.setCrossfadeSeconds(this.crossfadeSeconds);
  }

  /** Live-safe: only carrier bus gain changes while playing. */
  setRoomPreset(presetId) {
    if (!(presetId in ACOUSTIC_CONFIG.room.presets)) {
      throw new Error(`Unknown room preset ${presetId}`);
    }
    this.roomPreset = presetId;
    this.roomCarrierRelativeDb = roomCarrierDbForPreset(presetId);
    this._applyRoomCarrierGain(true);
  }

  setWatermarkEnabled(on) {
    this.watermarkEnabled = !!on;
    if (this.playing) this._applyRoomCarrierGain(true);
  }

  setMusicOnly(on) {
    this.musicOnly = !!on;
    if (this.playing) this._applyRoomCarrierGain(true);
  }

  _targetRoomCarrierGain() {
    if (!this.watermarkEnabled || this.musicOnly) return 0;
    if (this.profileId !== 'meditation') return 1;
    const musicDb = this.musicStats?.rmsDb;
    const refDb = this.carrierRefStats?.rmsDb;
    return relativeDbToGain(musicDb, this.roomCarrierRelativeDb, refDb);
  }

  _applyRoomCarrierGain(ramp) {
    if (!this.watermarkBus || !this.ctx) return;
    const g = this._targetRoomCarrierGain();
    if (ramp) rampGainTo(this.watermarkBus, g, this.ctx);
    else this.watermarkBus.gain.value = g;
  }

  _calibrateRoomCarrierRef(sampleRate, message) {
    const cal = new StreamingTxRenderer({
      message,
      sampleRate,
      profileId: 'meditation',
      deltaDb: this.deltaDb,
      ambientSeed: this.ambientSeed,
      watermarkNoiseSeed: this.watermarkNoiseSeed,
      ambientGain: 0,
      carrierLevel: 1,
      neutral: false,
      protocolVersion: this.protocolVersion,
      speedId: this.speedId,
    });
    const n = Math.max(2048, Math.round(sampleRate * 0.4));
    const chunk = cal.renderChunk({
      lengthSamples: n,
      ambientOnly: false,
    });
    return measureFloat32Stats(chunk.samples);
  }

  async start(message) {
    const ctx = await this.unlockAudio();
    await this._teardownImmediate({ emit: false });

    let useMusic = this.profileId === 'meditation';
    let decoded = null;
    if (useMusic) {
      this._emit('preparing');
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
        // Meditation asset unavailable/corrupt (e.g. a stale cached copy on
        // a particular device that never revalidates) — fall back to the
        // proven Air ambience so TX still produces audible sound + the
        // watermark instead of going silent.
        const detail = err && err.message ? err.message : String(err);
        console.warn('[meditation] falling back to Air:', detail);
        this.meditationMeta = { ...getMeditationLoadMeta(), error: detail };
        useMusic = false;
        this.profileId = 'air';
        decoded = null;
      }
    }
    if (!useMusic) {
      this.musicStats = getMeditationMusicStats();
    }

    this.message = message;
    this.playing = true;
    this.stopping = false;
    this.sessionStartPerf = performance.now();
    this.framesScheduled = 0;

    // Meditation: music only + data-bearing carrier (no Air/hiss bed).
    // Air: proven ambient + baked carrier level.
    let ambientGain;
    let carrierLevel;
    if (useMusic) {
      ambientGain = 0;
      carrierLevel = this.watermarkEnabled && !this.musicOnly ? 1 : 0;
      this.carrierRefStats = this._calibrateRoomCarrierRef(ctx.sampleRate, message);
    } else {
      ambientGain = AIR_AMBIENT_GAIN;
      carrierLevel =
        this.watermarkEnabled && !this.musicOnly ? AIR_CARRIER_LEVEL : 0;
      this.carrierRefStats = null;
    }

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
      protocolVersion: this.protocolVersion,
      speedId: this.speedId,
    });

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = useMusic
      ? ACOUSTIC_CONFIG.masterGain
      : this.outputGain;
    this.watermarkBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.watermarkBus.connect(this.masterGain);
    this.musicBus.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    if (useMusic) this._applyRoomCarrierGain(false);
    else this.watermarkBus.gain.value = 1;

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
    const musicStats = this.musicStats;
    const carrierGain = this.watermarkBus?.gain?.value ?? null;
    const carrierRmsDb =
      this.carrierRefStats && carrierGain != null
        ? this.carrierRefStats.rmsDb + 20 * Math.log10(Math.max(carrierGain, 1e-12))
        : null;
    const relativeDb =
      musicStats && carrierRmsDb != null
        ? carrierRmsDb - musicStats.rmsDb
        : this.profileId === 'meditation'
          ? this.roomCarrierRelativeDb
          : null;
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
      protocolVersion: this.protocolVersion,
      speedId: this.speedId,
      symbolMs: this.renderer?.symbolMs ?? null,
      frameSymbolCount: this.renderer?.frameSymbols?.length ?? null,
      frameMs: this.renderer
        ? this.renderer.symbolSamples * this.renderer.frameSymbols.length * (1000 / (this.ctx?.sampleRate || 48000))
        : FRAME_MS,
      chunkS: this.CHUNK_S,
      lookaheadS: this.LOOKAHEAD_S,
      watermarkEnabled: this.watermarkEnabled,
      musicOnly: this.musicOnly,
      musicGain: this.musicGain,
      crossfadeSeconds: this.crossfadeSeconds,
      music,
      meditationMeta: this.meditationMeta,
      meditationLoad: getMeditationLoadMeta(),
      roomPreset: this.roomPreset,
      roomCarrierRelativeDb: this.roomCarrierRelativeDb,
      musicRmsDb: musicStats?.rmsDb ?? null,
      musicPeakDb: musicStats?.peakDb ?? null,
      roomCarrierRmsDb: carrierRmsDb,
      roomCarrierRelativeMeasuredDb: relativeDb,
      carrierBusGain: carrierGain,
      masterGain: this.masterGain?.gain?.value ?? null,
      carrierRefRmsDb: this.carrierRefStats?.rmsDb ?? null,
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
