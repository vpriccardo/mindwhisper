/**
 * Documented full-range BT.601-ish Y/Cb/Cr used by Hidden envelope encode/decode.
 * sRGB channels in [0,255]; Y in [0,255]; Cb/Cr centered at 128.
 */

export function srgbToYCbCr(
  r: number,
  g: number,
  b: number,
): { y: number; cb: number; cr: number } {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return { y, cb, cr };
}

export function yCbCrToSrgb(
  y: number,
  cb: number,
  cr: number,
): { r: number; g: number; b: number } {
  const cbi = cb - 128;
  const cri = cr - 128;
  const r = y + 1.402 * cri;
  const g = y - 0.344136 * cbi - 0.714136 * cri;
  const b = y + 1.772 * cbi;
  return {
    r: clampByte(r),
    g: clampByte(g),
    b: clampByte(b),
  };
}

export function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
