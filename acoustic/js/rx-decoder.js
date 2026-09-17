/**
 * RX decoder: feature buffer, preamble search, soft decode, frame combining.
 * Used by live microphone path and synthetic DSP tests — same logic.
 */

import {
  CHANNEL_COUNT,
  WATERMARK_CHANNELS,
  BANDWIDTH_HZ,
  SYMBOL_MS,
  FEATURE_MS,
  FEATURES_PER_SYMBOL,
  PREAMBLE_SYMBOLS,
  DATA_SYMBOLS,
  FRAME_SYMBOLS,
  TOTAL_BITS,
  PREAMBLE_BYTES,
  PREAMBLE_CORRELATION_MIN,
  EPSILON_ENERGY,
  DUPLICATE_SUPPRESS_MS,
  FEATURE_BUFFER_SECONDS,
  decodeFromBits,
  softDescrambleDeinterleave,
  combineSoftFrames,
  symbolsFromBytes,
} from './protocol.js';
import {
  designBandpass,
  createBiquadState,
  processBiquad,
} from './watermark.js';

export function bandpassQ(centreHz, bandwidthHz = BANDWIDTH_HZ) {
  return centreHz / bandwidthHz;
}

/**
 * Offline / main-thread feature extractor mirroring the AudioWorklet.
 * Processes mono PCM and yields feature vectors every ~FEATURE_MS.
 */
export class FeatureExtractor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.filtersA = [];
    this.filtersB = [];
    this.statesA = [];
    this.statesB = [];
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const [lowHz, highHz] = WATERMARK_CHANNELS[ch];
      this.filtersA.push(designBandpass(lowHz, sampleRate));
      this.filtersA.push(designBandpass(highHz, sampleRate));
      this.filtersB.push(designBandpass(lowHz, sampleRate));
      this.filtersB.push(designBandpass(highHz, sampleRate));
      this.statesA.push(createBiquadState(), createBiquadState());
      this.statesB.push(createBiquadState(), createBiquadState());
    }
    this.energies = new Float64Array(16);
    this.blockSamples = Math.max(1, Math.round((FEATURE_MS / 1000) * sampleRate));
    this.inBlock = 0;
    this.sampleIndex = 0;
    this.features = [];
  }

  processSample(x) {
    for (let b = 0; b < 16; b++) {
      const y1 = processBiquad(x, this.filtersA[b], this.statesA[b]);
      const y = processBiquad(y1, this.filtersB[b], this.statesB[b]);
      this.energies[b] += y * y;
    }
    this.inBlock++;
    this.sampleIndex++;
    if (this.inBlock >= this.blockSamples) {
      const ratios = new Float32Array(CHANNEL_COUNT);
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        const eLow = this.energies[ch * 2];
        const eHigh = this.energies[ch * 2 + 1];
        ratios[ch] =
          10 *
          Math.log10((eLow + EPSILON_ENERGY) / (eHigh + EPSILON_ENERGY));
      }
      const feat = {
        sampleIndex: this.sampleIndex,
        timestamp: (this.sampleIndex / this.sampleRate) * 1000,
        ratios: ratios.slice(),
        energies: Array.from(this.energies),
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

/**
 * Rolling feature buffer (main thread).
 */
export class FeatureBuffer {
  constructor(seconds = FEATURE_BUFFER_SECONDS) {
    this.maxFeatures = Math.ceil((seconds * 1000) / FEATURE_MS);
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

  /** Ratios matrix: features[t][ch] */
  ratiosAt(index) {
    return this.items[index].ratios;
  }
}

function preambleExpectedSigns() {
  // 8 symbols × 8 channels; bit 1 => +1, bit 0 => -1
  const symbols = symbolsFromBytes(PREAMBLE_BYTES);
  const signs = [];
  for (let s = 0; s < PREAMBLE_SYMBOLS; s++) {
    const row = new Float32Array(CHANNEL_COUNT);
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      row[ch] = symbols[s][ch] ? 1 : -1;
    }
    signs.push(row);
  }
  return signs;
}

const PREAMBLE_SIGNS = preambleExpectedSigns();

/**
 * Average middle feature blocks for a symbol starting at feature index `start`.
 * Prefer blocks 2–3 (of 0–5) to avoid crossfade / filter-ringing edges;
 * fall back to 1–4 if requested via opts.
 */
export function symbolRatiosFromFeatures(featureItems, start, opts = {}) {
  // Middle four of six 20 ms blocks — exclude crossfade edges
  const blocks = opts.blocks || [1, 2, 3, 4];
  const ratios = new Float32Array(CHANNEL_COUNT);
  let count = 0;
  for (const b of blocks) {
    const idx = start + b;
    if (idx >= featureItems.length) break;
    const r = featureItems[idx].ratios;
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) ratios[ch] += r[ch];
    count++;
  }
  if (count > 0) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) ratios[ch] /= count;
  }
  return ratios;
}

/**
 * Preamble correlation at candidate feature start index.
 */
export function scorePreamble(featureItems, start) {
  const needed = PREAMBLE_SYMBOLS * FEATURES_PER_SYMBOL;
  if (start + needed > featureItems.length) {
    return { score: -1, channelMeans: null, symbolRatios: null };
  }

  const symbolRatios = [];
  for (let s = 0; s < PREAMBLE_SYMBOLS; s++) {
    symbolRatios.push(
      symbolRatiosFromFeatures(featureItems, start + s * FEATURES_PER_SYMBOL)
    );
  }

  // Per-channel mean across preamble
  const means = new Float32Array(CHANNEL_COUNT);
  for (let s = 0; s < PREAMBLE_SYMBOLS; s++) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      means[ch] += symbolRatios[s][ch];
    }
  }
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) means[ch] /= PREAMBLE_SYMBOLS;

  let num = 0;
  let denObs = 0;
  let denExp = 0;
  for (let s = 0; s < PREAMBLE_SYMBOLS; s++) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const obs = symbolRatios[s][ch] - means[ch];
      const exp = PREAMBLE_SIGNS[s][ch];
      num += obs * exp;
      denObs += obs * obs;
      denExp += exp * exp;
    }
  }
  const denom = Math.sqrt(denObs * denExp) + 1e-12;
  const score = num / denom;
  return { score, channelMeans: means, symbolRatios };
}

/**
 * Estimate per-channel bias, scale, noise, quality from preamble.
 */
export function calibrateFromPreamble(symbolRatios, means) {
  const calib = [];
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const bias = means[ch];
    let sumScale = 0;
    let sumRes2 = 0;
    for (let s = 0; s < PREAMBLE_SYMBOLS; s++) {
      const obs = symbolRatios[s][ch] - bias;
      const exp = PREAMBLE_SIGNS[s][ch];
      sumScale += obs * exp;
    }
    const scale = sumScale / PREAMBLE_SYMBOLS; // estimated modulation amplitude
    for (let s = 0; s < PREAMBLE_SYMBOLS; s++) {
      const obs = symbolRatios[s][ch] - bias;
      const pred = scale * PREAMBLE_SIGNS[s][ch];
      const res = obs - pred;
      sumRes2 += res * res;
    }
    const noise = Math.sqrt(sumRes2 / PREAMBLE_SYMBOLS) + 1e-6;
    const snr = Math.abs(scale) / noise;
    const quality = Math.max(0, Math.min(1, snr / 3));
    calib.push({ bias, scale, noise, quality, snr });
  }
  return calib;
}

/**
 * Decode one frame starting at feature index `start` (preamble start).
 */
export function decodeFrameAt(featureItems, start, opts = {}) {
  const threshold = opts.threshold ?? PREAMBLE_CORRELATION_MIN;
  const pre = scorePreamble(featureItems, start);
  if (pre.score < threshold) {
    return { ok: false, reason: 'preamble', preambleScore: pre.score };
  }

  const calib = calibrateFromPreamble(pre.symbolRatios, pre.channelMeans);
  const dataStart = start + PREAMBLE_SYMBOLS * FEATURES_PER_SYMBOL;
  const softScrambled = new Float32Array(TOTAL_BITS);

  for (let s = 0; s < DATA_SYMBOLS; s++) {
    const ratios = symbolRatiosFromFeatures(
      featureItems,
      dataStart + s * FEATURES_PER_SYMBOL
    );
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const c = calib[ch];
      // Bias-removed differential; scale sign maps energy ratio → soft bit
      const soft = c.scale >= 0
        ? (ratios[ch] - c.bias) / c.noise
        : (c.bias - ratios[ch]) / c.noise;
      softScrambled[s * 8 + ch] = soft * (0.35 + 0.65 * c.quality);
    }
  }

  const decoded = decodeFromBits(softScrambled, { soft: true });
  const avgQuality =
    calib.reduce((a, c) => a + c.quality, 0) / CHANNEL_COUNT;

  return {
    ok: decoded.ok,
    message: decoded.message,
    error: decoded.error,
    crcValid: decoded.crcValid === true,
    correctionCount: decoded.correctionCount || 0,
    preambleScore: pre.score,
    calibration: calib,
    softScrambled,
    softOriginal: softDescrambleDeinterleave(softScrambled),
    avgQuality,
    decoded,
  };
}

/**
 * Search feature buffer for preambles and attempt decodes.
 */
export class FrameSearcher {
  constructor(options = {}) {
    this.threshold = options.threshold ?? PREAMBLE_CORRELATION_MIN;
    this.minSpacingFeatures = options.minSpacingFeatures ?? FEATURES_PER_SYMBOL; // 6
    this.lastAcceptTimes = new Map(); // key -> timestamp
    this.pendingSoft = []; // { soft, weight, start, score }
    this.stats = {
      framesDetected: 0,
      framesCrcValid: 0,
      framesCrcFailed: 0,
      bestPreambleScore: 0,
      lastMessage: null,
      lastHammingCorrections: 0,
      combinedAttempts: 0,
    };
    this.onMessage = options.onMessage || null;
    this.searchedUntil = 0;
    this._scoreCache = new Map();
  }

  resetStats() {
    this.stats = {
      framesDetected: 0,
      framesCrcValid: 0,
      framesCrcFailed: 0,
      bestPreambleScore: 0,
      lastMessage: null,
      lastHammingCorrections: 0,
      combinedAttempts: 0,
    };
    this.pendingSoft = [];
    this.lastAcceptTimes.clear();
    this.searchedUntil = 0;
    this._scoreCache.clear();
  }

  _scoreAt(featureItems, start) {
    let s = this._scoreCache.get(start);
    if (s == null) {
      s = scorePreamble(featureItems, start).score;
      this._scoreCache.set(start, s);
    }
    return s;
  }

  /**
   * Incremental search over new features.
   * Prefers local correlation maxima, then soft-combines spaced frame peaks.
   * @param {Array} featureItems full buffer items
   */
  process(featureItems) {
    const frameFeatures = FRAME_SYMBOLS * FEATURES_PER_SYMBOL;
    const maxStart = featureItems.length - frameFeatures;
    if (maxStart < 0) return null;

    let bestResult = null;
    const from = Math.max(1, this.searchedUntil - frameFeatures);

    for (let start = from; start <= maxStart; start++) {
      const score = this._scoreAt(featureItems, start);
      if (score > this.stats.bestPreambleScore) {
        this.stats.bestPreambleScore = score;
      }
      if (score < this.threshold) continue;

      const left = this._scoreAt(featureItems, start - 1);
      const right =
        start + 1 <= maxStart
          ? this._scoreAt(featureItems, start + 1)
          : -1;
      if (score < left || score < right) continue;

      this.stats.framesDetected++;
      const result = decodeFrameAt(featureItems, start, {
        threshold: this.threshold,
      });

      if (result.ok && result.crcValid) {
        this.stats.framesCrcValid++;
        this.stats.lastHammingCorrections = result.correctionCount;
        const accepted = this._acceptMessage(result.message, result);
        if (accepted) {
          bestResult = result;
          this.searchedUntil = start + frameFeatures;
          start += frameFeatures - 1;
          continue;
        }
      } else {
        this.stats.framesCrcFailed++;
        if (result.softScrambled) {
          this._addPending({
            soft: result.softScrambled,
            weight:
              Math.max(0.1, result.preambleScore) *
              Math.max(0.1, result.avgQuality || 0.5),
            start,
            score: result.preambleScore,
            t: featureItems[start]?.timestamp || 0,
            avgQuality: result.avgQuality,
          });
          const combined = this._tryCombine();
          if (combined && combined.ok) {
            this.stats.combinedAttempts++;
            this.stats.framesCrcValid++;
            const accepted = this._acceptMessage(combined.message, {
              ...combined,
              preambleScore: result.preambleScore,
              correctionCount: combined.correctionCount,
              avgQuality: result.avgQuality,
              combinedRepetitions: Math.min(3, this.pendingSoft.length),
            });
            if (accepted) bestResult = accepted;
          }
        }
      }
    }
    this.searchedUntil = Math.max(this.searchedUntil, maxStart + 1);
    return bestResult;
  }

  _addPending(entry) {
    const near = this.pendingSoft.findIndex(
      (p) => Math.abs(p.start - entry.start) <= 3
    );
    if (near >= 0) {
      if (entry.score > this.pendingSoft[near].score) {
        this.pendingSoft[near] = entry;
      }
    } else {
      this.pendingSoft.push(entry);
    }
    const cutoff = entry.t - 22000;
    this.pendingSoft = this.pendingSoft.filter((p) => p.t >= cutoff);
    if (this.pendingSoft.length > 12) {
      this.pendingSoft.sort((a, b) => b.score - a.score);
      this.pendingSoft = this.pendingSoft.slice(0, 12);
    }
  }

  _tryCombine() {
    if (this.pendingSoft.length < 2) return null;
    const frameFeatures = FRAME_SYMBOLS * FEATURES_PER_SYMBOL;
    const sorted = [...this.pendingSoft].sort((a, b) => a.start - b.start);
    let bestCombo = null;
    let bestWeightSum = 0;

    for (let i = 0; i < sorted.length; i++) {
      const chain = [sorted[i]];
      for (let j = i + 1; j < sorted.length && chain.length < 3; j++) {
        const prev = chain[chain.length - 1];
        const gap = sorted[j].start - prev.start;
        if (Math.abs(gap - frameFeatures) <= 8) {
          chain.push(sorted[j]);
        }
      }
      if (chain.length >= 2) {
        const wSum = chain.reduce((a, p) => a + p.weight, 0);
        if (wSum > bestWeightSum) {
          bestWeightSum = wSum;
          bestCombo = chain;
        }
      }
    }

    const use = bestCombo || sorted.slice(-3);
    if (use.length < 2) return null;
    return combineSoftFrames(
      use.map((p) => p.soft),
      use.map((p) => p.weight)
    );
  }

  _acceptMessage(message, meta) {
    const key = `${message}`;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prev = this.lastAcceptTimes.get(key);
    if (prev != null && now - prev < DUPLICATE_SUPPRESS_MS) {
      return null; // duplicate suppress
    }
    this.lastAcceptTimes.set(key, now);
    this.stats.lastMessage = message;
    const payload = { message, ...meta };
    if (this.onMessage) this.onMessage(payload);
    return payload;
  }
}

/**
 * Decode a full rendered TX PCM buffer (synthetic loopback).
 */
export function decodePcmBuffer(samples, sampleRate, options = {}) {
  const extractor = new FeatureExtractor(sampleRate);
  extractor.processBuffer(samples);
  const searcher = new FrameSearcher({
    threshold: options.threshold ?? PREAMBLE_CORRELATION_MIN,
  });
  const result = searcher.process(extractor.features);
  return {
    result,
    stats: searcher.stats,
    featureCount: extractor.features.length,
    features: extractor.features,
  };
}

/**
 * Human-readable signal quality heuristic.
 */
export function signalQualityLabel(meta) {
  if (!meta) return 'Poor';
  const score = meta.preambleScore || 0;
  const q = meta.avgQuality || 0;
  const corr = meta.correctionCount || 0;
  let points = 0;
  if (score > 0.7) points += 3;
  else if (score > 0.5) points += 2;
  else if (score > 0.35) points += 1;
  if (q > 0.7) points += 2;
  else if (q > 0.4) points += 1;
  if (corr <= 2) points += 1;
  else if (corr >= 10) points -= 1;
  if (meta.combinedRepetitions >= 2) points += 1;
  if (points >= 6) return 'Strong';
  if (points >= 4) return 'Good';
  if (points >= 2) return 'Fair';
  return 'Poor';
}
