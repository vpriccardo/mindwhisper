/**
 * call-v2 RX: self-referencing spectral feature extraction + soft-bit
 * demodulation + preamble/header/RS decode. The received audio is expected
 * to sound like ordinary music — RX never looks for an added tone; it
 * looks for the music's OWN band-energy balance moving in the expected
 * two-half self-cancelling pattern (§38/§39).
 */

import { designBandpass, createBiquadState, processBiquad } from '../dsp-biquad.js';
import {
  decodeFrameV2,
  computeFrameLayoutV2,
  parseHeaderV2,
  majorityVoteHeaderByte,
} from '../protocol-v2.js';
import {
  CALL_V2_PAIRS,
  CALL_V2_CHANNEL_COUNT,
  CALL_V2_PREAMBLE,
  CALL_V2_HEADER_SYMBOLS,
  CALL_V2_Q_DEFAULT,
  CALL_V2_SPEED_PRESETS,
  CALL_V2_SPEED_ORDER,
  CALL_V2_FEATURE_MS,
  CALL_V2_PREAMBLE_CORRELATION_MIN,
  CALL_V2_DUPLICATE_SUPPRESS_MS,
  CALL_V2_FEATURE_BUFFER_SECONDS,
  CALL_V2_EPSILON_ENERGY,
  CALL_V2_BYTE_ERASURE_CONFIDENCE_THRESHOLD,
  CALL_V2_MAX_COMBINE_FRAMES,
} from './call-v2-constants.js';

// ---------------------------------------------------------------------------
// Feature extraction: 12 bandpass energies -> 6 low/high ratios per block.
// ---------------------------------------------------------------------------

export class CallV2FeatureExtractor {
  constructor(sampleRate, Q = CALL_V2_Q_DEFAULT, featureMs = CALL_V2_FEATURE_MS) {
    this.sampleRate = sampleRate;
    this.featureMs = featureMs;
    this.filters = [];
    this.states = [];
    for (const [lowHz, highHz] of CALL_V2_PAIRS) {
      this.filters.push(designBandpass(lowHz, sampleRate, lowHz / Q));
      this.filters.push(designBandpass(highHz, sampleRate, highHz / Q));
      this.states.push(createBiquadState(), createBiquadState());
    }
    this.energies = new Float64Array(CALL_V2_CHANNEL_COUNT * 2);
    this.blockSamples = Math.max(1, Math.round((featureMs / 1000) * sampleRate));
    this.inBlock = 0;
    this.sampleIndex = 0;
    this.features = [];
  }

  processSample(x) {
    for (let b = 0; b < this.filters.length; b++) {
      const y = processBiquad(x, this.filters[b], this.states[b]);
      this.energies[b] += y * y;
    }
    this.inBlock++;
    this.sampleIndex++;
    if (this.inBlock >= this.blockSamples) {
      const ratios = new Float32Array(CALL_V2_CHANNEL_COUNT);
      for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
        const eLow = this.energies[p * 2];
        const eHigh = this.energies[p * 2 + 1];
        ratios[p] = 10 * Math.log10((eLow + CALL_V2_EPSILON_ENERGY) / (eHigh + CALL_V2_EPSILON_ENERGY));
      }
      const feat = {
        sampleIndex: this.sampleIndex,
        timestamp: (this.sampleIndex / this.sampleRate) * 1000,
        ratios,
      };
      this.features.push(feat);
      this.energies.fill(0);
      this.inBlock = 0;
      return feat;
    }
    return null;
  }

  processBuffer(samples) {
    const out = [];
    for (let i = 0; i < samples.length; i++) {
      const f = this.processSample(samples[i]);
      if (f) out.push(f);
    }
    return out;
  }
}

export class CallV2FeatureBuffer {
  constructor(seconds = CALL_V2_FEATURE_BUFFER_SECONDS, featureMs = CALL_V2_FEATURE_MS) {
    this.maxFeatures = Math.ceil((seconds * 1000) / featureMs);
    this.items = [];
  }
  push(feat) {
    this.items.push(feat);
    if (this.items.length > this.maxFeatures) {
      this.items.splice(0, this.items.length - this.maxFeatures);
    }
  }
  get length() {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// Self-referencing two-half soft-bit extraction (§39)
// ---------------------------------------------------------------------------

const SPEED_CANDIDATES = CALL_V2_SPEED_ORDER.map((id) => {
  const symbolMs = CALL_V2_SPEED_PRESETS[id];
  const halfMs = symbolMs / 2;
  return {
    id,
    symbolMs,
    halfMs,
    featuresPerHalf: Math.round(halfMs / CALL_V2_FEATURE_MS),
    featuresPerSymbol: Math.round(symbolMs / CALL_V2_FEATURE_MS),
  };
});
export const CALL_V2_MAX_FEATURES_PER_SYMBOL = Math.max(...SPEED_CANDIDATES.map((c) => c.featuresPerSymbol));
export const CALL_V2_PREAMBLE_LOOKAHEAD_FEATURES =
  CALL_V2_PREAMBLE.length * CALL_V2_MAX_FEATURES_PER_SYMBOL;

/** Average ratios over the usable (post-transition) blocks of one half-symbol. */
function halfRatios(featureItems, start, featuresPerHalf) {
  const ratios = new Float32Array(CALL_V2_CHANNEL_COUNT);
  let count = 0;
  const first = featuresPerHalf >= 2 ? 1 : 0; // skip only the transition-affected first block
  for (let b = first; b < featuresPerHalf; b++) {
    const idx = start + b;
    if (idx >= featureItems.length || !featureItems[idx]) break;
    const r = featureItems[idx].ratios;
    for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) ratios[p] += r[p];
    count++;
  }
  if (count > 0) {
    for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) ratios[p] /= count;
  }
  return { ratios, count };
}

/** softBit[p] = firstHalfRatio[p] - secondHalfRatio[p] for the symbol starting at `start`. */
export function softBitsForSymbol(featureItems, start, featuresPerHalf) {
  const first = halfRatios(featureItems, start, featuresPerHalf);
  const second = halfRatios(featureItems, start + featuresPerHalf, featuresPerHalf);
  const soft = new Float32Array(CALL_V2_CHANNEL_COUNT);
  for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
    soft[p] = first.ratios[p] - second.ratios[p];
  }
  return { soft, validHalves: first.count > 0 && second.count > 0 };
}

function preambleExpectedSigns() {
  return CALL_V2_PREAMBLE.map((sym) => {
    const row = new Float32Array(CALL_V2_CHANNEL_COUNT);
    for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
      row[p] = (sym >> (CALL_V2_CHANNEL_COUNT - 1 - p)) & 1 ? 1 : -1;
    }
    return row;
  });
}
const PREAMBLE_SIGNS = preambleExpectedSigns();

/**
 * Preamble correlation score for one (start, speed) hypothesis.
 *
 * Unlike room-v2's calibrated synthetic carrier (all 8 channels share
 * comparable natural gain), each call-v2 channel rides on a DIFFERENT,
 * uncontrolled real-music frequency band whose natural energy/SNR can
 * differ by many dB from the others. A naive magnitude-weighted
 * correlation lets weak/noisy channels dilute strong, clean ones, so each
 * channel is first normalized by its own RMS across the preamble (a
 * per-channel z-score) before combining — equivalent to a simple SNR-
 * weighted combiner.
 */
export function scoreCallV2PreambleAt(featureItems, start, featuresPerHalf) {
  const symbolFeatures = featuresPerHalf * 2;
  const needed = CALL_V2_PREAMBLE.length * symbolFeatures;
  if (start + needed > featureItems.length) {
    return { score: -1, softs: null };
  }
  const softs = [];
  for (let s = 0; s < CALL_V2_PREAMBLE.length; s++) {
    const { soft } = softBitsForSymbol(featureItems, start + s * symbolFeatures, featuresPerHalf);
    softs.push(soft);
  }
  const chRms = new Float32Array(CALL_V2_CHANNEL_COUNT);
  for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
    let sum2 = 0;
    for (let s = 0; s < softs.length; s++) sum2 += softs[s][p] * softs[s][p];
    chRms[p] = Math.sqrt(sum2 / softs.length) + 1e-6;
  }
  let num = 0;
  let denObs = 0;
  let denExp = 0;
  for (let s = 0; s < softs.length; s++) {
    for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
      const obs = softs[s][p] / chRms[p];
      const exp = PREAMBLE_SIGNS[s][p];
      num += obs * exp;
      denObs += obs * obs;
      denExp += exp * exp;
    }
  }
  const score = num / (Math.sqrt(denObs * denExp) + 1e-12);
  return { score, softs, chRms };
}

export function bestCallV2SpeedAt(featureItems, start) {
  let best = null;
  for (const cand of SPEED_CANDIDATES) {
    const r = scoreCallV2PreambleAt(featureItems, start, cand.featuresPerHalf);
    if (!best || r.score > best.score) best = { ...r, speed: cand };
  }
  return best;
}

/** Per-channel calibration from the known preamble (§40): scale/noise/quality. */
function calibrateCallV2Preamble(softs) {
  const calib = [];
  for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
    let sumScale = 0;
    for (let s = 0; s < softs.length; s++) sumScale += softs[s][p] * PREAMBLE_SIGNS[s][p];
    const scale = sumScale / softs.length;
    let sumRes2 = 0;
    for (let s = 0; s < softs.length; s++) {
      const pred = scale * PREAMBLE_SIGNS[s][p];
      const res = softs[s][p] - pred;
      sumRes2 += res * res;
    }
    const noise = Math.sqrt(sumRes2 / softs.length) + 1e-6;
    const snr = Math.abs(scale) / noise;
    const quality = Math.max(0, Math.min(1, snr / 3));
    calib.push({ scale, noise, quality, snr });
  }
  return calib;
}

function hardBitsAndConfidenceFromSoft(soft, calib) {
  const bits = new Uint8Array(CALL_V2_CHANNEL_COUNT);
  const conf = new Float32Array(CALL_V2_CHANNEL_COUNT);
  const softAligned = new Float32Array(CALL_V2_CHANNEL_COUNT);
  for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
    const c = calib[p];
    // scale sign maps softBit polarity -> logical bit (self-referencing decode, §39)
    const normalized = (c.scale >= 0 ? soft[p] : -soft[p]) / c.noise;
    softAligned[p] = normalized * (0.2 + 0.8 * c.quality);
    bits[p] = softAligned[p] > 0 ? 1 : 0;
    conf[p] = Math.max(0, Math.min(1, Math.abs(normalized) * c.quality / 3));
  }
  return { bits, conf, softAligned };
}

function sixBitsToValue(bits) {
  let v = 0;
  for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) v |= bits[p] << (CALL_V2_CHANNEL_COUNT - 1 - p);
  return v;
}

// ---------------------------------------------------------------------------
// Full frame decode at a candidate feature start index
// ---------------------------------------------------------------------------

export function decodeCallV2FrameAt(featureItems, start, opts = {}) {
  const threshold = opts.threshold ?? CALL_V2_PREAMBLE_CORRELATION_MIN;

  let pre;
  let featuresPerHalf;
  let speedId;
  if (opts.speedHint) {
    featuresPerHalf = opts.speedHint.featuresPerHalf;
    speedId = opts.speedHint.id;
    pre = scoreCallV2PreambleAt(featureItems, start, featuresPerHalf);
  } else {
    const best = bestCallV2SpeedAt(featureItems, start);
    pre = best;
    featuresPerHalf = best?.speed?.featuresPerHalf;
    speedId = best?.speed?.id;
  }
  if (!pre || pre.score < threshold) {
    return { ok: false, reason: 'preamble', preambleScore: pre ? pre.score : -1 };
  }

  const calib = calibrateCallV2Preamble(pre.softs);
  const symbolFeatures = featuresPerHalf * 2;
  const headerStart = start + CALL_V2_PREAMBLE.length * symbolFeatures;

  const headerSymbolValues = [];
  const headerBitConfidences = [];
  for (let h = 0; h < CALL_V2_HEADER_SYMBOLS; h++) {
    const idx = headerStart + h * symbolFeatures;
    if (idx + symbolFeatures > featureItems.length) {
      return { ok: false, reason: 'incomplete-header', preambleScore: pre.score, speedId };
    }
    const { soft } = softBitsForSymbol(featureItems, idx, featuresPerHalf);
    const { bits, conf } = hardBitsAndConfidenceFromSoft(soft, calib);
    headerSymbolValues.push(sixBitsToValue(bits));
    headerBitConfidences.push(conf);
  }

  // 4 six-bit symbols -> 24 bits -> 3 header-byte candidates -> majority vote.
  const headerBits24 = new Uint8Array(24);
  for (let s = 0; s < CALL_V2_HEADER_SYMBOLS; s++) {
    for (let b = 0; b < CALL_V2_CHANNEL_COUNT; b++) {
      headerBits24[s * CALL_V2_CHANNEL_COUNT + b] = (headerSymbolValues[s] >> (CALL_V2_CHANNEL_COUNT - 1 - b)) & 1;
    }
  }
  const headerCandidates = [0, 1, 2].map((byteIdx) => {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | headerBits24[byteIdx * 8 + b];
    return v;
  });

  const { byte: majorityHeader } = majorityVoteHeaderByte(headerCandidates);
  const headerCheck = parseHeaderV2(majorityHeader);
  if (!headerCheck.ok) {
    return { ok: false, reason: 'header', error: headerCheck.error, preambleScore: pre.score, speedId };
  }

  const layout = computeFrameLayoutV2(headerCheck.length);
  const payloadSymbolCount = Math.ceil(layout.codewordBits / CALL_V2_CHANNEL_COUNT);
  const payloadStart = headerStart + CALL_V2_HEADER_SYMBOLS * symbolFeatures;
  const frameFeatureLength =
    (CALL_V2_PREAMBLE.length + CALL_V2_HEADER_SYMBOLS + payloadSymbolCount) * symbolFeatures;
  if (payloadStart + payloadSymbolCount * symbolFeatures > featureItems.length) {
    return {
      ok: false,
      reason: 'incomplete-data',
      preambleScore: pre.score,
      speedId,
      layout,
      frameFeatureLength,
    };
  }

  const bitConfidences = new Float32Array(payloadSymbolCount * CALL_V2_CHANNEL_COUNT);
  const whitenedBits = new Uint8Array(payloadSymbolCount * CALL_V2_CHANNEL_COUNT);
  const softAlignedBits = new Float32Array(payloadSymbolCount * CALL_V2_CHANNEL_COUNT);
  for (let s = 0; s < payloadSymbolCount; s++) {
    const idx = payloadStart + s * symbolFeatures;
    const { soft } = softBitsForSymbol(featureItems, idx, featuresPerHalf);
    const { bits, conf, softAligned } = hardBitsAndConfidenceFromSoft(soft, calib);
    for (let b = 0; b < CALL_V2_CHANNEL_COUNT; b++) {
      whitenedBits[s * CALL_V2_CHANNEL_COUNT + b] = bits[b];
      bitConfidences[s * CALL_V2_CHANNEL_COUNT + b] = conf[b];
      softAlignedBits[s * CALL_V2_CHANNEL_COUNT + b] = softAligned[b];
    }
  }
  const usableBits = whitenedBits.subarray(0, layout.codewordBits);
  const usableSoft = softAlignedBits.subarray(0, layout.codewordBits);

  // §41: aggregate per-bit confidence into per-RS-byte confidence, then
  // try ranked erasure budgets. Absolute-threshold erasures alone rarely
  // fire at these SNRs; ranking the weakest bytes and spending up to the
  // full parity budget (trying small budgets first so we leave headroom
  // for unknown errors) is what makes reference-aware / soft-confidence
  // decode actually land CRC-valid frames.
  const byteConfidences = new Array(layout.codewordBytes);
  for (let byteIdx = 0; byteIdx < layout.codewordBytes; byteIdx++) {
    let sum = 0;
    let n = 0;
    for (let b = 0; b < 8; b++) {
      const bitIdx = byteIdx * 8 + b;
      if (bitIdx < bitConfidences.length) {
        sum += bitConfidences[bitIdx];
        n++;
      }
    }
    byteConfidences[byteIdx] = n > 0 ? sum / n : 0;
  }
  const rankedWeakest = byteConfidences
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c - b.c);

  let decoded = null;
  let erasureBytePositions = [];
  // Prefer threshold-only first (cheap), then escalating ranked budgets.
  const budgets = [0];
  const thresholdErasures = rankedWeakest
    .filter((e) => e.c < CALL_V2_BYTE_ERASURE_CONFIDENCE_THRESHOLD)
    .map((e) => e.i);
  if (thresholdErasures.length) budgets.push(-1); // sentinel: use threshold set
  for (let n = 1; n <= layout.parityBytes; n++) budgets.push(n);

  for (const budget of budgets) {
    const erasures =
      budget === -1
        ? thresholdErasures
        : budget === 0
          ? []
          : rankedWeakest.slice(0, budget).map((e) => e.i);
    const attempt = decodeFrameV2(headerCandidates, usableBits, {
      erasureBytePositions: erasures,
    });
    if (attempt.ok) {
      decoded = attempt;
      erasureBytePositions = erasures;
      break;
    }
    if (!decoded) decoded = attempt; // keep last failure for diagnostics
  }
  const avgChannelQuality = calib.reduce((a, c) => a + c.quality, 0) / CALL_V2_CHANNEL_COUNT;

  return {
    ok: decoded.ok,
    message: decoded.message,
    error: decoded.error,
    crcValid: decoded.ok,
    correctionCount: decoded.rsErrorCount || 0,
    erasureCount: decoded.rsErasureCount ?? erasureBytePositions.length,
    preambleScore: pre.score,
    avgQuality: avgChannelQuality,
    channelQuality: calib.map((c) => c.quality),
    speedId,
    symbolMs: featuresPerHalf * 2 * CALL_V2_FEATURE_MS,
    featuresPerHalf,
    frameFeatureLength,
    layout,
    headerCandidates,
    whitenedBitsSoft: usableBits,
    softAligned: usableSoft,
    byteConfidences,
    decoded,
  };
}

// ---------------------------------------------------------------------------
// Multi-frame combining (§45): soft-sum aligned frames, then hard-decide.
// ---------------------------------------------------------------------------

/**
 * Soft-combine N frames of polarity-aligned soft bits (same length), then
 * hard-decide. Optional per-frame weights. Returns hard 0/1 bits.
 */
export function combineCallV2SoftBitFrames(frames) {
  if (!frames.length) return null;
  const len = frames[0].soft.length;
  const sum = new Float32Array(len);
  const confSum = new Float32Array(len);
  for (const f of frames) {
    const w = f.weight ?? 1;
    for (let i = 0; i < len; i++) {
      sum[i] += f.soft[i] * w;
      confSum[i] += (f.conf ? f.conf[i] : Math.abs(f.soft[i])) * w;
    }
  }
  const hard = new Uint8Array(len);
  for (let i = 0; i < len; i++) hard[i] = sum[i] > 0 ? 1 : 0;
  return { hard, confSum, softSum: sum };
}

/** @deprecated Prefer combineCallV2SoftBitFrames — kept for hard-bit majority vote fallback. */
export function combineCallV2HardBitFrames(frames) {
  if (!frames.length) return null;
  const len = frames[0].bits.length;
  const combined = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const f of frames) {
      const w = f.weights ? f.weights[i] ?? 1 : 1;
      sum += (f.bits[i] ? 1 : -1) * w;
    }
    combined[i] = sum >= 0 ? 1 : 0;
  }
  return combined;
}

// ---------------------------------------------------------------------------
// Stateful searcher: SEARCH -> CANDIDATE -> TRACK -> CONFIRMED (§42-44)
// ---------------------------------------------------------------------------

export const CallV2SyncState = Object.freeze({
  SEARCH: 'SEARCH',
  CANDIDATE: 'CANDIDATE',
  TRACK: 'TRACK',
  CONFIRMED: 'CONFIRMED',
});

export class CallV2FrameSearcher {
  constructor(options = {}) {
    this.threshold = options.threshold ?? CALL_V2_PREAMBLE_CORRELATION_MIN;
    this.onMessage = options.onMessage || null;
    this.state = CallV2SyncState.SEARCH;
    this.lastAcceptTimes = new Map();
    this.searchedUntil = 0;
    this._scoreCache = new Map();
    this.pendingFrames = []; // for soft/hard combining, keyed implicitly by matching header/length
    this.stats = this._emptyStats();
    this.lastChannelQuality = new Float32Array(CALL_V2_CHANNEL_COUNT);
  }

  _emptyStats() {
    return {
      framesDetected: 0,
      framesCrcValid: 0,
      framesCrcFailed: 0,
      bestPreambleScore: 0,
      lastMessage: null,
      rsCorrections: 0,
      rsErasures: 0,
      combinedAttempts: 0,
      state: CallV2SyncState.SEARCH,
    };
  }

  resetStats() {
    this.stats = this._emptyStats();
    this.state = CallV2SyncState.SEARCH;
    this.lastAcceptTimes.clear();
    this.searchedUntil = 0;
    this._scoreCache.clear();
    this.pendingFrames = [];
  }

  _bestAt(featureItems, start) {
    let s = this._scoreCache.get(start);
    if (s == null) {
      s = bestCallV2SpeedAt(featureItems, start);
      this._scoreCache.set(start, s);
    }
    return s;
  }

  process(featureItems) {
    const maxStart = featureItems.length - CALL_V2_PREAMBLE_LOOKAHEAD_FEATURES;
    if (maxStart < 0) return null;

    let bestResult = null;
    const from = Math.max(1, this.searchedUntil - CALL_V2_PREAMBLE_LOOKAHEAD_FEATURES);
    let advanceLimit = maxStart + 1;

    for (let start = from; start <= maxStart; start++) {
      const best = this._bestAt(featureItems, start);
      if (!best) continue;
      if (best.score > this.stats.bestPreambleScore) this.stats.bestPreambleScore = best.score;
      if (best.score < this.threshold) continue;

      const left = this._bestAt(featureItems, start - 1);
      const right = start + 1 <= maxStart ? this._bestAt(featureItems, start + 1) : null;
      if (left && best.score < left.score) continue;
      if (right && best.score < right.score) continue;

      this.state = CallV2SyncState.CANDIDATE;
      this.stats.framesDetected++;
      const result = decodeCallV2FrameAt(featureItems, start, {
        threshold: this.threshold,
        speedHint: best.speed,
      });

      if (result.channelQuality) {
        for (let i = 0; i < CALL_V2_CHANNEL_COUNT; i++) this.lastChannelQuality[i] = result.channelQuality[i];
      }

      if (result.reason === 'incomplete-data' || result.reason === 'incomplete-header') {
        advanceLimit = Math.min(advanceLimit, start);
        continue;
      }

      if (result.ok) {
        this.stats.framesCrcValid++;
        this.stats.rsCorrections += result.correctionCount || 0;
        this.stats.rsErasures += result.erasureCount || 0;
        const accepted = this._acceptMessage(result.message, result);
        if (accepted) {
          bestResult = accepted;
          this.state = CallV2SyncState.CONFIRMED;
          const frameLen = result.frameFeatureLength || CALL_V2_PREAMBLE_LOOKAHEAD_FEATURES;
          this.searchedUntil = start + frameLen;
          start += frameLen - 1;
          continue;
        }
      } else {
        this.stats.framesCrcFailed++;
        if (result.whitenedBitsSoft && result.layout) {
          this._addPendingForCombine(result, start);
          const combined = this._tryCombine();
          if (combined && combined.ok) {
            this.stats.combinedAttempts++;
            this.stats.framesCrcValid++;
            const accepted = this._acceptMessage(combined.message, {
              ...combined,
              combinedRepetitions: combined.combinedRepetitions,
              avgQuality: result.avgQuality,
            });
            if (accepted) {
              bestResult = accepted;
              this.state = CallV2SyncState.CONFIRMED;
            }
          }
        }
      }
    }
    this.searchedUntil = Math.max(this.searchedUntil, advanceLimit);
    this.stats.state = this.state;
    return bestResult;
  }

  _addPendingForCombine(result, start) {
    // Only combine frames that agree on message length (§45: never combine
    // frames belonging to different length/header/timing sequences).
    const key = `${result.layout.messageLength}`;
    const entry = {
      key,
      bits: result.whitenedBitsSoft,
      soft: result.softAligned,
      conf: result.byteConfidences
        ? null
        : null,
      bitConf: null,
      headerCandidates: result.headerCandidates,
      layout: result.layout,
      start,
      weight: Math.max(0.1, result.preambleScore) * Math.max(0.1, result.avgQuality || 0.5),
      score: result.preambleScore,
    };
    // Prefer replacing a near-duplicate start; otherwise append.
    const near = this.pendingFrames.findIndex(
      (p) => p.key === key && Math.abs(p.start - start) <= 4
    );
    if (near >= 0) {
      if (entry.score >= this.pendingFrames[near].score) this.pendingFrames[near] = entry;
    } else {
      this.pendingFrames.push(entry);
    }
    if (this.pendingFrames.length > 12) this.pendingFrames.shift();
  }

  _tryCombine() {
    const groups = new Map();
    for (const p of this.pendingFrames) {
      if (!groups.has(p.key)) groups.set(p.key, []);
      groups.get(p.key).push(p);
    }
    for (const [, frames] of groups) {
      if (frames.length < 2) continue;
      // Prefer chains spaced about one frame apart when frameFeatureLength known.
      const sorted = [...frames].sort((a, b) => a.start - b.start);
      for (let n = Math.min(CALL_V2_MAX_COMBINE_FRAMES, sorted.length); n >= 2; n--) {
        // Try the last n frames AND any n-frame chain with consistent spacing.
        const candidates = [sorted.slice(-n)];
        for (let i = 0; i + n <= sorted.length; i++) {
          candidates.push(sorted.slice(i, i + n));
        }
        for (const use of candidates) {
          if (!use[0].soft) continue;
          const combined = combineCallV2SoftBitFrames(
            use.map((f) => ({ soft: f.soft, weight: f.weight }))
          );
          if (!combined) continue;
          const headerBytes = [0, 1, 2].map((i) => {
            const votes = use.map((f) => f.headerCandidates[i]);
            return majorityVoteHeaderByte(votes).byte;
          });
          // Ranked erasure budgets on combined soft magnitude.
          const nBytes = Math.ceil(combined.hard.length / 8);
          const byteConf = new Array(nBytes);
          for (let b = 0; b < nBytes; b++) {
            let s = 0;
            let c = 0;
            for (let i = 0; i < 8; i++) {
              const idx = b * 8 + i;
              if (idx < combined.confSum.length) {
                s += combined.confSum[idx];
                c++;
              }
            }
            byteConf[b] = c ? s / c : 0;
          }
          const ranked = byteConf
            .map((c, i) => ({ c, i }))
            .sort((a, b) => a.c - b.c);
          const parity = use[0].layout.parityBytes;
          for (let nErase = 0; nErase <= parity; nErase++) {
            const erasures = ranked.slice(0, nErase).map((e) => e.i);
            const decoded = decodeFrameV2(headerBytes, combined.hard, {
              erasureBytePositions: erasures,
            });
            if (decoded.ok) {
              return { ...decoded, combinedRepetitions: use.length };
            }
          }
        }
      }
    }
    return null;
  }

  _acceptMessage(message, meta) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prev = this.lastAcceptTimes.get(message);
    const duplicate = prev != null && now - prev < CALL_V2_DUPLICATE_SUPPRESS_MS;
    this.lastAcceptTimes.set(message, now);
    this.stats.lastMessage = message;
    const payload = { message, duplicate, ...meta };
    if (this.onMessage) this.onMessage(payload);
    return payload;
  }
}

/**
 * Apply reference-ratio subtraction in-place style (returns new feature list).
 * Kept here to avoid a circular import with call-v2-reference.js.
 */
export function applyReferenceCorrection(receivedFeatures, refFeatures, refPhase = 0) {
  if (!refFeatures?.length) return receivedFeatures;
  const nRef = refFeatures.length;
  return receivedFeatures.map((f, i) => {
    const r = refFeatures[(refPhase + i) % nRef];
    const ratios = new Float32Array(CALL_V2_CHANNEL_COUNT);
    for (let p = 0; p < CALL_V2_CHANNEL_COUNT; p++) {
      ratios[p] = f.ratios[p] - (r ? r.ratios[p] : 0);
    }
    return { sampleIndex: f.sampleIndex, timestamp: f.timestamp, ratios };
  });
}

/**
 * Coarse phase lock against a known unwatermarked reference feature stream.
 * Scores candidate phases by best preamble correlation over a few starts.
 */
export function findBestReferencePhase(receivedFeatures, refFeatures, opts = {}) {
  if (!refFeatures?.length || !receivedFeatures?.length) {
    return { phase: 0, score: -Infinity, start: 0 };
  }
  const step = opts.step ?? 2;
  const maxPhase = Math.min(refFeatures.length, opts.maxPhase ?? refFeatures.length);
  const searchStarts =
    opts.searchStarts ??
    (() => {
      const out = [];
      const limit = Math.min(receivedFeatures.length - CALL_V2_PREAMBLE_LOOKAHEAD_FEATURES, 240);
      for (let s = 0; s <= Math.max(0, limit); s += 8) out.push(s);
      return out.length ? out : [0];
    })();
  let best = { phase: 0, score: -Infinity, start: 0 };
  for (const start of searchStarts) {
    for (let phase = 0; phase < maxPhase; phase += step) {
      const corrected = applyReferenceCorrection(receivedFeatures, refFeatures, phase);
      const scored = bestCallV2SpeedAt(corrected, start);
      if (scored && scored.score > best.score) {
        best = { phase, score: scored.score, start };
      }
    }
  }
  return best;
}

export function decodeCallV2PcmBuffer(samples, sampleRate, options = {}) {
  const extractor = new CallV2FeatureExtractor(sampleRate, options.Q);
  extractor.processBuffer(samples);
  let features = extractor.features;
  let referencePhase = options.referencePhase ?? null;

  // Optional reference-aware path (§46): subtract known unwatermarked
  // Meditation spectral motion before search. Blind decode leaves
  // referenceFeatures unset.
  if (options.referenceFeatures?.length) {
    if (referencePhase == null || options.searchReferencePhase) {
      const found = findBestReferencePhase(features, options.referenceFeatures, {
        step: options.referencePhaseStep ?? 2,
        maxPhase: options.referenceMaxPhase,
      });
      referencePhase = found.phase;
    }
    features = applyReferenceCorrection(features, options.referenceFeatures, referencePhase);
  }

  const searcher = new CallV2FrameSearcher({
    threshold: options.threshold ?? CALL_V2_PREAMBLE_CORRELATION_MIN,
  });
  const result = searcher.process(features);
  return {
    result,
    stats: searcher.stats,
    featureCount: features.length,
    features,
    referencePhase,
  };
}

export function callV2SignalQualityLabel(meta) {
  if (!meta) return 'Poor';
  const score = meta.preambleScore || 0;
  const q = meta.avgQuality || 0;
  let points = 0;
  if (score > 0.6) points += 3;
  else if (score > 0.4) points += 2;
  else if (score > 0.3) points += 1;
  if (q > 0.6) points += 2;
  else if (q > 0.3) points += 1;
  if (points >= 5) return 'Strong';
  if (points >= 3) return 'Good';
  if (points >= 1) return 'Fair';
  return 'Poor';
}
