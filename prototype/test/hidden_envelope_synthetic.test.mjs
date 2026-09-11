import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { createHiddenToken, tokenToBits } from "./.bundle/hiddenEnvelopeProtocol.mjs";
import { embedHiddenWatermark, extractSoftBitsExact } from "./.bundle/embed.mjs";
import { ENVELOPE_MANIFEST } from "./.bundle/envelopeManifest.mjs";
import { scoreHiddenDictionary } from "./.bundle/dictionaryMatcher.mjs";
import { HIDDEN_DICTIONARY_META } from "./.bundle/hiddenDictionaryMeta.mjs";
import { GRID_H, GRID_W } from "./.bundle/watermarkBasis.mjs";
import { LockPolicy } from "./.bundle/lockPolicy.mjs";
import { FrameAccumulator } from "./.bundle/frameAccumulator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadAssets() {
  const png = PNG.sync.read(
    readFileSync(join(ROOT, "src", "assets", "envelope", "envelope-base-v1.png")),
  );
  const maskBuf = readFileSync(
    join(ROOT, "src", "assets", "envelope", "envelope-mask-v1.bin"),
  );
  const weights = new Float32Array(
    maskBuf.buffer,
    maskBuf.byteOffset,
    maskBuf.byteLength / 4,
  );
  let coverage = 0;
  for (let i = 0; i < weights.length; i++) coverage += weights[i];
  const basisBuf = readFileSync(
    join(ROOT, "src", "assets", "envelope", "envelope-basis-v1.bin"),
  );
  const f32 = new Float32Array(
    basisBuf.buffer,
    basisBuf.byteOffset,
    basisBuf.byteLength / 4,
  );
  const fields = [];
  const stride = GRID_W * GRID_H;
  for (let b = 0; b < 56; b++) fields.push(f32.slice(b * stride, (b + 1) * stride));
  const digestTable = readFileSync(
    join(ROOT, "src", "generated", "hiddenDigestTable.bin"),
  );
  return {
    rgba: Uint8ClampedArray.from(png.data),
    width: png.width,
    height: png.height,
    mask: { weights, coverage: coverage / weights.length },
    fields,
    digestTable,
  };
}

function addNoiseToSoft(soft, rng, bitFlipProb, gauss) {
  const out = Float64Array.from(soft);
  for (let i = 0; i < out.length; i++) {
    out[i] += (rng() * 2 - 1) * gauss;
    if (rng() < bitFlipProb) out[i] *= -1;
  }
  return out;
}

describe("synthetic soft-bit robustness harness (NOT camera validation)", () => {
  it("runs bounded soft-bit distortion matrix + 200 seeded trials", async () => {
    const assets = loadAssets();
    const words = ["LETTO", "CAFFE", "OMBRELLO", "COLAPASTA", "SCOLAPASTA"];
    const encodedCache = new Map();

    async function getSoft(word, salt) {
      const key = `${word}:${salt}`;
      if (encodedCache.has(key)) return encodedCache.get(key);
      const { token } = await createHiddenToken(word, salt);
      const embedded = embedHiddenWatermark({
        rgba: assets.rgba,
        width: assets.width,
        height: assets.height,
        token,
        alpha: ENVELOPE_MANIFEST.alpha,
        mask: assets.mask,
        basisFields: assets.fields,
      });
      const { soft } = extractSoftBitsExact({
        cleanRgba: assets.rgba,
        encodedRgba: embedded.rgba,
        width: assets.width,
        height: assets.height,
        mask: assets.mask,
        basisFields: assets.fields,
      });
      encodedCache.set(key, soft);
      return soft;
    }

    const matrix = [];
    for (const bitFlip of [0, 0.02, 0.05]) {
      for (const gauss of [0, 0.05, 0.1]) {
        matrix.push({ bitFlip, gauss, release: bitFlip <= 0.05 && gauss <= 0.1 });
      }
    }

    let correct = 0;
    let wrong = 0;
    let noLock = 0;
    const matrixRows = [];

    for (const cond of matrix) {
      let c = 0;
      let w = 0;
      let n = 0;
      for (const word of words) {
        const salt = 17;
        const soft0 = await getSoft(word, salt);
        const rng = mulberry32(word.length * 1000 + Math.round(cond.gauss * 100));
        const soft = addNoiseToSoft(soft0, rng, cond.bitFlip, cond.gauss);
        const acc = new FrameAccumulator();
        const policy = new LockPolicy({
          ...ENVELOPE_MANIFEST.lock,
        });
        let locked = null;
        for (let f = 0; f < 10; f++) {
          const softF = addNoiseToSoft(soft, rng, cond.bitFlip * 0.5, cond.gauss);
          acc.push({
            soft: softF,
            noise: new Float64Array(56).fill(1),
            quality: 0.8,
            timestampMs: f * 40,
          });
          const { soft: softAcc, independentCount, spanMs } = acc.accumulateSoft();
          const match = scoreHiddenDictionary({
            soft: softAcc,
            surfaces: HIDDEN_DICTIONARY_META.surfaces,
            digestTable: assets.digestTable,
            topSalts: 32,
          });
          if (!match.best || match.ambiguous) continue;
          policy.noteDecision({
            canonicalWord: match.best.canonicalWord,
            salt8: match.best.salt8,
            score: match.best.score,
            margin: match.margin,
            unique: match.unique,
            qualitySafety: false,
          });
          const ev = policy.evaluate(independentCount, spanMs);
          if (ev.mayLock) {
            locked = match.best.canonicalWord;
            break;
          }
        }
        const canonical =
          HIDDEN_DICTIONARY_META.surfaces.find((s) => s.surface === word)
            ?.canonicalWord ?? word;
        if (locked == null) n++;
        else if (locked === canonical) c++;
        else w++;
      }
      matrixRows.push({ ...cond, correct: c, wrong: w, noLock: n });
      if (cond.release) {
        correct += c;
        wrong += w;
        noLock += n;
      }
    }

    const TRIALS = 200;
    const rng = mulberry32(0xc0ffee);
    let rCorrect = 0;
    let rWrong = 0;
    let rNo = 0;
    let lockBy10 = 0;
    for (const word of words) {
      for (let salt = 0; salt < 8; salt++) {
        await getSoft(word, salt);
      }
    }
    for (let t = 0; t < TRIALS; t++) {
      const word = words[Math.floor(rng() * words.length)];
      const salt = Math.floor(rng() * 8);
      const soft0 = await getSoft(word, salt);
      const bitFlip = rng() * 0.04;
      const gauss = rng() * 0.08;
      const acc = new FrameAccumulator();
      const policy = new LockPolicy({
        ...ENVELOPE_MANIFEST.lock,
      });
      let locked = null;
      let frames = 0;
      for (let f = 0; f < 12; f++) {
        frames++;
        const softF = addNoiseToSoft(soft0, rng, bitFlip, gauss);
        acc.push({
          soft: softF,
          noise: new Float64Array(56).fill(0.8 + rng()),
          quality: 0.5 + rng() * 0.5,
          timestampMs: f * 35,
        });
        const { soft: softAcc, independentCount, spanMs } = acc.accumulateSoft();
        const match = scoreHiddenDictionary({
          soft: softAcc,
          surfaces: HIDDEN_DICTIONARY_META.surfaces,
          digestTable: assets.digestTable,
          topSalts: 32,
        });
        if (!match.best || match.ambiguous) continue;
        policy.noteDecision({
          canonicalWord: match.best.canonicalWord,
          salt8: match.best.salt8,
          score: match.best.score,
          margin: match.margin,
          unique: match.unique,
          qualitySafety: false,
        });
        if (policy.evaluate(independentCount, spanMs).mayLock) {
          locked = match.best.canonicalWord;
          if (frames <= 10) lockBy10++;
          break;
        }
      }
      const canonical =
        HIDDEN_DICTIONARY_META.surfaces.find((s) => s.surface === word)
          ?.canonicalWord ?? word;
      if (locked == null) rNo++;
      else if (locked === canonical) rCorrect++;
      else rWrong++;
    }

    const summary = {
      note: "Soft-bit-only stress harness — NOT camera / pixel-domain validation.",
      matrixRows,
      matrixTotals: { correct, wrong, noLock },
      randomTrials: {
        n: TRIALS,
        correct: rCorrect,
        wrong: rWrong,
        noLock: rNo,
        lockBy10,
        correctRate: rCorrect / TRIALS,
        lockBy10Rate: lockBy10 / Math.max(1, rCorrect + rWrong),
      },
      gates: {
        zeroWrongLocks: wrong === 0 && rWrong === 0,
      },
    };

    mkdirSync(join(ROOT, "test-results"), { recursive: true });
    writeFileSync(
      join(ROOT, "test-results", "synthetic_softbit_harness.json"),
      JSON.stringify(summary, null, 2),
    );

    assert.equal(rWrong, 0, "wrong locks in randomized soft-bit trials");
    assert.equal(wrong, 0, "wrong locks in release-envelope matrix rows");
    assert.ok(
      rCorrect / TRIALS >= 0.85,
      `correct lock rate ${rCorrect / TRIALS} < 0.85`,
    );
  });
});
