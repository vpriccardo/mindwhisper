/** Continuous optical acquisition state machine (no DOM). */

import { validatePayloadText } from "./payloadValidate";

export type AcquisitionState =
  | "IDLE"
  | "REQUESTING_CAMERA"
  | "SCANNING"
  | "PAYLOAD_LOCKED"
  | "RECOVERING"
  | "RECOVERED"
  | "RECOVERY_ERROR"
  | "CAMERA_ERROR";

export type OpticalFormat =
  | "QR_CODE"
  | "AZTEC"
  | "HIDDEN_ENVELOPE_V1"
  | "AUDIO_SEAL_V1"
  | "PARAMETRIC_SEAL_V1"
  | "UNKNOWN";

export type AcquisitionSnapshot = {
  state: AcquisitionState;
  lockedPayload: string | null;
  opticalFormat: OpticalFormat | null;
  acquiredAt: number | null;
  lastSeenAt: number | null;
  generation: number;
  recoverCalls: number;
  cameraError: string | null;
  recoveryError: string | null;
  debug: {
    attempts: number;
    invalidRecognized: number;
    validDetections: number;
    decodeMsTotal: number;
    avgDecodeMs: number;
  };
  /** After clear, ignore this payload until absent for clearCooldownMs */
  suppressPayload: string | null;
  suppressUntilAbsentMs: number;
  /** Timestamp when suppressed payload was last seen missing; null if still in view or N/A */
  suppressAbsentSince: number | null;
};

export type RecognizedSymbol = {
  text: string;
  format: OpticalFormat;
  nowMs: number;
  decodeMs?: number;
};

export type AcquisitionConfig = {
  /** Require two equal detections within this window; 0 = lock on first valid. */
  doubleDetectWindowMs: number;
  clearCooldownMs: number;
};

export const DEFAULT_ACQUISITION_CONFIG: AcquisitionConfig = {
  doubleDetectWindowMs: 0,
  clearCooldownMs: 500,
};

type PendingDetect = { payload: string; at: number } | null;

export class AcquisitionController {
  private snap: AcquisitionSnapshot;
  private config: AcquisitionConfig;
  private pending: PendingDetect = null;
  private recoverHandler: ((payload: string, generation: number) => void) | null =
    null;

  constructor(config: Partial<AcquisitionConfig> = {}) {
    this.config = { ...DEFAULT_ACQUISITION_CONFIG, ...config };
    this.snap = this.initial();
  }

  private initial(): AcquisitionSnapshot {
    return {
      state: "IDLE",
      lockedPayload: null,
      opticalFormat: null,
      acquiredAt: null,
      lastSeenAt: null,
      generation: 0,
      recoverCalls: 0,
      cameraError: null,
      recoveryError: null,
      debug: {
        attempts: 0,
        invalidRecognized: 0,
        validDetections: 0,
        decodeMsTotal: 0,
        avgDecodeMs: 0,
      },
      suppressPayload: null,
      suppressUntilAbsentMs: this.config.clearCooldownMs,
      suppressAbsentSince: null,
    };
  }

  get snapshot(): AcquisitionSnapshot {
    return structuredClone(this.snap);
  }

  onRecover(handler: (payload: string, generation: number) => void): void {
    this.recoverHandler = handler;
  }

  beginRequestCamera(): void {
    this.snap.state = "REQUESTING_CAMERA";
    this.snap.cameraError = null;
  }

  beginScanning(): void {
    this.snap.state = "SCANNING";
    this.snap.cameraError = null;
  }

  setCameraError(message: string): void {
    this.snap.state = "CAMERA_ERROR";
    this.snap.cameraError = message;
  }

  stopToIdle(): void {
    // Keep locked result visible; only camera stops
    if (
      this.snap.state === "PAYLOAD_LOCKED" ||
      this.snap.state === "RECOVERING" ||
      this.snap.state === "RECOVERED" ||
      this.snap.state === "RECOVERY_ERROR"
    ) {
      // stay in result state without camera
      return;
    }
    this.snap.state = "IDLE";
  }

  forceIdle(): void {
    this.snap.state = "IDLE";
  }

  noteDecodeAttempt(decodeMs: number): void {
    this.snap.debug.attempts += 1;
    this.snap.debug.decodeMsTotal += decodeMs;
    this.snap.debug.avgDecodeMs =
      this.snap.debug.decodeMsTotal / this.snap.debug.attempts;
  }

  /** Frame with no recognized valid code. */
  noteAbsence(nowMs: number): void {
    if (this.snap.suppressPayload) {
      if (this.snap.suppressAbsentSince == null) {
        this.snap.suppressAbsentSince = nowMs;
      } else if (
        nowMs - this.snap.suppressAbsentSince >=
        this.snap.suppressUntilAbsentMs
      ) {
        this.snap.suppressPayload = null;
        this.snap.suppressAbsentSince = null;
      }
    }
  }

  onRecognized(symbol: RecognizedSymbol): "ignored" | "repeat" | "locked" {
    const validation = validatePayloadText(symbol.text);
    if (!validation.ok) {
      this.snap.debug.invalidRecognized += 1;
      this.noteAbsence(symbol.nowMs);
      return "ignored";
    }

    const payload = validation.payload;
    this.snap.debug.validDetections += 1;

    // After clear: ignore previous payload until it has been absent ≥ cooldown
    if (this.snap.suppressPayload === payload) {
      this.snap.suppressAbsentSince = null; // still in view
      this.snap.lastSeenAt = symbol.nowMs;
      return "ignored";
    }
    // Different payload clears suppression immediately
    if (this.snap.suppressPayload && this.snap.suppressPayload !== payload) {
      this.snap.suppressPayload = null;
      this.snap.suppressAbsentSince = null;
    }

    if (this.snap.lockedPayload === payload) {
      this.snap.lastSeenAt = symbol.nowMs;
      return "repeat";
    }

    if (this.config.doubleDetectWindowMs > 0) {
      if (
        this.pending &&
        this.pending.payload === payload &&
        symbol.nowMs - this.pending.at <= this.config.doubleDetectWindowMs
      ) {
        this.pending = null;
        this.lockPayload(payload, symbol.format, symbol.nowMs);
        return "locked";
      }
      this.pending = { payload, at: symbol.nowMs };
      return "ignored";
    }

    this.lockPayload(payload, symbol.format, symbol.nowMs);
    return "locked";
  }

  private lockPayload(payload: string, format: OpticalFormat, nowMs: number): void {
    this.snap.lockedPayload = payload;
    this.snap.opticalFormat = format;
    this.snap.acquiredAt = nowMs;
    this.snap.lastSeenAt = nowMs;
    this.snap.generation += 1;
    this.snap.recoverCalls += 1;
    this.snap.recoveryError = null;
    this.snap.state = "RECOVERING";
    const gen = this.snap.generation;
    this.recoverHandler?.(payload, gen);
  }

  /** Manual paste path also uses generation locking. */
  lockFromPaste(payload: string, nowMs: number): number {
    const validation = validatePayloadText(payload);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    this.snap.lockedPayload = validation.payload;
    this.snap.opticalFormat = null;
    this.snap.acquiredAt = nowMs;
    this.snap.lastSeenAt = nowMs;
    this.snap.generation += 1;
    this.snap.recoverCalls += 1;
    this.snap.recoveryError = null;
    this.snap.state = "RECOVERING";
    return this.snap.generation;
  }

  /**
   * Hidden-envelope / audio-seal path: word already recovered locally.
   * Skips Protocol v1 validation and HTTP recover.
   */
  lockFromHiddenEnvelope(input: {
    canonicalWord: string;
    tokenHex: string;
    nowMs: number;
    format?: "HIDDEN_ENVELOPE_V1" | "AUDIO_SEAL_V1" | "PARAMETRIC_SEAL_V1";
  }): number {
    const format = input.format ?? "HIDDEN_ENVELOPE_V1";
    const key = `HENV1:${input.tokenHex}`;
    if (this.snap.suppressPayload === key) {
      this.snap.suppressAbsentSince = null;
      this.snap.lastSeenAt = input.nowMs;
      return this.snap.generation;
    }
    if (this.snap.suppressPayload && this.snap.suppressPayload !== key) {
      this.snap.suppressPayload = null;
      this.snap.suppressAbsentSince = null;
    }
    if (this.snap.lockedPayload === key) {
      this.snap.lastSeenAt = input.nowMs;
      return this.snap.generation;
    }

    this.snap.lockedPayload = key;
    this.snap.opticalFormat = format;
    this.snap.acquiredAt = input.nowMs;
    this.snap.lastSeenAt = input.nowMs;
    this.snap.generation += 1;
    this.snap.recoverCalls += 1;
    this.snap.recoveryError = null;
    this.snap.state = "RECOVERED";
    void input.canonicalWord;
    return this.snap.generation;
  }

  lockFromParametricSeal(input: {
    canonicalWord: string;
    index: number;
    nowMs: number;
  }): number {
    return this.lockFromHiddenEnvelope({
      canonicalWord: input.canonicalWord,
      tokenHex: `PENV1:${input.index}`,
      nowMs: input.nowMs,
      format: "PARAMETRIC_SEAL_V1",
    });
  }
  lockFromAudioSeal(input: {
    canonicalWord: string;
    tokenHex: string;
    nowMs: number;
  }): number {
    return this.lockFromHiddenEnvelope({ ...input, format: "AUDIO_SEAL_V1" });
  }

  markRecovered(generation: number): boolean {
    if (generation !== this.snap.generation) return false;
    this.snap.state = "RECOVERED";
    this.snap.recoveryError = null;
    return true;
  }

  markRecoveryError(generation: number, message: string): boolean {
    if (generation !== this.snap.generation) return false;
    this.snap.state = "RECOVERY_ERROR";
    this.snap.recoveryError = message;
    return true;
  }

  markNoMatch(generation: number, message: string): boolean {
    if (generation !== this.snap.generation) return false;
    // Keep payload locked; show as recovered-with-error style
    this.snap.state = "RECOVERY_ERROR";
    this.snap.recoveryError = message;
    return true;
  }

  clearLockedResult(nowMs: number): void {
    const previous = this.snap.lockedPayload;
    this.snap.lockedPayload = null;
    this.snap.opticalFormat = null;
    this.snap.acquiredAt = null;
    this.snap.lastSeenAt = null;
    this.snap.recoveryError = null;
    this.snap.suppressPayload = previous;
    this.snap.suppressAbsentSince = null;
    this.pending = null;
    void nowMs;
    if (
      this.snap.state !== "IDLE" &&
      this.snap.state !== "REQUESTING_CAMERA" &&
      this.snap.state !== "CAMERA_ERROR"
    ) {
      this.snap.state = "SCANNING";
    }
  }

  isCurrentGeneration(generation: number): boolean {
    return generation === this.snap.generation;
  }
}
