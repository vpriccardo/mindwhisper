/**
 * Dedicated worker: decode PENV1 from captured RGBA frames.
 */

import { decodeParametricFrame } from "../../shared/parametricSeal/decode";

declare const self: DedicatedWorkerGlobalScope;

type InMsg =
  | { type: "frame"; width: number; height: number; rgba: ArrayBuffer; tMs: number }
  | { type: "reset" }
  | { type: "stop" };

type OutMsg =
  | {
      type: "lock";
      word: string;
      index: number;
      conceptId: string;
      timeToLockMs: number;
      decodeMs: number;
    }
  | {
      type: "status";
      state: string;
      reason: string | null;
      paperFrac: number | null;
      decodeMs: number;
    };

let locked = false;
let startedAt = 0;
let lastStatusAt = 0;

function post(msg: OutMsg): void {
  self.postMessage(msg);
}

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === "reset") {
    locked = false;
    startedAt = performance.now();
    post({ type: "status", state: "searching", reason: null, paperFrac: null, decodeMs: 0 });
    return;
  }
  if (msg.type === "stop") {
    locked = false;
    return;
  }
  if (msg.type !== "frame") return;
  if (locked) return;
  if (!startedAt) startedAt = msg.tMs;
  const rgba = new Uint8ClampedArray(msg.rgba);
  const result = decodeParametricFrame(rgba, msg.width, msg.height);
  if (result.ok) {
    locked = true;
    post({
      type: "lock",
      word: result.entry.canonicalWord,
      index: result.index,
      conceptId: result.entry.conceptId,
      timeToLockMs: msg.tMs - startedAt,
      decodeMs: result.decodeMs,
    });
    return;
  }
  const now = msg.tMs;
  if (now - lastStatusAt > 200) {
    lastStatusAt = now;
    const paperFrac =
      result.detect && "paperFrac" in result.detect
        ? (result.detect.paperFrac ?? null)
        : null;
    post({
      type: "status",
      state: "searching",
      reason: result.reason,
      paperFrac,
      decodeMs: result.decodeMs,
    });
  }
};
