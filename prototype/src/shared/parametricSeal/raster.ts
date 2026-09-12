/**
 * Geometry rasterizer shared by the pretty canvas renderer and Node tests.
 * Draws into a Uint8ClampedArray RGBA buffer.
 */

import {
  BUBBLE_SIZE_FRAC,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MARGIN_FRAC,
  TWINE_WIDTH_FRAC,
} from "./constants";
import type { SealGeometry } from "./layout";

export type PixelBuffer = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
};

export function paperRect(
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
): { x: number; y: number; w: number; h: number } {
  const m = Math.round(Math.min(width, height) * MARGIN_FRAC);
  return { x: m, y: m, w: width - 2 * m, h: height - 2 * hSafe(height, m) };
}

function hSafe(height: number, m: number): number {
  return m;
}

function setPx(
  buf: PixelBuffer,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): void {
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return;
  const o = (y * buf.width + x) * 4;
  buf.rgba[o] = r;
  buf.rgba[o + 1] = g;
  buf.rgba[o + 2] = b;
  buf.rgba[o + 3] = 255;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function fillBackground(buf: PixelBuffer): void {
  for (let i = 0; i < buf.width * buf.height; i++) {
    const o = i * 4;
    buf.rgba[o] = 22;
    buf.rgba[o + 1] = 24;
    buf.rgba[o + 2] = 28;
    buf.rgba[o + 3] = 255;
  }
}

function fillRoundRect(
  buf: PixelBuffer,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rad: number,
  color: (x: number, y: number) => [number, number, number],
): void {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = Math.max(x0 + rad - px, 0, px - (x1 - rad));
      const dy = Math.max(y0 + rad - py, 0, py - (y1 - rad));
      if (dx * dx + dy * dy > rad * rad && (dx > 0 && dy > 0)) continue;
      const c = color(px, py);
      setPx(buf, x, y, c[0], c[1], c[2]);
    }
  }
}

function fillCircle(
  buf: PixelBuffer,
  cx: number,
  cy: number,
  r: number,
  color: (x: number, y: number, d: number) => [number, number, number],
): void {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(buf.width, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(buf.height, Math.ceil(cy + r + 1));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const c = color(x, y, Math.sqrt(d2) / r);
      setPx(buf, x, y, c[0], c[1], c[2]);
    }
  }
}

function drawThickLine(
  buf: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  rgb: [number, number, number],
  clip?: { x: number; y: number; w: number; h: number },
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const hw = width / 2;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1));
  const maxX = Math.min(buf.width, Math.ceil(Math.max(x0, x1) + hw + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1));
  const maxY = Math.min(buf.height, Math.ceil(Math.max(y0, y1) + hw + 1));
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      const t = (px * dx + py * dy) / (len * len);
      if (t < -0.02 || t > 1.02) continue;
      if (
        clip &&
        (x + 0.5 < clip.x ||
          y + 0.5 < clip.y ||
          x + 0.5 > clip.x + clip.w ||
          y + 0.5 > clip.y + clip.h)
      ) {
        continue;
      }
      const qx = px - t * dx;
      const qy = py - t * dy;
      const dist = Math.hypot(qx, qy);
      // Accept a bit of end-cap using the normal; ignore nx,ny except for thickness.
      void nx;
      void ny;
      if (dist <= hw) setPx(buf, x, y, rgb[0], rgb[1], rgb[2]);
    }
  }
}

/** Fixed paper grain so texture does not carry the payload. */
function grain(x: number, y: number): number {
  const n =
    Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 -
    Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
  return n * 2 - 1;
}

export function rasterizeGeometry(
  geom: SealGeometry,
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
): PixelBuffer {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const buf: PixelBuffer = { rgba, width, height };
  fillBackground(buf);
  const paper = paperRect(width, height);
  const rad = Math.min(paper.w, paper.h) * 0.035;
  fillRoundRect(buf, paper.x, paper.y, paper.w, paper.h, rad, (x, y) => {
    const u = (x - paper.x) / paper.w;
    const v = (y - paper.y) / paper.h;
    const g = grain(x * 0.37, y * 0.41) * 6;
    const shade = mix(0, 10, v) + g;
    // Flap: slightly darker band in the top 22%.
    const flap = v < 0.22 ? -8 : 0;
    return [
      mix(228, 243, u * 0.3 + 0.2) + shade + flap,
      mix(214, 230, u * 0.3 + 0.2) + shade + flap,
      mix(190, 208, u * 0.3 + 0.2) + shade + flap,
    ];
  });

  const twineW = paper.w * TWINE_WIDTH_FRAC;
  const cx = paper.x + geom.twineU * paper.w;
  const cy = paper.y + geom.twineV * paper.h;
  const theta = (geom.twineAngleDeg * Math.PI) / 180;
  const reach = Math.hypot(paper.w, paper.h);
  const dirs = [theta, -theta];
  for (const a of dirs) {
    const dx = Math.cos(a) * reach;
    const dy = Math.sin(a) * reach;
    drawThickLine(
      buf,
      cx - dx,
      cy - dy,
      cx + dx,
      cy + dy,
      twineW,
      [68, 42, 28],
      paper,
    );
  }

  const waxR = (geom.waxDiam * paper.w) / 2;
  const wx = paper.x + geom.waxU * paper.w;
  const wy = paper.y + geom.waxV * paper.h;
  fillCircle(buf, wx, wy, waxR, (_x, _y, t) => {
    const k = t * t;
    // Stronger red dominance so phone WB / screen wash still reads as wax.
    return [
      mix(148, 58, k),
      mix(24, 6, k),
      mix(30, 10, k),
    ];
  });

  const br = waxR * geom.bubbleRadFrac;
  const bx = wx + Math.cos(geom.bubbleAngleRad) * br;
  const by = wy + Math.sin(geom.bubbleAngleRad) * br;
  fillCircle(buf, bx, by, waxR * BUBBLE_SIZE_FRAC, (_x, _y, t) => {
    const k = 0.25 + 0.75 * t;
    return [mix(28, 12, k), mix(6, 2, k), mix(8, 3, k)];
  });

  return buf;
}

export function bufferToDataUrl(buf: PixelBuffer): string {
  // Minimal PNG encoder is heavy; browser renderer uses canvas instead.
  void buf;
  return "";
}
