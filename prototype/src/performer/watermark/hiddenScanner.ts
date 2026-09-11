/**
 * Main-thread controller for the Hidden-envelope worker pipeline.
 *
 * Capture uses a reusable canvas with long edge ≤640. Strict back-pressure:
 * at most one capture in progress and one bitmap in the worker.
 */

import type {
  PipelineStatus,
  WorkerDiagnostics,
  WorkerOutMessage,
} from "./types";

export type HiddenScannerCallbacks = {
  onStatus: (status: PipelineStatus, label?: string) => void;
  onLock: (info: {
    word: string;
    tokenHex: string | null;
    salt8: number | null;
    timeToLockMs: number | null;
    generation: number;
  }) => void;
  onDiagnostics?: (diag: WorkerDiagnostics) => void;
  onError?: (message: string) => void;
};

export type HiddenScannerHandle = {
  stop: () => void;
  reset: () => void;
  getStream: () => MediaStream | null;
  getCaptureStats: () => CaptureStats;
};

export type CaptureStats = {
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

const CAPTURE_LONG_EDGE = 640;
const TARGET_INTERVAL_MS = 85; // ~11–12 fps

export async function startHiddenScanner(options: {
  video: HTMLVideoElement;
  deviceId?: string;
  workerUrl: string;
  baseUrl: string;
  debug: boolean;
  callbacks: HiddenScannerCallbacks;
}): Promise<HiddenScannerHandle> {
  const worker = new Worker(options.workerUrl);
  let stream: MediaStream | null = null;
  let stopped = false;
  let generation = 1;
  let raf = 0;
  let lastPost = 0;
  let locked = false;

  let inFlight = 0;
  let captureInProgress = false;
  let framesSubmitted = 0;
  let framesSkipped = 0;
  let framesDropped = 0;
  let lastCaptureMs = 0;
  let lastBitmapW = 0;
  let lastBitmapH = 0;
  let pendingBitmap: ImageBitmap | null = null;

  const captureCanvas = document.createElement("canvas");
  const captureCtx = captureCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!captureCtx) {
    worker.terminate();
    throw new Error("2D capture canvas unavailable");
  }

  const ready = new Promise<void>((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerOutMessage>) => {
      if (ev.data.type === "ready") {
        worker.removeEventListener("message", onMsg);
        if (ev.data.ok) resolve();
        else {
          const err = ev.data.error || "Worker init failed";
          options.callbacks.onError?.(err);
          reject(new Error(err));
        }
      }
    };
    worker.addEventListener("message", onMsg);
  });

  worker.postMessage({
    type: "init",
    baseUrl: options.baseUrl,
    debug: options.debug,
  });

  const tryConstraints = async (mild: boolean): Promise<MediaStream> => {
    const videoConstraints: MediaTrackConstraints = options.deviceId
      ? { deviceId: { exact: options.deviceId } }
      : { facingMode: { ideal: "environment" } };
    if (!mild) {
      videoConstraints.width = { ideal: 1920 };
      videoConstraints.height = { ideal: 1080 };
      videoConstraints.frameRate = { ideal: 30, min: 15 };
    }
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints,
    });
    try {
      const track = s.getVideoTracks()[0];
      if (track) {
        await track.applyConstraints({
          advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
        });
      }
    } catch (err) {
      // Unsupported AF — surface in debug only.
      if (options.debug) {
        console.warn("focusMode continuous unsupported", err);
      }
    }
    return s;
  };

  try {
    stream = await tryConstraints(false);
  } catch (err) {
    try {
      stream = await tryConstraints(true);
    } catch (err2) {
      worker.terminate();
      const message =
        err2 instanceof Error
          ? err2.message
          : err instanceof Error
            ? err.message
            : "Camera error";
      options.callbacks.onError?.(message);
      throw err2;
    }
  }

  options.video.srcObject = stream;
  await options.video.play();
  await ready;

  const releasePending = () => {
    if (pendingBitmap) {
      try {
        pendingBitmap.close();
      } catch (err) {
        if (options.debug) console.warn("pending bitmap close", err);
      }
      pendingBitmap = null;
    }
  };

  const noteWorkerDone = () => {
    inFlight = Math.max(0, inFlight - 1);
  };

  worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
    const msg = ev.data;
    if (msg.type === "frame_ack") {
      noteWorkerDone();
      return;
    }
    if (msg.type !== "result") return;
    // Results also imply the frame finished; ack may arrive separately.
    if (msg.generation !== generation) return;
    options.callbacks.onStatus(msg.status, msg.statusLabel);
    if (msg.diagnostics && options.callbacks.onDiagnostics) {
      const stats = getCaptureStats();
      msg.diagnostics.captureDebug = {
        sourceVideoWidth: stats.sourceVideoWidth,
        sourceVideoHeight: stats.sourceVideoHeight,
        workerBitmapWidth: stats.workerBitmapWidth,
        workerBitmapHeight: stats.workerBitmapHeight,
        captureMs: stats.captureMs,
        framesSubmitted: stats.framesSubmitted,
        framesSkipped: stats.framesSkipped,
        framesDropped: stats.framesDropped + (msg.diagnostics.droppedFrames || 0),
        inFlight: stats.inFlight,
      };
      msg.diagnostics.skippedFrames = stats.framesSkipped;
      options.callbacks.onDiagnostics(msg.diagnostics);
    }
    if (msg.status === "locked" && msg.lockedWord && !locked) {
      locked = true;
      options.callbacks.onLock({
        word: msg.lockedWord,
        tokenHex: msg.tokenHex,
        salt8: msg.salt8,
        timeToLockMs: msg.timeToLockMs,
        generation,
      });
    }
  };

  worker.onerror = (ev) => {
    options.callbacks.onError?.(
      `Hidden envelope worker error: ${ev.message || "unknown"}`,
    );
  };

  function getCaptureStats(): CaptureStats {
    return {
      sourceVideoWidth: options.video.videoWidth || 0,
      sourceVideoHeight: options.video.videoHeight || 0,
      workerBitmapWidth: lastBitmapW,
      workerBitmapHeight: lastBitmapH,
      captureMs: lastCaptureMs,
      framesSubmitted,
      framesSkipped,
      framesDropped,
      inFlight,
    };
  }

  const postFrame = (now: number) => {
    if (stopped || !options.video.videoWidth) return;
    if (now - lastPost < TARGET_INTERVAL_MS) return;

    // Strict back-pressure: do not create frames while one is in-flight.
    if (inFlight >= 1 || captureInProgress) {
      framesSkipped++;
      return;
    }

    lastPost = now;
    captureInProgress = true;
    const tCap0 = performance.now();

    try {
      const vw = options.video.videoWidth;
      const vh = options.video.videoHeight;
      const long = Math.max(vw, vh);
      const scale = long > CAPTURE_LONG_EDGE ? CAPTURE_LONG_EDGE / long : 1;
      const cw = Math.max(1, Math.round(vw * scale));
      const ch = Math.max(1, Math.round(vh * scale));
      if (captureCanvas.width !== cw || captureCanvas.height !== ch) {
        captureCanvas.width = cw;
        captureCanvas.height = ch;
      }
      captureCtx.drawImage(options.video, 0, 0, cw, ch);

      void (async () => {
        let bitmap: ImageBitmap | null = null;
        try {
          bitmap = await createImageBitmap(captureCanvas);
          lastCaptureMs = performance.now() - tCap0;
          lastBitmapW = bitmap.width;
          lastBitmapH = bitmap.height;

          if (stopped || inFlight >= 1) {
            bitmap.close();
            framesSkipped++;
            return;
          }

          pendingBitmap = bitmap;
          inFlight = 1;
          framesSubmitted++;
          const toSend = bitmap;
          pendingBitmap = null;
          worker.postMessage(
            { type: "frame", generation, timestampMs: now, bitmap: toSend },
            [toSend],
          );
        } catch (err) {
          framesDropped++;
          if (bitmap) {
            try {
              bitmap.close();
            } catch (closeErr) {
              if (options.debug) console.warn("bitmap close after fail", closeErr);
            }
          }
          options.callbacks.onError?.(
            `Capture failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          captureInProgress = false;
        }
      })();
    } catch (err) {
      captureInProgress = false;
      framesDropped++;
      options.callbacks.onError?.(
        `Capture setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const videoEl = options.video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number) => void) => number;
    cancelVideoFrameCallback?: (id: number) => void;
  };

  let rvfcId = 0;
  const loopRvfc = (now: number) => {
    if (stopped) return;
    postFrame(now);
    rvfcId = videoEl.requestVideoFrameCallback!(loopRvfc);
  };
  if (typeof videoEl.requestVideoFrameCallback === "function") {
    rvfcId = videoEl.requestVideoFrameCallback(loopRvfc);
  } else {
    const loop = (now: number) => {
      if (stopped) return;
      postFrame(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  return {
    getStream: () => stream,
    getCaptureStats,
    reset: () => {
      locked = false;
      generation += 1;
      releasePending();
      inFlight = 0;
      captureInProgress = false;
      worker.postMessage({ type: "reset" });
    },
    stop: () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (rvfcId && videoEl.cancelVideoFrameCallback) {
        videoEl.cancelVideoFrameCallback(rvfcId);
      }
      releasePending();
      inFlight = 0;
      worker.terminate();
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      options.video.srcObject = null;
    },
  };
}
