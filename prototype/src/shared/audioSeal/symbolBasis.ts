/**
 * Deterministic DSSS/BPSK symbol bases for AENV1.
 */

import {
  AENV_BASIS_KEY,
  AENV_VERSION_SEED,
  CHIPS_PER_SYMBOL,
  HOP_FREQUENCIES_HZ,
  NUM_SYMBOLS,
  SAMPLE_RATE,
  SAMPLES_PER_CHIP,
  SYMBOL_SAMPLES,
} from "./constants";
import { mixSeeds, xorshift32 } from "./prng";

function unitRmsInPlace(buf: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  const rms = Math.sqrt(sum / buf.length) || 1;
  const g = 1 / rms;
  for (let i = 0; i < buf.length; i++) buf[i]! *= g;
}

function raisedCosineTaper(buf: Float32Array, edge: number): void {
  const n = buf.length;
  const e = Math.min(edge, Math.floor(n / 4));
  for (let i = 0; i < e; i++) {
    const w = 0.5 * (1 - Math.cos((Math.PI * i) / e));
    buf[i]! *= w;
    buf[n - 1 - i]! *= w;
  }
}

function makeChips(symbolIndex: number): Int8Array {
  let attempt = 0;
  while (attempt < 64) {
    const rng = xorshift32(
      mixSeeds(AENV_VERSION_SEED, AENV_BASIS_KEY, symbolIndex, attempt + 1),
    );
    const chips = new Int8Array(CHIPS_PER_SYMBOL);
    // Start balanced then shuffle
    for (let i = 0; i < CHIPS_PER_SYMBOL; i++) {
      chips[i] = i < CHIPS_PER_SYMBOL / 2 ? 1 : -1;
    }
    for (let i = CHIPS_PER_SYMBOL - 1; i >= 1; i--) {
      const j = rng() % (i + 1);
      const tmp = chips[i]!;
      chips[i] = chips[j]!;
      chips[j] = tmp;
    }
    let dc = 0;
    for (let i = 0; i < chips.length; i++) dc += chips[i]!;
    if (dc !== 0) {
      attempt++;
      continue;
    }
    // Reject if consecutive runs too long (poor spreading)
    let run = 1;
    let maxRun = 1;
    for (let i = 1; i < chips.length; i++) {
      if (chips[i] === chips[i - 1]) {
        run++;
        if (run > maxRun) maxRun = run;
      } else run = 1;
    }
    if (maxRun > 6) {
      attempt++;
      continue;
    }
    return chips;
  }
  throw new Error(`Failed to build balanced chips for symbol ${symbolIndex}`);
}

function hopFrequency(symbolIndex: number): number {
  const rng = xorshift32(mixSeeds(AENV_VERSION_SEED, 0x40f, symbolIndex));
  const idx = rng() % HOP_FREQUENCIES_HZ.length;
  return HOP_FREQUENCIES_HZ[idx]!;
}

function synthesizeBasis(symbolIndex: number): Float32Array {
  const chips = makeChips(symbolIndex);
  const freq = hopFrequency(symbolIndex);
  const out = new Float32Array(SYMBOL_SAMPLES);
  let phase = 0;
  const dphi = (2 * Math.PI * freq) / SAMPLE_RATE;
  for (let c = 0; c < CHIPS_PER_SYMBOL; c++) {
    const chip = chips[c]!;
    const off = c * SAMPLES_PER_CHIP;
    for (let s = 0; s < SAMPLES_PER_CHIP; s++) {
      out[off + s] = chip * Math.sin(phase);
      phase += dphi;
    }
  }
  raisedCosineTaper(out, Math.round(0.001 * SAMPLE_RATE));
  // Remove residual DC
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i]!;
  mean /= out.length;
  for (let i = 0; i < out.length; i++) out[i]! -= mean;
  unitRmsInPlace(out);
  return out;
}

function ncc(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

let basesCache: Float32Array[] | null = null;

/** All 156 unit-RMS symbol bases (bit=1 polarity). */
export function getSymbolBases(): Float32Array[] {
  if (basesCache) return basesCache;
  const bases: Float32Array[] = [];
  for (let i = 0; i < NUM_SYMBOLS; i++) {
    let basis = synthesizeBasis(i);
    // Reject / regenerate if adjacent NCC too high
    if (i > 0) {
      let tries = 0;
      while (Math.abs(ncc(basis, bases[i - 1]!)) > 0.25 && tries < 32) {
        // Nudge by regenerating with different attempt via mixing tries into index path
        // Remake chips with offset attempt inside makeChips is already attempt loop;
        // force different hop by synthesizing with a salted index key via remake:
        const alt = synthesizeBasisAlternate(i, tries + 1);
        basis = alt;
        tries++;
      }
    }
    bases.push(basis);
  }
  basesCache = bases;
  return bases;
}

function synthesizeBasisAlternate(symbolIndex: number, salt: number): Float32Array {
  const chips = makeChipsAlternate(symbolIndex, salt);
  const rng = xorshift32(mixSeeds(AENV_VERSION_SEED, 0x40f, symbolIndex, salt));
  const freq = HOP_FREQUENCIES_HZ[rng() % HOP_FREQUENCIES_HZ.length]!;
  const out = new Float32Array(SYMBOL_SAMPLES);
  let phase = 0;
  const dphi = (2 * Math.PI * freq) / SAMPLE_RATE;
  for (let c = 0; c < CHIPS_PER_SYMBOL; c++) {
    const chip = chips[c]!;
    const off = c * SAMPLES_PER_CHIP;
    for (let s = 0; s < SAMPLES_PER_CHIP; s++) {
      out[off + s] = chip * Math.sin(phase);
      phase += dphi;
    }
  }
  raisedCosineTaper(out, Math.round(0.001 * SAMPLE_RATE));
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i]!;
  mean /= out.length;
  for (let i = 0; i < out.length; i++) out[i]! -= mean;
  unitRmsInPlace(out);
  return out;
}

function makeChipsAlternate(symbolIndex: number, salt: number): Int8Array {
  const rng = xorshift32(
    mixSeeds(AENV_VERSION_SEED, AENV_BASIS_KEY, symbolIndex, 1000 + salt),
  );
  const chips = new Int8Array(CHIPS_PER_SYMBOL);
  for (let i = 0; i < CHIPS_PER_SYMBOL; i++) {
    chips[i] = i < CHIPS_PER_SYMBOL / 2 ? 1 : -1;
  }
  for (let i = CHIPS_PER_SYMBOL - 1; i >= 1; i--) {
    const j = rng() % (i + 1);
    const tmp = chips[i]!;
    chips[i] = chips[j]!;
    chips[j] = tmp;
  }
  return chips;
}

export function adjacentBasisMaxAbsNcc(): number {
  const bases = getSymbolBases();
  let max = 0;
  for (let i = 1; i < bases.length; i++) {
    const c = Math.abs(ncc(bases[i]!, bases[i - 1]!));
    if (c > max) max = c;
  }
  return max;
}

export function modulateInterleavedBits(bits: Int8Array): Float32Array {
  if (bits.length !== NUM_SYMBOLS) throw new Error("Expected 156 bits");
  const bases = getSymbolBases();
  const out = new Float32Array(NUM_SYMBOLS * SYMBOL_SAMPLES);
  for (let i = 0; i < NUM_SYMBOLS; i++) {
    const sign = bits[i]! === 1 ? 1 : -1;
    const basis = bases[i]!;
    const off = i * SYMBOL_SAMPLES;
    for (let s = 0; s < SYMBOL_SAMPLES; s++) {
      out[off + s] = sign * basis[s]!;
    }
  }
  return out;
}
