/**
 * PENV1 pack / unpack: dictionary index + CRC-8/SMBUS.
 */

import { CRC_BITS, INDEX_BITS, INDEX_MAX, PAYLOAD_BITS } from "./constants";

/** CRC-8/SMBUS: poly 0x07, init 0x00, no xorout. */
export function crc8Smbus(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function crc8Index(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= INDEX_MAX) {
    throw new Error("PENV1 index out of range.");
  }
  return crc8Smbus(new Uint8Array([(index >> 8) & 0xff, index & 0xff]));
}

/** 20-bit payload: [index 11][crc8 8][parity 1] */
export function packPayload(index: number): number {
  const crc = crc8Index(index);
  const body = (index & (INDEX_MAX - 1)) | (crc << INDEX_BITS);
  const parity = popcount19(body) & 1;
  return body | (parity << (INDEX_BITS + CRC_BITS));
}

function popcount19(n: number): number {
  let x = n & 0x7ffff;
  let c = 0;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

export type UnpackOk = {
  ok: true;
  index: number;
  crc: number;
};

export type UnpackFail = {
  ok: false;
  reason: string;
  index?: number;
};

export function unpackPayload(payload: number): UnpackOk | UnpackFail {
  const bits = payload >>> 0;
  if (bits >= 1 << PAYLOAD_BITS) {
    return { ok: false, reason: "payload_overflow" };
  }
  const body = bits & 0x7ffff;
  const parity = (bits >> (INDEX_BITS + CRC_BITS)) & 1;
  if ((popcount19(body) & 1) !== parity) {
    return { ok: false, reason: "parity" };
  }
  const index = body & (INDEX_MAX - 1);
  const crc = (body >> INDEX_BITS) & 0xff;
  if (crc8Index(index) !== crc) {
    return { ok: false, reason: "crc", index };
  }
  return { ok: true, index, crc };
}

export function toGray(n: number): number {
  return (n ^ (n >>> 1)) >>> 0;
}

export function fromGray(g: number): number {
  let n = g >>> 0;
  n ^= n >>> 1;
  n ^= n >>> 2;
  n ^= n >>> 4;
  n ^= n >>> 8;
  return n >>> 0;
}
