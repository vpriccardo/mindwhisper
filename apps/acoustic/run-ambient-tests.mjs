/**
 * Ambient nature diagnostics: tonality peaks + wave-interval periodicity.
 * Run: node run-ambient-tests.mjs
 *
 * These are debugging aids — not a claim that the sound "is realistic".
 */

import {
  createTideStream,
  createElementsStream,
  collectWaveIntervals,
  analyzeTonality,
  intervalAutocorrScore,
  TIDE_DEFAULTS,
  ELEMENTS_DEFAULTS,
} from './js/ambient-nature.js';
import { createAmbientStream, renderAmbient } from './js/ambient-profiles.js';

const sampleRate = 48000;
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log('PASS ', msg);
    passed++;
  } else {
    console.error('FAIL ', msg);
    failed++;
  }
}

console.log('=== Air freeze identity ===');
{
  const a = renderAmbient(sampleRate, sampleRate, 0xa11);
  const stream = createAmbientStream('air', sampleRate, 0xa11);
  const b = stream.render(sampleRate);
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDiff) maxDiff = d;
  }
  assert(maxDiff < 1e-7, `air stream identity maxDiff=${maxDiff}`);
}

console.log('\n=== Tide / Elements continuous render ===');
for (const [name, factory] of [
  ['tide', createTideStream],
  ['elements', createElementsStream],
]) {
  const s = factory(sampleRate, 0xc0ffee, { transport: 'room' });
  const buf = s.render(sampleRate * 3);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sum += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sum / buf.length);
  assert(peak > 0.01 && peak < 1.5, `${name} peak=${peak.toFixed(3)}`);
  assert(rms > 0.005 && rms < 0.6, `${name} rms=${rms.toFixed(4)}`);
  assert(s.profileId === name, `${name} profileId`);
}

console.log('\n=== Tonality check (4s Tide / Elements) ===');
for (const [name, factory] of [
  ['tide', createTideStream],
  ['elements', createElementsStream],
]) {
  const buf = factory(sampleRate, 0x71de, { transport: 'room' }).render(sampleRate * 4);
  const { suspiciousPeaks, frames } = analyzeTonality(buf, sampleRate, {
    belowHz: 4000,
    seconds: 4,
  });
  console.log(
    `  ${name}: frames=${frames} suspiciousPeaks=${suspiciousPeaks.length}` +
      (suspiciousPeaks[0]
        ? ` top=${suspiciousPeaks[0].hz.toFixed(0)}Hz ×${suspiciousPeaks[0].ratio.toFixed(1)}`
        : '')
  );
  // Flag only extreme persistent peaks (ratio > 25) as hard fail — aid not theorem
  const bad = suspiciousPeaks.filter((p) => p.ratio > 25 && p.hz < 4000);
  assert(bad.length === 0, `${name} no extreme tonal peaks <4kHz`);
}

console.log('\n=== Wave interval periodicity (5 min control timing) ===');
{
  const intervals = collectWaveIntervals(0x71de00, 300);
  const { score, lag } = intervalAutocorrScore(intervals);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const min = Math.min(...intervals);
  const max = Math.max(...intervals);
  console.log(
    `  n=${intervals.length} mean=${mean.toFixed(2)}s min=${min.toFixed(2)} max=${max.toFixed(2)} autocorr=${score.toFixed(3)}@lag${lag}`
  );
  assert(min >= TIDE_DEFAULTS.TIDE_INTERVAL_MIN - 0.01, 'interval min bound');
  assert(max <= TIDE_DEFAULTS.TIDE_INTERVAL_MAX + 0.01, 'interval max bound');
  assert(score < 0.35, `no strong mechanical periodicity (score=${score.toFixed(3)})`);
}

console.log('\n=== Call transport support bed present ===');
{
  const room = createTideStream(sampleRate, 0xabc, { transport: 'room' }).render(sampleRate);
  const call = createTideStream(sampleRate, 0xabc, { transport: 'call' }).render(sampleRate);
  let diff = 0;
  for (let i = 0; i < room.length; i++) diff += Math.abs(room[i] - call[i]);
  assert(diff > 1, `call support bed changes mix (L1=${diff.toFixed(1)})`);
}

console.log('\n=== Legacy breathing → tide alias ===');
{
  const s = createAmbientStream('breathing', sampleRate, 0x1);
  assert(s.profileId === 'tide', 'breathing alias → tide');
}

console.log('\n=== Defaults exported ===');
assert(ELEMENTS_DEFAULTS.ELEMENTS_RAIN_GAIN > 0, 'ELEMENTS_RAIN_GAIN');
assert(TIDE_DEFAULTS.TIDE_WAVE_GAIN > 0, 'TIDE_WAVE_GAIN');

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
