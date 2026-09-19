/**
 * Room receiver controller: microphone → AudioWorklet → feature buffer → decode.
 * Default: room-v2. ?protocol=v1 selects frozen room-v1 path.
 * Used by rx.html only. Call channel uses js/call/call-rx.js + rx2.html.
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
import {
  RoomV2FeatureBuffer,
  RoomV2FrameSearcher,
  roomV2SignalQualityLabel,
} from './room-v2/room-v2-rx.js';
import {
  ROOM_V2_PREAMBLE_CORRELATION_MIN,
  ROOM_V2_FEATURE_BUFFER_SECONDS,
  roomV2SymbolMsForSpeed,
} from './room-v2/room-v2-constants.js';
import {
  RX_SENSITIVITY,
  RX_SENSITIVITY_ORDER,
  rxThresholdMultiplierForSensitivity,
  getProtocolVersion,
  isDebugMode,
} from './acoustic-config.js';

export { isDebugMode, getProtocolVersion, RX_SENSITIVITY, RX_SENSITIVITY_ORDER };

export class Receiver {
  constructor() {
    this.protocolVersion = getProtocolVersion();
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.workletNode = null;
    this.listening = false;
    this.sensitivity = RX_SENSITIVITY.defaultPreset;
    this.state = 'idle';
    this.lastMessage = null;
    this.lastMeta = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.trackSettings = null;
    this.workletSampleRate = null;
    this.detectedSpeedId = null;
    this.detectedSymbolMs = null;
    this.onState = null;
    this.onMessage = null;
    this.onPartial = null;
    this.lastPartial = null;
    this._visibilityHandler = null;
    this.testStartPerf = null;
    this.firstValidMs = null;
    this._initDecoder();
  }

  _initDecoder() {
    if (this.protocolVersion === 'v2') {
      this.featureBuffer = new RoomV2FeatureBuffer(ROOM_V2_FEATURE_BUFFER_SECONDS);
      this.searcher = new RoomV2FrameSearcher({
        threshold:
          ROOM_V2_PREAMBLE_CORRELATION_MIN *
          rxThresholdMultiplierForSensitivity(this.sensitivity),
        onMessage: (msg) => this._onDecoded(msg),
        onPartial: (partial) => this._onPartial(partial),
      });
    } else {
      this.featureBuffer = new FeatureBuffer(FEATURE_BUFFER_SECONDS);
      this.searcher = new FrameSearcher({
        threshold:
          PREAMBLE_CORRELATION_MIN * rxThresholdMultiplierForSensitivity(this.sensitivity),
        onMessage: (msg) => this._onDecoded(msg),
      });
    }
  }

  get protocolLabel() {
    return this.protocolVersion === 'v2' ? 'room-v2' : 'room-v1';
  }

  _setState(state) {
    this.state = state;
    if (this.onState) this.onState(state, this);
  }

  /** Change frame-detection sensitivity (live). Higher = stricter threshold. */
  setSensitivity(id) {
    if (!RX_SENSITIVITY.multipliers[id]) return;
    this.sensitivity = id;
    const min =
      this.protocolVersion === 'v2'
        ? ROOM_V2_PREAMBLE_CORRELATION_MIN
        : PREAMBLE_CORRELATION_MIN;
    this.searcher.threshold = min * rxThresholdMultiplierForSensitivity(id);
  }

  /** Reset calibration counters only — keep mic / decoder thresholds. */
  resetTestCounters() {
    this.testStartPerf = performance.now();
    this.firstValidMs = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.lastMessage = null;
    this.lastPartial = null;
    this.lastMeta = null;
    this.detectedSpeedId = null;
    this.detectedSymbolMs = null;
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
    const base = {
      protocol: this.protocolLabel,
      receiverState: this.getReceiverStateLabel(),
      sensitivity: this.sensitivity,
      timeToFirstValidMs: this.firstValidMs,
      validFrames: s.framesCrcValid,
      failedFrames: s.framesCrcFailed,
      lastSignalQuality: this.getSignalQuality(),
    };
    if (this.protocolVersion === 'v2') {
      return {
        ...base,
        frameDurationMs: this.detectedSymbolMs,
        detectedSpeed: this.detectedSpeedId,
        rsCorrections: s.rsCorrections ?? 0,
        rsErasures: s.rsErasures ?? 0,
        crcFailures: s.framesCrcFailed,
        combinedAttempts: s.combinedAttempts ?? 0,
        combineTries: s.combineTries ?? 0,
        pendingFrames: s.pendingFrames ?? this.searcher?.pendingFrames?.length ?? 0,
        bestPreambleScore: s.bestPreambleScore ?? 0,
        featureCount: this.featureBuffer?.items?.length ?? 0,
        partialPreview: this.lastPartial?.preview ?? null,
        partialKnown: this.lastPartial?.knownCount ?? 0,
        aec: this.trackSettings?.echoCancellation,
        agc: this.trackSettings?.autoGainControl,
        ns: this.trackSettings?.noiseSuppression,
        sampleRate: this.trackSettings?.sampleRate ?? this.workletSampleRate,
      };
    }
    return {
      ...base,
      hammingCorrections: s.lastHammingCorrections,
    };
  }

  _onPartial(partial) {
    if (!partial?.preview) return;
    this.lastPartial = partial;
    if (this.onPartial) this.onPartial(partial);
  }

  _onDecoded(payload) {
    this.validFrameCount += 1;
    this.lastMeta = payload;
    if (payload.speedId) {
      this.detectedSpeedId = payload.speedId;
      this.detectedSymbolMs =
        payload.symbolMs ?? roomV2SymbolMsForSpeed(payload.speedId);
    }
    if (typeof console !== 'undefined' && isDebugMode()) {
      console.log('[rx] decoded', {
        message: payload.message,
        duplicate: payload.duplicate,
        speedId: payload.speedId,
        preambleScore: payload.preambleScore,
        corrections: payload.correctionCount,
        erasures: payload.erasureCount,
        validFrameCount: this.validFrameCount,
      });
    }
    if (this.testStartPerf != null && this.firstValidMs == null && payload.crcValid !== false) {
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
      this._setState('maintained');
      if (this.onMessage) this.onMessage(payload);
      return;
    }

    this.lastMessage = payload.message;
    this.lastPartial = null;
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
      // Prefer raw capture. On iOS, constraining sampleRate/AGC can silently
      // fall back to a voice-processing path that cancels the other phone.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (e) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (e2) {
        throw new Error(
          e.name === 'NotAllowedError' || e2.name === 'NotAllowedError'
            ? 'Microphone permission denied.'
            : `Microphone error: ${e2.message || e.message}`
        );
      }
    }

    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.trackSettings = track ? track.getSettings() : {};
    // Re-assert unconstrained capture when the UA exposes the setters (Safari).
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        });
        this.trackSettings = track.getSettings();
      } catch {
        /* ignore — not all UAs allow flipping AEC after open */
      }
    }

    const isV2 = this.protocolVersion === 'v2';
    const workletPath = isV2 ? '../audio/rx-v2-worklet.js' : '../audio/rx-worklet.js';
    const processorName = isV2 ? 'rx-v2-watermark-processor' : 'rx-watermark-processor';
    const workletUrl = new URL(workletPath, import.meta.url);
    await this.ctx.audioWorklet.addModule(workletUrl.href);

    this.source = this.ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.ctx, processorName);
    this.workletNode.port.onmessage = (ev) => this._onWorkletMessage(ev.data);
    // Keep the graph alive WITHOUT routing mic→speakers. Connecting the mic
    // path to ctx.destination (even at gain 0) can enable iOS voice-processing
    // / AEC, which cancels the other phone's watermark as "echo".
    this._graphSink = this.ctx.createMediaStreamDestination();
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.workletNode);
    this.workletNode.connect(mute);
    mute.connect(this._graphSink);
    // Silent keepalive → real destination so WebKit keeps rendering the
    // AudioContext / worklet without putting the mic in the speaker graph.
    this._keepalive = this.ctx.createOscillator();
    this._keepalive.frequency.value = 1;
    const keepGain = this.ctx.createGain();
    keepGain.gain.value = 0;
    this._keepalive.connect(keepGain);
    keepGain.connect(this.ctx.destination);
    try {
      this._keepalive.start();
    } catch {
      /* already started */
    }
    this._keepGain = keepGain;

    this._initDecoder();
    this.searcher.resetStats();
    this.listening = true;
    this.lastMessage = null;
    this.lastPartial = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.detectedSpeedId = null;
    this.detectedSymbolMs = null;
    this._setState('listening');

    this._visibilityHandler = () => {
      if (document.hidden) {
        /* keep listening */
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

    const dropped = this.featureBuffer.push({
      sampleIndex: data.sampleIndex,
      timestamp: data.timestamp,
      ratios: Float32Array.from(data.ratios),
    });
    if (dropped && this.searcher?.rebaseDropped) {
      this.searcher.rebaseDropped(dropped);
    }

    if (this.protocolVersion === 'v1') {
      if (this.state === 'listening' || this.state === 'possible' || this.state === 'decoding') {
        const score = this.searcher.stats.bestPreambleScore;
        if (score >= PREAMBLE_CORRELATION_MIN * 0.8 && this.state === 'listening') {
          this._setState('possible');
        }
      }
    } else if (this.protocolVersion === 'v2') {
      const score = this.searcher.stats.bestPreambleScore;
      if (
        this.state === 'listening' &&
        score >= ROOM_V2_PREAMBLE_CORRELATION_MIN * 0.8
      ) {
        this._setState('possible');
      }
    }

    const before = this.searcher.stats.framesDetected;
    const result = this.searcher.process(this.featureBuffer.items);
    if (this.searcher.stats.framesDetected > before && this.state !== 'received') {
      this._setState('decoding');
    }
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
    if (this._keepalive) {
      try {
        this._keepalive.stop();
        this._keepalive.disconnect();
      } catch {
        /* ignore */
      }
      this._keepalive = null;
    }
    if (this._keepGain) {
      try {
        this._keepGain.disconnect();
      } catch {
        /* ignore */
      }
      this._keepGain = null;
    }
    this._graphSink = null;
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
    this.lastPartial = null;
    this.lastMeta = null;
    this.validFrameCount = 0;
    this.signalConfirmed = false;
    this.detectedSpeedId = null;
    this.detectedSymbolMs = null;
    this.searcher.resetStats();
    if (this.protocolVersion === 'v2') {
      this.featureBuffer = new RoomV2FeatureBuffer(ROOM_V2_FEATURE_BUFFER_SECONDS);
    } else {
      this.featureBuffer = new FeatureBuffer(FEATURE_BUFFER_SECONDS);
    }
    if (this.listening) this._setState('listening');
  }

  getSignalQuality() {
    if (this.protocolVersion === 'v2') {
      return roomV2SignalQualityLabel(
        this.lastMeta || { preambleScore: this.searcher.stats.bestPreambleScore }
      );
    }
    return signalQualityLabel(
      this.lastMeta || { preambleScore: this.searcher.stats.bestPreambleScore }
    );
  }

  getDebugInfo() {
    const s = this.searcher.stats;
    const common = {
      protocol: this.protocolLabel,
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
      featureCount: this.featureBuffer.length,
      lastPreambleScore: this.lastMeta?.preambleScore ?? null,
      avgChannelQuality: this.lastMeta?.avgQuality ?? null,
      signalQuality: this.getSignalQuality(),
      receiverState: this.getReceiverStateLabel(),
    };
    if (this.protocolVersion === 'v2') {
      return {
        ...common,
        detectedSpeedId: this.detectedSpeedId,
        detectedSymbolMs: this.detectedSymbolMs,
        rsCorrections: s.rsCorrections ?? 0,
        rsErasures: s.rsErasures ?? 0,
        lastCorrectionCount: this.lastMeta?.correctionCount ?? null,
        lastErasureCount: this.lastMeta?.erasureCount ?? null,
      };
    }
    return {
      ...common,
      hammingCorrections: s.lastHammingCorrections,
      combinedAttempts: s.combinedAttempts,
      lastCalibration: this.lastMeta?.calibration || null,
      softBitMetrics: this.lastMeta?.softScrambled
        ? summarizeSoft(this.lastMeta.softScrambled)
        : null,
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
