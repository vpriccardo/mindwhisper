/**
 * room-v2 RX: feature extraction reuses the UNCHANGED room acoustic
 * front-end (see ../rx-decoder.js FeatureExtractor — same 8-channel
 * bandpass/band-reject design), only the framing differs: new preamble,
 * repeated header for immediate length knowledge, and RS-coded payload
 * (1 RS byte = 1 acoustic symbol) at a selectable, auto-detected speed.
 */

import { CHANNEL_COUNT, symbolsFromBytes } from '../protocol.js';
import {
  decodeFrameV2,
  computeFrameLayoutV2,
  parseHeaderV2,
  majorityVoteHeaderByte,
} from '../protocol-v2.js';
import { FeatureExtractor, FeatureBuffer as V1FeatureBuffer } from '../rx-decoder.js';
import {
  ROOM_V2_PREAMBLE,
  ROOM_V2_HEADER_SYMBOLS,
  ROOM_V2_FEATURE_MS,
  ROOM_V2_SPEED_PRESETS,
  ROOM_V2_SPEED_ORDER,
  ROOM_V2_PREAMBLE_CORRELATION_MIN,
  ROOM_V2_DUPLICATE_SUPPRESS_MS,
  ROOM_V2_FEATURE_BUFFER_SECONDS,
  ROOM_V2_BYTE_ERASURE_QUALITY_THRESHOLD,
} from './room-v2-constants.js';

export function createRoomV2FeatureExtractor(sampleRate) {
  return new FeatureExtractor(sampleRate, ROOM_V2_FEATURE_MS);
}

export class RoomV2FeatureBuffer extends V1FeatureBuffer {
  constructor(seconds = ROOM_V2_FEATURE_BUFFER_SECONDS) {
    super(seconds);
    this.maxFeatures = Math.ceil((seconds * 1000) / ROOM_V2_FEATURE_MS);
    this.items = [];
  }
}

const SPEED_CANDIDATES = ROOM_V2_SPEED_ORDER.map((id) => ({
  id,
  symbolMs: ROOM_V2_SPEED_PRESETS[id],
  featuresPerSymbol: Math.round(ROOM_V2_SPEED_PRESETS[id] / ROOM_V2_FEATURE_MS),
}));
export const ROOM_V2_MIN_FEATURES_PER_SYMBOL = Math.min(
  ...SPEED_CANDIDATES.map((c) => c.featuresPerSymbol)
);
export const ROOM_V2_MAX_FEATURES_PER_SYMBOL = Math.max(
  ...SPEED_CANDIDATES.map((c) => c.featuresPerSymbol)
);
/**
 * Preamble scoring compares all 4 speed hypotheses at every candidate start,
 * so a start position must only ever be scored (and cached) once ALL of
 * them have full look-ahead available — otherwise an early, incomplete
 * evaluation (e.g. while a live buffer is still filling up) would
 * permanently cache an understated score for the slowest hypothesis.
 */
export const ROOM_V2_PREAMBLE_LOOKAHEAD_FEATURES =
  ROOM_V2_PREAMBLE.length * ROOM_V2_MAX_FEATURES_PER_SYMBOL;

function preambleExpectedSigns() {
  const symbols = symbolsFromBytes(ROOM_V2_PREAMBLE);
  return symbols.map((row) => Float32Array.from(row, (b) => (b ? 1 : -1)));
}
const PREAMBLE_SIGNS = preambleExpectedSigns();

/**
 * Average the usable feature blocks of one symbol. Only the FIRST block of
 * each symbol overlaps the (short, ~12 ms) crossfade ramp from the previous
 * symbol's gain — the room-v1 acoustic engine only fades in at a symbol's
 * *start* (see tx-engine.js renderChunk), so every later block is clean and
 * can be used. This maximizes integration time (critical for the shorter
 * room-v2 symbol durations), unlike v1's RX which also drops the final
 * block purely as a safety margin.
 */
export function symbolRatiosFromFeaturesV2(featureItems, start, featuresPerSymbol) {
  const ratios = new Float32Array(CHANNEL_COUNT);
  let count = 0;
  const first = featuresPerSymbol >= 2 ? 1 : 0;
  const last = featuresPerSymbol - 1;
  for (let b = first; b <= last; b++) {
    const idx = start + b;
    if (idx >= featureItems.length || !featureItems[idx]) break;
    const r = featureItems[idx].ratios;
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) ratios[ch] += r[ch];
    count++;
  }
  if (count > 0) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) ratios[ch] /= count;
  }
  return ratios;
}

export function scoreRoomV2PreambleAt(featureItems, start, featuresPerSymbol) {
  const needed = ROOM_V2_PREAMBLE.length * featuresPerSymbol;
  if (start + needed > featureItems.length) {
    return { score: -1, means: null, symbolRatios: null };
  }
  const symbolRatios = [];
  for (let s = 0; s < ROOM_V2_PREAMBLE.length; s++) {
    symbolRatios.push(
      symbolRatiosFromFeaturesV2(featureItems, start + s * featuresPerSymbol, featuresPerSymbol)
    );
  }
  const means = new Float32Array(CHANNEL_COUNT);
  for (const row of symbolRatios) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) means[ch] += row[ch];
  }
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) means[ch] /= symbolRatios.length;

  let num = 0;
  let denObs = 0;
  let denExp = 0;
  for (let s = 0; s < symbolRatios.length; s++) {
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const obs = symbolRatios[s][ch] - means[ch];
      const exp = PREAMBLE_SIGNS[s][ch];
      num += obs * exp;
      denObs += obs * obs;
      denExp += exp * exp;
    }
  }
  const score = num / (Math.sqrt(denObs * denExp) + 1e-12);
  return { score, means, symbolRatios };
}

/** Blind speed detection: score every candidate symbol duration, keep the best. */
export function bestRoomV2SpeedAt(featureItems, start) {
  let best = null;
  for (const cand of SPEED_CANDIDATES) {
    const r = scoreRoomV2PreambleAt(featureItems, start, cand.featuresPerSymbol);
    if (!best || r.score > best.score) {
      best = { ...r, speed: cand };
    }
  }
  return best;
}

function calibrateRoomV2Preamble(symbolRatios, means) {
  const calib = [];
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const bias = means[ch];
    let sumScale = 0;
    for (let s = 0; s < symbolRatios.length; s++) {
      sumScale += (symbolRatios[s][ch] - bias) * PREAMBLE_SIGNS[s][ch];
    }
    const scale = sumScale / symbolRatios.length;
    let sumRes2 = 0;
    for (let s = 0; s < symbolRatios.length; s++) {
      const obs = symbolRatios[s][ch] - bias;
      const pred = scale * PREAMBLE_SIGNS[s][ch];
      const res = obs - pred;
      sumRes2 += res * res;
    }
    const noise = Math.sqrt(sumRes2 / symbolRatios.length) + 1e-6;
    const snr = Math.abs(scale) / noise;
    const quality = Math.max(0, Math.min(1, snr / 3));
    calib.push({ bias, scale, noise, quality, snr });
  }
  return calib;
}

/** Recover one 8-bit symbol byte (channel 0 = MSB) + an average per-symbol quality score. */
function symbolByteFromRatios(ratios, calib) {
  let byte = 0;
  let qualitySum = 0;
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const c = calib[ch];
    const soft = c.scale >= 0 ? ratios[ch] - c.bias : c.bias - ratios[ch];
    const bit = soft > 0 ? 1 : 0;
    byte |= bit << (CHANNEL_COUNT - 1 - ch);
    qualitySum += c.quality;
  }
  return { byte, quality: qualitySum / CHANNEL_COUNT };
}

/**
 * Attempt a full room-v2 frame decode starting at feature index `start`.
 * Returns as soon as possible: header failure short-circuits before any
 * RS-length-dependent work (§20).
 */
export function decodeRoomV2FrameAt(featureItems, start, opts = {}) {
  const threshold = opts.threshold ?? ROOM_V2_PREAMBLE_CORRELATION_MIN;

  let pre;
  let featuresPerSymbol;
  let speedId;
  if (opts.speedHint) {
    featuresPerSymbol = opts.speedHint.featuresPerSymbol;
    speedId = opts.speedHint.id;
    pre = scoreRoomV2PreambleAt(featureItems, start, featuresPerSymbol);
  } else {
    const best = bestRoomV2SpeedAt(featureItems, start);
    pre = best;
    featuresPerSymbol = best?.speed?.featuresPerSymbol;
    speedId = best?.speed?.id;
  }
  if (!pre || pre.score < threshold) {
    return { ok: false, reason: 'preamble', preambleScore: pre ? pre.score : -1 };
  }

  const calib = calibrateRoomV2Preamble(pre.symbolRatios, pre.means);
  const headerStart = start + ROOM_V2_PREAMBLE.length * featuresPerSymbol;
  const headerCandidates = [];
  for (let h = 0; h < ROOM_V2_HEADER_SYMBOLS; h++) {
    const idx = headerStart + h * featuresPerSymbol;
    if (idx + featuresPerSymbol > featureItems.length) {
      return { ok: false, reason: 'incomplete-header', preambleScore: pre.score, speedId };
    }
    const ratios = symbolRatiosFromFeaturesV2(featureItems, idx, featuresPerSymbol);
    const { byte } = symbolByteFromRatios(ratios, calib);
    headerCandidates.push(byte);
  }

  const { byte: majorityHeader } = majorityVoteHeaderByte(headerCandidates);
  const headerCheck = parseHeaderV2(majorityHeader);
  if (!headerCheck.ok) {
    return { ok: false, reason: 'header', error: headerCheck.error, preambleScore: pre.score, speedId };
  }

  // §20: length known immediately after header → exact remaining symbol count, no max-payload waiting.
  const layout = computeFrameLayoutV2(headerCheck.length);
  const dataStart = headerStart + ROOM_V2_HEADER_SYMBOLS * featuresPerSymbol;
  const neededSymbols = layout.codewordBytes;
  const frameFeatureLength =
    (ROOM_V2_PREAMBLE.length + ROOM_V2_HEADER_SYMBOLS + neededSymbols) * featuresPerSymbol;
  if (dataStart + neededSymbols * featuresPerSymbol > featureItems.length) {
    return {
      ok: false,
      reason: 'incomplete-data',
      preambleScore: pre.score,
      speedId,
      layout,
      frameFeatureLength,
    };
  }

  const whitenedBits = new Uint8Array(neededSymbols * 8);
  let qualitySum = 0;
  const byteQualities = new Array(neededSymbols);
  const byteValues = new Array(neededSymbols);
  for (let s = 0; s < neededSymbols; s++) {
    const idx = dataStart + s * featuresPerSymbol;
    const ratios = symbolRatiosFromFeaturesV2(featureItems, idx, featuresPerSymbol);
    const { byte, quality } = symbolByteFromRatios(ratios, calib);
    byteQualities[s] = quality;
    byteValues[s] = byte;
    qualitySum += quality;
    for (let b = 0; b < 8; b++) whitenedBits[s * 8 + b] = (byte >> (7 - b)) & 1;
  }
  const avgQuality = qualitySum / neededSymbols;

  // §9/§41: mark genuinely low-confidence bytes as RS erasures (an erasure
  // only "costs" 1 unit of the RS budget vs. 2 for a blind error). Measured
  // empirically (see docs/room-v2-report.md): at this system's per-symbol
  // SNR, the confidence metric is only weakly correlated with which byte is
  // actually wrong, so aggressively spending the parity budget on the
  // lowest-confidence bytes regardless of their absolute quality made
  // decode LESS reliable overall (erasing bytes that were actually fine
  // reduces headroom for real, unpredicted errors elsewhere). Only erase
  // when a byte is clearly, absolutely unreliable.
  const erasureBytePositions = [];
  for (let s = 0; s < neededSymbols; s++) {
    if (byteQualities[s] < ROOM_V2_BYTE_ERASURE_QUALITY_THRESHOLD) erasureBytePositions.push(s);
  }

  const decoded = decodeFrameV2(headerCandidates, whitenedBits, { erasureBytePositions });

  return {
    ok: decoded.ok,
    message: decoded.message,
    error: decoded.error,
    crcValid: decoded.ok,
    correctionCount: decoded.rsErrorCount || 0,
    erasureCount: decoded.rsErasureCount ?? erasureBytePositions.length,
    preambleScore: pre.score,
    avgQuality,
    channelQuality: calib.map((c) => c.quality),
    speedId,
    symbolMs: featuresPerSymbol * ROOM_V2_FEATURE_MS,
    featuresPerSymbol,
    frameFeatureLength,
    layout,
    decoded,
  };
}

/**
 * Stateful room-v2 frame searcher — continuous SEARCH with independent
 * per-frame decode attempts (TX repeats forever; §21/§44 favor time-to-
 * first-valid over per-frame success rate, so no TRACK state is needed).
 */
export class RoomV2FrameSearcher {
  constructor(options = {}) {
    this.threshold = options.threshold ?? ROOM_V2_PREAMBLE_CORRELATION_MIN;
    this.onMessage = options.onMessage || null;
    this.lastAcceptTimes = new Map();
    this.searchedUntil = 0;
    this._scoreCache = new Map();
    // Starts (and ±neighbours) already given a *complete* decode attempt.
    // Live mic calls process() once per ~15 ms feature tick; without this,
    // the LOOKAHEAD rewind re-tries the same failed/succeeded peak every
    // tick and Failed-frames climbs continuously (batch decodeRoomV2PcmBuffer
    // never hits this path).
    this._attemptedStarts = new Set();
    // Incomplete candidates already surfaced once (so framesDetected does not
    // climb on every ~15 ms tick while waiting for the rest of the frame).
    this._incompleteNoted = new Set();
    this.stats = this._emptyStats();
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
    };
  }

  resetStats() {
    this.stats = this._emptyStats();
    this.lastAcceptTimes.clear();
    this.searchedUntil = 0;
    this._scoreCache.clear();
    this._attemptedStarts.clear();
    this._incompleteNoted.clear();
  }

  _wasAttempted(start) {
    for (let d = -2; d <= 2; d++) {
      if (this._attemptedStarts.has(start + d)) return true;
    }
    return false;
  }

  _markAttempted(start, width = 2) {
    for (let d = -width; d <= width; d++) this._attemptedStarts.add(start + d);
  }

  _markAttemptedRange(from, toExclusive) {
    for (let s = from; s < toExclusive; s++) this._attemptedStarts.add(s);
  }

  _noteIncomplete(start) {
    for (let d = -2; d <= 2; d++) {
      if (this._incompleteNoted.has(start + d)) return false;
    }
    this._incompleteNoted.add(start);
    return true;
  }

  _pruneAttempts(minStart) {
    for (const s of this._attemptedStarts) {
      if (s < minStart) this._attemptedStarts.delete(s);
    }
    for (const s of this._incompleteNoted) {
      if (s < minStart) this._incompleteNoted.delete(s);
    }
  }

  _bestAt(featureItems, start) {
    let s = this._scoreCache.get(start);
    if (s == null) {
      s = bestRoomV2SpeedAt(featureItems, start);
      this._scoreCache.set(start, s);
    }
    return s;
  }

  /**
   * Decode at the preamble peak, then ±1/±2 feature offsets.
   * Live mic alignment often peaks a feature or two early/late relative to
   * the true symbol grid; preamble correlation can still look excellent there
   * while the RS codeword is uncorrectable. Trying small offsets before
   * sealing the neighbourhood recovers frames that would otherwise burn the
   * full RS budget at the wrong grid.
   */
  _decodePeakWithOffsets(featureItems, peakStart, speedHint) {
    const offsets = [0, -1, 1, -2, 2];
    let firstComplete = null;
    for (const d of offsets) {
      const start = peakStart + d;
      if (start < 0) continue;
      const result = decodeRoomV2FrameAt(featureItems, start, {
        threshold: this.threshold,
        speedHint,
      });
      result.alignOffset = d;
      result.peakStart = peakStart;
      if (result.reason === 'incomplete-data' || result.reason === 'incomplete-header') {
        // Only the peak gates "wait for more audio" — offsets may look
        // incomplete simply because they need one more symbol of look-ahead.
        if (d === 0) return result;
        continue;
      }
      if (!firstComplete) firstComplete = result;
      if (result.ok) return result;
    }
    return firstComplete;
  }

  process(featureItems) {
    // Gate scoring (and therefore caching) on full look-ahead for every
    // speed hypothesis — see ROOM_V2_PREAMBLE_LOOKAHEAD_FEATURES.
    const maxStart = featureItems.length - ROOM_V2_PREAMBLE_LOOKAHEAD_FEATURES;
    if (maxStart < 0) return null;

    let bestResult = null;
    const from = Math.max(1, this.searchedUntil - ROOM_V2_PREAMBLE_LOOKAHEAD_FEATURES);
    // A candidate whose full frame length isn't buffered yet ("incomplete")
    // must remain re-checkable on a later call once more audio arrives —
    // otherwise unconditionally advancing searchedUntil to maxStart+1 would
    // permanently skip past it long before its (unknown until the header is
    // read) full frame length elapses. Only the true message length varies
    // this window, so we can't gate the outer scan on it up front like v1
    // does with its fixed frame size — instead we track the earliest still-
    // pending position and never advance searchedUntil past it.
    let advanceLimit = maxStart + 1;

    this._pruneAttempts(from - 8);

    for (let start = from; start <= maxStart; start++) {
      if (this._wasAttempted(start)) continue;
      const best = this._bestAt(featureItems, start);
      if (!best) continue;
      if (best.score > this.stats.bestPreambleScore) this.stats.bestPreambleScore = best.score;
      if (best.score < this.threshold) continue;

      const left = this._bestAt(featureItems, start - 1);
      const right = start + 1 <= maxStart ? this._bestAt(featureItems, start + 1) : null;
      if (left && best.score < left.score) continue;
      if (right && best.score < right.score) continue;

      const result = this._decodePeakWithOffsets(featureItems, start, best.speed);

      if (!result) continue;

      if (result.reason === 'incomplete-data' || result.reason === 'incomplete-header') {
        advanceLimit = Math.min(advanceLimit, start);
        // Count the candidate once while the frame is still filling in —
        // not on every subsequent feature tick (and not on neighbour starts
        // of the same peak as the local-max drifts by ±1–2).
        if (this._noteIncomplete(start)) {
          this.stats.framesDetected++;
          this._debugLog('incomplete', {
            start,
            score: best.score,
            speed: best.speed?.id,
            reason: result.reason,
            features: featureItems.length,
          });
        }
        continue;
      }

      // Complete attempt (CRC ok or fail) — never re-decode this peak on later ticks.
      this._markAttempted(start);
      if (!this._incompleteNoted.has(start)) {
        // Also treat neighbour incomplete notes as "already counted".
        let counted = false;
        for (let d = -2; d <= 2; d++) {
          if (this._incompleteNoted.has(start + d)) {
            counted = true;
            break;
          }
        }
        if (!counted) this.stats.framesDetected++;
      }
      for (let d = -2; d <= 2; d++) this._incompleteNoted.delete(start + d);

      const decodeStart = start + (result.alignOffset || 0);

      if (result.ok) {
        this.stats.framesCrcValid++;
        this.stats.rsCorrections += result.correctionCount || 0;
        this.stats.rsErasures += result.erasureCount || 0;
        this._debugLog('crc-ok', {
          start: decodeStart,
          peakStart: start,
          alignOffset: result.alignOffset || 0,
          score: best.score,
          speed: result.speedId,
          message: result.message,
          corrections: result.correctionCount,
          erasures: result.erasureCount,
        });
        const accepted = this._acceptMessage(result.message, result);
        if (accepted) {
          bestResult = accepted;
          const frameLen = result.frameFeatureLength || ROOM_V2_PREAMBLE_LOOKAHEAD_FEATURES;
          // Skip the rest of this frame so side-lobe peaks inside it are not
          // re-tried as fresh detections on later ticks.
          this._markAttemptedRange(start - 2, decodeStart + frameLen);
          this.searchedUntil = decodeStart + frameLen;
          start += frameLen - 1;
          continue;
        }
      } else {
        this.stats.framesCrcFailed++;
        this._debugLog('crc-fail', {
          start: decodeStart,
          peakStart: start,
          alignOffset: result.alignOffset || 0,
          score: best.score,
          speed: result.speedId || best.speed?.id,
          reason: result.reason,
          error: result.error,
          headerCandidates: result.headerCandidates,
          avgQuality: result.avgQuality,
        });
      }
    }
    this.searchedUntil = Math.max(this.searchedUntil, advanceLimit);
    return bestResult;
  }

  _debugLog(event, detail) {
    if (typeof globalThis === 'undefined') return;
    const enabled =
      globalThis.__ROOM_V2_RX_DEBUG__ === true ||
      (typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('debug') === '1');
    if (!enabled) return;
    const s = this.stats;
    console.log(`[room-v2-rx] ${event}`, {
      ...detail,
      threshold: this.threshold,
      detected: s.framesDetected,
      valid: s.framesCrcValid,
      failed: s.framesCrcFailed,
      bestPreamble: s.bestPreambleScore,
      searchedUntil: this.searchedUntil,
    });
  }

  _acceptMessage(message, meta) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prev = this.lastAcceptTimes.get(message);
    const duplicate = prev != null && now - prev < ROOM_V2_DUPLICATE_SUPPRESS_MS;
    this.lastAcceptTimes.set(message, now);
    this.stats.lastMessage = message;
    const payload = { message, duplicate, ...meta };
    if (this.onMessage) this.onMessage(payload);
    return payload;
  }
}

export function decodeRoomV2PcmBuffer(samples, sampleRate, options = {}) {
  const extractor = createRoomV2FeatureExtractor(sampleRate);
  extractor.processBuffer(samples);
  const searcher = new RoomV2FrameSearcher({
    threshold: options.threshold ?? ROOM_V2_PREAMBLE_CORRELATION_MIN,
  });
  const result = searcher.process(extractor.features);
  return {
    result,
    stats: searcher.stats,
    featureCount: extractor.features.length,
    features: extractor.features,
  };
}

export function roomV2SignalQualityLabel(meta) {
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
  else if (corr >= 6) points -= 1;
  if (points >= 6) return 'Strong';
  if (points >= 4) return 'Good';
  if (points >= 2) return 'Fair';
  return 'Poor';
}
