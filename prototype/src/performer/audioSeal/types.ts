/** Shared audio-seal performer types. */

export type AudioScanState =
  | "IDLE"
  | "LISTENING"
  | "PREAMBLE"
  | "DECODING"
  | "LOCKED";

export type AudioLockInfo = {
  word: string;
  surface: string;
  conceptId: string;
  matchType: string;
  tokenHex: string;
  timeToLockMs?: number;
  preambleScore?: number;
  viterbiMargin?: number;
  snrEstimate?: number;
};

/** CRC-valid (or best-effort) token latched for manual copy / lookup. */
export type AudioPayloadInfo = {
  tokenHex: string;
  crcOk: boolean;
  word: string | null;
  surface: string | null;
  preambleScore?: number;
  viterbiMargin?: number;
  snrEstimate?: number;
  timeToLockMs?: number;
  note: string;
};

export type AudioDiagnostics = {
  state: AudioScanState;
  inputDbfs: number;
  clippedPct: number;
  sampleRate: number;
  resampled: boolean;
  preambleScore: number | null;
  sidelobeRatio: number | null;
  timeScale: number | null;
  viterbiMetric: number | null;
  viterbiMargin: number | null;
  crcOk: boolean | null;
  snrEstimate: number | null;
  decodeMs: number | null;
  lastFailReason: string | null;
  /** Last recovered token hex (CRC ok or raw). */
  lastTokenHex?: string | null;
  candidates: number;
  crcFailures: number;
  noMatch: number;
  duplicates: number;
  locks: number;
  droppedChunks: number;
  /** @deprecated Misleading name kept for UI compat; now ring fill % (0–100). */
  bufferOverruns: number;
  /** Best preamble NCC seen recently (even when below lock threshold). */
  bestPreambleScore?: number | null;
  ringFillPct?: number;
  echoCancellation?: boolean | string;
  noiseSuppression?: boolean | string;
  autoGainControl?: boolean | string;
  trackSettings?: Record<string, unknown>;
};

export type AudioWorkerInMessage =
  | { type: "init"; digestTable: ArrayBuffer; surfacesJson: string }
  | { type: "pcm"; samples: Float32Array; sampleRate: number; tMs: number }
  | { type: "wav"; samples: Float32Array; sampleRate: number }
  | { type: "reset" }
  | { type: "stop" };

export type AudioWorkerOutMessage =
  | { type: "ready" }
  | { type: "status"; state: AudioScanState }
  | { type: "diag"; diag: AudioDiagnostics }
  | {
      type: "payload";
      info: AudioPayloadInfo;
      diag: AudioDiagnostics;
    }
  | {
      type: "lock";
      info: AudioLockInfo;
      diag: AudioDiagnostics;
    }
  | { type: "error"; message: string };
