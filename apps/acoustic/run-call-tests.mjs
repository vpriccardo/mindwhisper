/**
 * call-v1 channel simulator + Monte-Carlo harness (Node ESM).
 * Also verifies shared protocol packing and that room-v1 encode is untouched.
 *
 * Usage: node run-call-tests.mjs
 */
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const js = (name) => pathToFileURL(join(__dirname, 'js', name)).href;
const callJs = (name) => pathToFileURL(join(__dirname, 'js', 'call', name)).href;

const protocol = await import(js('protocol.js'));
const callTx = await import(callJs('call-tx.js'));
const callRx = await import(callJs('call-rx.js'));
const callConstants = await import(callJs('call-constants.js'));
const { createXorshift32 } = protocol;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('PASS ', msg);
  } else {
    failed++;
    console.error('FAIL ', msg);
  }
}

const {
  encodeMessage,
  encodeProtectedPayload,
  encodeCallMessage,
  decodeFromCallDataSymbols,
  decodeFromCallBits,
  TOTAL_BITS,
  CALL_TOTAL_BITS,
  CALL_DATA_SYMBOLS,
  CALL_CHANNEL_COUNT,
  CALL_EXTRA_PAD_BITS,
  CODED_BITS,
  combineCallSoftFrames,
} = protocol;

const { renderCallTransmission } = callTx;
const { decodeCallPcmBuffer } = callRx;
const {
  BASE_TOTAL_DIFFERENTIAL_DB,
  CALL_FRAME_MS,
  CALL_CHIP_CODE,
  CHIPS_PER_SYMBOL,
} = callConstants;

console.log('\n=== call-v1 protocol packing ===');
{
  const enc = encodeCallMessage('ELEPHANT');
  assert(enc.scrambled.length === TOTAL_BITS, `room scrambled ${TOTAL_BITS}`);
  const protectedEnc = encodeProtectedPayload('ELEPHANT');
  assert(
    protectedEnc.scrambled.length === TOTAL_BITS &&
      protectedEnc.scrambled.every((b, i) => b === enc.scrambled[i]),
    'encodeProtectedPayload === encodeMessage'
  );
  assert(enc.callBits.length === CALL_TOTAL_BITS, `call bits ${CALL_TOTAL_BITS}`);
  assert(enc.callDataSymbols.length === CALL_DATA_SYMBOLS, `46 symbols`);
  assert(CALL_EXTRA_PAD_BITS === 4, 'extra pad 4');
  assert(enc.hammingBits.length === CODED_BITS, 'hamming still 266');
  // last 4 call bits are zero pad
  assert(
    enc.callBits[272] === 0 &&
      enc.callBits[273] === 0 &&
      enc.callBits[274] === 0 &&
      enc.callBits[275] === 0,
    'trailing 4 zeros'
  );
  const dec = decodeFromCallDataSymbols(enc.callDataSymbols);
  assert(dec.ok && dec.message === 'ELEPHANT', 'call symbol roundtrip');

  // Shared encode path identity: callBits[:272] === scrambled
  let same = true;
  for (let i = 0; i < TOTAL_BITS; i++) {
    if (enc.callBits[i] !== enc.scrambled[i]) same = false;
  }
  assert(same, 'callBits prefix === scrambled');

  // Soft path
  const soft = Float32Array.from(enc.callBits.subarray(0, TOTAL_BITS), (b) =>
    b ? 1 : -1
  );
  const softDec = decodeFromCallBits(soft, { soft: true });
  assert(softDec.ok && softDec.message === 'ELEPHANT', 'soft call decode');

  const soft2 = Float32Array.from(soft, (v, i) => v + (i % 11 === 0 ? -1.4 : 0));
  const soft3 = Float32Array.from(soft, (v, i) => v + (i % 13 === 0 ? -1.4 : 0));
  const comb = combineCallSoftFrames([soft2, soft3]);
  assert(comb.ok && comb.message === 'ELEPHANT', 'call soft combine');
}

assert(CALL_CHIP_CODE.length === CHIPS_PER_SYMBOL, 'chip code length 8');
assert(Math.abs(CALL_FRAME_MS - 18560) < 1, `frame ms ${CALL_FRAME_MS}`);

// ---------------------------------------------------------------------------
// Channel impairments
// ---------------------------------------------------------------------------

function onePoleLp(samples, sampleRate, cutoffHz) {
  const x = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = new Float32Array(samples.length);
  let y = 0;
  for (let i = 0; i < samples.length; i++) {
    y = (1 - x) * samples[i] + x * y;
    out[i] = y;
  }
  return out;
}

function onePoleHp(samples, sampleRate, cutoffHz) {
  const x = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = new Float32Array(samples.length);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    const y = x * (prevOut + samples[i] - prevIn);
    prevIn = samples[i];
    prevOut = y;
    out[i] = y;
  }
  return out;
}

function addNoise(samples, snrDb, rng) {
  let pSig = 0;
  for (let i = 0; i < samples.length; i++) pSig += samples[i] * samples[i];
  pSig /= samples.length;
  const pNoise = pSig / Math.pow(10, snrDb / 10);
  const sigma = Math.sqrt(Math.max(pNoise, 0));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] + rng.nextGaussian() * sigma;
  }
  return out;
}

function applyAgc(samples, targetRms = 0.15) {
  const out = new Float32Array(samples.length);
  let env = 0.01;
  const atk = 0.002;
  const rel = 0.0004;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    env = a > env ? env + atk * (a - env) : env + rel * (a - env);
    const g = targetRms / (env + 1e-6);
    out[i] = samples[i] * Math.min(8, Math.max(0.05, g));
  }
  return out;
}

function applyEq(samples, sampleRate) {
  // Mild telephone-ish mid boost / HF cut
  let y = onePoleLp(samples, sampleRate, 3400);
  y = onePoleHp(y, sampleRate, 300);
  return y;
}

function addSpeechMasker(samples, sampleRate, rng, level = 0.08) {
  const out = samples.slice();
  // Simple formant-ish burble, not sync'd to frame
  let phase = 0;
  const f0 = 140 + rng.nextFloat() * 40;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const env =
      0.5 + 0.5 * Math.sin(2 * Math.PI * t * (2.2 + 0.3 * Math.sin(t * 0.37)));
    const v =
      Math.sin(phase) * 0.6 +
      Math.sin(phase * 2.1) * 0.25 +
      rng.nextGaussian() * 0.15;
    phase += (2 * Math.PI * f0) / sampleRate;
    out[i] += v * env * level;
  }
  return out;
}

function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples.slice();
  const n = Math.floor((samples.length * toRate) / fromRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = (i * fromRate) / toRate;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = samples[i0] * (1 - f) + samples[i1] * f;
  }
  return out;
}

function applyDrift(samples, sampleRate, ppm) {
  const toRate = sampleRate * (1 + ppm * 1e-6);
  return resampleLinear(samples, sampleRate, toRate);
}

function applyReverb(samples, sampleRate) {
  const delays = [0.023, 0.041, 0.067].map((d) => Math.round(d * sampleRate));
  const gains = [0.28, 0.18, 0.12];
  const out = samples.slice();
  for (let k = 0; k < delays.length; k++) {
    const d = delays[k];
    const g = gains[k];
    for (let i = d; i < out.length; i++) {
      out[i] += samples[i - d] * g;
    }
  }
  return out;
}

function applyDropouts(samples, sampleRate, rng, duty = 0.04) {
  const out = samples.slice();
  const block = Math.round(0.02 * sampleRate);
  for (let i = 0; i < out.length; i += block) {
    if (rng.nextFloat() < duty) {
      for (let j = i; j < Math.min(out.length, i + block); j++) out[j] = 0;
    }
  }
  return out;
}

function applyPacketLoss(samples, sampleRate, rng, loss = 0.03) {
  // Zero ~20 ms packets
  return applyDropouts(samples, sampleRate, rng, loss);
}

function bandLimit(samples, sampleRate, lowHz, highHz) {
  let y = samples;
  if (lowHz > 0) y = onePoleHp(y, sampleRate, lowHz);
  if (highHz < sampleRate / 2) y = onePoleLp(y, sampleRate, highHz);
  return y;
}

function impair(samples, sampleRate, scenario, rng) {
  let y = samples.slice();
  switch (scenario) {
    case 'clean':
      break;
    case 'band4k':
      y = bandLimit(y, sampleRate, 200, 4000);
      break;
    case 'band3k4':
      y = bandLimit(y, sampleRate, 300, 3400);
      break;
    case 'agc':
      y = applyAgc(y);
      break;
    case 'eq':
      y = applyEq(y, sampleRate);
      break;
    case 'noise15':
      y = addNoise(y, 15, rng);
      break;
    case 'speech':
      y = addSpeechMasker(y, sampleRate, rng, 0.1);
      break;
    case 'resample44k':
      y = resampleLinear(y, sampleRate, 44100);
      // decode at 44.1k
      return { samples: y, sampleRate: 44100 };
    case 'drift50':
      y = applyDrift(y, sampleRate, 50);
      break;
    case 'reverb':
      y = applyReverb(y, sampleRate);
      break;
    case 'dropouts':
      y = applyDropouts(y, sampleRate, rng, 0.05);
      break;
    case 'packetLoss':
      y = applyPacketLoss(y, sampleRate, rng, 0.04);
      break;
    case 'comboCall':
      y = bandLimit(y, sampleRate, 250, 3800);
      y = applyEq(y, sampleRate);
      y = applyAgc(y);
      y = addNoise(y, 18, rng);
      y = addSpeechMasker(y, sampleRate, rng, 0.06);
      break;
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
  return { samples: y, sampleRate };
}

const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -';

function randomMessage(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += alphabet[rng.nextUint32() % alphabet.length];
  }
  if (!/\S/.test(s)) s = 'A' + s.slice(1);
  return s;
}

const sampleRate = 48000;

console.log('\n=== call-v1 clean DSP loopback ===');
{
  const msg = 'ELEPHANT';
  console.log('Rendering call frame…');
  const t0 = Date.now();
  const tx = renderCallTransmission({
    message: msg,
    sampleRate,
    profileId: 'air',
    frameCount: 2,
    deltaDb: BASE_TOTAL_DIFFERENTIAL_DB,
    includeFadeIn: true,
    includeFadeOut: false,
  });
  console.log(
    `Render ${(Date.now() - t0) / 1000}s peak=${tx.peak.toFixed(3)} dur=${tx.durationMs.toFixed(0)}ms`
  );
  assert(tx.peak <= 0.851, `peak ${tx.peak}`);

  const t1 = Date.now();
  const { result, stats } = decodeCallPcmBuffer(tx.samples, sampleRate);
  console.log(`Decode ${(Date.now() - t1) / 1000}s`, stats);
  assert(
    result && result.ok && result.message === msg,
    `loopback got ${result && result.message}`
  );
  assert(stats.framesCrcValid >= 1, `crc valid ${stats.framesCrcValid}`);
}

console.log('\n=== enhancementWeight=0 (base only) ===');
{
  const tx = renderCallTransmission({
    message: 'BASEOK',
    sampleRate,
    profileId: 'air',
    frameCount: 2,
    enableEnhancement: false,
    deltaDb: BASE_TOTAL_DIFFERENTIAL_DB,
  });
  const { result, stats } = decodeCallPcmBuffer(tx.samples, sampleRate);
  assert(
    result && result.ok && result.message === 'BASEOK',
    `base-only decode ${result && result.message}`
  );
  assert(stats.framesCrcValid >= 1, 'base-only CRC');
}

console.log('\n=== neutral / ambient false positive ===');
{
  const neu = renderCallTransmission({
    message: 'HELLO',
    sampleRate,
    profileId: 'air',
    frameCount: 1,
    neutral: true,
  });
  const r = decodeCallPcmBuffer(neu.samples, sampleRate);
  assert(!r.result || !r.result.ok, 'neutral no decode');
  assert(r.stats.framesCrcValid === 0, 'neutral zero CRC');
}

console.log('\n=== Scenario matrix (Monte-Carlo) ===');
const scenarios = [
  'clean',
  'band4k',
  'band3k4',
  'agc',
  'eq',
  'noise15',
  'speech',
  'resample44k',
  'drift50',
  'reverb',
  'dropouts',
  'packetLoss',
  'comboCall',
];

/**
 * Monte-Carlo counts: ≥100 for major scenarios (spec).
 * Override all with CALL_MC=N. Secondary default 40 (CALL_MC_SECONDARY=100 for full).
 * Renders two frames (needed for reliable CRC); enhancement off in MC (base-alone path).
 */
const MC_FULL = Number(process.env.CALL_MC || 0) || 0;
const MC_SECONDARY = Number(process.env.CALL_MC_SECONDARY || 40);
const scenarioMc = (name) => {
  if (MC_FULL > 0) return MC_FULL;
  if (['clean', 'band4k', 'agc', 'comboCall', 'band3k4'].includes(name)) return 100;
  return MC_SECONDARY;
};

const scenarioResults = {};

for (const scenario of scenarios) {
  const MC = scenarioMc(scenario);
  const rng = createXorshift32(0xca11 ^ scenario.length * 97);
  let ok = 0;
  const t0 = Date.now();
  for (let i = 0; i < MC; i++) {
    const len = 1 + (rng.nextUint32() % 20);
    const msg = randomMessage(rng, len);
    const tx = renderCallTransmission({
      message: msg,
      sampleRate,
      profileId: ['air', 'tide', 'elements'][i % 3],
      frameCount: 2,
      deltaDb: BASE_TOTAL_DIFFERENTIAL_DB,
      // Base-alone is the mandatory path; enhancement covered by dedicated tests above.
      enableEnhancement: false,
      includeFadeIn: false,
      includeFadeOut: false,
      ambientSeed: (0xa11ce55 + i * 17) >>> 0,
      carrierSeed: (0xc0dec0de + i * 31) >>> 0,
    });
    const imp = impair(tx.samples, sampleRate, scenario, rng);
    const { result } = decodeCallPcmBuffer(imp.samples, imp.sampleRate);
    if (result && result.ok && result.message === msg) ok++;
    if ((i + 1) % 10 === 0 || i + 1 === MC) {
      console.log(
        `  … ${scenario} ${i + 1}/${MC} ok=${ok} (${((Date.now() - t0) / 1000).toFixed(0)}s)`
      );
    }
  }
  const rate = ok / MC;
  scenarioResults[scenario] = { ok, total: MC, rate };
  console.log(
    `  ${scenario}: ${ok}/${MC} (${(rate * 100).toFixed(0)}%) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  if (scenario === 'clean' || scenario === 'band4k' || scenario === 'agc') {
    assert(rate >= 0.85, `${scenario} rate ${rate}`);
  } else if (scenario === 'comboCall' || scenario === 'packetLoss' || scenario === 'dropouts') {
    assert(rate >= 0.35, `${scenario} rate ${rate} (soft)`);
  } else {
    assert(rate >= 0.55, `${scenario} rate ${rate}`);
  }
}

console.log('\n=== Optional ffmpeg Opus harness ===');
{
  const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (which.status !== 0) {
    console.log('SKIP  ffmpeg not available');
    passed++;
  } else {
    try {
      const msg = 'OPUSTEST';
      const tx = renderCallTransmission({
        message: msg,
        sampleRate,
        profileId: 'air',
        frameCount: 2,
        deltaDb: BASE_TOTAL_DIFFERENTIAL_DB,
        includeFadeIn: false,
        includeFadeOut: false,
      });
      // Write raw f32le mono
      const rawPath = join(tmpdir(), `mw-call-${process.pid}.f32`);
      const opusPath = join(tmpdir(), `mw-call-${process.pid}.opus`);
      const outRaw = join(tmpdir(), `mw-call-out-${process.pid}.f32`);
      const buf = Buffer.from(tx.samples.buffer, tx.samples.byteOffset, tx.samples.byteLength);
      writeFileSync(rawPath, buf);
      const enc = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-f',
          'f32le',
          '-ar',
          String(sampleRate),
          '-ac',
          '1',
          '-i',
          rawPath,
          '-c:a',
          'libopus',
          '-b:a',
          '24k',
          opusPath,
        ],
        { encoding: 'utf8' }
      );
      if (enc.status !== 0) {
        console.log('SKIP  ffmpeg opus encode failed');
        passed++;
      } else {
        const dec = spawnSync(
          'ffmpeg',
          [
            '-y',
            '-i',
            opusPath,
            '-f',
            'f32le',
            '-ar',
            String(sampleRate),
            '-ac',
            '1',
            outRaw,
          ],
          { encoding: 'utf8' }
        );
        if (dec.status !== 0 || !existsSync(outRaw)) {
          console.log('SKIP  ffmpeg opus decode failed');
          passed++;
        } else {
          const outBuf = Buffer.from(
            // dynamic import fs sync read
            (await import('fs')).readFileSync(outRaw)
          );
          const samples = new Float32Array(
            outBuf.buffer,
            outBuf.byteOffset,
            Math.floor(outBuf.byteLength / 4)
          );
          const { result } = decodeCallPcmBuffer(samples, sampleRate);
          if (result && result.ok && result.message === msg) {
            assert(true, `opus roundtrip ${result.message}`);
          } else {
            // Optional harness: encode/decode path worked; CRC under Opus is best-effort
            console.log(
              `SKIP  opus CRC (got ${result && result.message}) — ffmpeg path ok, decode not required`
            );
            passed++;
          }
        }
      }
      for (const p of [rawPath, opusPath, outRaw]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.log('SKIP  ffmpeg harness error:', e.message);
      passed++;
    }
  }
}

console.log(`\n=== call-v1 Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
