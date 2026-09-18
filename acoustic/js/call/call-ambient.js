/**
 * Call-resilient ambient profiles (Breathing / Elements / Air).
 * Same UX names as room-v1; spectral energy concentrated in ~600–3200 Hz
 * plus a shared codec-preservation bed. Rhythms are NOT synced to the frame.
 */

import { createXorshift32 } from '../protocol.js';
import { CALL_AMBIENT_SEED_DEFAULT } from './call-constants.js';

export const CALL_AMBIENT_PROFILES = Object.freeze({
  breathing: {
    id: 'breathing',
    label: 'Breathing',
    subtitle: 'Slow, soft inhale/exhale — call-safe',
  },
  elements: {
    id: 'elements',
    label: 'Elements',
    subtitle: 'Soft rain and wind under the call band',
  },
  air: {
    id: 'air',
    label: 'Air',
    subtitle: 'Steady warm air texture for calls',
  },
});

export const DEFAULT_CALL_AMBIENT_PROFILE = 'breathing';
export const CALL_PROFILE_IDS = Object.keys(CALL_AMBIENT_PROFILES);

function onePoleLpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

function onePoleHpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

/**
 * Shared codec-preservation bed: dense 700–2800 Hz energy that survives
 * telephone / Opus / WebRTC band-limiting better than sparse tones.
 */
function createCodecBed(sampleRate, seed) {
  const rng = createXorshift32(seed ^ 0xbed0001);
  // Inter-channel / intra-pair gaps only (never inside a call LOW/HIGH band).
  // Was 2860 — that sat inside channel-5 LOW (2700–2920).
  const centres = [780, 960, 1160, 1350, 1740, 2180, 2660, 2940];
  const bands = centres.map((c) => {
    const bw = 90 + (c % 50);
    const lp = onePoleLpCoef(sampleRate, c + bw * 0.5);
    const hp = onePoleHpCoef(sampleRate, Math.max(80, c - bw * 0.5));
    return {
      lp,
      hp,
      hpPrevIn: 0,
      hpPrevOut: 0,
      lpY: 0,
      phase: rng.nextFloat() * Math.PI * 2,
      phaseInc: (2 * Math.PI * (c * (0.92 + rng.nextFloat() * 0.08))) / sampleRate,
      level: 0.08 + rng.nextFloat() * 0.04,
    };
  });
  let brown = 0;
  return {
    next() {
      const white = rng.nextGaussian();
      brown = 0.995 * brown + 0.04 * white;
      let sum = brown * 0.045;
      for (const b of bands) {
        let x = white * 0.55 + Math.sin(b.phase) * 0.35;
        b.phase += b.phaseInc;
        let h = b.hp * (b.hpPrevOut + x - b.hpPrevIn);
        b.hpPrevIn = x;
        b.hpPrevOut = h;
        b.lpY = (1 - b.lp) * h + b.lp * b.lpY;
        sum += b.lpY * b.level;
      }
      return sum;
    },
  };
}

export function createCallAmbientStream(
  profileId,
  sampleRate,
  seed = CALL_AMBIENT_SEED_DEFAULT
) {
  const id = CALL_PROFILE_IDS.includes(profileId) ? profileId : 'air';
  if (id === 'breathing') return createCallBreathing(sampleRate, seed);
  if (id === 'elements') return createCallElements(sampleRate, seed);
  return createCallAir(sampleRate, seed);
}

export function renderCallAmbientProfile(
  profileId,
  sampleRate,
  lengthSamples,
  seed = CALL_AMBIENT_SEED_DEFAULT
) {
  const stream = createCallAmbientStream(profileId, sampleRate, seed);
  return stream.render(lengthSamples);
}

function createCallAir(sampleRate, seed) {
  const rng = createXorshift32(seed);
  const bed = createCodecBed(sampleRate, seed);

  const windHp = onePoleHpCoef(sampleRate, 120);
  const windLp = onePoleLpCoef(sampleRate, 2800);
  let windHpPrevIn = 0;
  let windHpPrevOut = 0;
  let windLpY = 0;
  let brown = 0;

  const padFreqs = [174.61, 220.0, 261.63];
  const pads = padFreqs.map((f) => ({
    phase: rng.nextFloat() * Math.PI * 2,
    inc: (2 * Math.PI * f) / sampleRate,
    phase2: rng.nextFloat() * Math.PI * 2,
    inc2: (2 * Math.PI * f * 1.498) / sampleRate,
  }));
  const padLp = onePoleLpCoef(sampleRate, 900);
  let padLpY = 0;
  let sampleIndex = 0;

  return {
    profileId: 'air',
    render(n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const white = rng.nextGaussian();
        brown = 0.996 * brown + 0.038 * white;

        let wind = windHp * (windHpPrevOut + brown - windHpPrevIn);
        windHpPrevIn = brown;
        windHpPrevOut = wind;
        windLpY = (1 - windLp) * wind + windLp * windLpY;

        let pad = 0;
        for (const p of pads) {
          pad += Math.sin(p.phase) * 0.55 + Math.sin(p.phase2) * 0.22;
          p.phase += p.inc;
          p.phase2 += p.inc2;
        }
        padLpY = (1 - padLp) * pad + padLp * padLpY;

        out[i] =
          bed.next() * 0.55 + windLpY * 0.28 + padLpY * 0.12 + white * 0.02;
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };
}

function createCallBreathing(sampleRate, seed) {
  const rng = createXorshift32(seed);
  const bed = createCodecBed(sampleRate, seed ^ 0x111);

  const CYCLE = 7.2; // seconds — independent of watermark frame
  const INHALE = 2.6;
  const TURN = 0.55;

  const airHp = onePoleHpCoef(sampleRate, 180);
  const airLpBase = onePoleLpCoef(sampleRate, 2400);
  let airHpPrevIn = 0;
  let airHpPrevOut = 0;
  let airLpY = 0;
  let brown = 0;

  const pads = [146.83, 196.0, 246.94].map((f) => ({
    phase: rng.nextFloat() * Math.PI * 2,
    inc: (2 * Math.PI * f) / sampleRate,
    phase2: rng.nextFloat() * Math.PI * 2,
    inc2: (2 * Math.PI * f * 1.5) / sampleRate,
  }));
  const padLp = onePoleLpCoef(sampleRate, 700);
  let padLpY = 0;
  let sampleIndex = 0;

  function breathShape(phase01) {
    const t = phase01 * CYCLE;
    if (t < INHALE) {
      const x = t / INHALE;
      return 0.5 - 0.5 * Math.cos(Math.PI * x);
    }
    if (t < INHALE + TURN) return 1;
    const x = (t - INHALE - TURN) / (CYCLE - INHALE - TURN);
    return 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, x));
  }

  return {
    profileId: 'breathing',
    render(n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = sampleIndex / sampleRate;
        const breath = breathShape((t % CYCLE) / CYCLE);
        const amp = Math.pow(10, ((breath - 0.5) * 4.0) / 20); // ±2 dB
        const bright = 0.6 + 0.4 * breath;

        const white = rng.nextGaussian();
        brown = 0.997 * brown + 0.035 * white;

        let air = airHp * (airHpPrevOut + brown - airHpPrevIn);
        airHpPrevIn = brown;
        airHpPrevOut = air;
        const dynLp = onePoleLpCoef(sampleRate, 1600 + bright * 1800);
        airLpY = (1 - dynLp) * air + dynLp * airLpY;

        let pad = 0;
        for (const p of pads) {
          pad +=
            (Math.sin(p.phase) * 0.5 + Math.sin(p.phase2) * 0.25) *
            (0.8 + 0.2 * breath);
          p.phase += p.inc;
          p.phase2 += p.inc2;
        }
        padLpY = (1 - padLp) * pad + padLp * padLpY;

        out[i] =
          (bed.next() * 0.5 + airLpY * 0.3 + padLpY * 0.14) * amp * 0.95;
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };
}

function createCallElements(sampleRate, seed) {
  const rng = createXorshift32(seed);
  const bed = createCodecBed(sampleRate, seed ^ 0x222);

  const rainHp = onePoleHpCoef(sampleRate, 900);
  const rainLp = onePoleLpCoef(sampleRate, 3200);
  let rainHpPrevIn = 0;
  let rainHpPrevOut = 0;
  let rainLpY = 0;

  const windHp = onePoleHpCoef(sampleRate, 100);
  const windLp = onePoleLpCoef(sampleRate, 1600);
  let windHpPrevIn = 0;
  let windHpPrevOut = 0;
  let windLpY = 0;
  let brown = 0;
  let rainSlow = 0;
  let sampleIndex = 0;

  return {
    profileId: 'elements',
    render(n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = sampleIndex / sampleRate;
        const white = rng.nextGaussian();
        brown = 0.996 * brown + 0.04 * white;
        rainSlow = 0.9997 * rainSlow + 0.0003 * (rng.nextFloat() * 2 - 1);
        const rainAmp = 0.78 + 0.22 * rainSlow;

        let rain = rainHp * (rainHpPrevOut + white - rainHpPrevIn);
        rainHpPrevIn = white;
        rainHpPrevOut = rain;
        rainLpY = (1 - rainLp) * rain + rainLp * rainLpY;
        rain = rainLpY * rainAmp;

        const windMod =
          0.72 +
          0.28 * Math.sin(2 * Math.PI * t * (0.06 + 0.015 * Math.sin(t * 0.01)));
        let wind = windHp * (windHpPrevOut + brown - windHpPrevIn);
        windHpPrevIn = brown;
        windHpPrevOut = wind;
        windLpY = (1 - windLp) * wind + windLp * windLpY;

        out[i] =
          bed.next() * 0.48 + rain * 0.22 + windLpY * windMod * 0.2 + white * 0.015;
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };
}
