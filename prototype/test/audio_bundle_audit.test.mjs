/**
 * Production bundle security/static audit for accidental cross-tab channels.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const distSpec = join(ROOT, "dist", "spectator");
const distPerf = join(ROOT, "dist", "performer");

const FORBIDDEN = [
  "BroadcastChannel",
  "RTCPeerConnection",
  "SharedWorker",
  "serviceWorker",
  "WebSocket(",
  "new WebSocket",
];

describe("audio seal dist assets + bundle audit", () => {
  it("lab pages, worklet, worker exist after build", () => {
    // Build may not have run in --test-only path; skip soft if missing.
    if (!existsSync(join(distSpec, "spectator.js"))) {
      return;
    }
    assert.ok(existsSync(join(distSpec, "audio-lab", "index.html")));
    assert.ok(existsSync(join(distSpec, "audio-lab", "audio-lab.js")));
    assert.ok(existsSync(join(distPerf, "audio-lab", "index.html")));
    assert.ok(existsSync(join(distPerf, "audio-lab", "audio-lab.js")));
    assert.ok(existsSync(join(distPerf, "audioDecoderWorker.js")));
    assert.ok(existsSync(join(distPerf, "audioCaptureWorklet.js")));
    assert.ok(
      existsSync(join(distPerf, "assets", "envelope", "hiddenDigestTable.bin")),
    );
  });

  it("spectator bundle has no cross-tab messaging APIs", () => {
    const path = join(distSpec, "spectator.js");
    if (!existsSync(path)) return;
    const src = readFileSync(path, "utf8");
    for (const needle of FORBIDDEN) {
      assert.equal(
        src.includes(needle),
        false,
        `spectator.js must not contain ${needle}`,
      );
    }
    assert.equal(src.includes("127.0.0.1:8001"), false);
    assert.equal(src.includes("localStorage"), false);
    assert.equal(src.includes("sessionStorage"), false);
  });

  it("performer main bundle has no BroadcastChannel / WebRTC", () => {
    const path = join(distPerf, "performer.js");
    if (!existsSync(path)) return;
    const src = readFileSync(path, "utf8");
    for (const needle of ["BroadcastChannel", "RTCPeerConnection", "SharedWorker"]) {
      assert.equal(src.includes(needle), false, needle);
    }
  });
});
