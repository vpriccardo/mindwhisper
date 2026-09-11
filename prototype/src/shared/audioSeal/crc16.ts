/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflect, xorout 0.
 */

const POLY = 0x1021;
const INIT = 0xffff;

export function crc16CcittFalse(data: Uint8Array): number {
  let crc = INIT;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i]! << 8) & 0xffff;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ POLY) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

/** Append high byte then low byte. */
export function crc16Bytes(data: Uint8Array): Uint8Array {
  const crc = crc16CcittFalse(data);
  return new Uint8Array([(crc >>> 8) & 0xff, crc & 0xff]);
}

export function verifyCrc16(token7: Uint8Array, crcHi: number, crcLo: number): boolean {
  if (token7.length !== 7) throw new Error("CRC covers exactly 7 HENV1 bytes.");
  const expect = crc16CcittFalse(token7);
  return expect === (((crcHi & 0xff) << 8) | (crcLo & 0xff));
}
