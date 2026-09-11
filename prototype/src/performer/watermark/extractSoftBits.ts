/**
 * Soft-bit extraction from a rectified canonical-size frame.
 */

import {
  BIT_COUNT,
  GRID_H,
  GRID_W,
  type EligibilityMask,
} from "../../shared/watermarkBasis";
import { srgbToYCbCr } from "../../shared/ycbcr";
import { estimateChromaAffine } from "./radiometricNormalize";

export type ExtractResult = {
  soft: Float64Array;
  noise: Float64Array;
  quality: number;
  validCarrierPct: number;
  residualChromaRms: number;
  avgAbsSoft: number;
  affine: {
    cbScale: number;
    cbBias: number;
    crScale: number;
    crBias: number;
  };
  glare: number;
  extractMs: number;
};

/**
 * Local high-pass: subtract box-blur residual (scale > one watermark cell).
 */
function highPass(field: Float32Array, w: number, h: number, radius: number): Float32Array {
  const out = new Float32Array(field.length);
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += field[y * w + x]!;
      integral[(y + 1) * (w + 1) + (x + 1)] =
        integral[y * (w + 1) + (x + 1)]! + row;
    }
  }
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    const A = integral[y0 * (w + 1) + x0]!;
    const B = integral[y0 * (w + 1) + x1]!;
    const C = integral[y1 * (w + 1) + x0]!;
    const D = integral[y1 * (w + 1) + x1]!;
    return D - B - C + A;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const y0 = Math.max(0, y - radius);
      const x1 = Math.min(w, x + radius + 1);
      const y1 = Math.min(h, y + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = box(x0, y0, x1, y1) / Math.max(1, area);
      out[y * w + x] = field[y * w + x]! - mean;
    }
  }
  return out;
}

export function extractSoftBitsFromRectified(input: {
  cleanRgba: Uint8ClampedArray;
  observedRgba: Uint8ClampedArray;
  width: number;
  height: number;
  valid: Uint8Array;
  mask: EligibilityMask;
  basisFields: Float32Array[];
}): ExtractResult {
  const t0 = performance.now();
  const { cleanRgba, observedRgba, width, height, valid, mask, basisFields } =
    input;
  const affine = estimateChromaAffine(
    cleanRgba,
    observedRgba,
    width,
    height,
    valid,
  );

  const residualFull = new Float32Array(width * height);
  let validCount = 0;
  let glare = 0;
  let residualSum2 = 0;
  for (let p = 0; p < width * height; p++) {
    if (!valid[p]) {
      residualFull[p] = 0;
      continue;
    }
    validCount++;
    const o = p * 4;
    const ref = srgbToYCbCr(cleanRgba[o]!, cleanRgba[o + 1]!, cleanRgba[o + 2]!);
    const obs = srgbToYCbCr(
      observedRgba[o]!,
      observedRgba[o + 1]!,
      observedRgba[o + 2]!,
    );
    if (obs.y > 250) glare++;
    const mappedCb = affine.cbScale * ref.cb + affine.cbBias;
    const mappedCr = affine.crScale * ref.cr + affine.crBias;
    const dCb = obs.cb - mappedCb;
    const dCr = obs.cr - mappedCr;
    const r = (dCb - dCr) / 2;
    residualFull[p] = r;
    residualSum2 += r * r;
  }

  const cellPx = width / GRID_W;
  const hp = highPass(residualFull, width, height, Math.max(2, Math.round(cellPx * 1.5)));

  const residual = new Float32Array(GRID_W * GRID_H);
  const weights = new Float32Array(GRID_W * GRID_H);
  const cellW = width / GRID_W;
  const cellH = height / GRID_H;

  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const gi = gy * GRID_W + gx;
      const mw = mask.weights[gi] ?? 0;
      if (mw <= 0) continue;
      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.floor((gx + 1) * cellW);
      const y1 = Math.floor((gy + 1) * cellH);
      let acc = 0;
      let wAcc = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * width + x;
          if (!valid[p]) continue;
          acc += hp[p]!;
          wAcc += 1;
        }
      }
      if (wAcc > 0) {
        residual[gi] = acc / wAcc;
        weights[gi] = mw * (wAcc / ((x1 - x0) * (y1 - y0)));
      }
    }
  }

  const soft = new Float64Array(BIT_COUNT);
  const noise = new Float64Array(BIT_COUNT);
  let absSum = 0;
  for (let b = 0; b < BIT_COUNT; b++) {
    const { corr, rms } = weightedCorr(residual, basisFields[b]!, weights);
    soft[b] = corr;
    noise[b] = Math.max(0.05, rms);
    absSum += Math.abs(corr);
  }

  const coverage = validCount / Math.max(1, width * height);
  const glareFrac = glare / Math.max(1, validCount);
  const quality = Math.max(
    0,
    Math.min(1, coverage * 1.2) * (1 - Math.min(1, glareFrac * 3)),
  );

  return {
    soft,
    noise,
    quality,
    validCarrierPct: coverage * 100,
    residualChromaRms: Math.sqrt(residualSum2 / Math.max(1, validCount)),
    avgAbsSoft: absSum / BIT_COUNT,
    affine: {
      cbScale: affine.cbScale,
      cbBias: affine.cbBias,
      crScale: affine.crScale,
      crBias: affine.crBias,
    },
    glare: glareFrac,
    extractMs: performance.now() - t0,
  };
}

function weightedCorr(
  residual: Float32Array,
  basis: Float32Array,
  weights: Float32Array,
): { corr: number; rms: number } {
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
  if (wSum <= 0) return { corr: 0, rms: 1 };
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
  const corr = denom < 1e-12 ? 0 : num / denom;
  const rms = Math.sqrt(dr / wSum);
  return { corr, rms };
}
