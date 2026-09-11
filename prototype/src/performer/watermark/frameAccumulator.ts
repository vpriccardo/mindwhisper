/**
 * Circular evidence accumulator for Hidden-envelope soft bits.
 *
 * Soft values are accumulated as weighted sums and then normalized by
 * totalWeight so lock thresholds are calibrated in the per-frame soft domain.
 * Near-identical consecutive frames are de-weighted; independentCount reports
 * the effective independent-frame mass (not the raw observation count).
 */

import { HENV_BIT_COUNT } from "../../shared/hiddenEnvelopeProtocol";

export type SoftObservation = {
  soft: Float64Array;
  noise: Float64Array;
  quality: number;
  timestampMs: number;
  homographyFingerprint?: string;
  /** 1 for independent; <1 when de-weighted as near-duplicate */
  independence?: number;
};

export type AccumulatorConfig = {
  maxAgeMs: number;
  maxObservations: number;
  maxKeep: number;
  trackLossResetMs: number;
};

export const DEFAULT_ACCUMULATOR_CONFIG: AccumulatorConfig = {
  maxAgeMs: 1250,
  maxObservations: 18,
  maxKeep: 10,
  trackLossResetMs: 400,
};

export class FrameAccumulator {
  private buf: SoftObservation[] = [];
  private config: AccumulatorConfig;
  private lastAcceptedAt: number | null = null;
  private releasedCount = 0;

  constructor(config: Partial<AccumulatorConfig> = {}) {
    this.config = { ...DEFAULT_ACCUMULATOR_CONFIG, ...config };
  }

  get length(): number {
    return this.buf.length;
  }

  get released(): number {
    return this.releasedCount;
  }

  reset(): void {
    this.releasedCount += this.buf.length;
    this.buf = [];
    this.lastAcceptedAt = null;
  }

  noteTrackLoss(nowMs: number): void {
    if (
      this.lastAcceptedAt !== null &&
      nowMs - this.lastAcceptedAt > this.config.trackLossResetMs
    ) {
      this.reset();
    }
  }

  push(obs: SoftObservation): void {
    if (obs.soft.length !== HENV_BIT_COUNT) {
      throw new Error("soft length must be 56");
    }
    const prev = this.buf[this.buf.length - 1];
    let quality = obs.quality;
    let independence = 1;
    if (prev) {
      const sim = softSimilarity(prev.soft, obs.soft);
      if (sim > 0.995) {
        quality *= 0.25;
        independence = 0.25;
      } else if (sim > 0.98) {
        quality *= 0.6;
        independence = 0.6;
      }
    }
    this.buf.push({
      ...obs,
      soft: Float64Array.from(obs.soft),
      noise: Float64Array.from(obs.noise),
      quality,
      independence,
    });
    this.lastAcceptedAt = obs.timestampMs;
    this.evict(obs.timestampMs);
  }

  private evict(nowMs: number): void {
    const aged = this.buf.filter((o) => nowMs - o.timestampMs <= this.config.maxAgeMs);
    this.releasedCount += this.buf.length - aged.length;
    this.buf = aged;
    if (this.buf.length > this.config.maxObservations) {
      const drop = this.buf.length - this.config.maxObservations;
      this.buf.splice(0, drop);
      this.releasedCount += drop;
    }
  }

  /** Best observations by quality, capped. */
  bestObservations(): SoftObservation[] {
    return [...this.buf]
      .sort((a, b) => b.quality - a.quality)
      .slice(0, this.config.maxKeep);
  }

  /**
   * Weighted soft accumulation, normalized by totalWeight.
   * independentCount = sum of independence factors (effective independent frames).
   */
  accumulateSoft(): {
    soft: Float64Array;
    independentCount: number;
    spanMs: number;
    totalWeight: number;
  } {
    const best = this.bestObservations();
    const soft = new Float64Array(HENV_BIT_COUNT);
    let totalWeight = 0;
    let independentCount = 0;
    for (const obs of best) {
      independentCount += obs.independence ?? 1;
      for (let i = 0; i < HENV_BIT_COUNT; i++) {
        const n = Math.max(obs.noise[i] ?? 1, 1e-3);
        const w = obs.quality / n;
        soft[i]! += w * obs.soft[i]!;
        if (i === 0) totalWeight += w;
      }
    }
    if (totalWeight > 1e-12) {
      for (let i = 0; i < HENV_BIT_COUNT; i++) {
        soft[i]! /= totalWeight;
      }
    }
    const times = best.map((o) => o.timestampMs);
    const spanMs =
      times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0;
    return { soft, independentCount, spanMs, totalWeight };
  }
}

function softSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na * nb);
  return d < 1e-12 ? 0 : dot / d;
}
