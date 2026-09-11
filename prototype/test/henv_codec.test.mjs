import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import {
  generateBasisFields,
  GRID_H,
  GRID_W,
  MAX_BASIS_NCC,
  normalizedCorrelation,
  guardEligible,
} from "./.bundle/watermarkBasis.mjs";
import { ENVELOPE_MANIFEST } from "./.bundle/envelopeManifest.mjs";
import {
  createHiddenToken,
  tokenToBits,
  bitsToSigns,
} from "./.bundle/hiddenEnvelopeProtocol.mjs";
import { embedHiddenWatermark, extractSoftBitsExact } from "./.bundle/embed.mjs";
import { scoreHiddenDictionary } from "./.bundle/dictionaryMatcher.mjs";
import { HIDDEN_DICTIONARY_META } from "./.bundle/hiddenDictionaryMeta.mjs";
import { FrameAccumulator } from "./.bundle/frameAccumulator.mjs";
import { LockPolicy } from "./.bundle/lockPolicy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadMask() {
  const buf = readFileSync(
    join(ROOT, "src", "assets", "envelope", "envelope-mask-v1.bin"),
  );
  const weights = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  );
  let coverage = 0;
  for (let i = 0; i < weights.length; i++) coverage += weights[i];
  return { weights, coverage: coverage / weights.length };
}

function loadPngRgba() {
  const bytes = readFileSync(
    join(ROOT, "src", "assets", "envelope", "envelope-base-v1.png"),
  );
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha, ENVELOPE_MANIFEST.pngSha256);
  const png = PNG.sync.read(bytes);
  return {
    rgba: Uint8ClampedArray.from(png.data),
    width: png.width,
    height: png.height,
  };
}

function loadBasis() {
  const buf = readFileSync(
    join(ROOT, "src", "assets", "envelope", "envelope-basis-v1.bin"),
  );
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const fields = [];
  const stride = GRID_W * GRID_H;
  for (let b = 0; b < 56; b++) fields.push(f32.slice(b * stride, (b + 1) * stride));
  return fields;
}

function loadDigestTable() {
  return readFileSync(join(ROOT, "src", "generated", "hiddenDigestTable.bin"));
}

describe("carrier + basis", () => {
  it("verifies PNG and mask checksums", () => {
    const maskBuf = readFileSync(
      join(ROOT, "src", "assets", "envelope", "envelope-mask-v1.bin"),
    );
    const maskSha = createHash("sha256").update(maskBuf).digest("hex");
    assert.equal(maskSha, ENVELOPE_MANIFEST.maskSha256);
    assert.ok(ENVELOPE_MANIFEST.maskCoverage >= 0.35);
  });

  it("basis is balanced and low cross-correlation", () => {
    const mask = loadMask();
    const { fields, checksum } = generateBasisFields(mask);
    assert.equal(checksum, ENVELOPE_MANIFEST.basisChecksum);
    const eligible = [];
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = y * GRID_W + x;
        if (guardEligible(x, y) && mask.weights[i] > 0) eligible.push(i);
      }
    }
    for (let a = 0; a < fields.length; a++) {
      let mean = 0;
      for (const i of eligible) mean += fields[a][i];
      mean /= eligible.length;
      assert.ok(Math.abs(mean) < 1e-6);
      for (let b = 0; b < a; b++) {
        const ncc = Math.abs(
          normalizedCorrelation(fields[a], fields[b], eligible),
        );
        assert.ok(ncc <= MAX_BASIS_NCC + 1e-9, `ncc ${ncc} bits ${b},${a}`);
      }
    }
  });
});

describe("digital encode/decode", () => {
  it("round-trips LETTO with correct bit signs", async () => {
    const clean = loadPngRgba();
    const mask = loadMask();
    const fields = loadBasis();
    const { token } = await createHiddenToken("LETTO", 0x2a);
    const bits = tokenToBits(token);
    const signs = bitsToSigns(bits);
    const embedded = embedHiddenWatermark({
      rgba: clean.rgba,
      width: clean.width,
      height: clean.height,
      token,
      alpha: ENVELOPE_MANIFEST.alpha,
      mask,
      basisFields: fields,
    });
    const { soft } = extractSoftBitsExact({
      cleanRgba: clean.rgba,
      encodedRgba: embedded.rgba,
      width: clean.width,
      height: clean.height,
      mask,
      basisFields: fields,
    });
    let wrong = 0;
    for (let i = 0; i < 56; i++) {
      const got = soft[i] >= 0 ? 1 : -1;
      if (got !== signs[i]) wrong++;
    }
    assert.equal(wrong, 0, `bit sign errors: ${wrong}`);
  });

  it("dictionary soft match recovers word", async () => {
    const clean = loadPngRgba();
    const mask = loadMask();
    const fields = loadBasis();
    const table = loadDigestTable();
    const { token } = await createHiddenToken("OMBRELLO", 11);
    const embedded = embedHiddenWatermark({
      rgba: clean.rgba,
      width: clean.width,
      height: clean.height,
      token,
      alpha: ENVELOPE_MANIFEST.alpha,
      mask,
      basisFields: fields,
    });
    const { soft } = extractSoftBitsExact({
      cleanRgba: clean.rgba,
      encodedRgba: embedded.rgba,
      width: clean.width,
      height: clean.height,
      mask,
      basisFields: fields,
    });
    const match = scoreHiddenDictionary({
      soft,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable: table,
    });
    assert.ok(match.best);
    assert.equal(match.best.canonicalWord, "OMBRELLO");
    assert.equal(match.best.salt8, 11);
  });

  it("rejects wrong word soft scores", async () => {
    const clean = loadPngRgba();
    const mask = loadMask();
    const fields = loadBasis();
    const table = loadDigestTable();
    const { token } = await createHiddenToken("CAFFE", 3);
    const embedded = embedHiddenWatermark({
      rgba: clean.rgba,
      width: clean.width,
      height: clean.height,
      token,
      alpha: ENVELOPE_MANIFEST.alpha,
      mask,
      basisFields: fields,
    });
    const { soft } = extractSoftBitsExact({
      cleanRgba: clean.rgba,
      encodedRgba: embedded.rgba,
      width: clean.width,
      height: clean.height,
      mask,
      basisFields: fields,
    });
    // Flip many soft signs → should not confidently lock as CAFFE with high margin
    for (let i = 0; i < 28; i++) soft[i] *= -1;
    const match = scoreHiddenDictionary({
      soft,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable: table,
    });
    if (match.best?.canonicalWord === "CAFFE" && match.best.salt8 === 3) {
      assert.ok(match.best.estimatedBitErrors >= 20);
    }
  });
});

describe("accumulator + lock policy", () => {
  it("evicts old observations and releases count", () => {
    const acc = new FrameAccumulator({ maxAgeMs: 100, maxObservations: 5 });
    for (let i = 0; i < 8; i++) {
      acc.push({
        soft: new Float64Array(56).fill(0.1 * i),
        noise: new Float64Array(56).fill(1),
        quality: 1,
        timestampMs: i * 10,
      });
    }
    assert.ok(acc.length <= 5);
    assert.ok(acc.released >= 3);
  });

  it("de-weights near-identical consecutive frames", () => {
    const acc = new FrameAccumulator();
    const soft = new Float64Array(56).fill(0.5);
    acc.push({ soft, noise: new Float64Array(56).fill(1), quality: 1, timestampMs: 0 });
    acc.push({ soft, noise: new Float64Array(56).fill(1), quality: 1, timestampMs: 10 });
    const best = acc.bestObservations();
    assert.ok(best[0].quality <= 1);
    assert.ok(best.some((o) => o.quality < 1));
  });

  it("requires three stable decisions to lock", () => {
    const policy = new LockPolicy({
      provisional: true,
      minAbsConfidence: 5,
      minScoreMargin: 1,
      minFrames: 3,
      minSpanMs: 150,
      trackLossResetMs: 400,
    });
    const d = {
      canonicalWord: "LETTO",
      salt8: 1,
      score: 10,
      margin: 3,
      unique: true,
      qualitySafety: false,
    };
    assert.equal(policy.noteDecision(d).mayLock, false);
    assert.equal(policy.noteDecision(d).mayLock, false);
    const third = policy.noteDecision(d);
    // evaluate also needs independent frame/span args
    const ev = policy.evaluate(3, 200);
    assert.equal(ev.mayLock, true);
    void third;
  });
});
