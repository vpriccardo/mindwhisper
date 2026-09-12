/**
 * PENV1 — parametric still-life envelope.
 * 20 bits of geometry: 11-bit dictionary index + CRC-8 + 1 parity bit.
 */

export const PENV_PROTOCOL_ID = "PENV1" as const;

export const INDEX_BITS = 11;
export const INDEX_MAX = 1 << INDEX_BITS; // 2048
export const CRC_BITS = 8;
export const PARITY_BITS = 1;
export const PAYLOAD_BITS = INDEX_BITS + CRC_BITS + PARITY_BITS; // 20

export const CHANNELS = {
  waxX: 3,
  waxY: 3,
  bubbleAngle: 4,
  bubbleRad: 2,
  twineAngle: 3,
  twineOff: 3,
  waxSize: 2,
} as const;

/** Rendered photo including a dark margin so the paper quad is findable. */
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 640;
export const MARGIN_FRAC = 0.08;

/** Canonical warp size for the decoder (paper only). */
export const WARP_W = 400;
export const WARP_H = 280;

/** Knot / wax rest position in paper [0,1]. */
export const KNOT_U = 0.5;
export const KNOT_V = 0.58;
export const WAX_SPAN_U = 0.07;
export const WAX_SPAN_V = 0.06;
export const WAX_DIAM = [0.236, 0.256, 0.276, 0.296] as const;
export const BUBBLE_RAD = [0.34, 0.42, 0.5, 0.58] as const;
export const BUBBLE_SIZE_FRAC = 0.16;
export const TWINE_ANGLE_DEG = [30, 32, 34, 36, 38, 40, 42, 44] as const;
export const TWINE_OFF_V = 0.05;
export const TWINE_CROSS_U = 0.5;
export const TWINE_CROSS_V0 = 0.54;
export const TWINE_WIDTH_FRAC = 0.028;

export const PENV_MANIFEST = {
  protocolId: PENV_PROTOCOL_ID,
  payloadBits: PAYLOAD_BITS,
  indexBits: INDEX_BITS,
  crcBits: CRC_BITS,
} as const;

const CHANNEL_ORDER = [
  ["waxX", 3],
  ["waxY", 3],
  ["bubbleAngle", 4],
  ["bubbleRad", 2],
  ["twineAngle", 3],
  ["twineOff", 3],
  ["waxSize", 2],
] as const;

export function channelBitTotal(): number {
  return CHANNEL_ORDER.reduce((s, [, n]) => s + n, 0);
}

if (channelBitTotal() !== PAYLOAD_BITS) {
  throw new Error("PENV1 channel bits must sum to PAYLOAD_BITS.");
}
