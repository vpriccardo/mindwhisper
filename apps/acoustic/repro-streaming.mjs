/**
 * Reproduction / regression check: streaming (per-feature-tick) use of
 * CallFrameSearcher.process(), matching the live rx2.html / CallReceiver
 * path — NOT the batch decodeCallFeatureBuffer() path used by the
 * automated test suite (run-call-tests.mjs / run-call-loopback.mjs), which
 * never called process() incrementally and so never caught the TRACK/
 * CONFIRMED per-tick bug fixed in call-sync.js.
 *
 * Usage: node repro-streaming.mjs [snrDb] [attenDb]
 */
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const callJs = (name) => pathToFileURL(join(__dirname, 'js', 'call', name)).href;
const js = (name) => pathToFileURL(join(__dirname, 'js', name)).href;

const { renderCallTransmission } = await import(callJs('call-tx.js'));
const { CallFeatureExtractor } = await import(callJs('call-rx.js'));
const { CallFrameSearcher } = await import(callJs('call-sync.js'));
const { BASE_TOTAL_DIFFERENTIAL_DB, CALL_PREAMBLE_CORRELATION_MIN } = await import(
  callJs('call-constants.js')
);
const { createXorshift32 } = await import(js('protocol.js'));

const sampleRate = 48000;
const msg = 'ELEPHANT';
const snrDb = process.argv[2] ? Number(process.argv[2]) : 20;
const attenDb = process.argv[3] ? Number(process.argv[3]) : 0;

function addNoise(samples, snr, rng) {
  let pSig = 0;
  for (let i = 0; i < samples.length; i++) pSig += samples[i] * samples[i];
  pSig /= samples.length;
  const pNoise = pSig / Math.pow(10, snr / 10);
  const sigma = Math.sqrt(Math.max(pNoise, 0));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] + rng.nextGaussian() * sigma;
  return out;
}

function attenuate(samples, db) {
  const g = Math.pow(10, -db / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
  return out;
}

const tx = renderCallTransmission({
  message: msg,
  sampleRate,
  profileId: 'air',
  frameCount: 4, // ~74.2s — several real frame repeats
  deltaDb: BASE_TOTAL_DIFFERENTIAL_DB,
  enableEnhancement: true,
  includeFadeIn: false,
  includeFadeOut: false,
  ambientSeed: 0xa11ce55,
  carrierSeed: 0xc0dec0de,
});

const rng = createXorshift32(0xf00dbabe);
let samples = tx.samples;
if (attenDb > 0) samples = attenuate(samples, attenDb);
if (Number.isFinite(snrDb)) samples = addNoise(samples, snrDb, rng);

const extractor = new CallFeatureExtractor(sampleRate);
const features = extractor.processBuffer(samples);
console.log(
  `SNR=${snrDb}dB atten=${attenDb}dB — ${(samples.length / sampleRate).toFixed(1)}s audio, ${features.length} feature ticks.`
);

const searcher = new CallFrameSearcher({ threshold: CALL_PREAMBLE_CORRELATION_MIN });
let lastState = null;
let transitions = 0;
const bufItems = [];
for (const f of features) {
  bufItems.push(f);
  searcher.process(bufItems);
  if (searcher.state !== lastState) {
    transitions++;
    lastState = searcher.state;
  }
}

console.log(`State transitions: ${transitions}`);
console.log('Final stats:', searcher.stats);

// Guardrail: a healthy streaming run should have roughly one
// detected/decoded attempt per real frame period (frameCount ± a couple),
// not dozens/hundreds from re-triggering on the same audio every tick.
const maxExpected = 6; // generous margin above frameCount=4
if (searcher.stats.framesDetected > maxExpected) {
  console.error(
    `FAIL  framesDetected=${searcher.stats.framesDetected} is way above the ~4 real frame periods — TRACK-loop spiral likely reintroduced.`
  );
  process.exit(1);
}
console.log(`PASS  framesDetected=${searcher.stats.framesDetected} within expected range (<= ${maxExpected}).`);
