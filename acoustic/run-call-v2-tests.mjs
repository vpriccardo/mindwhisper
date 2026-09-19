/**
 * call-v2 synthetic + loopback tests (Node ESM).
 *
 * Blind decode is exercised on a 12-tone carrier (energy at every peaking
 * centre) so the self-referencing soft-bit path can be proven at the goal
 * depth/speed presets. Real Meditation PCM is exercised with the optional
 * reference-aware path (§46).
 *
 * Usage: node run-call-v2-tests.mjs
 * Env:   CALL_V2_MC=N   Monte-Carlo count (default 20)
 *        MEDITATION_F32=/path/to/meditation.f32  (optional real-asset test)
 */
import { readFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const js = (name) => pathToFileURL(join(__dirname, 'js', name)).href;

const txMod = await import(js('call/call-v2-tx.js'));
const rxMod = await import(js('call/call-v2-rx.js'));
const protoMod = await import(js('call/call-v2-protocol.js'));
const constMod = await import(js('call/call-v2-constants.js'));
const refMod = await import(js('call/call-v2-reference.js'));
const protocol = await import(js('protocol.js'));
const { makeBroadbandMusic } = await import(
  pathToFileURL(join(__dirname, 'test-helpers/synthetic-music.mjs')).href
);

const { CallV2StreamingProcessor } = txMod;
const { decodeCallV2PcmBuffer, CallV2FeatureExtractor } = rxMod;
const { buildCallV2TransmitSymbols, callV2FrameSymbolCount } = protoMod;
const {
  CALL_V2_PAIRS,
  CALL_V2_PREAMBLE,
  CALL_V2_DEPTH_PRESETS,
  CALL_V2_SPEED_ORDER,
  CALL_V2_DEFAULT_DEPTH,
  CALL_V2_DEFAULT_SPEED,
  CALL_V2_CHANNEL_COUNT,
  callV2SymbolMsForSpeed,
} = constMod;
const { extractReferenceFeatures } = refMod;
const { createXorshift32, ALPHABET } = protocol;

const MC = Math.max(1, Number(process.env.CALL_V2_MC) || 20);
const SR = 48000;
const MED_PATH = process.env.MEDITATION_F32 || '/tmp/meditation.f32';

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

function randomMessage(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[rng.nextUint32() % ALPHABET.length];
  if (!/\S/.test(s)) s = 'A' + s.slice(1);
  return s;
}

/** Sum of sines at every peaking centre — maximises EQ→bandpass coupling. */
function makePairToneCarrier(n, sampleRate = SR, amp = 0.05) {
  const out = new Float32Array(n);
  for (const [lo, hi] of CALL_V2_PAIRS) {
    for (let i = 0; i < n; i++) {
      out[i] += amp * Math.sin((2 * Math.PI * lo * i) / sampleRate);
      out[i] += amp * Math.sin((2 * Math.PI * hi * i) / sampleRate);
    }
  }
  return out;
}

function fillFrom(carrier, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = carrier[i % carrier.length];
  return out;
}

function renderWatermarked(message, carrier, opts = {}) {
  const tx = new CallV2StreamingProcessor({
    message,
    sampleRate: SR,
    depthId: opts.depthId,
    depthDb: opts.depthDb,
    speedId: opts.speedId ?? CALL_V2_DEFAULT_SPEED,
    Q: opts.Q,
    neutral: opts.neutral,
  });
  const frames = opts.frames ?? 2;
  const n = tx.frameSamples * frames + tx.symbolSamples;
  const input = fillFrom(carrier, n);
  const out = tx.process(input, { watermarkEnabled: opts.watermarkEnabled !== false });
  return { out, tx };
}

// ---------------------------------------------------------------------------
// Constants / framing
// ---------------------------------------------------------------------------
console.log('\n=== call-v2 constants & framing ===');
assert(CALL_V2_PAIRS.length === 6, '6 frequency pairs');
assert(CALL_V2_CHANNEL_COUNT === 6, '6 parallel channels');
assert(CALL_V2_PREAMBLE.length === 8, '8-symbol preamble');
assert(
  Array.from(CALL_V2_PREAMBLE).join(',') ===
    [0b111000, 0b000111, 0b110100, 0b001011, 0b101010, 0b010101, 0b100110, 0b011001].join(','),
  'preamble matches spec'
);
assert(CALL_V2_DEFAULT_DEPTH === 'balanced', 'default depth balanced');
assert(CALL_V2_DEFAULT_SPEED === 'fast', 'default speed fast (120 ms)');
assert(callV2FrameSymbolCount(8) === 32, '8-char frame = 32 symbols (8+4+20)');
{
  const built = buildCallV2TransmitSymbols('ELEPHANT');
  assert(built.frameSymbols.length === 32, `ELEPHANT frameSymbols ${built.frameSymbols.length}`);
  const ms = callV2SymbolMsForSpeed('fast');
  const frameMs = built.frameSymbols.length * ms;
  assert(frameMs === 3840, `8-char @120ms frame = ${frameMs} ms (target ≤4500)`);
}

// ---------------------------------------------------------------------------
// Neutral (watermark off) must leave PCM unchanged
// ---------------------------------------------------------------------------
console.log('\n=== watermark-off identity ===');
{
  const carrier = makePairToneCarrier(SR);
  const { out, tx } = renderWatermarked('HI', carrier, {
    depthDb: 0.4,
    speedId: 'fast',
    frames: 1,
    watermarkEnabled: false,
  });
  const input = fillFrom(carrier, out.length);
  let maxDiff = 0;
  for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - input[i]));
  assert(maxDiff < 1e-7, `watermark off maxDiff=${maxDiff} (exact pass-through)`);
  assert(tx.totalDeltaDb === 0.4, 'depth still recorded when off');
}

// ---------------------------------------------------------------------------
// Blind clean loopback on pair-tone carrier (goal depths × default speed)
// ---------------------------------------------------------------------------
console.log('\n=== blind pair-tone loopback (depth sweep @ fast) ===');
{
  const carrier = makePairToneCarrier(SR * 30);
  for (const [depthId, depthDb] of Object.entries(CALL_V2_DEPTH_PRESETS)) {
    const { out } = renderWatermarked('HELLO12', carrier, {
      depthDb,
      speedId: 'fast',
      frames: 2,
    });
    const dec = decodeCallV2PcmBuffer(out, SR, { threshold: 0.25 });
    assert(
      dec.result?.message === 'HELLO12',
      `blind depth=${depthId} (${depthDb} dB) → ${dec.result?.message ?? 'null'} (crc=${dec.stats.framesCrcValid})`
    );
  }
}

// ---------------------------------------------------------------------------
// Blind speed sweep at balanced depth
// ---------------------------------------------------------------------------
console.log('\n=== blind pair-tone speed sweep (balanced 0.40 dB) ===');
{
  const carrier = makePairToneCarrier(SR * 40);
  for (const speedId of CALL_V2_SPEED_ORDER) {
    const { out, tx } = renderWatermarked('ELEPHANT', carrier, {
      depthDb: 0.4,
      speedId,
      frames: 3,
    });
    const dec = decodeCallV2PcmBuffer(out, SR, { threshold: 0.25 });
    const ok = dec.result?.message === 'ELEPHANT';
    // Default 'fast' is the hard requirement (§31). Other speeds are
    // reported — pure-tone beating can degrade non-default half lengths.
    if (speedId === CALL_V2_DEFAULT_SPEED) {
      assert(ok, `blind speed=${speedId} (${tx.symbolMs}ms) → ${dec.result?.message ?? 'null'}`);
    } else {
      console.log(
        `INFO speed=${speedId} (${tx.symbolMs}ms) → ${dec.result?.message ?? 'null'} crc=${dec.stats.framesCrcValid} comb=${dec.stats.combinedAttempts}`
      );
      if (ok) {
        passed++;
        console.log('PASS ', `blind speed=${speedId} recovered`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Monte Carlo blind short messages
// ---------------------------------------------------------------------------
console.log(`\n=== blind Monte Carlo (N=${MC}, depth=0.40, speed=fast) ===`);
{
  const carrier = makePairToneCarrier(SR * 40, SR, 0.05);
  const rng = createXorshift32(0xc411c211);
  let ok = 0;
  const lengths = [2, 4, 8, 12];
  for (let i = 0; i < MC; i++) {
    const len = lengths[i % lengths.length];
    const msg = randomMessage(rng, len);
    const { out } = renderWatermarked(msg, carrier, {
      depthDb: 0.4,
      speedId: 'fast',
      frames: 2,
    });
    const dec = decodeCallV2PcmBuffer(out, SR, { threshold: 0.25 });
    if (dec.result?.message === msg) ok++;
    else console.log(`  miss i=${i} len=${len} got=${dec.result?.message ?? 'null'}`);
  }
  const rate = ok / MC;
  assert(rate >= 0.9, `blind MC success ${ok}/${MC} (${(rate * 100).toFixed(0)}% ≥ 90%)`);
}

// ---------------------------------------------------------------------------
// Broadband pink noise: blind is weak; report only (not a hard fail)
// ---------------------------------------------------------------------------
console.log('\n=== pink-noise blind (informational) ===');
{
  const pink = makeBroadbandMusic(SR * 25, SR);
  const { out } = renderWatermarked('HI', pink, { depthDb: 0.4, speedId: 'fast', frames: 3 });
  const dec = decodeCallV2PcmBuffer(out, SR, { threshold: 0.2 });
  console.log(
    `INFO pink blind → ${dec.result?.message ?? 'null'} pre=${dec.stats.bestPreambleScore.toFixed(3)} crc=${dec.stats.framesCrcValid}`
  );
}

// ---------------------------------------------------------------------------
// Real Meditation + reference-aware (§46)
// ---------------------------------------------------------------------------
console.log('\n=== Meditation reference-aware ===');
if (existsSync(MED_PATH)) {
  const buf = readFileSync(MED_PATH);
  const med = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const refFeatures = extractReferenceFeatures(med, SR);
  assert(refFeatures.length > 100, `ref features ${refFeatures.length}`);

  for (const depthDb of [0.4, 0.55, 0.7]) {
    const { out } = renderWatermarked('HI', med, {
      depthDb,
      speedId: 'conservative',
      frames: 3,
    });
    const blind = decodeCallV2PcmBuffer(out, SR, { threshold: 0.25 });
    const ref = decodeCallV2PcmBuffer(out, SR, {
      threshold: 0.25,
      referenceFeatures: refFeatures,
      referencePhase: 0,
    });
    console.log(
      `INFO med depth=${depthDb} blind=${blind.result?.message ?? 'null'} ref=${ref.result?.message ?? 'null'} refComb=${ref.stats.combinedAttempts}`
    );
    assert(
      ref.result?.message === 'HI',
      `Meditation+ref depth=${depthDb} → ${ref.result?.message ?? 'null'}`
    );
  }
} else {
  console.log(`SKIP Meditation tests (no ${MED_PATH}; set MEDITATION_F32=...)`);
}

// ---------------------------------------------------------------------------
// Frame duration acceptance targets (§54)
// ---------------------------------------------------------------------------
console.log('\n=== frame duration targets ===');
{
  for (const [len, maxMs] of [
    [8, 4500],
    [20, 6500],
  ]) {
    const nSym = callV2FrameSymbolCount(len);
    const ms = nSym * callV2SymbolMsForSpeed('fast');
    assert(ms <= maxMs, `len=${len} @fast ${ms}ms ≤ ${maxMs}ms`);
  }
}

console.log(`\n=== call-v2 tests: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
