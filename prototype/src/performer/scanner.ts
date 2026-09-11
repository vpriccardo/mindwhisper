/** Webcam + ZXing continuous recognition (QR + Aztec only). */

import { BrowserMultiFormatReader } from "@zxing/browser";
import {
  BarcodeFormat,
  DecodeHintType,
  type Result,
} from "@zxing/library";
import type { OpticalFormat } from "./acquisition";

export type ScanEvent =
  | { kind: "symbol"; text: string; format: OpticalFormat; decodeMs: number }
  | { kind: "empty"; decodeMs: number }
  | { kind: "error"; message: string };

/** Target gap between decode cycles when work finishes early (~25–30 Hz). */
const MIN_INTERVAL_MS = 35;
/** Cap capture width for decode speed; higher source video still helps focus. */
const DECODE_MAX_WIDTH = 1280;

function mapFormat(result: Result): OpticalFormat {
  const fmt = result.getBarcodeFormat();
  if (fmt === BarcodeFormat.AZTEC) return "AZTEC";
  if (fmt === BarcodeFormat.QR_CODE) return "QR_CODE";
  return "UNKNOWN";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listVideoInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export type ScannerHandle = {
  stop: () => void;
  getStream: () => MediaStream | null;
};

function buildHints(): Map<DecodeHintType, unknown> {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.AZTEC,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.PURE_BARCODE, false);
  return hints;
}

/**
 * Draw a video region into `out`, optionally scaling up a center crop (digital zoom)
 * and applying a light contrast stretch for low-contrast wax/postal symbols.
 */
function captureRegion(
  video: HTMLVideoElement,
  out: HTMLCanvasElement,
  opts: {
    crop: number; // 1 = full frame, 0.5 = center half, etc.
    scaleUp: number;
    contrast: boolean;
  },
): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  const cropW = Math.floor(vw * opts.crop);
  const cropH = Math.floor(vh * opts.crop);
  const sx = Math.floor((vw - cropW) / 2);
  const sy = Math.floor((vh - cropH) / 2);

  let dw = Math.floor(cropW * opts.scaleUp);
  let dh = Math.floor(cropH * opts.scaleUp);
  if (dw > DECODE_MAX_WIDTH) {
    const r = DECODE_MAX_WIDTH / dw;
    dw = DECODE_MAX_WIDTH;
    dh = Math.floor(dh * r);
  }

  out.width = dw;
  out.height = dh;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, dw, dh);

  if (!opts.contrast) return;

  const image = ctx.getImageData(0, 0, dw, dh);
  const data = image.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) | 0;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < data.length; i += 4) {
    const y = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) | 0;
    const stretched = (((y - min) * 255) / range) | 0;
    data[i] = stretched;
    data[i + 1] = stretched;
    data[i + 2] = stretched;
  }
  ctx.putImageData(image, 0, 0);
}

function invertCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i]!;
    data[i + 1] = 255 - data[i + 1]!;
    data[i + 2] = 255 - data[i + 2]!;
  }
  ctx.putImageData(image, 0, 0);
}

type Pass = { crop: number; scaleUp: number; contrast: boolean; invert?: boolean };

/** Ordered passes: full frame first, then center zooms for distant/passing symbols. */
const DECODE_PASSES: Pass[] = [
  { crop: 1, scaleUp: 1, contrast: false },
  { crop: 0.7, scaleUp: 1.4, contrast: false },
  { crop: 0.5, scaleUp: 2, contrast: true },
  { crop: 0.4, scaleUp: 2.4, contrast: true },
  { crop: 0.55, scaleUp: 1.8, contrast: true, invert: true },
];

async function tryBarcodeDetector(
  canvas: HTMLCanvasElement,
): Promise<{ text: string; format: OpticalFormat } | null> {
  const BD = (
    globalThis as unknown as {
      BarcodeDetector?: new (opts: { formats: string[] }) => {
        detect: (source: ImageBitmapSource) => Promise<
          Array<{ rawValue: string; format: string }>
        >;
      };
    }
  ).BarcodeDetector;
  if (!BD) return null;
  try {
    const supported = await (
      BD as unknown as { getSupportedFormats: () => Promise<string[]> }
    ).getSupportedFormats?.();
    if (supported) {
      const set = new Set(supported.map((f) => f.toLowerCase()));
      if (!set.has("qr_code") || !set.has("aztec")) return null;
    }
  } catch {
    return null;
  }
  try {
    const detector = new BD({ formats: ["qr_code", "aztec"] });
    const codes = await detector.detect(canvas);
    for (const code of codes) {
      const fmt = code.format.toLowerCase();
      if (fmt.includes("aztec")) {
        return { text: code.rawValue, format: "AZTEC" };
      }
      if (fmt.includes("qr")) {
        return { text: code.rawValue, format: "QR_CODE" };
      }
    }
  } catch {
    // fall through to ZXing
  }
  return null;
}

/**
 * High-rate continuous scanner: multi-ROI + contrast/invert passes, no overlapping work.
 * Tuned for brief “pass-by” glimpses of QR / low-contrast Aztec seals.
 */
export async function startScanner(options: {
  video: HTMLVideoElement;
  deviceId?: string;
  onEvent: (event: ScanEvent) => void;
}): Promise<ScannerHandle> {
  const reader = new BrowserMultiFormatReader(buildHints(), {
    delayBetweenScanAttempts: 0,
    delayBetweenScanSuccess: 0,
  });

  let stream: MediaStream | null = null;
  let stopped = false;
  let loopPromise: Promise<void> | null = null;

  const constraints: MediaStreamConstraints = {
    audio: false,
    video: options.deviceId
      ? {
          deviceId: { exact: options.deviceId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, min: 15 },
        }
      : {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, min: 15 },
        },
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Retry with milder constraints
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: options.deviceId
          ? { deviceId: { exact: options.deviceId } }
          : { facingMode: { ideal: "environment" } },
      });
    } catch (err2) {
      const message =
        err2 instanceof Error ? err2.message : "Unable to access the camera.";
      options.onEvent({ kind: "error", message });
      throw err2;
    }
  }

  // Prefer continuous autofocus when the UA supports it
  for (const track of stream.getVideoTracks()) {
    const anyTrack = track as MediaStreamTrack & {
      applyConstraints: (c: MediaTrackConstraints) => Promise<void>;
    };
    try {
      await anyTrack.applyConstraints({
        advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
      });
    } catch {
      // ignore unsupported constraints
    }
  }

  options.video.srcObject = stream;
  options.video.setAttribute("playsinline", "true");
  options.video.muted = true;
  await options.video.play().catch(() => undefined);

  // Wait briefly for dimensions
  for (let i = 0; i < 30 && (!options.video.videoWidth || !options.video.videoHeight); i++) {
    await sleep(50);
  }

  const work = document.createElement("canvas");

  const runLoop = async (): Promise<void> => {
    while (!stopped) {
      const t0 = performance.now();
      let found: { text: string; format: OpticalFormat } | null = null;

      if (options.video.readyState >= 2 && options.video.videoWidth > 0) {
        for (const pass of DECODE_PASSES) {
          if (stopped) break;
          captureRegion(options.video, work, pass);
          if (pass.invert) invertCanvas(work);

          // Native fast path when available (helps QR pass-by)
          const native = await tryBarcodeDetector(work);
          if (native) {
            found = native;
            break;
          }

          try {
            const result: Result = reader.decodeFromCanvas(work);
            found = { text: result.getText(), format: mapFormat(result) };
            break;
          } catch {
            // try next pass
          }
        }
      }

      const decodeMs = performance.now() - t0;
      if (found) {
        options.onEvent({
          kind: "symbol",
          text: found.text,
          format: found.format,
          decodeMs,
        });
      } else {
        options.onEvent({ kind: "empty", decodeMs });
      }

      const wait = Math.max(0, MIN_INTERVAL_MS - (performance.now() - t0));
      if (wait > 0) await sleep(wait);
    }
  };

  loopPromise = runLoop();

  return {
    getStream: () => stream,
    stop: () => {
      stopped = true;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        stream = null;
      }
      options.video.srcObject = null;
      void loopPromise;
    },
  };
}

/** Optional BarcodeDetector fast path — only if both formats are supported. */
export async function barcodeDetectorSupportsRequired(): Promise<boolean> {
  const BD = (
    globalThis as unknown as {
      BarcodeDetector?: {
        getSupportedFormats: () => Promise<string[]>;
      };
    }
  ).BarcodeDetector;
  if (!BD?.getSupportedFormats) return false;
  try {
    const formats = await BD.getSupportedFormats();
    const set = new Set(formats.map((f) => f.toLowerCase()));
    return set.has("qr_code") && set.has("aztec");
  } catch {
    return false;
  }
}
