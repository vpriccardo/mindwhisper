/**
 * Deterministic windowed-sinc resampler to canonical 48 kHz.
 *
 * Live capture must use StreamingResampler: iPhone Safari AudioContext is
 * often 44.1 kHz, and resampling each 20 ms chunk in isolation destroys
 * preamble correlation (discontinuities at every chunk edge).
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

function interpolateAt(
  input: Float32Array,
  srcCenter: number,
  half: number,
  winN: number,
): number {
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
  return wsum !== 0 ? sum / wsum : 0;
}

/**
 * Resample a complete mono buffer from `fromRate` to SAMPLE_RATE (48 kHz).
 * Use this for WAV / offline. Do not call this on isolated live chunks.
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
    out[i] = interpolateAt(input, i * ratio, half, winN);
  }
  return out;
}

/**
 * Continuous 44.1 kHz (etc.) → 48 kHz conversion for the microphone worker.
 * Keeps a short input tail so successive 128/960-sample worklet chunks
 * form one phase-continuous stream.
 */
export class StreamingResampler {
  private fromRate: number;
  private hold = new Float32Array(0);
  /** Position of the next output sample, in hold-sample units. */
  private pos = 0;

  constructor(fromRate: number) {
    this.fromRate = fromRate;
  }

  get rate(): number {
    return this.fromRate;
  }

  reset(fromRate: number): void {
    this.fromRate = fromRate;
    this.hold = new Float32Array(0);
    this.pos = 0;
  }

  push(chunk: Float32Array): Float32Array {
    if (chunk.length === 0) return new Float32Array(0);
    if (Math.abs(this.fromRate - SAMPLE_RATE) < 0.5) {
      return chunk;
    }

    const combined = new Float32Array(this.hold.length + chunk.length);
    combined.set(this.hold);
    combined.set(chunk, this.hold.length);

    const ratio = this.fromRate / SAMPLE_RATE;
    const half = SINC_HALF_WIDTH;
    const winN = half * 2 + 1;

    // Group delay of `half` input samples. Advance so the loop can start;
    // otherwise pos stays 0 forever and nothing is emitted.
    if (this.pos < half) this.pos = half;
    let pos = this.pos;

    const out: number[] = [];
    while (pos + half + 1 < combined.length) {
      out.push(interpolateAt(combined, pos, half, winN));
      pos += ratio;
    }

    const keepFrom = Math.max(0, Math.floor(pos) - half);
    this.hold = combined.slice(keepFrom);
    this.pos = pos - keepFrom;
    return Float32Array.from(out);
  }
}

/** Fast linear path used only for non-critical UI meters / tests. */
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
