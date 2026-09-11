/**
 * Deterministic AENV1 channel simulator + calibration sweep.
 * Run: npm run test:audio-channel
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHiddenToken, tokenToHex } from "./.bundle/hiddenEnvelopeProtocol.mjs";
import { renderAudioSeal } from "./.bundle/renderAudioSeal.mjs";
import { decodeAudioSealBuffer } from "./.bundle/decodeAudioSeal.mjs";
import { HIDDEN_DICTIONARY_META } from "./.bundle/hiddenDictionaryMeta.mjs";
import { WATERMARK_DB_PROVISIONAL } from "./.bundle/audioSealConstants.mjs";
import { resampleToCanonical } from "./.bundle/resample.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const digestTable = readFileSync(
  join(ROOT, "src", "generated", "hiddenDigestTable.bin"),
);

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyGain(buf, db) {
  const g = Math.pow(10, db / 20);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] * g;
  return out;
}

function addNoise(buf, snrDb, rng, pink = false) {
  let signalPower = 0;
  for (let i = 0; i < buf.length; i++) signalPower += buf[i] * buf[i];
  signalPower /= buf.length;
  const noisePower = signalPower / Math.pow(10, snrDb / 20);
  // snrDb is treated as amplitude-ish ratio for simplicity; use power:
  const np = signalPower / Math.pow(10, snrDb / 10);
  const sigma = Math.sqrt(np || 1e-12);
  const out = new Float32Array(buf.length);
  let b0 = 0;
  for (let i = 0; i < buf.length; i++) {
    let n = (rng() * 2 - 1) * sigma * Math.sqrt(3);
    if (pink) {
      b0 = 0.98 * b0 + 0.02 * n;
      n = b0;
    }
    out[i] = buf[i] + n;
  }
  void noisePower;
  return out;
}

function softClip(buf, drive = 2) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] * drive;
    out[i] = x / (1 + Math.abs(x));
  }
  return out;
}

function hardClipPct(buf, pct = 0.01) {
  const out = Float32Array.from(buf);
  const n = Math.floor(buf.length * pct);
  for (let i = 0; i < n; i++) {
    const idx = (i * 9973) % buf.length;
    out[idx] = Math.sign(out[idx] || 1);
  }
  return out;
}

function dropout(buf, rng, ms = 15) {
  const out = Float32Array.from(buf);
  const len = Math.round((ms / 1000) * 48000);
  const start = Math.floor(rng() * Math.max(1, out.length - len));
  for (let i = 0; i < len; i++) out[start + i] = 0;
  return out;
}

function timeScale(buf, scale) {
  const outLen = Math.round(buf.length / scale);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * scale;
    const i0 = Math.floor(src);
    const i1 = Math.min(buf.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = buf[i0] * (1 - f) + buf[i1] * f;
  }
  return out;
}

function onePoleHP(buf, alpha) {
  const out = new Float32Array(buf.length);
  let xPrev = 0;
  let yPrev = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = alpha * (yPrev + x - xPrev);
    out[i] = y;
    xPrev = x;
    yPrev = y;
  }
  return out;
}

function onePoleLP(buf, alpha) {
  const out = new Float32Array(buf.length);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += alpha * (buf[i] - y);
    out[i] = y;
  }
  return out;
}

function echo(buf, delayMs, decay = 0.35) {
  const d = Math.round((delayMs / 1000) * 48000);
  const out = Float32Array.from(buf);
  for (let i = d; i < out.length; i++) out[i] += buf[i - d] * decay;
  return out;
}

const WORDS = ["LETTO", "CAFFE", "TAVOLO", "SEDIA", "LIBRO"];
const WATERMARK_SWEEP = [-30, -26, -22, -20, -18, -16, -14, -12];

async function runMildTrial(seed, watermarkDb) {
  const rng = mulberry32(seed ^ 0xabcdef);
  const word = WORDS[Math.floor(rng() * WORDS.length)];
  const salt = Math.floor(rng() * 256);
  const tok = await createHiddenToken(word, salt);
  const rendered = await renderAudioSeal({
    token: tok.token,
    watermarkDb,
    cover: { seed: (seed * 2654435761) >>> 0 },
  });
  let x = rendered.mixed;
  // Mild: modest gain + very light AWGN only (SNR ≥ 40 dB).
  x = applyGain(x, -6 + rng() * 6);
  x = addNoise(x, 40 + rng() * 10, rng, false);
  const t0 = performance.now();
  const result = decodeAudioSealBuffer({
    samples: x,
    surfaces: HIDDEN_DICTIONARY_META.surfaces,
    digestTable,
    allowShort: true,
  });
  return {
    ok: result.ok,
    tokenOk: result.ok && result.tokenHex === tokenToHex(tok.token),
    wrongLock: result.ok && result.match?.canonicalWord !== tok.normalizedWord,
    decodeMs: performance.now() - t0,
  };
}

async function runCleanTrial(seed, watermarkDb) {
  const word = WORDS[seed % WORDS.length];
  const salt = seed % 256;
  const tok = await createHiddenToken(word, salt);
  const rendered = await renderAudioSeal({
    token: tok.token,
    watermarkDb,
    cover: { seed: seed >>> 0 },
  });
  const t0 = performance.now();
  const result = decodeAudioSealBuffer({
    samples: rendered.mixed,
    surfaces: HIDDEN_DICTIONARY_META.surfaces,
    digestTable,
    allowShort: true,
  });
  return {
    tokenOk: result.ok && result.tokenHex === tokenToHex(tok.token),
    wrongLock: result.ok && result.match?.canonicalWord !== tok.normalizedWord,
    decodeMs: result.ok ? result.decodeMs : performance.now() - t0,
  };
}

async function runTrial(seed, watermarkDb) {
  const rng = mulberry32(seed);
  const word = WORDS[Math.floor(rng() * WORDS.length)];
  const salt = Math.floor(rng() * 256);
  const tok = await createHiddenToken(word, salt);
  const rendered = await renderAudioSeal({
    token: tok.token,
    watermarkDb,
    cover: { seed: (seed * 2654435761) >>> 0 },
  });
  let x = rendered.mixed;

  const gainDb = -30 + rng() * 36; // -30..+6
  x = applyGain(x, gainDb);

  const snrChoices = [0, 5, 10, 15, 20, 30];
  const snr = snrChoices[Math.floor(rng() * snrChoices.length)];
  x = addNoise(x, snr, rng, rng() > 0.5);

  if (rng() > 0.5) x = onePoleLP(x, 0.15 + rng() * 0.5);
  if (rng() > 0.5) x = onePoleHP(x, 0.9 + rng() * 0.09);
  if (rng() > 0.6) x = echo(x, 10 + rng() * 140, 0.15 + rng() * 0.35);
  if (rng() > 0.7) {
    // 44.1 round trip
    const down = resampleLinear(x, 48000, 44100);
    x = resampleToCanonical(down, 44100);
  }
  if (rng() > 0.5) {
    const scales = [0.995, 0.9975, 1.0, 1.0025, 1.005];
    x = timeScale(x, scales[Math.floor(rng() * scales.length)]);
  }
  if (rng() > 0.7) x = softClip(x, 1.5 + rng());
  if (rng() > 0.85) x = hardClipPct(x, 0.01);
  if (rng() > 0.7) x = dropout(x, rng, 5 + rng() * 25);

  const t0 = performance.now();
  const result = decodeAudioSealBuffer({
    samples: x,
    surfaces: HIDDEN_DICTIONARY_META.surfaces,
    digestTable,
    allowShort: true,
  });
  const decodeMs = performance.now() - t0;
  return {
    ok: result.ok,
    wordOk: result.ok && result.match?.canonicalWord === tok.normalizedWord,
    tokenOk: result.ok && result.tokenHex === tokenToHex(tok.token),
    wrongLock: result.ok && result.match?.canonicalWord !== tok.normalizedWord,
    failReason: result.ok ? null : result.failReason,
    decodeMs,
    watermarkDb,
    snr,
    gainDb,
  };
}

function resampleLinear(input, fromRate, toRate) {
  const outLen = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

async function main() {
  const trials = Number(process.env.AENV_TRIALS || 1000);
  console.log(`AENV1 channel simulator: ${trials} harsh trials…`);

  // Clean + mild gates at provisional watermark
  let cleanOk = 0;
  let mildOk = 0;
  let mildWrong = 0;
  const mildN = 100;
  const cleanN = 56;
  const cleanTimes = [];
  for (let i = 0; i < cleanN; i++) {
    const r = await runCleanTrial(3000 + i, WATERMARK_DB_PROVISIONAL);
    if (r.tokenOk) cleanOk++;
    if (r.wrongLock) mildWrong++;
    cleanTimes.push(r.decodeMs);
  }
  for (let i = 0; i < mildN; i++) {
    const r = await runMildTrial(4000 + i, WATERMARK_DB_PROVISIONAL);
    if (r.tokenOk) mildOk++;
    if (r.wrongLock) mildWrong++;
  }
  cleanTimes.sort((a, b) => a - b);
  console.log(`clean ${cleanOk}/${cleanN}; mild ${mildOk}/${mildN}`);

  // Calibration sweep (smaller, harsh impairments)
  const calib = [];
  for (const db of WATERMARK_SWEEP) {
    let ok = 0;
    const n = 20;
    for (let i = 0; i < n; i++) {
      const r = await runTrial(10000 + db * 100 + i, db);
      if (r.tokenOk) ok++;
    }
    calib.push({ watermarkDb: db, trials: n, tokenOk: ok, rate: ok / n });
    console.log(`calib db=${db}: ${ok}/${n}`);
  }

  let wrong = 0;
  let tokenOk = 0;
  let wordOk = 0;
  let preambleFail = 0;
  let crcFail = 0;
  const decodeTimes = [];
  for (let i = 0; i < trials; i++) {
    const r = await runTrial(200000 + i, WATERMARK_DB_PROVISIONAL);
    if (r.tokenOk) tokenOk++;
    if (r.wordOk) wordOk++;
    if (r.wrongLock) wrong++;
    if (r.failReason === "no_preamble") preambleFail++;
    if (r.failReason === "crc") crcFail++;
    decodeTimes.push(r.decodeMs);
    if ((i + 1) % 100 === 0) console.log(`… ${i + 1}/${trials}`);
  }
  decodeTimes.sort((a, b) => a - b);
  const p50 = decodeTimes[Math.floor(decodeTimes.length * 0.5)];
  const p95 = decodeTimes[Math.floor(decodeTimes.length * 0.95)];

  const report = {
    provisionalWatermarkDb: WATERMARK_DB_PROVISIONAL,
    clean: {
      trials: cleanN,
      tokenOk: cleanOk,
      rate: cleanOk / cleanN,
      decodeMsP50: cleanTimes[Math.floor(cleanTimes.length * 0.5)],
      decodeMsP95: cleanTimes[Math.floor(cleanTimes.length * 0.95)],
    },
    mild: {
      trials: mildN,
      tokenOk: mildOk,
      rate: mildOk / mildN,
      wrongLocks: mildWrong,
    },
    harsh: {
      trials,
      tokenOk,
      wordOk,
      wrongLocks: wrong,
      preambleFail,
      crcFail,
      tokenRate: tokenOk / trials,
      wordRate: wordOk / trials,
      detectRate: (trials - preambleFail) / trials,
      decodeMsP50: p50,
      decodeMsP95: p95,
    },
    calibrationHarsh: calib,
    note: "Provisional; do not auto-commit stronger watermarkDb. Harsh tier uses stacked impairments.",
  };

  const outDir = join(ROOT, "docs");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "AUDIO_CHANNEL_REPORT.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${outPath}`);
  if (wrong > 0 || mildWrong > 0) process.exitCode = 2;
  if (cleanOk < cleanN) process.exitCode = 3;
}

await main();
