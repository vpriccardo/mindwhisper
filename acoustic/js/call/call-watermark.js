/**
 * call-v1 TX UI controller wrapper.
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
  CALL_AMBIENT_PROFILES,
  DEBUG_CALL_AMBIENT_PROFILES,
  DEFAULT_CALL_AMBIENT_PROFILE,
  CALL_PROFILE_IDS,
  ALL_CALL_PROFILE_IDS,
} from './call-ambient.js';
import { preloadMeditationAudio, getMeditationLoadMeta } from '../meditation-audio.js';
import {
  ACOUSTIC_CONFIG,
  CALL_PRESET_ORDER,
  formatRelativeDb,
  callLevelsForPreset,
} from '../acoustic-config.js';

export function isDebugMode() {
  return new URLSearchParams(location.search).get('debug') === '1';
}

export {
  preloadMeditationAudio,
  getMeditationLoadMeta,
  ACOUSTIC_CONFIG,
  CALL_PRESET_ORDER,
  formatRelativeDb,
  callLevelsForPreset,
};

export class CallTransmitter {
  constructor() {
    this.engine = new CallContinuousTransmitter();
    this.deltaDb = BASE_TOTAL_DIFFERENTIAL_DB;
    this.profileId = DEFAULT_CALL_AMBIENT_PROFILE;
    this.watermarkEnabled = true;
    this.lastMeta = null;
    this.onState = null;
    this.engine.onState = (state) => {
      if (this.onState) this.onState(state, this);
    };
  }

  get playing() {
    return this.engine.playing;
  }

  validate(message) {
    return isValidMessage(message);
  }

  setProfile(id) {
    this.engine.setProfile(id);
    this.profileId = this.engine.profileId;
  }

  setAmbientDebug(debug) {
    this.engine.setAmbientDebug(debug);
  }

  setDeltaDb(db) {
    if (!BASE_DELTA_DB_OPTIONS.includes(db)) {
      throw new Error(`Invalid delta ${db}`);
    }
    this.deltaDb = db;
    this.engine.setDeltaDb(db);
  }

  setWatermarkEnabled(on) {
    this.watermarkEnabled = !!on;
    this.engine.setWatermarkEnabled(this.watermarkEnabled);
  }

  setMusicGain(g) {
    this.engine.setMusicGain(g);
  }

  setCrossfadeSeconds(s) {
    this.engine.setCrossfadeSeconds(s);
  }

  setMusicOnly(on) {
    this.engine.setMusicOnly(on);
  }

  setCallPreset(presetId) {
    this.engine.setCallPreset(presetId);
  }

  async play(message) {
    const check = this.validate(message);
    if (!check.ok) throw new Error(check.error);
    this.engine.profileId = this.profileId;
    this.engine.deltaDb = this.deltaDb;
    this.engine.watermarkEnabled = this.watermarkEnabled;
    await this.engine.start(message);
    this.lastMeta = {
      encoded: this.engine.renderer?.encoded,
      deltaDb: this.deltaDb,
      profileId: this.profileId,
      sampleRate: this.engine.ctx.sampleRate,
      frameMs: CALL_FRAME_MS,
      watermarkEnabled: this.watermarkEnabled,
    };
    return this.lastMeta;
  }

  async stop() {
    await this.engine.stop();
  }

  /** Offline render for A/B comparison in debug */
  async renderOffline(message, { neutral = false } = {}) {
    const ctx = await this.engine.ensureContext();
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
    return this.engine.getDebugInfo();
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
  ACOUSTIC_CONFIG,
  CALL_PRESET_ORDER,
  formatRelativeDb,
  callLevelsForPreset,
};
