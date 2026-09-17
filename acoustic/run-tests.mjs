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
const hamming = await import(js('hamming.js'));
const watermark = await import(js('watermark.js'));
const decoder = await import(js('rx-decoder.js'));
const ambient = await import(js('ambient.js'));

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

const { hammingEncodeBytes } = hamming;

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

// --- DSP loopback ---
console.log('\n=== DSP loopback ===');
const sampleRate = 48000;
const msg = 'ELEPHANT';
console.log(`Rendering "${msg}"…`);
const t0 = Date.now();
const tx = watermark.renderWatermarkedAudio({ message: msg, sampleRate });
console.log(`Render ${(Date.now() - t0) / 1000}s, peak=${tx.peak.toFixed(3)}, rmsDb=${tx.rmsDb.toFixed(1)}, deltaDb=${tx.deltaDb}`);

assert(tx.peak <= 0.851, `peak ${tx.peak}`);
assert(Math.abs(tx.durationMs - TOTAL_TX_MS) < 50, `duration ${tx.durationMs}`);

const t1 = Date.now();
const { result, stats, featureCount } = decoder.decodePcmBuffer(tx.samples, sampleRate);
console.log(`Decode ${(Date.now() - t1) / 1000}s, features=${featureCount}, stats=`, stats);

assert(result && result.ok && result.message === msg, `loopback got ${result && result.message}`);
assert(stats.framesCrcValid >= 1, `crc valid ${stats.framesCrcValid}`);

// Neutral false positive
{
  const neu = watermark.renderWatermarkedAudio({
    message: 'HELLO',
    sampleRate,
    deltaDb: 1.5,
    neutral: true,
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

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
