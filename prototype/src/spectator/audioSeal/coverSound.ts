/**
 * Procedural envelope/paper/wax cover sound — separate from AENV1 embedder.
 */

import {
  DATA_START,
  GUARD_START,
  PREAMBLE_START,
  SAMPLE_RATE,
  TAIL_START,
  TOTAL_SAMPLES,
} from "../../shared/audioSeal/constants";
import { mixSeeds, xorshift32 } from "../../shared/audioSeal/prng";

export type CoverOptions = {
  /** Deterministic seed for tests. Production omits → crypto random. */
  seed?: number;
};

function resolveSeed(seed?: number): number {
  if (seed !== undefined) return seed >>> 0;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! >>> 0;
}

function noise(rng: () => number): number {
  return rng() / 0x100000000 * 2 - 1;
}

/** Simple one-pole lowpass. */
function lowpassStep(state: { y: number }, x: number, alpha: number): number {
  state.y += alpha * (x - state.y);
  return state.y;
}

function highpassStep(
  state: { x: number; y: number },
  x: number,
  alpha: number,
): number {
  state.y = alpha * (state.y + x - state.x);
  state.x = x;
  return state.y;
}

function envADSR(
  t: number,
  a: number,
  d: number,
  s: number,
  r: number,
  sustainLevel: number,
): number {
  if (t < 0) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - sustainLevel) * ((t - a) / d);
  if (t < a + d + s) return sustainLevel;
  if (t < a + d + s + r) return sustainLevel * (1 - (t - a - d - s) / r);
  return 0;
}

/**
 * Full 2.10 s cover: paper → flap → stamp → wax decay.
 */
export function renderCoverSound(options: CoverOptions = {}): {
  samples: Float32Array;
  seed: number;
} {
  const seed = resolveSeed(options.seed);
  const rng = xorshift32(mixSeeds(seed, 0xc0ffee));
  const out = new Float32Array(TOTAL_SAMPLES);

  const lpPaper = { y: 0 };
  const lpBrown = { y: 0 };
  const hpCrack = { x: 0, y: 0 };

  // Resonators for stamp thump
  let r1 = 0;
  let r1p = 0;
  let r2 = 0;
  let r2p = 0;

  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;

    // Pinkish paper friction throughout
    const white = noise(rng);
    const brown = lowpassStep(lpBrown, white, 0.02);
    const paper = lowpassStep(lpPaper, white * 0.6 + brown * 0.4, 0.08);
    const paperEnv =
      0.22 * envADSR(t, 0.02, 0.08, 1.7, 0.25, 0.55) +
      0.12 * envADSR(t - 0.08, 0.01, 0.05, 0.12, 0.08, 0.4);
    s += paper * paperEnv;

    // Flap close around 0.18–0.28 s (overlaps preamble/guard)
    const flapT = t - 0.18;
    if (flapT > 0 && flapT < 0.14) {
      const click = Math.exp(-flapT * 55) * (noise(rng) * 0.7);
      const whoosh = lowpassStep(lpPaper, noise(rng), 0.15) * envADSR(flapT, 0.005, 0.03, 0.04, 0.06, 0.3);
      s += click * 0.55 + whoosh * 0.35;
    }

    // Stamp wood contact ~1.86 s (tail start) with slight anticipation
    const stampT = t - 1.84;
    if (stampT > -0.02 && stampT < 0.25) {
      const tt = Math.max(0, stampT);
      const transient = Math.exp(-tt * 90) * (noise(rng) * 0.9 + brown * 0.2);
      // Kick resonators
      if (tt < 0.002 && stampT >= 0) {
        r1 += 0.9;
        r2 += 0.55;
      }
      s += transient * 0.7 * envADSR(tt, 0.001, 0.02, 0.05, 0.12, 0.25);
    }

    // Resonant thump
    const f1 = 110;
    const f2 = 220;
    const w1 = (2 * Math.PI * f1) / SAMPLE_RATE;
    const w2 = (2 * Math.PI * f2) / SAMPLE_RATE;
    const nr1 = 2 * Math.cos(w1) * r1 * 0.992 - r1p;
    r1p = r1;
    r1 = nr1;
    const nr2 = 2 * Math.cos(w2) * r2 * 0.985 - r2p;
    r2p = r2;
    r2 = nr2;
    s += r1 * 0.22 + r2 * 0.12;

    // Wax crackle / decay in tail
    if (i >= TAIL_START) {
      const tt = (i - TAIL_START) / SAMPLE_RATE;
      const crack = highpassStep(hpCrack, noise(rng), 0.92);
      s += crack * 0.18 * Math.exp(-tt * 8) * (0.4 + 0.6 * envADSR(tt, 0.0, 0.02, 0.08, 0.15, 0.35));
      s += brown * 0.08 * Math.exp(-tt * 4);
    }

    // Gentle movement in pre-roll / preamble / guard
    if (i < DATA_START) {
      const move = lowpassStep(lpBrown, noise(rng), 0.04);
      const regionBoost =
        i < PREAMBLE_START ? 0.15 : i < GUARD_START ? 0.2 : 0.18;
      s += move * regionBoost;
    }

    out[i] = s;
  }

  // Remove DC and normalize peak to ~-6 dBFS so mixer has headroom
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i]!;
  mean /= out.length;
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    out[i]! -= mean;
    const a = Math.abs(out[i]!);
    if (a > peak) peak = a;
  }
  const target = Math.pow(10, -6 / 20);
  const g = peak > 0 ? target / peak : 1;
  for (let i = 0; i < out.length; i++) out[i]! *= g;

  return { samples: out, seed };
}
