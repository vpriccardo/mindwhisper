/**
 * Hidden-envelope decode worker. Loads assets once; processes one frame at a time.
 * Requires a verified OpenCV runtime — never falls back to JS NCC in live mode.
 */

import { ENVELOPE_MANIFEST } from "../../generated/envelopeManifest";
import { HIDDEN_DICTIONARY_META } from "../../generated/hiddenDictionaryMeta";
import {
  tokenToHex,
  bitsToToken,
  bitsFromHardDecisions,
} from "../../shared/hiddenEnvelopeProtocol";
import { GRID_H, GRID_W, type EligibilityMask } from "../../shared/watermarkBasis";
import { scoreHiddenDictionary, buildCodewordSignsTable } from "./dictionaryMatcher";
import { extractSoftBitsFromRectified } from "./extractSoftBits";
import { FrameAccumulator } from "./frameAccumulator";
import { LockPolicy } from "./lockPolicy";
import {
  alignLive,
  buildAlignContext,
  resetAlignTracking,
  resizeRgba,
  type AlignContext,
} from "./templateAlign";
import type {
  WorkerDiagnostics,
  WorkerInMessage,
  WorkerOutMessage,
  PipelineStatus,
} from "./types";

declare const self: DedicatedWorkerGlobalScope;

let busy = false;
let dropped = 0;
let ready = false;
let debug = false;
let opencvReady = false;
let alignCtx: AlignContext | null = null;
let mask: EligibilityMask | null = null;
let basisFields: Float32Array[] | null = null;
let digestTable: Uint8Array | null = null;
let cleanCanonical: Uint8ClampedArray | null = null;
const accumulator = new FrameAccumulator({
  trackLossResetMs: ENVELOPE_MANIFEST.lock.trackLossResetMs,
});
const lockPolicy = new LockPolicy({ ...ENVELOPE_MANIFEST.lock });
let firstUsableAt: number | null = null;
let lockedWord: string | null = null;
let lockedTokenHex: string | null = null;
let lockedSalt: number | null = null;
let resourcesHeld = 0;
let status: PipelineStatus = "searching";
let lastInitError: string | null = null;

const REQUIRED_CV = [
  "Mat",
  "ORB",
  "findHomography",
  "warpPerspective",
  "findTransformECC",
] as const;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function loadCv(baseUrl: string): Promise<any> {
  const url = new URL("assets/opencv/opencv.js", baseUrl).toString();
  try {
    importScripts(url);
  } catch (err) {
    throw new Error(
      `OpenCV unavailable: failed to load ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let cv = (self as any).cv;
  if (cv == null) {
    throw new Error("OpenCV unavailable: cv global missing after importScripts");
  }
  if (typeof cv.then === "function") {
    try {
      cv = await cv;
    } catch (err) {
      throw new Error(
        `OpenCV unavailable: runtime init failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // Some builds expose cv.onRuntimeInitialized
  if (cv && !cv.Mat && typeof cv.onRuntimeInitialized !== "undefined") {
    await new Promise<void>((resolve, reject) => {
      const prev = cv.onRuntimeInitialized;
      const timer = setTimeout(
        () => reject(new Error("OpenCV unavailable: runtime init timeout")),
        20000,
      );
      cv.onRuntimeInitialized = () => {
        clearTimeout(timer);
        if (typeof prev === "function") prev();
        resolve();
      };
    });
  }
  for (const name of REQUIRED_CV) {
    if (typeof cv[name] === "undefined") {
      throw new Error(`OpenCV unavailable: missing cv.${name}`);
    }
  }
  return cv;
}

async function init(baseUrl: string, debugFlag: boolean): Promise<void> {
  debug = debugFlag;
  lastInitError = null;
  const pngUrl = new URL(ENVELOPE_MANIFEST.assetPaths.png, baseUrl).toString();
  const maskUrl = new URL(ENVELOPE_MANIFEST.assetPaths.mask, baseUrl).toString();
  const basisUrl = new URL(ENVELOPE_MANIFEST.assetPaths.basis, baseUrl).toString();
  const digestUrl = new URL(
    "assets/envelope/hiddenDigestTable.bin",
    baseUrl,
  ).toString();

  const [pngRes, maskRes, basisRes, digestRes] = await Promise.all([
    fetch(pngUrl, { cache: "no-store" }),
    fetch(maskUrl, { cache: "no-store" }),
    fetch(basisUrl, { cache: "no-store" }),
    fetch(digestUrl, { cache: "no-store" }),
  ]);
  if (!pngRes.ok || !maskRes.ok || !basisRes.ok || !digestRes.ok) {
    throw new Error("Failed to fetch Hidden envelope assets.");
  }
  const pngBuf = await pngRes.arrayBuffer();
  if ((await sha256Hex(pngBuf)) !== ENVELOPE_MANIFEST.pngSha256) {
    throw new Error("Carrier PNG checksum mismatch in worker.");
  }
  const maskBuf = new Uint8Array(await maskRes.arrayBuffer());
  if (
    (await sha256Hex(
      maskBuf.buffer.slice(maskBuf.byteOffset, maskBuf.byteOffset + maskBuf.byteLength),
    )) !== ENVELOPE_MANIFEST.maskSha256
  ) {
    throw new Error("Mask checksum mismatch in worker.");
  }
  const basisBuf = new Uint8Array(await basisRes.arrayBuffer());
  const digestBuf = new Uint8Array(await digestRes.arrayBuffer());

  const weights = new Float32Array(
    maskBuf.buffer,
    maskBuf.byteOffset,
    maskBuf.byteLength / 4,
  );
  let coverage = 0;
  for (let i = 0; i < weights.length; i++) coverage += weights[i]!;
  mask = { weights, coverage: coverage / weights.length };

  const f32 = new Float32Array(
    basisBuf.buffer,
    basisBuf.byteOffset,
    basisBuf.byteLength / 4,
  );
  const stride = GRID_W * GRID_H;
  basisFields = [];
  for (let b = 0; b < 56; b++) {
    basisFields.push(f32.slice(b * stride, (b + 1) * stride));
  }
  digestTable = digestBuf;

  // Precompute matcher signs table once (avoids multi-second first-frame stall).
  buildCodewordSignsTable(
    HIDDEN_DICTIONARY_META.surfaces as any,
    digestTable,
  );

  const bmp = await createImageBitmap(new Blob([pngBuf], { type: "image/png" }));
  const nativeW = bmp.width;
  const nativeH = bmp.height;
  const canvas = new OffscreenCanvas(nativeW, nativeH);
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("OffscreenCanvas 2d unavailable");
  ctx2d.drawImage(bmp, 0, 0);
  const img = ctx2d.getImageData(0, 0, nativeW, nativeH);
  bmp.close();
  cleanCanonical = resizeRgba(
    img.data,
    nativeW,
    nativeH,
    ENVELOPE_MANIFEST.canonicalWidth,
    ENVELOPE_MANIFEST.canonicalHeight,
  );

  const cv = await loadCv(baseUrl);
  opencvReady = true;
  alignCtx = buildAlignContext(
    cleanCanonical,
    ENVELOPE_MANIFEST.canonicalWidth,
    ENVELOPE_MANIFEST.canonicalHeight,
    cv,
    { liveMode: true },
  );
  // Warm ORB reference once during init.
  try {
    const orb = new cv.ORB(500);
    const refMat = cv.matFromImageData({
      data: alignCtx.refRgba,
      width: alignCtx.refWidth,
      height: alignCtx.refHeight,
    });
    const refGray = new cv.Mat();
    cv.cvtColor(refMat, refGray, cv.COLOR_RGBA2GRAY);
    const rkp = new cv.KeyPointVector();
    const rdesc = new cv.Mat();
    orb.detectAndCompute(refGray, new cv.Mat(), rkp, rdesc);
    alignCtx.orbRefKeypoints = rkp;
    alignCtx.orbRefDescriptors = rdesc;
    alignCtx.refGrayMat = refGray;
    refMat.delete();
    orb.delete();
  } catch (err) {
    throw new Error(
      `OpenCV unavailable: ORB reference init failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  ready = true;
}

function post(msg: WorkerOutMessage): void {
  self.postMessage(msg);
}

function resetState(): void {
  accumulator.reset();
  lockPolicy.reset();
  firstUsableAt = null;
  lockedWord = null;
  lockedTokenHex = null;
  lockedSalt = null;
  status = "searching";
  if (alignCtx) resetAlignTracking(alignCtx);
}

function emptyDiag(partial: Partial<WorkerDiagnostics> = {}): WorkerDiagnostics {
  return {
    inliers: 0,
    inlierRatio: 0,
    reprojError: 0,
    validCarrierPct: 0,
    sharpness: 0,
    glare: 0,
    quality: 0,
    rejectReason: null,
    stageMs: {},
    totalMs: 0,
    bufferLen: accumulator.length,
    independentFrames: 0,
    totalWeight: 0,
    softScore: 0,
    softScoreMargin: 0,
    secondSoftScore: 0,
    avgAbsSoft: 0,
    softValues: null,
    residualChromaRms: 0,
    affineCbScale: 1,
    affineCbBias: 0,
    affineCrScale: 1,
    affineCrBias: 0,
    saltHypothesis: null,
    saltMargin: 0,
    estimatedBitErrors: null,
    matchFailReason: null,
    topCandidates: [],
    droppedFrames: dropped,
    skippedFrames: 0,
    resourcesHeld,
    alignPath: "none",
    alignMode: alignCtx?.mode ?? "searching",
    searchFrameCount: alignCtx?.searchFrameCount ?? 0,
    trackFrameCount: alignCtx?.trackFrameCount ?? 0,
    projectedHeightPx: 0,
    opencvReady,
    quad: null,
    ...partial,
  };
}

function statusLabelFor(s: PipelineStatus, weak = false): string {
  if (s === "locked") return "Locked";
  if (s === "signal_weak" || weak) return "Signal too weak — move closer or improve light";
  if (s === "reading") return "Reading hidden signal";
  if (s === "envelope_found") return "Envelope located — hold briefly";
  return "Searching for envelope";
}

async function processFrame(
  generation: number,
  timestampMs: number,
  bitmap: ImageBitmap,
): Promise<void> {
  const t0 = performance.now();
  const stageMs: Record<string, number> = {};
  const bitmapW = bitmap.width;
  const bitmapH = bitmap.height;

  const ack = () => post({ type: "frame_ack", generation });

  if (!alignCtx || !mask || !basisFields || !digestTable || !cleanCanonical) {
    try {
      bitmap.close();
    } catch (err) {
      post({
        type: "result",
        generation,
        status: "searching",
        lockedWord: null,
        tokenHex: null,
        salt8: null,
        timeToLockMs: null,
        diagnostics: emptyDiag({
          rejectReason: `bitmap_close_error:${err instanceof Error ? err.message : String(err)}`,
          totalMs: performance.now() - t0,
        }),
        statusLabel: statusLabelFor("searching"),
      });
    }
    ack();
    return;
  }

  let frameData: ImageData;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) {
      bitmap.close();
      post({
        type: "result",
        generation,
        status: "searching",
        lockedWord,
        tokenHex: lockedTokenHex,
        salt8: lockedSalt,
        timeToLockMs: null,
        diagnostics: emptyDiag({
          rejectReason: "offscreen_2d_unavailable",
          totalMs: performance.now() - t0,
          captureDebug: {
            sourceVideoWidth: 0,
            sourceVideoHeight: 0,
            workerBitmapWidth: bitmapW,
            workerBitmapHeight: bitmapH,
            captureMs: 0,
            framesSubmitted: 0,
            framesSkipped: 0,
            framesDropped: dropped,
            inFlight: 0,
          },
        }),
        statusLabel: statusLabelFor("searching"),
      });
      ack();
      return;
    }
    ctx2d.drawImage(bitmap, 0, 0);
    frameData = ctx2d.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
  } catch (err) {
    try {
      bitmap.close();
    } catch {
      /* already closed */
    }
    post({
      type: "result",
      generation,
      status: "searching",
      lockedWord,
      tokenHex: lockedTokenHex,
      salt8: lockedSalt,
      timeToLockMs: null,
      diagnostics: emptyDiag({
        rejectReason: `frame_copy_error:${err instanceof Error ? err.message : String(err)}`,
        totalMs: performance.now() - t0,
      }),
      statusLabel: statusLabelFor("searching"),
    });
    ack();
    return;
  }

  const tAlign0 = performance.now();
  let aligned;
  try {
    aligned = alignLive(
      alignCtx,
      frameData.data,
      frameData.width,
      frameData.height,
      timestampMs,
    );
  } catch (err) {
    accumulator.noteTrackLoss(timestampMs);
    status = "searching";
    post({
      type: "result",
      generation,
      status,
      lockedWord,
      tokenHex: lockedTokenHex,
      salt8: lockedSalt,
      timeToLockMs: null,
      diagnostics: emptyDiag({
        rejectReason: `align_error:${err instanceof Error ? err.message : String(err)}`,
        stageMs: { align: performance.now() - tAlign0 },
        totalMs: performance.now() - t0,
      }),
      statusLabel: statusLabelFor("searching"),
    });
    ack();
    return;
  }
  stageMs.align = performance.now() - tAlign0;

  if (!aligned.ok || !aligned.rectified || !aligned.valid) {
    accumulator.noteTrackLoss(timestampMs);
    status = "searching";
    post({
      type: "result",
      generation,
      status,
      lockedWord,
      tokenHex: lockedTokenHex,
      salt8: lockedSalt,
      timeToLockMs: null,
      diagnostics: debug
        ? emptyDiag({
            inliers: aligned.inliers,
            inlierRatio: aligned.inlierRatio,
            reprojError: aligned.reprojError,
            validCarrierPct: aligned.areaFraction * 100,
            sharpness: aligned.sharpness,
            quality: aligned.quality,
            rejectReason: aligned.reason,
            stageMs,
            totalMs: performance.now() - t0,
            alignPath: aligned.alignPath,
            alignMode: aligned.alignMode,
            projectedHeightPx: aligned.projectedHeightPx,
            quad: aligned.quad ?? null,
            captureDebug: {
              sourceVideoWidth: 0,
              sourceVideoHeight: 0,
              workerBitmapWidth: bitmapW,
              workerBitmapHeight: bitmapH,
              captureMs: 0,
              framesSubmitted: 0,
              framesSkipped: 0,
              framesDropped: dropped,
              inFlight: 0,
            },
          })
        : null,
      statusLabel: statusLabelFor(status),
    });
    ack();
    return;
  }

  if (aligned.quality < 0.15) {
    status = "envelope_found";
    post({
      type: "result",
      generation,
      status,
      lockedWord,
      tokenHex: lockedTokenHex,
      salt8: lockedSalt,
      timeToLockMs: null,
      diagnostics: debug
        ? emptyDiag({
            inliers: aligned.inliers,
            inlierRatio: aligned.inlierRatio,
            reprojError: aligned.reprojError,
            validCarrierPct: aligned.areaFraction * 100,
            sharpness: aligned.sharpness,
            quality: aligned.quality,
            rejectReason: "low_quality",
            stageMs,
            totalMs: performance.now() - t0,
            alignPath: aligned.alignPath,
            alignMode: aligned.alignMode,
            projectedHeightPx: aligned.projectedHeightPx,
            quad: aligned.quad ?? null,
          })
        : null,
      statusLabel: statusLabelFor(status),
    });
    ack();
    return;
  }

  status = "reading";
  if (firstUsableAt === null) firstUsableAt = timestampMs;

  let extracted;
  try {
    extracted = extractSoftBitsFromRectified({
      cleanRgba: cleanCanonical,
      observedRgba: aligned.rectified,
      width: ENVELOPE_MANIFEST.canonicalWidth,
      height: ENVELOPE_MANIFEST.canonicalHeight,
      valid: aligned.valid,
      mask,
      basisFields,
    });
  } catch (err) {
    post({
      type: "result",
      generation,
      status: "signal_weak",
      lockedWord,
      tokenHex: lockedTokenHex,
      salt8: lockedSalt,
      timeToLockMs: null,
      diagnostics: emptyDiag({
        rejectReason: `extract_error:${err instanceof Error ? err.message : String(err)}`,
        stageMs,
        totalMs: performance.now() - t0,
        alignPath: aligned.alignPath,
        alignMode: aligned.alignMode,
        projectedHeightPx: aligned.projectedHeightPx,
        quad: aligned.quad ?? null,
      }),
      statusLabel: statusLabelFor("signal_weak"),
    });
    ack();
    return;
  }
  stageMs.extract = extracted.extractMs;

  accumulator.push({
    soft: extracted.soft,
    noise: extracted.noise,
    quality: extracted.quality * aligned.quality,
    timestampMs,
  });

  const acc = accumulator.accumulateSoft();
  let match;
  try {
    match = scoreHiddenDictionary({
      soft: acc.soft,
      surfaces: HIDDEN_DICTIONARY_META.surfaces as any,
      digestTable,
      topSalts: 32,
      ambiguousMargin: ENVELOPE_MANIFEST.lock.minScoreMargin,
    });
  } catch (err) {
    post({
      type: "result",
      generation,
      status: "signal_weak",
      lockedWord,
      tokenHex: lockedTokenHex,
      salt8: lockedSalt,
      timeToLockMs: null,
      diagnostics: emptyDiag({
        rejectReason: `match_error:${err instanceof Error ? err.message : String(err)}`,
        stageMs: { ...stageMs, match: 0 },
        totalMs: performance.now() - t0,
        independentFrames: acc.independentCount,
        totalWeight: acc.totalWeight,
        avgAbsSoft: extracted.avgAbsSoft,
        residualChromaRms: extracted.residualChromaRms,
      }),
      statusLabel: statusLabelFor("signal_weak"),
    });
    ack();
    return;
  }
  stageMs.match = match.matchMs;

  const weakSignal =
    extracted.avgAbsSoft < 0.04 ||
    match.failReason === "no_dictionary_candidate" ||
    (match.best != null &&
      Math.abs(match.best.score) < ENVELOPE_MANIFEST.lock.minAbsConfidence * 0.5);

  let timeToLockMs: number | null = null;
  if (!lockedWord && match.best && !match.ambiguous && match.failReason == null) {
    const decision = lockPolicy.noteDecision({
      canonicalWord: match.best.canonicalWord,
      salt8: match.best.salt8,
      score: match.best.score,
      margin: match.margin,
      unique: match.unique && !match.ambiguous,
      qualitySafety: aligned.quality < 0.2 || extracted.quality < 0.15,
    });
    const evalLock = lockPolicy.evaluate(acc.independentCount, acc.spanMs);
    if (decision.mayLock && evalLock.mayLock) {
      lockedWord = match.best.canonicalWord;
      lockedSalt = match.best.salt8;
      const hard = bitsFromHardDecisions(acc.soft);
      lockedTokenHex = tokenToHex(bitsToToken(hard));
      status = "locked";
      timeToLockMs =
        firstUsableAt !== null ? timestampMs - firstUsableAt : null;
    } else if (weakSignal) {
      status = "signal_weak";
    }
  } else if (lockedWord) {
    status = "locked";
  } else if (weakSignal) {
    status = "signal_weak";
  } else if (match.failReason === "ambiguous_candidate") {
    status = "reading";
  }

  post({
    type: "result",
    generation,
    status,
    lockedWord,
    tokenHex: lockedTokenHex,
    salt8: lockedSalt,
    timeToLockMs,
    diagnostics: debug
      ? emptyDiag({
          inliers: aligned.inliers,
          inlierRatio: aligned.inlierRatio,
          reprojError: aligned.reprojError,
          validCarrierPct: extracted.validCarrierPct,
          sharpness: aligned.sharpness,
          glare: extracted.glare,
          quality: extracted.quality * aligned.quality,
          rejectReason: match.failReason,
          stageMs,
          totalMs: performance.now() - t0,
          bufferLen: accumulator.length,
          independentFrames: acc.independentCount,
          totalWeight: acc.totalWeight,
          softScore: match.best?.score ?? 0,
          softScoreMargin: match.margin,
          secondSoftScore: match.second?.score ?? 0,
          avgAbsSoft: extracted.avgAbsSoft,
          softValues: Array.from(extracted.soft),
          residualChromaRms: extracted.residualChromaRms,
          affineCbScale: extracted.affine.cbScale,
          affineCbBias: extracted.affine.cbBias,
          affineCrScale: extracted.affine.crScale,
          affineCrBias: extracted.affine.crBias,
          saltHypothesis: match.topSalt,
          saltMargin: match.saltMargin,
          estimatedBitErrors: match.best?.estimatedBitErrors ?? null,
          matchFailReason: match.failReason,
          topCandidates: [
            match.best
              ? {
                  word: match.best.canonicalWord,
                  score: match.best.score,
                  margin: match.margin,
                }
              : null,
            match.second
              ? { word: match.second.canonicalWord, score: match.second.score }
              : null,
          ].filter(Boolean) as WorkerDiagnostics["topCandidates"],
          alignPath: aligned.alignPath,
          alignMode: aligned.alignMode,
          projectedHeightPx: aligned.projectedHeightPx,
          quad: aligned.quad ?? null,
          captureDebug: {
            sourceVideoWidth: 0,
            sourceVideoHeight: 0,
            workerBitmapWidth: bitmapW,
            workerBitmapHeight: bitmapH,
            captureMs: 0,
            framesSubmitted: 0,
            framesSkipped: 0,
            framesDropped: dropped,
            inFlight: 1,
          },
        })
      : null,
    statusLabel: statusLabelFor(status, weakSignal),
  });
  ack();
}

self.onmessage = (ev: MessageEvent<WorkerInMessage>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    void init(msg.baseUrl, msg.debug)
      .then(() => post({ type: "ready", ok: true }))
      .catch((err) => {
        lastInitError = err instanceof Error ? err.message : String(err);
        opencvReady = false;
        ready = false;
        post({
          type: "ready",
          ok: false,
          error: lastInitError,
        });
      });
    return;
  }
  if (msg.type === "reset") {
    resetState();
    return;
  }
  if (msg.type === "frame") {
    if (!ready || busy) {
      dropped++;
      try {
        msg.bitmap.close();
      } catch (err) {
        // Surface via ack diagnostics path — main counts this as dropped.
        void err;
      }
      post({ type: "frame_ack", generation: msg.generation });
      return;
    }
    busy = true;
    resourcesHeld++;
    void processFrame(msg.generation, msg.timestampMs, msg.bitmap)
      .catch((err) => {
        post({
          type: "result",
          generation: msg.generation,
          status: "searching",
          lockedWord,
          tokenHex: lockedTokenHex,
          salt8: lockedSalt,
          timeToLockMs: null,
          diagnostics: emptyDiag({
            rejectReason: `process_error:${err instanceof Error ? err.message : String(err)}`,
          }),
          statusLabel: statusLabelFor("searching"),
        });
        post({ type: "frame_ack", generation: msg.generation });
      })
      .finally(() => {
        busy = false;
        resourcesHeld = Math.max(0, resourcesHeld - 1);
      });
  }
};
