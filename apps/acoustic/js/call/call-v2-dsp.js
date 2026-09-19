/**
 * call-v2 DSP: peaking-EQ math shared by the offline (Node-testable)
 * renderer and used as the reference model for the live production engine
 * (which drives real native BiquadFilterNode + AudioParam automation —
 * see call-v2-tx.js `CallV2ContinuousTransmitter`).
 *
 * The peaking-filter coefficient formula below is the exact
 * Audio-EQ-Cookbook / Web Audio API `BiquadFilterNode` "peaking" formula
 * (https://www.w3.org/TR/audio-eq-cookbook/, W3C Web Audio spec §BiquadFilterNode),
 * so this offline model is mathematically equivalent to what a real
 * BiquadFilterNode produces for the same frequency/Q/gain — only the
 * scheduling mechanism differs (linear interpolation of the *gain in dB*
 * with per-sample coefficient refresh here, vs. native AudioParam
 * automation live). At Δ ≤ 0.7 dB total swing and ~12 ms ramps this
 * distinction is inaudible.
 */

export function designPeakingCoeffs(freqHz, sampleRate, Q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha / A;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * One automatable peaking filter: fixed freq/Q, gain(dB) linearly ramped
 * over a scheduled window (mirrors AudioParam.linearRampToValueAtTime),
 * coefficients refreshed every sample from the interpolated gain.
 */
export class AutomatedPeakingFilter {
  constructor(freqHz, sampleRate, Q) {
    this.freqHz = freqHz;
    this.sampleRate = sampleRate;
    this.Q = Q;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
    this.sampleIndex = 0;
    this.rampStartGainDb = 0;
    this.rampStartSample = 0;
    this.rampEndSample = 0;
    this.rampEndGainDb = 0;
  }

  /** Schedule a linear ramp to targetGainDb over rampSamples, starting now. */
  scheduleRamp(targetGainDb, rampSamples) {
    const cur = this.currentGainDb();
    this.rampStartGainDb = cur;
    this.rampStartSample = this.sampleIndex;
    this.rampEndSample = this.sampleIndex + Math.max(1, Math.round(rampSamples));
    this.rampEndGainDb = targetGainDb;
  }

  /** Snap immediately (no ramp) — used for initial state / bypass. */
  setGainImmediate(gainDb) {
    this.rampStartGainDb = gainDb;
    this.rampStartSample = this.sampleIndex;
    this.rampEndSample = this.sampleIndex;
    this.rampEndGainDb = gainDb;
  }

  currentGainDb() {
    const i = this.sampleIndex;
    if (i >= this.rampEndSample) return this.rampEndGainDb;
    if (i <= this.rampStartSample || this.rampEndSample <= this.rampStartSample) {
      return this.rampStartGainDb;
    }
    const t = (i - this.rampStartSample) / (this.rampEndSample - this.rampStartSample);
    return this.rampStartGainDb + (this.rampEndGainDb - this.rampStartGainDb) * t;
  }

  processSample(x) {
    const gainDb = this.currentGainDb();
    this.sampleIndex++;
    if (Math.abs(gainDb) < 1e-9) {
      // Exact bypass at 0 dB — keeps filter state trivially stable and
      // guarantees a truly unmodified signal when watermarking is off.
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = x;
      return x;
    }
    const c = designPeakingCoeffs(this.freqHz, this.sampleRate, this.Q, gainDb);
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * A full 6-pair (12-filter) cascade. Filters for different pairs act on
 * mostly non-overlapping bands, so a series cascade closely approximates
 * simultaneous multi-band EQ (standard parametric-EQ practice).
 */
export class CallV2EqBank {
  constructor(pairs, sampleRate, Q) {
    this.sampleRate = sampleRate;
    this.filters = []; // [lowFilter, highFilter] per pair, flattened
    for (const [lowHz, highHz] of pairs) {
      this.filters.push(new AutomatedPeakingFilter(lowHz, sampleRate, Q));
      this.filters.push(new AutomatedPeakingFilter(highHz, sampleRate, Q));
    }
  }

  processSample(x) {
    let y = x;
    for (let i = 0; i < this.filters.length; i++) {
      y = this.filters[i].processSample(y);
    }
    return y;
  }

  processBuffer(input) {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = this.processSample(input[i]);
    return out;
  }

  /**
   * Schedule the two-half self-cancelling symbol (§28) for pair `pairIndex`.
   * half=0 → first half, half=1 → second half. bit=1 uses [+,-]→[-,+];
   * bit=0 is the inverse (§28).
   */
  scheduleSymbolHalf(pairIndex, bit, half, halfDeltaDb, rampSamples) {
    const lowFilter = this.filters[pairIndex * 2];
    const highFilter = this.filters[pairIndex * 2 + 1];
    const firstHalfSign = bit ? 1 : -1; // bit1 first-half: LOW +, HIGH -
    const sign = half === 0 ? firstHalfSign : -firstHalfSign;
    lowFilter.scheduleRamp(sign * halfDeltaDb, rampSamples);
    highFilter.scheduleRamp(-sign * halfDeltaDb, rampSamples);
  }

  setAllGainsImmediate(gainDb) {
    for (const f of this.filters) f.setGainImmediate(gainDb);
  }
}
