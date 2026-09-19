/**
 * CRC-16/CCITT-FALSE
 * poly=0x1021, init=0xFFFF, refin=false, refout=false, xorout=0x0000
 * Standard test vector: "123456789" => 0x29B1
 */
export function crc16CcittFalse(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

export function crc16ToBytes(crc) {
  return [(crc >> 8) & 0xff, crc & 0xff];
}

export function bytesToCrc16(hi, lo) {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}
