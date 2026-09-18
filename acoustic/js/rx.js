/**
 * Room-v1 receiver controller: microphone → AudioWorklet → feature buffer → decode.
 * Used by rx.html only. Call channel uses js/call/call-rx.js + rx2.html — do not merge.
 */

import {
  PREAMBLE_CORRELATION_MIN,
  FEATURE_BUFFER_SECONDS,
} from './protocol.js';
import {
  FeatureBuffer,
  FrameSearcher,
  signalQualityLabel,
} from './rx-decoder.js';

export function isDebugMode() {
  return new URLSearchParams(location.search).get('debug') === '1';
}

export class Receiver {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.workletNode = null;
    this.listening = false;
    this.featureBuffer = new FeatureBuffer(FEATURE_BUFFER_SECONDS);
    this.searcher = new FrameSearcher({
      threshold: PREAMBLE_CORRELATION_MIN,
      onMessage: (msg) => this._onDecoded(msg),
    });
    this.state = 'idle';
    this.lastMessage = null;
    this.lastMeta = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.trackSettings = null;
    this.workletSampleRate = null;
    this.onState = null;
    this.onMessage = null;
    this._visibilityHandler = null;
    this.testStartPerf = null;
    this.firstValidMs = null;
  }

  _setState(state) {
    this.state = state;
    if (this.onState) this.onState(state, this);
  }

  /** Reset calibration counters only — keep mic / decoder thresholds. */
  resetTestCounters() {
    this.testStartPerf = performance.now();
    this.firstValidMs = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.lastMessage = null;
    this.lastMeta = null;
    this.searcher.resetStats();
  }

  getReceiverStateLabel() {
    if (this.state === 'received' || this.state === 'maintained' || this.signalConfirmed) {
      return 'CONFIRMED';
    }
    if (this.state === 'decoding') return 'TRACK';
    if (this.listening) return 'SEARCH';
    return 'IDLE';
  }

  getTestDiagnostics() {
    const s = this.searcher.stats;
    return {
      receiverState: this.getReceiverStateLabel(),
      timeToFirstValidMs: this.firstValidMs,
      validFrames: s.framesCrcValid,
      failedFrames: s.framesCrcFailed,
      lastSignalQuality: this.getSignalQuality(),
      hammingCorrections: s.lastHammingCorrections,
    };
  }

  _onDecoded(payload) {
    this.validFrameCount += 1;
    this.lastMeta = payload;
    if (this.testStartPerf != null && this.firstValidMs == null && payload.crcValid !== false) {
      // Prefer CRC-valid messages for first-decode timing
      if (!payload.duplicate || !this.lastMessage) {
        this.firstValidMs = performance.now() - this.testStartPerf;
      }
    }
    if (
      this.testStartPerf != null &&
      this.firstValidMs == null &&
      payload.message &&
      !payload.error
    ) {
      this.firstValidMs = performance.now() - this.testStartPerf;
    }

    if (payload.duplicate && this.lastMessage === payload.message) {
      if (this.validFrameCount >= 2) this.signalConfirmed = true;
      // Stay on received; UI can show calm "Signal maintained" without re-animating.
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

    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      throw new Error('Microphone requires HTTPS (or localhost).');
    }

    this.testStartPerf = performance.now();
    this.firstValidMs = null;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

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

    const workletUrl = new URL('../audio/rx-worklet.js', import.meta.url);
    await this.ctx.audioWorklet.addModule(workletUrl.href);

    this.source = this.ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.ctx, 'rx-watermark-processor');
    this.workletNode.port.onmessage = (ev) => this._onWorkletMessage(ev.data);
    // Keep graph alive; worklet has no audio output needed
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.workletNode);
    this.workletNode.connect(mute);
    mute.connect(this.ctx.destination);

    this.featureBuffer = new FeatureBuffer(FEATURE_BUFFER_SECONDS);
    this.searcher.resetStats();
    this.listening = true;
    this.lastMessage = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this._setState('listening');

    this._visibilityHandler = () => {
      if (document.hidden) {
        // Keep listening but note foreground recommendation; do not auto-stop
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
    window.addEventListener('pagehide', this._pageHide = () => this.stop());
  }

  _onWorkletMessage(data) {
    if (!data) return;
    if (data.type === 'ready') {
      this.workletSampleRate = data.sampleRate;
      return;
    }
    if (data.type !== 'features') return;

    this.featureBuffer.push({
      sampleIndex: data.sampleIndex,
      timestamp: data.timestamp,
      ratios: Float32Array.from(data.ratios),
    });

    if (this.state === 'listening' || this.state === 'possible' || this.state === 'decoding') {
      const score = this.searcher.stats.bestPreambleScore;
      if (score >= PREAMBLE_CORRELATION_MIN * 0.8 && this.state === 'listening') {
        this._setState('possible');
      }
    }

    const before = this.searcher.stats.framesDetected;
    const result = this.searcher.process(this.featureBuffer.items);
    if (this.searcher.stats.framesDetected > before && this.state !== 'received') {
      this._setState('decoding');
    }
    // result handled via onMessage callback when CRC ok
    void result;
  }

  async stop() {
    this.listening = false;
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._pageHide) {
      window.removeEventListener('pagehide', this._pageHide);
      this._pageHide = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        /* ignore */
      }
      this.workletNode = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
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

  listenAgain() {
    this.lastMessage = null;
    this.lastMeta = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.searcher.resetStats();
    this.featureBuffer = new FeatureBuffer(FEATURE_BUFFER_SECONDS);
    if (this.listening) this._setState('listening');
  }

  getSignalQuality() {
    return signalQualityLabel(this.lastMeta || {
      preambleScore: this.searcher.stats.bestPreambleScore,
    });
  }

  getDebugInfo() {
    const s = this.searcher.stats;
    return {
      audioContextSampleRate: this.ctx?.sampleRate ?? null,
      workletSampleRate: this.workletSampleRate,
      trackSettings: this.trackSettings,
      supportedConstraints: navigator.mediaDevices?.getSupportedConstraints?.() || null,
      preambleCorrelation: s.bestPreambleScore,
      framesDetected: s.framesDetected,
      framesCrcValid: s.framesCrcValid,
      framesCrcFailed: s.framesCrcFailed,
      lastMessage: s.lastMessage,
      validFrameCount: this.validFrameCount,
      signalConfirmed: this.signalConfirmed,
      hammingCorrections: s.lastHammingCorrections,
      combinedAttempts: s.combinedAttempts,
      featureCount: this.featureBuffer.length,
      lastCalibration: this.lastMeta?.calibration || null,
      lastPreambleScore: this.lastMeta?.preambleScore ?? null,
      avgChannelQuality: this.lastMeta?.avgQuality ?? null,
      softBitMetrics: this.lastMeta?.softScrambled
        ? summarizeSoft(this.lastMeta.softScrambled)
        : null,
      signalQuality: this.getSignalQuality(),
    };
  }
}

function summarizeSoft(soft) {
  let absMean = 0;
  let pos = 0;
  for (let i = 0; i < soft.length; i++) {
    absMean += Math.abs(soft[i]);
    if (soft[i] > 0) pos++;
  }
  return {
    absMean: absMean / soft.length,
    positiveFraction: pos / soft.length,
    length: soft.length,
  };
}
