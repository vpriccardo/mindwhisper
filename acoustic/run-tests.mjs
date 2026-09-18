/**
 * Headless protocol + DSP loopback tests (Node ESM).
 * Usage: node run-tests.mjs
 */
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const js = (name) => pathToFileURL(join(__dirname, 'js', name)).href;

const protocol = await import(js('protocol.js'));
const watermark = await import(js('watermark.js'));
const decoder = await import(js('rx-decoder.js'));
const ambient = await import(js('ambient.js'));
const txEngine = await import(js('tx-engine.js'));
const profiles = await import(js('ambient-profiles.js'));

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

function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const {
  ALPHABET,
  TOTAL_BITS,
  CODED_BITS,
  PROTOCOL_VERSION,
  PREAMBLE_CORRELATION_MIN,
  TOTAL_TX_MS,
  WATERMARK_CHANNELS,
  WATERMARK_DELTA_DB_DEFAULT,
  FEATURE_BUFFER_SECONDS,
  isValidMessage,
  packMessage,
  unpackMessage,
  buildRawFrame,
  encodeMessage,
  decodeFromBits,
  decodeFromDataSymbols,
  interleave,
  inverseInterleave,
  scrambleBits,
  descrambleBits,
  hammingEncodeNibble,
  hammingDecodeCodeword,
  crc16CcittFalse,
  createXorshift32,
  combineSoftFrames,
} = protocol;

const { hammingEncodeBytes } = await import(js('hamming.js'));

// --- Protocol ---
console.log('\n=== Protocol ===');

for (const ch of ALPHABET) {
  const enc = encodeMessage(ch);
  const dec = decodeFromDataSymbols(enc.dataSymbols);
  assert(dec.ok && dec.message === ch, `char "${ch}"`);
}

for (const m of ['A', 'Hello World', 'test-case', 'Aa0 -Zz', 'x'.repeat(20)]) {
  const dec = decodeFromDataSymbols(encodeMessage(m).dataSymbols);
  assert(dec.ok && dec.message === m, `msg "${m}"`);
}
assert(!isValidMessage('').ok, 'reject empty');
assert(!isValidMessage('hello!').ok, 'reject !');

{
  const data = new TextEncoder().encode('123456789');
  assert(crc16CcittFalse(data) === 0x29b1, 'CRC vector 0x29B1');
}

{
  let ok = true;
  for (let n = 0; n < 16; n++) {
    const cw = hammingEncodeNibble(n);
    for (let bit = 0; bit < 7; bit++) {
      const flipped = cw ^ (1 << (6 - bit));
      const { nibble, corrected } = hammingDecodeCodeword(flipped);
      if (nibble !== n || !corrected) ok = false;
    }
  }
  assert(ok, 'Hamming all single-bit corrections');
}

{
  const rng = createXorshift32(0x12345678);
  let ok = true;
  for (let t = 0; t < 20; t++) {
    const x = new Uint8Array(TOTAL_BITS);
    for (let i = 0; i < TOTAL_BITS; i++) x[i] = rng.nextBit();
    if (!bytesEq(x, inverseInterleave(interleave(x)))) ok = false;
  }
  assert(ok, 'interleave roundtrip');
}

{
  const x = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) x[i] = i & 1;
  assert(bytesEq(x, descrambleBits(scrambleBits(x))), 'scramble roundtrip');
}

{
  const enc = encodeMessage('ELEPHANT');
  assert(enc.rawFrame[0] === PROTOCOL_VERSION, 'version');
  assert(enc.hammingBits.length === CODED_BITS, '266 hamming bits');
  const dec = decodeFromDataSymbols(enc.dataSymbols);
  assert(dec.ok && dec.message === 'ELEPHANT', 'ELEPHANT roundtrip');
}

{
  const enc = encodeMessage('test');
  const bits = new Uint8Array(enc.scrambled);
  for (let i = 0; i < 40; i++) bits[i * 3] ^= 1;
  assert(!decodeFromBits(bits).ok, 'CRC reject on corruption');
}

{
  const { frame } = buildRawFrame('hi');
  frame[0] = 0x99;
  const crc = crc16CcittFalse(frame.subarray(0, 17));
  frame[17] = (crc >> 8) & 0xff;
  frame[18] = crc & 0xff;
  const ham = hammingEncodeBytes(frame);
  const padded = new Uint8Array(TOTAL_BITS);
  padded.set(ham);
  const bits = scrambleBits(interleave(padded));
  const dec = decodeFromBits(bits);
  assert(!dec.ok && /version/i.test(dec.error || ''), 'version reject');
}

{
  const soft = Float32Array.from(encodeMessage('Soft').scrambled, (b) => (b ? 1 : -1));
  const f1 = Float32Array.from(soft, (v, i) => v + (i % 5 === 0 ? -1.2 : 0));
  const f2 = Float32Array.from(soft, (v, i) => v + (i % 7 === 0 ? -1.2 : 0));
  const c = combineSoftFrames([f1, f2]);
  assert(c.ok && c.message === 'Soft', 'soft combining');
}

// --- call-v1 packing (shared payload, +4 pad → 46×6) — must not break room ---
{
  const {
    encodeCallMessage,
    decodeFromCallDataSymbols,
    CALL_TOTAL_BITS,
    CALL_DATA_SYMBOLS,
    CALL_EXTRA_PAD_BITS,
  } = protocol;
  const enc = encodeCallMessage('ELEPHANT');
  assert(enc.scrambled.length === TOTAL_BITS, 'room scrambled untouched length');
  assert(CALL_EXTRA_PAD_BITS === 4 && enc.callBits.length === CALL_TOTAL_BITS, 'call 276 bits');
  assert(enc.callDataSymbols.length === CALL_DATA_SYMBOLS, '46 call symbols');
  const dec = decodeFromCallDataSymbols(enc.callDataSymbols);
  assert(dec.ok && dec.message === 'ELEPHANT', 'call packing roundtrip');
}

// --- Band energy helper ---
function bandEnergy(samples, sampleRate, lowHz, highHz) {
  // Coarse Goertzel-ish energy via DFT bins around the band
  const n = Math.min(samples.length, sampleRate * 2);
  let sum = 0;
  const mid = (lowHz + highHz) / 2;
  const w = (2 * Math.PI * mid) / sampleRate;
  let s1 = 0;
  let s2 = 0;
  const coeff = 2 * Math.cos(w);
  for (let i = 0; i < n; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  sum = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return sum / n;
}

function profileBandEnergies(samples, sampleRate) {
  return WATERMARK_CHANNELS.map(([lo, hi]) => bandEnergy(samples, sampleRate, lo, hi));
}

// --- DSP loopback (Air reference) ---
console.log('\n=== DSP loopback (Air) ===');
const sampleRate = 48000;
const msg = 'ELEPHANT';
console.log(`Rendering "${msg}"…`);
const t0 = Date.now();
const tx = watermark.renderWatermarkedAudio({
  message: msg,
  sampleRate,
  profileId: 'air',
});
console.log(
  `Render ${(Date.now() - t0) / 1000}s, peak=${tx.peak.toFixed(3)}, rmsDb=${tx.rmsDb.toFixed(1)}, deltaDb=${tx.deltaDb}, dur=${tx.durationMs.toFixed(0)}`
);

assert(tx.peak <= 0.851, `peak ${tx.peak}`);
assert(Math.abs(tx.durationMs - TOTAL_TX_MS) < 50, `duration ${tx.durationMs} vs ${TOTAL_TX_MS}`);

const t1 = Date.now();
const { result, stats, featureCount } = decoder.decodePcmBuffer(tx.samples, sampleRate);
console.log(`Decode ${(Date.now() - t1) / 1000}s, features=${featureCount}, stats=`, stats);

assert(result && result.ok && result.message === msg, `loopback got ${result && result.message}`);
assert(stats.framesCrcValid >= 1, `crc valid ${stats.framesCrcValid}`);

const airEnergies = profileBandEnergies(tx.samples, sampleRate);
const airEnergyMean =
  airEnergies.reduce((a, b) => a + b, 0) / airEnergies.length;

// Neutral false positive
{
  const neu = watermark.renderWatermarkedAudio({
    message: 'HELLO',
    sampleRate,
    deltaDb: 1.5,
    neutral: true,
    profileId: 'air',
  });
  const r = decoder.decodePcmBuffer(neu.samples, sampleRate, {
    threshold: PREAMBLE_CORRELATION_MIN,
  });
  assert(!r.result || !r.result.ok, 'neutral no decode');
  assert(r.stats.framesCrcValid === 0, 'neutral zero CRC');
}

// Timing offset
{
  const pad = Math.floor(sampleRate * 0.37);
  const padded = new Float32Array(pad + tx.samples.length);
  padded.set(tx.samples, pad);
  const r = decoder.decodePcmBuffer(padded, sampleRate);
  assert(r.result && r.result.ok && r.result.message === msg, 'offset decode');
}

// Gain
{
  for (const gdb of [-20, 0, 6]) {
    const g = Math.pow(10, gdb / 20);
    const scaled = Float32Array.from(tx.samples, (x) => x * g);
    let peak = 0;
    for (let i = 0; i < scaled.length; i++) peak = Math.max(peak, Math.abs(scaled[i]));
    if (peak > 0.99) {
      const s = 0.99 / peak;
      for (let i = 0; i < scaled.length; i++) scaled[i] *= s;
    }
    const r = decoder.decodePcmBuffer(scaled, sampleRate);
    assert(r.result && r.result.ok && r.result.message === msg, `gain ${gdb} dB`);
  }
}

// Ambient only false positive (shorter)
{
  const n = sampleRate * 6;
  const amb = ambient.renderAmbient(sampleRate, n, 0xabc);
  const r = decoder.decodePcmBuffer(amb, sampleRate);
  assert(r.stats.framesCrcValid === 0, 'ambient-only no CRC false positive');
}

// --- Per-profile loopback ---
console.log('\n=== Profile matrix ===');
const PROFILE_LIST = ['air', 'breathing', 'elements'];
const LENGTHS = [1, 5, 10, 20];
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -';

function randomMessage(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += alphabet[rng.nextUint32() % alphabet.length];
  }
  // Avoid all-spaces
  if (!/\S/.test(s)) s = 'A' + s.slice(1);
  return s;
}

for (const profileId of PROFILE_LIST) {
  console.log(`\n-- profile ${profileId} --`);
  for (const len of LENGTHS) {
    const m =
      len === 1
        ? 'X'
        : len === 5
          ? 'Hello'
          : len === 10
            ? 'Test Case!'
            : 'ABCDEFGHIJ0123456789';
    // 20-char valid alphabet only
    const message =
      len === 20
        ? 'ABCDEFGHIJ0123456789'
        : len === 10
          ? 'Test-Case1'
          : m.replace(/!/g, '');
    const rendered = watermark.renderWatermarkedAudio({
      message,
      sampleRate,
      profileId,
      deltaDb: WATERMARK_DELTA_DB_DEFAULT,
    });
    assert(rendered.peak <= 0.851, `${profileId} len=${len} peak`);
    const r = decoder.decodePcmBuffer(rendered.samples, sampleRate);
    assert(
      r.result && r.result.ok && r.result.message === message,
      `${profileId} len=${len} decode "${message}"`
    );

    const energies = profileBandEnergies(rendered.samples, sampleRate);
    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    // Masking bed: each profile should retain a meaningful fraction of Air band energy
    const ratio = mean / Math.max(airEnergyMean, 1e-20);
    assert(ratio > 0.25, `${profileId} band energy ratio ${ratio.toFixed(2)} vs Air`);
    console.log(
      `  ${profileId} len=${len} rmsDb=${rendered.rmsDb.toFixed(1)} bandRatio=${ratio.toFixed(2)} crc=${r.stats.framesCrcValid}`
    );
  }
}

// 100 randomized messages per profile (clean)
console.log('\n=== Randomized clean decode (100 / profile) ===');
for (const profileId of PROFILE_LIST) {
  const rng = createXorshift32(0xc0ffee ^ profileId.length * 0x9e37);
  let ok = 0;
  const N = 100;
  for (let i = 0; i < N; i++) {
    const len = 1 + (rng.nextUint32() % 20);
    const message = randomMessage(rng, len);
    if (!isValidMessage(message).ok) {
      i--;
      continue;
    }
    const rendered = watermark.renderWatermarkedAudio({
      message,
      sampleRate,
      profileId,
      // Two frames + short ambient lead-in (filter warmup); no end fades
      frameCount: 2,
      includeFadeIn: false,
      includeFadeOut: false,
      leadInMs: 250,
      trailOutMs: 0,
    });
    const r = decoder.decodePcmBuffer(rendered.samples, sampleRate);
    if (r.result && r.result.ok && r.result.message === message) ok++;
  }
  const rate = ok / N;
  console.log(`  ${profileId}: ${ok}/${N} (${(rate * 100).toFixed(0)}%)`);
  assert(rate >= 0.98, `${profileId} random decode rate ${rate}`);
}

// Continuous streaming render (~2 min worth of frames, chunked — memory check)
console.log('\n=== Continuous streaming (~2 min synthetic) ===');
{
  const renderer = new txEngine.StreamingTxRenderer({
    message: 'CONTINUOUS',
    sampleRate,
    profileId: 'breathing',
  });
  const frameSamples = renderer.frameSamples;
  const targetFrames = Math.ceil((120 * sampleRate) / frameSamples); // ~2 minutes
  const blockFrames = Math.max(1, Math.floor((10 * sampleRate) / frameSamples));
  let framesDone = 0;
  const memBefore =
    typeof process.memoryUsage === 'function' ? process.memoryUsage().heapUsed : 0;

  // Ambient-only lead-in warms carrier filters (mirrors live TX)
  renderer.renderChunk({
    lengthSamples: Math.round(0.8 * sampleRate),
    ambientOnly: true,
    fadeIn: true,
  });

  const extractor = new decoder.FeatureExtractor(sampleRate);
  const searcher = new decoder.FrameSearcher({
    threshold: PREAMBLE_CORRELATION_MIN,
  });
  let maxAbs = 0;
  const allFeatures = [];

  while (framesDone < targetFrames) {
    const n = Math.min(blockFrames, targetFrames - framesDone);
    const chunk = renderer.renderChunk({
      lengthSamples: n * frameSamples,
    });
    for (let i = 0; i < chunk.samples.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(chunk.samples[i]));
    }
    extractor.processBuffer(chunk.samples);
    for (const f of extractor.features) allFeatures.push(f);
    extractor.features.length = 0;
    searcher.process(allFeatures);
    framesDone += n;
  }

  const memAfter =
    typeof process.memoryUsage === 'function' ? process.memoryUsage().heapUsed : 0;
  const memDeltaMb = (memAfter - memBefore) / (1024 * 1024);
  const decodedOk = searcher.stats.framesCrcValid;
  console.log(
    `  frames=${framesDone}, crcHits=${decodedOk}, peak~${maxAbs.toFixed(3)}, heapΔ=${memDeltaMb.toFixed(1)} MB`
  );
  assert(decodedOk >= 10, `continuous CRC hits ${decodedOk}`);
  assert(maxAbs <= 1.0, `continuous peak ${maxAbs}`);
  // Heap growth should not scale like storing 2 minutes of PCM (~23 MB float)
  assert(memDeltaMb < 80, `memory growth ${memDeltaMb.toFixed(1)} MB`);
  assert(
    renderer.framesTransmitted >= targetFrames - 1,
    `framesTransmitted ${renderer.framesTransmitted}`
  );
}

// Start/Stop session simulation (offline renderer recreate)
console.log('\n=== Start/Stop session recreate ===');
{
  for (let s = 0; s < 4; s++) {
    const r = new txEngine.StreamingTxRenderer({
      message: 'SESSION',
      sampleRate,
      profileId: PROFILE_LIST[s % 3],
    });
    // Lead-in then ~10 seconds of data frames
    r.renderChunk({
      lengthSamples: Math.round(0.8 * sampleRate),
      ambientOnly: true,
      fadeIn: true,
    });
    const samples = Math.round(10 * sampleRate);
    const chunk = r.renderChunk({ lengthSamples: samples });
    // Soft fade-out on a short ambient-only trail
    const trail = r.renderChunk({
      lengthSamples: Math.round(0.6 * sampleRate),
      ambientOnly: true,
      fadeOut: true,
    });
    const pcm = new Float32Array(chunk.samples.length + trail.samples.length);
    pcm.set(chunk.samples, 0);
    pcm.set(trail.samples, chunk.samples.length);
    const dec = decoder.decodePcmBuffer(pcm, sampleRate);
    assert(
      dec.result && dec.result.ok && dec.result.message === 'SESSION',
      `session ${s} profile=${PROFILE_LIST[s % 3]}`
    );
  }
}

// Air ambient identity: streaming vs single-shot should match sample-for-sample for pure ambient
console.log('\n=== Air ambient regression ===');
{
  const n = sampleRate; // 1s
  const a = ambient.renderAmbient(sampleRate, n, 0xA11);
  const stream = profiles.createAmbientStream('air', sampleRate, 0xA11);
  const b = stream.render(n);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  assert(maxDiff < 1e-7, `air ambient stream identity maxDiff=${maxDiff}`);
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
