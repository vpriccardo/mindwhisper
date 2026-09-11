/**
 * Soft DSSS demodulator for AENV1 symbols.
 */

import {
  DATA_START,
  NUM_SYMBOLS,
  PREAMBLE_START,
  SYMBOL_SAMPLES,
} from "../../shared/audioSeal/constants";
import { getSymbolBases } from "../../shared/audioSeal/symbolBasis";

export type DemodResult = {
  soft: Float64Array;
  snrEstimate: number;
};

function correlateScaled(
  signal: Float32Array,
  basis: Float32Array,
  start: number,
  scale: number,
  lag: number,
): number {
  let dot = 0;
  let ns = 0;
  let nb = 0;
  const n = basis.length;
  for (let i = 0; i < n; i++) {
    const src = start + lag + i * scale;
    const i0 = Math.floor(src);
    if (i0 < 0 || i0 + 1 >= signal.length) return 0;
    const frac = src - i0;
    const s = signal[i0]! * (1 - frac) + signal[i0 + 1]! * frac;
    const b = basis[i]!;
    dot += s * b;
    ns += s * s;
    nb += b * b;
  }
  const denom = Math.sqrt(ns * nb);
  if (!(denom > 1e-12)) return 0;
  const c = dot / denom;
  return Number.isFinite(c) ? c : 0;
}

/**
 * @param samples Full or packet-aligned buffer.
 * @param preambleOffset Absolute offset of preamble start in `samples`.
 */
export function softDemodulate(input: {
  samples: Float32Array;
  preambleOffset: number;
  timeScale?: number;
}): DemodResult {
  const scale = input.timeScale ?? 1;
  const bases = getSymbolBases();
  const soft = new Float64Array(NUM_SYMBOLS);
  const dataRel = DATA_START - PREAMBLE_START;
  let energy = 0;
  let noise = 0;

  for (let sym = 0; sym < NUM_SYMBOLS; sym++) {
    const expected =
      input.preambleOffset + (dataRel + sym * SYMBOL_SAMPLES) * scale;
    // Prefer lag 0; search a wider window for acoustic path / clock skew.
    let best = correlateScaled(input.samples, bases[sym]!, expected, scale, 0);
    let bestLag = 0;
    let bestAbs = Math.abs(best);
    for (let lag = -12; lag <= 12; lag++) {
      if (lag === 0) continue;
      const c = correlateScaled(
        input.samples,
        bases[sym]!,
        expected,
        scale,
        lag,
      );
      const a = Math.abs(c);
      if (a > bestAbs) {
        best = c;
        bestAbs = a;
        bestLag = lag;
      }
    }
    soft[sym] = best;
    energy += best * best;
    const n1 = correlateScaled(
      input.samples,
      bases[sym]!,
      expected,
      scale,
      bestLag + 16,
    );
    noise += n1 * n1;
  }

  const snrEstimate =
    noise > 1e-12 ? 10 * Math.log10(energy / Math.max(noise, 1e-12)) : 99;
  return { soft, snrEstimate };
}
