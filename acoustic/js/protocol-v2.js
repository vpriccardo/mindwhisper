/**
 * Shared protocol-v2: variable-length payload + CRC16 + shortened Reed-Solomon FEC.
 *
 * Replaces the v1 fixed-20-char-allocation + Hamming(7,4) framing with a
 * compact variable-length frame. Shared by room-v2 (acoustic/js/room-v2/) and
 * call-v2 (acoustic/js/call/call-v2-*.js) — only the acoustic transport
 * differs between the two.
 *
 * Frame layout (see README/spec):
 *   header byte  = (PROTOCOL_V2 << 5) | (messageLength - 1)
 *   packed message = messageLength * 6 bits, MSB-first, padded with 0 bits
 *   CRC16/CCITT-FALSE over (header || packed message)
 *   RS data = header || packed message || CRC-hi || CRC-lo
 *   RS parity = getParityBytes(messageLength) bytes
 *   RS codeword = RS data || RS parity  (systematic)
 *   Transmitted stream = header ×3 (unwhitened) followed by whitened RS codeword bits
 *
 * v1 alphabet, CRC-16/CCITT-FALSE, and xorshift32 PRNG are reused from
 * protocol.js / crc16.js — not duplicated here.
 */

import {
  ALPHABET,
  CHAR_BITS,
  MIN_MESSAGE_LEN,
  MAX_MESSAGE_LEN,
  isValidMessage,
  charToSymbol,
  symbolToChar,
  createXorshift32,
} from './protocol.js';
import { crc16CcittFalse, crc16ToBytes, bytesToCrc16 } from './crc16.js';
import { rsEncode, rsDecode } from './rs-codec.js';

export { ALPHABET, CHAR_BITS, MIN_MESSAGE_LEN, MAX_MESSAGE_LEN, isValidMessage };

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export const PROTOCOL_V2 = 0b010;
/** Codeword-bit whitening seed (balances modulation; NOT encryption). */
export const WHITEN_SEED_V2 = 0xa17c9e2d;
/** Header is transmitted this many times (majority-voted at RX) before the codeword. */
export const HEADER_REPEAT_COUNT = 3;

export function buildHeaderV2(messageLength) {
  if (messageLength < MIN_MESSAGE_LEN || messageLength > MAX_MESSAGE_LEN) {
    throw new Error(`Invalid message length ${messageLength}`);
  }
  return ((PROTOCOL_V2 & 0x07) << 5) | ((messageLength - 1) & 0x1f);
}

/**
 * Parse + validate a candidate header byte.
 * Rejects unless version === PROTOCOL_V2 and 1 <= length <= 20.
 */
export function parseHeaderV2(byte) {
  const b = byte & 0xff;
  const version = (b >> 5) & 0x07;
  const length = (b & 0x1f) + 1;
  if (version !== PROTOCOL_V2) {
    return { ok: false, error: `Invalid protocol version 0b${version.toString(2)}`, version, length };
  }
  if (length < MIN_MESSAGE_LEN || length > MAX_MESSAGE_LEN) {
    return { ok: false, error: `Invalid message length ${length}`, version, length };
  }
  return { ok: true, version, length };
}

/** Majority-vote a header byte from N (typically 3) received candidate bytes, bit by bit. */
export function majorityVoteHeaderByte(candidates) {
  let byte = 0;
  const agreement = new Array(8).fill(0);
  for (let bit = 7; bit >= 0; bit--) {
    let ones = 0;
    for (const c of candidates) {
      if ((c >> bit) & 1) ones++;
    }
    const half = candidates.length / 2;
    const bitVal = ones > half ? 1 : ones === half ? (candidates[0] >> bit) & 1 : 0;
    agreement[7 - bit] = Math.max(ones, candidates.length - ones) / candidates.length;
    byte |= bitVal << bit;
  }
  const minAgreement = Math.min(...agreement);
  return { byte, agreement, minAgreement };
}

// ---------------------------------------------------------------------------
// Variable-length FEC strength (§9)
// ---------------------------------------------------------------------------

export function getParityBytes(messageLength) {
  if (messageLength <= 8) return 6;
  if (messageLength <= 14) return 8;
  return 10;
}

// ---------------------------------------------------------------------------
// Compact message packing (variable length, MSB-first, zero-padded tail)
// ---------------------------------------------------------------------------

export function packedMessageByteLength(messageLength) {
  return Math.ceil((messageLength * CHAR_BITS) / 8);
}

/** Pack up to MAX_MESSAGE_LEN 6-bit symbols into ceil(N*6/8) bytes, MSB-first. Unused tail bits are 0. */
export function packMessageV2(message) {
  const n = message.length;
  const byteLen = packedMessageByteLength(n);
  const out = new Uint8Array(byteLen);
  let bitPos = 0;
  for (let i = 0; i < n; i++) {
    const sym = charToSymbol(message[i]) & 0x3f;
    for (let b = CHAR_BITS - 1; b >= 0; b--) {
      const bit = (sym >> b) & 1;
      const byteIndex = (bitPos / 8) | 0;
      const bitIndex = 7 - (bitPos % 8);
      out[byteIndex] |= bit << bitIndex;
      bitPos++;
    }
  }
  return out;
}

export function unpackMessageV2(packed, messageLength) {
  if (messageLength < MIN_MESSAGE_LEN || messageLength > MAX_MESSAGE_LEN) {
    throw new Error(`Invalid message length: ${messageLength}`);
  }
  const expectedBytes = packedMessageByteLength(messageLength);
  if (packed.length < expectedBytes) {
    throw new Error(`Packed message too short: ${packed.length} < ${expectedBytes}`);
  }
  const chars = [];
  let bitPos = 0;
  for (let i = 0; i < messageLength; i++) {
    let sym = 0;
    for (let b = 0; b < CHAR_BITS; b++) {
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

// ---------------------------------------------------------------------------
// Frame layout
// ---------------------------------------------------------------------------

/**
 * Compute the exact byte-accurate frame layout for a given message length,
 * without needing the message itself. Lets RX plan exact remaining symbol
 * counts as soon as a valid header is known (§20).
 */
export function computeFrameLayoutV2(messageLength) {
  const check =
    messageLength >= MIN_MESSAGE_LEN && messageLength <= MAX_MESSAGE_LEN;
  if (!check) throw new Error(`Invalid message length ${messageLength}`);
  const packedMessageBytes = packedMessageByteLength(messageLength);
  const dataBytes = 1 + packedMessageBytes + 2; // header + message + CRC16
  const parityBytes = getParityBytes(messageLength);
  const codewordBytes = dataBytes + parityBytes;
  return {
    messageLength,
    packedMessageBytes,
    dataBytes,
    parityBytes,
    codewordBytes,
    codewordBits: codewordBytes * 8,
  };
}

// ---------------------------------------------------------------------------
// Bit <-> byte helpers (MSB-first) + whitening
// ---------------------------------------------------------------------------

/** Bytes -> bit array, MSB-first, byte 0 bit 7 first. */
export function bytesToBitsMsb(bytes, bitCount = bytes.length * 8) {
  const out = new Uint8Array(bitCount);
  for (let i = 0; i < bitCount; i++) {
    const byteIndex = i >> 3;
    const bitIndex = 7 - (i & 7);
    out[i] = (bytes[byteIndex] >> bitIndex) & 1;
  }
  return out;
}

/** Bit array (MSB-first) -> bytes; trailing partial byte is zero-padded. */
export function bitsToBytesMsb(bits) {
  const byteLen = Math.ceil(bits.length / 8);
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      const byteIndex = i >> 3;
      const bitIndex = 7 - (i & 7);
      out[byteIndex] |= 1 << bitIndex;
    }
  }
  return out;
}

/** Deterministic xorshift32 whitening stream, self-inverse (XOR). */
export function whitenBits(bits, seed = WHITEN_SEED_V2) {
  const rng = createXorshift32(seed);
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) {
    out[i] = (bits[i] & 1) ^ rng.nextBit();
  }
  return out;
}

export const dewhitenBits = whitenBits; // XOR is self-inverse

/**
 * Soft-bit-aware whitening inverse: negate soft polarity where the
 * whitening stream flipped the bit. Used by RX before assembling RS bytes.
 */
export function dewhitenSoftBits(softBits, seed = WHITEN_SEED_V2) {
  const rng = createXorshift32(seed);
  const out = new Float32Array(softBits.length);
  for (let i = 0; i < softBits.length; i++) {
    const flip = rng.nextBit();
    out[i] = flip ? -softBits[i] : softBits[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full TX-side frame build
// ---------------------------------------------------------------------------

/**
 * Build the complete protocol-v2 transmit frame for a message.
 * Returns everything both room-v2 and call-v2 acoustic layers need.
 */
export function buildFrameV2(message) {
  const check = isValidMessage(message);
  if (!check.ok) throw new Error(check.error);

  const messageLength = message.length;
  const layout = computeFrameLayoutV2(messageLength);
  const header = buildHeaderV2(messageLength);
  const packedMessage = packMessageV2(message);

  const rsDataNoCrc = new Uint8Array(1 + layout.packedMessageBytes);
  rsDataNoCrc[0] = header;
  rsDataNoCrc.set(packedMessage, 1);
  const crc = crc16CcittFalse(rsDataNoCrc);
  const [crcHi, crcLo] = crc16ToBytes(crc);

  const rsData = new Uint8Array(layout.dataBytes);
  rsData.set(rsDataNoCrc, 0);
  rsData[rsData.length - 2] = crcHi;
  rsData[rsData.length - 1] = crcLo;

  const codeword = rsEncode(rsData, layout.parityBytes);
  const codewordBits = bytesToBitsMsb(codeword);
  const whitenedBits = whitenBits(codewordBits);

  const headerRepeats = new Uint8Array(HEADER_REPEAT_COUNT).fill(header);

  return {
    message,
    messageLength,
    layout,
    header,
    headerRepeats,
    packedMessage,
    crc,
    rsData,
    codeword,
    codewordBits,
    whitenedBits,
    whitenedBytes:
      whitenedBits.length % 8 === 0 ? bitsToBytesMsb(whitenedBits) : null,
  };
}

// ---------------------------------------------------------------------------
// Full RX-side decode
// ---------------------------------------------------------------------------

/**
 * Decode from majority-voted header candidates + whitened codeword bits
 * (hard 0/1 array). Optional erasureBytePositions marks RS codeword byte
 * indices RX considers unreliable.
 */
export function decodeFrameV2(headerCandidates, whitenedCodewordBits, opts = {}) {
  const erasureBytePositions = opts.erasureBytePositions || [];
  const { byte: majorityHeader, minAgreement } = majorityVoteHeaderByte(headerCandidates);
  const headerCheck = parseHeaderV2(majorityHeader);
  if (!headerCheck.ok) {
    return { ok: false, error: `header: ${headerCheck.error}`, stage: 'header', minAgreement };
  }

  const layout = computeFrameLayoutV2(headerCheck.length);
  if (whitenedCodewordBits.length < layout.codewordBits) {
    return {
      ok: false,
      error: `Not enough codeword bits: ${whitenedCodewordBits.length} < ${layout.codewordBits}`,
      stage: 'length',
      layout,
    };
  }

  const codewordBits = dewhitenBits(
    whitenedCodewordBits.subarray
      ? whitenedCodewordBits.subarray(0, layout.codewordBits)
      : whitenedCodewordBits.slice(0, layout.codewordBits)
  );
  const codewordBytes = bitsToBytesMsb(codewordBits);

  const rs = rsDecode(codewordBytes, layout.parityBytes, erasureBytePositions);
  if (!rs.ok) {
    return { ok: false, error: `RS: ${rs.error}`, stage: 'rs', layout, minAgreement, rs };
  }

  const internalHeader = rs.data[0];
  if (internalHeader !== majorityHeader) {
    return {
      ok: false,
      error: `Internal header 0x${internalHeader.toString(16)} != majority 0x${majorityHeader.toString(16)}`,
      stage: 'header-mismatch',
      layout,
      minAgreement,
      rs,
    };
  }

  const packedMessage = rs.data.subarray(1, 1 + layout.packedMessageBytes);
  const crcRecv = bytesToCrc16(
    rs.data[rs.data.length - 2],
    rs.data[rs.data.length - 1]
  );
  const crcCalc = crc16CcittFalse(rs.data.subarray(0, rs.data.length - 2));
  if (crcRecv !== crcCalc) {
    return {
      ok: false,
      error: 'CRC mismatch',
      stage: 'crc',
      layout,
      minAgreement,
      rs,
      crcRecv,
      crcCalc,
    };
  }

  try {
    const message = unpackMessageV2(packedMessage, headerCheck.length);
    return {
      ok: true,
      message,
      messageLength: headerCheck.length,
      layout,
      header: majorityHeader,
      minAgreement,
      rsErrorCount: rs.errorCount,
      rsErasureCount: rs.erasureCount,
      rsCorrectedPositions: rs.correctedPositions,
      crc: crcCalc,
    };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      stage: 'unpack',
      layout,
      minAgreement,
      rs,
    };
  }
}

export const PROTOCOL_V2_CONSTANTS = Object.freeze({
  PROTOCOL_V2,
  WHITEN_SEED_V2,
  HEADER_REPEAT_COUNT,
});
