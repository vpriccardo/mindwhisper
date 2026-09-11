/**
 * Camera capture → PENV1 decoder worker.
 */

export type ParametricScannerCallbacks = {
  onStatus: (state: string, reason: string | null, paperFrac: number | null) => void;
  onLock: (info: {
    word: string;
    index: number;
    conceptId: string;
    timeToLockMs: number;
    decodeMs: number;
  }) => void;
  onError?: (message: string) => void;
};

export type ParametricScannerHandle = {
  stop: () => void;
  reset: () => void;
};

const CAPTURE_LONG_EDGE = 640;
const INTERVAL_MS = 90;

export async function startParametricScanner(options: {
  video: HTMLVideoElement;
  deviceId?: string;
  workerUrl: string;
  callbacks: ParametricScannerCallbacks;
}): Promise<ParametricScannerHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not available in this browser.");
  }

  const videoConstraints: MediaTrackConstraints = options.deviceId
    ? { deviceId: { exact: options.deviceId } }
    : { facingMode: { ideal: "environment" } };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...videoConstraints, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints,
    });
  }

  const video = options.video;
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  await video.play();

  const worker = new Worker(options.workerUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    stream.getTracks().forEach((t) => t.stop());
    worker.terminate();
    throw new Error("2D capture canvas unavailable");
  }

  let stopped = false;
  let inFlight = false;
  let raf = 0;
  let last = 0;

  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as {
      type: string;
      word?: string;
      index?: number;
      conceptId?: string;
      timeToLockMs?: number;
      decodeMs?: number;
      state?: string;
      reason?: string | null;
      paperFrac?: number | null;
    };
    if (msg.type === "lock") {
      inFlight = false;
      options.callbacks.onLock({
        word: msg.word!,
        index: msg.index!,
        conceptId: msg.conceptId!,
        timeToLockMs: msg.timeToLockMs!,
        decodeMs: msg.decodeMs!,
      });
      return;
    }
    if (msg.type === "status") {
      inFlight = false;
      options.callbacks.onStatus(msg.state ?? "searching", msg.reason ?? null, msg.paperFrac ?? null);
    }
  };

  const tick = (now: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (inFlight || now - last < INTERVAL_MS) return;
    if (!video.videoWidth) return;
    last = now;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = CAPTURE_LONG_EDGE / Math.max(vw, vh);
    const w = Math.max(2, Math.round(vw * scale));
    const h = Math.max(2, Math.round(vh * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    inFlight = true;
    worker.postMessage(
      {
        type: "frame",
        width: w,
        height: h,
        rgba: img.data.buffer,
        tMs: now,
      },
      [img.data.buffer],
    );
  };
  raf = requestAnimationFrame(tick);
  worker.postMessage({ type: "reset" });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      worker.postMessage({ type: "stop" });
      worker.terminate();
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
    reset: () => {
      inFlight = false;
      worker.postMessage({ type: "reset" });
    },
  };
}
