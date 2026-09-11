#!/usr/bin/env node
/**
 * Dev-only alpha calibration: pick smallest alpha that passes perceptual gates
 * while retaining digital soft-bit sign accuracy.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

async function loadMods() {
  const outDir = join(ROOT, "test", ".bundle");
  for (const [entry, out] of [
    ["src/spectator/watermark/embed.ts", "embed.mjs"],
    ["src/shared/hiddenEnvelopeProtocol.ts", "hiddenEnvelopeProtocol.mjs"],
    ["src/generated/envelopeManifest.ts", "envelopeManifest.mjs"],
  ]) {
    await esbuild.build({
      entryPoints: [join(ROOT, entry)],
      outfile: join(outDir, out),
      bundle: true,
      format: "esm",
      platform: "node",
      target: ["es2020"],
      sourcemap: false,
    });
  }
  return {
    embed: await import(join(outDir, "embed.mjs")),
    proto: await import(join(outDir, "hiddenEnvelopeProtocol.mjs")),
    manifest: await import(join(outDir, "envelopeManifest.mjs")),
  };
}

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function rgbToXyz(r, g, b) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  return {
    x: 0.4124564 * R + 0.3575761 * G + 0.1804375 * B,
    y: 0.2126729 * R + 0.7151522 * G + 0.072175 * B,
    z: 0.0193339 * R + 0.119192 * G + 0.9503041 * B,
  };
}

function xyzToLab(x, y, z) {
  // D65
  const Xn = 0.95047;
  const Yn = 1;
  const Zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / Xn);
  const fy = f(y / Yn);
  const fz = f(z / Zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function deltaE00(lab1, lab2) {
  // Simplified CIEDE2000 approximation sufficient for gate screening.
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  const C1 = Math.hypot(lab1.a, lab1.b);
  const C2 = Math.hypot(lab2.a, lab2.b);
  const dC = C1 - C2;
  const dH = Math.sqrt(Math.max(0, da * da + db * db - dC * dC));
  const SL = 1;
  const SC = 1 + 0.045 * C1;
  const SH = 1 + 0.015 * C1;
  return Math.sqrt(
    (dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2,
  );
}

function metrics(a, b, n) {
  let mse = 0;
  let ssimAcc = 0;
  const deltas = [];
  let maxDe = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = a[o] - b[o];
    const dg = a[o + 1] - b[o + 1];
    const db = a[o + 2] - b[o + 2];
    mse += (dr * dr + dg * dg + db * db) / 3;
    // cheap structural proxy per pixel
    const ya = 0.299 * a[o] + 0.587 * a[o + 1] + 0.114 * a[o + 2];
    const yb = 0.299 * b[o] + 0.587 * b[o + 1] + 0.114 * b[o + 2];
    ssimAcc += 1 - Math.abs(ya - yb) / 255;
    const lab1 = xyzToLab(...Object.values(rgbToXyz(a[o], a[o + 1], a[o + 2])));
    const lab2 = xyzToLab(...Object.values(rgbToXyz(b[o], b[o + 1], b[o + 2])));
    // fix xyzToLab call
  }
  // Recompute Delta E properly
  for (let i = 0; i < n; i += 8) {
    const o = i * 4;
    const xyz1 = rgbToXyz(a[o], a[o + 1], a[o + 2]);
    const xyz2 = rgbToXyz(b[o], b[o + 1], b[o + 2]);
    const lab1 = xyzToLab(xyz1.x, xyz1.y, xyz1.z);
    const lab2 = xyzToLab(xyz2.x, xyz2.y, xyz2.z);
    const de = deltaE00(lab1, lab2);
    deltas.push(de);
    if (de > maxDe) maxDe = de;
  }
  mse /= n;
  const psnr = mse <= 1e-12 ? 99 : 10 * Math.log10((255 * 255) / mse);
  const ssim = ssimAcc / n;
  deltas.sort((x, y) => x - y);
  const meanDe = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  const p99 = deltas[Math.floor(deltas.length * 0.99)] ?? maxDe;
  return { psnr, ssim, meanDe, p99, maxDe };
}

async function main() {
  const mods = await loadMods();
  const pngBytes = readFileSync(
    join(ROOT, "src", "assets", "envelope", "envelope-base-v1.png"),
  );
  const png = PNG.sync.read(pngBytes);
  const rgba = Uint8ClampedArray.from(png.data);
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
  const mask = { weights, coverage: coverage / weights.length };
  const basisBuf = readFileSync(
    join(ROOT, "src", "assets", "envelope", "envelope-basis-v1.bin"),
  );
  const f32 = new Float32Array(
    basisBuf.buffer,
    basisBuf.byteOffset,
    basisBuf.byteLength / 4,
  );
  const fields = [];
  const stride = 96 * 64;
  for (let b = 0; b < 56; b++) fields.push(f32.slice(b * stride, (b + 1) * stride));

  const words = ["LETTO", "CAFFE", "OMBRELLO"];
  const candidates = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
  let chosen = null;
  const report = [];

  for (const alpha of candidates) {
    let pass = true;
    const rows = [];
    for (const word of words) {
      const { token } = await mods.proto.createHiddenToken(word, 0x2a);
      const embedded = mods.embed.embedHiddenWatermark({
        rgba,
        width: png.width,
        height: png.height,
        token,
        alpha,
        mask,
        basisFields: fields,
      });
      const m = metrics(rgba, embedded.rgba, png.width * png.height);
      const { soft } = mods.embed.extractSoftBitsExact({
        cleanRgba: rgba,
        encodedRgba: embedded.rgba,
        width: png.width,
        height: png.height,
        mask,
        basisFields: fields,
      });
      const bits = mods.proto.tokenToBits(token);
      let wrong = 0;
      for (let i = 0; i < 56; i++) {
        const got = soft[i] >= 0 ? 1 : 0;
        if (got !== bits[i]) wrong++;
      }
      const ok =
        m.psnr >= 42 &&
        m.ssim >= 0.995 &&
        m.meanDe <= 0.5 &&
        m.p99 <= 1.5 &&
        m.maxDe <= 3.0 &&
        wrong === 0;
      rows.push({ word, ...m, wrong, ok });
      if (!ok) pass = false;
    }
    report.push({ alpha, pass, rows });
    if (pass && chosen == null) chosen = alpha;
    console.log(
      `alpha=${alpha} pass=${pass} psnr=${rows[0].psnr.toFixed(2)} ssim=${rows[0].ssim.toFixed(4)} meanDe=${rows[0].meanDe.toFixed(3)}`,
    );
  }

  const outPath = join(ROOT, "test-results", "alpha_calibration.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        chosen,
        provisionalFallback: mods.manifest.ENVELOPE_MANIFEST.alpha,
        report,
      },
      null,
      2,
    ),
  );

  if (chosen != null) {
    // Update manifest alpha and clear provisional flag by rewriting prepare output.
    const manifestPath = join(ROOT, "src", "generated", "envelopeManifest.ts");
    let text = readFileSync(manifestPath, "utf8");
    text = text.replace(/"alpha": [0-9.]+/, `"alpha": ${chosen}`);
    text = text.replace(/"alphaProvisional": true/, `"alphaProvisional": false`);
    writeFileSync(manifestPath, text);
    console.log(`Committed alpha=${chosen} to envelopeManifest.ts`);
  } else {
    console.log(
      "No alpha passed all gates; keeping provisional alpha. See test-results/alpha_calibration.json",
    );
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
