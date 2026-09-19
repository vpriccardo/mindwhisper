/**
 * call-v2 AudioWorklet: 12 band-pass energies → 6 low/high ratios / 10 ms.
 * Mirrors CallV2FeatureExtractor on the main thread.
 */

const CHANNEL_COUNT = 6;
const FEATURE_MS = 10;
const EPSILON = 1e-20;
const Q = 3.0;

const PAIRS = [
  [220, 300],
  [340, 420],
  [460, 560],
  [620, 740],
  [820, 960],
  [1080, 1260],
];

function designBandpass(centreHz, sampleRate, bandwidthHz) {
  const q = centreHz / Math.max(1, bandwidthHz);
  const w0 = (2 * Math.PI * centreHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
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

class Rx2V2CallProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const n = CHANNEL_COUNT * 2;
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

    for (let p = 0; p < CHANNEL_COUNT; p++) {
      const [lowHz, highHz] = PAIRS[p];
      this.filtersA[p * 2] = designBandpass(lowHz, sampleRate, lowHz / Q);
      this.filtersA[p * 2 + 1] = designBandpass(highHz, sampleRate, highHz / Q);
      this.filtersB[p * 2] = designBandpass(lowHz, sampleRate, lowHz / Q);
      this.filtersB[p * 2 + 1] = designBandpass(highHz, sampleRate, highHz / Q);
    }

    this.port.postMessage({
      type: 'ready',
      sampleRate,
      blockSamples: this.blockSamples,
      featureMs: FEATURE_MS,
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
        for (let p = 0; p < CHANNEL_COUNT; p++) {
          const eLow = this.energies[p * 2];
          const eHigh = this.energies[p * 2 + 1];
          this.ratios[p] =
            10 * Math.log10((eLow + EPSILON) / (eHigh + EPSILON));
        }
        this.port.postMessage({
          type: 'features',
          sampleIndex: this.sampleIndex,
          timestamp: (this.sampleIndex / sampleRate) * 1000,
          ratios: Array.from(this.ratios),
        });
        this.energies.fill(0);
        this.inBlock = 0;
      }
    }
    return true;
  }
}

registerProcessor('rx2-v2-call-processor', Rx2V2CallProcessor);
