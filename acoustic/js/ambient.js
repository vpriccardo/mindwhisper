/**
 * Procedural calm ambient / rain / air texture for watermark carrier.
 * Seeded PRNG for reproducible tests.
 */

import { createXorshift32, AMBIENT_SEED_DEFAULT } from './protocol.js';

const PAD_FREQS = [146.83, 220.0, 329.63]; // D3 A3 E4

/**
 * Render ambient layers into a mono Float32Array (no watermark).
 * @param {number} sampleRate
 * @param {number} lengthSamples
 * @param {number} [seed]
 * @returns {Float32Array}
 */
export function renderAmbient(sampleRate, lengthSamples, seed = AMBIENT_SEED_DEFAULT) {
  const out = new Float32Array(lengthSamples);
  const rng = createXorshift32(seed);

  // Pre-generate noise buffers for wind and rain (continuous, no per-symbol reset)
  const windNoise = new Float32Array(lengthSamples);
  const rainNoise = new Float32Array(lengthSamples);
  let brown = 0;
  for (let i = 0; i < lengthSamples; i++) {
    const white = rng.nextGaussian();
    brown = 0.996 * brown + 0.04 * white;
    windNoise[i] = brown;
    rainNoise[i] = white;
  }

  // One-pole / simple biquad-ish filters (inline for offline render)
  // Wind: band-ish 100 Hz – 3 kHz via HP + LP
  const wind = filterBand(windNoise, sampleRate, 100, 3000);
  // Rain: 2 kHz – 13 kHz
  const rain = filterBand(rainNoise, sampleRate, 2000, Math.min(13000, sampleRate * 0.45));

  // Pad oscillators with slow amplitude
  const pad = new Float32Array(lengthSamples);
  const detuneRng = createXorshift32(seed ^ 0x5555);
  for (const f0 of PAD_FREQS) {
    const det = 1 + (detuneRng.nextFloat() - 0.5) * 0.003;
    const f = f0 * det;
    let phase = detuneRng.nextFloat() * Math.PI * 2;
    const phaseInc = (2 * Math.PI * f) / sampleRate;
    // second slightly detuned partial
    let phase2 = detuneRng.nextFloat() * Math.PI * 2;
    const f2 = f * (1 + 0.0015);
    const phaseInc2 = (2 * Math.PI * f2) / sampleRate;
    for (let i = 0; i < lengthSamples; i++) {
      const t = i / sampleRate;
      const slowEnv = 0.85 + 0.15 * Math.sin(2 * Math.PI * t * 0.07 + f0 * 0.01);
      const s =
        Math.sin(phase) * 0.55 +
        Math.sin(phase2) * 0.25 +
        Math.sin(phase * 2) * 0.08; // soft triangle-ish
      pad[i] += s * slowEnv;
      phase += phaseInc;
      phase2 += phaseInc2;
    }
  }
  // Low-pass pad ~1.2 kHz
  const padLp = onePoleLowpass(pad, sampleRate, 1200);

  // Mix layers with calm balances
  const gainPad = 0.12;
  const gainWind = 0.22;
  const gainRain = 0.28;

  for (let i = 0; i < lengthSamples; i++) {
    const t = i / sampleRate;
    const windMod = 0.75 + 0.25 * Math.sin(2 * Math.PI * t * 0.04);
    const rainMod = 0.85 + 0.15 * Math.sin(2 * Math.PI * t * 0.11 + 1.3);
    out[i] =
      padLp[i] * gainPad +
      wind[i] * gainWind * windMod +
      rain[i] * gainRain * rainMod;
  }

  return out;
}

function onePoleLowpass(input, sampleRate, cutoffHz) {
  const out = new Float32Array(input.length);
  const x = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let y = 0;
  for (let i = 0; i < input.length; i++) {
    y = (1 - x) * input[i] + x * y;
    out[i] = y;
  }
  return out;
}

function onePoleHighpass(input, sampleRate, cutoffHz) {
  const out = new Float32Array(input.length);
  const x = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < input.length; i++) {
    const y = x * (prevOut + input[i] - prevIn);
    out[i] = y;
    prevIn = input[i];
    prevOut = y;
  }
  return out;
}

function filterBand(input, sampleRate, lowHz, highHz) {
  const hp = onePoleHighpass(input, sampleRate, lowHz);
  return onePoleLowpass(hp, sampleRate, highHz);
}

/**
 * Apply raised-cosine fade in/out in-place.
 */
export function applyFades(buffer, sampleRate, fadeInMs, fadeOutMs) {
  const fadeInN = Math.min(buffer.length, Math.floor((fadeInMs / 1000) * sampleRate));
  const fadeOutN = Math.min(buffer.length, Math.floor((fadeOutMs / 1000) * sampleRate));
  for (let i = 0; i < fadeInN; i++) {
    const x = i / fadeInN;
    const g = 0.5 - 0.5 * Math.cos(Math.PI * x);
    buffer[i] *= g;
  }
  for (let i = 0; i < fadeOutN; i++) {
    const x = i / fadeOutN;
    const g = 0.5 - 0.5 * Math.cos(Math.PI * (1 - x));
    buffer[buffer.length - 1 - i] *= g;
  }
}

/**
 * Normalize so peak <= peakTarget; return { peak, rms }.
 */
export function normalizePeak(buffer, peakTarget = 0.85) {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]);
    if (a > peak) peak = a;
    sumSq += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSq / buffer.length);
  if (peak > 1e-12) {
    const scale = peakTarget / peak;
    for (let i = 0; i < buffer.length; i++) buffer[i] *= scale;
    peak = peakTarget;
    // rms scales too
    return { peak, rms: rms * scale, scale };
  }
  return { peak, rms, scale: 1 };
}

export function measureRmsDbFs(buffer) {
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i];
  const rms = Math.sqrt(sumSq / buffer.length);
  return 20 * Math.log10(Math.max(rms, 1e-12));
}
