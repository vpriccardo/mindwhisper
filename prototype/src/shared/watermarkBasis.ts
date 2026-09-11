/**
 * Deterministic watermark basis for Hidden envelope (carrierId envelope-v1).
 * Same PRNG must match Python reference tests. Never uses Math.random().
 */

export const CARRIER_ID = "envelope-v1";
export const BASIS_VERSION = 1;
/** Implementation detail — not a cryptographic secret. */
export const BASIS_KEY = "intuizione-henv1-basis-v1";

export const CANONICAL_WIDTH = 768;
export const CANONICAL_HEIGHT = 512;
export const GRID_W = 96;
export const GRID_H = 64;
export const BIT_COUNT = 56;
export const GUARD_FRACTION = 0.04;
export const MAX_BASIS_NCC = 0.08;
export const MIN_MASK_COVERAGE = 0.35;

/** Mulberry32-style mix; identical across browser, worker, Node, Python. */
export function mix32(a: number): number {
  let t = (a >>> 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

export function hashString32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function cellSeed(
  carrierId: string,
  basisKey: string,
  bitIndex: number,
  cellX: number,
  cellY: number,
  attempt: number,
): number {
  let h = hashString32(carrierId);
  h = mix32(h ^ hashString32(basisKey));
  h = mix32(h ^ (bitIndex + 1) * 0x9e3779b1);
  h = mix32(h ^ (cellX + 1) * 0x85ebca6b);
  h = mix32(h ^ (cellY + 1) * 0xc2b2ae35);
  h = mix32(h ^ (attempt + 1) * 0x27d4eb2d);
  return h >>> 0;
}

/** Balanced -1/+1 from seed (LSB). */
export function signedFromSeed(seed: number): number {
  return (seed & 1) === 1 ? 1 : -1;
}

export type EligibilityMask = {
  /** Length GRID_W * GRID_H, values in [0,1]. */
  weights: Float32Array;
  coverage: number;
};

export function guardEligible(cellX: number, cellY: number): boolean {
  const gx0 = Math.floor(GRID_W * GUARD_FRACTION);
  const gy0 = Math.floor(GRID_H * GUARD_FRACTION);
  const gx1 = Math.ceil(GRID_W * (1 - GUARD_FRACTION)) - 1;
  const gy1 = Math.ceil(GRID_H * (1 - GUARD_FRACTION)) - 1;
  return cellX >= gx0 && cellX <= gx1 && cellY >= gy0 && cellY <= gy1;
}

/**
 * Generate 56 basis fields over the grid, zero-mean on eligible cells,
 * rejecting fields with |NCC| > MAX_BASIS_NCC vs any previous field.
 */
export function generateBasisFields(
  mask: EligibilityMask,
  options?: { carrierId?: string; basisKey?: string },
): { fields: Float32Array[]; checksum: string } {
  const carrierId = options?.carrierId ?? CARRIER_ID;
  const basisKey = options?.basisKey ?? BASIS_KEY;
  const n = GRID_W * GRID_H;
  const eligible: number[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = y * GRID_W + x;
      if (guardEligible(x, y) && (mask.weights[i] ?? 0) > 0) {
        eligible.push(i);
      }
    }
  }
  if (eligible.length < 16) {
    throw new Error("Too few eligible cells for basis generation.");
  }

  const fields: Float32Array[] = [];
  for (let bit = 0; bit < BIT_COUNT; bit++) {
    let attempt = 0;
    let accepted: Float32Array | null = null;
    while (attempt < 10_000) {
      const field = new Float32Array(n);
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const i = y * GRID_W + x;
          if (!guardEligible(x, y) || (mask.weights[i] ?? 0) <= 0) {
            field[i] = 0;
            continue;
          }
          const seed = cellSeed(carrierId, basisKey, bit, x, y, attempt);
          field[i] = signedFromSeed(seed);
        }
      }
      // Zero mean over eligible cells.
      let sum = 0;
      for (const i of eligible) sum += field[i]!;
      const mean = sum / eligible.length;
      for (const i of eligible) field[i]! -= mean;

      let ok = true;
      for (const prev of fields) {
        if (Math.abs(normalizedCorrelation(field, prev, eligible)) > MAX_BASIS_NCC) {
          ok = false;
          break;
        }
      }
      if (ok) {
        accepted = field;
        break;
      }
      attempt++;
    }
    if (!accepted) {
      throw new Error(`Failed to generate orthogonal-enough basis for bit ${bit}`);
    }
    fields.push(accepted);
  }

  return { fields, checksum: basisChecksum(fields) };
}

export function normalizedCorrelation(
  a: Float32Array,
  b: Float32Array,
  indices: number[],
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const i of indices) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na * nb);
  if (denom < 1e-12) return 0;
  return dot / denom;
}

export function basisChecksum(fields: Float32Array[]): string {
  // FNV-1a 64-bit-ish via two 32-bit lanes for stable hex.
  let h0 = 2166136261 >>> 0;
  let h1 = 0x811c9dc5 >>> 0;
  for (let f = 0; f < fields.length; f++) {
    const field = fields[f]!;
    for (let i = 0; i < field.length; i++) {
      // Quantize to milli-units for stable cross-language checksum.
      const q = Math.round(field[i]! * 1000);
      const u = q >>> 0;
      h0 ^= u & 0xff;
      h0 = Math.imul(h0, 16777619);
      h0 ^= (u >>> 8) & 0xff;
      h0 = Math.imul(h0, 16777619);
      h0 ^= (u >>> 16) & 0xff;
      h0 = Math.imul(h0, 16777619);
      h0 ^= (u >>> 24) & 0xff;
      h0 = Math.imul(h0, 16777619);
      h1 ^= (f + i + 1) & 0xff;
      h1 = Math.imul(h1, 16777619) >>> 0;
    }
  }
  return (
    h0.toString(16).padStart(8, "0") + h1.toString(16).padStart(8, "0")
  );
}
