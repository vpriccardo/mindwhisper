/**
 * Deterministic Fisher–Yates interleaver seeded only by AENV_VERSION_SEED.
 * Permutation built once at module init.
 */

import { AENV_VERSION_SEED, CODED_BITS } from "./constants";
import { nextInt, xorshift32 } from "./prng";

function buildPermutation(): {
  forward: Uint16Array;
  inverse: Uint16Array;
  checksum: number;
} {
  const forward = new Uint16Array(CODED_BITS);
  for (let i = 0; i < CODED_BITS; i++) forward[i] = i;
  const rng = xorshift32(AENV_VERSION_SEED);
  for (let i = CODED_BITS - 1; i >= 1; i--) {
    const j = nextInt(rng, i);
    const tmp = forward[i]!;
    forward[i] = forward[j]!;
    forward[j] = tmp;
  }
  const inverse = new Uint16Array(CODED_BITS);
  for (let i = 0; i < CODED_BITS; i++) {
    inverse[forward[i]!] = i;
  }
  let checksum = 0;
  for (let i = 0; i < CODED_BITS; i++) {
    checksum = (checksum + ((forward[i]! + 1) * (i + 3))) >>> 0;
  }
  return { forward, inverse, checksum };
}

const TABLE = buildPermutation();

export const INTERLEAVE_FORWARD = TABLE.forward;
export const INTERLEAVE_INVERSE = TABLE.inverse;
export const INTERLEAVE_CHECKSUM = TABLE.checksum;

export function interleaveBits(bits: Int8Array): Int8Array {
  if (bits.length !== CODED_BITS) throw new Error("interleave: bad length");
  const out = new Int8Array(CODED_BITS);
  for (let i = 0; i < CODED_BITS; i++) {
    out[i] = bits[INTERLEAVE_FORWARD[i]!]!;
  }
  return out;
}

export function deinterleaveBits(bits: Int8Array): Int8Array {
  if (bits.length !== CODED_BITS) throw new Error("deinterleave: bad length");
  const out = new Int8Array(CODED_BITS);
  for (let i = 0; i < CODED_BITS; i++) {
    out[INTERLEAVE_FORWARD[i]!] = bits[i]!;
  }
  return out;
}

export function interleaveSoft(soft: Float64Array): Float64Array {
  if (soft.length !== CODED_BITS) throw new Error("interleaveSoft: bad length");
  const out = new Float64Array(CODED_BITS);
  for (let i = 0; i < CODED_BITS; i++) {
    out[i] = soft[INTERLEAVE_FORWARD[i]!]!;
  }
  return out;
}

export function deinterleaveSoft(soft: Float64Array): Float64Array {
  if (soft.length !== CODED_BITS) throw new Error("deinterleaveSoft: bad length");
  const out = new Float64Array(CODED_BITS);
  for (let i = 0; i < CODED_BITS; i++) {
    out[INTERLEAVE_FORWARD[i]!] = soft[i]!;
  }
  return out;
}
