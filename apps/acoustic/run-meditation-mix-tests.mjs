/**
 * Meditation mix calibration matrix (synthetic).
 * Room presets: carrier RMS relative to assumed music RMS (−15.3 dBFS).
 * Call presets: base/enhancement relative to the same reference.
 *
 * Does NOT prove physical iPhone reliability.
 * Run: node run-meditation-mix-tests.mjs
 */
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const js = (n) => pathToFileURL(join(__dirname, 'js', n)).href;
const callJs = (n) => pathToFileURL(join(__dirname, 'js', 'call', n)).href;

const {
  ACOUSTIC_CONFIG,
  ROOM_PRESET_ORDER,
  CALL_PRESET_ORDER,
  relativeDbToGain,
  measureFloat32Stats,
  roomCarrierDbForPreset,
  callLevelsForPreset,
} = await import(js('acoustic-config.js'));
const { StreamingTxRenderer } = await import(js('tx-engine.js'));
const { decodePcmBuffer } = await import(js('rx-decoder.js'));
const { CallStreamingTxRenderer } = await import(callJs('call-tx.js'));
const { decodeCallPcmBuffer } = await import(callJs('call-rx.js'));

const sampleRate = 48000;
const message = 'TESTCASE1';
/** Typical decoded meditation loudness (browser-measured). */
const MUSIC_RMS_DB = -15.3;

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

function calibrateRoomRef() {
  const cal = new StreamingTxRenderer({
    message,
    sampleRate,
    profileId: 'meditation',
    ambientGain: 0,
    carrierLevel: 1,
  });
  const n = Math.round(sampleRate * 0.4);
  return measureFloat32Stats(
    cal.renderChunk({ lengthSamples: n, ambientOnly: false }).samples
  );
}

function renderRoomAtRelativeDb(relativeDb, carrierRef) {
  const gain = relativeDbToGain(MUSIC_RMS_DB, relativeDb, carrierRef.rmsDb);
  const renderer = new StreamingTxRenderer({
    message,
    sampleRate,
    profileId: 'meditation',
    ambientGain: 0,
    carrierLevel: gain,
  });
  const frameSamples = renderer.frameSamples;
  const lead = Math.round(sampleRate * 0.4);
  const total = lead + frameSamples * 3;
  const out = new Float32Array(total);
  let o = 0;
  const a = renderer.renderChunk({
    lengthSamples: lead,
    ambientOnly: true,
    fadeIn: true,
  });
  out.set(a.samples, o);
  o += a.samples.length;
  while (o < total) {
    const n = Math.min(renderer.symbolSamples * 4, total - o);
    const c = renderer.renderChunk({ lengthSamples: n, ambientOnly: false });
    out.set(c.samples, o);
    o += c.samples.length;
  }
  const stats = measureFloat32Stats(out);
  return { samples: out, stats, gain, peak: stats.peak };
}

function calibrateCallRefs() {
  const cal = new CallStreamingTxRenderer({
    message,
    sampleRate,
    profileId: 'meditation',
    ambientMix: 0,
    carrierLevel: 1,
    baseCarrierLevel: 1,
    enhCarrierLevel: 1,
    enableEnhancement: true,
  });
  const n = Math.round(sampleRate * 0.5);
  const chunk = cal.renderChunk({
    lengthSamples: n,
    ambientOnly: false,
    splitCarriers: true,
    watermarkEnabled: true,
  });
  return {
    base: measureFloat32Stats(chunk.baseSamples),
    enh: measureFloat32Stats(chunk.enhSamples),
  };
}

function renderCallAtPreset(presetId, refs) {
  const levels = callLevelsForPreset(presetId);
  const baseGain = relativeDbToGain(
    MUSIC_RMS_DB,
    levels.baseDb,
    refs.base.rmsDb
  );
  const enhGain = relativeDbToGain(
    MUSIC_RMS_DB,
    levels.enhancementDb,
    refs.enh.rmsDb
  );
  const renderer = new CallStreamingTxRenderer({
    message,
    sampleRate,
    profileId: 'meditation',
    ambientMix: 0,
    carrierLevel: 0,
    baseCarrierLevel: 1,
    enhCarrierLevel: 1,
    enableEnhancement: true,
  });
  const lead = Math.round(sampleRate * 0.5);
  const total = lead + renderer.frameSamples * 2;
  const out = new Float32Array(total);
  let o = 0;
  const a = renderer.renderChunk({
    lengthSamples: lead,
    ambientOnly: true,
    fadeIn: true,
    splitCarriers: true,
  });
  // lead is silence (ambientMix 0)
  o += a.samples.length;
  while (o < total) {
    const n = Math.min(renderer.symbolSamples * 4, total - o);
    const c = renderer.renderChunk({
      lengthSamples: n,
      ambientOnly: false,
      watermarkEnabled: true,
      splitCarriers: true,
    });
    for (let i = 0; i < n; i++) {
      out[o + i] = c.baseSamples[i] * baseGain + c.enhSamples[i] * enhGain;
    }
    o += n;
  }
  const stats = measureFloat32Stats(out);
  return { samples: out, stats, baseGain, enhGain, levels, peak: stats.peak };
}

console.log('=== Meditation mix config ===');
console.log('Assumed music RMS:', MUSIC_RMS_DB, 'dBFS');
console.log('Master gain (live):', ACOUSTIC_CONFIG.masterGain);
console.log('Music gain (live):', ACOUSTIC_CONFIG.meditationMusicGain);

console.log('\n=== Room carrier reference ===');
const roomRef = calibrateRoomRef();
console.log(
  `Room unity carrier RMS=${roomRef.rmsDb.toFixed(2)} dBFS peak=${roomRef.peakDb.toFixed(2)} dBFS`
);

console.log('\n=== Room preset matrix ===');
const roomResults = [];
for (const id of ROOM_PRESET_ORDER) {
  const db = roomCarrierDbForPreset(id);
  const t0 = Date.now();
  const rendered = renderRoomAtRelativeDb(db, roomRef);
  const r = decodePcmBuffer(rendered.samples, sampleRate);
  const ok = !!(r.result && r.result.ok && r.result.message === message);
  const relativeEst = rendered.stats.rmsDb - MUSIC_RMS_DB;
  roomResults.push({ id, db, ok, stats: r.stats, peak: rendered.peak, relativeEst });
  console.log(
    `  ${ACOUSTIC_CONFIG.room.labels[id]} (${db} dB): ok=${ok} crc=${r.stats.framesCrcValid} fail=${r.stats.framesCrcFailed} peak=${rendered.peak.toFixed(3)} carrierRms≈${rendered.stats.rmsDb.toFixed(1)} rel≈${relativeEst.toFixed(1)} (${Date.now() - t0}ms)`
  );
  assert(ok, `room ${id} decode`);
  assert(rendered.peak < 0.99, `room ${id} no clip peak=${rendered.peak}`);
}

console.log('\n=== Call carrier reference ===');
const callRefs = calibrateCallRefs();
console.log(
  `Base unity RMS=${callRefs.base.rmsDb.toFixed(2)} Enh unity RMS=${callRefs.enh.rmsDb.toFixed(2)}`
);

console.log('\n=== Call preset matrix ===');
const callResults = [];
for (const id of CALL_PRESET_ORDER) {
  const t0 = Date.now();
  const rendered = renderCallAtPreset(id, callRefs);
  const r = decodeCallPcmBuffer(rendered.samples, sampleRate);
  const ok = !!(r.result && r.result.ok && r.result.message === message);
  callResults.push({
    id,
    ok,
    stats: r.stats,
    peak: rendered.peak,
    levels: rendered.levels,
  });
  console.log(
    `  ${ACOUSTIC_CONFIG.call.labels[id]} (base ${rendered.levels.baseDb} / enh ${rendered.levels.enhancementDb}): ok=${ok} crc=${r.stats.framesCrcValid} fail=${r.stats.framesCrcFailed} peak=${rendered.peak.toFixed(3)} (${Date.now() - t0}ms)`
  );
  assert(ok, `call ${id} decode`);
  assert(rendered.peak < 0.99, `call ${id} no clip`);
}

console.log('\n=== Air unchanged smoke ===');
{
  const air = new StreamingTxRenderer({
    message,
    sampleRate,
    profileId: 'air',
    ambientGain: 1.55,
    carrierLevel: 0.05,
  });
  const n = air.frameSamples * 3;
  const out = new Float32Array(n);
  let o = 0;
  const lead = air.renderChunk({
    lengthSamples: Math.round(sampleRate * 0.6),
    ambientOnly: true,
    fadeIn: true,
  });
  out.set(lead.samples, 0);
  o = lead.samples.length;
  while (o < n) {
    const c = air.renderChunk({
      lengthSamples: Math.min(air.symbolSamples * 8, n - o),
      ambientOnly: false,
    });
    out.set(c.samples, o);
    o += c.samples.length;
  }
  const r = decodePcmBuffer(out, sampleRate);
  assert(
    r.result && r.result.ok && r.result.message === message,
    `Air still decodes (got ${r.result && r.result.message})`
  );
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);

console.log('\nJSON_RESULTS ' + JSON.stringify({ roomResults, callResults, roomRef, callRefs, MUSIC_RMS_DB }));
