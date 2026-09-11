#!/usr/bin/env node
/**
 * Prepare Hidden-envelope carrier assets: verify PNG, build mask, basis checksum, manifest.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ASSET = join(ROOT, "src", "assets", "envelope", "envelope-base-v1.png");
const OUT_DIR = join(ROOT, "src", "generated");
const MASK_PATH = join(ROOT, "src", "assets", "envelope", "envelope-mask-v1.bin");

const EXPECTED_SHA256 =
  "3b070bf276e7b4f96061ea0216218792e3d7ff3a8ecfb7ed48d42fc362bfe8a0";
const CANONICAL_W = 768;
const CANONICAL_H = 512;
const GRID_W = 96;
const GRID_H = 64;
const GUARD = 0.04;
const MIN_COVERAGE = 0.35;

/** Provisional alpha until calibrate-alpha.mjs updates the committed value. */
const PROVISIONAL_ALPHA = 1.75;

const PROVISIONAL_LOCK = {
  provisional: true,
  // Calibrated for weight-normalized soft accumulation (per-frame soft domain).
  // Exact digital soft scores are typically ~6–8; summed-domain 8.0 is obsolete.
  minAbsConfidence: 4.5,
  minScoreMargin: 1.25,
  minFrames: 3,
  minSpanMs: 150,
  trackLossResetMs: 400,
};

async function loadBasisModule() {
  const outfile = join(ROOT, "test", ".bundle", "watermarkBasis.mjs");
  mkdirSync(dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [join(ROOT, "src", "shared", "watermarkBasis.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["es2020"],
    sourcemap: false,
  });
  return import(outfile);
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function buildMask(png) {
  const { width, height, data } = png;
  // Downsample to grid by averaging cell luminance stats.
  const weights = new Float32Array(GRID_W * GRID_H);
  const cellW = width / GRID_W;
  const cellH = height / GRID_H;

  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const gi = gy * GRID_W + gx;
      const gx0 = Math.floor(GRID_W * GUARD);
      const gy0 = Math.floor(GRID_H * GUARD);
      const gx1 = Math.ceil(GRID_W * (1 - GUARD)) - 1;
      const gy1 = Math.ceil(GRID_H * (1 - GUARD)) - 1;
      if (gx < gx0 || gx > gx1 || gy < gy0 || gy > gy1) {
        weights[gi] = 0;
        continue;
      }

      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.min(width, Math.floor((gx + 1) * cellW));
      const y1 = Math.min(height, Math.floor((gy + 1) * cellH));

      let sum = 0;
      let sum2 = 0;
      let count = 0;
      let clipped = 0;
      let nearBlack = 0;
      let gradAcc = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * width + x) * 4;
          const r = data[o];
          const g = data[o + 1];
          const b = data[o + 2];
          const yv = luminance(r, g, b);
          sum += yv;
          sum2 += yv * yv;
          count++;
          if (r >= 250 && g >= 250 && b >= 250) clipped++;
          if (yv < 12) nearBlack++;

          if (x + 1 < x1 && y + 1 < y1) {
            const oR = (y * width + (x + 1)) * 4;
            const oD = ((y + 1) * width + x) * 4;
            const yR = luminance(data[oR], data[oR + 1], data[oR + 2]);
            const yD = luminance(data[oD], data[oD + 1], data[oD + 2]);
            gradAcc += Math.abs(yR - yv) + Math.abs(yD - yv);
          }
        }
      }
      if (count === 0) {
        weights[gi] = 0;
        continue;
      }
      const mean = sum / count;
      const variance = Math.max(0, sum2 / count - mean * mean);
      const std = Math.sqrt(variance);
      const clipFrac = clipped / count;
      const blackFrac = nearBlack / count;
      const grad = gradAcc / Math.max(1, count);

      // Continuous weight: prefer textured paper; exclude clipped / flat / black.
      let w = 1;
      w *= Math.max(0, 1 - clipFrac * 4);
      w *= Math.max(0, 1 - blackFrac * 4);
      // Soft-threshold texture: std around 4–40 and gradient around 2–30.
      const tex = Math.min(1, std / 12) * Math.min(1, grad / 8);
      w *= tex;
      if (std < 1.5 && grad < 1.0) w = 0;
      weights[gi] = Math.max(0, Math.min(1, w));
    }
  }

  let coverageSum = 0;
  for (let i = 0; i < weights.length; i++) coverageSum += weights[i];
  const coverage = coverageSum / weights.length;
  return { weights, coverage };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const pngBytes = readFileSync(ASSET);
  const sha256 = createHash("sha256").update(pngBytes).digest("hex");
  if (sha256 !== EXPECTED_SHA256) {
    throw new Error(
      `Carrier SHA-256 mismatch.\n expected ${EXPECTED_SHA256}\n got      ${sha256}`,
    );
  }

  const png = PNG.sync.read(pngBytes);
  if (png.width !== 1536 || png.height !== 1024) {
    throw new Error(
      `Unexpected carrier dimensions ${png.width}x${png.height}; expected 1536x1024`,
    );
  }

  const mask = buildMask(png);
  if (mask.coverage < MIN_COVERAGE) {
    throw new Error(
      `Mask coverage ${(mask.coverage * 100).toFixed(1)}% < ${MIN_COVERAGE * 100}%`,
    );
  }

  const maskBuf = Buffer.from(mask.weights.buffer);
  writeFileSync(MASK_PATH, maskBuf);
  const maskSha256 = createHash("sha256").update(maskBuf).digest("hex");

  const basisMod = await loadBasisModule();
  const { fields, checksum } = basisMod.generateBasisFields({
    weights: mask.weights,
    coverage: mask.coverage,
  });

  // Also write basis fields binary for decoder/tests (56 * 96 * 64 float32).
  const basisBin = Buffer.alloc(56 * GRID_W * GRID_H * 4);
  for (let b = 0; b < 56; b++) {
    Buffer.from(fields[b].buffer).copy(basisBin, b * GRID_W * GRID_H * 4);
  }
  const basisPath = join(ROOT, "src", "assets", "envelope", "envelope-basis-v1.bin");
  writeFileSync(basisPath, basisBin);
  const basisFileSha = createHash("sha256").update(basisBin).digest("hex");

  const manifest = {
    carrierId: "envelope-v1",
    protocolId: "HENV1",
    basisVersion: 1,
    nativeWidth: png.width,
    nativeHeight: png.height,
    canonicalWidth: CANONICAL_W,
    canonicalHeight: CANONICAL_H,
    gridWidth: GRID_W,
    gridHeight: GRID_H,
    bitCount: 56,
    guardFraction: GUARD,
    pngSha256: sha256,
    maskSha256,
    basisChecksum: checksum,
    basisFileSha256: basisFileSha,
    maskCoverage: mask.coverage,
    alpha: PROVISIONAL_ALPHA,
    alphaProvisional: true,
    yCbCr: "BT.601-fullrange-centered128",
    lock: PROVISIONAL_LOCK,
    assetPaths: {
      png: "assets/envelope/envelope-base-v1.png",
      mask: "assets/envelope/envelope-mask-v1.bin",
      basis: "assets/envelope/envelope-basis-v1.bin",
    },
  };

  writeFileSync(
    join(OUT_DIR, "envelopeManifest.ts"),
    `/* Auto-generated by scripts/prepare-carrier.mjs — do not edit by hand for hashes. */\n` +
      `export const ENVELOPE_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n` +
      `export type EnvelopeManifest = typeof ENVELOPE_MANIFEST;\n`,
  );

  console.log(
    `Carrier OK ${png.width}x${png.height} maskCoverage=${(mask.coverage * 100).toFixed(1)}% basis=${checksum} alpha=${PROVISIONAL_ALPHA}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
