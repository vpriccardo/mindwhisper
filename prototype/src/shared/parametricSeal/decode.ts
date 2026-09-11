/**
 * PENV1 decode: geometry → levels → payload → dictionary word.
 */

import { entryAtIndex, type ParametricEntry } from "./dictionary";
import { detectSealGeometry, type DetectResult } from "./detect";
import { geometryToLevels, levelsToPayload } from "./layout";
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
  const payload = levelsToPayload(levels);
  const unpacked = unpackPayload(payload);
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
