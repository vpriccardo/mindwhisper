/**
 * Exhaustive protocol-v2 + Reed-Solomon unit tests (Node ESM).
 * Usage: node run-protocol-v2-tests.mjs
 */
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const js = (name) => pathToFileURL(join(__dirname, 'js', name)).href;

const p2 = await import(js('protocol-v2.js'));
const rs = await import(js('rs-codec.js'));
const { crc16CcittFalse } = await import(js('crc16.js'));
const { createXorshift32 } = await import(js('protocol.js'));

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
  ALPHABET,
  PROTOCOL_V2,
  WHITEN_SEED_V2,
  HEADER_REPEAT_COUNT,
  buildHeaderV2,
  parseHeaderV2,
  majorityVoteHeaderByte,
  getParityBytes,
  packedMessageByteLength,
  packMessageV2,
  unpackMessageV2,
  computeFrameLayoutV2,
  bytesToBitsMsb,
  bitsToBytesMsb,
  whitenBits,
  dewhitenBits,
  buildFrameV2,
  decodeFrameV2,
  isValidMessage,
} = p2;

function randomMessage(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[rng.nextUint32() % ALPHABET.length];
  if (!/\S/.test(s)) s = 'A' + s.slice(1);
  return s;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
console.log('\n=== Header (§5/§12) ===');
{
  assert(PROTOCOL_V2 === 0b010, 'PROTOCOL_V2 == 0b010');
  for (let len = 1; len <= 20; len++) {
    const h = buildHeaderV2(len);
    const parsed = parseHeaderV2(h);
    assert(parsed.ok && parsed.version === PROTOCOL_V2 && parsed.length === len, `header roundtrip len=${len}`);
  }
  // bit layout check for a known value: len=8 -> (len-1)=7=0b00111; header = 010 00111 = 0b01000111 = 0x47
  assert(buildHeaderV2(8) === 0b01000111, 'header bit layout len=8');
  assert(buildHeaderV2(1) === 0b01000000, 'header bit layout len=1');
  assert(buildHeaderV2(20) === 0b01010011, 'header bit layout len=20');

  // reject wrong version
  for (let v = 0; v < 8; v++) {
    if (v === PROTOCOL_V2) continue;
    const bad = (v << 5) | 0x00;
    const parsed = parseHeaderV2(bad);
    assert(!parsed.ok, `reject version 0b${v.toString(2)}`);
  }
  // length always 1..20 by construction (5 bits => 1..32); versions matching PROTOCOL_V2 with length 21..32 must be rejected
  for (let raw = 20; raw < 32; raw++) {
    const b = (PROTOCOL_V2 << 5) | raw; // length = raw+1 = 21..32
    const parsed = parseHeaderV2(b);
    assert(!parsed.ok, `reject out-of-range length ${raw + 1}`);
  }
}

console.log('\n=== Majority header voting ===');
{
  const h = buildHeaderV2(12);
  {
    const { byte, minAgreement } = majorityVoteHeaderByte([h, h, h]);
    assert(byte === h && minAgreement === 1, 'unanimous vote');
  }
  {
    const corrupted = h ^ 0x08; // flip one bit in one candidate
    const { byte } = majorityVoteHeaderByte([h, h, corrupted]);
    assert(byte === h, '2-of-3 majority corrects single flipped candidate');
  }
  {
    // Flip a different single bit in each of two candidates (still each bit position 2-of-3 correct)
    const c1 = h ^ 0x01;
    const c2 = h ^ 0x02;
    const { byte } = majorityVoteHeaderByte([h, c1, c2]);
    assert(byte === h, 'majority per-bit corrects independent single-bit errors across candidates');
  }
}

// ---------------------------------------------------------------------------
// Packing (§4/§6)
// ---------------------------------------------------------------------------
console.log('\n=== Pack/unpack (§6) ===');
{
  assert(packedMessageByteLength(3) === 3, '3 chars -> 3 bytes');
  assert(packedMessageByteLength(8) === 6, '8 chars -> 6 bytes');
  assert(packedMessageByteLength(20) === 15, '20 chars -> 15 bytes');
  assert(packedMessageByteLength(1) === 1, '1 char -> 1 byte');
  assert(packedMessageByteLength(9) === 7, '9 chars -> 7 bytes (68 bits)');
  assert(packedMessageByteLength(14) === 11, '14 chars -> 11 bytes (84 bits)');
  assert(packedMessageByteLength(15) === 12, '15 chars -> 12 bytes (90 bits)');
}

for (const ch of ALPHABET) {
  const packed = packMessageV2(ch);
  const back = unpackMessageV2(packed, 1);
  assert(back === ch, `single char roundtrip "${ch === ' ' ? '<space>' : ch}"`);
}

for (const len of [1, 3, 8, 9, 14, 15, 20]) {
  const rng = createXorshift32(0xbeef0000 + len);
  for (let t = 0; t < 20; t++) {
    const msg = randomMessage(rng, len);
    const packed = packMessageV2(msg);
    const expectedBytes = packedMessageByteLength(len);
    assert(packed.length === expectedBytes, `len=${len} packed byte length`);
    const back = unpackMessageV2(packed, len);
    assert(back === msg, `len=${len} pack/unpack roundtrip "${msg}"`);
  }
}

// Unused tail bits must be zero
{
  const packed = packMessageV2('A'); // 6 bits used of 8 -> 2 trailing bits must be 0
  assert((packed[0] & 0x03) === 0, 'unused tail bits are 0 (len=1)');
  const packed3 = packMessageV2('AAA'); // 18 bits used of 24 -> 6 trailing bits 0
  assert((packed3[2] & 0x3f) === 0, 'unused tail bits are 0 (len=3)');
}

// ---------------------------------------------------------------------------
// CRC (§7) — reused from crc16.js, sanity check here too
// ---------------------------------------------------------------------------
console.log('\n=== CRC-16/CCITT-FALSE (§7) ===');
{
  const data = new TextEncoder().encode('123456789');
  assert(crc16CcittFalse(data) === 0x29b1, 'CRC known vector 0x29B1');
}

// ---------------------------------------------------------------------------
// Frame layout (§10)
// ---------------------------------------------------------------------------
console.log('\n=== Frame layout (§9/§10) ===');
{
  assert(getParityBytes(1) === 6 && getParityBytes(8) === 6, 'parity 6 for 1..8 chars');
  assert(getParityBytes(9) === 8 && getParityBytes(14) === 8, 'parity 8 for 9..14 chars');
  assert(getParityBytes(15) === 10 && getParityBytes(20) === 10, 'parity 10 for 15..20 chars');

  const l8 = computeFrameLayoutV2(8);
  assert(l8.dataBytes === 9 && l8.parityBytes === 6 && l8.codewordBytes === 15, '8-char frame: 9 data + 6 parity = 15 codeword');

  const l20 = computeFrameLayoutV2(20);
  assert(l20.dataBytes === 18 && l20.parityBytes === 10 && l20.codewordBytes === 28, '20-char frame: 18 data + 10 parity = 28 codeword');

  const l1 = computeFrameLayoutV2(1);
  assert(l1.dataBytes === 4 && l1.parityBytes === 6 && l1.codewordBytes === 10, '1-char frame: 4 data + 6 parity = 10 codeword');
}

// ---------------------------------------------------------------------------
// Bit <-> byte helpers + whitening (§13)
// ---------------------------------------------------------------------------
console.log('\n=== Bit/byte + whitening (§13) ===');
{
  const bytes = Uint8Array.from([0xa5, 0x3c, 0x00, 0xff]);
  const bits = bytesToBitsMsb(bytes);
  assert(bits.length === 32, 'bit length');
  assert(bits[0] === 1 && bits[1] === 0 && bits[2] === 1 && bits[3] === 0 && bits[4] === 0 && bits[5] === 1 && bits[6] === 0 && bits[7] === 1, '0xA5 MSB-first bits');
  const back = bitsToBytesMsb(bits);
  assert(back.every((v, i) => v === bytes[i]), 'bit/byte roundtrip');

  const whitened = whitenBits(bits, WHITEN_SEED_V2);
  let anyDiff = false;
  for (let i = 0; i < bits.length; i++) if (whitened[i] !== bits[i]) anyDiff = true;
  assert(anyDiff, 'whitening changes at least some bits');
  const dewhitened = dewhitenBits(whitened, WHITEN_SEED_V2);
  assert(dewhitened.every((v, i) => v === bits[i]), 'whiten/dewhiten roundtrip (self-inverse XOR)');

  // Deterministic seed => reproducible stream
  const w2 = whitenBits(bits, WHITEN_SEED_V2);
  assert(w2.every((v, i) => v === whitened[i]), 'whitening deterministic for fixed seed');
}

// ---------------------------------------------------------------------------
// Full frame build/decode roundtrip (§14 all lengths)
// ---------------------------------------------------------------------------
console.log('\n=== Full buildFrameV2/decodeFrameV2 roundtrip ===');
for (const len of [1, 8, 9, 14, 15, 20]) {
  const rng = createXorshift32(0xf00d0000 + len);
  for (let t = 0; t < 15; t++) {
    const msg = randomMessage(rng, len);
    const built = buildFrameV2(msg);
    assert(built.header === buildHeaderV2(len), `len=${len} header matches`);
    const decoded = decodeFrameV2(built.headerRepeats, built.whitenedBits);
    assert(decoded.ok && decoded.message === msg, `len=${len} full roundtrip "${msg}"`);
    assert(decoded.rsErrorCount === 0 && decoded.rsErasureCount === 0, `len=${len} clean decode has 0 errors/erasures`);
  }
}

// All alphabet characters individually through the full pipeline
for (const ch of ALPHABET) {
  const built = buildFrameV2(ch);
  const decoded = decodeFrameV2(built.headerRepeats, built.whitenedBits);
  assert(decoded.ok && decoded.message === ch, `full pipeline single char "${ch === ' ' ? '<space>' : ch}"`);
}

// Reject empty / invalid characters
assert(!isValidMessage('').ok, 'reject empty message');
assert(!isValidMessage('x'.repeat(21)).ok, 'reject 21-char message');
assert(!isValidMessage('hello!').ok, 'reject invalid character');

// ---------------------------------------------------------------------------
// RS errors at theoretical limits for each parity tier (§9/§14)
// ---------------------------------------------------------------------------
console.log('\n=== RS error correction at theoretical limits (per parity tier) ===');
for (const len of [8, 14, 20]) {
  const parity = getParityBytes(len);
  const maxErrors = Math.floor(parity / 2);
  const rng = createXorshift32(0xaaaa0000 + len);
  let okAtLimit = 0;
  let failBeyondLimit = 0;
  const N = 40;
  for (let t = 0; t < N; t++) {
    const msg = randomMessage(rng, len);
    const built = buildFrameV2(msg);
    const codeword = Uint8Array.from(built.codeword);
    const n = codeword.length;
    // Inject exactly maxErrors byte errors at random distinct positions
    const positions = new Set();
    while (positions.size < maxErrors) positions.add(rng.nextUint32() % n);
    for (const p of positions) codeword[p] ^= 1 + (rng.nextUint32() & 0xfe);
    const bits = bytesToBitsMsb(codeword);
    const whitened = whitenBits(bits);
    const decoded = decodeFrameV2(built.headerRepeats, whitened);
    if (decoded.ok && decoded.message === msg) okAtLimit++;
  }
  assert(okAtLimit === N, `len=${len} parity=${parity}: correct ${maxErrors} errors in ${okAtLimit}/${N} trials`);

  // One error beyond the limit should reliably fail-safe (never return wrong data as "ok")
  const rng2 = createXorshift32(0xbbbb0000 + len);
  let wrongAccepted = 0;
  for (let t = 0; t < N; t++) {
    const msg = randomMessage(rng2, len);
    const built = buildFrameV2(msg);
    const codeword = Uint8Array.from(built.codeword);
    const n = codeword.length;
    const positions = new Set();
    while (positions.size < maxErrors + 1) positions.add(rng2.nextUint32() % n);
    for (const p of positions) codeword[p] ^= 1 + (rng2.nextUint32() & 0xfe);
    const bits = bytesToBitsMsb(codeword);
    const whitened = whitenBits(bits);
    const decoded = decodeFrameV2(built.headerRepeats, whitened);
    if (decoded.ok && decoded.message !== msg) wrongAccepted++;
  }
  assert(wrongAccepted === 0, `len=${len} parity=${parity}: beyond-limit errors never silently accepted as wrong message (${wrongAccepted}/${N})`);
}

// ---------------------------------------------------------------------------
// RS erasures at theoretical limits (§9/§14): all-erasure correction up to `parity`
// ---------------------------------------------------------------------------
console.log('\n=== RS erasure correction at theoretical limits ===');
for (const len of [8, 14, 20]) {
  const parity = getParityBytes(len);
  const rng = createXorshift32(0xcccc0000 + len);
  let ok = 0;
  const N = 40;
  for (let t = 0; t < N; t++) {
    const msg = randomMessage(rng, len);
    const built = buildFrameV2(msg);
    const codeword = Uint8Array.from(built.codeword);
    const n = codeword.length;
    const positions = [];
    const used = new Set();
    while (used.size < parity) {
      const p = rng.nextUint32() % n;
      if (!used.has(p)) {
        used.add(p);
        positions.push(p);
      }
    }
    for (const p of positions) codeword[p] = rng.nextUint32() & 0xff; // garbage
    const bits = bytesToBitsMsb(codeword);
    const whitened = whitenBits(bits);
    // Erasure byte positions are known to RX by construction (simulating confidence gating)
    const decoded = decodeFrameV2(built.headerRepeats, whitened, {
      erasureBytePositions: positions,
    });
    if (decoded.ok && decoded.message === msg) ok++;
  }
  assert(ok === N, `len=${len} parity=${parity}: correct ${parity} erasures in ${ok}/${N} trials`);
}

// Mixed errors + erasures: 2*errors + erasures <= parity
console.log('\n=== RS mixed errors + erasures ===');
for (const len of [8, 14, 20]) {
  const parity = getParityBytes(len);
  const numErasures = Math.floor(parity / 2);
  const numErrors = Math.floor((parity - numErasures) / 2);
  const rng = createXorshift32(0xdddd0000 + len);
  let ok = 0;
  const N = 30;
  for (let t = 0; t < N; t++) {
    const msg = randomMessage(rng, len);
    const built = buildFrameV2(msg);
    const codeword = Uint8Array.from(built.codeword);
    const n = codeword.length;
    const used = new Set();
    const erasurePositions = [];
    while (erasurePositions.length < numErasures) {
      const p = rng.nextUint32() % n;
      if (!used.has(p)) {
        used.add(p);
        erasurePositions.push(p);
      }
    }
    const errorPositions = [];
    while (errorPositions.length < numErrors) {
      const p = rng.nextUint32() % n;
      if (!used.has(p)) {
        used.add(p);
        errorPositions.push(p);
      }
    }
    for (const p of erasurePositions) codeword[p] = rng.nextUint32() & 0xff;
    for (const p of errorPositions) codeword[p] ^= 1 + (rng.nextUint32() & 0xfe);
    const bits = bytesToBitsMsb(codeword);
    const whitened = whitenBits(bits);
    const decoded = decodeFrameV2(built.headerRepeats, whitened, {
      erasureBytePositions: erasurePositions,
    });
    if (decoded.ok && decoded.message === msg) ok++;
  }
  assert(
    ok === N,
    `len=${len} parity=${parity}: ${numErrors} errors + ${numErasures} erasures in ${ok}/${N} trials`
  );
}

// ---------------------------------------------------------------------------
// Header prefix vs internal header mismatch must reject (§11)
// ---------------------------------------------------------------------------
console.log('\n=== Header/internal mismatch rejection (§11) ===');
{
  const built = buildFrameV2('Hello');
  const wrongHeaderRepeats = Uint8Array.from(built.headerRepeats).map(() => buildHeaderV2(8));
  const decoded = decodeFrameV2(wrongHeaderRepeats, built.whitenedBits);
  assert(!decoded.ok, 'mismatched prefix header vs internal header rejected');
}

// ---------------------------------------------------------------------------
// Corrupted header candidates beyond majority repair -> version/length reject
// ---------------------------------------------------------------------------
console.log('\n=== Corrupt header handling (§12) ===');
{
  // All three candidates corrupted to an invalid version
  const badVersion = (0b111 << 5) | 0x03;
  const decoded = decodeFrameV2([badVersion, badVersion, badVersion], new Uint8Array(300));
  assert(!decoded.ok && decoded.stage === 'header', 'invalid version in majority header rejected');
}

// ---------------------------------------------------------------------------
// RS low-level: GF(256) sanity + generator poly properties
// ---------------------------------------------------------------------------
console.log('\n=== RS low-level GF(256) ===');
{
  const { gfMul, gfDiv, gfPow, gfInverse } = rs;
  assert(gfPow(2, 0) === 1, 'gfPow(2,0)=1');
  assert(gfPow(2, 255) === 1, 'gfPow(2,255)=1 (order of multiplicative group)');
  let allDistinct = true;
  const seen = new Set();
  for (let i = 0; i < 255; i++) {
    const v = gfPow(2, i);
    if (seen.has(v)) allDistinct = false;
    seen.add(v);
  }
  assert(allDistinct && seen.size === 255, 'powers of primitive element 2 are all distinct nonzero (generator)');
  for (let a = 1; a < 256; a++) {
    if (gfMul(a, gfInverse(a)) !== 1) {
      assert(false, `gfInverse(${a}) fails`);
      break;
    }
  }
  assert(true, 'gfInverse correct for all nonzero elements');
}

console.log(`\n=== protocol-v2 Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
