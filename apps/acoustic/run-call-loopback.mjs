/**
 * Phase 8 focused clean TX→RX loopback for call-v1 (no impairment matrix).
 * Usage: node run-call-loopback.mjs
 */
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const callJs = (name) => pathToFileURL(join(__dirname, 'js', 'call', name)).href;
const js = (name) => pathToFileURL(join(__dirname, 'js', name)).href;

const { createXorshift32 } = await import(js('protocol.js'));
const { renderCallTransmission } = await import(callJs('call-tx.js'));
const { decodeCallPcmBuffer } = await import(callJs('call-rx.js'));
const {
  BASE_TOTAL_DIFFERENTIAL_DB,
  CALL_ENHANCEMENT_CHANNELS,
  CALL_FRAME_MS,
  CROSSFADE_MS,
  CALL_PREAMBLE,
  CALL_CHIP_CODE,
} = await import(callJs('call-constants.js'));

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

const sampleRate = 48000;
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

console.log('\n=== call-v1 Phase 8 constants ===');
assert(BASE_TOTAL_DIFFERENTIAL_DB === 2.0, `Δ default ${BASE_TOTAL_DIFFERENTIAL_DB}`);
assert(CROSSFADE_MS >= 8 && CROSSFADE_MS <= 12, `crossfade ${CROSSFADE_MS} ms`);
assert(CALL_PREAMBLE.length === 12, '12-symbol preamble');
assert(CALL_CHIP_CODE.length === 8, '8-chip code');
assert(Math.abs(CALL_FRAME_MS - 18560) < 1, `frame ${CALL_FRAME_MS} ms`);
assert(
  CALL_ENHANCEMENT_CHANNELS[0][1] === 4020 &&
    CALL_ENHANCEMENT_CHANNELS[5][2] === 7660,
  'enhancement bands match constants'
);

console.log('\n=== clean synthetic loopback (several messages) ===');
const cases = [
  'ELEPHANT',
  'Hi',
  'call-v1 OK',
  'ABCDEFGHIJ0123456789', // 20 chars
];
const rng = createXorshift32(0x10b8ac);
for (let i = 0; i < 4; i++) {
  cases.push(randomMessage(rng, 1 + (rng.nextUint32() % 16)));
}

for (const msg of cases) {
  const t0 = Date.now();
  const tx = renderCallTransmission({
    message: msg,
    sampleRate,
    profileId: 'air',
    frameCount: 2,
    deltaDb: BASE_TOTAL_DIFFERENTIAL_DB,
    enableEnhancement: true,
    includeFadeIn: false,
    includeFadeOut: false,
    ambientSeed: 0xa11ce55,
    carrierSeed: 0xc0dec0de,
  });
  const { result, stats } = decodeCallPcmBuffer(tx.samples, sampleRate);
  const ok = result && result.ok && result.message === msg && stats.framesCrcValid >= 1;
  assert(
    ok,
    `loopback "${msg}" → ${result && result.message} crc=${stats.framesCrcValid} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
  );
}

console.log('\n=== base-only + pad strip ===');
{
  const msg = 'PADSTRIP';
  const tx = renderCallTransmission({
    message: msg,
    sampleRate,
    profileId: 'air',
    frameCount: 1,
    deltaDb: BASE_TOTAL_DIFFERENTIAL_DB,
    enableEnhancement: false,
    includeFadeIn: false,
    includeFadeOut: false,
  });
  const { result, stats } = decodeCallPcmBuffer(tx.samples, sampleRate);
  assert(
    result && result.ok && result.message === msg,
    `base-only "${msg}"`
  );
  assert(stats.framesCrcValid >= 1, 'CRC required');
}

console.log(`\n=== Phase 8 Summary: ${passed} passed, ${failed} failed (Δ=${BASE_TOTAL_DIFFERENTIAL_DB} dB) ===`);
if (failed > 0) process.exit(1);
