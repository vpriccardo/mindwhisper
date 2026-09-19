/**
 * call-v2 reference-aware decoding (§46) — optional experimental path.
 *
 * Because RX2 ships the SAME Meditation MP3 as TX2, the receiver can
 * subtract the expected natural spectral motion of the unwatermarked loop
 * from the received ratios, leaving primarily the watermark movement.
 *
 * Production blind decode must still work without this; this module is
 * behind `?debug=1` (and used by synthetic tests that know perfect phase).
 */

import { CallV2FeatureExtractor } from './call-v2-rx.js';
import { CALL_V2_CHANNEL_COUNT, CALL_V2_FEATURE_MS } from './call-v2-constants.js';

/**
 * Build a rolling feature stream from an unwatermarked reference PCM buffer
 * (the decoded Meditation asset). Features are extracted with the same
 * bandpass bank as the live RX so ratio subtraction is apples-to-apples.
 */
export function extractReferenceFeatures(samples, sampleRate, Q) {
  const extractor = new CallV2FeatureExtractor(sampleRate, Q);
  extractor.processBuffer(samples);
  return extractor.features;
}

/**
 * Subtract reference ratios from received ratios, with a fixed phase offset
 * in feature-index units. `refPhase` is the feature index into `refFeatures`
 * that aligns with `receivedFeatures[0]`. The reference loop wraps.
 */
export function subtractReferenceRatios(receivedFeatures, refFeatures, refPhase = 0) {
  if (!refFeatures.length) return receivedFeatures;
  const nRef = refFeatures.length;
  return receivedFeatures.map((f, i) => {
    const ref = refFeatures[(refPhase + i) % nRef];
    const ratios = new Float32Array(CALL_V2_CHANNEL_COUNT);
    for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
      ratios[p] = f.ratios[p] - (ref ? ref.ratios[p] : 0);
    }
    return { sampleIndex: f.sampleIndex, timestamp: f.timestamp, ratios };
  });
}

/**
 * Coarse phase search: find the reference-loop offset that maximises the
 * energy of the residual (watermark) soft-bit variance over a short window,
 * OR — when a preamble scorer is supplied — the preamble correlation.
 *
 * `scoreFn(correctedFeatures, start)` should return a numeric score; higher
 * is better. Step size defaults to 1 feature (~10 ms).
 */
export function searchReferencePhase(opts) {
  const {
    receivedFeatures,
    refFeatures,
    scoreFn,
    searchStarts = [0],
    maxPhase = refFeatures.length,
    step = 1,
  } = opts;
  let best = { phase: 0, score: -Infinity, start: 0 };
  for (const start of searchStarts) {
    for (let phase = 0; phase < maxPhase; phase += step) {
      const corrected = subtractReferenceRatios(receivedFeatures, refFeatures, phase);
      const score = scoreFn(corrected, start);
      if (score > best.score) best = { phase, score, start };
    }
  }
  return best;
}

/**
 * Convenience: feature-index duration of one reference loop.
 */
export function referenceLoopFeatureCount(refSampleCount, sampleRate, featureMs = CALL_V2_FEATURE_MS) {
  const block = Math.max(1, Math.round((featureMs / 1000) * sampleRate));
  return Math.floor(refSampleCount / block);
}
