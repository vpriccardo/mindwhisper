/**
 * Radiometric affine mapping of reference chroma → observed.
 */

import { srgbToYCbCr } from "../../shared/ycbcr";

export function estimateChromaAffine(
  refRgba: Uint8ClampedArray,
  obsRgba: Uint8ClampedArray,
  width: number,
  height: number,
  valid: Uint8Array,
): { cbScale: number; cbBias: number; crScale: number; crBias: number } {
  // Fit obs ≈ scale * ref + bias using robust means of low/high bins.
  let n = 0;
  let sumRefCb = 0;
  let sumObsCb = 0;
  let sumRefCr = 0;
  let sumObsCr = 0;
  let sumRefCb2 = 0;
  let sumRefCr2 = 0;
  let sumRefObsCb = 0;
  let sumRefObsCr = 0;

  const step = Math.max(1, Math.floor((width * height) / 20_000));
  for (let p = 0; p < width * height; p += step) {
    if (!valid[p]) continue;
    const o = p * 4;
    const yRef = 0.299 * refRgba[o]! + 0.587 * refRgba[o + 1]! + 0.114 * refRgba[o + 2]!;
    const yObs = 0.299 * obsRgba[o]! + 0.587 * obsRgba[o + 1]! + 0.114 * obsRgba[o + 2]!;
    if (yRef < 15 || yRef > 245 || yObs < 15 || yObs > 245) continue;
    const r0 = srgbToYCbCr(refRgba[o]!, refRgba[o + 1]!, refRgba[o + 2]!);
    const r1 = srgbToYCbCr(obsRgba[o]!, obsRgba[o + 1]!, obsRgba[o + 2]!);
    sumRefCb += r0.cb;
    sumObsCb += r1.cb;
    sumRefCr += r0.cr;
    sumObsCr += r1.cr;
    sumRefCb2 += r0.cb * r0.cb;
    sumRefCr2 += r0.cr * r0.cr;
    sumRefObsCb += r0.cb * r1.cb;
    sumRefObsCr += r0.cr * r1.cr;
    n++;
  }
  if (n < 32) {
    return { cbScale: 1, cbBias: 0, crScale: 1, crBias: 0 };
  }
  const fit = (sumX: number, sumY: number, sumX2: number, sumXY: number) => {
    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-6) return { scale: 1, bias: (sumY - sumX) / n };
    const scale = (n * sumXY - sumX * sumY) / denom;
    const bias = (sumY - scale * sumX) / n;
    return { scale, bias };
  };
  const cb = fit(sumRefCb, sumObsCb, sumRefCb2, sumRefObsCb);
  const cr = fit(sumRefCr, sumObsCr, sumRefCr2, sumRefObsCr);
  return {
    cbScale: cb.scale,
    cbBias: cb.bias,
    crScale: cr.scale,
    crBias: cr.bias,
  };
}
