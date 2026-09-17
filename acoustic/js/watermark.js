/**
 * Differential spectral watermark modulation over ambient carrier.
 * Sixteen narrow-band noise components; relative energy encodes bits.
 */

import {
  WATERMARK_CHANNELS,
  BANDWIDTH_HZ,
  CHANNEL_COUNT,
  SYMBOL_MS,
  CROSSFADE_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  FRAME_REPETITIONS,
  FRAME_SYMBOLS,
  WATERMARK_DELTA_DB_DEFAULT,
  WATERMARK_NOISE_SEED_DEFAULT,
  AMBIENT_SEED_DEFAULT,
  TOTAL_TX_MS,
  buildTransmitSymbols,
  createXorshift32,
} from './protocol.js';
import {
  renderAmbient,
  applyFades,
  normalizePeak,
  measureRmsDbFs,
} from './ambient.js';

/**
 * Design a biquad band-pass (RBJ cookbook) for centreHz with Q ≈ centre/bandwidth.
 */
export function designBandpass(centreHz, sampleRate, bandwidthHz = BANDWIDTH_HZ) {
  const nyquist = sampleRate * 0.5;
  if (centreHz >= nyquist * 0.95) {
    throw new Error(`Centre ${centreHz} Hz too close to Nyquist ${nyquist}`);
  }
  const Q = centreHz / bandwidthHz;
  const w0 = (2 * Math.PI * centreHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    centreHz,
    Q,
  };
}

/** RBJ band-reject / notch — clears ambient energy so watermark bands dominate locally. */
export function designBandReject(centreHz, sampleRate, bandwidthHz = BANDWIDTH_HZ) {
  const Q = centreHz / bandwidthHz;
  const w0 = (2 * Math.PI * centreHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const b0 = 1;
  const b1 = -2 * cosw0;
  const b2 = 1;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    centreHz,
    Q,
  };
}

export function createBiquadState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

export function processBiquad(sample, coef, state) {
  const y =
    coef.b0 * sample +
    coef.b1 * state.x1 +
    coef.b2 * state.x2 -
    coef.a1 * state.y1 -
    coef.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = sample;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

/**
 * Raised-cosine crossfade weight from 0→1 over crossfadeSamples.
 */
function raisedCosine(x) {
  // x in [0,1]
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
}

/**
 * Render full TX AudioBuffer contents (mono Float32Array).
 *
 * @param {object} opts
 * @param {string} opts.message
 * @param {number} opts.sampleRate
 * @param {number} [opts.deltaDb] total differential Δ
 * @param {boolean} [opts.neutral] if true, equal band gains (A/B imperceptibility)
 * @param {number} [opts.ambientSeed]
 * @param {number} [opts.watermarkNoiseSeed]
 * @param {number} [opts.carrierLevel] linear mix level of watermark texture
 */
export function renderWatermarkedAudio(opts) {
  const {
    message,
    sampleRate,
    deltaDb = WATERMARK_DELTA_DB_DEFAULT,
    neutral = false,
    ambientSeed = AMBIENT_SEED_DEFAULT,
    watermarkNoiseSeed = WATERMARK_NOISE_SEED_DEFAULT,
    // Watermark texture level relative to notched ambient (perceptual blend).
    carrierLevel = 0.55,
  } = opts;

  const { allSymbols, ...encoded } = buildTransmitSymbols(message);
  const totalMs = TOTAL_TX_MS;
  const lengthSamples = Math.round((totalMs / 1000) * sampleRate);
  const fadeInSamples = Math.round((FADE_IN_MS / 1000) * sampleRate);
  const symbolSamples = Math.round((SYMBOL_MS / 1000) * sampleRate);
  const crossfadeSamples = Math.max(1, Math.round((CROSSFADE_MS / 1000) * sampleRate));

  // Ambient bed — notch watermark centres so differential bands are not diluted
  // by uncorrelated rain energy at the same frequencies.
  let ambient = renderAmbient(sampleRate, lengthSamples, ambientSeed);
  {
    const notches = [];
    const notchStates = [];
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const [lowHz, highHz] = WATERMARK_CHANNELS[ch];
      // Slightly wider notch than TX band-pass so skirts clear
      notches.push(designBandReject(lowHz, sampleRate, BANDWIDTH_HZ * 1.35));
      notches.push(designBandReject(highHz, sampleRate, BANDWIDTH_HZ * 1.35));
      notchStates.push(createBiquadState(), createBiquadState());
    }
    const notched = new Float32Array(lengthSamples);
    for (let i = 0; i < lengthSamples; i++) {
      let x = ambient[i];
      for (let b = 0; b < notches.length; b++) {
        x = processBiquad(x, notches[b], notchStates[b]);
      }
      notched[i] = x;
    }
    ambient = notched;
  }

  // Shared continuous drive (never reset per-symbol) through cascaded band-passes
  // for sharper skirts / less adjacent-channel crosstalk.
  const noiseRng = createXorshift32(watermarkNoiseSeed);
  const drive = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) {
    drive[i] = noiseRng.nextGaussian();
  }

  const filtersA = [];
  const filtersB = [];
  const statesA = [];
  const statesB = [];
  const txBandwidth = BANDWIDTH_HZ;
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const [lowHz, highHz] = WATERMARK_CHANNELS[ch];
    filtersA.push(designBandpass(lowHz, sampleRate, txBandwidth));
    filtersA.push(designBandpass(highHz, sampleRate, txBandwidth));
    filtersB.push(designBandpass(lowHz, sampleRate, txBandwidth));
    filtersB.push(designBandpass(highHz, sampleRate, txBandwidth));
    statesA.push(createBiquadState(), createBiquadState());
    statesB.push(createBiquadState(), createBiquadState());
  }

  const bands = Array.from({ length: 16 }, () => new Float32Array(lengthSamples));
  for (let i = 0; i < lengthSamples; i++) {
    const x = drive[i];
    for (let b = 0; b < 16; b++) {
      const y1 = processBiquad(x, filtersA[b], statesA[b]);
      bands[b][i] = processBiquad(y1, filtersB[b], statesB[b]);
    }
  }

  // Equalize average energy of each band before modulation (over full buffer)
  const bandGain = new Float32Array(16);
  for (let b = 0; b < 16; b++) {
    let sumSq = 0;
    for (let i = 0; i < lengthSamples; i++) sumSq += bands[b][i] * bands[b][i];
    const rms = Math.sqrt(sumSq / lengthSamples);
    bandGain[b] = rms > 1e-12 ? 1 / rms : 1;
  }

  const halfDelta = deltaDb / 2;
  const out = new Float32Array(lengthSamples);

  // Copy ambient
  out.set(ambient);

  // Previous and current modulation gains per band (linear)
  const prevGain = new Float32Array(16);
  const curGain = new Float32Array(16);
  for (let b = 0; b < 16; b++) {
    prevGain[b] = 1;
    curGain[b] = 1;
  }

  function setGainsFromSymbol(symbolBits) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const lowIdx = ch * 2;
      const highIdx = ch * 2 + 1;
      if (neutral) {
        curGain[lowIdx] = 1;
        curGain[highIdx] = 1;
      } else {
        const bit = symbolBits[ch];
        // bit 1: LOW +Δ/2, HIGH -Δ/2
        // bit 0: LOW -Δ/2, HIGH +Δ/2
        if (bit === 1) {
          curGain[lowIdx] = dbToLinear(+halfDelta);
          curGain[highIdx] = dbToLinear(-halfDelta);
        } else {
          curGain[lowIdx] = dbToLinear(-halfDelta);
          curGain[highIdx] = dbToLinear(+halfDelta);
        }
      }
    }
  }

  // Ambient-only during fade-in (neutral equal bands still mixed for continuity of texture)
  const neutralBits = new Uint8Array(CHANNEL_COUNT); // all 0 — but we'll force neutral gains
  const wasNeutral = neutral;
  // During fade-in: use equal gains regardless
  for (let b = 0; b < 16; b++) {
    prevGain[b] = 1;
    curGain[b] = 1;
  }

  // Helper to mix watermark for a sample range with crossfade from prev→cur at start
  function mixRange(start, end, doCrossfade) {
    const cf = doCrossfade ? crossfadeSamples : 0;
    for (let i = start; i < end && i < lengthSamples; i++) {
      const local = i - start;
      let wPrev = 0;
      let wCur = 1;
      if (cf > 0 && local < cf) {
        const x = raisedCosine(local / cf);
        wPrev = 1 - x;
        wCur = x;
      }
      let wm = 0;
      for (let b = 0; b < 16; b++) {
        const g = wPrev * prevGain[b] + wCur * curGain[b];
        wm += bands[b][i] * bandGain[b] * g;
      }
      out[i] += wm * carrierLevel;
    }
    // Advance prev
    prevGain.set(curGain);
  }

  // Fade-in region: equal watermark texture (no data)
  mixRange(0, fadeInSamples, false);

  // Data region: three frames of symbols, continuous
  let cursor = fadeInSamples;
  for (let s = 0; s < allSymbols.length; s++) {
    if (wasNeutral) {
      for (let b = 0; b < 16; b++) curGain[b] = 1;
    } else {
      setGainsFromSymbol(allSymbols[s]);
    }
    const end = cursor + symbolSamples;
    mixRange(cursor, end, true);
    cursor = end;
  }

  // Fade-out: hold last gains (or neutral) through remainder
  if (wasNeutral || allSymbols.length === 0) {
    for (let b = 0; b < 16; b++) curGain[b] = 1;
  }
  mixRange(cursor, lengthSamples, true);

  applyFades(out, sampleRate, FADE_IN_MS, FADE_OUT_MS);
  const { peak, rms, scale } = normalizePeak(out, 0.85);
  const rmsDb = measureRmsDbFs(out);

  return {
    samples: out,
    sampleRate,
    durationMs: (lengthSamples / sampleRate) * 1000,
    peak,
    rms,
    rmsDb,
    scale,
    deltaDb,
    neutral: wasNeutral,
    symbolCount: allSymbols.length,
    expectedSymbols: FRAME_SYMBOLS * FRAME_REPETITIONS,
    encoded,
    fadeInSamples,
    symbolSamples,
  };
}

/**
 * Render using OfflineAudioContext when available; falls back to direct Float32 render.
 * Returns AudioBuffer if ctx provided / OfflineAudioContext works.
 */
export async function renderToAudioBuffer(message, audioContext, options = {}) {
  const sampleRate = audioContext.sampleRate;
  const rendered = renderWatermarkedAudio({
    message,
    sampleRate,
    ...options,
  });

  const buffer = audioContext.createBuffer(1, rendered.samples.length, sampleRate);
  buffer.copyToChannel(rendered.samples, 0);
  return { buffer, meta: rendered };
}

/**
 * Attempt OfflineAudioContext render of silence-length matching our procedural path.
 * We still use our own DSP (more deterministic than graph scheduling); OfflineAudioContext
 * is used mainly to obtain a buffer at the correct sample rate when no live context exists.
 */
export async function renderOffline(message, sampleRate = 48000, options = {}) {
  const length = Math.round((TOTAL_TX_MS / 1000) * sampleRate);
  let ctx = null;
  if (typeof OfflineAudioContext !== 'undefined') {
    try {
      ctx = new OfflineAudioContext(1, length, sampleRate);
    } catch {
      ctx = null;
    }
  }
  const rendered = renderWatermarkedAudio({ message, sampleRate, ...options });
  if (ctx) {
    const buffer = ctx.createBuffer(1, rendered.samples.length, sampleRate);
    buffer.copyToChannel(rendered.samples, 0);
    return { buffer, meta: rendered, usedOfflineContext: true };
  }
  return { buffer: null, meta: rendered, usedOfflineContext: false, samples: rendered.samples };
}
