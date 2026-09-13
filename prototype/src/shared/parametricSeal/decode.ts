/**
 * PENV1 decode: geometry → levels → payload → dictionary word.
 */

import { entryAtIndex, type ParametricEntry } from "./dictionary";
import { detectSealGeometry, type DetectResult } from "./detect";
import {
  geometryToLevels,
  levelsToPayload,
  type ChannelLevels,
} from "./layout";
import { unpackPayload } from "./protocol";

export type DecodeOk = {
  ok: true;
  index: number;
  entry: ParametricEntry;
  detect: Extract<DetectResult, { ok: true }>;
  decodeMs: number;
};

export type DecodeFail = {
  ok: false;
  reason: string;
  detect?: DetectResult;
  decodeMs: number;
};

const REPAIR_CHANNELS: (keyof ChannelLevels)[] = [
  "twineOff",
  "waxY",
  "waxX",
  "twineAngle",
  "waxSize",
  "bubbleRad",
  "bubbleAngle",
];

function tryUnpack(levels: ChannelLevels) {
  return unpackPayload(levelsToPayload(levels));
}

/** If CRC/parity fails, nudge the noisiest 1–2 geometry bins (±1). */
function repairLevels(levels: ChannelLevels) {
  const direct = tryUnpack(levels);
  if (direct.ok) return direct;

  for (const key of REPAIR_CHANNELS) {
    for (const d of [-1, 1]) {
      const next = { ...levels, [key]: levels[key] + d };
      const u = tryUnpack(next);
      if (u.ok) return u;
    }
  }
  for (let i = 0; i < REPAIR_CHANNELS.length; i++) {
    for (let j = i + 1; j < REPAIR_CHANNELS.length; j++) {
      const a = REPAIR_CHANNELS[i]!;
      const b = REPAIR_CHANNELS[j]!;
      for (const da of [-1, 1]) {
        for (const db of [-1, 1]) {
          const next = {
            ...levels,
            [a]: levels[a] + da,
            [b]: levels[b] + db,
          };
          const u = tryUnpack(next);
          if (u.ok) return u;
        }
      }
    }
  }
  return direct;
}

export function decodeParametricFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): DecodeOk | DecodeFail {
  const t0 = performance.now();
  const detect = detectSealGeometry(rgba, width, height);
  if (!detect.ok) {
    return { ok: false, reason: detect.reason, detect, decodeMs: performance.now() - t0 };
  }
  const levels = geometryToLevels(detect.geometry);
  const unpacked = repairLevels(levels);
  if (!unpacked.ok) {
    return {
      ok: false,
      reason: unpacked.reason,
      detect,
      decodeMs: performance.now() - t0,
    };
  }
  const entry = entryAtIndex(unpacked.index);
  if (!entry) {
    return {
      ok: false,
      reason: "unknown_index",
      detect,
      decodeMs: performance.now() - t0,
    };
  }
  return {
    ok: true,
    index: unpacked.index,
    entry,
    detect,
    decodeMs: performance.now() - t0,
  };
}
