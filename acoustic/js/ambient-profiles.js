/**
 * Ambient / presentation profiles for room-v1 TX (tx.html).
 * "air" is the reliability reference — keep its spectral character stable.
 * "meditation" uses a trimmed MP3 on a separate music bus; the ambient stream
 * for that profile is a quiet Air bed under the existing watermark carriers.
 *
 * Tide / Elements remain available only for ?debug=1 engineering comparisons.
 *
 * ROOM-V1 ONLY — call (tx2/rx2) must not edit this file; use js/call/call-ambient.js.
 */

import { createXorshift32, AMBIENT_SEED_DEFAULT } from './protocol.js';
import {
  createAmbientSession,
  createTideStream,
  createElementsStream,
  TIDE_DEFAULTS,
  ELEMENTS_DEFAULTS,
} from './ambient-nature.js';

/** Normal UI profiles (production). */
export const AMBIENT_PROFILES = Object.freeze({
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
export const DEBUG_AMBIENT_PROFILES = Object.freeze({
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

export const DEFAULT_AMBIENT_PROFILE = 'meditation';
export const PROFILE_IDS = Object.keys(AMBIENT_PROFILES);
export const ALL_PROFILE_IDS = [
  ...PROFILE_IDS,
  ...Object.keys(DEBUG_AMBIENT_PROFILES),
];

/** @deprecated alias */
export const LEGACY_PROFILE_ALIASES = Object.freeze({
  breathing: 'tide',
  tide: 'tide',
  elements: 'elements',
});

const PAD_FREQS = [146.83, 220.0, 329.63]; // D3 A3 E4 — Air only

function onePoleLpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

function onePoleHpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

export function resolveProfileId(profileId, { allowDebug = true } = {}) {
  const raw = LEGACY_PROFILE_ALIASES[profileId] || profileId;
  if (PROFILE_IDS.includes(raw)) return raw;
  if (allowDebug && ALL_PROFILE_IDS.includes(raw)) return raw;
  return 'air';
}

/**
 * Offline render of a profile into Float32Array (for tests / A-B / legacy path).
 * Meditation uses quiet Air bed (music is not included in PCM offline render).
 */
export function renderAmbientProfile(profileId, sampleRate, lengthSamples, seed = AMBIENT_SEED_DEFAULT) {
  const stream = createAmbientStream(profileId, sampleRate, seed);
  return stream.render(lengthSamples);
}

/** @deprecated use renderAmbientProfile('air', ...) — kept for Air regression identity */
export function renderAmbient(sampleRate, lengthSamples, seed = AMBIENT_SEED_DEFAULT) {
  return renderAmbientProfile('air', sampleRate, lengthSamples, seed);
}

/**
 * Create continuous ambient stream used under watermark notches/carriers.
 * Meditation → quiet Air bed (music plays on a separate bus).
 */
export function createAmbientStream(profileId, sampleRate, seed = AMBIENT_SEED_DEFAULT, debug = null) {
  const id = resolveProfileId(profileId);
  if (id === 'air') return createAirStream(sampleRate, seed);
  if (id === 'meditation') return createSilentStream(sampleRate);
  if (id === 'tide') {
    return createAmbientSession({
      profile: 'tide',
      transport: 'room',
      sampleRate,
      seed,
      debug,
    });
  }
  if (id === 'elements') {
    return createAmbientSession({
      profile: 'elements',
      transport: 'room',
      sampleRate,
      seed,
      debug,
    });
  }
  return createAirStream(sampleRate, seed);
}

export {
  createAmbientSession,
  createTideStream,
  createElementsStream,
  TIDE_DEFAULTS,
  ELEMENTS_DEFAULTS,
};

function createSilentStream(sampleRate) {
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
// Air — FROZEN reliability reference (faithful streaming port of renderAmbient)
// Do not regenerate with Tide/Elements algorithms. Identity-tested in run-tests.
// ---------------------------------------------------------------------------

function createAirStream(sampleRate, seed) {
  const rng = createXorshift32(seed);
  const detuneRng = createXorshift32(seed ^ 0x5555);

  let brown = 0;
  const windHpX = onePoleHpCoef(sampleRate, 100);
  const windLpX = onePoleLpCoef(sampleRate, 3000);
  let windHpPrevIn = 0;
  let windHpPrevOut = 0;
  let windLpY = 0;

  const rainHpX = onePoleHpCoef(sampleRate, 2000);
  const rainLpX = onePoleLpCoef(sampleRate, Math.min(13000, sampleRate * 0.45));
  let rainHpPrevIn = 0;
  let rainHpPrevOut = 0;
  let rainLpY = 0;

  const pads = PAD_FREQS.map((f0) => {
    const det = 1 + (detuneRng.nextFloat() - 0.5) * 0.003;
    const f = f0 * det;
    return {
      f0,
      phase: detuneRng.nextFloat() * Math.PI * 2,
      phaseInc: (2 * Math.PI * f) / sampleRate,
      phase2: detuneRng.nextFloat() * Math.PI * 2,
      phaseInc2: (2 * Math.PI * f * (1 + 0.0015)) / sampleRate,
    };
  });
  const padLpX = onePoleLpCoef(sampleRate, 1200);
  let padLpY = 0;

  let sampleIndex = 0;
  const gainPad = 0.12;
  const gainWind = 0.22;
  const gainRain = 0.28;

  return {
    profileId: 'air',
    render(n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = sampleIndex / sampleRate;
        const white = rng.nextGaussian();
        brown = 0.996 * brown + 0.04 * white;

        let w = windHpX * (windHpPrevOut + brown - windHpPrevIn);
        windHpPrevIn = brown;
        windHpPrevOut = w;
        windLpY = (1 - windLpX) * w + windLpX * windLpY;
        w = windLpY;

        let r = rainHpX * (rainHpPrevOut + white - rainHpPrevIn);
        rainHpPrevIn = white;
        rainHpPrevOut = r;
        rainLpY = (1 - rainLpX) * r + rainLpX * rainLpY;
        r = rainLpY;

        let pad = 0;
        for (const p of pads) {
          const slowEnv = 0.85 + 0.15 * Math.sin(2 * Math.PI * t * 0.07 + p.f0 * 0.01);
          const s =
            Math.sin(p.phase) * 0.55 +
            Math.sin(p.phase2) * 0.25 +
            Math.sin(p.phase * 2) * 0.08;
          pad += s * slowEnv;
          p.phase += p.phaseInc;
          p.phase2 += p.phaseInc2;
        }
        padLpY = (1 - padLpX) * pad + padLpX * padLpY;

        const windMod = 0.75 + 0.25 * Math.sin(2 * Math.PI * t * 0.04);
        const rainMod = 0.85 + 0.15 * Math.sin(2 * Math.PI * t * 0.11 + 1.3);
        out[i] =
          padLpY * gainPad +
          w * gainWind * windMod +
          r * gainRain * rainMod;
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };
}
