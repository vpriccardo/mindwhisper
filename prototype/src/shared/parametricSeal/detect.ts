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

function isCream(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return (
    y > 150 &&
    r > 145 &&
    g > 130 &&
    b > 100 &&
    r + 8 >= g &&
    g + 12 >= b &&
    r - b < 95
  );
}

function isWax(r: number, g: number, b: number): boolean {
  return r >= 44 && r > g + 28 && r > b + 18 && g < 80 && b < 70;
}

function isTwine(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const rg = r - g;
  return y < 120 && y > 30 && rg > 8 && rg < 38 && r > b + 10 && !isWax(r, g, b);
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

function measureWaxAndBubble(
  warped: Uint8ClampedArray,
  dw: number,
  dh: number,
): {
  waxU: number;
  waxV: number;
  waxDiam: number;
  bubbleAngleRad: number;
  bubbleRadFrac: number;
  waxPixels: number;
} | null {
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
  if (xs.length < 80) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < xs.length; i++) {
    cx += xs[i]!;
    cy += ys[i]!;
  }
  cx /= xs.length;
  cy /= ys.length;
  const radii: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    radii.push(Math.hypot(xs[i]! - cx, ys[i]! - cy));
  }
  radii.sort((a, b) => a - b);
  const waxR = radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.995))]!;
  const waxDiam = (2 * waxR) / dw;

  const holes: { x: number; y: number }[] = [];
  const rMax = waxR * 0.78;
  const rMin = waxR * 0.18;
  for (let y = Math.max(0, Math.floor(cy - rMax)); y < Math.min(dh, Math.ceil(cy + rMax)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rMax)); x < Math.min(dw, Math.ceil(cx + rMax)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < rMin || d > rMax) continue;
      const [r, g, b] = pix(warped, dw, x, y);
      if (isWax(r, g, b)) continue;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 70) holes.push({ x, y });
    }
  }
  if (holes.length < 8) return null;
  let bx = 0;
  let by = 0;
  for (const p of holes) {
    bx += p.x;
    by += p.y;
  }
  bx /= holes.length;
  by /= holes.length;
  const nWax = xs.length;
  const nHole = holes.length;
  cx = (cx * nWax + bx * nHole) / (nWax + nHole);
  cy = (cy * nWax + by * nHole) / (nWax + nHole);
  const bubbleRadFrac = Math.hypot(bx - cx, by - cy) / waxR;
  const bubbleAngleRad = Math.atan2(by - cy, bx - cx);
  return {
    waxU: (cx + 0.5) / dw,
    waxV: (cy + 0.5) / dh,
    waxDiam,
    bubbleAngleRad,
    bubbleRadFrac,
    waxPixels: xs.length,
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
  if (pts.length < 40) return null;

  const fitLine = (
    pool: { x: number; y: number }[],
  ): { inliers: { x: number; y: number }[]; ang: number } | null => {
    if (pool.length < 20) return null;
    let best: { x: number; y: number }[] = [];
    let bestAng = 0;
    for (let t = 0; t < 96; t++) {
      const a = pool[(t * 17) % pool.length]!;
      const b = pool[(t * 29 + 3) % pool.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 8) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const inliers: { x: number; y: number }[] = [];
      const thr = Math.max(2.2, dw * 0.012);
      for (const p of pool) {
        if (Math.abs((p.x - a.x) * nx + (p.y - a.y) * ny) <= thr) inliers.push(p);
      }
      if (inliers.length > best.length) {
        best = inliers;
        bestAng = Math.atan2(dy, dx);
      }
    }
    if (best.length < 16) return null;
    return { inliers: best, ang: bestAng };
  };

  const l1 = fitLine(pts);
  if (!l1) return null;
  const remain = pts.filter((p) => !l1.inliers.includes(p));
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
  if (!wax) return { ok: false, reason: "no_wax", quad, paperFrac };
  const twine = measureTwine(warped, wax.waxU, wax.waxV, wax.waxDiam, dw, dh);
  if (!twine) return { ok: false, reason: "no_twine", quad, paperFrac };

  return {
    ok: true,
    geometry: {
      waxU: wax.waxU,
      waxV: wax.waxV,
      waxDiam: wax.waxDiam,
      bubbleAngleRad: wax.bubbleAngleRad,
      bubbleRadFrac: wax.bubbleRadFrac,
      twineAngleDeg: twine.twineAngleDeg,
      twineU: twine.twineU,
      twineV: twine.twineV,
    },
    quad,
    paperFrac,
    waxPixels: wax.waxPixels,
  };
}
