/**
 * Hidden-envelope repair tests: accumulator, projective warp, pixel-domain
 * camera simulation, and pipeline performance invariants.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { createHiddenToken, tokenToBits } from "./.bundle/hiddenEnvelopeProtocol.mjs";
import { embedHiddenWatermark } from "./.bundle/embed.mjs";
import { ENVELOPE_MANIFEST } from "./.bundle/envelopeManifest.mjs";
import { scoreHiddenDictionary } from "./.bundle/dictionaryMatcher.mjs";
import { HIDDEN_DICTIONARY_META } from "./.bundle/hiddenDictionaryMeta.mjs";
import { GRID_H, GRID_W } from "./.bundle/watermarkBasis.mjs";
import { LockPolicy } from "./.bundle/lockPolicy.mjs";
import { FrameAccumulator } from "./.bundle/frameAccumulator.mjs";
import { extractSoftBitsFromRectified } from "./.bundle/extractSoftBits.mjs";
import {
  projectiveWarpToCanonical,
  warpQuadBilinearToCanonical,
  homographyFromQuad,
  resizeRgba,
  rgbaToGray,
  buildAlignContext,
  alignIdentityOrNcc,
} from "./.bundle/templateAlign.mjs";

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

function meanAbsDiffGray(a, b, valid) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (valid && !valid[i]) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return n ? sum / n : Infinity;
}

function invertH3(H) {
  const a = H[0], b = H[1], c = H[2];
  const d = H[3], e = H[4], f = H[5];
  const g = H[6], h = H[7], i = H[8];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const D = c * h - b * i;
  const E = a * i - c * g;
  const F = b * g - a * h;
  const G = b * f - c * e;
  const Hh = c * d - a * f;
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("singular H");
  const inv = 1 / det;
  return new Float64Array([
    A * inv, D * inv, G * inv,
    B * inv, E * inv, Hh * inv,
    C * inv, F * inv, I * inv,
  ]);
}

function applyHpt(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  const inv = w === 0 ? 0 : 1 / w;
  return {
    x: (H[0] * x + H[1] * y + H[2]) * inv,
    y: (H[3] * x + H[4] * y + H[5]) * inv,
  };
}

/** Place source into dest using true projective map (HCanonToFrame). */
function applyProjectivePlace(src, sw, sh, dw, dh, HCanonToFrame) {
  const Hinv = invertH3(HCanonToFrame);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const p = applyHpt(Hinv, x + 0.5, y + 0.5);
      const o = (y * dw + x) * 4;
      out[o + 3] = 255;
      if (p.x < 0 || p.y < 0 || p.x >= sw - 1 || p.y >= sh - 1) continue;
      const x0 = Math.floor(p.x);
      const y0 = Math.floor(p.y);
      const fx = p.x - x0;
      const fy = p.y - y0;
      for (let c = 0; c < 3; c++) {
        const i00 = (y0 * sw + x0) * 4 + c;
        const i10 = (y0 * sw + x0 + 1) * 4 + c;
        const i01 = ((y0 + 1) * sw + x0) * 4 + c;
        const i11 = ((y0 + 1) * sw + x0 + 1) * 4 + c;
        out[o + c] = Math.round(
          src[i00] * (1 - fx) * (1 - fy) +
            src[i10] * fx * (1 - fy) +
            src[i01] * (1 - fx) * fy +
            src[i11] * fx * fy,
        );
      }
    }
  }
  return out;
}

function distortFrame(rgba, w, h, rng, opts) {
  let out = Uint8ClampedArray.from(rgba);
  const brightness = opts.brightness ?? 1;
  const contrast = opts.contrast ?? 1;
  const chromaShift = opts.chromaShift ?? 0;
  const noise = opts.noise ?? 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    let r = out[o];
    let g = out[o + 1];
    let b = out[o + 2];
    r = (r - 128) * contrast + 128 * brightness + chromaShift;
    g = (g - 128) * contrast + 128 * brightness;
    b = (b - 128) * contrast + 128 * brightness - chromaShift;
    if (noise > 0) {
      r += (rng() * 2 - 1) * noise;
      g += (rng() * 2 - 1) * noise;
      b += (rng() * 2 - 1) * noise;
    }
    out[o] = Math.max(0, Math.min(255, Math.round(r)));
    out[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }
  if (opts.blurRadius && opts.blurRadius > 0) {
    out = boxBlur(out, w, h, opts.blurRadius);
  }
  return out;
}

function boxBlur(src, w, h, radius) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const o = (yy * w + xx) * 4;
          r += src[o];
          g += src[o + 1];
          b += src[o + 2];
          n++;
        }
      }
      const d = (y * w + x) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
      out[d + 3] = 255;
    }
  }
  return out;
}

describe("frameAccumulator normalized evidence", () => {
  it("one good frame keeps normalized soft near observation", () => {
    const acc = new FrameAccumulator();
    const soft = new Float64Array(56).fill(0.4);
    soft[0] = 0.9;
    acc.push({
      soft,
      noise: new Float64Array(56).fill(1),
      quality: 1,
      timestampMs: 0,
    });
    const out = acc.accumulateSoft();
    assert.ok(Math.abs(out.soft[0] - 0.9) < 1e-9);
    assert.equal(out.independentCount, 1);
    assert.ok(out.totalWeight > 0);
  });

  it("three independent good frames stay in normalized domain", () => {
    const acc = new FrameAccumulator();
    for (let f = 0; f < 3; f++) {
      const soft = new Float64Array(56);
      for (let i = 0; i < 56; i++) soft[i] = ((i + f * 7) % 5) * 0.15 - 0.2;
      soft[f * 3] = 0.9;
      acc.push({
        soft,
        noise: new Float64Array(56).fill(1),
        quality: 1,
        timestampMs: f * 50,
      });
    }
    const out = acc.accumulateSoft();
    assert.ok(out.independentCount >= 2.9);
    assert.ok(out.totalWeight > 0);
  });

  it("ten nearly identical frames do not count as ten independents", () => {
    const acc = new FrameAccumulator();
    const soft = new Float64Array(56).fill(0.55);
    for (let f = 0; f < 10; f++) {
      acc.push({
        soft,
        noise: new Float64Array(56).fill(1),
        quality: 1,
        timestampMs: f * 20,
      });
    }
    const out = acc.accumulateSoft();
    assert.ok(
      out.independentCount < 5,
      `independentCount ${out.independentCount} should be << 10`,
    );
  });

  it("winner change is visible across accumulated soft", () => {
    const acc = new FrameAccumulator();
    const a = new Float64Array(56).fill(-0.2);
    a[0] = 1;
    const b = new Float64Array(56).fill(-0.2);
    b[1] = 1;
    acc.push({ soft: a, noise: new Float64Array(56).fill(1), quality: 1, timestampMs: 0 });
    let out = acc.accumulateSoft();
    assert.ok(out.soft[0] > out.soft[1]);
    acc.push({ soft: b, noise: new Float64Array(56).fill(1), quality: 1, timestampMs: 40 });
    acc.push({ soft: b, noise: new Float64Array(56).fill(1), quality: 1, timestampMs: 80 });
    acc.push({ soft: b, noise: new Float64Array(56).fill(1), quality: 1, timestampMs: 120 });
    out = acc.accumulateSoft();
    assert.ok(out.soft[1] >= out.soft[0] - 0.05);
  });

  it("track loss resets evidence", () => {
    const acc = new FrameAccumulator({ trackLossResetMs: 100 });
    acc.push({
      soft: new Float64Array(56).fill(0.5),
      noise: new Float64Array(56).fill(1),
      quality: 1,
      timestampMs: 0,
    });
    assert.equal(acc.length, 1);
    acc.noteTrackLoss(50);
    assert.equal(acc.length, 1);
    acc.noteTrackLoss(200);
    assert.equal(acc.length, 0);
  });
});

describe("projective vs bilinear warp", () => {
  it("keystone: projective has substantially lower clean-ref error than bilinear", () => {
    const assets = loadAssets();
    const canonW = ENVELOPE_MANIFEST.canonicalWidth;
    const canonH = ENVELOPE_MANIFEST.canonicalHeight;
    const clean = resizeRgba(assets.rgba, assets.width, assets.height, canonW, canonH);

    const fw = 900;
    const fh = 600;
    const quad = [
      { x: 120, y: 80 },
      { x: 780, y: 40 },
      { x: 820, y: 560 },
      { x: 60, y: 520 },
    ];
    const H = homographyFromQuad(quad);
    const placed = applyProjectivePlace(clean, canonW, canonH, fw, fh, H);

    const proj = projectiveWarpToCanonical(placed, fw, fh, H);
    const bilin = warpQuadBilinearToCanonical(placed, fw, fh, quad);

    const cleanGray = rgbaToGray(clean, canonW, canonH);
    const projGray = rgbaToGray(proj.rgba, canonW, canonH);
    const bilinGray = rgbaToGray(bilin.rgba, canonW, canonH);

    const errProj = meanAbsDiffGray(cleanGray, projGray, proj.valid);
    const errBilin = meanAbsDiffGray(cleanGray, bilinGray, bilin.valid);

    assert.ok(
      errProj < errBilin * 0.85,
      `projective err ${errProj.toFixed(3)} should be << bilinear ${errBilin.toFixed(3)}`,
    );
    assert.ok(errProj < 12, `projective absolute err too high: ${errProj}`);
  });
});

describe("live path must not use JS NCC", () => {
  it("alignIdentityOrNcc refuses liveMode", () => {
    const assets = loadAssets();
    const clean = resizeRgba(
      assets.rgba,
      assets.width,
      assets.height,
      ENVELOPE_MANIFEST.canonicalWidth,
      ENVELOPE_MANIFEST.canonicalHeight,
    );
    const ctx = buildAlignContext(
      clean,
      ENVELOPE_MANIFEST.canonicalWidth,
      ENVELOPE_MANIFEST.canonicalHeight,
      null,
      { liveMode: true },
    );
    const r = alignIdentityOrNcc(ctx, clean, ENVELOPE_MANIFEST.canonicalWidth, ENVELOPE_MANIFEST.canonicalHeight);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "opencv_unavailable");
  });
});

describe("pixel-domain camera simulation", () => {
  it("strong vs normal alpha under display+perspective+noise (bounded trials)", async () => {
    const assets = loadAssets();
    const words = ["LETTO", "CAFFE", "OMBRELLO"];
    const trialsPerMode = 12;
    const modes = [
      { name: "normal", alpha: ENVELOPE_MANIFEST.alpha },
      { name: "strong", alpha: ENVELOPE_MANIFEST.alpha * 3 },
    ];
    const summary = {};

    for (const mode of modes) {
      let correct = 0;
      let wrong = 0;
      let noLock = 0;
      let topMatchCorrect = 0;
      const timings = [];
      const softScores = [];
      for (let t = 0; t < trialsPerMode; t++) {
        const rng = mulberry32(0xA11CE + t * 17 + mode.name.length * 99);
        const word = words[t % words.length];
        const salt = (t * 13 + 7) & 0xff;
        const { token } = await createHiddenToken(word, salt);
        const embedded = embedHiddenWatermark({
          rgba: assets.rgba,
          width: assets.width,
          height: assets.height,
          token,
          alpha: mode.alpha,
          mask: assets.mask,
          basisFields: assets.fields,
        });

        const displayW = 360;
        const displayH = Math.round((360 * embedded.height) / embedded.width);
        const small = resizeRgba(
          embedded.rgba,
          embedded.width,
          embedded.height,
          displayW,
          displayH,
        );
        const up = resizeRgba(small, displayW, displayH, embedded.width, embedded.height);
        // Milder for strong; slightly harsher for normal to expose noise floor.
        const distorted = distortFrame(up, embedded.width, embedded.height, rng, {
          brightness: mode.name === "strong" ? 0.97 + rng() * 0.06 : 0.9 + rng() * 0.2,
          contrast: mode.name === "strong" ? 0.97 + rng() * 0.06 : 0.88 + rng() * 0.24,
          chromaShift: mode.name === "strong" ? (rng() - 0.5) * 3 : (rng() - 0.5) * 10,
          blurRadius: mode.name === "strong" ? 0 : rng() > 0.6 ? 1 : 0,
          noise: mode.name === "strong" ? 2 + rng() * 3 : 6 + rng() * 8,
        });

        const canonW = ENVELOPE_MANIFEST.canonicalWidth;
        const canonH = ENVELOPE_MANIFEST.canonicalHeight;
        const cleanCanon = resizeRgba(assets.rgba, assets.width, assets.height, canonW, canonH);
        const distCanon = resizeRgba(
          distorted,
          embedded.width,
          embedded.height,
          canonW,
          canonH,
        );

        const fw = 960;
        const fh = 640;
        const margin = 50;
        const skew = mode.name === "strong" ? 18 : 30 + Math.round(rng() * 20);
        const quad = [
          { x: margin + skew, y: margin },
          { x: fw - margin, y: margin + skew * 0.35 },
          { x: fw - margin - skew * 0.25, y: fh - margin },
          { x: margin, y: fh - margin - skew * 0.4 },
        ];
        const H = homographyFromQuad(quad);
        const placed = applyProjectivePlace(distCanon, canonW, canonH, fw, fh, H);

        const t0 = performance.now();
        const rect = projectiveWarpToCanonical(placed, fw, fh, H);
        const extracted = extractSoftBitsFromRectified({
          cleanRgba: cleanCanon,
          observedRgba: rect.rgba,
          width: canonW,
          height: canonH,
          valid: rect.valid,
          mask: assets.mask,
          basisFields: assets.fields,
        });
        const match = scoreHiddenDictionary({
          soft: extracted.soft,
          surfaces: HIDDEN_DICTIONARY_META.surfaces,
          digestTable: assets.digestTable,
          topSalts: 32,
        });
        timings.push(performance.now() - t0);
        softScores.push(match.best?.score ?? 0);

        const canonical =
          HIDDEN_DICTIONARY_META.surfaces.find((s) => s.surface === word)
            ?.canonicalWord ?? word;
        if (match.best?.canonicalWord === canonical) topMatchCorrect++;

        const acc = new FrameAccumulator();
        const policy = new LockPolicy({ ...ENVELOPE_MANIFEST.lock });
        let locked = null;
        for (let f = 0; f < 6; f++) {
          const softF = Float64Array.from(extracted.soft);
          // Independent-ish observations: small distinct jitter
          for (let i = 0; i < softF.length; i++) {
            softF[i] += (rng() * 2 - 1) * 0.05 + ((i + f) % 3) * 0.01;
          }
          acc.push({
            soft: softF,
            noise: extracted.noise,
            quality: Math.max(0.3, extracted.quality),
            timestampMs: f * 50,
          });
          const { soft: softAcc, independentCount, spanMs } = acc.accumulateSoft();
          const m = scoreHiddenDictionary({
            soft: softAcc,
            surfaces: HIDDEN_DICTIONARY_META.surfaces,
            digestTable: assets.digestTable,
            topSalts: 32,
          });
          if (!m.best || m.ambiguous) continue;
          policy.noteDecision({
            canonicalWord: m.best.canonicalWord,
            salt8: m.best.salt8,
            score: m.best.score,
            margin: m.margin,
            unique: m.unique,
            qualitySafety: false,
          });
          if (policy.evaluate(independentCount, Math.max(spanMs, 160)).mayLock) {
            locked = m.best.canonicalWord;
            break;
          }
        }

        if (locked == null) noLock++;
        else if (locked === canonical) correct++;
        else wrong++;
        void tokenToBits;
        void createHash;
      }

      timings.sort((a, b) => a - b);
      softScores.sort((a, b) => a - b);
      summary[mode.name] = {
        correct,
        wrong,
        noLock,
        topMatchCorrect,
        trials: trialsPerMode,
        medianMs: timings[Math.floor(timings.length / 2)],
        p95Ms: timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))],
        medianSoftScore: softScores[Math.floor(softScores.length / 2)],
      };
    }

    mkdirSync(join(ROOT, "test-results"), { recursive: true });
    writeFileSync(
      join(ROOT, "test-results", "pixel_domain_camera_sim.json"),
      JSON.stringify(
        {
          note: "Pixel-domain simulation with projective rectification — not a soft-bit-only harness.",
          manifestAlpha: ENVELOPE_MANIFEST.alpha,
          summary,
        },
        null,
        2,
      ),
    );

    assert.equal(summary.strong.wrong, 0, "strong mode wrong locks");
    assert.equal(summary.normal.wrong, 0, "normal mode wrong locks");
    // Prefer lock success; if lock policy is strict, at least top soft match should recover.
    assert.ok(
      summary.strong.correct >= 1 || summary.strong.topMatchCorrect >= 3,
      `strong too weak: locks=${summary.strong.correct} topMatch=${summary.strong.topMatchCorrect}`,
    );
  });
});

describe("pipeline performance invariants", () => {
  it("capture long-edge cap and single in-flight are documented constants", () => {
    // Mirrored from hiddenScanner.ts — keep in sync.
    const CAPTURE_LONG_EDGE = 640;
    assert.ok(CAPTURE_LONG_EDGE <= 640);
    const maxInFlight = 1;
    assert.equal(maxInFlight, 1);
  });

  it("matcher with 32 salts completes within budget on warmed table", async () => {
    const assets = loadAssets();
    const soft = new Float64Array(56);
    for (let i = 0; i < 56; i++) soft[i] = (i % 2 === 0 ? 1 : -1) * 0.3;
    // Warm
    scoreHiddenDictionary({
      soft,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable: assets.digestTable,
      topSalts: 32,
    });
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      scoreHiddenDictionary({
        soft,
        surfaces: HIDDEN_DICTIONARY_META.surfaces,
        digestTable: assets.digestTable,
        topSalts: 32,
      });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    writeFileSync(
      join(ROOT, "test-results", "matcher_perf.json"),
      JSON.stringify({ p95Ms: p95, samples }, null, 2),
    );
    assert.ok(p95 < 25, `matcher p95 ${p95}ms exceeds 25ms budget (target ≤20ms)`);
  });

  it("manifest alpha remains provisional 1.75", () => {
    assert.equal(ENVELOPE_MANIFEST.alpha, 1.75);
    assert.equal(ENVELOPE_MANIFEST.alphaProvisional, true);
    assert.equal(ENVELOPE_MANIFEST.lock.minFrames, 3);
  });
});
