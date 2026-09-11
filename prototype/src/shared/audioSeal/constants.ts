/**
 * AENV1 acoustic transport constants.
 * Timing and structure are fixed; do not change ad hoc.
 */

export const AENV_PROTOCOL_ID = "AENV1" as const;
/** Fixed 32-bit seed for all protocol-structure PRNG draws (interleave, bases). */
export const AENV_VERSION_SEED = 0x41454e56; // 'AENV'
export const AENV_BASIS_KEY = 0xa51c0de5;

export const SAMPLE_RATE = 48_000;
export const TOTAL_DURATION_S = 2.1;
export const TOTAL_SAMPLES = 100_800;

/**
 * Each loop iteration is one full packet. The double-chirp preamble at
 * PREAMBLE_START is the receiver sync marker — looping re-emits it every
 * TOTAL_DURATION_S so the performer can lock without a single-shot play.
 */
export const PACKET_LOOP_PERIOD_S = TOTAL_DURATION_S;

export const PRE_ROLL_SAMPLES = 4_800;
export const PREAMBLE_SAMPLES = 7_680;
export const GUARD_SAMPLES = 1_920;
export const SYMBOL_SAMPLES = 480;
export const NUM_SYMBOLS = 156;
export const DATA_SAMPLES = NUM_SYMBOLS * SYMBOL_SAMPLES; // 74_880
export const TAIL_SAMPLES = 11_520;

export const PREAMBLE_START = PRE_ROLL_SAMPLES;
export const GUARD_START = PREAMBLE_START + PREAMBLE_SAMPLES;
export const DATA_START = GUARD_START + GUARD_SAMPLES;
export const TAIL_START = DATA_START + DATA_SAMPLES;

/** Samples from preamble start through end of packet (excludes pre-roll). */
export const PACKET_FROM_PREAMBLE = TOTAL_SAMPLES - PRE_ROLL_SAMPLES;

export const CHIPS_PER_SYMBOL = 30;
export const SAMPLES_PER_CHIP = 16;
export const HOP_FREQUENCIES_HZ = [3200, 4000, 4800, 5600, 6400, 7200] as const;

export const PREAMBLE_F0_HZ = 2600;
export const PREAMBLE_F1_HZ = 7400;
export const PREAMBLE_HALF_SAMPLES = PREAMBLE_SAMPLES / 2; // 3840 = 80 ms

export const BAND_LOW_HZ = 2800;
export const BAND_HIGH_HZ = 7600;
export const DETECT_BAND_LOW_HZ = 2200;
export const DETECT_BAND_HIGH_HZ = 8200;

export const HENV_TOKEN_BYTES = 7;
export const CRC_BYTES = 2;
export const PACKET_BYTES = HENV_TOKEN_BYTES + CRC_BYTES; // 9
export const PACKET_BITS = PACKET_BYTES * 8; // 72
export const TAIL_BITS = 6;
export const CONV_INPUT_BITS = PACKET_BITS + TAIL_BITS; // 78
export const CODED_BITS = CONV_INPUT_BITS * 2; // 156

export const CONV_K = 7;
export const CONV_RATE = 2;
/** Generator polynomials in octal. */
export const CONV_G0_OCTAL = 0o171;
export const CONV_G1_OCTAL = 0o133;

/** Provisional watermark level vs cover RMS in the data region (dB). */
export const WATERMARK_DB_PROVISIONAL = -12;
export const WATERMARK_DB_VERSION = 2;

export const MASK_WINDOW_SAMPLES = Math.round(0.02 * SAMPLE_RATE); // 960 = 20 ms
export const BOUNDARY_FADE_SAMPLES = Math.round(0.005 * SAMPLE_RATE); // 240 = 5 ms
export const PEAK_LIMIT_DBFS = -1;

export const RING_BUFFER_SECONDS = 6;
export const RING_BUFFER_SAMPLES = RING_BUFFER_SECONDS * SAMPLE_RATE;

export const TIMING_SCALES = [0.995, 0.9975, 1.0, 1.0025, 1.005] as const;

export const AUDIO_MANIFEST = {
  protocolId: AENV_PROTOCOL_ID,
  versionSeed: AENV_VERSION_SEED,
  sampleRate: SAMPLE_RATE,
  totalSamples: TOTAL_SAMPLES,
  watermarkDb: WATERMARK_DB_PROVISIONAL,
  watermarkDbVersion: WATERMARK_DB_VERSION,
  provisional: true as const,
  /** Acoustic laptop speaker→mic; digital tests pass well above this. */
  preambleCorrThreshold: 0.045,
  preambleSidelobeRatio: 1.12,
  viterbiMarginMin: 0.5,
  duplicateSuppressMs: 8_000,
} as const;

if (
  PRE_ROLL_SAMPLES +
    PREAMBLE_SAMPLES +
    GUARD_SAMPLES +
    DATA_SAMPLES +
    TAIL_SAMPLES !==
  TOTAL_SAMPLES
) {
  throw new Error("AENV1 timing regions must sum to TOTAL_SAMPLES.");
}

if (CODED_BITS !== NUM_SYMBOLS) {
  throw new Error("Coded bit count must equal symbol count.");
}

if (CHIPS_PER_SYMBOL * SAMPLES_PER_CHIP !== SYMBOL_SAMPLES) {
  throw new Error("Chip layout must fill one symbol.");
}
