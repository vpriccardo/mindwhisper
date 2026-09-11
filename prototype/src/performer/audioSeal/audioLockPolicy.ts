/**
 * Audio lock / duplicate-suppression policy.
 */

import { AUDIO_MANIFEST } from "../../shared/audioSeal/constants";

export type AudioLockCandidate = {
  tokenHex: string;
  canonicalWord: string;
  preambleScore: number;
  sidelobeRatio: number;
  viterbiMargin: number;
  clipped: boolean;
  nowMs: number;
};

export type AudioLockDecision =
  | { lock: true; reason: "ok" }
  | { lock: false; reason: string };

export class AudioLockPolicy {
  private lockedToken: string | null = null;
  private lastLockMs = 0;
  private suppressToken: string | null = null;

  reset(): void {
    this.lockedToken = null;
    this.lastLockMs = 0;
    this.suppressToken = null;
  }

  clear(previousTokenHex?: string): void {
    this.suppressToken = previousTokenHex ?? this.lockedToken;
    this.lockedToken = null;
  }

  get locked(): string | null {
    return this.lockedToken;
  }

  evaluate(c: AudioLockCandidate): AudioLockDecision {
    if (c.clipped) return { lock: false, reason: "clipped" };
    if (c.preambleScore < AUDIO_MANIFEST.preambleCorrThreshold) {
      return { lock: false, reason: "preamble_weak" };
    }
    if (c.sidelobeRatio < AUDIO_MANIFEST.preambleSidelobeRatio) {
      return { lock: false, reason: "sidelobe" };
    }
    if (this.suppressToken === c.tokenHex) {
      return { lock: false, reason: "suppressed" };
    }
    if (this.lockedToken === c.tokenHex) {
      return { lock: false, reason: "duplicate" };
    }
    if (
      this.lockedToken &&
      this.lockedToken !== c.tokenHex &&
      c.nowMs - this.lastLockMs < AUDIO_MANIFEST.duplicateSuppressMs
    ) {
      // Disagreeing token while locked: do not overwrite
      return { lock: false, reason: "disagree_while_locked" };
    }
    if (this.lockedToken && this.lockedToken !== c.tokenHex) {
      return { lock: false, reason: "disagree_while_locked" };
    }
    this.lockedToken = c.tokenHex;
    this.lastLockMs = c.nowMs;
    this.suppressToken = null;
    return { lock: true, reason: "ok" };
  }
}
