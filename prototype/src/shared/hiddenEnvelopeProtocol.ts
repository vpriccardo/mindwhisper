/**
 * Hidden envelope optical protocol HENV1.
 *
 * This compact token is a dictionary fingerprint, not encryption and not a
 * general-purpose secret. One salt byte yields 256 visual variants; six digest
 * bytes give a 48-bit comparison for a known salt.
 */

import { ensureWebCrypto, normalizeWord } from "../spectator/protocol";

export const HENV_PROTOCOL_ID = "HENV1" as const;
export const HENV_SALT_BYTES = 1;
export const HENV_DIGEST_BYTES = 6;
export const HENV_TOKEN_BYTES = 7;
export const HENV_BIT_COUNT = 56;

export type HiddenToken = {
  protocolId: typeof HENV_PROTOCOL_ID;
  salt8: number;
  digest6: Uint8Array;
  token: Uint8Array;
  normalizedWord: string;
};

/** Re-export so Hidden envelope callers share one normalization implementation. */
export { normalizeWord };

function assertNormalized(normalized: string): void {
  if (!normalized) {
    throw new Error("Normalized word is empty.");
  }
}

/** SHA-256(byte(salt8) || UTF8(normalizedWord)), first 6 bytes. */
export async function hiddenDigest6(
  normalized: string,
  salt8: number,
): Promise<Uint8Array> {
  assertNormalized(normalized);
  if (!Number.isInteger(salt8) || salt8 < 0 || salt8 > 255) {
    throw new Error("salt8 must be an integer in 0..255.");
  }
  const subtle = ensureWebCrypto();
  const wordBytes = new TextEncoder().encode(normalized);
  const input = new Uint8Array(1 + wordBytes.length);
  input[0] = salt8;
  input.set(wordBytes, 1);
  const digestBuf = await subtle.digest("SHA-256", input);
  return new Uint8Array(digestBuf).slice(0, HENV_DIGEST_BYTES);
}

/**
 * Create an HENV1 optical codeword.
 * @param normalized Already-normalized A–Z surface.
 * @param saltOptional Test-only fixed salt byte. Production UI must omit this.
 */
export async function createHiddenToken(
  normalized: string,
  saltOptional?: number,
): Promise<HiddenToken> {
  assertNormalized(normalized);

  let salt8: number;
  if (saltOptional !== undefined) {
    if (!Number.isInteger(saltOptional) || saltOptional < 0 || saltOptional > 255) {
      throw new Error("salt8 must be an integer in 0..255.");
    }
    salt8 = saltOptional;
  } else {
    const buf = new Uint8Array(1);
    crypto.getRandomValues(buf);
    salt8 = buf[0]!;
  }

  const digest6 = await hiddenDigest6(normalized, salt8);
  const token = new Uint8Array(HENV_TOKEN_BYTES);
  token[0] = salt8;
  token.set(digest6, 1);

  return {
    protocolId: HENV_PROTOCOL_ID,
    salt8,
    digest6,
    token,
    normalizedWord: normalized,
  };
}

/** Byte order L→R, MSB first within each byte → exactly 56 bits (0|1). */
export function tokenToBits(token: Uint8Array): Int8Array {
  if (token.length !== HENV_TOKEN_BYTES) {
    throw new Error(`Token must be exactly ${HENV_TOKEN_BYTES} bytes.`);
  }
  const bits = new Int8Array(HENV_BIT_COUNT);
  let i = 0;
  for (let b = 0; b < HENV_TOKEN_BYTES; b++) {
    const byte = token[b]!;
    for (let bit = 7; bit >= 0; bit--) {
      bits[i++] = (byte >> bit) & 1;
    }
  }
  return bits;
}

/** Bit 1 => +1, bit 0 => -1 for watermark embedding. */
export function bitsToSigns(bits: Int8Array): Float64Array {
  if (bits.length !== HENV_BIT_COUNT) {
    throw new Error(`Expected ${HENV_BIT_COUNT} bits.`);
  }
  const signs = new Float64Array(HENV_BIT_COUNT);
  for (let i = 0; i < HENV_BIT_COUNT; i++) {
    signs[i] = bits[i]! === 1 ? 1 : -1;
  }
  return signs;
}

export function tokenToHex(token: Uint8Array): string {
  return Array.from(token)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToToken(hex: string): Uint8Array {
  const cleaned = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{14}$/.test(cleaned)) {
    throw new Error("Hidden token hex must be exactly 14 hex characters.");
  }
  const out = new Uint8Array(HENV_TOKEN_BYTES);
  for (let i = 0; i < HENV_TOKEN_BYTES; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bitsFromHardDecisions(soft: Float64Array): Int8Array {
  const bits = new Int8Array(soft.length);
  for (let i = 0; i < soft.length; i++) {
    bits[i] = soft[i]! >= 0 ? 1 : 0;
  }
  return bits;
}

export function bitsToToken(bits: Int8Array): Uint8Array {
  if (bits.length !== HENV_BIT_COUNT) {
    throw new Error(`Expected ${HENV_BIT_COUNT} bits.`);
  }
  const token = new Uint8Array(HENV_TOKEN_BYTES);
  for (let b = 0; b < HENV_TOKEN_BYTES; b++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      const v = bits[b * 8 + bit]!;
      if (v !== 0 && v !== 1) throw new Error("Bits must be 0 or 1.");
      byte = (byte << 1) | v;
    }
    token[b] = byte;
  }
  return token;
}
