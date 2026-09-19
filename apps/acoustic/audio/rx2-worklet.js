/**
 * call-v1 AudioWorklet: 24 band-pass energies → 6 base + 6 enhancement ratios / ~20ms.
 * Posts features only — never raw PCM.
 */

const CHANNEL_COUNT = 6;
const FEATURE_MS = 20;
const EPSILON = 1e-20;

const BASE_CHANNELS = [
  [620, 760, 800, 940],
  [1000, 1140, 1180, 1320],
  [1380, 1520, 1560, 1700],
  [1780, 1940, 1980, 2140],
  [2220, 2400, 2440, 2620],
  [2700, 2920, 2960, 3180],
];

/** Must match CALL_ENHANCEMENT_CHANNELS in js/call/call-constants.js */
const ENH_CHANNELS = [
  [3800, 4020, 4100, 4320],
  [4450, 4670, 4770, 4990],
  [5120, 5360, 5460, 5700],
  [5840, 6080, 6200, 6440],
  [6580, 6820, 6940, 7180],
  [7300, 7540, 7660, 7900],
];

function designBandpass(centreHz, sampleRate, bandwidthHz) {
  const Q = centreHz / Math.max(1, bandwidthHz);
  const w0 = (2 * Math.PI * centreHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

function bandDefs() {
  const defs = [];
  for (const ch of BASE_CHANNELS) {
    defs.push([ch[0], ch[1]], [ch[2], ch[3]]);
  }
  for (const ch of ENH_CHANNELS) {
    defs.push([ch[0], ch[1]], [ch[2], ch[3]]);
  }
  return defs;
}

class Rx2CallProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const defs = bandDefs();
    const n = defs.length; // 24
    this.n = n;
    this.filtersA = new Array(n);
    this.filtersB = new Array(n);
    this.ax1 = new Float32Array(n);
    this.ax2 = new Float32Array(n);
    this.ay1 = new Float32Array(n);
    this.ay2 = new Float32Array(n);
    this.bx1 = new Float32Array(n);
    this.bx2 = new Float32Array(n);
    this.by1 = new Float32Array(n);
    this.by2 = new Float32Array(n);
    this.energies = new Float64Array(n);
    this.sampleIndex = 0;
    this.inBlock = 0;
    this.blockSamples = Math.max(1, Math.round((FEATURE_MS / 1000) * sampleRate));
    this.ratios = new Float32Array(CHANNEL_COUNT);
    this.enhRatios = new Float32Array(CHANNEL_COUNT);

    for (let i = 0; i < n; i++) {
      const [lo, hi] = defs[i];
      const centre = 0.5 * (lo + hi);
      const bw = Math.max(40, hi - lo) * 0.85;
      this.filtersA[i] = designBandpass(centre, sampleRate, bw);
      this.filtersB[i] = designBandpass(centre, sampleRate, bw);
    }

    this.port.postMessage({
      type: 'ready',
      sampleRate,
      blockSamples: this.blockSamples,
      bands: n,
    });
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    for (let i = 0; i < channel.length; i++) {
      const x = channel[i];
      for (let b = 0; b < this.n; b++) {
        const ca = this.filtersA[b];
        const y1 =
          ca.b0 * x +
          ca.b1 * this.ax1[b] +
          ca.b2 * this.ax2[b] -
          ca.a1 * this.ay1[b] -
          ca.a2 * this.ay2[b];
        this.ax2[b] = this.ax1[b];
        this.ax1[b] = x;
        this.ay2[b] = this.ay1[b];
        this.ay1[b] = y1;

        const cb = this.filtersB[b];
        const y =
          cb.b0 * y1 +
          cb.b1 * this.bx1[b] +
          cb.b2 * this.bx2[b] -
          cb.a1 * this.by1[b] -
          cb.a2 * this.by2[b];
        this.bx2[b] = this.bx1[b];
        this.bx1[b] = y1;
        this.by2[b] = this.by1[b];
        this.by1[b] = y;
        this.energies[b] += y * y;
      }
      this.inBlock++;
      this.sampleIndex++;

      if (this.inBlock >= this.blockSamples) {
        for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
          const eLow = this.energies[ch * 2];
          const eHigh = this.energies[ch * 2 + 1];
          this.ratios[ch] =
            10 * Math.log10((eLow + EPSILON) / (eHigh + EPSILON));
          const eeLow = this.energies[12 + ch * 2];
          const eeHigh = this.energies[12 + ch * 2 + 1];
          this.enhRatios[ch] =
            10 * Math.log10((eeLow + EPSILON) / (eeHigh + EPSILON));
        }
        this.port.postMessage({
          type: 'features',
          sampleIndex: this.sampleIndex,
          timestamp: (this.sampleIndex / sampleRate) * 1000,
          ratios: Array.from(this.ratios),
          enhRatios: Array.from(this.enhRatios),
          energies: Array.from(this.energies),
        });
        this.energies.fill(0);
        this.inBlock = 0;
      }
    }
    return true;
  }
}

registerProcessor('rx2-call-processor', Rx2CallProcessor);
