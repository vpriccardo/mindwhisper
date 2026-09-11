/** Shared types for Hidden-envelope worker messages. */

export type WorkerInitMessage = {
  type: "init";
  baseUrl: string;
  debug: boolean;
};

export type WorkerFrameMessage = {
  type: "frame";
  generation: number;
  timestampMs: number;
  bitmap: ImageBitmap;
};

export type WorkerResetMessage = { type: "reset" };

export type WorkerInMessage =
  | WorkerInitMessage
  | WorkerFrameMessage
  | WorkerResetMessage;

export type PipelineStatus =
  | "idle"
  | "searching"
  | "envelope_found"
  | "reading"
  | "signal_weak"
  | "locked";

export type AlignPath = "orb_search" | "ecc_track" | "none";

export type MatchFailReason =
  | "no_dictionary_candidate"
  | "ambiguous_candidate"
  | null;

export type WorkerDiagnostics = {
  inliers: number;
  inlierRatio: number;
  reprojError: number;
  validCarrierPct: number;
  sharpness: number;
  glare: number;
  quality: number;
  rejectReason: string | null;
  stageMs: Record<string, number>;
  totalMs: number;
  bufferLen: number;
  independentFrames: number;
  totalWeight: number;
  /** Uncalibrated soft dictionary score — not a calibrated confidence. */
  softScore: number;
  softScoreMargin: number;
  secondSoftScore: number;
  avgAbsSoft: number;
  softValues: number[] | null;
  residualChromaRms: number;
  affineCbScale: number;
  affineCbBias: number;
  affineCrScale: number;
  affineCrBias: number;
  saltHypothesis: number | null;
  saltMargin: number;
  estimatedBitErrors: number | null;
  matchFailReason: MatchFailReason;
  topCandidates: {
    word: string;
    score: number;
    margin?: number;
  }[];
  droppedFrames: number;
  skippedFrames: number;
  resourcesHeld: number;
  alignPath: AlignPath;
  alignMode: "searching" | "tracking";
  searchFrameCount: number;
  trackFrameCount: number;
  projectedHeightPx: number;
  opencvReady: boolean;
  captureDebug?: {
    sourceVideoWidth: number;
    sourceVideoHeight: number;
    workerBitmapWidth: number;
    workerBitmapHeight: number;
    captureMs: number;
    framesSubmitted: number;
    framesSkipped: number;
    framesDropped: number;
    inFlight: number;
  };
  quad?: { x: number; y: number }[] | null;
};

export type WorkerResultMessage = {
  type: "result";
  generation: number;
  status: PipelineStatus;
  lockedWord: string | null;
  tokenHex: string | null;
  salt8: number | null;
  timeToLockMs: number | null;
  diagnostics: WorkerDiagnostics | null;
  statusLabel?: string;
};

export type WorkerReadyMessage = {
  type: "ready";
  ok: boolean;
  error?: string;
};

export type WorkerFrameAckMessage = {
  type: "frame_ack";
  generation: number;
};

export type WorkerOutMessage =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerFrameAckMessage;
