/**
 * Two-stage preamble detector: coarse 12 kHz + fine 48 kHz.
 * For looping TX, prefer the latest viable peak that leaves room for a full packet.
 */

import {
  AUDIO_MANIFEST,
  PACKET_FROM_PREAMBLE,
  PREAMBLE_SAMPLES,
  SAMPLE_RATE,
  TIMING_SCALES,
} from "../../shared/audioSeal/constants";
import {
  getPreambleDecimated12k,
  getPreambleWaveform,
} from "../../shared/audioSeal/preamble";

export type PreambleHit = {
  offset: number;
  score: number;
  sidelobeRatio: number;
  timeScale: number;
};

export type PreambleScan = {
  hit: PreambleHit | null;
  /** Best fine (or coarse×approx) score seen in this scan. */
  bestScore: number;
  bestCoarseScore: number;
};

/** Re-export for callers that import PACKET_FROM_PREAMBLE via decode module. */
export { PACKET_FROM_PREAMBLE };

function nccAt(
  signal: Float32Array,
  template: Float32Array,
  offset: number,
  scale: number,
): number {
  const n = template.length;
  let dot = 0;
  let ns = 0;
  let nt = 0;
  for (let i = 0; i < n; i++) {
    const src = offset + i * scale;
    const i0 = Math.floor(src);
    if (i0 < 0 || i0 + 1 >= signal.length) return -1;
    const frac = src - i0;
    const s = signal[i0]! * (1 - frac) + signal[i0 + 1]! * frac;
    const t = template[i]!;
    dot += s * t;
    ns += s * s;
    nt += t * t;
  }
  return dot / (Math.sqrt(ns * nt) || 1);
}

function highpassInPlace(buf: Float32Array, alpha = 0.995): void {
  let xPrev = 0;
  let yPrev = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    const y = alpha * (yPrev + x - xPrev);
    buf[i] = y;
    xPrev = x;
    yPrev = y;
  }
}

function bandLimitSimple(buf: Float32Array): Float32Array {
  const out = Float32Array.from(buf);
  highpassInPlace(out, 0.995);
  // Mild LP (~10 kHz) — keep chirp band (2.6–7.4 kHz) intact.
  let y = 0;
  const alpha = 0.55;
  for (let i = 0; i < out.length; i++) {
    y += alpha * (out[i]! - y);
    out[i] = y;
  }
  return out;
}

function decimate4(buf: Float32Array): Float32Array {
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] =
      (buf[i * 4]! + buf[i * 4 + 1]! + buf[i * 4 + 2]! + buf[i * 4 + 3]!) / 4;
  }
  return out;
}

function refineAt(
  banded: Float32Array,
  center: number,
  thr: number,
  sideThr: number,
): PreambleHit | null {
  const fineTpl = getPreambleWaveform();
  const fineRadius = 160;
  let bestOff = center;
  let bestFine = -1;
  let bestScale = 1;
  for (const scale of TIMING_SCALES) {
    const span = Math.ceil(fineTpl.length * scale);
    for (let d = -fineRadius; d <= fineRadius; d++) {
      const off = center + d;
      if (off < 0 || off + span >= banded.length) continue;
      const score = nccAt(banded, fineTpl, off, scale);
      if (score > bestFine) {
        bestFine = score;
        bestOff = off;
        bestScale = scale;
      }
    }
  }
  if (bestFine < thr) return null;

  let side = 0;
  const excl = Math.round(0.002 * SAMPLE_RATE);
  for (
    let d = -Math.round(0.08 * SAMPLE_RATE);
    d <= Math.round(0.08 * SAMPLE_RATE);
    d += 12
  ) {
    if (Math.abs(d) < excl) continue;
    const off = bestOff + d;
    if (off < 0 || off + fineTpl.length >= banded.length) continue;
    const s = Math.abs(nccAt(banded, fineTpl, off, bestScale));
    if (s > side) side = s;
  }
  const sidelobeRatio = side > 1e-6 ? bestFine / side : 99;
  if (sidelobeRatio < sideThr) return null;

  return {
    offset: bestOff,
    score: bestFine,
    sidelobeRatio,
    timeScale: bestScale,
  };
}

export function detectPreambleDetailed(
  samples48k: Float32Array,
  options?: {
    corrThreshold?: number;
    sidelobeRatio?: number;
    minOffset?: number;
    maxOffset?: number;
    /** Prefer the latest peak that leaves room for a full packet (looping TX). */
    preferLatest?: boolean;
  },
): PreambleScan {
  const thr = options?.corrThreshold ?? AUDIO_MANIFEST.preambleCorrThreshold;
  const sideThr =
    options?.sidelobeRatio ?? AUDIO_MANIFEST.preambleSidelobeRatio;
  const preferLatest = options?.preferLatest !== false;
  const banded = bandLimitSimple(samples48k);
  const coarseSig = decimate4(banded);
  const coarseTpl = getPreambleDecimated12k();
  const step = Math.max(1, Math.round(0.002 * (SAMPLE_RATE / 4)));

  const minC = Math.max(0, Math.floor((options?.minOffset ?? 0) / 4));
  const maxC = Math.min(
    coarseSig.length - coarseTpl.length,
    Math.floor(
      (options?.maxOffset ?? samples48k.length - PREAMBLE_SAMPLES) / 4,
    ),
  );
  if (maxC <= minC) {
    return { hit: null, bestScore: -1, bestCoarseScore: -1 };
  }

  // Collect coarse candidates; cap how many we refine (fine NCC is expensive).
  const candidates: { o: number; score: number }[] = [];
  let bestC = -1;
  let bestScore = -1;
  for (let o = minC; o <= maxC; o += step) {
    const score = nccAt(coarseSig, coarseTpl, o, 1);
    if (score > bestScore) {
      bestScore = score;
      bestC = o;
    }
    if (score >= thr * 0.75) candidates.push({ o, score });
  }
  if (bestC < 0 || bestScore < thr * 0.55) {
    return { hit: null, bestScore, bestCoarseScore: bestScore };
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 6);
  if (preferLatest) {
    top.sort((a, b) => b.o - a.o);
  }

  let hit: PreambleHit | null = null;
  const needAfter = Math.ceil(PACKET_FROM_PREAMBLE * 1.01);
  for (const c of top) {
    const approx = c.o * 4;
    if (preferLatest && approx + needAfter > samples48k.length) continue;
    hit = refineAt(banded, approx, thr, sideThr);
    if (hit) break;
  }
  if (!hit) {
    hit = refineAt(banded, bestC * 4, thr, sideThr);
  }

  return {
    hit,
    bestScore: hit?.score ?? bestScore,
    bestCoarseScore: bestScore,
  };
}

export function detectPreamble(
  samples48k: Float32Array,
  options?: {
    corrThreshold?: number;
    sidelobeRatio?: number;
    minOffset?: number;
    maxOffset?: number;
    preferLatest?: boolean;
  },
): PreambleHit | null {
  return detectPreambleDetailed(samples48k, options).hit;
}
