/**
 * Call TX UI controller — call-v2 (Meditation default) or call-v1 additive carrier.
 */

import {
  isValidMessage,
  MAX_MESSAGE_LEN,
} from '../protocol.js';
import {
  BASE_TOTAL_DIFFERENTIAL_DB,
  BASE_DELTA_DB_OPTIONS,
  CALL_FRAME_MS,
  CALL_CONSTANTS,
} from './call-constants.js';
import {
  CallContinuousTransmitter,
  renderCallTransmission,
} from './call-tx.js';
import {
  CallV2ContinuousTransmitter,
  renderCallV2Transmission,
  callV2DepthDb,
} from './call-v2-tx.js';
import {
  CALL_V2_DEPTH_ORDER,
  CALL_V2_DEPTH_LABELS,
  CALL_V2_DEPTH_DESCRIPTIONS,
  CALL_V2_DEFAULT_DEPTH,
  CALL_V2_SPEED_ORDER,
  CALL_V2_SPEED_LABELS,
  CALL_V2_DEFAULT_SPEED,
  callV2SymbolMsForSpeed,
} from './call-v2-constants.js';
import {
  CALL_AMBIENT_PROFILES,
  DEBUG_CALL_AMBIENT_PROFILES,
  DEFAULT_CALL_AMBIENT_PROFILE,
  CALL_PROFILE_IDS,
  ALL_CALL_PROFILE_IDS,
} from './call-ambient.js';
import {
  preloadMeditationAudio,
  getMeditationLoadMeta,
  decodeMeditationBuffer,
} from '../meditation-audio.js';
import {
  ACOUSTIC_CONFIG,
  CALL_PRESET_ORDER,
  formatRelativeDb,
  callLevelsForPreset,
  getProtocolVersion,
  isDebugMode,
} from '../acoustic-config.js';

export { isDebugMode, getProtocolVersion };

export {
  preloadMeditationAudio,
  getMeditationLoadMeta,
  ACOUSTIC_CONFIG,
  CALL_PRESET_ORDER,
  formatRelativeDb,
  callLevelsForPreset,
  CALL_V2_DEPTH_ORDER,
  CALL_V2_DEPTH_LABELS,
  CALL_V2_DEPTH_DESCRIPTIONS,
  CALL_V2_DEFAULT_DEPTH,
  CALL_V2_SPEED_ORDER,
  CALL_V2_SPEED_LABELS,
  CALL_V2_DEFAULT_SPEED,
  callV2SymbolMsForSpeed,
  callV2DepthDb,
};

function usesCallV2(profileId, protocolVersion) {
  return protocolVersion !== 'v1' && profileId === 'meditation';
}

export class CallTransmitter {
  constructor() {
    this.protocolVersion = getProtocolVersion();
    this.v1Engine = new CallContinuousTransmitter();
    this.v2Engine = new CallV2ContinuousTransmitter();
    this.deltaDb = BASE_TOTAL_DIFFERENTIAL_DB;
    this.profileId = DEFAULT_CALL_AMBIENT_PROFILE;
    this.watermarkEnabled = true;
    this.lastMeta = null;
    this.onState = null;
    this._wireEngine(this.v1Engine);
    this._wireEngine(this.v2Engine);
  }

  _wireEngine(eng) {
    eng.onState = (state) => {
      if (this.onState && eng === this.engine) this.onState(state, this);
    };
  }

  get engine() {
    return usesCallV2(this.profileId, this.protocolVersion) ? this.v2Engine : this.v1Engine;
  }

  get isCallV2() {
    return usesCallV2(this.profileId, this.protocolVersion);
  }

  get protocolLabel() {
    return this.isCallV2 ? 'call-v2' : 'call-v1';
  }

  get playing() {
    return this.v1Engine.playing || this.v2Engine.playing;
  }

  async unlockAudio() {
    return this.engine.unlockAudio();
  }

  async ensureContext() {
    return this.engine.ensureContext();
  }

  validate(message) {
    return isValidMessage(message);
  }

  setProfile(id) {
    if (this.playing) return;
    this.v1Engine.setProfile(id);
    this.v2Engine.setProfile?.(id);
    this.profileId = this.v1Engine.profileId;
  }

  setAmbientDebug(debug) {
    if (this.playing) return;
    this.v1Engine.setAmbientDebug(debug);
  }

  setDeltaDb(db) {
    if (!BASE_DELTA_DB_OPTIONS.includes(db)) {
      throw new Error(`Invalid delta ${db}`);
    }
    this.deltaDb = db;
    this.v1Engine.setDeltaDb(db);
  }

  setDepth(depthId) {
    this.v2Engine.setDepth(depthId);
  }

  setSpeed(speedId) {
    if (this.isCallV2) {
      this.v2Engine.setSpeed(speedId);
    }
  }

  setWatermarkEnabled(on) {
    this.watermarkEnabled = !!on;
    this.v1Engine.setWatermarkEnabled(this.watermarkEnabled);
    this.v2Engine.setWatermarkEnabled(this.watermarkEnabled);
  }

  setMusicGain(g) {
    this.v1Engine.setMusicGain(g);
    this.v2Engine.setMusicGain(g);
  }

  setCrossfadeSeconds(s) {
    this.v1Engine.setCrossfadeSeconds(s);
    this.v2Engine.setCrossfadeSeconds(s);
  }

  setMusicOnly(on) {
    this.v1Engine.setMusicOnly(on);
    this.v2Engine.setMusicOnly(on);
  }

  setCallPreset(presetId) {
    this.v1Engine.setCallPreset(presetId);
  }

  async play(message) {
    const check = this.validate(message);
    if (!check.ok) throw new Error(check.error);

    if (this.isCallV2) {
      this.v2Engine.watermarkEnabled = this.watermarkEnabled;
      await this.v2Engine.start(message);
      this.lastMeta = {
        protocol: 'call-v2',
        encoded: this.v2Engine.encoded,
        profileId: this.profileId,
        sampleRate: this.v2Engine.ctx.sampleRate,
        frameMs: this.v2Engine.frameSymbols
          ? this.v2Engine.frameSymbols.length * this.v2Engine.symbolMs
          : null,
        watermarkEnabled: this.watermarkEnabled,
      };
      return this.lastMeta;
    }

    this.v1Engine.profileId = this.profileId;
    this.v1Engine.deltaDb = this.deltaDb;
    this.v1Engine.watermarkEnabled = this.watermarkEnabled;
    await this.v1Engine.start(message);
    this.lastMeta = {
      protocol: 'call-v1',
      encoded: this.v1Engine.renderer?.encoded,
      deltaDb: this.deltaDb,
      profileId: this.profileId,
      sampleRate: this.v1Engine.ctx.sampleRate,
      frameMs: CALL_FRAME_MS,
      watermarkEnabled: this.watermarkEnabled,
    };
    return this.lastMeta;
  }

  async stop() {
    await Promise.all([
      this.v1Engine.playing ? this.v1Engine.stop() : null,
      this.v2Engine.playing ? this.v2Engine.stop() : null,
    ]);
  }

  /** Offline render for A/B comparison in debug */
  async renderOffline(message, { neutral = false } = {}) {
    const ctx = await this.engine.ensureContext();
    if (this.isCallV2) {
      const decoded = await decodeMeditationBuffer(ctx);
      const ch = decoded.buffer.getChannelData(0);
      return renderCallV2Transmission({
        message,
        sampleRate: ctx.sampleRate,
        musicSamples: ch,
        frameCount: 1,
        neutral,
        watermarkEnabled: !neutral,
      });
    }
    return renderCallTransmission({
      message,
      sampleRate: ctx.sampleRate,
      profileId: this.profileId,
      deltaDb: this.deltaDb,
      neutral,
      watermarkEnabled: !neutral,
      frameCount: 1,
    });
  }

  getDebugInfo() {
    const info = this.engine.getDebugInfo();
    return { ...info, protocol: this.protocolLabel };
  }
}

export {
  MAX_MESSAGE_LEN,
  BASE_DELTA_DB_OPTIONS,
  BASE_TOTAL_DIFFERENTIAL_DB,
  CALL_AMBIENT_PROFILES,
  DEBUG_CALL_AMBIENT_PROFILES,
  DEFAULT_CALL_AMBIENT_PROFILE,
  CALL_PROFILE_IDS,
  ALL_CALL_PROFILE_IDS,
  CALL_CONSTANTS,
  CALL_FRAME_MS,
  renderCallTransmission,
};
