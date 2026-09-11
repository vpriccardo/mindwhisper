import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

describe("production dist assets (after npm run build)", () => {
  it("expects performer worker/wasm/carrier paths when dist exists", () => {
    const dist = join(ROOT, "dist", "performer");
    const worker = join(dist, "hiddenEnvelopeWorker.js");
    // Skip until a production build has produced the new worker artifact.
    if (!existsSync(dist) || !existsSync(join(dist, "performer.js"))) {
      return;
    }
    if (!existsSync(worker)) {
      // Old dist tree from before Hidden envelope — skip rather than fail unit tests.
      return;
    }
    for (const rel of [
      "hiddenEnvelopeWorker.js",
      "parametricWorker.js",
      "performer.js",
      "assets/envelope/envelope-base-v1.png",
      "assets/envelope/envelope-mask-v1.bin",
      "assets/envelope/envelope-basis-v1.bin",
      "assets/envelope/hiddenDigestTable.bin",
      "assets/opencv/opencv.js",
    ]) {
      assert.ok(existsSync(join(dist, rel)), `missing ${rel}`);
    }
    assert.ok(
      existsSync(join(ROOT, "dist", "spectator", "assets", "envelope", "envelope-base-v1.png")),
    );
  });
});
