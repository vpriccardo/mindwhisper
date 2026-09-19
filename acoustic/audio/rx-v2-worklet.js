/**
 * room-v2 AudioWorklet: 16 narrow band-pass filters → 8 pair ratio features / 15 ms.
 * Mirrors createRoomV2FeatureExtractor (ROOM_V2_FEATURE_MS) on the main thread.
 */

const CHANNEL_COUNT = 8;
const WATERMARK_CHANNELS = [
  [5200, 5480],
  [5800, 6080],
  [6400, 6680],
  [7000, 7280],
  [7600, 7880],
  [8200, 8480],
  [8800, 9080],
  [9400, 9680],
];
const BANDWIDTH_HZ = 140;
const FEATURE_MS = 15;
const EPSILON = 1e-20;

function designBandpass(centreHz, sampleRate, bandwidthHz) {
  const Q = centreHz / bandwidthHz;
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

class RxV2WatermarkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.filtersA = new Array(16);
    this.filtersB = new Array(16);
    this.ax1 = new Float32Array(16);
    this.ax2 = new Float32Array(16);
    this.ay1 = new Float32Array(16);
    this.ay2 = new Float32Array(16);
    this.bx1 = new Float32Array(16);
    this.bx2 = new Float32Array(16);
    this.by1 = new Float32Array(16);
    this.by2 = new Float32Array(16);
    this.energies = new Float64Array(16);
    this.sampleIndex = 0;
    this.inBlock = 0;
    this.blockSamples = Math.max(1, Math.round((FEATURE_MS / 1000) * sampleRate));
    this.ratios = new Float32Array(CHANNEL_COUNT);

    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const [lowHz, highHz] = WATERMARK_CHANNELS[ch];
      this.filtersA[ch * 2] = designBandpass(lowHz, sampleRate, BANDWIDTH_HZ);
      this.filtersA[ch * 2 + 1] = designBandpass(highHz, sampleRate, BANDWIDTH_HZ);
      this.filtersB[ch * 2] = designBandpass(lowHz, sampleRate, BANDWIDTH_HZ);
      this.filtersB[ch * 2 + 1] = designBandpass(highHz, sampleRate, BANDWIDTH_HZ);
    }

    this.port.postMessage({
      type: 'ready',
      sampleRate,
      blockSamples: this.blockSamples,
      featureMs: FEATURE_MS,
    });
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    for (let i = 0; i < channel.length; i++) {
      const x = channel[i];
      for (let b = 0; b < 16; b++) {
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

registerProcessor('rx-v2-watermark-processor', RxV2WatermarkProcessor);
