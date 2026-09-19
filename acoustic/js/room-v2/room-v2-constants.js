/**
 * room-v2 constants — framing/timing only. The acoustic watermark itself
 * (8 differential spectral channels, band design, ambient mixing) is
 * UNCHANGED from room-v1 and lives in ../protocol.js (WATERMARK_CHANNELS,
 * BANDWIDTH_HZ, CHANNEL_COUNT) and ../tx-engine.js / ../rx-decoder.js.
 */

/** New 8-byte preamble distinguishes room-v2 from room-v1 at the RX. */
export const ROOM_V2_PREAMBLE = new Uint8Array([
  0x96, 0x69, 0xc3, 0x3c, 0xa5, 0x5a, 0xd2, 0x2d,
]);
export const ROOM_V2_PREAMBLE_SYMBOLS = ROOM_V2_PREAMBLE.length; // 8

/** Header repeated 3× (unwhitened) right after the preamble, before the RS codeword. */
export const ROOM_V2_HEADER_SYMBOLS = 3;

/**
 * Feature extraction granularity for room-v2. Chosen so every supported
 * symbol duration (60/75/90/120 ms) divides evenly (GCD(60,75,90,120)=15),
 * avoiding cross-symbol bias from misaligned feature blocks.
 */
export const ROOM_V2_FEATURE_MS = 15;

export const ROOM_V2_SPEED_PRESETS = Object.freeze({
  fastest: 60,
  fast: 75,
  balanced: 90,
  conservative: 120,
});
export const ROOM_V2_SPEED_LABELS = Object.freeze({
  fastest: 'Fastest',
  fast: 'Fast',
  balanced: 'Balanced',
  conservative: 'Conservative',
});
export const ROOM_V2_SPEED_ORDER = Object.freeze([
  'fastest',
  'fast',
  'balanced',
  'conservative',
]);
/**
 * Synthetic Monte-Carlo testing (see docs/room-v2-report.md /
 * run-room-v2-tests.mjs) measured decode success within 8 continuously
 * repeated frames, WITHOUT changing the proven room-v1 carrier/modulation
 * depth (§15/§50 forbid that):
 *
 *   speed          1-8 chars   9-14 chars   15-20 chars
 *   fastest (60ms)   1/15         0/15          0/15
 *   fast    (75ms)   8/15         1/15          1/15
 *   balanced(90ms)   6/15         3/15          0/15
 *   conservative     15/15        14/15         13/15
 *
 * 60/75/90 ms are exposed for engineering comparison, but only
 * `conservative` (120 ms) meets the "strong practical performance" bar
 * (§18/§21) with the unchanged carrier. It is therefore the default;
 * shipping a faster nominal default that mostly fails would violate §18's
 * explicit "do not blindly ship" instruction.
 */
export const ROOM_V2_DEFAULT_SPEED = 'conservative'; // 120 ms

export function roomV2SymbolMsForSpeed(speedId) {
  return ROOM_V2_SPEED_PRESETS[speedId] ?? ROOM_V2_SPEED_PRESETS[ROOM_V2_DEFAULT_SPEED];
}

/** Crossfade between symbols — same short raised-cosine blend as room-v1. */
export const ROOM_V2_CROSSFADE_MS = 12;

/** Preamble correlation threshold (tuned empirically like room-v1's PREAMBLE_CORRELATION_MIN). */
export const ROOM_V2_PREAMBLE_CORRELATION_MIN = 0.35;

export const ROOM_V2_DUPLICATE_SUPPRESS_MS = 10000;
export const ROOM_V2_FEATURE_BUFFER_SECONDS = 30;
export const ROOM_V2_EPSILON_ENERGY = 1e-20;

/** Per-symbol (=per-RS-byte) confidence below this triggers an RS erasure. */
export const ROOM_V2_BYTE_ERASURE_QUALITY_THRESHOLD = 0.22;
