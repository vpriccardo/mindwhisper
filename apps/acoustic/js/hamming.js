/**
 * Hamming(7,4) with even parity.
 * Positions: 1 2 3 4 5 6 7
 * Content:   p p d p d d d
 * (1-indexed parity bits at 1, 2, 4)
 */

/**
 * Encode a 4-bit nibble (0–15) into a 7-bit codeword (bit 6 = pos1 … bit 0 = pos7).
 * @param {number} nibble
 * @returns {number} 7-bit codeword
 */
export function hammingEncodeNibble(nibble) {
  const d = nibble & 0x0f;
  const d1 = (d >> 3) & 1; // position 3
  const d2 = (d >> 2) & 1; // position 5
  const d3 = (d >> 1) & 1; // position 6
  const d4 = d & 1; // position 7

  // Even parity
  const p1 = d1 ^ d2 ^ d4; // covers 1,3,5,7
  const p2 = d1 ^ d3 ^ d4; // covers 2,3,6,7
  const p4 = d2 ^ d3 ^ d4; // covers 4,5,6,7

  // Pack positions 1..7 into bits 6..0
  return (
    (p1 << 6) |
    (p2 << 5) |
    (d1 << 4) |
    (p4 << 3) |
    (d2 << 2) |
    (d3 << 1) |
    d4
  );
}

/**
 * Decode a 7-bit codeword. Corrects single-bit errors via syndrome.
 * @param {number} codeword
 * @returns {{ nibble: number, corrected: boolean, syndrome: number }}
 */
export function hammingDecodeCodeword(codeword) {
  const c = codeword & 0x7f;
  const bits = [
    0,
    (c >> 6) & 1, // pos 1
    (c >> 5) & 1, // pos 2
    (c >> 4) & 1, // pos 3
    (c >> 3) & 1, // pos 4
    (c >> 2) & 1, // pos 5
    (c >> 1) & 1, // pos 6
    c & 1, // pos 7
  ];

  // Syndrome with even parity checks
  const s1 = bits[1] ^ bits[3] ^ bits[5] ^ bits[7];
  const s2 = bits[2] ^ bits[3] ^ bits[6] ^ bits[7];
  const s4 = bits[4] ^ bits[5] ^ bits[6] ^ bits[7];
  const syndrome = s1 | (s2 << 1) | (s4 << 2);

  let corrected = false;
  if (syndrome !== 0) {
    bits[syndrome] ^= 1;
    corrected = true;
  }

  const nibble =
    (bits[3] << 3) | (bits[5] << 2) | (bits[6] << 1) | bits[7];

  return { nibble, corrected, syndrome };
}

/**
 * Encode an array of bytes into Hamming-coded bits (MSB-first nibbles per byte).
 * @param {Uint8Array|number[]} bytes
 * @returns {Uint8Array} bit array (0/1), length = bytes.length * 2 * 7
 */
export function hammingEncodeBytes(bytes) {
  const out = new Uint8Array(bytes.length * 2 * 7);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    const hi = (bytes[i] >> 4) & 0x0f;
    const lo = bytes[i] & 0x0f;
    for (const nibble of [hi, lo]) {
      const cw = hammingEncodeNibble(nibble);
      for (let b = 6; b >= 0; b--) {
        out[o++] = (cw >> b) & 1;
      }
    }
  }
  return out;
}

/**
 * Decode Hamming-coded bits back to bytes.
 * @param {Uint8Array|number[]} bits length must be multiple of 14 (two codewords per byte)
 * @returns {{ bytes: Uint8Array, correctionCount: number }}
 */
export function hammingDecodeBits(bits) {
  if (bits.length % 14 !== 0) {
    throw new Error(`Hamming bit length must be multiple of 14, got ${bits.length}`);
  }
  const byteCount = bits.length / 14;
  const bytes = new Uint8Array(byteCount);
  let correctionCount = 0;
  let bi = 0;
  for (let i = 0; i < byteCount; i++) {
    let byte = 0;
    for (let n = 0; n < 2; n++) {
      let cw = 0;
      for (let b = 0; b < 7; b++) {
        cw = (cw << 1) | (bits[bi++] & 1);
      }
      const { nibble, corrected } = hammingDecodeCodeword(cw);
      if (corrected) correctionCount++;
      byte = (byte << 4) | nibble;
    }
    bytes[i] = byte;
  }
  return { bytes, correctionCount };
}
