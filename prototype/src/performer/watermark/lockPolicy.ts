/**
 * Lock policy helpers for Hidden envelope multi-frame evidence.
 */

export type LockThresholds = {
  provisional: boolean;
  minAbsConfidence: number;
  minScoreMargin: number;
  minFrames: number;
  minSpanMs: number;
  trackLossResetMs: number;
};

export type DecisionUpdate = {
  canonicalWord: string;
  salt8: number;
  score: number;
  margin: number;
  unique: boolean;
  qualitySafety: boolean;
};

export type LockEval = {
  mayLock: boolean;
  reason: string;
};

export class LockPolicy {
  private recent: DecisionUpdate[] = [];
  private thresholds: LockThresholds;

  constructor(thresholds: LockThresholds) {
    this.thresholds = thresholds;
  }

  reset(): void {
    this.recent = [];
  }

  noteDecision(d: DecisionUpdate): LockEval {
    this.recent.push(d);
    if (this.recent.length > 8) this.recent.shift();
    return this.evaluate();
  }

  evaluate(independentFrames = 3, spanMs = 150): LockEval {
    const t = this.thresholds;
    const last3 = this.recent.slice(-3);
    if (last3.length < 3) {
      return { mayLock: false, reason: "need_three_decisions" };
    }
    if (independentFrames < t.minFrames) {
      return { mayLock: false, reason: "need_independent_frames" };
    }
    if (spanMs < t.minSpanMs) {
      return { mayLock: false, reason: "need_time_span" };
    }
    const winner = last3[0]!.canonicalWord;
    const salt = last3[0]!.salt8;
    if (!last3.every((d) => d.canonicalWord === winner && d.salt8 === salt)) {
      return { mayLock: false, reason: "unstable_winner" };
    }
    const latest = last3[last3.length - 1]!;
    if (!latest.unique) {
      return { mayLock: false, reason: "not_unique" };
    }
    if (latest.qualitySafety) {
      return { mayLock: false, reason: "quality_safety" };
    }
    if (Math.abs(latest.score) < t.minAbsConfidence) {
      return { mayLock: false, reason: "low_confidence" };
    }
    if (latest.margin < t.minScoreMargin) {
      return { mayLock: false, reason: "low_margin" };
    }
    return { mayLock: true, reason: "ok" };
  }
}
