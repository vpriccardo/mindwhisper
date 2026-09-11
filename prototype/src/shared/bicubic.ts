/**
 * Bicubic upsample of a Float32 grid field to native pixel dimensions.
 */

function cubicHermite(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * b +
      (-a + c) * t +
      (2 * a - 5 * b + 4 * c - d) * t2 +
      (-a + 3 * b - 3 * c + d) * t3)
  );
}

function sampleBicubic(
  src: Float32Array,
  sw: number,
  sh: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const get = (ix: number, iy: number) => {
    const cx = Math.min(Math.max(ix, 0), sw - 1);
    const cy = Math.min(Math.max(iy, 0), sh - 1);
    return src[cy * sw + cx]!;
  };
  const rows = [0, 1, 2, 3].map((j) => {
    const iy = y0 - 1 + j;
    const c0 = get(x0 - 1, iy);
    const c1 = get(x0, iy);
    const c2 = get(x0 + 1, iy);
    const c3 = get(x0 + 2, iy);
    return cubicHermite(c0, c1, c2, c3, tx);
  });
  return cubicHermite(rows[0]!, rows[1]!, rows[2]!, rows[3]!, ty);
}

export function upsampleBicubic(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * sh) / dh - 0.5;
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * sw) / dw - 0.5;
      out[y * dw + x] = sampleBicubic(src, sw, sh, sx, sy);
    }
  }
  return out;
}
