/**
 * Shared nature ambience: Tide + Elements.
 * Continuous stochastic process — no loops, no audio assets, no protocol logic.
 *
 * createAmbientSession({ profile, transport, sampleRate, seed, debug })
 *   transport: 'room' | 'call'
 *
 * Air is intentionally NOT implemented here — use frozen createAirStream /
 * createCallAir wrappers in ambient-profiles.js / call-ambient.js.
 */

import {
  clamp,
  createSeededStreams,
  createPinkNoise,
  createBrownNoise,
  createSmoothRandomModulator,
  createRandomWalk,
  createPoissonEventStream,
  gaussianLike,
  createBandPass,
  createLowPass,
  createHighPass,
  shapedWaveEnvelope,
  createTinyAmbience,
} from './ambient-core.js';
import { createXorshift32 } from './protocol.js';

// ---------------------------------------------------------------------------
// Tunable mix constants (exposed via stream.debugParams / ?debug=1)
// ---------------------------------------------------------------------------

export const TIDE_DEFAULTS = Object.freeze({
  TIDE_WAVE_GAIN: 0.72,
  TIDE_SEA_BED_GAIN: 0.28,
  TIDE_FOAM_GAIN: 0.48,
  TIDE_SPRAY_GAIN: 0.16,
  TIDE_SPRAY_BED_GAIN: 0.09, // continuous fine spray for 5–10 kHz mask floor
  TIDE_HARMONIC_GAIN: 0, // optional; 0 = off (avoids whale character)
  TIDE_MACRO_DB: 0.9, // < 1.5 dB macro shaping
  TIDE_INTERVAL_MEAN: 8.0,
  TIDE_INTERVAL_STD: 1.2,
  TIDE_INTERVAL_MIN: 5.8,
  TIDE_INTERVAL_MAX: 10.5,
});

export const ELEMENTS_DEFAULTS = Object.freeze({
  ELEMENTS_RAIN_GAIN: 0.52,
  ELEMENTS_DROPLET_GAIN: 0.18,
  ELEMENTS_WIND_GAIN: 0.28,
  ELEMENTS_WATER_GAIN: 0.12, // distant relative to rain (~-12 to -20 dB feel)
  ELEMENTS_BRIGHTNESS: 0.55,
  ELEMENTS_DROPLET_RATE: 12, // events/sec nominal (varies stochastically)
});

export const CALL_SUPPORT_DEFAULTS = Object.freeze({
  CALL_SUPPORT_GAIN: 0.22,
});

const SOLO_MODES = Object.freeze([
  'full',
  'base',
  'events',
  'watermarkBed',
  // Tide-specific aliases used by debug UI
  'seaBed',
  'waves',
  'foam',
  'rainBed',
  'droplets',
  'wind',
  'water',
  'support',
]);

/**
 * Shared session factory used by room (tx) and call (tx2).
 * Audible character stays recognisably the same; call adds a quiet support bed.
 */
export function createAmbientSession({
  profile,
  transport = 'room',
  sampleRate,
  seed,
  debug = null,
} = {}) {
  const id = profile === 'elements' ? 'elements' : 'tide';
  if (id === 'tide') {
    return createTideStream(sampleRate, seed, { transport, debug });
  }
  return createElementsStream(sampleRate, seed, { transport, debug });
}

// ---------------------------------------------------------------------------
// Call support bed — broad low/mid texture for ~600–3200 Hz (not tones)
// ---------------------------------------------------------------------------

function createCallSupportBed(sampleRate, seed) {
  const rng = createXorshift32((seed ^ 0xbed0001) >>> 0 || 0x1);
  const pink = createPinkNoise(rng);
  const brown = createBrownNoise(createXorshift32((seed ^ 0xbed0002) >>> 0 || 0x1));
  const bp = createBandPass(sampleRate, 650, 3000);
  const lp = createLowPass(sampleRate, 2800);
  // Extremely quiet fixed harmonics in the call band (fixed pitch, no vibrato)
  const harms = [780, 1160, 1740, 2460].map((f) => ({
    phase: rng.nextFloat() * Math.PI * 2,
    inc: (2 * Math.PI * f) / sampleRate,
  }));
  return {
    next() {
      let x = pink.next() * 0.55 + brown.next() * 0.35;
      x = bp.process(x);
      x = lp.process(x);
      let h = 0;
      for (const p of harms) {
        h += Math.sin(p.phase) * 0.04;
        p.phase += p.inc;
      }
      return x * 0.85 + h * 0.15;
    },
  };
}

function mergeParams(defaults, debug) {
  const p = { ...defaults };
  if (debug && typeof debug === 'object') {
    for (const k of Object.keys(defaults)) {
      if (typeof debug[k] === 'number' && Number.isFinite(debug[k])) {
        p[k] = debug[k];
      }
    }
  }
  return p;
}

function soloGain(solo, layer, profile) {
  if (!solo || solo === 'full') return 1;
  if (solo === 'watermarkBed' || solo === 'support') {
    return layer === 'support' || layer === 'sprayBed' ? 1 : 0;
  }
  if (solo === 'base') {
    if (profile === 'tide') return layer === 'seaBed' || layer === 'sprayBed' ? 1 : 0;
    return layer === 'rainBed' || layer === 'wind' ? 1 : 0;
  }
  if (solo === 'events') {
    if (profile === 'tide') return layer === 'waves' || layer === 'foam' ? 1 : 0;
    return layer === 'droplets' || layer === 'water' ? 1 : 0;
  }
  // named solos
  if (solo === layer) return 1;
  if (solo === 'waves' && (layer === 'waves' || layer === 'foam')) return 1;
  if (solo === 'foam' && layer === 'foam') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// TIDE
// ---------------------------------------------------------------------------

export function createTideStream(sampleRate, seed, { transport = 'room', debug = null } = {}) {
  const streams = createSeededStreams(seed, [
    'noise',
    'macro',
    'wave',
    'wind',
    'foam',
    'spray',
  ]);
  const params = mergeParams(TIDE_DEFAULTS, debug);
  let solo = (debug && debug.solo) || 'full';

  const brown = createBrownNoise(streams.noise);
  const pink = createPinkNoise(createXorshift32((seed ^ 0x71de) >>> 0 || 0x1));
  const pinkR = createPinkNoise(createXorshift32((seed ^ 0x71df) >>> 0 || 0x1)); // stereo-ish indep

  // Sea bed: low broad water + subtle distant foam
  const bedLp = createLowPass(sampleRate, 900);
  const bedHp = createHighPass(sampleRate, 60);
  const bedFoam = createBandPass(sampleRate, 600, 2800);
  const bedLevel = createSmoothRandomModulator(streams.macro, {
    sampleRate,
    minHz: 0.03,
    maxHz: 0.09,
    minVal: 0.72,
    maxVal: 1.0,
    smoothness: 0.9992,
  });

  // Wave body / foam / spray filters (fixed centres — no moving resonance)
  const bodyBp = createBandPass(sampleRate, 100, 1200);
  const foamBpA = createBandPass(sampleRate, 700, 3500);
  const foamBpB = createBandPass(sampleRate, 2000, 7000);
  const sprayBp = createBandPass(sampleRate, 3000, Math.min(11000, sampleRate * 0.45));
  const sprayBedBp = createBandPass(sampleRate, 4800, Math.min(10500, sampleRate * 0.45));

  // Continuous spray bed for watermark mask floor between waves
  const sprayBedLevel = createSmoothRandomModulator(streams.spray, {
    sampleRate,
    minHz: 0.04,
    maxHz: 0.12,
    minVal: 0.75,
    maxVal: 1.15,
    smoothness: 0.999,
  });

  // Macro breath-feel shaping (< ~1 dB), aperiodic
  const macro = createSmoothRandomModulator(streams.macro, {
    sampleRate,
    minHz: 0.05,
    maxHz: 0.14,
    minVal: -1,
    maxVal: 1,
    smoothness: 0.9994,
  });

  // Optional fixed harmonic warmth (default off)
  const harmPhases = [146.83, 220.0, 329.63].map((f) => ({
    phase: streams.wave.nextFloat() * Math.PI * 2,
    inc: (2 * Math.PI * f) / sampleRate,
  }));
  const harmLp = createLowPass(sampleRate, 900);

  const space = createTinyAmbience(sampleRate, { wet: 0.06 });
  const support =
    transport === 'call' ? createCallSupportBed(sampleRate, seed ^ 0xca11) : null;
  const callGain = CALL_SUPPORT_DEFAULTS.CALL_SUPPORT_GAIN;

  // Wave event state — continuous, irregular
  let nextWaveAt = 2.5 + streams.wave.nextFloat() * 2.0;
  let waveStart = -100;
  let rise = 2.2;
  let crest = 0.5;
  let release = 4.0;
  let waveAmp = 1;

  // Soft foam residual after crest
  let foamTail = 0;

  let sampleIndex = 0;
  const invSr = 1 / sampleRate;

  function scheduleNextWave(t) {
    const interval = clamp(
      gaussianLike(streams.wave, params.TIDE_INTERVAL_MEAN, params.TIDE_INTERVAL_STD),
      params.TIDE_INTERVAL_MIN,
      params.TIDE_INTERVAL_MAX
    );
    nextWaveAt = t + interval;
    rise = 1.8 + streams.wave.nextFloat() * 1.2;
    crest = 0.3 + streams.wave.nextFloat() * 0.5;
    release = 3.0 + streams.wave.nextFloat() * 2.5;
    waveAmp = 0.82 + streams.wave.nextFloat() * 0.28;
  }

  const api = {
    profileId: 'tide',
    transport,
    debugParams: params,
    setDebugParam(key, value) {
      if (key in params && typeof value === 'number') params[key] = value;
    },
    setSolo(mode) {
      if (SOLO_MODES.includes(mode)) solo = mode;
    },
    getSolo() {
      return solo;
    },
    getSeed() {
      return seed;
    },
    render(n) {
      const out = new Float32Array(n);
      let bedL = bedLevel.peek();
      let sprayL = sprayBedLevel.peek();
      let macroG = 1;
      let ctrlCountdown = 0;

      for (let i = 0; i < n; i++) {
        if (ctrlCountdown <= 0) {
          bedL = bedLevel.next();
          sprayL = sprayBedLevel.next();
          const macroDb = params.TIDE_MACRO_DB * macro.next();
          macroG = Math.pow(10, macroDb / 20);
          ctrlCountdown = 32;
        }
        ctrlCountdown--;

        const t = sampleIndex * invSr;

        if (t >= nextWaveAt) {
          waveStart = t;
          scheduleNextWave(t);
        }

        const wt = t - waveStart;
        const env = shapedWaveEnvelope(wt, rise, crest, release) * waveAmp;
        const foamGate = clamp(
          (wt - rise * 0.55) / Math.max(0.2, rise * 0.45 + crest + release * 0.35),
          0,
          1
        );
        const foamEnv = env * (0.35 + 0.65 * foamGate);
        foamTail = Math.max(foamTail * (1 - 3 * invSr), foamEnv);

        const br = brown.next();
        const pk = pink.next();
        const pkR = pinkR.next();

        let sea =
          bedHp.process(bedLp.process(br * 0.7 + pk * 0.25)) * bedL;
        sea += bedFoam.process(pkR) * 0.18;
        sea *= params.TIDE_SEA_BED_GAIN;

        let body = bodyBp.process(br * 0.85 + pk * 0.2) * env * params.TIDE_WAVE_GAIN;

        let foam =
          (foamBpA.process(pk) * 0.55 + foamBpB.process(pkR) * 0.45) *
          Math.max(foamEnv, foamTail * 0.4) *
          params.TIDE_FOAM_GAIN;

        const sprayEvt =
          foamEnv > 0.02
            ? sprayBp.process(pkR * 0.7 + streams.spray.nextGaussian() * 0.15) *
              foamEnv *
              params.TIDE_SPRAY_GAIN
            : 0;
        const sprayBed =
          sprayBedBp.process(pkR) * sprayL * params.TIDE_SPRAY_BED_GAIN;

        let harm = 0;
        if (params.TIDE_HARMONIC_GAIN > 1e-6) {
          for (const p of harmPhases) {
            harm += Math.sin(p.phase);
            p.phase += p.inc;
          }
          harm = harmLp.process(harm / harmPhases.length) * params.TIDE_HARMONIC_GAIN;
        }

        let supportS = 0;
        if (support) supportS = support.next() * callGain;

        const gSea = soloGain(solo, 'seaBed', 'tide');
        const gWave = soloGain(solo, 'waves', 'tide');
        const gFoam = soloGain(solo, 'foam', 'tide');
        const gSpray = soloGain(solo, 'foam', 'tide');
        const gBed = soloGain(solo, 'sprayBed', 'tide');
        const gSup = soloGain(solo, 'support', 'tide');

        let mix =
          sea * gSea +
          body * gWave +
          foam * gFoam +
          sprayEvt * gSpray +
          sprayBed * gBed +
          harm * gSea +
          supportS * gSup;

        mix = space.process(mix) * macroG;
        out[i] = clamp(mix, -1.2, 1.2);
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// ELEMENTS
// ---------------------------------------------------------------------------

export function createElementsStream(
  sampleRate,
  seed,
  { transport = 'room', debug = null } = {}
) {
  const streams = createSeededStreams(seed, [
    'noise',
    'rain',
    'drop',
    'wind',
    'water',
    'macro',
  ]);
  const params = mergeParams(ELEMENTS_DEFAULTS, debug);
  let solo = (debug && debug.solo) || 'full';

  const brown = createBrownNoise(streams.noise);
  const pink = createPinkNoise(createXorshift32((seed ^ 0xe1e1) >>> 0 || 0x1));
  const pink2 = createPinkNoise(createXorshift32((seed ^ 0xe1e2) >>> 0 || 0x1));

  // Rain bed
  const rainHp = createHighPass(sampleRate, 1500);
  const rainLp = createLowPass(
    sampleRate,
    Math.min(11000, sampleRate * 0.45)
  );
  const rainDensity = createSmoothRandomModulator(streams.rain, {
    sampleRate,
    minHz: 0.04,
    maxHz: 0.11,
    minVal: 0.78,
    maxVal: 1.12,
    smoothness: 0.9991,
  });
  const rainBright = createSmoothRandomModulator(streams.rain, {
    sampleRate,
    minHz: 0.03,
    maxHz: 0.09,
    minVal: 0.4,
    maxVal: 0.9,
    smoothness: 0.9993,
  });

  // Droplets — short noise bursts, Poisson
  const dropRateMod = createSmoothRandomModulator(streams.drop, {
    sampleRate,
    minHz: 0.05,
    maxHz: 0.15,
    minVal: 5,
    maxVal: 20,
    smoothness: 0.999,
  });
  const drops = createPoissonEventStream(streams.drop, sampleRate, params.ELEMENTS_DROPLET_RATE);
  // Active droplet voices (fixed pool — no alloc in process)
  const MAX_DROPS = 24;
  const dropVoices = new Array(MAX_DROPS);
  for (let i = 0; i < MAX_DROPS; i++) {
    dropVoices[i] = {
      active: false,
      age: 0,
      dur: 0,
      amp: 0,
      // simple one-pole band via lp/hp state
      hpPrevIn: 0,
      hpPrevOut: 0,
      lpY: 0,
      hpX: 0.99,
      lpX: 0.9,
    };
  }
  let dropWrite = 0;

  // Wind — coloured noise, shelving, NO resonant moving BP
  const windHp = createHighPass(sampleRate, 80);
  const windLp = createLowPass(sampleRate, 2200);
  const windLevel = createSmoothRandomModulator(streams.wind, {
    sampleRate,
    minHz: 0.04,
    maxHz: 0.12, // ~4–20 s feel via smoothness
    minVal: 0.7,
    maxVal: 1.05,
    smoothness: 0.9995,
  });
  const windBright = createSmoothRandomModulator(streams.wind, {
    sampleRate,
    minHz: 0.03,
    maxHz: 0.08,
    minVal: 0.55,
    maxVal: 1.0,
    smoothness: 0.9996,
  });
  const windWalk = createRandomWalk(streams.wind, {
    sampleRate,
    step: 0.00025,
    restore: 0.00008,
    minVal: -0.35,
    maxVal: 0.35,
  });

  // Distant water — softer/sparser Tide-like waves
  let nextWaveAt = 8 + streams.water.nextFloat() * 6;
  let waveStart = -100;
  let rise = 2.5;
  let crest = 0.6;
  let release = 4.5;
  let waveAmp = 0.7;
  const waterBody = createBandPass(sampleRate, 80, 900);
  const waterFoam = createBandPass(sampleRate, 500, 2200);

  const space = createTinyAmbience(sampleRate, { wet: 0.07 });
  const support =
    transport === 'call' ? createCallSupportBed(sampleRate, seed ^ 0xca12) : null;
  const callGain = CALL_SUPPORT_DEFAULTS.CALL_SUPPORT_GAIN;

  // Room HF mask bed (quiet continuous rain-top for 5–10 kHz)
  const maskBp =
    transport === 'room'
      ? createBandPass(sampleRate, 5000, Math.min(10000, sampleRate * 0.45))
      : null;

  let sampleIndex = 0;
  const invSr = 1 / sampleRate;

  function spawnDrop() {
    const v = dropVoices[dropWrite];
    dropWrite = (dropWrite + 1) % MAX_DROPS;
    // Population: 70% distant, 25% medium, 5% closer
    const r = streams.drop.nextFloat();
    let pop = 0; // distant
    if (r > 0.95) pop = 2;
    else if (r > 0.7) pop = 1;

    const centre = 2000 + streams.drop.nextFloat() * 7000; // 2–9 kHz
    const bw = 1800 + streams.drop.nextFloat() * 2200;
    const low = Math.max(800, centre - bw * 0.5);
    const high = Math.min(sampleRate * 0.45, centre + bw * 0.5);
    v.active = true;
    v.age = 0;
    v.dur = (0.008 + streams.drop.nextFloat() * 0.037) * sampleRate; // 8–45 ms
    const ampScale = pop === 2 ? 0.55 : pop === 1 ? 0.28 : 0.12;
    v.amp = ampScale * (0.5 + streams.drop.nextFloat() * 0.5);
    v.hpX = Math.exp((-2 * Math.PI * low) / sampleRate);
    v.lpX = Math.exp((-2 * Math.PI * high) / sampleRate);
    v.hpPrevIn = 0;
    v.hpPrevOut = 0;
    v.lpY = 0;
  }

  const api = {
    profileId: 'elements',
    transport,
    debugParams: params,
    setDebugParam(key, value) {
      if (key in params && typeof value === 'number') params[key] = value;
    },
    setSolo(mode) {
      if (SOLO_MODES.includes(mode)) solo = mode;
    },
    getSolo() {
      return solo;
    },
    getSeed() {
      return seed;
    },
    render(n) {
      const out = new Float32Array(n);
      let dens = rainDensity.peek();
      let bright = rainBright.peek() * params.ELEMENTS_BRIGHTNESS;
      let rate = params.ELEMENTS_DROPLET_RATE;
      let wBright = windBright.peek();
      let wLevel = windLevel.peek();
      let wWalk = 0;
      let ctrlCountdown = 0;
      rainLp.setCutoff(4000 + bright * 7000);
      windLp.setCutoff(900 + wBright * 1600);

      for (let i = 0; i < n; i++) {
        if (ctrlCountdown <= 0) {
          dens = rainDensity.next();
          bright = rainBright.next() * params.ELEMENTS_BRIGHTNESS;
          rate = params.ELEMENTS_DROPLET_RATE * 0.35 + dropRateMod.next() * 0.65;
          drops.setRate(rate);
          wBright = windBright.next();
          wLevel = windLevel.next();
          wWalk = windWalk.next();
          rainLp.setCutoff(4000 + bright * 7000);
          windLp.setCutoff(900 + wBright * 1600);
          ctrlCountdown = 64;
        }
        ctrlCountdown--;

        const t = sampleIndex * invSr;
        if (drops.next()) spawnDrop();

        const wh = streams.noise.nextGaussian();
        const pk = pink.next();
        const br = brown.next();

        let rain = rainLp.process(rainHp.process(pk * 0.7 + wh * 0.25));
        rain *= dens * params.ELEMENTS_RAIN_GAIN;

        let dropSum = 0;
        for (let d = 0; d < MAX_DROPS; d++) {
          const v = dropVoices[d];
          if (!v.active) continue;
          const x = streams.drop.nextGaussian();
          let h = v.hpX * (v.hpPrevOut + x - v.hpPrevIn);
          v.hpPrevIn = x;
          v.hpPrevOut = h;
          v.lpY = (1 - v.lpX) * h + v.lpX * v.lpY;
          const env = 1 - v.age / v.dur;
          dropSum += v.lpY * v.amp * env * env;
          v.age++;
          if (v.age >= v.dur) v.active = false;
        }
        dropSum *= params.ELEMENTS_DROPLET_GAIN;

        let wind = windLp.process(windHp.process(br * 0.8 + pink2.next() * 0.2));
        wind *= wLevel * (1 + wWalk * 0.15) * params.ELEMENTS_WIND_GAIN;

        if (t >= nextWaveAt) {
          waveStart = t;
          rise = 2.0 + streams.water.nextFloat() * 1.2;
          crest = 0.4 + streams.water.nextFloat() * 0.5;
          release = 3.5 + streams.water.nextFloat() * 2.5;
          waveAmp = 0.55 + streams.water.nextFloat() * 0.3;
          nextWaveAt =
            t + clamp(gaussianLike(streams.water, 11.5, 2.2), 8.5, 16.0);
        }
        const wEnv = shapedWaveEnvelope(t - waveStart, rise, crest, release) * waveAmp;
        const water =
          (waterBody.process(br) * 0.75 + waterFoam.process(pk) * 0.3) *
          wEnv *
          params.ELEMENTS_WATER_GAIN;

        let mask = 0;
        if (maskBp) {
          mask = maskBp.process(wh) * 0.045 * dens;
        }

        let supportS = 0;
        if (support) supportS = support.next() * callGain;

        const gRain = soloGain(solo, 'rainBed', 'elements');
        const gDrop = soloGain(solo, 'droplets', 'elements');
        const gWind = soloGain(solo, 'wind', 'elements');
        const gWater = soloGain(solo, 'water', 'elements');
        const gSup = soloGain(solo, 'support', 'elements');
        const gMask = soloGain(solo, 'sprayBed', 'elements');

        let mix =
          rain * gRain +
          dropSum * gDrop +
          wind * gWind +
          water * gWater +
          mask * gMask +
          supportS * gSup;

        mix = space.process(mix);
        out[i] = clamp(mix, -1.2, 1.2);
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };

  return api;
}

/**
 * Offline helpers for tonality / periodicity debug tests.
 */
export function collectWaveIntervals(seed, seconds = 300) {
  const rng = createXorshift32((seed ^ 0x71de00) >>> 0 || 0x1);
  const intervals = [];
  let t = 0;
  while (t < seconds) {
    const iv = clamp(
      gaussianLike(rng, TIDE_DEFAULTS.TIDE_INTERVAL_MEAN, TIDE_DEFAULTS.TIDE_INTERVAL_STD),
      TIDE_DEFAULTS.TIDE_INTERVAL_MIN,
      TIDE_DEFAULTS.TIDE_INTERVAL_MAX
    );
    intervals.push(iv);
    t += iv;
  }
  return intervals;
}

/** In-place radix-2 real FFT magnitude (N must be power of 2). */
function fftMagSq(re) {
  const N = re.length;
  const im = new Float64Array(N);
  // bit reverse
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nWRe;
      }
    }
  }
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = re[k] * re[k] + im[k] * im[k];
  return mag;
}

export function analyzeTonality(buffer, sampleRate, { belowHz = 4000, seconds = 4 } = {}) {
  // Fast radix-2 FFT periodogram — debug aid for whale-like narrow peaks.
  const n = Math.min(buffer.length, Math.floor(seconds * sampleRate));
  const N = 1024;
  const hop = 512;
  const bins = N / 2;
  const accum = new Float64Array(bins);
  let frames = 0;

  for (let start = 0; start + N <= n; start += hop) {
    const re = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = buffer[start + i] * w;
    }
    const mag = fftMagSq(re);
    for (let k = 0; k < bins; k++) accum[k] += mag[k];
    frames++;
  }
  if (frames === 0) return { suspiciousPeaks: [], frames: 0 };

  const peaks = [];
  const maxBin = Math.min(bins - 2, Math.floor((belowHz * N) / sampleRate));
  for (let k = 3; k < maxBin; k++) {
    const v = accum[k] / frames;
    const neigh =
      (accum[k - 2] + accum[k - 1] + accum[k + 1] + accum[k + 2]) / (4 * frames);
    if (v > neigh * 8 && v > 1e-8) {
      peaks.push({
        hz: (k * sampleRate) / N,
        ratio: v / Math.max(neigh, 1e-20),
      });
    }
  }
  peaks.sort((a, b) => b.ratio - a.ratio);
  return { suspiciousPeaks: peaks.slice(0, 8), frames };
}

export function intervalAutocorrScore(intervals) {
  // Crude periodicity score: normalized autocorr peak for lags 2..40
  const n = intervals.length;
  if (n < 20) return { score: 0, lag: 0 };
  const mean = intervals.reduce((a, b) => a + b, 0) / n;
  let varSum = 0;
  for (const x of intervals) varSum += (x - mean) * (x - mean);
  if (varSum < 1e-12) return { score: 1, lag: 1 }; // perfectly constant = bad
  let best = 0;
  let bestLag = 0;
  for (let lag = 2; lag <= Math.min(40, Math.floor(n / 3)); lag++) {
    let c = 0;
    for (let i = 0; i < n - lag; i++) {
      c += (intervals[i] - mean) * (intervals[i + lag] - mean);
    }
    c /= varSum;
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  return { score: best, lag: bestLag };
}
