/**
 * call-v1 TX: continuous ambient + chip-spread differential spectral watermark.
 * Frame loops PREAMBLE+DATA forever; ambient evolves independently.
 */

import {
  encodeCallMessage,
} from '../protocol.js';
import {
  designBandReject,
  createBiquadState,
  processBiquad,
} from '../dsp-biquad.js';
import { applyFades, normalizePeak, measureRmsDbFs } from '../ambient.js';
import {
  CALL_BASE_CHANNELS,
  CALL_ENHANCEMENT_CHANNELS,
  CALL_CHANNEL_COUNT,
  CALL_PREAMBLE,
  CALL_PREAMBLE_SYMBOLS,
  CALL_DATA_SYMBOLS,
  CALL_FRAME_SYMBOLS,
  CALL_CHIP_CODE,
  CHIPS_PER_SYMBOL,
  CHIP_MS,
  SYMBOL_MS,
  CROSSFADE_MS,
  BASE_TOTAL_DIFFERENTIAL_DB,
  ENHANCEMENT_DIFFERENTIAL_DB,
  CALL_FADE_IN_MS,
  CALL_FADE_OUT_MS,
  CALL_CARRIER_LEVEL,
  CALL_AMBIENT_MIX,
  CALL_CARRIER_SEED_DEFAULT,
  CALL_AMBIENT_SEED_DEFAULT,
  CALL_FRAME_MS,
} from './call-constants.js';
import { CallCarrierBank } from './call-carrier.js';
import {
  createCallAmbientStream,
  DEFAULT_CALL_AMBIENT_PROFILE,
  ALL_CALL_PROFILE_IDS,
  resolveProfileId,
} from './call-ambient.js';
import {
  CrossfadeMusicEngine,
  decodeMeditationBuffer,
  ensureMeditationBytes,
  preloadMeditationAudio,
  getMeditationLoadMeta,
  setMeditationMusicStats,
  MEDITATION_MUSIC_GAIN_DEFAULT,
  MUSIC_CROSSFADE_SECONDS,
  MUSIC_STOP_FADE_SECONDS,
} from '../meditation-audio.js';
import {
  ACOUSTIC_CONFIG,
  callLevelsForPreset,
  relativeDbToGain,
  measureFloat32Stats,
  measureAudioBufferStats,
  rampGainTo,
} from '../acoustic-config.js';

export { preloadMeditationAudio, getMeditationLoadMeta, ACOUSTIC_CONFIG };

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function raisedCosine(x) {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
}

function symbolBitsFromByte(sym) {
  const bits = new Uint8Array(CALL_CHANNEL_COUNT);
  for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
    bits[ch] = (sym >> (CALL_CHANNEL_COUNT - 1 - ch)) & 1;
  }
  return bits;
}

export function buildCallTransmitSymbols(message) {
  const encoded = encodeCallMessage(message);
  const preamble = CALL_PREAMBLE.map(symbolBitsFromByte);
  const data = [];
  for (let i = 0; i < encoded.callDataSymbols.length; i++) {
    data.push(symbolBitsFromByte(encoded.callDataSymbols[i]));
  }
  const frameSymbols = preamble.concat(data);
  return { ...encoded, frameSymbols, preambleSymbols: preamble, dataSymbolsBits: data };
}

/**
 * Stateful continuous call-v1 renderer.
 */
export class CallStreamingTxRenderer {
  constructor(opts) {
    const {
      message,
      sampleRate,
      profileId = DEFAULT_CALL_AMBIENT_PROFILE,
      deltaDb = BASE_TOTAL_DIFFERENTIAL_DB,
      enhancementDeltaDb = ENHANCEMENT_DIFFERENTIAL_DB,
      neutral = false,
      enableEnhancement = true,
      ambientSeed = CALL_AMBIENT_SEED_DEFAULT,
      carrierSeed = CALL_CARRIER_SEED_DEFAULT,
      carrierLevel = CALL_CARRIER_LEVEL,
      ambientMix = CALL_AMBIENT_MIX,
      ambientDebug = null,
    } = opts;

    this.sampleRate = sampleRate;
    this.profileId = resolveProfileId(profileId);
    this.deltaDb = deltaDb;
    this.enhancementDeltaDb = enhancementDeltaDb;
    this.neutral = neutral;
    this.enableEnhancement = enableEnhancement;
    this.carrierLevel = carrierLevel;
    this.baseCarrierLevel = opts.baseCarrierLevel != null ? opts.baseCarrierLevel : null;
    this.enhCarrierLevel = opts.enhCarrierLevel != null ? opts.enhCarrierLevel : null;
    this.ambientMix = ambientMix;
    this.halfDelta = deltaDb / 2;
    this.halfEnh = enhancementDeltaDb / 2;
    this.ambientDebug = ambientDebug;

    const built = buildCallTransmitSymbols(message);
    this.encoded = built;
    this.frameSymbols = built.frameSymbols;
    this.chipSamples = Math.round((CHIP_MS / 1000) * sampleRate);
    this.symbolSamples = this.chipSamples * CHIPS_PER_SYMBOL;
    this.crossfadeSamples = Math.max(
      1,
      Math.round((CROSSFADE_MS / 1000) * sampleRate)
    );
    this.frameSamples = this.symbolSamples * CALL_FRAME_SYMBOLS;

    this.ambient = createCallAmbientStream(
      this.profileId,
      sampleRate,
      ambientSeed,
      ambientDebug
    );
    this.carriers = new CallCarrierBank({
      sampleRate,
      seed: carrierSeed,
      includeEnhancement: enableEnhancement,
    });

    // Notch ambient at base (+enh) centres so bed energy does not dilute ratios
    this.notches = [];
    this.notchStates = [];
    const addNotch = (lo, hi, widen) => {
      const centre = 0.5 * (lo + hi);
      const bw = Math.max(60, hi - lo);
      // Triple cascade for deep nulls so ambient residual << ±Δ/2 dB
      this.notches.push(designBandReject(centre, sampleRate, bw * widen));
      this.notchStates.push(createBiquadState());
      this.notches.push(designBandReject(centre, sampleRate, bw * widen * 0.95));
      this.notchStates.push(createBiquadState());
      this.notches.push(designBandReject(centre, sampleRate, bw * widen * 0.85));
      this.notchStates.push(createBiquadState());
    };
    for (const ch of CALL_BASE_CHANNELS) {
      addNotch(ch[0], ch[1], 1.45);
      addNotch(ch[2], ch[3], 1.45);
    }
    if (enableEnhancement) {
      for (const ch of CALL_ENHANCEMENT_CHANNELS) {
        addNotch(ch[0], ch[1], 1.3);
        addNotch(ch[2], ch[3], 1.3);
      }
    }

    this.baseGain = new Float32Array(12);
    this.enhGain = new Float32Array(12);
    this.prevBaseGain = new Float32Array(12);
    this.prevEnhGain = new Float32Array(12);
    this.baseGain.fill(1);
    this.enhGain.fill(1);
    this.prevBaseGain.fill(1);
    this.prevEnhGain.fill(1);

    this.sampleIndex = 0;
    this.dataSampleIndex = 0;
    this.framesTransmitted = 0;
    this._lastChipKey = null;
  }

  _setGainsForChip(symbolBits, chipIndex) {
    const code = CALL_CHIP_CODE[chipIndex];
    for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
      const lowIdx = ch * 2;
      const highIdx = ch * 2 + 1;
      if (this.neutral || !symbolBits) {
        this.baseGain[lowIdx] = 1;
        this.baseGain[highIdx] = 1;
        this.enhGain[lowIdx] = 1;
        this.enhGain[highIdx] = 1;
        continue;
      }
      const bit = symbolBits[ch];
      // bit1 → +code, bit0 → −code as differential sign
      const sign = bit ? code : -code;
      this.baseGain[lowIdx] = dbToLinear(sign * this.halfDelta);
      this.baseGain[highIdx] = dbToLinear(-sign * this.halfDelta);
      if (this.enableEnhancement) {
        this.enhGain[lowIdx] = dbToLinear(sign * this.halfEnh);
        this.enhGain[highIdx] = dbToLinear(-sign * this.halfEnh);
      } else {
        this.enhGain[lowIdx] = 1;
        this.enhGain[highIdx] = 1;
      }
    }
  }

  _symbolAt(globalSymbolIndex) {
    if (globalSymbolIndex < 0) return null;
    return this.frameSymbols[globalSymbolIndex % this.frameSymbols.length];
  }

  renderChunk(opts) {
    const {
      lengthSamples,
      fadeIn = false,
      fadeOut = false,
      ambientOnly = false,
      fadeInMs = CALL_FADE_IN_MS,
      fadeOutMs = CALL_FADE_OUT_MS,
      watermarkEnabled = true,
      splitCarriers = false,
    } = opts;

    const ambient = this.ambient.render(lengthSamples);
    const out = new Float32Array(lengthSamples);
    const baseOut = splitCarriers ? new Float32Array(lengthSamples) : null;
    const enhOut = splitCarriers ? new Float32Array(lengthSamples) : null;

    for (let i = 0; i < lengthSamples; i++) {
      let x = ambient[i];
      for (let b = 0; b < this.notches.length; b++) {
        x = processBiquad(x, this.notches[b], this.notchStates[b]);
      }
      out[i] = x * this.ambientMix;
    }

    const baseBands = new Float32Array(12);
    const enhBands = new Float32Array(12);
    const useWm = watermarkEnabled && !ambientOnly;
    const baseLevel = this.baseCarrierLevel != null ? this.baseCarrierLevel : this.carrierLevel;
    const enhLevel = this.enhCarrierLevel != null ? this.enhCarrierLevel : this.carrierLevel;

    for (let i = 0; i < lengthSamples; i++) {
      this.carriers.next(baseBands, this.enableEnhancement ? enhBands : null);

      if (ambientOnly) {
        continue;
      }

      let posInChip = this.crossfadeSamples;
      if (useWm) {
        const symIndex = Math.floor(this.dataSampleIndex / this.symbolSamples);
        const posInSym = this.dataSampleIndex % this.symbolSamples;
        const chipIndex = Math.floor(posInSym / this.chipSamples);
        posInChip = posInSym % this.chipSamples;
        const chipKey = `${symIndex}:${chipIndex}`;
        this.dataSampleIndex++;

        if (chipKey !== this._lastChipKey) {
          this.prevBaseGain.set(this.baseGain);
          this.prevEnhGain.set(this.enhGain);
          this._setGainsForChip(this._symbolAt(symIndex), chipIndex);
          this._lastChipKey = chipKey;
        }
      } else {
        this.baseGain.fill(1);
        this.enhGain.fill(1);
        this.prevBaseGain.fill(1);
        this.prevEnhGain.fill(1);
      }

      let wPrev = 0;
      let wCur = 1;
      if (useWm && posInChip < this.crossfadeSamples) {
        const x = raisedCosine(posInChip / this.crossfadeSamples);
        wPrev = 1 - x;
        wCur = x;
      }

      let baseWm = 0;
      for (let b = 0; b < 12; b++) {
        const g = wPrev * this.prevBaseGain[b] + wCur * this.baseGain[b];
        baseWm += baseBands[b] * g;
      }
      let enhWm = 0;
      if (this.enableEnhancement) {
        for (let b = 0; b < 12; b++) {
          const g = wPrev * this.prevEnhGain[b] + wCur * this.enhGain[b];
          enhWm += enhBands[b] * g;
        }
      }

      if (splitCarriers) {
        // Keep PCM in a safe reference range; relative level is on GainNodes.
        const REF = 0.05;
        baseOut[i] = baseWm * REF;
        enhOut[i] = enhWm * REF;
      } else {
        out[i] += baseWm * baseLevel + enhWm * enhLevel;
      }
    }

    this.sampleIndex += lengthSamples;
    if (useWm) {
      this.framesTransmitted = Math.floor(
        this.dataSampleIndex / this.frameSamples
      );
    }

    if (fadeIn) applyFades(out, this.sampleRate, fadeInMs, 0);
    if (fadeOut) applyFades(out, this.sampleRate, 0, fadeOutMs);
    if (splitCarriers) {
      if (fadeIn) {
        applyFades(baseOut, this.sampleRate, fadeInMs, 0);
        applyFades(enhOut, this.sampleRate, fadeInMs, 0);
      }
      if (fadeOut) {
        applyFades(baseOut, this.sampleRate, 0, fadeOutMs);
        applyFades(enhOut, this.sampleRate, 0, fadeOutMs);
      }
    }

    // Soft-clip only when a loud ambient bed is present (Air / procedural).
    // Meditation path must not nonlinearly warp watermark ratios.
    let peak = 0;
    if (this.ambientMix > 0.01 && !splitCarriers) {
      for (let i = 0; i < out.length; i++) {
        const y = Math.tanh(out[i] * 1.1);
        out[i] = y;
        const a = Math.abs(y);
        if (a > peak) peak = a;
      }
      if (peak > 0.92) {
        const scale = 0.92 / peak;
        for (let i = 0; i < out.length; i++) out[i] *= scale;
        peak = 0.92;
      }
    } else {
      for (let i = 0; i < out.length; i++) {
        const a = Math.abs(out[i]);
        if (a > peak) peak = a;
      }
      if (splitCarriers) {
        for (let i = 0; i < lengthSamples; i++) {
          peak = Math.max(peak, Math.abs(baseOut[i]), Math.abs(enhOut[i]));
        }
      }
    }

    return {
      samples: out,
      baseSamples: baseOut,
      enhSamples: enhOut,
      peak,
      rmsDb: measureRmsDbFs(out),
      sampleIndex: this.sampleIndex,
      framesTransmitted: this.framesTransmitted,
    };
  }
}

/**
 * Live continuous call transmitter (Web Audio clock scheduling).
 */
export class CallContinuousTransmitter {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.musicBus = null;
    this.watermarkBus = null; // Air / combined
    this.baseWatermarkBus = null; // callBaseWatermarkBus
    this.enhancementWatermarkBus = null; // callEnhancementWatermarkBus
    this.musicEngine = null;
    this.renderer = null;
    this.playing = false;
    this.stopping = false;
    this.profileId = DEFAULT_CALL_AMBIENT_PROFILE;
    this.deltaDb = BASE_TOTAL_DIFFERENTIAL_DB;
    this.enableEnhancement = true;
    this.watermarkEnabled = true;
    this.musicOnly = false;
    this.ambientSeed = CALL_AMBIENT_SEED_DEFAULT;
    this.carrierSeed = CALL_CARRIER_SEED_DEFAULT;
    this.ambientDebug = null;
    this.message = '';
    this.nextScheduleTime = 0;
    this.timer = null;
    this.activeSources = new Set();
    this.sessionStartPerf = 0;
    this.framesScheduled = 0;
    this.onState = null;
    this.LOOKAHEAD_S = 1.0;
    this.CHUNK_SYMBOLS = 8;
    this.FADE_IN_S = CALL_FADE_IN_MS / 1000;
    this.FADE_OUT_S = CALL_FADE_OUT_MS / 1000;
    this.leadInS = 1.0;
    this.musicGain = ACOUSTIC_CONFIG.meditationMusicGain;
    this.crossfadeSeconds = MUSIC_CROSSFADE_SECONDS;
    this.meditationMeta = null;
    this.callPreset = ACOUSTIC_CONFIG.call.defaultPreset;
    const levels = callLevelsForPreset(this.callPreset);
    this.callBaseRelativeDb = levels.baseDb;
    this.callEnhRelativeDb = levels.enhancementDb;
    this.musicStats = null;
    this.baseCarrierRefStats = null;
    this.enhCarrierRefStats = null;
    this.splitMeditation = false;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  setProfile(id) {
    const resolved = resolveProfileId(id);
    if (!ALL_CALL_PROFILE_IDS.includes(resolved)) {
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

  setWatermarkEnabled(on) {
    this.watermarkEnabled = !!on;
    if (this.playing) this._applyCallCarrierGains(true);
  }

  setMusicOnly(on) {
    this.musicOnly = !!on;
    if (this.playing) this._applyCallCarrierGains(true);
  }

  setMusicGain(g) {
    this.musicGain = Math.max(0.4, Math.min(1.2, Number(g) || ACOUSTIC_CONFIG.meditationMusicGain));
    if (this.musicEngine) this.musicEngine.setMusicGain(this.musicGain);
  }

  setCrossfadeSeconds(s) {
    this.crossfadeSeconds = Math.max(5, Math.min(12, Number(s) || MUSIC_CROSSFADE_SECONDS));
    if (this.musicEngine) this.musicEngine.setCrossfadeSeconds(this.crossfadeSeconds);
  }

  /** Live-safe preset change — only GainNodes ramp. */
  setCallPreset(presetId) {
    if (!(presetId in ACOUSTIC_CONFIG.call.presets)) {
      throw new Error(`Unknown call preset ${presetId}`);
    }
    this.callPreset = presetId;
    const levels = callLevelsForPreset(presetId);
    this.callBaseRelativeDb = levels.baseDb;
    this.callEnhRelativeDb = levels.enhancementDb;
    this._applyCallCarrierGains(true);
  }

  _applyCallCarrierGains(ramp) {
    if (!this.ctx) return;
    const silent = !this.watermarkEnabled || this.musicOnly;
    if (this.splitMeditation) {
      const baseG = silent
        ? 0
        : relativeDbToGain(
            this.musicStats?.rmsDb,
            this.callBaseRelativeDb,
            this.baseCarrierRefStats?.rmsDb
          );
      const enhG = silent
        ? 0
        : relativeDbToGain(
            this.musicStats?.rmsDb,
            this.callEnhRelativeDb,
            this.enhCarrierRefStats?.rmsDb
          );
      if (this.baseWatermarkBus) {
        if (ramp) rampGainTo(this.baseWatermarkBus, baseG, this.ctx);
        else this.baseWatermarkBus.gain.value = baseG;
      }
      if (this.enhancementWatermarkBus) {
        if (ramp) rampGainTo(this.enhancementWatermarkBus, enhG, this.ctx);
        else this.enhancementWatermarkBus.gain.value = enhG;
      }
    } else if (this.watermarkBus) {
      const g = silent ? 0 : 1;
      if (ramp) rampGainTo(this.watermarkBus, g, this.ctx);
      else this.watermarkBus.gain.value = g;
    }
  }

  _calibrateCallCarrierRefs(sampleRate, message) {
    const cal = new CallStreamingTxRenderer({
      message,
      sampleRate,
      profileId: 'meditation',
      deltaDb: this.deltaDb,
      enableEnhancement: true,
      ambientSeed: this.ambientSeed,
      carrierSeed: this.carrierSeed,
      ambientMix: 0,
      carrierLevel: 1,
      baseCarrierLevel: 1,
      enhCarrierLevel: 1,
    });
    const n = Math.max(2048, Math.round(sampleRate * 0.5));
    const chunk = cal.renderChunk({
      lengthSamples: n,
      ambientOnly: false,
      splitCarriers: true,
      watermarkEnabled: true,
    });
    return {
      base: measureFloat32Stats(chunk.baseSamples),
      enh: measureFloat32Stats(chunk.enhSamples),
    };
  }

  async start(message) {
    await this.stop({ immediate: true });
    const ctx = await this.ensureContext();

    const useMusic = this.profileId === 'meditation';
    this.splitMeditation = useMusic;
    let decoded = null;
    if (useMusic) {
      this._emit('preparing');
      try {
        await ensureMeditationBytes();
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
        console.warn('[meditation]', detail);
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

    if (useMusic) {
      const refs = this._calibrateCallCarrierRefs(ctx.sampleRate, message);
      this.baseCarrierRefStats = refs.base;
      this.enhCarrierRefStats = refs.enh;
    } else {
      this.baseCarrierRefStats = null;
      this.enhCarrierRefStats = null;
    }

    this.renderer = new CallStreamingTxRenderer({
      message,
      sampleRate: ctx.sampleRate,
      profileId: this.profileId,
      deltaDb: this.deltaDb,
      enableEnhancement: this.enableEnhancement,
      ambientSeed: this.ambientSeed,
      carrierSeed: this.carrierSeed,
      ambientDebug: this.ambientDebug,
      // Meditation: no support bed / Air / hiss — carriers only on dedicated buses.
      ambientMix: useMusic || this.musicOnly ? 0 : CALL_AMBIENT_MIX,
      carrierLevel:
        !useMusic && this.watermarkEnabled && !this.musicOnly
          ? CALL_CARRIER_LEVEL
          : 0,
      baseCarrierLevel: useMusic ? 1 : null,
      enhCarrierLevel: useMusic ? 1 : null,
    });

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = useMusic
      ? ACOUSTIC_CONFIG.masterGain
      : 1;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(this.masterGain);

    if (useMusic) {
      this.baseWatermarkBus = ctx.createGain();
      this.enhancementWatermarkBus = ctx.createGain();
      this.baseWatermarkBus.connect(this.masterGain);
      this.enhancementWatermarkBus.connect(this.masterGain);
      this.watermarkBus = null;
      this._applyCallCarrierGains(false);
    } else {
      this.watermarkBus = ctx.createGain();
      this.watermarkBus.gain.value = 1;
      this.watermarkBus.connect(this.masterGain);
      this.baseWatermarkBus = null;
      this.enhancementWatermarkBus = null;
    }
    this.masterGain.connect(ctx.destination);

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
        splitCarriers: useMusic,
      });
      this._scheduleChunk(lead, t0);
      this.nextScheduleTime = t0 + leadSamples / ctx.sampleRate;
      this._emit('playing');
      this._tick();
    } else {
      this.nextScheduleTime = t0;
      this._emit('playing');
    }
  }

  _tick() {
    if (!this.playing || this.stopping || this.musicOnly) return;
    const ctx = this.ctx;
    const chunkSamples = this.renderer.symbolSamples * this.CHUNK_SYMBOLS;

    while (this.nextScheduleTime < ctx.currentTime + this.LOOKAHEAD_S + 0.25) {
      const chunk = this.renderer.renderChunk({
        lengthSamples: chunkSamples,
        ambientOnly: false,
        watermarkEnabled: true, // bus gain gates audibility for A/B
        splitCarriers: this.splitMeditation,
      });
      this._scheduleChunk(chunk, this.nextScheduleTime);
      this.nextScheduleTime += chunk.samples.length / ctx.sampleRate;
      this.framesScheduled = this.renderer.framesTransmitted;
    }

    this.timer = setTimeout(() => this._tick(), 120);
  }

  _scheduleChunk(chunk, when) {
    if (this.splitMeditation) {
      if (chunk.baseSamples) {
        this._scheduleBuffer(chunk.baseSamples, when, this.baseWatermarkBus);
      }
      if (chunk.enhSamples) {
        this._scheduleBuffer(chunk.enhSamples, when, this.enhancementWatermarkBus);
      }
      return;
    }
    this._scheduleBuffer(chunk.samples, when, this.watermarkBus || this.masterGain);
  }

  _scheduleBuffer(samples, when, bus) {
    const ctx = this.ctx;
    if (!bus || !samples) return;
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
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
    src.start(startAt);
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
      if (this.musicEngine) {
        try {
          await this.musicEngine.stop({ fadeS: 0 });
        } catch {
          /* ignore */
        }
        this.musicEngine = null;
      }
      this._cleanupSources();
      this._emit('stopped');
      return;
    }

    if (immediate) {
      try {
        this.masterGain.gain.cancelScheduledValues(ctx.currentTime);
        this.masterGain.gain.value = 0;
      } catch {
        /* ignore */
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
      this._emit('stopped');
      return;
    }

    const fadeS = Math.max(this.FADE_OUT_S, MUSIC_STOP_FADE_SECONDS);
    const now = ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(0, now + fadeS);
    if (this.musicEngine) {
      this.musicEngine.stop({ fadeS }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, fadeS * 1000 + 50));

    this._cleanupSources();
    this.musicEngine = null;
    this._disconnectBuses();
    this.renderer = null;
    this.playing = false;
    this.stopping = false;
    this._emit('stopped');
  }

  _disconnectBuses() {
    for (const node of [
      this.musicBus,
      this.watermarkBus,
      this.baseWatermarkBus,
      this.enhancementWatermarkBus,
      this.masterGain,
    ]) {
      if (!node) continue;
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.musicBus = null;
    this.watermarkBus = null;
    this.baseWatermarkBus = null;
    this.enhancementWatermarkBus = null;
    this.masterGain = null;
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
    const baseGain = this.baseWatermarkBus?.gain?.value ?? null;
    const enhGain = this.enhancementWatermarkBus?.gain?.value ?? null;
    const baseRmsDb =
      this.baseCarrierRefStats && baseGain != null
        ? this.baseCarrierRefStats.rmsDb +
          20 * Math.log10(Math.max(baseGain, 1e-12))
        : null;
    const enhRmsDb =
      this.enhCarrierRefStats && enhGain != null
        ? this.enhCarrierRefStats.rmsDb +
          20 * Math.log10(Math.max(enhGain, 1e-12))
        : null;
    return {
      profile: this.profileId,
      playing: this.playing,
      deltaDb: this.deltaDb,
      watermarkEnabled: this.watermarkEnabled,
      enableEnhancement: this.enableEnhancement,
      musicOnly: this.musicOnly,
      musicGain: this.musicGain,
      crossfadeSeconds: this.crossfadeSeconds,
      music,
      meditationMeta: this.meditationMeta,
      meditationLoad: getMeditationLoadMeta(),
      message: this.message,
      sampleRate: this.ctx?.sampleRate ?? null,
      framesTransmitted: this.renderer?.framesTransmitted ?? 0,
      sessionDurationMs: this.playing
        ? performance.now() - this.sessionStartPerf
        : 0,
      frameMs: CALL_FRAME_MS,
      symbolMs: SYMBOL_MS,
      activeSources: this.activeSources.size,
      callPreset: this.callPreset,
      callBaseRelativeDb: this.callBaseRelativeDb,
      callEnhRelativeDb: this.callEnhRelativeDb,
      musicRmsDb: musicStats?.rmsDb ?? null,
      musicPeakDb: musicStats?.peakDb ?? null,
      callBaseRmsDb: baseRmsDb,
      callBaseRelativeMeasuredDb:
        musicStats && baseRmsDb != null ? baseRmsDb - musicStats.rmsDb : null,
      callEnhRmsDb: enhRmsDb,
      callEnhRelativeMeasuredDb:
        musicStats && enhRmsDb != null ? enhRmsDb - musicStats.rmsDb : null,
      masterGain: this.masterGain?.gain?.value ?? null,
    };
  }
}

/**
 * Offline render for tests.
 */
export function renderCallTransmission(opts) {
  const {
    message,
    sampleRate,
    profileId = 'air',
    frameCount = 1,
    deltaDb = BASE_TOTAL_DIFFERENTIAL_DB,
    includeFadeIn = true,
    includeFadeOut = true,
    leadInMs = includeFadeIn ? CALL_FADE_IN_MS : 0,
    trailOutMs = includeFadeOut ? CALL_FADE_OUT_MS : 0,
    watermarkEnabled = true,
    ...rest
  } = opts;

  const renderer = new CallStreamingTxRenderer({
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
        fadeInMs: CALL_FADE_IN_MS,
      }).samples
    );
  }

  parts.push(
    renderer.renderChunk({
      lengthSamples: renderer.frameSamples * frameCount,
      ambientOnly: false,
      watermarkEnabled,
    }).samples
  );

  if (trailOutMs > 0) {
    parts.push(
      renderer.renderChunk({
        lengthSamples: Math.round((trailOutMs / 1000) * sampleRate),
        ambientOnly: true,
        fadeOut: includeFadeOut,
        fadeOutMs: CALL_FADE_OUT_MS,
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
    symbolSamples: renderer.symbolSamples,
    frameSamples: renderer.frameSamples,
    chipSamples: renderer.chipSamples,
    durationMs: (out.length / sampleRate) * 1000,
  };
}
