/**
 * call-v1 acoustic-layer constants + symbol mapping.
 * Shared protected payload (CRC → Hamming → interleave → scramble) lives in
 * ../protocol.js — this module only pads/packs for the 6-channel call layer.
 */

import {
  CALL_CHANNEL_COUNT,
  CALL_DATA_SYMBOLS,
  CALL_EXTRA_PAD_BITS,
  CALL_TOTAL_BITS,
  TOTAL_BITS,
  encodeProtectedPayload,
  encodeCallMessage,
  decodeFromBits,
  decodeFromCallDataSymbols,
  decodeFromCallBits,
} from '../protocol.js';

export const CALL_PROTOCOL_ID = 'call-v1';

/** Six base differential channels: [lowLow, lowHigh, highLow, highHigh] Hz (§7) */
export const CALL_BASE_CHANNELS = Object.freeze([
  Object.freeze([620, 760, 800, 940]),
  Object.freeze([1000, 1140, 1180, 1320]),
  Object.freeze([1380, 1520, 1560, 1700]),
  Object.freeze([1780, 1940, 1980, 2140]),
  Object.freeze([2220, 2400, 2440, 2620]),
  Object.freeze([2700, 2920, 2960, 3180]),
]);

/** Optional enhancement pairs (§16) — same 6 bits; not required for decode */
export const CALL_ENHANCEMENT_CHANNELS = Object.freeze([
  Object.freeze([3800, 4020, 4100, 4320]),
  Object.freeze([4450, 4670, 4770, 4990]),
  Object.freeze([5120, 5360, 5460, 5700]),
  Object.freeze([5840, 6080, 6200, 6440]),
  Object.freeze([6580, 6820, 6940, 7180]),
  Object.freeze([7300, 7540, 7660, 7900]),
]);

export const ENHANCEMENT_DIFFERENTIAL_DB = 0.9;

/**
 * Total LOW↔HIGH swing per base channel (§9).
 * Spec starts at 1.2 dB. Evidence with multi-partial carriers:
 *   1.2 → ~87% clean (preamble OK, CRC miss)
 *   1.5 → 38/40 = 95% clean
 *   2.0 → target default until real-call A/B can go lower
 * Prefer the lowest value that clears field tests. Debug UI keeps the ladder.
 * Do not revert carrier to filtered-noise alone (that needed ≈3.5 dB).
 */
export const BASE_TOTAL_DIFFERENTIAL_DB = 2.0;
export const BASE_DELTA_DB_OPTIONS = Object.freeze([
  0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0,
]);

export const CALL_CHIP_CODE = Object.freeze([+1, +1, -1, +1, -1, -1, +1, -1]);
export const CHIPS_PER_SYMBOL = 8;
export const CHIP_MS = 40;
export const SYMBOL_MS = CHIP_MS * CHIPS_PER_SYMBOL; // 320
export const CROSSFADE_MS = 10;
export const FEATURE_MS = 20;
export const FEATURES_PER_CHIP = CHIP_MS / FEATURE_MS; // 2
export const FEATURES_PER_SYMBOL = SYMBOL_MS / FEATURE_MS; // 16

export const CALL_PREAMBLE_SYMBOLS = 12;
export const CALL_PREAMBLE = Object.freeze([
  0b111000, 0b000111, 0b110100, 0b001011, 0b101010, 0b010101, 0b100110,
  0b011001, 0b110010, 0b001101, 0b101100, 0b010011,
]);

/** 12 preamble + 46 data = 58 symbols → 18_560 ms */
export const CALL_FRAME_SYMBOLS = CALL_PREAMBLE_SYMBOLS + CALL_DATA_SYMBOLS; // 58
export const CALL_FRAME_MS = CALL_FRAME_SYMBOLS * SYMBOL_MS; // 18560
export const FRAME_DURATION_MS = CALL_FRAME_MS;

export const CALL_PREAMBLE_CORRELATION_MIN = 0.28;
export const CALL_TRACK_WINDOW_MS = 200;
export const CALL_MISSED_FRAMES_TO_SEARCH = 2;
export const CALL_DUPLICATE_SUPPRESS_MS = 25000;
export const CALL_FEATURE_BUFFER_SECONDS = 90;
export const EPSILON_ENERGY = 1e-20;

export const CALL_BAND_COUNT = CALL_CHANNEL_COUNT * 2; // 12 base bands
export const CALL_ENH_BAND_COUNT = CALL_CHANNEL_COUNT * 2; // 12 enhancement
export const CALL_TOTAL_BANDS = CALL_BAND_COUNT + CALL_ENH_BAND_COUNT; // 24

export const CALL_FADE_IN_MS = 800;
export const CALL_FADE_OUT_MS = 800;
export const CALL_CARRIER_LEVEL = 0.35;
/** Ambient mix after band notches — nature/pads must stay in front of carriers. */
export const CALL_AMBIENT_MIX = 1.0;
export const CALL_AMBIENT_SEED_DEFAULT = 0xca11a55e;
export const CALL_CARRIER_SEED_DEFAULT = 0xc0dec0de;

export {
  CALL_CHANNEL_COUNT,
  CALL_DATA_SYMBOLS,
  CALL_EXTRA_PAD_BITS,
  CALL_TOTAL_BITS,
  TOTAL_BITS,
  encodeProtectedPayload,
};

/** Decode path for the shared 272-bit protected bitstream (room or call after strip-pad). */
export function decodeProtectedPayload(softOrHard, opts = {}) {
  return decodeFromBits(softOrHard, opts);
}

/**
 * message → protected 272 bits → pad +4 zeros → 46×6-bit call data symbols.
 * Thin wrapper over protocol.encodeCallMessage (no duplicated CRC/Hamming/etc.).
 */
export function messageToCallDataSymbols(message) {
  const encoded = encodeCallMessage(message);
  return {
    protectedBits: encoded.scrambled, // length TOTAL_BITS (272)
    callBits: encoded.callBits, // length CALL_TOTAL_BITS (276)
    callDataSymbols: encoded.callDataSymbols, // length 46
    encoded,
  };
}

/**
 * 46×6-bit call symbols → strip 4 pad bits → shared protocol decode.
 */
export function callDataSymbolsToMessage(symbolBytes) {
  return decodeFromCallDataSymbols(symbolBytes);
}

/**
 * Soft/hard call bit stream (276 or 272) → shared decode (uses first 272).
 */
export function callBitsToMessage(softOrHard, opts = {}) {
  return decodeFromCallBits(softOrHard, opts);
}

/**
 * Pack already-protected bits (272) into 46 call symbols (+4 zero pad).
 */
export function protectedBitsToCallDataSymbols(protectedBits) {
  if (protectedBits.length !== TOTAL_BITS) {
    throw new Error(`Expected ${TOTAL_BITS} protected bits, got ${protectedBits.length}`);
  }
  const callBits = new Uint8Array(CALL_TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) callBits[i] = protectedBits[i] & 1;
  const callDataSymbols = new Uint8Array(CALL_DATA_SYMBOLS);
  for (let s = 0; s < CALL_DATA_SYMBOLS; s++) {
    let sym = 0;
    for (let b = 0; b < CALL_CHANNEL_COUNT; b++) {
      sym = (sym << 1) | (callBits[s * CALL_CHANNEL_COUNT + b] & 1);
    }
    callDataSymbols[s] = sym;
  }
  return { callBits, callDataSymbols };
}

/**
 * Unpack 46 call symbols → 272 protected bits (last 4 pad bits discarded).
 */
export function callDataSymbolsToProtectedBits(symbolBytes) {
  if (symbolBytes.length !== CALL_DATA_SYMBOLS) {
    throw new Error(`Expected ${CALL_DATA_SYMBOLS} call symbols, got ${symbolBytes.length}`);
  }
  const bits = new Uint8Array(TOTAL_BITS);
  let bitPos = 0;
  for (let s = 0; s < CALL_DATA_SYMBOLS; s++) {
    const sym = symbolBytes[s] & 0x3f;
    for (let b = 0; b < CALL_CHANNEL_COUNT; b++) {
      const bit = (sym >> (CALL_CHANNEL_COUNT - 1 - b)) & 1;
      if (bitPos < TOTAL_BITS) bits[bitPos] = bit;
      bitPos++;
    }
  }
  return bits;
}

export const CALL_CONSTANTS = Object.freeze({
  CALL_PROTOCOL_ID,
  CALL_BASE_CHANNELS,
  CALL_ENHANCEMENT_CHANNELS,
  ENHANCEMENT_DIFFERENTIAL_DB,
  BASE_TOTAL_DIFFERENTIAL_DB,
  BASE_DELTA_DB_OPTIONS,
  CALL_CHIP_CODE,
  CHIPS_PER_SYMBOL,
  CHIP_MS,
  SYMBOL_MS,
  CROSSFADE_MS,
  FEATURE_MS,
  FEATURES_PER_CHIP,
  FEATURES_PER_SYMBOL,
  CALL_PREAMBLE_SYMBOLS,
  CALL_PREAMBLE,
  CALL_FRAME_SYMBOLS,
  CALL_FRAME_MS,
  FRAME_DURATION_MS,
  CALL_PREAMBLE_CORRELATION_MIN,
  CALL_TRACK_WINDOW_MS,
  CALL_MISSED_FRAMES_TO_SEARCH,
  CALL_DUPLICATE_SUPPRESS_MS,
  CALL_FEATURE_BUFFER_SECONDS,
  EPSILON_ENERGY,
  CALL_BAND_COUNT,
  CALL_ENH_BAND_COUNT,
  CALL_TOTAL_BANDS,
  CALL_CHANNEL_COUNT,
  CALL_DATA_SYMBOLS,
  CALL_EXTRA_PAD_BITS,
  CALL_TOTAL_BITS,
  TOTAL_BITS,
  CALL_FADE_IN_MS,
  CALL_FADE_OUT_MS,
  CALL_CARRIER_LEVEL,
  CALL_AMBIENT_MIX,
});
