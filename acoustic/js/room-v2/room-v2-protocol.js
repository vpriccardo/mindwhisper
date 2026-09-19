/**
 * room-v2 framing: maps the shared protocol-v2 frame onto the room
 * transport's 8-parallel-channel acoustic symbols. Pure framing logic —
 * no DSP here (see ../tx-engine.js / ../rx-decoder.js for the actual
 * unchanged acoustic watermark).
 */

import { buildFrameV2, decodeFrameV2, computeFrameLayoutV2 } from '../protocol-v2.js';
import { symbolsFromBytes, CHANNEL_COUNT } from '../protocol.js';
import { ROOM_V2_PREAMBLE, ROOM_V2_HEADER_SYMBOLS } from './room-v2-constants.js';

/**
 * Build the full room-v2 transmit frame: 8 preamble symbols + 3 header
 * symbols (unwhitened) + N RS-codeword symbols (1 RS byte = 1 symbol,
 * since the room transport already carries 8 bits/symbol).
 */
export function buildRoomV2TransmitSymbols(message) {
  const built = buildFrameV2(message);
  if (!built.whitenedBytes) {
    // Codeword bits are always byte-aligned (codewordBytes * 8), but guard
    // defensively in case framing assumptions ever change.
    throw new Error('room-v2 requires a byte-aligned whitened codeword');
  }
  const preambleSymbols = symbolsFromBytes(ROOM_V2_PREAMBLE);
  const headerSymbols = symbolsFromBytes(built.headerRepeats);
  const dataSymbols = symbolsFromBytes(built.whitenedBytes);
  const frameSymbols = preambleSymbols.concat(headerSymbols, dataSymbols);
  return {
    ...built,
    preambleSymbols,
    headerSymbols,
    dataSymbolsBits: dataSymbols,
    frameSymbols,
    frameSymbolCount: frameSymbols.length,
  };
}

/** Total acoustic symbol count for a given message length (preamble+header+codeword). */
export function roomV2FrameSymbolCount(messageLength) {
  const layout = computeFrameLayoutV2(messageLength);
  return ROOM_V2_PREAMBLE.length + ROOM_V2_HEADER_SYMBOLS + layout.codewordBytes;
}

export { ROOM_V2_PREAMBLE, ROOM_V2_HEADER_SYMBOLS, CHANNEL_COUNT, decodeFrameV2, computeFrameLayoutV2 };
