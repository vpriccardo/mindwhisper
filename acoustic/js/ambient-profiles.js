/**
 * Ambient sound profiles for TX.
 * "air" is the reliability reference — keep its spectral character stable.
 * Profiles only affect the perceptual bed; watermark modulation stays separate.
 */

import { createXorshift32, AMBIENT_SEED_DEFAULT } from './protocol.js';

export const AMBIENT_PROFILES = Object.freeze({
  breathing: {
    id: 'breathing',
    label: 'Breathing',
    subtitle: 'Slow, soft inhale/exhale rhythm',
  },
  elements: {
    id: 'elements',
    label: 'Elements',
    subtitle: 'Rain, wind and distant waves',
  },
  air: {
    id: 'air',
    label: 'Air',
    subtitle: 'Original reliable ambient texture',
  },
});

export const DEFAULT_AMBIENT_PROFILE = 'breathing';
export const PROFILE_IDS = Object.keys(AMBIENT_PROFILES);

const PAD_FREQS = [146.83, 220.0, 329.63]; // D3 A3 E4 — shared warm voicing

function onePoleLpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

function onePoleHpCoef(sampleRate, cutoffHz) {
  return Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

/**
 * Offline render of a profile into Float32Array (for tests / A-B / legacy path).
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
 * Create a continuous ambient stream. Call render(n) repeatedly; state advances.
 */
export function createAmbientStream(profileId, sampleRate, seed = AMBIENT_SEED_DEFAULT) {
  const id = PROFILE_IDS.includes(profileId) ? profileId : 'air';
  if (id === 'air') return createAirStream(sampleRate, seed);
  if (id === 'breathing') return createBreathingStream(sampleRate, seed);
  return createElementsStream(sampleRate, seed);
}

// ---------------------------------------------------------------------------
// Air — faithful streaming port of the original renderAmbient
// ---------------------------------------------------------------------------

function createAirStream(sampleRate, seed) {
  const rng = createXorshift32(seed);
  const detuneRng = createXorshift32(seed ^ 0x5555);

  let brown = 0;
  // Wind: HP then LP
  const windHpX = onePoleHpCoef(sampleRate, 100);
  const windLpX = onePoleLpCoef(sampleRate, 3000);
  let windHpPrevIn = 0;
  let windHpPrevOut = 0;
  let windLpY = 0;

  // Rain: HP then LP
  const rainHpX = onePoleHpCoef(sampleRate, 2000);
  const rainLpX = onePoleLpCoef(sampleRate, Math.min(13000, sampleRate * 0.45));
  let rainHpPrevIn = 0;
  let rainHpPrevOut = 0;
  let rainLpY = 0;

  // Pad oscillators (same init order as original)
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

        // Wind path
        let w = windHpX * (windHpPrevOut + brown - windHpPrevIn);
        windHpPrevIn = brown;
        windHpPrevOut = w;
        windLpY = (1 - windLpX) * w + windLpX * windLpY;
        w = windLpY;

        // Rain path
        let r = rainHpX * (rainHpPrevOut + white - rainHpPrevIn);
        rainHpPrevIn = white;
        rainHpPrevOut = r;
        rainLpY = (1 - rainLpX) * r + rainLpX * rainLpY;
        r = rainLpY;

        // Pad
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

// ---------------------------------------------------------------------------
// Breathing — abstract meditative swell (not human breath recording)
// ---------------------------------------------------------------------------

function createBreathingStream(sampleRate, seed) {
  const rng = createXorshift32(seed);
  const detuneRng = createXorshift32(seed ^ 0xB2E4);

  // ~8.7 s cycle, not aligned to frame 5.04 s
  const CYCLE = 8.7;
  const INHALE = 3.7;
  const TURN = 0.5;
  // remainder = exhale

  let brown = 0;
  const airLpX = onePoleLpCoef(sampleRate, 4200);
  const airHpX = onePoleHpCoef(sampleRate, 180);
  let airHpPrevIn = 0;
  let airHpPrevOut = 0;
  let airLpY = 0;

  // Soft HF shimmer / watermark mask bed 5–10 kHz
  const maskHpX = onePoleHpCoef(sampleRate, 4800);
  const maskLpX = onePoleLpCoef(sampleRate, 10500);
  let maskHpPrevIn = 0;
  let maskHpPrevOut = 0;
  let maskLpY = 0;

  const pads = PAD_FREQS.map((f0) => {
    const det = 1 + (detuneRng.nextFloat() - 0.5) * 0.0025;
    return {
      f0,
      phase: detuneRng.nextFloat() * Math.PI * 2,
      phaseInc: (2 * Math.PI * f0 * det) / sampleRate,
      phase2: detuneRng.nextFloat() * Math.PI * 2,
      phaseInc2: (2 * Math.PI * f0 * det * (1.0012)) / sampleRate,
    };
  });
  const padLpX = onePoleLpCoef(sampleRate, 1400);
  let padLpY = 0;

  let sampleIndex = 0;

  function breathShape(phase01) {
    // phase01 in [0,1)
    const t = phase01 * CYCLE;
    if (t < INHALE) {
      const x = t / INHALE;
      return 0.5 - 0.5 * Math.cos(Math.PI * x); // 0→1
    }
    if (t < INHALE + TURN) {
      return 1;
    }
    const x = (t - INHALE - TURN) / (CYCLE - INHALE - TURN);
    return 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, x)); // 1→0
  }

  return {
    profileId: 'breathing',
    render(n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = sampleIndex / sampleRate;
        const phase01 = (t % CYCLE) / CYCLE;
        const breath = breathShape(phase01); // 0..1
        // Keep watermark-safe floor: mix amplitude ±~2.5 dB around mid
        const amp = Math.pow(10, ((breath - 0.5) * 5.0) / 20); // ±2.5 dB
        const brightness = 0.55 + 0.45 * breath; // open spectrum on inhale

        const white = rng.nextGaussian();
        brown = 0.997 * brown + 0.035 * white;

        let air = airHpX * (airHpPrevOut + brown - airHpPrevIn);
        airHpPrevIn = brown;
        airHpPrevOut = air;
        // Brightness moves LP gently
        const dynLp = onePoleLpCoef(sampleRate, 1800 + brightness * 3200);
        airLpY = (1 - dynLp) * air + dynLp * airLpY;
        air = airLpY;

        let mask = maskHpX * (maskHpPrevOut + white - maskHpPrevIn);
        maskHpPrevIn = white;
        maskHpPrevOut = mask;
        maskLpY = (1 - maskLpX) * mask + maskLpX * maskLpY;
        mask = maskLpY;

        let pad = 0;
        for (const p of pads) {
          const env = 0.82 + 0.18 * breath;
          pad +=
            (Math.sin(p.phase) * 0.55 + Math.sin(p.phase2) * 0.28) * env;
          p.phase += p.phaseInc;
          p.phase2 += p.phaseInc2;
        }
        padLpY = (1 - padLpX) * pad + padLpX * padLpY;

        out[i] =
          (padLpY * 0.14 + air * 0.26 + mask * 0.18) * amp * 0.92;
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };
}

// ---------------------------------------------------------------------------
// Elements — soft rain + wind + distant waves
// ---------------------------------------------------------------------------

function createElementsStream(sampleRate, seed) {
  const rng = createXorshift32(seed);
  const waveRng = createXorshift32(seed ^ 0x51a1);

  let brown = 0;
  let pink = 0;

  // Rain fine (HF)
  const rainHpX = onePoleHpCoef(sampleRate, 2500);
  const rainLpX = onePoleLpCoef(sampleRate, Math.min(12000, sampleRate * 0.45));
  let rainHpPrevIn = 0;
  let rainHpPrevOut = 0;
  let rainLpY = 0;

  // Wind mid
  const windHpX = onePoleHpCoef(sampleRate, 80);
  const windLpX = onePoleLpCoef(sampleRate, 1800);
  let windHpPrevIn = 0;
  let windHpPrevOut = 0;
  let windLpY = 0;

  // Waves low
  const waveLpX = onePoleLpCoef(sampleRate, 450);
  let waveLpY = 0;
  const foamHpX = onePoleHpCoef(sampleRate, 900);
  const foamLpX = onePoleLpCoef(sampleRate, 3500);
  let foamHpPrevIn = 0;
  let foamHpPrevOut = 0;
  let foamLpY = 0;

  // Mask bed
  const maskHpX = onePoleHpCoef(sampleRate, 5000);
  const maskLpX = onePoleLpCoef(sampleRate, 10000);
  let maskHpPrevIn = 0;
  let maskHpPrevOut = 0;
  let maskLpY = 0;

  // Soft pad undercurrent
  const padPhase = (2 * Math.PI * 146.83) / sampleRate;
  const padPhase2 = (2 * Math.PI * 220.0) / sampleRate;
  let p1 = waveRng.nextFloat() * Math.PI * 2;
  let p2 = waveRng.nextFloat() * Math.PI * 2;

  // Wave schedule — deterministic but irregular
  let nextWaveAt = 6.5 + waveRng.nextFloat() * 2.5;
  let waveStart = -10;
  let waveDur = 2.2;

  let sampleIndex = 0;
  let rainSlow = 0;

  return {
    profileId: 'elements',
    render(n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = sampleIndex / sampleRate;
        const white = rng.nextGaussian();
        brown = 0.996 * brown + 0.04 * white;
        pink = 0.97 * pink + 0.03 * white;

        // Rain medium fluctuation
        rainSlow =
          0.9997 * rainSlow + 0.0003 * (rng.nextFloat() * 2 - 1);
        const rainAmp = 0.75 + 0.25 * rainSlow;

        let rain = rainHpX * (rainHpPrevOut + white - rainHpPrevIn);
        rainHpPrevIn = white;
        rainHpPrevOut = rain;
        rainLpY = (1 - rainLpX) * rain + rainLpX * rainLpY;
        rain = rainLpY * rainAmp;

        // Occasional soft droplet (rare, filtered)
        let drop = 0;
        if (rng.nextFloat() < 0.00035) {
          drop = (rng.nextFloat() * 2 - 1) * 0.35;
        }
        drop *= 0.92; // will be filtered via rain path blend

        // Wind slow
        const windMod =
          0.7 +
          0.3 *
            Math.sin(2 * Math.PI * t * (0.07 + 0.02 * Math.sin(t * 0.011)));
        let wind = windHpX * (windHpPrevOut + brown - windHpPrevIn);
        windHpPrevIn = brown;
        windHpPrevOut = wind;
        windLpY = (1 - windLpX) * wind + windLpX * windLpY;
        wind = windLpY * windMod;

        // Waves
        if (t >= nextWaveAt) {
          waveStart = t;
          waveDur = 1.8 + waveRng.nextFloat() * 1.2;
          nextWaveAt = t + 6.2 + waveRng.nextFloat() * 3.5;
        }
        let waveEnv = 0;
        const wt = t - waveStart;
        if (wt >= 0 && wt < waveDur) {
          const x = wt / waveDur;
          // rise then soft decay
          waveEnv =
            x < 0.35
              ? 0.5 - 0.5 * Math.cos(Math.PI * (x / 0.35))
              : Math.pow(1 - (x - 0.35) / 0.65, 1.4);
        }
        waveLpY = (1 - waveLpX) * brown + waveLpX * waveLpY;
        let foam = foamHpX * (foamHpPrevOut + pink - foamHpPrevIn);
        foamHpPrevIn = pink;
        foamHpPrevOut = foam;
        foamLpY = (1 - foamLpX) * foam + foamLpX * foamLpY;
        const wave = (waveLpY * 0.85 + foamLpY * 0.25) * waveEnv;

        let mask = maskHpX * (maskHpPrevOut + white - maskHpPrevIn);
        maskHpPrevIn = white;
        maskHpPrevOut = mask;
        maskLpY = (1 - maskLpX) * mask + maskLpX * maskLpY;

        const pad =
          Math.sin(p1) * 0.04 + Math.sin(p2) * 0.03;
        p1 += padPhase;
        p2 += padPhase2;

        out[i] =
          rain * 0.22 +
          drop * 0.04 +
          wind * 0.16 +
          wave * 0.2 +
          mask * 0.14 +
          pad;
        sampleIndex++;
      }
      return out;
    },
    getSampleIndex() {
      return sampleIndex;
    },
  };
}
