/**
 * call-v1 carriers: broad textured beds that stay differential-stable at Δ=1.2 dB.
 *
 * Pure filtered noise alone is too ratio-noisy for ±0.6 dB; pure sines decode
 * perfectly but are codec-fragile. Blend: dominant in-band partials + light
 * shared-drive noise fill + slow phase drift.
 */

import { createXorshift32 } from '../protocol.js';
import {
  designBandpass,
  createBiquadState,
  processBiquad,
} from '../dsp-biquad.js';
import {
  CALL_BASE_CHANNELS,
  CALL_ENHANCEMENT_CHANNELS,
  CALL_CHANNEL_COUNT,
  CALL_CARRIER_SEED_DEFAULT,
} from './call-constants.js';

function bandCentre(lo, hi) {
  return 0.5 * (lo + hi);
}

function bandWidth(lo, hi) {
  return Math.max(40, hi - lo);
}

/**
 * Stateful multi-band textured carrier bank.
 */
export class CallCarrierBank {
  constructor(opts) {
    const {
      sampleRate,
      seed = CALL_CARRIER_SEED_DEFAULT,
      includeEnhancement = true,
      enhancementLevel = 0.5,
    } = opts;

    this.sampleRate = sampleRate;
    this.includeEnhancement = includeEnhancement;
    this.enhancementLevel = enhancementLevel;
    this.seed = seed >>> 0;
    this.rng = createXorshift32(this.seed);
    this.phaseRng = createXorshift32(this.seed ^ 0x9e3779b9);

    this.baseDefs = [];
    this.enhDefs = [];

    for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
      const [ll, lh, hl, hh] = CALL_BASE_CHANNELS[ch];
      this.baseDefs.push(this._makeBand(ll, lh), this._makeBand(hl, hh));
    }
    for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
      const [ll, lh, hl, hh] = CALL_ENHANCEMENT_CHANNELS[ch];
      this.enhDefs.push(this._makeBand(ll, lh), this._makeBand(hl, hh));
    }

    this.bandGain = new Float32Array(this.baseDefs.length + this.enhDefs.length);
    this.bandGain.fill(1);
    this._calibrate(Math.round(sampleRate * 1.5));
  }

  _makeBand(lo, hi) {
    const centre = bandCentre(lo, hi);
    const bw = bandWidth(lo, hi);
    const sr = this.sampleRate;
    // Three in-band partials spread across the band (not out-of-band harmonics)
    const f0 = centre - bw * 0.22;
    const f1 = centre;
    const f2 = centre + bw * 0.22;
    return {
      lo,
      hi,
      centre,
      bw,
      filtersA: designBandpass(centre, sr, bw * 0.75),
      filtersB: designBandpass(centre, sr, bw * 0.75),
      stateA: createBiquadState(),
      stateB: createBiquadState(),
      // partial phases / increments
      p0: this.phaseRng.nextFloat() * Math.PI * 2,
      p1: this.phaseRng.nextFloat() * Math.PI * 2,
      p2: this.phaseRng.nextFloat() * Math.PI * 2,
      i0: (2 * Math.PI * f0) / sr,
      i1: (2 * Math.PI * f1) / sr,
      i2: (2 * Math.PI * f2) / sr,
      // slow amplitude / phase drift
      drift: this.phaseRng.nextFloat() * Math.PI * 2,
      driftInc: (2 * Math.PI * (0.05 + this.phaseRng.nextFloat() * 0.12)) / sr,
      drift2: this.phaseRng.nextFloat() * Math.PI * 2,
      drift2Inc: (2 * Math.PI * (0.02 + this.phaseRng.nextFloat() * 0.06)) / sr,
    };
  }

  _calibrate(warmup) {
    const all = this.baseDefs.concat(this.enhDefs);
    const acc = new Float64Array(all.length);
    for (let i = 0; i < warmup; i++) {
      const drive = this.rng.nextGaussian();
      for (let b = 0; b < all.length; b++) {
        const y = this._processBand(all[b], drive, false);
        acc[b] += y * y;
      }
    }
    for (let b = 0; b < all.length; b++) {
      const rms = Math.sqrt(acc[b] / warmup);
      this.bandGain[b] = rms > 1e-12 ? 1 / rms : 1;
      all[b].stateA = createBiquadState();
      all[b].stateB = createBiquadState();
    }
    // Pair-balance neutral ratios
    for (let p = 0; p < all.length; p += 2) {
      const geo = Math.sqrt(this.bandGain[p] * this.bandGain[p + 1]);
      this.bandGain[p] = geo;
      this.bandGain[p + 1] = geo;
    }
    this.rng = createXorshift32((this.seed ^ 0x51f00d) >>> 0);
  }

  _processBand(band, drive, advancePhase = true) {
    // Keep texture mostly tonal — heavy noise fill makes some seeds
    // (esp. channels 2/4) ratio-unstable even at high Δ.
    const am =
      0.97 +
      0.03 * Math.sin(band.drift) +
      0.02 * Math.sin(band.drift2);
    const partials =
      Math.sin(band.p1) * 0.82 +
      Math.sin(band.p0) * 0.12 +
      Math.sin(band.p2) * 0.12;

    const y1 = processBiquad(drive, band.filtersA, band.stateA);
    const noise = processBiquad(y1, band.filtersB, band.stateB);

    if (advancePhase) {
      band.p0 += band.i0;
      band.p1 += band.i1;
      band.p2 += band.i2;
      band.drift += band.driftInc;
      band.drift2 += band.drift2Inc;
    }
    return partials * am + noise * 0.06;
  }

  next(baseOut, enhOut = null) {
    const drive = this.rng.nextGaussian();
    for (let b = 0; b < this.baseDefs.length; b++) {
      baseOut[b] =
        this._processBand(this.baseDefs[b], drive) * this.bandGain[b];
    }
    if (enhOut && this.includeEnhancement) {
      const off = this.baseDefs.length;
      for (let b = 0; b < this.enhDefs.length; b++) {
        enhOut[b] =
          this._processBand(this.enhDefs[b], drive) *
          this.bandGain[off + b] *
          this.enhancementLevel;
      }
    } else if (enhOut) {
      enhOut.fill(0);
    }
  }
}
