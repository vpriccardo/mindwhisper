/**
 * Room-v1 transmitter controller — continuous ambient + repeating watermark frames.
 * Used by tx.html only. Call channel uses js/call/* + tx2.html — do not merge.
 */

import {
  isValidMessage,
  MAX_MESSAGE_LEN,
  WATERMARK_DELTA_DB_DEFAULT,
  WATERMARK_DELTA_DB_OPTIONS,
  AMBIENT_SEED_DEFAULT,
  WATERMARK_NOISE_SEED_DEFAULT,
  CONSTANTS,
} from './protocol.js';
import {
  ContinuousTransmitter,
  renderProfileTransmission,
} from './tx-engine.js';
import { renderToAudioBuffer } from './watermark.js';
import {
  AMBIENT_PROFILES,
  DEBUG_AMBIENT_PROFILES,
  DEFAULT_AMBIENT_PROFILE,
  PROFILE_IDS,
  ALL_PROFILE_IDS,
} from './ambient-profiles.js';
import {
  preloadMeditationAudio,
  getMeditationLoadMeta,
} from './meditation-audio.js';
import {
  ACOUSTIC_CONFIG,
  ROOM_PRESET_ORDER,
  formatRelativeDb,
  roomCarrierDbForPreset,
} from './acoustic-config.js';

export function isDebugMode() {
  return new URLSearchParams(location.search).get('debug') === '1';
}

export {
  preloadMeditationAudio,
  getMeditationLoadMeta,
  ACOUSTIC_CONFIG,
  ROOM_PRESET_ORDER,
  formatRelativeDb,
  roomCarrierDbForPreset,
};

export class Transmitter {
  constructor() {
    this.engine = new ContinuousTransmitter();
    this.deltaDb = WATERMARK_DELTA_DB_DEFAULT;
    this.profileId = DEFAULT_AMBIENT_PROFILE;
    this.ambientSeed = AMBIENT_SEED_DEFAULT;
    this.watermarkNoiseSeed = WATERMARK_NOISE_SEED_DEFAULT;
    this.lastMeta = null;
    this.bufferA = null;
    this.bufferB = null;
    this.abMode = 'B';
    this.onState = null;

    this.engine.onState = (state, eng) => {
      if (this.onState) this.onState(state, this);
    };
  }

  get playing() {
    return this.engine.playing;
  }

  async resumeIfNeeded() {
    return this.engine.resumeIfNeeded();
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
    this.engine.setProfile(id);
    this.profileId = this.engine.profileId;
  }

  setAmbientDebug(debug) {
    this.engine.setAmbientDebug(debug);
  }

  setDeltaDb(db) {
    if (!WATERMARK_DELTA_DB_OPTIONS.includes(db)) {
      throw new Error(`Invalid delta ${db}`);
    }
    this.deltaDb = db;
    this.engine.setDeltaDb(db);
    this.bufferA = null;
    this.bufferB = null;
  }

  setMusicGain(g) {
    this.engine.setMusicGain(g);
  }

  setCrossfadeSeconds(s) {
    this.engine.setCrossfadeSeconds(s);
  }

  setWatermarkEnabled(on) {
    this.engine.setWatermarkEnabled(on);
  }

  setMusicOnly(on) {
    this.engine.setMusicOnly(on);
  }

  setRoomPreset(presetId) {
    this.engine.setRoomPreset(presetId);
  }

  async render(message, { neutral = false, profileId } = {}) {
    const ctx = await this.ensureContext();
    const { buffer, meta } = await renderToAudioBuffer(message, ctx, {
      deltaDb: this.deltaDb,
      neutral,
      profileId: profileId || this.profileId,
      ambientSeed: this.ambientSeed,
      watermarkNoiseSeed: this.watermarkNoiseSeed,
    });
    this.lastMeta = meta;
    return { buffer, meta };
  }

  async prepareAB(message) {
    const a = await this.render(message, { neutral: true });
    const b = await this.render(message, { neutral: false });
    this.bufferA = a.buffer;
    this.bufferB = b.buffer;
    this.lastMeta = b.meta;
    return { a, b };
  }

  /** Continuous Start — same message forever until Stop. */
  async play(message) {
    const check = this.validate(message);
    if (!check.ok) throw new Error(check.error);

    this.engine.profileId = this.profileId;
    this.engine.deltaDb = this.deltaDb;
    this.engine.ambientSeed = this.ambientSeed;
    this.engine.watermarkNoiseSeed = this.watermarkNoiseSeed;

    await this.engine.start(message);
    this.lastMeta = {
      encoded: this.engine.renderer?.encoded,
      deltaDb: this.deltaDb,
      profileId: this.profileId,
      sampleRate: this.engine.ctx.sampleRate,
    };
    return this.lastMeta;
  }

  async stop() {
    if (this._abSource) {
      try {
        this._abSource.stop();
      } catch {
        /* ignore */
      }
      this._abSource = null;
      this._abGain = null;
    }
    await this.engine.stop({ immediate: false });
  }

  async switchAB(mode) {
    this.abMode = mode;
    // A/B comparison uses finite offline buffers while idle debug tooling;
    // during continuous play, stop first then play selected buffer once.
    if (this.playing) await this.engine.stop({ immediate: true });
    const ctx = await this.ensureContext();
    const buffer = mode === 'A' ? this.bufferA : this.bufferB;
    if (!buffer) return;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const t = ctx.currentTime;
    gain.gain.linearRampToValueAtTime(1, t + 0.012);
    source.start(0);
    this._abSource = source;
    this._abGain = gain;
    source.onended = () => {
      this._abSource = null;
      this._abGain = null;
      if (this.onState) this.onState('ended', this);
    };
    if (this.onState) this.onState('playing', this);
  }

  getDebugInfo() {
    const live = this.engine.getDebugInfo();
    const enc = this.lastMeta?.encoded;
    return {
      ...live,
      rawFrame: enc ? Array.from(enc.rawFrame) : null,
      crc: enc
        ? '0x' + enc.crc.toString(16).toUpperCase().padStart(4, '0')
        : null,
      constants: CONSTANTS,
      profiles: AMBIENT_PROFILES,
    };
  }
}

export {
  MAX_MESSAGE_LEN,
  WATERMARK_DELTA_DB_OPTIONS,
  AMBIENT_PROFILES,
  DEBUG_AMBIENT_PROFILES,
  DEFAULT_AMBIENT_PROFILE,
  PROFILE_IDS,
  ALL_PROFILE_IDS,
  renderProfileTransmission,
  ACOUSTIC_CONFIG,
  ROOM_PRESET_ORDER,
  formatRelativeDb,
  roomCarrierDbForPreset,
};
