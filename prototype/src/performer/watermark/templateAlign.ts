/**
 * Template detection / alignment for Hidden envelope.
 *
 * Live camera path requires a verified OpenCV runtime and uses:
 *   Searching → ORB + RANSAC (throttled)
 *   Tracking  → findTransformECC (no ORB)
 * followed by cv.warpPerspective (true projective) + luminance ECC refine.
 *
 * Pure-JS NCC (`alignIdentityOrNcc`) remains for isolated unit tests only and
 * must never be called from the live camera worker path.
 */

import {
  CANONICAL_HEIGHT,
  CANONICAL_WIDTH,
} from "../../shared/watermarkBasis";

export type AlignResult = {
  ok: boolean;
  reason: string;
  /** Rectified RGBA at canonical size */
  rectified: Uint8ClampedArray | null;
  valid: Uint8Array | null;
  inliers: number;
  inlierRatio: number;
  reprojError: number;
  areaFraction: number;
  sharpness: number;
  quality: number;
  quad?: { x: number; y: number }[];
  alignPath: "orb_search" | "ecc_track" | "none";
  alignMode: "searching" | "tracking";
  projectedHeightPx: number;
  /** 3×3 row-major: maps canonical → full-frame coordinates */
  HCanonToFrame?: Float64Array | null;
};

export type AlignContext = {
  refGray: Float32Array;
  refRgba: Uint8ClampedArray;
  refWidth: number;
  refHeight: number;
  /** OpenCV module — required for live alignment */
  cv: any | null;
  orbRefDescriptors?: any;
  orbRefKeypoints?: any;
  refGrayMat?: any;
  mode: "searching" | "tracking";
  /** Maps canonical → full-frame (row-major 9) */
  lastHCanonToFrame: Float64Array | null;
  lastQuad: { x: number; y: number }[] | null;
  lastTrackOkAt: number;
  lastSearchAt: number;
  searchIntervalMs: number;
  trackLossMs: number;
  searchFrameCount: number;
  trackFrameCount: number;
  lastAlignPath: "orb_search" | "ecc_track" | "none";
  liveMode: boolean;
};

const ORB_FEATURES_SEARCH = 500;
const MIN_MATCHES = 18;
const MIN_INLIERS = 18;
const MIN_INLIER_RATIO = 0.35;
const MIN_AREA_FRACTION = 0.05;
const ECC_TRACK_ITERS = 20;
const ECC_REFINE_ITERS = 25;
const SEARCH_LONG_EDGE = 640;

export function rgbaToGray(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    g[i] = 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
  }
  return g;
}

function laplacianVar(gray: Float32Array, w: number, h: number): number {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v =
        -gray[(y - 1) * w + x]! -
        gray[y * w + (x - 1)]! -
        gray[y * w + (x + 1)]! -
        gray[(y + 1) * w + x]! +
        4 * gray[y * w + x]!;
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

function fail(
  reason: string,
  ctx: AlignContext,
  extras: Partial<AlignResult> = {},
): AlignResult {
  return {
    ok: false,
    reason,
    rectified: null,
    valid: null,
    inliers: 0,
    inlierRatio: 0,
    reprojError: 0,
    areaFraction: 0,
    sharpness: 0,
    quality: 0,
    alignPath: extras.alignPath ?? "none",
    alignMode: ctx.mode,
    projectedHeightPx: extras.projectedHeightPx ?? 0,
    quad: extras.quad,
    HCanonToFrame: null,
    ...extras,
  };
}

function quadArea(q: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += q[i]!.x * q[j]!.y - q[j]!.x * q[i]!.y;
  }
  return Math.abs(a) / 2;
}

function projectedHeight(q: { x: number; y: number }[]): number {
  const top = (dist(q[0]!, q[1]!) + dist(q[3]!, q[2]!)) / 2;
  const side = (dist(q[0]!, q[3]!) + dist(q[1]!, q[2]!)) / 2;
  return Math.max(top, side) > 0 ? side : 0;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function isConvexQuad(q: { x: number; y: number }[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const dx1 = q[(i + 1) % 4]!.x - q[i]!.x;
    const dy1 = q[(i + 1) % 4]!.y - q[i]!.y;
    const dx2 = q[(i + 2) % 4]!.x - q[(i + 1) % 4]!.x;
    const dy2 = q[(i + 2) % 4]!.y - q[(i + 1) % 4]!.y;
    const cross = dx1 * dy2 - dy1 * dx2;
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
  }
  return true;
}

function matToRowMajor9(cv: any, H: any): Float64Array {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = H.doubleAt(r, c);
    }
  }
  return out;
}

function rowMajor9ToMat(cv: any, H: Float64Array): any {
  return cv.matFromArray(3, 3, cv.CV_64F, Array.from(H));
}

function applyH(
  H: Float64Array,
  x: number,
  y: number,
): { x: number; y: number } {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  const inv = w === 0 ? 0 : 1 / w;
  return {
    x: (H[0]! * x + H[1]! * y + H[2]!) * inv,
    y: (H[3]! * x + H[4]! * y + H[5]!) * inv,
  };
}

function quadFromHCanonToFrame(H: Float64Array): { x: number; y: number }[] {
  return [
    applyH(H, 0, 0),
    applyH(H, CANONICAL_WIDTH, 0),
    applyH(H, CANONICAL_WIDTH, CANONICAL_HEIGHT),
    applyH(H, 0, CANONICAL_HEIGHT),
  ];
}

function ensureOrbReference(ctx: AlignContext): void {
  const cv = ctx.cv;
  if (!cv || ctx.orbRefKeypoints) return;
  const refMat = cv.matFromImageData({
    data: ctx.refRgba,
    width: ctx.refWidth,
    height: ctx.refHeight,
  });
  const refGray = new cv.Mat();
  cv.cvtColor(refMat, refGray, cv.COLOR_RGBA2GRAY);
  const orb = new cv.ORB(ORB_FEATURES_SEARCH);
  const rkp = new cv.KeyPointVector();
  const rdesc = new cv.Mat();
  orb.detectAndCompute(refGray, new cv.Mat(), rkp, rdesc);
  ctx.orbRefKeypoints = rkp;
  ctx.orbRefDescriptors = rdesc;
  ctx.refGrayMat = refGray;
  refMat.delete();
  orb.delete();
}

/**
 * Projective warp via OpenCV warpPerspective.
 * HCanonToFrame maps canonical → full-frame; warpPerspective uses that as dst→src.
 * Border: BORDER_CONSTANT black. Interpolation: INTER_LINEAR.
 * Valid mask excludes border / out-of-source pixels via projected polygon coverage.
 */
export function warpPerspectiveToCanonical(
  cv: any,
  frameRgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
  HCanonToFrame: Float64Array,
): { rgba: Uint8ClampedArray; valid: Uint8Array } {
  const src = cv.matFromImageData({
    data: frameRgba,
    width: frameW,
    height: frameH,
  });
  const M = rowMajor9ToMat(cv, HCanonToFrame);
  const dst = new cv.Mat();
  const dsize = new cv.Size(CANONICAL_WIDTH, CANONICAL_HEIGHT);
  // Border mode documented: BORDER_CONSTANT (0) — black fill outside source.
  cv.warpPerspective(
    src,
    dst,
    M,
    dsize,
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(0, 0, 0, 255),
  );
  const rgba = new Uint8ClampedArray(dst.data);
  src.delete();
  M.delete();
  dst.delete();

  const valid = validMaskFromHomography(HCanonToFrame, frameW, frameH);
  // Zero invalid pixels so they never participate in chroma correlation.
  for (let i = 0; i < valid.length; i++) {
    if (!valid[i]) {
      const o = i * 4;
      rgba[o] = 0;
      rgba[o + 1] = 0;
      rgba[o + 2] = 0;
      rgba[o + 3] = 255;
    }
  }
  return { rgba, valid };
}

/** Mark pixels whose back-projected source sample lies inside the frame. */
export function validMaskFromHomography(
  HCanonToFrame: Float64Array,
  frameW: number,
  frameH: number,
): Uint8Array {
  const valid = new Uint8Array(CANONICAL_WIDTH * CANONICAL_HEIGHT);
  for (let y = 0; y < CANONICAL_HEIGHT; y++) {
    for (let x = 0; x < CANONICAL_WIDTH; x++) {
      const p = applyH(HCanonToFrame, x + 0.5, y + 0.5);
      const ok =
        p.x >= 0 && p.y >= 0 && p.x < frameW - 1 && p.y < frameH - 1;
      valid[y * CANONICAL_WIDTH + x] = ok ? 1 : 0;
    }
  }
  return valid;
}

/**
 * Pure-JS true projective warp (for unit tests / comparison).
 * Uses the same HCanonToFrame convention as OpenCV warpPerspective.
 */
export function projectiveWarpToCanonical(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  HCanonToFrame: Float64Array,
): { rgba: Uint8ClampedArray; valid: Uint8Array } {
  const dw = CANONICAL_WIDTH;
  const dh = CANONICAL_HEIGHT;
  const rgba = new Uint8ClampedArray(dw * dh * 4);
  const valid = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const p = applyH(HCanonToFrame, x + 0.5, y + 0.5);
      const di = (y * dw + x) * 4;
      const pi = y * dw + x;
      if (p.x < 0 || p.y < 0 || p.x >= sw - 1 || p.y >= sh - 1) {
        rgba[di] = 0;
        rgba[di + 1] = 0;
        rgba[di + 2] = 0;
        rgba[di + 3] = 255;
        valid[pi] = 0;
        continue;
      }
      const x0 = Math.floor(p.x);
      const y0 = Math.floor(p.y);
      const fx = p.x - x0;
      const fy = p.y - y0;
      for (let c = 0; c < 3; c++) {
        const i00 = (y0 * sw + x0) * 4 + c;
        const i10 = (y0 * sw + x0 + 1) * 4 + c;
        const i01 = ((y0 + 1) * sw + x0) * 4 + c;
        const i11 = ((y0 + 1) * sw + x0 + 1) * 4 + c;
        rgba[di + c] = Math.round(
          src[i00]! * (1 - fx) * (1 - fy) +
            src[i10]! * fx * (1 - fy) +
            src[i01]! * (1 - fx) * fy +
            src[i11]! * fx * fy,
        );
      }
      rgba[di + 3] = 255;
      valid[pi] = 1;
    }
  }
  return { rgba, valid };
}

/** Legacy bilinear quad warp — retained for comparison tests only. */
export function warpQuadBilinearToCanonical(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  quad: { x: number; y: number }[],
): { rgba: Uint8ClampedArray; valid: Uint8Array } {
  const dw = CANONICAL_WIDTH;
  const dh = CANONICAL_HEIGHT;
  const rgba = new Uint8ClampedArray(dw * dh * 4);
  const valid = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const v = (y + 0.5) / dh;
    for (let x = 0; x < dw; x++) {
      const u = (x + 0.5) / dw;
      const topX = quad[0]!.x * (1 - u) + quad[1]!.x * u;
      const topY = quad[0]!.y * (1 - u) + quad[1]!.y * u;
      const botX = quad[3]!.x * (1 - u) + quad[2]!.x * u;
      const botY = quad[3]!.y * (1 - u) + quad[2]!.y * u;
      const sx = topX * (1 - v) + botX * v;
      const sy = topY * (1 - v) + botY * v;
      const p = y * dw + x;
      const o = p * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        rgba[o] = 0;
        rgba[o + 1] = 0;
        rgba[o + 2] = 0;
        rgba[o + 3] = 255;
        valid[p] = 0;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const i00 = (y0 * sw + x0) * 4 + c;
        const i10 = (y0 * sw + x0 + 1) * 4 + c;
        const i01 = ((y0 + 1) * sw + x0) * 4 + c;
        const i11 = ((y0 + 1) * sw + x0 + 1) * 4 + c;
        rgba[o + c] = Math.round(
          src[i00]! * (1 - fx) * (1 - fy) +
            src[i10]! * fx * (1 - fy) +
            src[i01]! * (1 - fx) * fy +
            src[i11]! * fx * fy,
        );
      }
      rgba[o + 3] = 255;
      valid[p] = 1;
    }
  }
  return { rgba, valid };
}

/** Build HCanonToFrame from a frame-space quadrilateral (TL,TR,BR,BL). */
export function homographyFromQuad(
  quad: { x: number; y: number }[],
): Float64Array {
  // DLT: map canonical corners → quad
  const src = [
    [0, 0],
    [CANONICAL_WIDTH, 0],
    [CANONICAL_WIDTH, CANONICAL_HEIGHT],
    [0, CANONICAL_HEIGHT],
  ];
  const dst = quad.map((p) => [p.x, p.y]);
  return dltHomography(src, dst);
}

function dltHomography(
  src: number[][],
  dst: number[][],
): Float64Array {
  // Solve Ah = 0 for 8 DOF homography (h33=1).
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [u, v] = dst[i]!;
    A.push([-x!, -y!, -1, 0, 0, 0, x! * u!, y! * u!, u!]);
    A.push([0, 0, 0, -x!, -y!, -1, x! * v!, y! * v!, v!]);
  }
  // Gaussian elimination on 8x9 (fix h33=1 via nullspace SVD-lite: use last column).
  // Use simple least-squares via normal equations on 8 unknowns with h8=1.
  const M = Array.from({ length: 8 }, () => new Float64Array(8).fill(0));
  const b = new Float64Array(8);
  for (let r = 0; r < 8; r++) {
    const row = A[r]!;
    for (let c = 0; c < 8; c++) {
      for (let k = 0; k < 8; k++) {
        M[c]![k]! += row[c]! * row[k]!;
      }
      b[c]! -= row[c]! * row[8]!;
    }
  }
  // Solve M h = b
  const h = solve8(M, b);
  return new Float64Array([
    h[0]!,
    h[1]!,
    h[2]!,
    h[3]!,
    h[4]!,
    h[5]!,
    h[6]!,
    h[7]!,
    1,
  ]);
}

function solve8(M: Float64Array[], b: Float64Array): Float64Array {
  const n = 8;
  const A = M.map((row, i) => {
    const r = new Float64Array(n + 1);
    r.set(row);
    r[n] = b[i]!;
    return r;
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
    }
    const tmp = A[col]!;
    A[col] = A[pivot]!;
    A[pivot] = tmp;
    const div = A[col]![col]!;
    if (Math.abs(div) < 1e-12) continue;
    for (let c = col; c <= n; c++) A[col]![c]! /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r]![col]!;
      for (let c = col; c <= n; c++) A[r]![c]! -= f * A[col]![c]!;
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = A[i]![n]!;
  return x;
}

function refineWithEcc(
  cv: any,
  ctx: AlignContext,
  rectified: Uint8ClampedArray,
): { rgba: Uint8ClampedArray; eccOk: boolean } {
  try {
    const tpl = cv.matFromImageData({
      data: ctx.refRgba,
      width: ctx.refWidth,
      height: ctx.refHeight,
    });
    const tplGray = new cv.Mat();
    cv.cvtColor(tpl, tplGray, cv.COLOR_RGBA2GRAY);
    const inp = cv.matFromImageData({
      data: rectified,
      width: CANONICAL_WIDTH,
      height: CANONICAL_HEIGHT,
    });
    const inpGray = new cv.Mat();
    cv.cvtColor(inp, inpGray, cv.COLOR_RGBA2GRAY);
    // 2×3 identity warp (EUCLIDEAN / AFFINE init)
    const warp = cv.matFromArray(2, 3, cv.CV_32F, [1, 0, 0, 0, 1, 0]);
    const criteria = new cv.TermCriteria(
      cv.TERM_CRITERIA_EPS + cv.TERM_CRITERIA_COUNT,
      ECC_REFINE_ITERS,
      1e-4,
    );
    let cc = 0;
    try {
      cc = cv.findTransformECC(
        tplGray,
        inpGray,
        warp,
        cv.MOTION_EUCLIDEAN,
        criteria,
      );
    } catch {
      tpl.delete();
      tplGray.delete();
      inp.delete();
      inpGray.delete();
      warp.delete();
      return { rgba: rectified, eccOk: false };
    }
    if (!(cc > 0.5)) {
      tpl.delete();
      tplGray.delete();
      inp.delete();
      inpGray.delete();
      warp.delete();
      return { rgba: rectified, eccOk: false };
    }
    const warped = new cv.Mat();
    cv.warpAffine(
      inp,
      warped,
      warp,
      new cv.Size(CANONICAL_WIDTH, CANONICAL_HEIGHT),
      cv.INTER_LINEAR + cv.WARP_INVERSE_MAP,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 255),
    );
    const out = new Uint8ClampedArray(warped.data);
    tpl.delete();
    tplGray.delete();
    inp.delete();
    inpGray.delete();
    warp.delete();
    warped.delete();
    return { rgba: out, eccOk: true };
  } catch {
    return { rgba: rectified, eccOk: false };
  }
}

function finalizeAligned(
  ctx: AlignContext,
  frameRgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
  HCanonToFrame: Float64Array,
  meta: {
    inliers: number;
    inlierRatio: number;
    alignPath: "orb_search" | "ecc_track";
    nowMs: number;
  },
): AlignResult {
  const cv = ctx.cv!;
  const quad = quadFromHCanonToFrame(HCanonToFrame);
  const area = quadArea(quad);
  const areaFraction = area / (frameW * frameH);
  const heightPx = projectedHeight(quad);
  if (areaFraction < MIN_AREA_FRACTION || !isConvexQuad(quad)) {
    return fail("quad_reject", ctx, {
      alignPath: meta.alignPath,
      projectedHeightPx: heightPx,
      quad,
    });
  }

  let { rgba, valid } = warpPerspectiveToCanonical(
    cv,
    frameRgba,
    frameW,
    frameH,
    HCanonToFrame,
  );
  const refined = refineWithEcc(cv, ctx, rgba);
  rgba = refined.rgba;
  // Recompute valid from H (ECC is small; keep projective coverage mask)
  const g = rgbaToGray(rgba, CANONICAL_WIDTH, CANONICAL_HEIGHT);
  const sharpness = laplacianVar(g, CANONICAL_WIDTH, CANONICAL_HEIGHT);
  const quality = Math.min(
    1,
    meta.inlierRatio *
      Math.min(1, areaFraction / 0.08) *
      Math.min(1, sharpness / 40),
  );

  ctx.mode = "tracking";
  ctx.lastHCanonToFrame = HCanonToFrame;
  ctx.lastQuad = quad;
  ctx.lastTrackOkAt = meta.nowMs;
  ctx.lastAlignPath = meta.alignPath;
  if (meta.alignPath === "orb_search") ctx.searchFrameCount++;
  else ctx.trackFrameCount++;

  return {
    ok: true,
    reason: "ok",
    rectified: rgba,
    valid,
    inliers: meta.inliers,
    inlierRatio: meta.inlierRatio,
    reprojError: 3,
    areaFraction,
    sharpness,
    quality,
    quad,
    alignPath: meta.alignPath,
    alignMode: "tracking",
    projectedHeightPx: heightPx,
    HCanonToFrame,
  };
}

function orbSearch(
  ctx: AlignContext,
  frameRgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
  nowMs: number,
): AlignResult {
  const cv = ctx.cv!;
  ensureOrbReference(ctx);
  ctx.lastSearchAt = nowMs;

  const long = Math.max(frameW, frameH);
  const scale = long > SEARCH_LONG_EDGE ? SEARCH_LONG_EDGE / long : 1;
  const sw = Math.max(1, Math.round(frameW * scale));
  const sh = Math.max(1, Math.round(frameH * scale));
  const small = resizeRgba(frameRgba, frameW, frameH, sw, sh);

  const src = cv.matFromImageData({ data: small, width: sw, height: sh });
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const orb = new cv.ORB(ORB_FEATURES_SEARCH);
  const kp = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const emptyMask = new cv.Mat();
  orb.detectAndCompute(gray, emptyMask, kp, desc);
  emptyMask.delete();

  if (kp.size() < MIN_MATCHES || desc.rows < MIN_MATCHES) {
    src.delete();
    gray.delete();
    kp.delete();
    desc.delete();
    orb.delete();
    ctx.mode = "searching";
    return fail("few_keypoints", ctx, { alignPath: "orb_search" });
  }

  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knn = new cv.DMatchVectorVector();
  matcher.knnMatch(desc, ctx.orbRefDescriptors, knn, 2);

  const goodSrc: number[] = [];
  const goodDst: number[] = [];
  for (let i = 0; i < knn.size(); i++) {
    const pair = knn.get(i);
    if (pair.size() < 2) continue;
    const m = pair.get(0);
    const n = pair.get(1);
    if (m.distance < 0.75 * n.distance) {
      const qp = kp.get(m.queryIdx).pt;
      const tp = ctx.orbRefKeypoints.get(m.trainIdx).pt;
      // Scale small-frame coords → full frame; ref already canonical.
      goodSrc.push(qp.x / scale, qp.y / scale);
      goodDst.push(tp.x, tp.y);
    }
  }

  let result: AlignResult;
  if (goodSrc.length / 2 < MIN_MATCHES) {
    result = fail("few_matches", ctx, { alignPath: "orb_search" });
  } else {
    // Homography maps frame → canonical (src=frame, dst=ref)
    const srcPts = cv.matFromArray(goodSrc.length / 2, 1, cv.CV_32FC2, goodSrc);
    const dstPts = cv.matFromArray(goodDst.length / 2, 1, cv.CV_32FC2, goodDst);
    const mask = new cv.Mat();
    const Hfc = cv.findHomography(srcPts, dstPts, cv.RANSAC, 3, mask);
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) {
      if (mask.ucharAt(i, 0)) inliers++;
    }
    const inlierRatio = inliers / (goodSrc.length / 2);
    if (Hfc.empty() || inliers < MIN_INLIERS || inlierRatio < MIN_INLIER_RATIO) {
      result = fail("homography_reject", ctx, { alignPath: "orb_search" });
      Hfc.delete();
    } else {
      const inv = new cv.Mat();
      cv.invert(Hfc, inv);
      const HCanonToFrame = matToRowMajor9(cv, inv);
      inv.delete();
      Hfc.delete();
      // Cheap projected-area / convexity checks happen in finalizeAligned
      result = finalizeAligned(ctx, frameRgba, frameW, frameH, HCanonToFrame, {
        inliers,
        inlierRatio,
        alignPath: "orb_search",
        nowMs,
      });
    }
    srcPts.delete();
    dstPts.delete();
    mask.delete();
  }

  src.delete();
  gray.delete();
  kp.delete();
  desc.delete();
  knn.delete();
  matcher.delete();
  orb.delete();

  if (!result.ok) ctx.mode = "searching";
  return result;
}

function eccTrack(
  ctx: AlignContext,
  frameRgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
  nowMs: number,
): AlignResult {
  const cv = ctx.cv!;
  if (!ctx.lastHCanonToFrame) {
    return fail("no_track_state", ctx, { alignPath: "ecc_track" });
  }

  // Downscale for fast ECC
  const long = Math.max(frameW, frameH);
  const scale = long > SEARCH_LONG_EDGE ? SEARCH_LONG_EDGE / long : 1;
  const sw = Math.max(1, Math.round(frameW * scale));
  const sh = Math.max(1, Math.round(frameH * scale));
  const small = resizeRgba(frameRgba, frameW, frameH, sw, sh);

  // Template: further downscale reference for speed
  const tH = 128;
  const tW = Math.round((CANONICAL_WIDTH / CANONICAL_HEIGHT) * tH);
  const refSmall = resizeRgba(ctx.refRgba, ctx.refWidth, ctx.refHeight, tW, tH);

  const tpl = cv.matFromImageData({ data: refSmall, width: tW, height: tH });
  const tplGray = new cv.Mat();
  cv.cvtColor(tpl, tplGray, cv.COLOR_RGBA2GRAY);

  const inp = cv.matFromImageData({ data: small, width: sw, height: sh });
  const inpGray = new cv.Mat();
  cv.cvtColor(inp, inpGray, cv.COLOR_RGBA2GRAY);

  // Scale HCanonToFrame from full frame to small-search + template size.
  // H_full: canon(768) → frame. We need H_small: templ(tW) → small(sw).
  // x_frame = H_full * x_canon; x_small = scale * x_frame
  // x_canon = (768/tW) * x_templ
  // ⇒ x_small = scale * H_full * S_ct * x_templ
  const sx = CANONICAL_WIDTH / tW;
  const sy = CANONICAL_HEIGHT / tH;
  const Hf = ctx.lastHCanonToFrame;
  // Compose: H_ts = S_scale * H_full * S_canon_from_templ
  const Hts = new Float64Array(9);
  // S_ct = diag(sx, sy, 1)
  const Htmp = new Float64Array(9);
  Htmp[0] = Hf[0]! * sx;
  Htmp[1] = Hf[1]! * sy;
  Htmp[2] = Hf[2]!;
  Htmp[3] = Hf[3]! * sx;
  Htmp[4] = Hf[4]! * sy;
  Htmp[5] = Hf[5]!;
  Htmp[6] = Hf[6]! * sx;
  Htmp[7] = Hf[7]! * sy;
  Htmp[8] = Hf[8]!;
  Hts[0] = scale * Htmp[0]!;
  Hts[1] = scale * Htmp[1]!;
  Hts[2] = scale * Htmp[2]!;
  Hts[3] = scale * Htmp[3]!;
  Hts[4] = scale * Htmp[4]!;
  Hts[5] = scale * Htmp[5]!;
  Hts[6] = Htmp[6]!;
  Hts[7] = Htmp[7]!;
  Hts[8] = Htmp[8]!;

  const warp = rowMajor9ToMat(cv, Hts);
  // findTransformECC needs CV_32F for homography
  const warp32 = new cv.Mat();
  warp.convertTo(warp32, cv.CV_32F);
  warp.delete();

  const criteria = new cv.TermCriteria(
    cv.TERM_CRITERIA_EPS + cv.TERM_CRITERIA_COUNT,
    ECC_TRACK_ITERS,
    1e-3,
  );
  let cc = 0;
  try {
    cc = cv.findTransformECC(
      tplGray,
      inpGray,
      warp32,
      cv.MOTION_HOMOGRAPHY,
      criteria,
    );
  } catch (err) {
    tpl.delete();
    tplGray.delete();
    inp.delete();
    inpGray.delete();
    warp32.delete();
    return fail(
      `ecc_track_fail:${err instanceof Error ? err.message : String(err)}`,
      ctx,
      { alignPath: "ecc_track" },
    );
  }

  tpl.delete();
  tplGray.delete();
  inp.delete();
  inpGray.delete();

  if (!(cc > 0.4)) {
    warp32.delete();
    return fail("ecc_track_low_cc", ctx, { alignPath: "ecc_track" });
  }

  const warp64 = new cv.Mat();
  warp32.convertTo(warp64, cv.CV_64F);
  warp32.delete();
  const HtsOut = matToRowMajor9(cv, warp64);
  warp64.delete();

  // Invert the scale composition to recover H_full:
  // H_ts = S_scale * H_full * S_ct  ⇒  H_full = S_scale^{-1} * H_ts * S_ct^{-1}
  const invScale = 1 / scale;
  const invSx = 1 / sx;
  const invSy = 1 / sy;
  // First H1 = H_ts * S_ct^{-1}
  const H1 = new Float64Array(9);
  H1[0] = HtsOut[0]! * invSx;
  H1[1] = HtsOut[1]! * invSy;
  H1[2] = HtsOut[2]!;
  H1[3] = HtsOut[3]! * invSx;
  H1[4] = HtsOut[4]! * invSy;
  H1[5] = HtsOut[5]!;
  H1[6] = HtsOut[6]! * invSx;
  H1[7] = HtsOut[7]! * invSy;
  H1[8] = HtsOut[8]!;
  // H_full = S_scale^{-1} * H1
  const Hfull = new Float64Array(9);
  Hfull[0] = invScale * H1[0]!;
  Hfull[1] = invScale * H1[1]!;
  Hfull[2] = invScale * H1[2]!;
  Hfull[3] = invScale * H1[3]!;
  Hfull[4] = invScale * H1[4]!;
  Hfull[5] = invScale * H1[5]!;
  Hfull[6] = H1[6]!;
  Hfull[7] = H1[7]!;
  Hfull[8] = H1[8]!;

  return finalizeAligned(ctx, frameRgba, frameW, frameH, Hfull, {
    inliers: Math.round(cc * 100),
    inlierRatio: Math.min(1, cc),
    alignPath: "ecc_track",
    nowMs,
  });
}

/**
 * Live alignment — requires OpenCV. Never falls back to JS NCC.
 */
export function alignLive(
  ctx: AlignContext,
  frameRgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
  nowMs: number = performance.now(),
): AlignResult {
  if (!ctx.cv) {
    return fail("opencv_unavailable", ctx);
  }
  if (!ctx.liveMode) {
    return fail("not_live_mode", ctx);
  }

  // Track loss → Searching
  if (
    ctx.mode === "tracking" &&
    ctx.lastTrackOkAt > 0 &&
    nowMs - ctx.lastTrackOkAt > ctx.trackLossMs
  ) {
    ctx.mode = "searching";
    ctx.lastHCanonToFrame = null;
  }

  if (ctx.mode === "tracking" && ctx.lastHCanonToFrame) {
    const tracked = eccTrack(ctx, frameRgba, frameW, frameH, nowMs);
    if (tracked.ok) return tracked;
    // Tracking failed this frame — only ORB-search if interval allows.
    if (nowMs - ctx.lastSearchAt < ctx.searchIntervalMs) {
      return fail(tracked.reason || "track_failed_throttled", ctx, {
        alignPath: "ecc_track",
      });
    }
    ctx.mode = "searching";
    return orbSearch(ctx, frameRgba, frameW, frameH, nowMs);
  }

  // Searching
  if (nowMs - ctx.lastSearchAt < ctx.searchIntervalMs && ctx.lastSearchAt > 0) {
    return fail("search_throttled", ctx, { alignPath: "none" });
  }
  return orbSearch(ctx, frameRgba, frameW, frameH, nowMs);
}

/**
 * @deprecated Live path must use alignLive. Kept for unit tests only.
 */
export function alignWithOpenCV(
  ctx: AlignContext,
  frameRgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
): AlignResult {
  if (!ctx.cv) {
    if (ctx.liveMode) return fail("opencv_unavailable", ctx);
    return alignIdentityOrNcc(ctx, frameRgba, frameW, frameH);
  }
  // Non-live tests with OpenCV: one-shot ORB without throttle.
  const prevInterval = ctx.searchIntervalMs;
  ctx.searchIntervalMs = 0;
  ctx.liveMode = true;
  const result = alignLive(ctx, frameRgba, frameW, frameH, performance.now());
  ctx.searchIntervalMs = prevInterval;
  return result;
}

/** Identity / near-identity path — unit tests only, never live camera. */
export function alignIdentityOrNcc(
  ctx: AlignContext,
  frameRgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
): AlignResult {
  if (ctx.liveMode) {
    return fail("opencv_unavailable", ctx);
  }
  const long = Math.max(frameW, frameH);
  const scale = long > 720 ? 720 / long : 1;
  const sw = Math.max(1, Math.round(frameW * scale));
  const sh = Math.max(1, Math.round(frameH * scale));
  const small = resizeRgba(frameRgba, frameW, frameH, sw, sh);
  const smallGray = rgbaToGray(small, sw, sh);

  const tH = 240;
  const tW = Math.round((CANONICAL_WIDTH / CANONICAL_HEIGHT) * tH);
  const refSmall = resizeRgba(ctx.refRgba, ctx.refWidth, ctx.refHeight, tW, tH);
  const refGray = rgbaToGray(refSmall, tW, tH);

  let best = { score: -1, x: 0, y: 0, scale: 1 };
  for (const sc of [0.7, 0.85, 1.0, 1.15, 1.35, 1.6]) {
    const tw = Math.max(8, Math.round(tW * sc));
    const th = Math.max(8, Math.round(tH * sc));
    if (tw >= sw || th >= sh) continue;
    const templ =
      sc === 1
        ? refGray
        : rgbaToGray(resizeRgba(refSmall, tW, tH, tw, th), tw, th);
    const hit = nccSearch(smallGray, sw, sh, templ, tw, th);
    if (hit.score > best.score) {
      best = { score: hit.score, x: hit.x, y: hit.y, scale: sc };
    }
  }

  if (best.score < 0.35) {
    return fail("template_not_found", ctx);
  }

  const tw = Math.round(tW * best.scale);
  const th = Math.round(tH * best.scale);
  const x0 = best.x / scale;
  const y0 = best.y / scale;
  const x1 = (best.x + tw) / scale;
  const y1 = (best.y + th) / scale;
  const quad = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const H = homographyFromQuad(quad);
  const { rgba, valid } = projectiveWarpToCanonical(frameRgba, frameW, frameH, H);
  const gray = rgbaToGray(rgba, CANONICAL_WIDTH, CANONICAL_HEIGHT);
  const sharpness = laplacianVar(gray, CANONICAL_WIDTH, CANONICAL_HEIGHT);
  const areaFraction = ((x1 - x0) * (y1 - y0)) / (frameW * frameH);
  const quality = Math.max(
    0,
    Math.min(1, best.score) *
      Math.min(1, areaFraction / 0.05) *
      Math.min(1, sharpness / 50),
  );

  return {
    ok: true,
    reason: "ok",
    rectified: rgba,
    valid,
    inliers: Math.round(best.score * 100),
    inlierRatio: best.score,
    reprojError: 0,
    areaFraction,
    sharpness,
    quality,
    quad,
    alignPath: "none",
    alignMode: "searching",
    projectedHeightPx: y1 - y0,
    HCanonToFrame: H,
  };
}

export function resizeRgba(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = src[si + 3]!;
    }
  }
  return out;
}

function nccSearch(
  img: Float32Array,
  iw: number,
  ih: number,
  templ: Float32Array,
  tw: number,
  th: number,
): { score: number; x: number; y: number } {
  let best = -1;
  let bx = 0;
  let by = 0;
  let tMean = 0;
  for (let i = 0; i < templ.length; i++) tMean += templ[i]!;
  tMean /= templ.length;
  let tVar = 0;
  for (let i = 0; i < templ.length; i++) {
    const d = templ[i]! - tMean;
    tVar += d * d;
  }
  if (tVar < 1e-6) return { score: -1, x: 0, y: 0 };

  const step = Math.max(1, Math.floor(Math.min(tw, th) / 16));
  for (let y = 0; y <= ih - th; y += step) {
    for (let x = 0; x <= iw - tw; x += step) {
      let sum = 0;
      let sum2 = 0;
      let dot = 0;
      for (let ty = 0; ty < th; ty += 2) {
        for (let tx = 0; tx < tw; tx += 2) {
          const v = img[(y + ty) * iw + (x + tx)]!;
          const t = templ[ty * tw + tx]!;
          sum += v;
          sum2 += v * v;
          dot += v * (t - tMean);
        }
      }
      const n = Math.ceil(th / 2) * Math.ceil(tw / 2);
      const mean = sum / n;
      const varI = sum2 / n - mean * mean;
      if (varI < 1e-6) continue;
      let tVarSub = 0;
      for (let ty = 0; ty < th; ty += 2) {
        for (let tx = 0; tx < tw; tx += 2) {
          const d = templ[ty * tw + tx]! - tMean;
          tVarSub += d * d;
        }
      }
      const score = dot / Math.sqrt(varI * n * tVarSub);
      if (score > best) {
        best = score;
        bx = x;
        by = y;
      }
    }
  }
  return { score: best, x: bx, y: by };
}

export function buildAlignContext(
  refRgba: Uint8ClampedArray,
  refWidth: number,
  refHeight: number,
  cv: any | null,
  options: { liveMode?: boolean } = {},
): AlignContext {
  const canonical =
    refWidth === CANONICAL_WIDTH && refHeight === CANONICAL_HEIGHT
      ? refRgba
      : resizeRgba(refRgba, refWidth, refHeight, CANONICAL_WIDTH, CANONICAL_HEIGHT);
  return {
    refGray: rgbaToGray(canonical, CANONICAL_WIDTH, CANONICAL_HEIGHT),
    refRgba: canonical,
    refWidth: CANONICAL_WIDTH,
    refHeight: CANONICAL_HEIGHT,
    cv,
    mode: "searching",
    lastHCanonToFrame: null,
    lastQuad: null,
    lastTrackOkAt: 0,
    lastSearchAt: 0,
    searchIntervalMs: 400,
    trackLossMs: 350,
    searchFrameCount: 0,
    trackFrameCount: 0,
    lastAlignPath: "none",
    liveMode: options.liveMode ?? false,
  };
}

export function resetAlignTracking(ctx: AlignContext): void {
  ctx.mode = "searching";
  ctx.lastHCanonToFrame = null;
  ctx.lastQuad = null;
  ctx.lastTrackOkAt = 0;
  ctx.lastSearchAt = 0;
  ctx.lastAlignPath = "none";
}
