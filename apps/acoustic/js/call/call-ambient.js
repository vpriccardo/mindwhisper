/**
 * Call-resilient ambient profiles.
 * Normal UI: Meditation (MP3 + quiet Call Air bed + support) / Air.
 * Tide / Elements remain behind ?debug=1 only.
 */

import { createXorshift32 } from '../protocol.js';
import { CALL_AMBIENT_SEED_DEFAULT } from './call-constants.js';
import {
  createAmbientSession,
  TIDE_DEFAULTS,
  ELEMENTS_DEFAULTS,
  CALL_SUPPORT_DEFAULTS,
} from '../ambient-nature.js';

/** Normal UI profiles (production). */
export const CALL_AMBIENT_PROFILES = Object.freeze({
  meditation: {
    id: 'meditation',
    label: 'Meditation',
    subtitle: 'Calm ambient meditation',
  },
  air: {
    id: 'air',
    label: 'Air',
    subtitle: 'Original atmospheric sound',
  },
});

/** Extra profiles only when ?debug=1 */
export const DEBUG_CALL_AMBIENT_PROFILES = Object.freeze({
  tide: {
    id: 'tide',
    label: 'Tide (debug)',
    subtitle: 'Procedural ocean — engineering only',
  },
  elements: {
    id: 'elements',
    label: 'Elements (debug)',
    subtitle: 'Procedural rain — engineering only',
  },
});

export const DEFAULT_CALL_AMBIENT_PROFILE = 'meditation';
export const CALL_PROFILE_IDS = Object.keys(CALL_AMBIENT_PROFILES);
export const ALL_CALL_PROFILE_IDS = [
  ...CALL_PROFILE_IDS,
  ...Object.keys(DEBUG_CALL_AMBIENT_PROFILES),
];

/** @deprecated alias — old id maps to tide (debug) */
export const CALL_LEGACY_PROFILE_ALIASES = Object.freeze({
  breathing: 'tide',
  tide: 'tide',
  elements: 'elements',
});

function onePoleLpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

function onePoleHpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

export function resolveProfileId(profileId) {
  const raw = CALL_LEGACY_PROFILE_ALIASES[profileId] || profileId;
  if (CALL_PROFILE_IDS.includes(raw)) return raw;
  if (ALL_CALL_PROFILE_IDS.includes(raw)) return raw;
  return 'air';
}

/**
 * Shared codec-preservation bed used by frozen Call Air (and Meditation bed).
 * Tide/Elements use ambient-nature call support bed instead.
 */
function createCodecBed(sampleRate, seed) {
  const rng = createXorshift32(seed ^ 0xbed0001);
  // Inter-channel / intra-pair gaps only (never inside a call LOW/HIGH band).
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
  seed = CALL_AMBIENT_SEED_DEFAULT,
  debug = null
) {
  const id = resolveProfileId(profileId);
  if (id === 'air') return createCallAir(sampleRate, seed);
  // Meditation: no support bed / Air / hiss — carriers only (music on separate bus).
  if (id === 'meditation') return createSilentCallStream(sampleRate);
  return createAmbientSession({
    profile: id,
    transport: 'call',
    sampleRate,
    seed,
    debug,
  });
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

export { TIDE_DEFAULTS, ELEMENTS_DEFAULTS, CALL_SUPPORT_DEFAULTS, createAmbientSession };

function createSilentCallStream(sampleRate) {
  let sampleIndex = 0;
  return {
    profileId: 'meditation',
    render(n) {
      sampleIndex += n;
      return new Float32Array(n);
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };
}

// ---------------------------------------------------------------------------
// Call Air — FROZEN reliability reference (do not regenerate with Tide/Elements)
// ---------------------------------------------------------------------------

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
