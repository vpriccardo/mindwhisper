/**
 * Shared acoustic watermark protocol constants and encode/decode.
 * TX and RX MUST import from this module — do not duplicate constants.
 */

import { crc16CcittFalse, crc16ToBytes, bytesToCrc16 } from './crc16.js';
import {
  hammingEncodeBytes,
  hammingDecodeBits,
  hammingEncodeNibble,
  hammingDecodeCodeword,
} from './hamming.js';

// ---------------------------------------------------------------------------
// Alphabet & payload
// ---------------------------------------------------------------------------

export const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -';

export const CHAR_BITS = 6;
export const MAX_MESSAGE_LEN = 20;
export const MIN_MESSAGE_LEN = 1;
export const PACKED_MESSAGE_BYTES = 15; // 20 * 6 / 8
export const RAW_FRAME_BYTES = 19; // version + length + 15 packed + 2 CRC
export const PROTOCOL_VERSION = 0x01;

// ---------------------------------------------------------------------------
// Timing / frame structure
// ---------------------------------------------------------------------------

export const SYMBOL_MS = 120;
export const FEATURE_MS = 20;
export const FEATURES_PER_SYMBOL = SYMBOL_MS / FEATURE_MS; // 6
export const PREAMBLE_SYMBOLS = 8;
export const DATA_SYMBOLS = 34; // 272 / 8
export const FRAME_SYMBOLS = PREAMBLE_SYMBOLS + DATA_SYMBOLS; // 42
export const FRAME_MS = FRAME_SYMBOLS * SYMBOL_MS; // 5040
export const FRAME_REPETITIONS = 3;
export const FADE_IN_MS = 600;
export const FADE_OUT_MS = 600;
export const TOTAL_TX_MS =
  FADE_IN_MS + FRAME_REPETITIONS * FRAME_MS + FADE_OUT_MS; // ~16320

export const CROSSFADE_MS = 12;
export const WATERMARK_DELTA_DB_DEFAULT = 3.5;
export const WATERMARK_DELTA_DB_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0];

export const CHANNEL_COUNT = 8;
export const CODED_BITS = 266; // 38 nibbles * 7
export const PAD_BITS = 6;
export const TOTAL_BITS = CODED_BITS + PAD_BITS; // 272
export const INTERLEAVE_A = 73; // p(i) = (73 * i) mod 272
export const SCRAMBLER_SEED = 0xc0ffee42;
export const AMBIENT_SEED_DEFAULT = 0xa11ce55;
export const WATERMARK_NOISE_SEED_DEFAULT = 0x7a7e7a7e;

/** Hardcoded 8-symbol preamble bytes. bit7 → channel 0 … bit0 → channel 7 */
export const PREAMBLE_BYTES = new Uint8Array([
  0xd3, 0x5c, 0xa6, 0x79, 0x3a, 0xc5, 0x96, 0x69,
]);

/**
 * Eight differential spectral watermark channels: [lowHz, highHz]
 */
export const WATERMARK_CHANNELS = [
  [5200, 5480],
  [5800, 6080],
  [6400, 6680],
  [7000, 7280],
  [7600, 7880],
  [8200, 8480],
  [8800, 9080],
  [9400, 9680],
];

/** Approximate band width used for Q ≈ centre / BANDWIDTH_HZ */
/** Approx -3 dB bandwidth for watermark band-pass / notch design. */
export const BANDWIDTH_HZ = 140;

export const PREAMBLE_CORRELATION_MIN = 0.35;
export const DUPLICATE_SUPPRESS_MS = 10000;
export const FEATURE_BUFFER_SECONDS = 30;
export const EPSILON_ENERGY = 1e-20;

export const CONSTANTS = Object.freeze({
  ALPHABET,
  CHAR_BITS,
  MAX_MESSAGE_LEN,
  MIN_MESSAGE_LEN,
  PACKED_MESSAGE_BYTES,
  RAW_FRAME_BYTES,
  PROTOCOL_VERSION,
  SYMBOL_MS,
  FEATURE_MS,
  FEATURES_PER_SYMBOL,
  PREAMBLE_SYMBOLS,
  DATA_SYMBOLS,
  FRAME_SYMBOLS,
  FRAME_MS,
  FRAME_REPETITIONS,
  FADE_IN_MS,
  FADE_OUT_MS,
  TOTAL_TX_MS,
  CROSSFADE_MS,
  WATERMARK_DELTA_DB_DEFAULT,
  WATERMARK_DELTA_DB_OPTIONS,
  CHANNEL_COUNT,
  CODED_BITS,
  PAD_BITS,
  TOTAL_BITS,
  INTERLEAVE_A,
  SCRAMBLER_SEED,
  AMBIENT_SEED_DEFAULT,
  WATERMARK_NOISE_SEED_DEFAULT,
  PREAMBLE_BYTES,
  WATERMARK_CHANNELS,
  BANDWIDTH_HZ,
  PREAMBLE_CORRELATION_MIN,
  DUPLICATE_SUPPRESS_MS,
  FEATURE_BUFFER_SECONDS,
  EPSILON_ENERGY,
});

// ---------------------------------------------------------------------------
// PRNG — shared xorshift32
// ---------------------------------------------------------------------------

export function createXorshift32(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x1;
  return {
    nextUint32() {
      let x = state >>> 0;
      x ^= (x << 13) >>> 0;
      x ^= x >>> 17;
      x ^= (x << 5) >>> 0;
      state = x >>> 0;
      return state;
    },
    nextBit() {
      return this.nextUint32() & 1;
    },
    nextFloat() {
      return (this.nextUint32() >>> 0) / 0x100000000;
    },
    /** Gaussian via Box-Muller */
    nextGaussian() {
      const u1 = Math.max(this.nextFloat(), 1e-12);
      const u2 = this.nextFloat();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
    getState() {
      return state;
    },
    setState(s) {
      state = s >>> 0 || 0x1;
    },
  };
}

// ---------------------------------------------------------------------------
// Character validation / packing
// ---------------------------------------------------------------------------

const CHAR_TO_SYMBOL = new Map();
for (let i = 0; i < ALPHABET.length; i++) {
  CHAR_TO_SYMBOL.set(ALPHABET[i], i);
}

export function isValidMessage(message) {
  if (typeof message !== 'string') {
    return { ok: false, error: 'Message must be a string' };
  }
  if (message.length < MIN_MESSAGE_LEN || message.length > MAX_MESSAGE_LEN) {
    return {
      ok: false,
      error: `Message length must be ${MIN_MESSAGE_LEN}–${MAX_MESSAGE_LEN} characters`,
    };
  }
  for (let i = 0; i < message.length; i++) {
    if (!CHAR_TO_SYMBOL.has(message[i])) {
      return {
        ok: false,
        error: `Unsupported character "${message[i]}" at position ${i + 1}`,
      };
    }
  }
  return { ok: true };
}

export function charToSymbol(ch) {
  const s = CHAR_TO_SYMBOL.get(ch);
  if (s === undefined) throw new Error(`Unsupported character: ${ch}`);
  return s;
}

export function symbolToChar(sym) {
  if (sym < 0 || sym >= ALPHABET.length) {
    throw new Error(`Invalid symbol: ${sym}`);
  }
  return ALPHABET[sym];
}

/**
 * Pack up to 20 6-bit symbols into 15 bytes (MSB-first within the bit stream).
 */
export function packMessage(message) {
  const symbols = new Array(MAX_MESSAGE_LEN).fill(0);
  for (let i = 0; i < message.length; i++) {
    symbols[i] = charToSymbol(message[i]);
  }
  const out = new Uint8Array(PACKED_MESSAGE_BYTES);
  let bitPos = 0;
  for (let i = 0; i < MAX_MESSAGE_LEN; i++) {
    const sym = symbols[i] & 0x3f;
    for (let b = 5; b >= 0; b--) {
      const bit = (sym >> b) & 1;
      const byteIndex = (bitPos / 8) | 0;
      const bitIndex = 7 - (bitPos % 8);
      out[byteIndex] |= bit << bitIndex;
      bitPos++;
    }
  }
  return out;
}

export function unpackMessage(packed, length) {
  if (length < MIN_MESSAGE_LEN || length > MAX_MESSAGE_LEN) {
    throw new Error(`Invalid message length: ${length}`);
  }
  const chars = [];
  let bitPos = 0;
  for (let i = 0; i < length; i++) {
    let sym = 0;
    for (let b = 0; b < 6; b++) {
      const byteIndex = (bitPos / 8) | 0;
      const bitIndex = 7 - (bitPos % 8);
      const bit = (packed[byteIndex] >> bitIndex) & 1;
      sym = (sym << 1) | bit;
      bitPos++;
    }
    if (sym >= ALPHABET.length) {
      throw new Error(`Invalid symbol value: ${sym}`);
    }
    chars.push(symbolToChar(sym));
  }
  return chars.join('');
}

/**
 * Build the 19-byte raw frame: version | length | packed[15] | CRC hi | CRC lo
 */
export function buildRawFrame(message) {
  const check = isValidMessage(message);
  if (!check.ok) throw new Error(check.error);

  const packed = packMessage(message);
  const frame = new Uint8Array(RAW_FRAME_BYTES);
  frame[0] = PROTOCOL_VERSION;
  frame[1] = message.length;
  frame.set(packed, 2);
  const crc = crc16CcittFalse(frame.subarray(0, 17));
  const [hi, lo] = crc16ToBytes(crc);
  frame[17] = hi;
  frame[18] = lo;
  return { frame, crc };
}

// ---------------------------------------------------------------------------
// Interleaving
// ---------------------------------------------------------------------------

export function interleaveIndex(i) {
  return (INTERLEAVE_A * i) % TOTAL_BITS;
}

export function interleave(bits) {
  if (bits.length !== TOTAL_BITS) {
    throw new Error(`Expected ${TOTAL_BITS} bits, got ${bits.length}`);
  }
  const out = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) {
    out[interleaveIndex(i)] = bits[i] & 1;
  }
  return out;
}

export function inverseInterleave(bits) {
  if (bits.length !== TOTAL_BITS) {
    throw new Error(`Expected ${TOTAL_BITS} bits, got ${bits.length}`);
  }
  const out = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) {
    out[i] = bits[interleaveIndex(i)] & 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scrambling (whitening)
// ---------------------------------------------------------------------------

export function scrambleBits(bits, seed = SCRAMBLER_SEED) {
  const rng = createXorshift32(seed);
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) {
    out[i] = (bits[i] & 1) ^ rng.nextBit();
  }
  return out;
}

export function descrambleBits(bits, seed = SCRAMBLER_SEED) {
  // XOR is self-inverse
  return scrambleBits(bits, seed);
}

// ---------------------------------------------------------------------------
// Full encode / decode pipeline
// ---------------------------------------------------------------------------

/**
 * Encode message → 272 scrambled bits + 34 data symbol bytes (8 bits each).
 */
export function encodeMessage(message) {
  const { frame, crc } = buildRawFrame(message);
  const hammingBits = hammingEncodeBytes(frame); // 266 bits
  if (hammingBits.length !== CODED_BITS) {
    throw new Error(`Unexpected Hamming length ${hammingBits.length}`);
  }
  const padded = new Uint8Array(TOTAL_BITS);
  padded.set(hammingBits, 0);
  // last 6 bits remain 0
  const interleaved = interleave(padded);
  const scrambled = scrambleBits(interleaved);

  const dataSymbols = new Uint8Array(DATA_SYMBOLS);
  for (let s = 0; s < DATA_SYMBOLS; s++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | (scrambled[s * 8 + b] & 1);
    }
    dataSymbols[s] = byte;
  }

  return {
    message,
    rawFrame: frame,
    crc,
    hammingBits,
    interleaved,
    scrambled,
    dataSymbols,
    preambleBytes: PREAMBLE_BYTES,
  };
}

/**
 * Convert preamble + data symbol bytes into a flat list of per-symbol channel bit arrays.
 * Each symbol: Uint8Array[8] with bit for channels 0..7 (bit7 of byte → ch0).
 */
export function symbolsFromBytes(bytes) {
  const symbols = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    const bits = new Uint8Array(CHANNEL_COUNT);
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      bits[ch] = (byte >> (7 - ch)) & 1;
    }
    symbols.push(bits);
  }
  return symbols;
}

export function buildTransmitSymbols(message) {
  const encoded = encodeMessage(message);
  const preambleSymbols = symbolsFromBytes(PREAMBLE_BYTES);
  const dataSymbols = symbolsFromBytes(encoded.dataSymbols);
  const frame = preambleSymbols.concat(dataSymbols);
  const all = [];
  for (let r = 0; r < FRAME_REPETITIONS; r++) {
    for (const sym of frame) {
      all.push(sym);
    }
  }
  return { ...encoded, frameSymbols: frame, allSymbols: all };
}

/**
 * Soft or hard bits (272) → message, or rejection.
 * @param {Float32Array|Uint8Array|number[]} softOrHard — positive => 1, negative/0 => 0 for soft
 * @param {{ soft?: boolean }} opts
 */
export function decodeFromBits(softOrHard, opts = {}) {
  const soft = opts.soft === true;
  const hard = new Uint8Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) {
    const v = softOrHard[i];
    if (soft) {
      hard[i] = v > 0 ? 1 : 0;
    } else {
      hard[i] = v & 1;
    }
  }

  const descrambled = descrambleBits(hard);
  const deinterleaved = inverseInterleave(descrambled);
  const coded = deinterleaved.subarray(0, CODED_BITS);
  const { bytes, correctionCount } = hammingDecodeBits(coded);

  if (bytes.length !== RAW_FRAME_BYTES) {
    return { ok: false, error: 'Wrong frame byte length', correctionCount };
  }

  const version = bytes[0];
  const length = bytes[1];
  const packed = bytes.subarray(2, 17);
  const crcRecv = bytesToCrc16(bytes[17], bytes[18]);
  const crcCalc = crc16CcittFalse(bytes.subarray(0, 17));

  if (version !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `Invalid protocol version 0x${version.toString(16)}`,
      correctionCount,
      crcValid: false,
    };
  }
  if (crcRecv !== crcCalc) {
    return {
      ok: false,
      error: 'CRC mismatch',
      correctionCount,
      crcValid: false,
      crcRecv,
      crcCalc,
    };
  }
  if (length < MIN_MESSAGE_LEN || length > MAX_MESSAGE_LEN) {
    return {
      ok: false,
      error: `Invalid message length ${length}`,
      correctionCount,
      crcValid: true,
    };
  }

  try {
    const message = unpackMessage(packed, length);
    // Verify all used symbols are valid (unpackMessage already checks)
    return {
      ok: true,
      message,
      correctionCount,
      crcValid: true,
      crc: crcCalc,
      version,
      length,
      rawFrame: bytes,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      correctionCount,
      crcValid: true,
    };
  }
}

/**
 * Decode from 34 data symbol bytes (after preamble stripped).
 */
export function decodeFromDataSymbols(symbolBytes) {
  if (symbolBytes.length !== DATA_SYMBOLS) {
    return { ok: false, error: `Expected ${DATA_SYMBOLS} symbols` };
  }
  const bits = new Uint8Array(TOTAL_BITS);
  for (let s = 0; s < DATA_SYMBOLS; s++) {
    const byte = symbolBytes[s];
    for (let b = 0; b < 8; b++) {
      bits[s * 8 + b] = (byte >> (7 - b)) & 1;
    }
  }
  return decodeFromBits(bits, { soft: false });
}

/**
 * Combine multiple soft-bit frames (each length 272) with optional weights.
 */
export function combineSoftFrames(softFrames, weights) {
  const combined = new Float32Array(TOTAL_BITS);
  const w = weights || softFrames.map(() => 1);
  let wSum = 0;
  for (let f = 0; f < softFrames.length; f++) {
    const wf = w[f];
    wSum += wf;
    const frame = softFrames[f];
    for (let i = 0; i < TOTAL_BITS; i++) {
      combined[i] += frame[i] * wf;
    }
  }
  if (wSum > 0) {
    for (let i = 0; i < TOTAL_BITS; i++) {
      combined[i] /= wSum;
    }
  }
  return decodeFromBits(combined, { soft: true });
}

/**
 * Soft bits arrive scrambled (same order as TX scrambled stream).
 * This descrambles + deinterleaves soft values for combining/Hamming.
 */
export function softDescrambleDeinterleave(softScrambled) {
  const rng = createXorshift32(SCRAMBLER_SEED);
  const softInterleaved = new Float32Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) {
    const flip = rng.nextBit();
    // If scrambled bit was flipped, negate soft polarity
    softInterleaved[i] = flip ? -softScrambled[i] : softScrambled[i];
  }
  const softOriginal = new Float32Array(TOTAL_BITS);
  for (let i = 0; i < TOTAL_BITS; i++) {
    softOriginal[i] = softInterleaved[interleaveIndex(i)];
  }
  return softOriginal;
}

export function decodeSoftScrambled(softScrambled) {
  const softOriginal = softDescrambleDeinterleave(softScrambled);
  // Pad bits are ignored; take coded portion as soft, convert via hard after mean
  // Re-use decodeFromBits on hard decisions of softOriginal order... but
  // decodeFromBits expects scrambled-order hard bits. Simpler path:
  return decodeFromBits(softScrambled, { soft: true });
}

// Re-export Hamming helpers for tests
export { hammingEncodeNibble, hammingDecodeCodeword, crc16CcittFalse };
