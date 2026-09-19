/**
 * call-v1 sync: SEARCH → CANDIDATE → TRACK → CONFIRMED
 * Preamble search on ~20 ms feature grid; CRC required before display.
 */

import {
  decodeFromCallBits,
  TOTAL_BITS,
  CALL_CHANNEL_COUNT,
} from '../protocol.js';
import {
  CALL_PREAMBLE,
  CALL_PREAMBLE_SYMBOLS,
  CALL_DATA_SYMBOLS,
  CALL_CHIP_CODE,
  CHIPS_PER_SYMBOL,
  FEATURES_PER_CHIP,
  FEATURES_PER_SYMBOL,
  CALL_PREAMBLE_CORRELATION_MIN,
  CALL_TRACK_WINDOW_MS,
  CALL_MISSED_FRAMES_TO_SEARCH,
  CALL_DUPLICATE_SUPPRESS_MS,
  FEATURE_MS,
  EPSILON_ENERGY,
} from './call-constants.js';
import {
  CallSoftCombiner,
  CALL_FRAME_FEATURES,
  mergeBaseEnhancementSoft,
} from './call-combiner.js';

export const SyncState = Object.freeze({
  SEARCH: 'SEARCH',
  CANDIDATE: 'CANDIDATE',
  TRACK: 'TRACK',
  CONFIRMED: 'CONFIRMED',
});

function preambleExpectedBits() {
  const rows = [];
  for (let s = 0; s < CALL_PREAMBLE_SYMBOLS; s++) {
    const sym = CALL_PREAMBLE[s];
    const bits = new Int8Array(CALL_CHANNEL_COUNT);
    for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
      bits[ch] = (sym >> (CALL_CHANNEL_COUNT - 1 - ch)) & 1 ? 1 : -1;
    }
    rows.push(bits);
  }
  return rows;
}

const PREAMBLE_SIGNS = preambleExpectedBits();

/**
 * Average chip differential ratios for one symbol starting at feature index.
 * Uses middle samples of each 40 ms chip (skip crossfade edges).
 */
export function chipDiffsFromFeatures(featureItems, start, useEnhancement = false) {
  const chips = [];
  for (let c = 0; c < CHIPS_PER_SYMBOL; c++) {
    const diffs = new Float32Array(CALL_CHANNEL_COUNT);
    let weightSum = 0;
    for (let f = 0; f < FEATURES_PER_CHIP; f++) {
      const idx = start + c * FEATURES_PER_CHIP + f;
      if (idx >= featureItems.length) break;
      const feat = featureItems[idx];
      if (!feat) continue;
      const ratios = useEnhancement ? feat.enhRatios : feat.ratios;
      if (!ratios) continue;
      // Prefer late chip samples (past ~10 ms raised-cosine), keep early lightly.
      const w = f === FEATURES_PER_CHIP - 1 ? 1.0 : 0.35;
      for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
        diffs[ch] += ratios[ch] * w;
      }
      weightSum += w;
    }
    if (weightSum > 0) {
      for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) diffs[ch] /= weightSum;
    }
    chips.push(diffs);
  }
  return chips;
}

/**
 * Despread one channel across chips: softBit = Σ(obsDiff[c] * code[c])
 */
export function despreadChannel(chipDiffs, channel, bias = 0) {
  let soft = 0;
  for (let c = 0; c < CHIPS_PER_SYMBOL; c++) {
    soft += (chipDiffs[c][channel] - bias) * CALL_CHIP_CODE[c];
  }
  return soft;
}

export function scoreCallPreamble(featureItems, start, useEnhancement = false) {
  const needed = CALL_PREAMBLE_SYMBOLS * FEATURES_PER_SYMBOL;
  if (start + needed > featureItems.length) {
    return { score: -1, channelMeans: null, symbolSoft: null };
  }

  const symbolSoft = [];
  const means = new Float32Array(CALL_CHANNEL_COUNT);

  for (let s = 0; s < CALL_PREAMBLE_SYMBOLS; s++) {
    const chips = chipDiffsFromFeatures(
      featureItems,
      start + s * FEATURES_PER_SYMBOL,
      useEnhancement
    );
    // per-chip mean bias approx from chip averages
    const soft = new Float32Array(CALL_CHANNEL_COUNT);
    for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
      let bias = 0;
      for (let c = 0; c < CHIPS_PER_SYMBOL; c++) bias += chips[c][ch];
      bias /= CHIPS_PER_SYMBOL;
      soft[ch] = despreadChannel(chips, ch, bias);
      means[ch] += soft[ch];
    }
    symbolSoft.push(soft);
  }
  for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
    means[ch] /= CALL_PREAMBLE_SYMBOLS;
  }

  let num = 0;
  let denObs = 0;
  let denExp = 0;
  for (let s = 0; s < CALL_PREAMBLE_SYMBOLS; s++) {
    for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
      const obs = symbolSoft[s][ch] - means[ch];
      const exp = PREAMBLE_SIGNS[s][ch];
      num += obs * exp;
      denObs += obs * obs;
      denExp += exp * exp;
    }
  }
  const score = num / (Math.sqrt(denObs * denExp) + 1e-12);
  return { score, channelMeans: means, symbolSoft };
}

export function calibrateCallPreamble(symbolSoft, means) {
  const calib = [];
  for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
    const bias = means[ch];
    let sumScale = 0;
    let sumRes2 = 0;
    for (let s = 0; s < CALL_PREAMBLE_SYMBOLS; s++) {
      const obs = symbolSoft[s][ch] - bias;
      sumScale += obs * PREAMBLE_SIGNS[s][ch];
    }
    const scale = sumScale / CALL_PREAMBLE_SYMBOLS;
    for (let s = 0; s < CALL_PREAMBLE_SYMBOLS; s++) {
      const obs = symbolSoft[s][ch] - bias;
      const pred = scale * PREAMBLE_SIGNS[s][ch];
      const res = obs - pred;
      sumRes2 += res * res;
    }
    const noise = Math.sqrt(sumRes2 / CALL_PREAMBLE_SYMBOLS) + 1e-6;
    const snr = Math.abs(scale) / noise;
    const quality = Math.max(0, Math.min(1, snr / 3));
    calib.push({ bias, scale, noise, quality, snr });
  }
  return calib;
}

/**
 * Extract soft scrambled bits (272) from a frame at feature start.
 */
export function extractCallSoftBits(featureItems, start, calib, useEnhancement = false) {
  const soft = new Float32Array(TOTAL_BITS);
  const dataStart = start + CALL_PREAMBLE_SYMBOLS * FEATURES_PER_SYMBOL;

  for (let s = 0; s < CALL_DATA_SYMBOLS; s++) {
    const chips = chipDiffsFromFeatures(
      featureItems,
      dataStart + s * FEATURES_PER_SYMBOL,
      useEnhancement
    );
    for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
      const c = calib[ch];
      // chip-level bias ≈ mean of chip ratios for this symbol
      let chipBias = 0;
      for (let k = 0; k < CHIPS_PER_SYMBOL; k++) chipBias += chips[k][ch];
      chipBias /= CHIPS_PER_SYMBOL;

      let softBit = despreadChannel(chips, ch, chipBias);
      // map using preamble scale polarity
      if (c.scale < 0) softBit = -softBit;
      softBit = softBit / c.noise;
      softBit *= 0.35 + 0.65 * c.quality;

      const bitIndex = s * CALL_CHANNEL_COUNT + ch;
      if (bitIndex < TOTAL_BITS) soft[bitIndex] = softBit;
    }
  }
  return soft;
}

export function decodeCallFrameAt(featureItems, start, opts = {}) {
  const threshold = opts.threshold ?? CALL_PREAMBLE_CORRELATION_MIN;
  const basePre = scoreCallPreamble(featureItems, start, false);
  if (basePre.score < threshold) {
    return { ok: false, reason: 'preamble', preambleScore: basePre.score };
  }

  const baseCalib = calibrateCallPreamble(basePre.symbolSoft, basePre.channelMeans);
  const baseSoft = extractCallSoftBits(featureItems, start, baseCalib, false);
  const avgQuality =
    baseCalib.reduce((a, c) => a + c.quality, 0) / CALL_CHANNEL_COUNT;

  // Prefer base-only: enhancement must never be required, and noisy HF
  // energy must not poison a CRC-valid base decode.
  const baseDecoded = decodeFromCallBits(baseSoft, { soft: true });
  if (baseDecoded.ok && baseDecoded.crcValid === true) {
    return {
      ok: true,
      message: baseDecoded.message,
      error: baseDecoded.error,
      crcValid: true,
      correctionCount: baseDecoded.correctionCount || 0,
      preambleScore: basePre.score,
      calibration: baseCalib,
      softScrambled: baseSoft,
      avgQuality,
      enhancementWeight: 0,
      channelQuality: baseCalib.map((c) => c.quality),
      enhChannelQuality: new Array(CALL_CHANNEL_COUNT).fill(0),
      decoded: baseDecoded,
    };
  }

  let enhSoft = null;
  let enhancementWeight = 0;
  let enhChannelQuality = new Array(CALL_CHANNEL_COUNT).fill(0);
  if (opts.useEnhancement !== false) {
    const enhPre = scoreCallPreamble(featureItems, start, true);
    // Gate harshly: random ambient in HF bands can score >0.15.
    if (enhPre.score > 0.35 && enhPre.score > basePre.score * 0.55) {
      const enhCalib = calibrateCallPreamble(enhPre.symbolSoft, enhPre.channelMeans);
      enhChannelQuality = enhCalib.map((c) => c.quality);
      const avgQ =
        enhCalib.reduce((a, c) => a + c.quality, 0) / CALL_CHANNEL_COUNT;
      enhancementWeight = Math.max(0, Math.min(0.55, avgQ * 0.7));
      if (enhancementWeight > 0.12) {
        enhSoft = extractCallSoftBits(featureItems, start, enhCalib, true);
      } else {
        enhancementWeight = 0;
      }
    }
  }

  const softScrambled =
    enhancementWeight > 0
      ? mergeBaseEnhancementSoft(baseSoft, enhSoft, enhancementWeight)
      : baseSoft;
  const decoded =
    enhancementWeight > 0
      ? decodeFromCallBits(softScrambled, { soft: true })
      : baseDecoded;

  return {
    ok: decoded.ok,
    message: decoded.message,
    error: decoded.error,
    crcValid: decoded.crcValid === true,
    correctionCount: decoded.correctionCount || 0,
    preambleScore: basePre.score,
    calibration: baseCalib,
    softScrambled,
    avgQuality,
    enhancementWeight,
    channelQuality: baseCalib.map((c) => c.quality),
    enhChannelQuality,
    decoded,
  };
}

/**
 * Stateful call-v1 frame searcher with SEARCH/TRACK/CONFIRMED.
 */
export class CallFrameSearcher {
  constructor(options = {}) {
    this.threshold = options.threshold ?? CALL_PREAMBLE_CORRELATION_MIN;
    this.state = SyncState.SEARCH;
    this.trackStart = null;
    this.missedFrames = 0;
    this.combiner = new CallSoftCombiner();
    this.lastAcceptTimes = new Map();
    this.searchedUntil = 0;
    this._scoreCache = new Map();
    this.onMessage = options.onMessage || null;
    this.stats = this._emptyStats();
    this.lastChannelQuality = new Float32Array(CALL_CHANNEL_COUNT);
    this.lastEnhQuality = new Float32Array(CALL_CHANNEL_COUNT);
  }

  _emptyStats() {
    return {
      framesDetected: 0,
      framesCrcValid: 0,
      framesCrcFailed: 0,
      bestPreambleScore: 0,
      lastMessage: null,
      lastHammingCorrections: 0,
      combinedAttempts: 0,
      state: SyncState.SEARCH,
    };
  }

  resetStats() {
    this.stats = this._emptyStats();
    this.state = SyncState.SEARCH;
    this.trackStart = null;
    this.missedFrames = 0;
    this.combiner.clear();
    this.lastAcceptTimes.clear();
    this.searchedUntil = 0;
    this._scoreCache.clear();
  }

  _scoreAt(featureItems, start) {
    let s = this._scoreCache.get(start);
    if (s == null) {
      s = scoreCallPreamble(featureItems, start, false).score;
      this._scoreCache.set(start, s);
    }
    return s;
  }

  process(featureItems) {
    const maxStart = featureItems.length - CALL_FRAME_FEATURES;
    if (maxStart < 0) return null;

    let bestResult = null;
    const trackHalf = Math.round(CALL_TRACK_WINDOW_MS / FEATURE_MS);

    if (this.state === SyncState.TRACK || this.state === SyncState.CONFIRMED) {
      const center = this.trackStart;
      const to = center + trackHalf;
      // Live mic input arrives one ~20 ms feature at a time (see
      // CallReceiver._onWorkletMessage), so process() is invoked far more
      // often than once per ~18.56 s frame. Only re-evaluate once the
      // buffer has actually reached the expected next-frame window —
      // otherwise every tick before that point re-scans a truncated/empty
      // window, sees no peak, and burns the missed-frame budget within a
      // couple of ticks. That falsely bounces CONFIRMED → SEARCH → (re-find
      // the *same* already-decoded audio still sitting in the buffer) →
      // CONFIRMED, over and over, which is exactly the "detects
      // immediately, then failed-frame count climbs" symptom seen live
      // (the offline decodeCallFeatureBuffer() batch path used by the
      // automated test suite never calls process() incrementally like
      // this, so this bug is invisible to run-call-tests.mjs).
      if (maxStart < to) {
        this.stats.state = this.state;
        return null;
      }
      const from = Math.max(0, center - trackHalf);
      let localBest = -1;
      let localStart = center;
      for (let start = from; start <= to; start++) {
        const score = this._scoreAt(featureItems, start);
        if (score > localBest) {
          localBest = score;
          localStart = start;
        }
      }
      if (localBest >= this.threshold * 0.85) {
        this.state = SyncState.CANDIDATE;
        bestResult = this._tryDecode(featureItems, localStart);
        if (bestResult && bestResult.ok) {
          this.missedFrames = 0;
          this.trackStart = localStart + CALL_FRAME_FEATURES;
          this.state = SyncState.CONFIRMED;
        } else {
          this.missedFrames++;
          this.trackStart = localStart + CALL_FRAME_FEATURES;
          this.state =
            this.missedFrames >= CALL_MISSED_FRAMES_TO_SEARCH
              ? SyncState.SEARCH
              : SyncState.TRACK;
        }
      } else {
        this.missedFrames++;
        this.trackStart = (this.trackStart || 0) + CALL_FRAME_FEATURES;
        if (this.missedFrames >= CALL_MISSED_FRAMES_TO_SEARCH) {
          this.state = SyncState.SEARCH;
          this.trackStart = null;
        }
      }
      this.stats.state = this.state;
      this.searchedUntil = Math.max(this.searchedUntil, to + 1);
      return bestResult;
    }

    // SEARCH — allow start=0; treat missing neighbors as -Infinity for peak pick
    const from = Math.max(0, this.searchedUntil - CALL_FRAME_FEATURES);
    for (let start = from; start <= maxStart; start++) {
      const score = this._scoreAt(featureItems, start);
      if (score > this.stats.bestPreambleScore) {
        this.stats.bestPreambleScore = score;
      }
      if (score < this.threshold) continue;

      const left =
        start > 0 ? this._scoreAt(featureItems, start - 1) : -Infinity;
      const right =
        start + 1 <= maxStart
          ? this._scoreAt(featureItems, start + 1)
          : -Infinity;
      if (score < left || score < right) continue;

      this.state = SyncState.CANDIDATE;
      const result = this._tryDecode(featureItems, start);
      if (result && result.ok) {
        this.trackStart = start + CALL_FRAME_FEATURES;
        this.missedFrames = 0;
        this.state = SyncState.CONFIRMED;
        bestResult = result;
        this.searchedUntil = start + CALL_FRAME_FEATURES;
        start += CALL_FRAME_FEATURES - 1;
      } else if (score >= this.threshold) {
        this.trackStart = start + CALL_FRAME_FEATURES;
        this.state = SyncState.TRACK;
        this.missedFrames = 0;
      }
    }
    this.searchedUntil = Math.max(this.searchedUntil, maxStart + 1);
    this.stats.state = this.state;
    return bestResult;
  }

  _tryDecode(featureItems, start) {
    this.stats.framesDetected++;
    const result = decodeCallFrameAt(featureItems, start, {
      threshold: this.threshold * 0.9,
      useEnhancement: true,
    });

    if (result.channelQuality) {
      for (let i = 0; i < CALL_CHANNEL_COUNT; i++) {
        this.lastChannelQuality[i] = result.channelQuality[i];
      }
    }
    if (result.enhChannelQuality) {
      for (let i = 0; i < CALL_CHANNEL_COUNT; i++) {
        this.lastEnhQuality[i] = result.enhChannelQuality[i];
      }
    }

    if (result.ok && result.crcValid) {
      this.stats.framesCrcValid++;
      this.stats.lastHammingCorrections = result.correctionCount;
      return this._acceptMessage(result.message, result);
    }

    this.stats.framesCrcFailed++;
    if (result.softScrambled) {
      this.combiner.add({
        soft: result.softScrambled,
        weight:
          Math.max(0.1, result.preambleScore) *
          Math.max(0.1, result.avgQuality || 0.5),
        start,
        score: result.preambleScore,
        t: featureItems[start]?.timestamp || 0,
      });
      const combined = this.combiner.tryCombine();
      if (combined && combined.ok) {
        this.stats.combinedAttempts++;
        this.stats.framesCrcValid++;
        return this._acceptMessage(combined.message, {
          ...combined,
          preambleScore: result.preambleScore,
          avgQuality: result.avgQuality,
          enhancementWeight: result.enhancementWeight,
        });
      }
    }
    return result;
  }

  _acceptMessage(message, meta) {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prev = this.lastAcceptTimes.get(message);
    const duplicate = prev != null && now - prev < CALL_DUPLICATE_SUPPRESS_MS;
    this.lastAcceptTimes.set(message, now);
    this.stats.lastMessage = message;
    const payload = { message, duplicate, ...meta };
    if (this.onMessage) this.onMessage(payload);
    return payload;
  }
}

/**
 * Offline / batch-friendly search: collect all local preamble peaks, decode,
 * and soft-combine before committing to TRACK. Used by decodeCallPcmBuffer.
 */
export function decodeCallFeatureBuffer(featureItems, options = {}) {
  const threshold = options.threshold ?? CALL_PREAMBLE_CORRELATION_MIN;
  const searcher = new CallFrameSearcher({ threshold });
  // Drive SEARCH across the whole buffer in one shot
  const maxStart = featureItems.length - CALL_FRAME_FEATURES;
  if (maxStart < 0) {
    return { result: null, stats: searcher.stats };
  }

  const peaks = [];
  for (let start = 0; start <= maxStart; start++) {
    const score = searcher._scoreAt(featureItems, start);
    if (score > searcher.stats.bestPreambleScore) {
      searcher.stats.bestPreambleScore = score;
    }
    if (score < threshold) continue;
    const left = start > 0 ? searcher._scoreAt(featureItems, start - 1) : -Infinity;
    const right =
      start + 1 <= maxStart ? searcher._scoreAt(featureItems, start + 1) : -Infinity;
    if (score < left || score < right) continue;
    peaks.push({ start, score });
  }

  // Prefer peaks spaced about one frame apart (true repetitions)
  peaks.sort((a, b) => b.score - a.score);
  let bestResult = null;
  const bestScore = peaks.length ? peaks[0].score : 0;
  // Ignore weak sidelobes — they inflate CRC-fail counters without helping.
  const strongPeaks = peaks.filter((p) => p.score >= bestScore * 0.9).slice(0, 8);

  for (const peak of strongPeaks) {
    const result = searcher._tryDecode(featureItems, peak.start);
    if (result && result.ok) {
      bestResult = result;
      searcher.state = SyncState.CONFIRMED;
      searcher.stats.state = SyncState.CONFIRMED;
      // keep scanning a few more for stats / confirm
      if (searcher.stats.framesCrcValid >= 2) break;
    }
  }

  // Final combine attempt if still nothing
  if (!bestResult) {
    const combined = searcher.combiner.tryCombine();
    if (combined && combined.ok) {
      searcher.stats.combinedAttempts++;
      searcher.stats.framesCrcValid++;
      bestResult = searcher._acceptMessage(combined.message, {
        ...combined,
        combinedRepetitions: combined.combinedRepetitions,
      });
      searcher.state = SyncState.CONFIRMED;
      searcher.stats.state = SyncState.CONFIRMED;
    }
  }

  return { result: bestResult, stats: searcher.stats, searcher };
}
