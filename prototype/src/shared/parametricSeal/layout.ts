/**
 * Map a 20-bit PENV1 payload onto still-life geometry (and back).
 */

import {
  BUBBLE_RAD,
  CHANNELS,
  KNOT_U,
  KNOT_V,
  TWINE_ANGLE_DEG,
  TWINE_CROSS_U,
  TWINE_CROSS_V0,
  TWINE_OFF_V,
  WAX_DIAM,
  WAX_SPAN_U,
  WAX_SPAN_V,
} from "./constants";
import { fromGray, toGray } from "./protocol";

export type ChannelLevels = {
  waxX: number;
  waxY: number;
  bubbleAngle: number;
  bubbleRad: number;
  twineAngle: number;
  twineOff: number;
  waxSize: number;
};

export type SealGeometry = {
  waxU: number;
  waxV: number;
  waxDiam: number;
  bubbleAngleRad: number;
  bubbleRadFrac: number;
  twineAngleDeg: number;
  twineU: number;
  twineV: number;
};

const ORDER: { key: keyof ChannelLevels; bits: number }[] = [
  { key: "waxX", bits: CHANNELS.waxX },
  { key: "waxY", bits: CHANNELS.waxY },
  { key: "bubbleAngle", bits: CHANNELS.bubbleAngle },
  { key: "bubbleRad", bits: CHANNELS.bubbleRad },
  { key: "twineAngle", bits: CHANNELS.twineAngle },
  { key: "twineOff", bits: CHANNELS.twineOff },
  { key: "waxSize", bits: CHANNELS.waxSize },
];

function levelsOf(bits: number): number {
  return 1 << bits;
}

function binCenter(level: number, n: number): number {
  return (level + 0.5) / n;
}

export function payloadToLevels(payload: number): ChannelLevels {
  let shift = 0;
  const out = {} as ChannelLevels;
  for (const ch of ORDER) {
    const mask = (1 << ch.bits) - 1;
    const gray = (payload >>> shift) & mask;
    out[ch.key] = fromGray(gray);
    shift += ch.bits;
  }
  return out;
}

export function levelsToPayload(levels: ChannelLevels): number {
  let payload = 0;
  let shift = 0;
  for (const ch of ORDER) {
    const n = levelsOf(ch.bits);
    const v = Math.max(0, Math.min(n - 1, Math.round(levels[ch.key])));
    payload |= (toGray(v) & ((1 << ch.bits) - 1)) << shift;
    shift += ch.bits;
  }
  return payload >>> 0;
}

export function levelsToGeometry(levels: ChannelLevels): SealGeometry {
  const nx = levelsOf(CHANNELS.waxX);
  const ny = levelsOf(CHANNELS.waxY);
  const no = levelsOf(CHANNELS.twineOff);
  return {
    waxU: KNOT_U + (binCenter(levels.waxX, nx) - 0.5) * WAX_SPAN_U,
    waxV: KNOT_V + (binCenter(levels.waxY, ny) - 0.5) * WAX_SPAN_V,
    waxDiam: WAX_DIAM[levels.waxSize]!,
    bubbleAngleRad: ((levels.bubbleAngle + 0.5) / 16) * Math.PI * 2,
    bubbleRadFrac: BUBBLE_RAD[levels.bubbleRad]!,
    twineAngleDeg: TWINE_ANGLE_DEG[levels.twineAngle]!,
    twineU: TWINE_CROSS_U,
    twineV:
      TWINE_CROSS_V0 + (binCenter(levels.twineOff, no) - 0.5) * TWINE_OFF_V,
  };
}

export function payloadToGeometry(payload: number): SealGeometry {
  return levelsToGeometry(payloadToLevels(payload));
}

function nearest(value: number, table: readonly number[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(value - table[i]!);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Quantize measured geometry back to channel levels.
 * Measurements are paper-normalized [0,1] except angles in radians/degrees as stored.
 */
export function geometryToLevels(g: SealGeometry): ChannelLevels {
  const nx = levelsOf(CHANNELS.waxX);
  const ny = levelsOf(CHANNELS.waxY);
  const no = levelsOf(CHANNELS.twineOff);
  const u = (g.waxU - KNOT_U) / WAX_SPAN_U + 0.5;
  const v = (g.waxV - KNOT_V) / WAX_SPAN_V + 0.5;
  const off = (g.twineV - TWINE_CROSS_V0) / TWINE_OFF_V + 0.5;
  let ang = g.bubbleAngleRad / (Math.PI * 2);
  ang = ang - Math.floor(ang);
  return {
    waxX: clampLevel(Math.round(u * nx - 0.5), nx),
    waxY: clampLevel(Math.round(v * ny - 0.5), ny),
    bubbleAngle: clampLevel(Math.round(ang * 16 - 0.5), 16),
    bubbleRad: nearest(g.bubbleRadFrac, BUBBLE_RAD),
    twineAngle: nearest(g.twineAngleDeg, TWINE_ANGLE_DEG),
    twineOff: clampLevel(Math.round(off * no - 0.5), no),
    waxSize: nearest(g.waxDiam, WAX_DIAM),
  };
}

function clampLevel(v: number, n: number): number {
  return Math.max(0, Math.min(n - 1, v));
}
