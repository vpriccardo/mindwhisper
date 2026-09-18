/**
 * Multi-frame soft combining for call-v1 (1 → 2 → 3 frames).
 */

import { combineCallSoftFrames, TOTAL_BITS } from '../protocol.js';
import { CALL_FRAME_SYMBOLS, FEATURES_PER_SYMBOL } from './call-constants.js';

export const CALL_FRAME_FEATURES = CALL_FRAME_SYMBOLS * FEATURES_PER_SYMBOL;

/**
 * Pending soft-frame store with spacing-aware combine attempts.
 */
export class CallSoftCombiner {
  constructor(opts = {}) {
    this.maxFrames = opts.maxFrames ?? 8;
    this.spacingTol = opts.spacingTol ?? 12; // feature indices
    this.pending = [];
  }

  clear() {
    this.pending = [];
  }

  add(entry) {
    // entry: { soft: Float32Array(272+), weight, start, score, t }
    const near = this.pending.findIndex(
      (p) => Math.abs(p.start - entry.start) <= 4
    );
    if (near >= 0) {
      if (entry.score > this.pending[near].score) this.pending[near] = entry;
    } else {
      this.pending.push(entry);
    }
    const cutoff = (entry.t || 0) - 70000;
    this.pending = this.pending.filter((p) => (p.t || 0) >= cutoff);
    if (this.pending.length > this.maxFrames) {
      this.pending.sort((a, b) => b.score - a.score);
      this.pending = this.pending.slice(0, this.maxFrames);
    }
  }

  /**
   * Try single-frame decode first (caller), then 2-frame, then 3-frame chains.
   */
  tryCombine() {
    if (this.pending.length < 2) return null;
    const sorted = [...this.pending].sort((a, b) => a.start - b.start);
    let best = null;
    let bestW = 0;

    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i < sorted.length; i++) {
        const chain = [sorted[i]];
        for (let j = i + 1; j < sorted.length && chain.length < n; j++) {
          const prev = chain[chain.length - 1];
          const gap = sorted[j].start - prev.start;
          if (Math.abs(gap - CALL_FRAME_FEATURES) <= this.spacingTol) {
            chain.push(sorted[j]);
          }
        }
        if (chain.length === n) {
          const wSum = chain.reduce((a, p) => a + p.weight, 0);
          if (wSum > bestW) {
            bestW = wSum;
            best = chain;
          }
        }
      }
      if (best && best.length === n) {
        const decoded = combineCallSoftFrames(
          best.map((p) => p.soft),
          best.map((p) => p.weight)
        );
        if (decoded.ok) {
          return {
            ...decoded,
            combinedRepetitions: n,
            chainStarts: best.map((p) => p.start),
          };
        }
      }
    }
    return null;
  }
}

/**
 * Weighted merge of base soft bits and enhancement soft bits.
 * enhancementWeight=0 must work (base-only).
 */
export function mergeBaseEnhancementSoft(baseSoft, enhSoft, enhancementWeight) {
  const out = new Float32Array(TOTAL_BITS);
  const w = Math.max(0, enhancementWeight);
  const wb = 1;
  const we = w;
  const den = wb + we;
  for (let i = 0; i < TOTAL_BITS; i++) {
    const b = baseSoft[i] || 0;
    const e = enhSoft ? enhSoft[i] || 0 : 0;
    out[i] = den > 0 ? (wb * b + we * e) / den : b;
  }
  return out;
}
