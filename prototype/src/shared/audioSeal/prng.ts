/**
 * Documented 32-bit xorshift PRNG for AENV1 protocol structure.
 * Never use Math.random() for interleave, bases, or hops.
 */

export function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    return state >>> 0;
  };
}

/** Uniform float in [0, 1). */
export function nextUnit(rng: () => number): number {
  return rng() / 0x100000000;
}

/** Inclusive integer in [0, maxInclusive]. */
export function nextInt(rng: () => number, maxInclusive: number): number {
  if (maxInclusive < 0) throw new Error("maxInclusive must be >= 0");
  const span = maxInclusive + 1;
  // Rejection sampling to avoid modulo bias for small spans.
  const limit = Math.floor(0x100000000 / span) * span;
  let v = rng();
  while (v >= limit) v = rng();
  return v % span;
}

/** Mix several 32-bit keys into one seed. */
export function mixSeeds(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
