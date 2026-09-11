/**
 * Hidden envelope spectator transport — embeds HENV1 into the carrier PNG.
 * Sensitive session values stay in module memory only.
 * Token creation is owned by spectator.ts; this module only embeds.
 */

import { ENVELOPE_MANIFEST } from "../../generated/envelopeManifest";
import {
  tokenToHex,
  type HiddenToken,
} from "../../shared/hiddenEnvelopeProtocol";
import {
  GRID_H,
  GRID_W,
  type EligibilityMask,
} from "../../shared/watermarkBasis";
import { embedHiddenWatermark } from "../watermark/embed";

let cachedClean: {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  mask: EligibilityMask;
  basisFields: Float32Array[];
} | null = null;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function loadBasisFields(baseUrl: string): Promise<Float32Array[]> {
  const url = new URL(ENVELOPE_MANIFEST.assetPaths.basis, baseUrl).toString();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load basis: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const expected = ENVELOPE_MANIFEST.basisFileSha256;
  const got = await sha256Hex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (got !== expected) {
    throw new Error("Basis asset checksum mismatch.");
  }
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const fields: Float32Array[] = [];
  const stride = GRID_W * GRID_H;
  for (let b = 0; b < 56; b++) {
    fields.push(f32.slice(b * stride, (b + 1) * stride));
  }
  return fields;
}

async function loadMask(baseUrl: string): Promise<EligibilityMask> {
  const url = new URL(ENVELOPE_MANIFEST.assetPaths.mask, baseUrl).toString();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load mask: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const got = await sha256Hex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (got !== ENVELOPE_MANIFEST.maskSha256) {
    throw new Error("Mask asset checksum mismatch.");
  }
  const weights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  let coverage = 0;
  for (let i = 0; i < weights.length; i++) coverage += weights[i]!;
  coverage /= weights.length;
  return { weights, coverage };
}

async function loadCleanCarrier(baseUrl: string): Promise<{
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  const url = new URL(ENVELOPE_MANIFEST.assetPaths.png, baseUrl).toString();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load carrier PNG: ${res.status}`);
  const ab = await res.arrayBuffer();
  const got = await sha256Hex(ab);
  if (got !== ENVELOPE_MANIFEST.pngSha256) {
    throw new Error(
      "Carrier PNG checksum mismatch. Hidden envelope disabled.",
    );
  }
  const blob = new Blob([ab], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  if (
    bmp.width !== ENVELOPE_MANIFEST.nativeWidth ||
    bmp.height !== ENVELOPE_MANIFEST.nativeHeight
  ) {
    bmp.close();
    throw new Error("Carrier PNG dimension mismatch.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    throw new Error("2D canvas unavailable.");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    rgba: imageData.data,
    width: canvas.width,
    height: canvas.height,
  };
}

export async function ensureHiddenAssets(baseUrl: string): Promise<void> {
  if (cachedClean) return;
  const [clean, mask, basisFields] = await Promise.all([
    loadCleanCarrier(baseUrl),
    loadMask(baseUrl),
    loadBasisFields(baseUrl),
  ]);
  cachedClean = { ...clean, mask, basisFields };
}

export type HiddenRenderResult = {
  objectUrl: string;
  token: HiddenToken;
  tokenHex: string;
  clippedPercent: number;
  encodeMs: number;
  width: number;
  height: number;
};

export async function renderHiddenEnvelope(
  host: HTMLElement,
  token: HiddenToken | Uint8Array,
  baseUrl: string,
  options?: { alphaOverride?: number },
): Promise<HiddenRenderResult> {
  await ensureHiddenAssets(baseUrl);
  if (!cachedClean) throw new Error("Hidden envelope assets not loaded.");

  const hidden: HiddenToken =
    token instanceof Uint8Array
      ? {
          protocolId: "HENV1",
          salt8: token[0]!,
          digest6: token.subarray(1, 7),
          token,
          normalizedWord: "",
        }
      : token;
  if (hidden.token.length !== 7) {
    throw new Error("Hidden envelope requires a 7-byte HENV1 token.");
  }

  const alpha =
    options?.alphaOverride != null
      ? options.alphaOverride
      : ENVELOPE_MANIFEST.alpha;
  const embedded = embedHiddenWatermark({
    rgba: cachedClean.rgba,
    width: cachedClean.width,
    height: cachedClean.height,
    token: hidden.token,
    alpha,
    mask: cachedClean.mask,
    basisFields: cachedClean.basisFields,
  });

  const canvas = document.createElement("canvas");
  canvas.width = embedded.width;
  canvas.height = embedded.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable.");
  ctx.putImageData(
    new ImageData(embedded.rgba, embedded.width, embedded.height),
    0,
    0,
  );

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
  const objectUrl = URL.createObjectURL(blob);

  host.replaceChildren();
  host.className = "transport-host transport-hidden";
  const img = document.createElement("img");
  img.src = objectUrl;
  img.alt = "Closed envelope";
  img.className = "hidden-envelope-img";
  img.draggable = false;
  host.appendChild(img);

  return {
    objectUrl,
    token: hidden,
    tokenHex: tokenToHex(hidden.token),
    clippedPercent: embedded.clippedPercent,
    encodeMs: embedded.encodeMs,
    width: embedded.width,
    height: embedded.height,
  };
}

export function getCachedCleanForDebug(): typeof cachedClean {
  return cachedClean;
}
