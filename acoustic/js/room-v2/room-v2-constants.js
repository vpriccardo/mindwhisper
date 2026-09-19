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
  adaptive: 'Adaptive',
  fastest: 'Fastest',
  fast: 'Fast',
  balanced: 'Balanced',
  conservative: 'Conservative',
});
export const ROOM_V2_SPEED_ORDER = Object.freeze([
  'adaptive',
  'fastest',
  'fast',
  'balanced',
  'conservative',
]);
/** UI order excluding the adaptive meta-preset (resolved at encode time). */
export const ROOM_V2_SPEED_PRESET_ORDER = Object.freeze([
  'fastest',
  'fast',
  'balanced',
  'conservative',
]);
/**
 * Synthetic Monte-Carlo (Air, hard decode, no soft-combine) showed only
 * conservative meeting ≥75% alone. Live path now uses ranked RS erasures +
 * soft multi-frame combine, so TX can pick a length-adaptive default that
 * prefers shorter frames for short messages while RX still blindly detects
 * whichever speed is on the air.
 */
export const ROOM_V2_DEFAULT_SPEED = 'adaptive';

/** Resolve a concrete preset id (never returns 'adaptive'). */
export function roomV2ResolveSpeedId(speedId, messageLength = 8) {
  if (speedId && speedId !== 'adaptive' && ROOM_V2_SPEED_PRESETS[speedId] != null) {
    return speedId;
  }
  return roomV2AdaptiveSpeedForLength(messageLength);
}

/**
 * Length-tiered TX speed: short messages get 90 ms (faster first-lock),
 * longer ones stay on 120 ms for integration. RX detects whichever is sent.
 */
export function roomV2AdaptiveSpeedForLength(messageLength) {
  const n = Number(messageLength) || 8;
  // Prefer faster symbols for short messages; soft-combine + stronger FEC
  // cover the SNR hit. Longer messages stay on 120 ms integration.
  if (n <= 5) return 'fast'; // 75 ms
  if (n <= 10) return 'balanced'; // 90 ms
  return 'conservative';
}

export function roomV2SymbolMsForSpeed(speedId, messageLength = 8) {
  const id = roomV2ResolveSpeedId(speedId, messageLength);
  return ROOM_V2_SPEED_PRESETS[id] ?? ROOM_V2_SPEED_PRESETS.conservative;
}

/** Crossfade between symbols — same short raised-cosine blend as room-v1. */
export const ROOM_V2_CROSSFADE_MS = 12;

/** Preamble correlation threshold (tuned empirically like room-v1's PREAMBLE_CORRELATION_MIN). */
export const ROOM_V2_PREAMBLE_CORRELATION_MIN = 0.35;

export const ROOM_V2_DUPLICATE_SUPPRESS_MS = 10000;
export const ROOM_V2_FEATURE_BUFFER_SECONDS = 30;
export const ROOM_V2_EPSILON_ENERGY = 1e-20;

/** Per-byte confidence below this seeds the threshold erasure set. */
export const ROOM_V2_BYTE_ERASURE_QUALITY_THRESHOLD = 0.22;

/** Soft multi-frame combine across TX repetitions (time-to-first-CRC). */
export const ROOM_V2_MAX_COMBINE_FRAMES = 4;
