/**
 * call-v2 framing: maps the shared protocol-v2 frame onto 6-bit acoustic
 * symbols for the call transport (6 parallel spectral channels/symbol).
 * Pure framing — no DSP (see call-v2-dsp.js / call-v2-tx.js).
 */

import { buildFrameV2, decodeFrameV2, computeFrameLayoutV2 } from '../protocol-v2.js';
import {
  CALL_V2_PREAMBLE,
  CALL_V2_CHANNEL_COUNT,
  CALL_V2_HEADER_SYMBOLS,
} from './call-v2-constants.js';

/** Serialize a byte array into 6-bit symbol values, MSB-first, zero-padding the final symbol. */
export function bytesToSixBitSymbols(bytes) {
  const totalBits = bytes.length * 8;
  const symbolCount = Math.ceil(totalBits / CALL_V2_CHANNEL_COUNT);
  const symbols = new Array(symbolCount).fill(0);
  for (let i = 0; i < totalBits; i++) {
    const byteIndex = i >> 3;
    const bitIndex = 7 - (i & 7);
    const bit = (bytes[byteIndex] >> bitIndex) & 1;
    const symIndex = Math.floor(i / CALL_V2_CHANNEL_COUNT);
    const symBit = CALL_V2_CHANNEL_COUNT - 1 - (i % CALL_V2_CHANNEL_COUNT);
    symbols[symIndex] |= bit << symBit;
  }
  return symbols;
}

/** Inverse of bytesToSixBitSymbols — reconstruct up to `bitCount` real bits into bytes. */
export function sixBitSymbolsToBits(symbols, bitCount) {
  const bits = new Uint8Array(bitCount);
  for (let i = 0; i < bitCount; i++) {
    const symIndex = Math.floor(i / CALL_V2_CHANNEL_COUNT);
    const symBit = CALL_V2_CHANNEL_COUNT - 1 - (i % CALL_V2_CHANNEL_COUNT);
    bits[i] = (symbols[symIndex] >> symBit) & 1;
  }
  return bits;
}

export function sixBitValueToBits(value) {
  const bits = new Uint8Array(CALL_V2_CHANNEL_COUNT);
  for (let ch = 0; ch < CALL_V2_CHANNEL_COUNT; ch++) {
    bits[ch] = (value >> (CALL_V2_CHANNEL_COUNT - 1 - ch)) & 1;
  }
  return bits;
}

/**
 * Build the full call-v2 transmit frame: 8 preamble symbols + 4 header
 * symbols (3x repeated header, 24 bits, unwhitened) + ceil(codewordBits/6)
 * whitened RS-codeword payload symbols (zero-padded final symbol).
 */
export function buildCallV2TransmitSymbols(message) {
  const built = buildFrameV2(message);

  // 3 header-byte repeats serialized MSB-first → 24 bits → 4 six-bit symbols.
  const headerBytes = built.headerRepeats; // Uint8Array(3), each = built.header
  const headerSymbols = bytesToSixBitSymbols(headerBytes);
  if (headerSymbols.length !== CALL_V2_HEADER_SYMBOLS) {
    throw new Error(
      `Expected ${CALL_V2_HEADER_SYMBOLS} header symbols, got ${headerSymbols.length}`
    );
  }

  const payloadSymbols = bitsToSixBitSymbolsFromBitArray(built.whitenedBits);

  const frameSymbols = [...CALL_V2_PREAMBLE, ...headerSymbols, ...payloadSymbols];
  return {
    ...built,
    headerSymbols,
    payloadSymbols,
    frameSymbols,
    frameSymbolCount: frameSymbols.length,
  };
}

function bitsToSixBitSymbolsFromBitArray(bits) {
  const symbolCount = Math.ceil(bits.length / CALL_V2_CHANNEL_COUNT);
  const symbols = new Array(symbolCount).fill(0);
  for (let i = 0; i < bits.length; i++) {
    const symIndex = Math.floor(i / CALL_V2_CHANNEL_COUNT);
    const symBit = CALL_V2_CHANNEL_COUNT - 1 - (i % CALL_V2_CHANNEL_COUNT);
    symbols[symIndex] |= (bits[i] & 1) << symBit;
  }
  return symbols;
}

/** Total acoustic symbol count for a given message length (preamble+header+payload). */
export function callV2FrameSymbolCount(messageLength) {
  const layout = computeFrameLayoutV2(messageLength);
  const payloadSymbols = Math.ceil(layout.codewordBits / CALL_V2_CHANNEL_COUNT);
  return CALL_V2_PREAMBLE.length + CALL_V2_HEADER_SYMBOLS + payloadSymbols;
}

export {
  CALL_V2_PREAMBLE,
  CALL_V2_HEADER_SYMBOLS,
  CALL_V2_CHANNEL_COUNT,
  decodeFrameV2,
  computeFrameLayoutV2,
};
