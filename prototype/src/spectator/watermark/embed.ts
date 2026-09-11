/**
 * Chroma watermark embedding for Hidden envelope.
 */

import { upsampleBicubic } from "../../shared/bicubic";
import {
  BIT_COUNT,
  GRID_H,
  GRID_W,
  generateBasisFields,
  type EligibilityMask,
} from "../../shared/watermarkBasis";
import { bitsToSigns, tokenToBits } from "../../shared/hiddenEnvelopeProtocol";
import { srgbToYCbCr, yCbCrToSrgb } from "../../shared/ycbcr";

export type EmbedResult = {
  width: number;
  height: number;
  /** RGBA buffer */
  rgba: Uint8ClampedArray;
  clippedPercent: number;
  encodeMs: number;
};

export type EmbedInputs = {
  /** Source RGBA of clean carrier (native size). */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  token: Uint8Array;
  alpha: number;
  mask: EligibilityMask;
  basisFields?: Float32Array[];
};

export function embedHiddenWatermark(input: EmbedInputs): EmbedResult {
  const t0 =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  const { width, height, rgba, token, alpha, mask } = input;
  if (rgba.length !== width * height * 4) {
    throw new Error("RGBA length does not match dimensions.");
  }

  const fields = input.basisFields ?? generateBasisFields(mask).fields;
  if (fields.length !== BIT_COUNT) {
    throw new Error("Basis field count mismatch.");
  }

  const bits = tokenToBits(token);
  const signs = bitsToSigns(bits);
  const n = GRID_W * GRID_H;
  const composite = new Float32Array(n);
  const invSqrt = 1 / Math.sqrt(BIT_COUNT);

  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let b = 0; b < BIT_COUNT; b++) {
      sum += signs[b]! * fields[b]![i]!;
    }
    composite[i] = sum * invSqrt * (mask.weights[i] ?? 0);
  }

  // Remove weighted mean; normalize to unit weighted RMS.
  let wSum = 0;
  let meanAcc = 0;
  for (let i = 0; i < n; i++) {
    const w = mask.weights[i] ?? 0;
    if (w <= 0) continue;
    wSum += w;
    meanAcc += w * composite[i]!;
  }
  const mean = wSum > 0 ? meanAcc / wSum : 0;
  let rmsAcc = 0;
  for (let i = 0; i < n; i++) {
    const w = mask.weights[i] ?? 0;
    if (w <= 0) {
      composite[i] = 0;
      continue;
    }
    const v = composite[i]! - mean;
    composite[i] = v;
    rmsAcc += w * v * v;
  }
  const rms = wSum > 0 ? Math.sqrt(rmsAcc / wSum) : 0;
  let clipped = 0;
  let eligible = 0;
  if (rms > 1e-12) {
    for (let i = 0; i < n; i++) {
      const w = mask.weights[i] ?? 0;
      if (w <= 0) continue;
      eligible++;
      let v = composite[i]! / rms;
      if (v > 3) {
        v = 3;
        clipped++;
      } else if (v < -3) {
        v = -3;
        clipped++;
      }
      composite[i] = v;
    }
  }

  const fieldNative = upsampleBicubic(composite, GRID_W, GRID_H, width, height);
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    const r = rgba[o]!;
    const g = rgba[o + 1]!;
    const b = rgba[o + 2]!;
    const a = rgba[o + 3]!;
    const { y, cb, cr } = srgbToYCbCr(r, g, b);
    const f = fieldNative[p]!;
    const { r: nr, g: ng, b: nb } = yCbCrToSrgb(
      y,
      cb + alpha * f,
      cr - alpha * f,
    );
    out[o] = nr;
    out[o + 1] = ng;
    out[o + 2] = nb;
    out[o + 3] = a;
  }

  const t1 =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  return {
    width,
    height,
    rgba: out,
    clippedPercent: eligible > 0 ? (100 * clipped) / eligible : 0,
    encodeMs: t1 - t0,
  };
}

/**
 * Exact-image soft-bit extraction (identity alignment) for digital tests.
 */
export function extractSoftBitsExact(input: {
  cleanRgba: Uint8ClampedArray;
  encodedRgba: Uint8ClampedArray;
  width: number;
  height: number;
  mask: EligibilityMask;
  basisFields: Float32Array[];
}): { soft: Float64Array; quality: number } {
  const { cleanRgba, encodedRgba, width, height, mask, basisFields } = input;
  const residual = new Float32Array(GRID_W * GRID_H);
  const weights = new Float32Array(GRID_W * GRID_H);
  const cellW = width / GRID_W;
  const cellH = height / GRID_H;

  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const gi = gy * GRID_W + gx;
      const mw = mask.weights[gi] ?? 0;
      if (mw <= 0) continue;
      let acc = 0;
      let count = 0;
      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.floor((gx + 1) * cellW);
      const y1 = Math.floor((gy + 1) * cellH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * width + x) * 4;
          const c0 = srgbToYCbCr(
            cleanRgba[o]!,
            cleanRgba[o + 1]!,
            cleanRgba[o + 2]!,
          );
          const c1 = srgbToYCbCr(
            encodedRgba[o]!,
            encodedRgba[o + 1]!,
            encodedRgba[o + 2]!,
          );
          // Opposite-chroma projection matching embed: dCb - (-dCr) wait:
          // embed: Cb += a*f, Cr -= a*f → residual projection = (dCb - dCr) / 2
          const dCb = c1.cb - c0.cb;
          const dCr = c1.cr - c0.cr;
          acc += (dCb - dCr) / 2;
          count++;
        }
      }
      if (count > 0) {
        residual[gi] = acc / count;
        weights[gi] = mw;
      }
    }
  }

  const soft = new Float64Array(BIT_COUNT);
  for (let b = 0; b < BIT_COUNT; b++) {
    soft[b] = weightedNcc(residual, basisFields[b]!, weights);
  }
  return { soft, quality: 1 };
}

function weightedNcc(
  residual: Float32Array,
  basis: Float32Array,
  weights: Float32Array,
): number {
  let wr = 0;
  let wb = 0;
  let wSum = 0;
  for (let i = 0; i < residual.length; i++) {
    const w = weights[i]!;
    if (w <= 0) continue;
    wr += w * residual[i]!;
    wb += w * basis[i]!;
    wSum += w;
  }
  if (wSum <= 0) return 0;
  const mr = wr / wSum;
  const mb = wb / wSum;
  let num = 0;
  let dr = 0;
  let db = 0;
  for (let i = 0; i < residual.length; i++) {
    const w = weights[i]!;
    if (w <= 0) continue;
    const rv = residual[i]! - mr;
    const bv = basis[i]! - mb;
    num += w * rv * bv;
    dr += w * rv * rv;
    db += w * bv * bv;
  }
  const denom = Math.sqrt(dr * db);
  if (denom < 1e-12) return 0;
  return num / denom;
}
