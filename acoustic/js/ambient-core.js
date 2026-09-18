/**
 * Deterministic procedural noise + stochastic control utilities.
 * Shared by Tide / Elements (room + call). No protocol / watermark logic.
 *
 * Pink: Paul Kellet refined filter (efficient, iPhone-safe).
 * Brown: leaky integrator + one-pole DC block (bounded).
 * Modulation: Ornstein–Uhlenbeck / smooth random targets (aperiodic).
 */

import { createXorshift32 } from './protocol.js';

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function onePoleLpCoef(sampleRate, cutoffHz) {
  const c = Math.max(1, Math.min(cutoffHz, sampleRate * 0.49));
  return Math.exp((-2 * Math.PI * c) / sampleRate);
}

export function onePoleHpCoef(sampleRate, cutoffHz) {
  const c = Math.max(1, Math.min(cutoffHz, sampleRate * 0.49));
  return Math.exp((-2 * Math.PI * c) / sampleRate);
}

/** Derive independent streams from one session seed (never restart mid-session). */
export function createSeededStreams(seed, names) {
  const out = {};
  let s = seed >>> 0 || 0x1;
  for (let i = 0; i < names.length; i++) {
    s = (Math.imul(s ^ (0x9e3779b9 + i * 0x85ebca6b), 0x27d4eb2d) >>> 0) || 0x1;
    out[names[i]] = createXorshift32(s);
  }
  return out;
}

/**
 * Lightweight pink noise (Paul Kellet refined method).
 * Documented coefficients; ~1/f spectrum without multi-octave bank cost.
 */
export function createPinkNoise(rng) {
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  return {
    next() {
      const white = rng.nextGaussian();
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      return pink * 0.11;
    },
  };
}

/** Brown-ish noise: leaky integrate white, DC-block, soft clamp. */
export function createBrownNoise(rng, { leak = 0.996, drive = 0.04 } = {}) {
  let y = 0;
  let dcX = 0;
  let dcY = 0;
  const dcR = 0.995;
  return {
    next() {
      const white = rng.nextGaussian();
      y = leak * y + drive * white;
      // DC block
      const x = y;
      dcY = x - dcX + dcR * dcY;
      dcX = x;
      return clamp(dcY, -4, 4);
    },
  };
}

/**
 * Smooth aperiodic modulator (Ornstein–Uhlenbeck toward random targets).
 * Bounded, smooth, deterministic when seeded — not a sine LFO.
 */
export function createSmoothRandomModulator(rng, {
  sampleRate,
  minHz = 0.02,
  maxHz = 0.18,
  minVal = 0,
  maxVal = 1,
  smoothness = 0.997,
} = {}) {
  let value = minVal + (maxVal - minVal) * 0.5;
  let target = value;
  let samplesToRetarget = Math.floor(sampleRate / (minHz + maxHz) * 0.5);
  const mid = (minHz + maxHz) * 0.5;
  const span = Math.max(1e-6, maxHz - minHz);

  return {
    next() {
      if (--samplesToRetarget <= 0) {
        target = minVal + rng.nextFloat() * (maxVal - minVal);
        const rate = minHz + rng.nextFloat() * span;
        const period = 1 / Math.max(rate, mid * 0.25);
        samplesToRetarget = Math.max(
          1,
          Math.floor(period * sampleRate * (0.55 + rng.nextFloat() * 0.9))
        );
      }
      value = smoothness * value + (1 - smoothness) * target;
      return value;
    },
    peek() {
      return value;
    },
  };
}

/** Bounded random walk with soft restoring force. */
export function createRandomWalk(rng, {
  sampleRate,
  step = 0.0008,
  restore = 0.00015,
  minVal = -1,
  maxVal = 1,
} = {}) {
  let value = 0;
  const invSr = 1 / sampleRate;
  return {
    next() {
      value += (rng.nextFloat() * 2 - 1) * step;
      value -= value * restore;
      value = clamp(value, minVal, maxVal);
      // tiny sr-normalization so feel is similar across rates
      void invSr;
      return value;
    },
    peek() {
      return value;
    },
  };
}

/**
 * Poisson-like event stream: returns true when an event fires this sample.
 * Rate in events/sec; rate may be changed externally via setRate.
 */
export function createPoissonEventStream(rng, sampleRate, ratePerSec = 10) {
  let rate = Math.max(0, ratePerSec);
  const invSr = 1 / sampleRate;
  return {
    setRate(r) {
      rate = Math.max(0, r);
    },
    next() {
      if (rate <= 0) return false;
      // P(event) ≈ rate / sr for small rates
      return rng.nextFloat() < rate * invSr;
    },
  };
}

/** Bounded approx-Gaussian via sum of uniforms (no heavy Box-Muller for intervals). */
export function gaussianLike(rng, mean, std) {
  // Irwin–Hall n=6 → roughly normal
  let s = 0;
  for (let i = 0; i < 6; i++) s += rng.nextFloat();
  const z = (s - 3) / Math.SQRT2; // ~N(0,1)-ish
  return mean + z * std;
}

/** Band-pass via cascade HP then LP (low Q — no resonant howl). */
export function createBandPass(sampleRate, lowHz, highHz) {
  const hpX = onePoleHpCoef(sampleRate, lowHz);
  const lpX = onePoleLpCoef(sampleRate, highHz);
  let hpPrevIn = 0;
  let hpPrevOut = 0;
  let lpY = 0;
  return {
    process(x) {
      let h = hpX * (hpPrevOut + x - hpPrevIn);
      hpPrevIn = x;
      hpPrevOut = h;
      lpY = (1 - lpX) * h + lpX * lpY;
      return lpY;
    },
  };
}

/** Simple one-pole low-pass state. */
export function createLowPass(sampleRate, cutoffHz) {
  let coef = onePoleLpCoef(sampleRate, cutoffHz);
  let y = 0;
  return {
    setCutoff(hz) {
      coef = onePoleLpCoef(sampleRate, hz);
    },
    process(x) {
      y = (1 - coef) * x + coef * y;
      return y;
    },
  };
}

/** Simple one-pole high-pass state. */
export function createHighPass(sampleRate, cutoffHz) {
  const coef = onePoleHpCoef(sampleRate, cutoffHz);
  let prevIn = 0;
  let prevOut = 0;
  return {
    process(x) {
      const y = coef * (prevOut + x - prevIn);
      prevIn = x;
      prevOut = y;
      return y;
    },
  };
}

/**
 * Asymmetric wave envelope: slow rise → rounded crest → longer release.
 * Returns 0..1. Not a sine.
 */
export function shapedWaveEnvelope(t, rise, crest, release) {
  if (t < 0) return 0;
  if (t < rise) {
    const x = t / Math.max(1e-6, rise);
    // smoothstep-ish with slight exponential lean
    const s = smoothstep(0, 1, x);
    return s * s;
  }
  if (t < rise + crest) {
    const x = (t - rise) / Math.max(1e-6, crest);
    // soft rounded crest near 1
    return 1 - 0.08 * Math.sin(Math.PI * x);
  }
  if (t < rise + crest + release) {
    const x = (t - rise - crest) / Math.max(1e-6, release);
    // longer exponential-like decay into a soft tail
    const e = Math.exp(-2.4 * x);
    const soft = (1 - x) * (1 - x);
    return Math.max(0, e * 0.85 + soft * 0.15);
  }
  return 0;
}

/** Tiny algorithmic space (2–4 short delays). Extremely subtle; no IR assets. */
export function createTinyAmbience(sampleRate, { wet = 0.08 } = {}) {
  const lens = [
    Math.floor(0.018 * sampleRate),
    Math.floor(0.027 * sampleRate),
    Math.floor(0.039 * sampleRate),
  ];
  const bufs = lens.map((n) => new Float32Array(Math.max(8, n)));
  const idx = [0, 0, 0];
  const fb = 0.18;
  const lp = [0, 0, 0];
  const lpCoef = 0.35;
  return {
    process(x) {
      let sum = 0;
      for (let i = 0; i < bufs.length; i++) {
        const b = bufs[i];
        const r = b[idx[i]];
        lp[i] = (1 - lpCoef) * r + lpCoef * lp[i];
        sum += lp[i];
        b[idx[i]] = x + lp[i] * fb;
        idx[i]++;
        if (idx[i] >= b.length) idx[i] = 0;
      }
      return x * (1 - wet) + (sum / bufs.length) * wet;
    },
  };
}
