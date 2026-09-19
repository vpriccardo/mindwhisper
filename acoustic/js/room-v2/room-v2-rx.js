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
  peekPartialMessageV2,
} from '../protocol-v2.js';
import { FeatureExtractor, FeatureBuffer as V1FeatureBuffer } from '../rx-decoder.js';
import {
  ROOM_V2_PREAMBLE,
  ROOM_V2_HEADER_SYMBOLS,
  ROOM_V2_FEATURE_MS,
  ROOM_V2_SPEED_PRESETS,
  ROOM_V2_SPEED_PRESET_ORDER,
  ROOM_V2_PREAMBLE_CORRELATION_MIN,
  ROOM_V2_DUPLICATE_SUPPRESS_MS,
  ROOM_V2_FEATURE_BUFFER_SECONDS,
  ROOM_V2_BYTE_ERASURE_QUALITY_THRESHOLD,
  ROOM_V2_MAX_COMBINE_FRAMES,
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

const SPEED_CANDIDATES = ROOM_V2_SPEED_PRESET_ORDER.map((id) => ({
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

/**
 * Soft, noise-normalized bit decisions for one acoustic symbol.
 * soft[ch] > 0 ⇒ bit 1 (polarity-aligned to preamble calib scale).
 */
function symbolSoftFromRatios(ratios, calib) {
  let byte = 0;
  const soft = new Float32Array(CHANNEL_COUNT);
  const conf = new Float32Array(CHANNEL_COUNT);
  let confSum = 0;
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const c = calib[ch];
    const raw = c.scale >= 0 ? ratios[ch] - c.bias : c.bias - ratios[ch];
    const sn = raw / (c.noise || 1e-6);
    soft[ch] = sn;
    conf[ch] = Math.abs(sn) * Math.max(0.05, c.quality);
    confSum += conf[ch];
    if (raw > 0) byte |= 1 << (CHANNEL_COUNT - 1 - ch);
  }
  return { byte, soft, conf, quality: confSum / CHANNEL_COUNT };
}

/** Soft-sum N polarity-aligned whitened bit frames, then hard-decide. */
export function combineRoomV2SoftBitFrames(frames) {
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

function rankedErasureBudgets(byteConfidences, parityBytes) {
  const rankedWeakest = byteConfidences
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c - b.c);
  const budgets = [0];
  const thresholdErasures = rankedWeakest
    .filter((e) => e.c < ROOM_V2_BYTE_ERASURE_QUALITY_THRESHOLD)
    .map((e) => e.i);
  if (thresholdErasures.length) budgets.push(-1);
  for (let n = 1; n <= parityBytes; n++) budgets.push(n);
  return { rankedWeakest, thresholdErasures, budgets };
}

function tryDecodeWithErasureBudgets(headerCandidates, whitenedBits, byteConfidences, parityBytes) {
  const { rankedWeakest, thresholdErasures, budgets } = rankedErasureBudgets(
    byteConfidences,
    parityBytes
  );
  let decoded = null;
  let erasureBytePositions = [];
  for (const budget of budgets) {
    const erasures =
      budget === -1
        ? thresholdErasures
        : budget === 0
          ? []
          : rankedWeakest.slice(0, budget).map((e) => e.i);
    const attempt = decodeFrameV2(headerCandidates, whitenedBits, {
      erasureBytePositions: erasures,
    });
    if (attempt.ok) {
      decoded = attempt;
      erasureBytePositions = erasures;
      break;
    }
    if (!decoded) decoded = attempt;
  }
  return { decoded, erasureBytePositions };
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
    const { byte } = symbolSoftFromRatios(ratios, calib);
    headerCandidates.push(byte);
  }

  const { byte: majorityHeader } = majorityVoteHeaderByte(headerCandidates);
  const headerCheck = parseHeaderV2(majorityHeader);
  if (!headerCheck.ok) {
    return {
      ok: false,
      reason: 'header',
      error: headerCheck.error,
      preambleScore: pre.score,
      speedId,
      headerCandidates,
    };
  }

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
  const softAligned = new Float32Array(neededSymbols * 8);
  const bitConf = new Float32Array(neededSymbols * 8);
  const byteConfidences = new Array(neededSymbols);
  let qualitySum = 0;
  for (let s = 0; s < neededSymbols; s++) {
    const idx = dataStart + s * featuresPerSymbol;
    const ratios = symbolRatiosFromFeaturesV2(featureItems, idx, featuresPerSymbol);
    const { byte, soft, conf, quality } = symbolSoftFromRatios(ratios, calib);
    byteConfidences[s] = quality;
    qualitySum += quality;
    for (let b = 0; b < 8; b++) {
      const bitIdx = s * 8 + b;
      whitenedBits[bitIdx] = (byte >> (7 - b)) & 1;
      softAligned[bitIdx] = soft[b];
      bitConf[bitIdx] = conf[b];
    }
  }
  const avgQuality = qualitySum / neededSymbols;

  const { decoded, erasureBytePositions } = tryDecodeWithErasureBudgets(
    headerCandidates,
    whitenedBits,
    byteConfidences,
    layout.parityBytes
  );

  const partial =
    !decoded.ok && softAligned
      ? peekPartialMessageV2(softAligned, layout)
      : null;

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
    headerCandidates,
    softAligned,
    bitConf,
    byteConfidences,
    whitenedBits,
    partial,
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
    this.onPartial = options.onPartial || null;
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
    this.pendingFrames = [];
    this.stats = this._emptyStats();
  }

  _emitPartial(partial, meta = {}) {
    if (!partial || !this.onPartial) return;
    const prev = this.stats.lastPartial;
    // Prefer previews that reveal more characters; ignore regressions.
    if (prev && partial.knownCount < prev.knownCount) return;
    if (prev && partial.knownCount === prev.knownCount && partial.preview === prev.preview) {
      return;
    }
    this.stats.lastPartial = partial;
    this.onPartial({ ...partial, ...meta });
  }

  _emptyStats() {
    return {
      framesDetected: 0,
      framesCrcValid: 0,
      framesCrcFailed: 0,
      bestPreambleScore: 0,
      lastMessage: null,
      lastPartial: null,
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
    this.pendingFrames = [];
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
    const offsets = [0, -1, 1, -2, 2, -3, 3];
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
        if (d === 0) return result;
        continue;
      }
      if (!firstComplete) firstComplete = result;
      if (result.ok) return result;
    }
    return firstComplete;
  }

  _addPendingForCombine(result, start) {
    if (!result.softAligned || !result.layout) return;
    const key = `${result.layout.messageLength}`;
    const entry = {
      key,
      soft: result.softAligned,
      conf: result.bitConf,
      headerCandidates: result.headerCandidates,
      layout: result.layout,
      frameFeatureLength: result.frameFeatureLength,
      start,
      weight: Math.max(0.1, result.preambleScore) * Math.max(0.1, result.avgQuality || 0.5),
      score: result.preambleScore,
    };
    const near = this.pendingFrames.findIndex(
      (p) => p.key === key && Math.abs(p.start - start) <= 4
    );
    if (near >= 0) {
      if (entry.score >= this.pendingFrames[near].score) this.pendingFrames[near] = entry;
    } else {
      this.pendingFrames.push(entry);
    }
    if (this.pendingFrames.length > 16) this.pendingFrames.shift();
  }

  _tryCombine() {
    const groups = new Map();
    for (const p of this.pendingFrames) {
      if (!groups.has(p.key)) groups.set(p.key, []);
      groups.get(p.key).push(p);
    }
    let bestPartial = null;
    for (const [, frames] of groups) {
      if (frames.length < 2) continue;
      const sorted = [...frames].sort((a, b) => a.start - b.start);
      const spacing = sorted[0].frameFeatureLength || 0;
      for (let n = Math.min(ROOM_V2_MAX_COMBINE_FRAMES, sorted.length); n >= 2; n--) {
        const candidates = [sorted.slice(-n)];
        for (let i = 0; i + n <= sorted.length; i++) {
          const slice = sorted.slice(i, i + n);
          if (spacing > 0) {
            let okSpacing = true;
            for (let k = 1; k < slice.length; k++) {
              const gap = slice[k].start - slice[k - 1].start;
              if (Math.abs(gap - spacing) > 8) {
                okSpacing = false;
                break;
              }
            }
            if (!okSpacing && !(i === sorted.length - n)) continue;
          }
          candidates.push(slice);
        }
        for (const use of candidates) {
          if (!use[0]?.soft) continue;
          const combined = combineRoomV2SoftBitFrames(
            use.map((f) => ({ soft: f.soft, conf: f.conf, weight: f.weight }))
          );
          if (!combined) continue;
          const headerBytes = [0, 1, 2].map((i) => {
            const votes = use.map((f) => f.headerCandidates[i]);
            return majorityVoteHeaderByte(votes).byte;
          });
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
          const { decoded } = tryDecodeWithErasureBudgets(
            headerBytes,
            combined.hard,
            byteConf,
            use[0].layout.parityBytes
          );
          if (decoded?.ok) {
            return { ...decoded, combinedRepetitions: use.length };
          }
          const partial = peekPartialMessageV2(combined.softSum, use[0].layout);
          if (
            partial &&
            (!bestPartial ||
              partial.knownCount > bestPartial.partial.knownCount)
          ) {
            bestPartial = { partial, combinedRepetitions: use.length, ok: false };
          }
        }
      }
    }
    return bestPartial;
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
        if (result.softAligned && result.layout) {
          this._emitPartial(result.partial, {
            preambleScore: result.preambleScore,
            source: 'frame',
          });
          this._addPendingForCombine(result, decodeStart);
          const combined = this._tryCombine();
          if (combined && combined.ok) {
            this.stats.combinedAttempts++;
            this.stats.framesCrcValid++;
            this.stats.rsCorrections += combined.rsErrorCount || 0;
            this._debugLog('crc-ok-combined', {
              start: decodeStart,
              repetitions: combined.combinedRepetitions,
              message: combined.message,
              corrections: combined.rsErrorCount,
            });
            const accepted = this._acceptMessage(combined.message, {
              ...combined,
              combinedRepetitions: combined.combinedRepetitions,
              avgQuality: result.avgQuality,
              speedId: result.speedId,
              preambleScore: result.preambleScore,
            });
            if (accepted) {
              bestResult = accepted;
              const frameLen = result.frameFeatureLength || ROOM_V2_PREAMBLE_LOOKAHEAD_FEATURES;
              this._markAttemptedRange(start - 2, decodeStart + frameLen);
              this.searchedUntil = decodeStart + frameLen;
              start += frameLen - 1;
              continue;
            }
          } else if (combined?.partial) {
            this._emitPartial(combined.partial, {
              preambleScore: result.preambleScore,
              source: 'combine',
              combinedRepetitions: combined.combinedRepetitions,
            });
          }
        }
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
    // Throttle noisy incomplete/fail spam so debug mode does not stall the
    // audio callback path; always emit crc-ok / combined successes.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (event === 'incomplete' || event === 'crc-fail') {
      if (this._lastDebugSpamAt != null && now - this._lastDebugSpamAt < 400) return;
      this._lastDebugSpamAt = now;
    }
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
