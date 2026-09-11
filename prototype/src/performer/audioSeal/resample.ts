/**
 * Deterministic windowed-sinc resampler to canonical 48 kHz.
 */

import { SAMPLE_RATE } from "../../shared/audioSeal/constants";

const SINC_HALF_WIDTH = 16;

function hannWindow(n: number, N: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-8) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * Resample mono Float32Array from `fromRate` to SAMPLE_RATE (48 kHz).
 */
export function resampleToCanonical(
  input: Float32Array,
  fromRate: number,
): Float32Array {
  if (Math.abs(fromRate - SAMPLE_RATE) < 0.5) {
    return Float32Array.from(input);
  }
  const ratio = fromRate / SAMPLE_RATE;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  const half = SINC_HALF_WIDTH;
  const winN = half * 2 + 1;

  for (let i = 0; i < outLen; i++) {
    const srcCenter = i * ratio;
    const iCenter = Math.floor(srcCenter);
    let sum = 0;
    let wsum = 0;
    for (let tap = -half; tap <= half; tap++) {
      const idx = iCenter + tap;
      if (idx < 0 || idx >= input.length) continue;
      const x = srcCenter - idx;
      const w = sinc(x) * hannWindow(tap + half, winN);
      sum += input[idx]! * w;
      wsum += w;
    }
    out[i] = wsum !== 0 ? sum / wsum : 0;
  }
  return out;
}

/** Fast linear path used only for non-critical UI meters. */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (Math.abs(fromRate - toRate) < 0.5) return Float32Array.from(input);
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}
