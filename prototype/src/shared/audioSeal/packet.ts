/**
 * AENV1 packet: HENV1(7) || CRC16(2) → FEC → interleave → 156 bits.
 */

import { HENV_TOKEN_BYTES, PACKET_BITS, PACKET_BYTES } from "./constants";
import { convDecodeSoft, convEncode, type ViterbiResult } from "./convolutional";
import { crc16Bytes, crc16CcittFalse, verifyCrc16 } from "./crc16";
import { deinterleaveSoft, interleaveBits } from "./interleave";

export type EncodedPacket = {
  token: Uint8Array;
  crc: number;
  packetBytes: Uint8Array;
  packetBits: Int8Array;
  codedBits: Int8Array;
  interleavedBits: Int8Array;
};

export type DecodedPacket = {
  ok: boolean;
  token: Uint8Array | null;
  crcOk: boolean;
  tailOk: boolean;
  viterbi: ViterbiResult | null;
  failReason: string | null;
};

function bytesToBits(bytes: Uint8Array): Int8Array {
  const bits = new Int8Array(bytes.length * 8);
  let i = 0;
  for (let b = 0; b < bytes.length; b++) {
    const byte = bytes[b]!;
    for (let bit = 7; bit >= 0; bit--) {
      bits[i++] = (byte >> bit) & 1;
    }
  }
  return bits;
}

function bitsToBytes(bits: Int8Array, numBytes: number): Uint8Array {
  if (bits.length < numBytes * 8) throw new Error("bitsToBytes: short");
  const out = new Uint8Array(numBytes);
  for (let b = 0; b < numBytes; b++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      byte = (byte << 1) | (bits[b * 8 + bit]! & 1);
    }
    out[b] = byte;
  }
  return out;
}

export function encodeAenvPacket(token: Uint8Array): EncodedPacket {
  if (token.length !== HENV_TOKEN_BYTES) {
    throw new Error(`Token must be ${HENV_TOKEN_BYTES} bytes.`);
  }
  const crcBytes = crc16Bytes(token);
  const crc = crc16CcittFalse(token);
  const packetBytes = new Uint8Array(PACKET_BYTES);
  packetBytes.set(token, 0);
  packetBytes.set(crcBytes, HENV_TOKEN_BYTES);
  const packetBits = bytesToBits(packetBytes);
  if (packetBits.length !== PACKET_BITS) {
    throw new Error("Packet bit length mismatch.");
  }
  const codedBits = convEncode(packetBits);
  const interleavedBits = interleaveBits(codedBits);
  return {
    token: Uint8Array.from(token),
    crc,
    packetBytes,
    packetBits,
    codedBits,
    interleavedBits,
  };
}

/**
 * Decode from soft values in interleaved (channel) order.
 * soft[i] > 0 favors bit 1.
 */
export function decodeAenvPacketSoft(softInterleaved: Float64Array): DecodedPacket {
  const softCoded = deinterleaveSoft(softInterleaved);
  const viterbi = convDecodeSoft(softCoded);
  if (!viterbi.tailOk) {
    return {
      ok: false,
      token: null,
      crcOk: false,
      tailOk: false,
      viterbi,
      failReason: "tail_bits",
    };
  }
  const packetBytes = bitsToBytes(viterbi.bits, PACKET_BYTES);
  const token = packetBytes.subarray(0, HENV_TOKEN_BYTES);
  const crcOk = verifyCrc16(token, packetBytes[7]!, packetBytes[8]!);
  if (!crcOk) {
    return {
      ok: false,
      token: Uint8Array.from(token),
      crcOk: false,
      tailOk: true,
      viterbi,
      failReason: "crc",
    };
  }
  return {
    ok: true,
    token: Uint8Array.from(token),
    crcOk: true,
    tailOk: true,
    viterbi,
    failReason: null,
  };
}

export { bytesToBits, bitsToBytes };
