/**
 * call-v2 constants: music-embedded differential-EQ watermark.
 *
 * THE MUSIC ITSELF IS THE CARRIER — there is no separate additive carrier
 * bus (contrast with call-v1's CallCarrierBank in call-carrier.js, which
 * this transport does NOT use for the default Meditation call path).
 */

export const CALL_V2_PROTOCOL_ID = 'call-v2';

/** Six host-spectral frequency-pair channels (§25). All inside the
 * speech/audio region likely to survive calls, and (per §26 analysis —
 * see docs/call-v2-band-analysis.md) chosen to sit on real, usable energy
 * already present in the Meditation asset. */
export const CALL_V2_PAIRS = Object.freeze([
  Object.freeze([220, 300]),
  Object.freeze([340, 420]),
  Object.freeze([460, 560]),
  Object.freeze([620, 740]),
  Object.freeze([820, 960]),
  Object.freeze([1080, 1260]),
]);
export const CALL_V2_CHANNEL_COUNT = CALL_V2_PAIRS.length; // 6

/** Peaking-filter Q — configurable, not highly resonant (§25). */
export const CALL_V2_Q_DEFAULT = 3.0;
export const CALL_V2_Q_MIN = 2.5;
export const CALL_V2_Q_MAX = 3.5;

/** Watermark strength presets — TOTAL low/high differential, in dB (§30). */
export const CALL_V2_DEPTH_PRESETS = Object.freeze({
  invisible: 0.2,
  verySubtle: 0.3,
  balanced: 0.4,
  robust: 0.55,
  strong: 0.7,
});
export const CALL_V2_DEPTH_ORDER = Object.freeze([
  'invisible',
  'verySubtle',
  'balanced',
  'robust',
  'strong',
]);
export const CALL_V2_DEPTH_LABELS = Object.freeze({
  invisible: 'Invisible',
  verySubtle: 'Very subtle',
  balanced: 'Balanced',
  robust: 'Robust',
  strong: 'Strong',
});
export const CALL_V2_DEPTH_DESCRIPTIONS = Object.freeze({
  invisible: 'Maximum audio purity; experimental.',
  verySubtle: 'Extremely small spectral changes.',
  balanced: 'Recommended starting point.',
  robust: 'More resistant to call processing.',
  strong: 'Diagnostic/high-robustness mode.',
});
export const CALL_V2_DEFAULT_DEPTH = 'balanced';

/** Symbol timing presets (§31/§36). */
export const CALL_V2_SPEED_PRESETS = Object.freeze({
  fastest: 100,
  fast: 120,
  balanced: 140,
  conservative: 160,
});
export const CALL_V2_SPEED_ORDER = Object.freeze([
  'fastest',
  'fast',
  'balanced',
  'conservative',
]);
export const CALL_V2_SPEED_LABELS = Object.freeze({
  fastest: 'Fastest',
  fast: 'Fast',
  balanced: 'Balanced',
  conservative: 'Conservative',
});
export const CALL_V2_DEFAULT_SPEED = 'fast'; // 120 ms

export function callV2SymbolMsForSpeed(speedId) {
  return CALL_V2_SPEED_PRESETS[speedId] ?? CALL_V2_SPEED_PRESETS[CALL_V2_DEFAULT_SPEED];
}

/** Half-symbol gain-transition ramp (§29). */
export const CALL_V2_TRANSITION_MS = 12;

/**
 * RX feature extraction granularity (§38 says "every approximately 20 ms";
 * 10 ms is chosen here so every half-symbol duration (50/60/70/80 ms for
 * the four speed presets) divides evenly — see room-v2-constants.js for the
 * identical rationale).
 */
export const CALL_V2_FEATURE_MS = 10;

/** Eight six-bit preamble symbols (§32). Encoded with the SAME two-half
 * self-cancelling modulation as ordinary payload bits — no separate
 * synchronization sound. */
export const CALL_V2_PREAMBLE = Object.freeze([
  0b111000, 0b000111, 0b110100, 0b001011, 0b101010, 0b010101, 0b100110,
  0b011001,
]);
export const CALL_V2_PREAMBLE_SYMBOLS = CALL_V2_PREAMBLE.length; // 8

/** Header repeated 3× → 24 bits → 4 six-bit symbols (§33). */
export const CALL_V2_HEADER_BITS = 24;
export const CALL_V2_HEADER_SYMBOLS = CALL_V2_HEADER_BITS / CALL_V2_CHANNEL_COUNT; // 4

export const CALL_V2_PREAMBLE_CORRELATION_MIN = 0.3;
export const CALL_V2_TRACK_WINDOW_MS = 400;
export const CALL_V2_MISSED_FRAMES_TO_SEARCH = 2;
export const CALL_V2_DUPLICATE_SUPPRESS_MS = 25000;
export const CALL_V2_FEATURE_BUFFER_SECONDS = 60;
export const CALL_V2_EPSILON_ENERGY = 1e-20;

/** Byte confidence below this becomes an RS erasure (§41). */
export const CALL_V2_BYTE_ERASURE_CONFIDENCE_THRESHOLD = 0.3;

/** Multi-frame soft combine attempts up to 3 (§45). */
export const CALL_V2_MAX_COMBINE_FRAMES = 3;
