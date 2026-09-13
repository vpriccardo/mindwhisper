/**
 * Detect cream paper quad, burgundy wax, bubble, and twine in a camera frame.
 */

import { WARP_W } from "./constants";
import type { SealGeometry } from "./layout";

export type Quad = [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];

export type DetectOk = {
  ok: true;
  geometry: SealGeometry;
  quad: Quad;
  paperFrac: number;
  waxPixels: number;
};

export type DetectFail = {
  ok: false;
  reason: string;
  quad?: Quad;
  paperFrac?: number;
};

export type DetectResult = DetectOk | DetectFail;

/** Soft cream paper (camera / screen tolerant). */
function isCream(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return (
    y > 125 &&
    r > 120 &&
    g > 105 &&
    b > 80 &&
    r + 12 >= g &&
    g + 18 >= b &&
    r - b < 110
  );
}

/**
 * Red-chroma score for burgundy wax. Survives phone-of-screen desaturation
 * better than a hard RGB gate (absolute thresholds go to zero there).
 * Must stay below brown-twine scores so the X is not absorbed into the seal.
 */
function waxScore(r: number, g: number, b: number): number {
  if (r < 30 || isCream(r, g, b)) return 0;
  const rg = r - g;
  const rb = r - b;
  const ratio = r / (g + 1);
  // Strict vs brown twine (~1.3–1.7). Washed seals fall through to soft flood.
  if (ratio < 1.9 || rg < 18 || rb < 8) return 0;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y > 165) return 0;
  return (rg + 0.4 * rb) * (1.12 - Math.min(0.7, y / 230));
}

/** Soft red-excess score for washed frames where absolute ratio collapses. */
function softRedScore(r: number, g: number, b: number): number {
  if (isCream(r, g, b)) return 0;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y > 175 || y < 20 || r < 35) return 0;
  const rg = r - g;
  const rb = r - b;
  if (rg < 8) return 0;
  return rg + 0.35 * rb;
}

/** Strong wax gate used to carve twine away from the seal. */
function isWax(r: number, g: number, b: number): boolean {
  return waxScore(r, g, b) >= 28;
}

/** Brown twine: warmer brown with less red dominance than wax. */
function isTwine(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const rg = r - g;
  const gb = g - b;
  if (waxScore(r, g, b) >= 28 || isCream(r, g, b)) return false;
  const ratio = r / (g + 1);
  return (
    y > 16 &&
    y < 155 &&
    r >= g - 2 &&
    ratio < 2.35 &&
    rg >= 2 &&
    rg <= 55 &&
    gb >= -12 &&
    gb <= 48 &&
    r > b + 2
  );
}

function pix(
  rgba: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
): [number, number, number] {
  const o = (y * w + x) * 4;
  return [rgba[o]!, rgba[o + 1]!, rgba[o + 2]!];
}

function downsampleMask(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  pred: (r: number, g: number, b: number) => boolean,
  dw: number,
): { mask: Uint8Array; dw: number; dh: number; scale: number } {
  const scale = w / dw;
  const dh = Math.max(1, Math.round(h / scale));
  const mask = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.round(x * scale));
      const sy = Math.min(h - 1, Math.round(y * scale));
      const [r, g, b] = pix(rgba, w, sx, sy);
      mask[y * dw + x] = pred(r, g, b) ? 1 : 0;
    }
  }
  return { mask, dw, dh, scale };
}

function creamPoints(mask: Uint8Array, dw: number, dh: number): {
  count: number;
  xs: number[];
  ys: number[];
} {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    xs.push(i % dw);
    ys.push((i / dw) | 0);
  }
  return { count: xs.length, xs, ys };
}

function orientedQuad(
  xs: number[],
  ys: number[],
  scale: number,
): Quad {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    const a = dx * c + dy * s;
    const b = -dx * s + dy * c;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  minA -= 1;
  maxA += 1;
  minB -= 1;
  maxB += 1;
  const corner = (a: number, b: number) => ({
    x: (mx + a * c - b * s) * scale,
    y: (my + a * s + b * c) * scale,
  });
  const pts = [
    corner(minA, minB),
    corner(maxA, minB),
    corner(maxA, maxB),
    corner(minA, maxB),
  ];
  let tl = 0;
  let tr = 0;
  let br = 0;
  let bl = 0;
  let tlS = Infinity;
  let trS = -Infinity;
  let brS = -Infinity;
  let blS = Infinity;
  for (let i = 0; i < 4; i++) {
    const x = pts[i]!.x;
    const y = pts[i]!.y;
    const sum = x + y;
    const dif = x - y;
    if (sum < tlS) {
      tlS = sum;
      tl = i;
    }
    if (dif > trS) {
      trS = dif;
      tr = i;
    }
    if (sum > brS) {
      brS = sum;
      br = i;
    }
    if (dif < blS) {
      blS = dif;
      bl = i;
    }
  }
  return [pts[tl]!, pts[tr]!, pts[br]!, pts[bl]!];
}

function dltHomography(
  src: number[][],
  dst: number[][],
): Float64Array {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [u, v] = dst[i]!;
    A.push([-x!, -y!, -1, 0, 0, 0, x! * u!, y! * u!, u!]);
    A.push([0, 0, 0, -x!, -y!, -1, x! * v!, y! * v!, v!]);
  }
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
  const h = solve8(M, b);
  return new Float64Array([h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1]);
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
  const h = new Float64Array(8);
  for (let i = 0; i < 8; i++) h[i] = A[i]![8]!;
  return h;
}

function applyH(H: Float64Array, x: number, y: number): { x: number; y: number } {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  return {
    x: (H[0]! * x + H[1]! * y + H[2]!) / w,
    y: (H[3]! * x + H[4]! * y + H[5]!) / w,
  };
}

function warpPaper(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  quad: Quad,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const H = dltHomography(
    [
      [0, 0],
      [dw, 0],
      [dw, dh],
      [0, dh],
    ],
    quad.map((p) => [p.x, p.y]),
  );
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const p = applyH(H, x + 0.5, y + 0.5);
      const sx = p.x;
      const sy = p.y;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const o = (y * dw + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
        out[o + 3] = 255;
        continue;
      }
      const fx = sx - x0;
      const fy = sy - y0;
      const sample = (ix: number, iy: number, c: number) =>
        rgba[(iy * w + ix) * 4 + c]!;
      for (let c = 0; c < 3; c++) {
        const v00 = sample(x0, y0, c);
        const v10 = sample(x0 + 1, y0, c);
        const v01 = sample(x0, y0 + 1, c);
        const v11 = sample(x0 + 1, y0 + 1, c);
        out[o + c] = Math.round(
          v00 * (1 - fx) * (1 - fy) +
            v10 * fx * (1 - fy) +
            v01 * (1 - fx) * fy +
            v11 * fx * fy,
        );
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

function collectWaxPixels(
  warped: Uint8ClampedArray,
  dw: number,
  dh: number,
): { xs: number[]; ys: number[] } | null {
  // Prefer absolute burgundy gate — covers the full seal (not just the bright core).
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const [r, g, b] = pix(warped, dw, x, y);
      if (isWax(r, g, b)) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length >= 50) {
    // Absolute gate often keeps only the bright outer shell under wash — expand
    // with soft red so waxR still reaches the bubble. Skip on clean digitals
    // (huge r/g) so brown twine near the knot is not absorbed.
    let ratioSum = 0;
    for (let i = 0; i < xs.length; i++) {
      const [r, g] = pix(warped, dw, xs[i]!, ys[i]!);
      ratioSum += r / (g + 1);
    }
    const meanRatio = ratioSum / xs.length;
    if (meanRatio < 3.2) {
      let cx0 = 0;
      let cy0 = 0;
      for (let i = 0; i < xs.length; i++) {
        cx0 += xs[i]!;
        cy0 += ys[i]!;
      }
      cx0 /= xs.length;
      cy0 /= ys.length;
      let r0 = 0;
      for (let i = 0; i < xs.length; i++) {
        r0 = Math.max(r0, Math.hypot(xs[i]! - cx0, ys[i]! - cy0));
      }
      const growR = Math.max(r0 * 1.4, r0 + 10);
      const thr = 18;
      const seen = new Set(xs.map((x, i) => ys[i]! * dw + x));
      for (
        let y = Math.max(0, Math.floor(cy0 - growR));
        y < Math.min(dh, Math.ceil(cy0 + growR));
        y++
      ) {
        for (
          let x = Math.max(0, Math.floor(cx0 - growR));
          x < Math.min(dw, Math.ceil(cx0 + growR));
          x++
        ) {
          if (Math.hypot(x - cx0, y - cy0) > growR) continue;
          const key = y * dw + x;
          if (seen.has(key)) continue;
          const [r, g, b] = pix(warped, dw, x, y);
          if (softRedScore(r, g, b) < thr) continue;
          seen.add(key);
          xs.push(x);
          ys.push(y);
        }
      }
    }
    return { xs, ys };
  }

  // Washed fallback: flood from the reddest seed so we recover the whole blob
  // instead of keeping only a top-% core (that undersized waxR and missed the bubble).
  let peak = 0;
  let seedX = (dw / 2) | 0;
  let seedY = (dh * 0.58) | 0;
  for (let y = Math.floor(dh * 0.28); y < Math.floor(dh * 0.88); y++) {
    for (let x = Math.floor(dw * 0.22); x < Math.floor(dw * 0.78); x++) {
      const [r, g, b] = pix(warped, dw, x, y);
      const s = softRedScore(r, g, b);
      if (s > peak) {
        peak = s;
        seedX = x;
        seedY = y;
      }
    }
  }
  if (peak < 12) return null;

  const thr = Math.max(18, peak * 0.32);
  const seen = new Uint8Array(dw * dh);
  const qx: number[] = [seedX];
  const qy: number[] = [seedY];
  seen[seedY * dw + seedX] = 1;
  const outX: number[] = [];
  const outY: number[] = [];
  const maxR = Math.max(28, Math.min(dw, dh) * 0.2);
  while (qx.length) {
    const x = qx.pop()!;
    const y = qy.pop()!;
    const [r, g, b] = pix(warped, dw, x, y);
    const s = softRedScore(r, g, b);
    if (s < thr) continue;
    if (Math.hypot(x - seedX, y - seedY) > maxR) continue;
    outX.push(x);
    outY.push(y);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= dw || ny >= dh) continue;
      const i = ny * dw + nx;
      if (seen[i]) continue;
      seen[i] = 1;
      qx.push(nx);
      qy.push(ny);
    }
  }
  if (outX.length < 50) return null;
  return { xs: outX, ys: outY };
}

function measureWaxAndBubble(
  warped: Uint8ClampedArray,
  dw: number,
  dh: number,
):
  | {
      ok: true;
      waxU: number;
      waxV: number;
      waxDiam: number;
      bubbleAngleRad: number;
      bubbleRadFrac: number;
      waxPixels: number;
    }
  | { ok: false; reason: "no_wax" | "no_bubble"; waxHits?: number } {
  const blob = collectWaxPixels(warped, dw, dh);
  if (!blob) return { ok: false, reason: "no_wax", waxHits: 0 };
  const { xs, ys } = blob;

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < xs.length; i++) {
    cx += xs[i]!;
    cy += ys[i]!;
  }
  cx /= xs.length;
  cy /= ys.length;

  // Trim outliers (twine tips that leaked into a soft flood).
  const dist = xs.map((x, i) => Math.hypot(x - cx, ys[i]! - cy));
  const sorted = [...dist].sort((a, b) => a - b);
  const trimR = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.92))]!;
  const inliers: { x: number; y: number }[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (dist[i]! <= trimR * 1.12) inliers.push({ x: xs[i]!, y: ys[i]! });
  }
  if (inliers.length < 40) {
    return { ok: false, reason: "no_wax", waxHits: inliers.length };
  }
  cx = 0;
  cy = 0;
  for (const p of inliers) {
    cx += p.x;
    cy += p.y;
  }
  cx /= inliers.length;
  cy /= inliers.length;
  const radii = inliers
    .map((p) => Math.hypot(p.x - cx, p.y - cy))
    .sort((a, b) => a - b);
  const waxR = radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.995))]!;
  if (waxR < 6) return { ok: false, reason: "no_wax", waxHits: inliers.length };
  const waxDiam = (2 * waxR) / dw;

  // Local luma — bubble is a dark hole relative to nearby wax/paper.
  let localSum = 0;
  let localN = 0;
  const sampleR = Math.max(8, waxR * 1.15);
  for (let y = Math.max(0, Math.floor(cy - sampleR)); y < Math.min(dh, Math.ceil(cy + sampleR)); y++) {
    for (let x = Math.max(0, Math.floor(cx - sampleR)); x < Math.min(dw, Math.ceil(cx + sampleR)); x++) {
      const [r, g, b] = pix(warped, dw, x, y);
      localSum += 0.299 * r + 0.587 * g + 0.114 * b;
      localN++;
    }
  }
  const localMean = localN ? localSum / localN : 80;
  const holeLum = Math.min(110, Math.max(36, localMean * 0.58));

  // Relative darkness in the annulus (survives wash when absolute luma rises).
  const annulus: { x: number; y: number; lum: number; rg: number }[] = [];
  const rMax = waxR * 0.84;
  const rMin = waxR * 0.12;
  for (let y = Math.max(0, Math.floor(cy - rMax)); y < Math.min(dh, Math.ceil(cy + rMax)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rMax)); x < Math.min(dw, Math.ceil(cx + rMax)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < rMin || d > rMax) continue;
      const [r, g, b] = pix(warped, dw, x, y);
      if (isWax(r, g, b) || softRedScore(r, g, b) >= 28) continue;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      annulus.push({ x, y, lum, rg: r - g });
    }
  }
  if (annulus.length < 8) {
    return { ok: false, reason: "no_bubble", waxHits: inliers.length };
  }
  const sortedAnn = [...annulus].sort((a, b) => a.lum - b.lum);
  const lums = sortedAnn.map((p) => p.lum);
  // Annulus is already non-wax; under wash it is mostly the bubble, so median≈bubble
  // and a median*0.92 clamp would exclude everything. Take the darkest pocket.
  const cutIdx = Math.max(5, Math.floor(sortedAnn.length * 0.22));
  const darkCut = Math.min(localMean * 0.88, lums[cutIdx]! + 5);
  const holes = sortedAnn
    .slice(0, Math.max(cutIdx + 1, Math.floor(sortedAnn.length * 0.28)))
    .filter((p) => p.lum <= darkCut && p.rg < 48);
  if (holes.length < 5) {
    return { ok: false, reason: "no_bubble", waxHits: inliers.length };
  }
  let bx = 0;
  let by = 0;
  for (const p of holes) {
    bx += p.x;
    by += p.y;
  }
  bx /= holes.length;
  by /= holes.length;
  const nWax = inliers.length;
  const nHole = holes.length;
  cx = (cx * nWax + bx * nHole) / (nWax + nHole);
  cy = (cy * nWax + by * nHole) / (nWax + nHole);
  const bubbleRadFrac = Math.hypot(bx - cx, by - cy) / waxR;
  const bubbleAngleRad = Math.atan2(by - cy, bx - cx);
  return {
    ok: true,
    waxU: (cx + 0.5) / dw,
    waxV: (cy + 0.5) / dh,
    waxDiam,
    bubbleAngleRad,
    bubbleRadFrac,
    waxPixels: inliers.length,
  };
}

function measureTwine(
  warped: Uint8ClampedArray,
  waxU: number,
  waxV: number,
  waxDiam: number,
  dw: number,
  dh: number,
): { twineU: number; twineV: number; twineAngleDeg: number } | null {
  const wx = waxU * dw;
  const wy = waxV * dh;
  const wr = (waxDiam * dw) / 2;
  const pts: { x: number; y: number }[] = [];
  for (let y = 2; y < dh - 2; y += 1) {
    for (let x = 2; x < dw - 2; x += 1) {
      if (Math.hypot(x - wx, y - wy) < wr * 1.05) continue;
      const [r, g, b] = pix(warped, dw, x, y);
      if (isTwine(r, g, b)) pts.push({ x, y });
    }
  }
  if (pts.length < 24) return null;

  const fitLine = (
    pool: { x: number; y: number }[],
  ): { inliers: { x: number; y: number }[]; ang: number } | null => {
    if (pool.length < 12) return null;
    let best: { x: number; y: number }[] = [];
    let bestAng = 0;
    for (let t = 0; t < 120; t++) {
      const a = pool[(t * 17) % pool.length]!;
      const b = pool[(t * 29 + 3) % pool.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 6) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const inliers: { x: number; y: number }[] = [];
      const thr = Math.max(2.8, dw * 0.016);
      for (const p of pool) {
        if (Math.abs((p.x - a.x) * nx + (p.y - a.y) * ny) <= thr) inliers.push(p);
      }
      if (inliers.length > best.length) {
        best = inliers;
        bestAng = Math.atan2(dy, dx);
      }
    }
    if (best.length < 10) return null;
    return { inliers: best, ang: bestAng };
  };

  const l1 = fitLine(pts);
  if (!l1) return null;
  const inlierSet = new Set(l1.inliers);
  const remain = pts.filter((p) => !inlierSet.has(p));
  const l2 = fitLine(remain);
  if (!l2) return null;

  const norm = (a: number) => {
    let x = a;
    while (x < 0) x += Math.PI;
    while (x >= Math.PI) x -= Math.PI;
    return x;
  };
  const a1 = norm(l1.ang);
  const a2 = norm(l2.ang);
  let delta = Math.abs(a1 - a2);
  if (delta > Math.PI / 2) delta = Math.PI - delta;
  const theta = (delta / 2) * (180 / Math.PI);

  const fit = (ptsIn: { x: number; y: number }[]) => {
    let mx = 0;
    let my = 0;
    for (const p of ptsIn) {
      mx += p.x;
      my += p.y;
    }
    mx /= ptsIn.length;
    my /= ptsIn.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of ptsIn) {
      const dx = p.x - mx;
      const dy = p.y - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { mx, my, ang };
  };
  const f1 = fit(l1.inliers);
  const f2 = fit(l2.inliers);
  const d1x = Math.cos(f1.ang);
  const d1y = Math.sin(f1.ang);
  const d2x = Math.cos(f2.ang);
  const d2y = Math.sin(f2.ang);
  const den = d1x * d2y - d1y * d2x;
  let ix = (f1.mx + f2.mx) / 2;
  let iy = (f1.my + f2.my) / 2;
  if (Math.abs(den) > 1e-6) {
    const t = ((f2.mx - f1.mx) * d2y - (f2.my - f1.my) * d2x) / den;
    ix = f1.mx + t * d1x;
    iy = f1.my + t * d1y;
  }
  return {
    twineU: (ix + 0.5) / dw,
    twineV: (iy + 0.5) / dh,
    twineAngleDeg: theta,
  };
}

function quadAspect(q: Quad): number {
  const top = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const bot = Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y);
  const left = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
  const right = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
  const w = (top + bot) / 2;
  const h = (left + right) / 2;
  return w / Math.max(1, h);
}

export function detectSealGeometry(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): DetectResult {
  const creamDw = Math.min(480, Math.max(160, width));
  const cream = downsampleMask(rgba, width, height, isCream, creamDw);
  const blob = creamPoints(cream.mask, cream.dw, cream.dh);
  const paperFrac = blob.count / (cream.dw * cream.dh);
  if (blob.count < 80) {
    return { ok: false, reason: "no_paper", paperFrac };
  }

  const quad = orientedQuad(blob.xs, blob.ys, cream.scale);

  const aspect = quadAspect(quad);
  const dw = WARP_W;
  const dh = Math.max(160, Math.round(dw / aspect));
  const warped = warpPaper(rgba, width, height, quad, dw, dh);
  const wax = measureWaxAndBubble(warped, dw, dh);
  if (!wax.ok) {
    return {
      ok: false,
      reason:
        wax.reason === "no_wax"
          ? `no_wax:${wax.waxHits ?? 0}`
          : `no_bubble:${wax.waxHits ?? 0}`,
      quad,
      paperFrac,
    };
  }
  const twine = measureTwine(warped, wax.waxU, wax.waxV, wax.waxDiam, dw, dh);
  if (!twine) return { ok: false, reason: "no_twine", quad, paperFrac };

  // Cream OBB / warp + phone wash: a small negative V bias recentres waxY/twineOff.
  const V_BIAS = -0.002;
  return {
    ok: true,
    geometry: {
      waxU: wax.waxU,
      waxV: wax.waxV + V_BIAS,
      waxDiam: wax.waxDiam,
      bubbleAngleRad: wax.bubbleAngleRad,
      bubbleRadFrac: wax.bubbleRadFrac,
      twineAngleDeg: twine.twineAngleDeg,
      twineU: twine.twineU,
      twineV: twine.twineV + V_BIAS,
    },
    quad,
    paperFrac,
    waxPixels: wax.waxPixels,
  };
}
