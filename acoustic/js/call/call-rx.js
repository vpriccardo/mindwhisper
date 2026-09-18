/**
 * call-v1 RX: offline feature extractor + live microphone controller.
 */

import {
  CALL_BASE_CHANNELS,
  CALL_ENHANCEMENT_CHANNELS,
  CALL_CHANNEL_COUNT,
  CALL_FEATURE_BUFFER_SECONDS,
  CALL_PREAMBLE_CORRELATION_MIN,
  FEATURE_MS,
  EPSILON_ENERGY,
} from './call-constants.js';
import {
  designBandpass,
  createBiquadState,
  processBiquad,
} from '../dsp-biquad.js';
import { CallFrameSearcher, SyncState, decodeCallFeatureBuffer } from './call-sync.js';

function bandCentre(lo, hi) {
  return 0.5 * (lo + hi);
}

function bandWidth(lo, hi) {
  return Math.max(40, hi - lo);
}

/**
 * Main-thread feature extractor mirroring rx2-worklet (24 bands → 6+6 ratios).
 */
export class CallFeatureExtractor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.filtersA = [];
    this.filtersB = [];
    this.statesA = [];
    this.statesB = [];

    const defs = [];
    for (const ch of CALL_BASE_CHANNELS) {
      defs.push([ch[0], ch[1]], [ch[2], ch[3]]);
    }
    for (const ch of CALL_ENHANCEMENT_CHANNELS) {
      defs.push([ch[0], ch[1]], [ch[2], ch[3]]);
    }

    for (const [lo, hi] of defs) {
      const c = bandCentre(lo, hi);
      const bw = bandWidth(lo, hi);
      this.filtersA.push(designBandpass(c, sampleRate, bw * 0.85));
      this.filtersB.push(designBandpass(c, sampleRate, bw * 0.85));
      this.statesA.push(createBiquadState());
      this.statesB.push(createBiquadState());
    }

    this.energies = new Float64Array(24);
    this.blockSamples = Math.max(1, Math.round((FEATURE_MS / 1000) * sampleRate));
    this.inBlock = 0;
    this.sampleIndex = 0;
    this.features = [];
  }

  processSample(x) {
    for (let b = 0; b < 24; b++) {
      const y1 = processBiquad(x, this.filtersA[b], this.statesA[b]);
      const y = processBiquad(y1, this.filtersB[b], this.statesB[b]);
      this.energies[b] += y * y;
    }
    this.inBlock++;
    this.sampleIndex++;
    if (this.inBlock >= this.blockSamples) {
      const ratios = new Float32Array(CALL_CHANNEL_COUNT);
      const enhRatios = new Float32Array(CALL_CHANNEL_COUNT);
      for (let ch = 0; ch < CALL_CHANNEL_COUNT; ch++) {
        const eLow = this.energies[ch * 2];
        const eHigh = this.energies[ch * 2 + 1];
        ratios[ch] =
          10 * Math.log10((eLow + EPSILON_ENERGY) / (eHigh + EPSILON_ENERGY));
        const eeLow = this.energies[12 + ch * 2];
        const eeHigh = this.energies[12 + ch * 2 + 1];
        enhRatios[ch] =
          10 *
          Math.log10((eeLow + EPSILON_ENERGY) / (eeHigh + EPSILON_ENERGY));
      }
      const feat = {
        sampleIndex: this.sampleIndex,
        timestamp: (this.sampleIndex / this.sampleRate) * 1000,
        ratios: ratios.slice(),
        enhRatios: enhRatios.slice(),
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

export class CallFeatureBuffer {
  constructor(seconds = CALL_FEATURE_BUFFER_SECONDS) {
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
}

export function decodeCallPcmBuffer(samples, sampleRate, options = {}) {
  const extractor = new CallFeatureExtractor(sampleRate);
  extractor.processBuffer(samples);
  const { result, stats, searcher } = decodeCallFeatureBuffer(extractor.features, {
    threshold: options.threshold ?? CALL_PREAMBLE_CORRELATION_MIN,
  });
  return {
    result,
    stats,
    featureCount: extractor.features.length,
    features: extractor.features,
    searcher,
  };
}

export function callSignalQualityLabel(meta) {
  if (!meta) return 'Poor';
  const score = meta.preambleScore || 0;
  const q = meta.avgQuality || 0;
  const corr = meta.correctionCount || 0;
  let points = 0;
  if (score > 0.65) points += 3;
  else if (score > 0.45) points += 2;
  else if (score > 0.28) points += 1;
  if (q > 0.65) points += 2;
  else if (q > 0.35) points += 1;
  if (corr <= 3) points += 1;
  if (meta.combinedRepetitions >= 2) points += 1;
  if (points >= 6) return 'Strong';
  if (points >= 4) return 'Good';
  if (points >= 2) return 'Fair';
  return 'Poor';
}

/**
 * Live call receiver controller.
 */
export class CallReceiver {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.workletNode = null;
    this.listening = false;
    this.featureBuffer = new CallFeatureBuffer();
    this.searcher = new CallFrameSearcher({
      threshold: CALL_PREAMBLE_CORRELATION_MIN,
      onMessage: (msg) => this._onDecoded(msg),
    });
    this.state = 'idle';
    this.syncState = SyncState.SEARCH;
    this.lastMessage = null;
    this.lastMeta = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.trackSettings = null;
    this.onState = null;
    this.onMessage = null;
    this._visibilityHandler = null;
  }

  _setState(state) {
    this.state = state;
    if (this.onState) this.onState(state, this);
  }

  _onDecoded(payload) {
    this.validFrameCount += 1;
    this.lastMeta = payload;
    this.syncState = this.searcher.state;

    if (payload.duplicate && this.lastMessage === payload.message) {
      if (this.validFrameCount >= 2) this.signalConfirmed = true;
      this._setState('maintained');
      if (this.onMessage) this.onMessage(payload);
      return;
    }

    this.lastMessage = payload.message;
    this.signalConfirmed = this.validFrameCount >= 2;
    this._setState('received');
    if (this.onMessage) this.onMessage(payload);
  }

  async start() {
    if (this.listening) return;

    if (
      !window.isSecureContext &&
      location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1'
    ) {
      throw new Error('Microphone requires HTTPS (or localhost).');
    }

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: { ideal: 48000 },
        },
        video: false,
      });
    } catch (e) {
      throw new Error(
        e.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : `Microphone error: ${e.message}`
      );
    }

    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.trackSettings = track ? track.getSettings() : {};

    const workletUrl = new URL('../../audio/rx2-worklet.js', import.meta.url);
    await this.ctx.audioWorklet.addModule(workletUrl.href);

    this.source = this.ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.ctx, 'rx2-call-processor');
    this.workletNode.port.onmessage = (ev) => this._onWorkletMessage(ev.data);

    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.workletNode);
    this.workletNode.connect(mute);
    mute.connect(this.ctx.destination);

    this.featureBuffer = new CallFeatureBuffer();
    this.searcher.resetStats();
    this.listening = true;
    this.lastMessage = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.syncState = SyncState.SEARCH;
    this._setState('listening');

    this._visibilityHandler = () => {
      if (document.hidden) {
        // keep listening but surface status
        this._setState('listening');
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  _onWorkletMessage(data) {
    if (!data || data.type !== 'features') return;
    const feat = {
      sampleIndex: data.sampleIndex,
      timestamp: data.timestamp,
      ratios: Float32Array.from(data.ratios),
      enhRatios: Float32Array.from(data.enhRatios || []),
      energies: data.energies || null,
    };
    this.featureBuffer.push(feat);
    this.searcher.process(this.featureBuffer.items);
    this.syncState = this.searcher.state;
  }

  async stop() {
    this.listening = false;
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    try {
      this.workletNode?.port && (this.workletNode.port.onmessage = null);
      this.workletNode?.disconnect();
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.workletNode = null;
    this.source = null;
    if (this.stream) {
      for (const t of this.stream.getAudioTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
    this._setState('idle');
  }

  getDebugInfo() {
    return {
      syncState: this.syncState,
      stats: this.searcher.stats,
      channelQuality: Array.from(this.searcher.lastChannelQuality),
      enhChannelQuality: Array.from(this.searcher.lastEnhQuality),
      featureCount: this.featureBuffer.length,
      trackSettings: this.trackSettings,
      lastMeta: this.lastMeta,
    };
  }
}

export function isDebugMode() {
  return new URLSearchParams(location.search).get('debug') === '1';
}
