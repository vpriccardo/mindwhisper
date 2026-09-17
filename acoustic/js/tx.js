/**
 * Transmitter controller: encode → render → play via Web Audio.
 */

import {
  isValidMessage,
  MAX_MESSAGE_LEN,
  WATERMARK_DELTA_DB_DEFAULT,
  WATERMARK_DELTA_DB_OPTIONS,
  AMBIENT_SEED_DEFAULT,
  WATERMARK_NOISE_SEED_DEFAULT,
  TOTAL_TX_MS,
  CONSTANTS,
} from './protocol.js';
import { renderWatermarkedAudio, renderToAudioBuffer } from './watermark.js';

export function isDebugMode() {
  return new URLSearchParams(location.search).get('debug') === '1';
}

export class Transmitter {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gainNode = null;
    this.playing = false;
    this.deltaDb = WATERMARK_DELTA_DB_DEFAULT;
    this.ambientSeed = AMBIENT_SEED_DEFAULT;
    this.watermarkNoiseSeed = WATERMARK_NOISE_SEED_DEFAULT;
    this.lastMeta = null;
    this.bufferA = null; // neutral
    this.bufferB = null; // encoded
    this.abMode = 'B';
    this.onState = null;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  validate(message) {
    return isValidMessage(message);
  }

  async render(message, { neutral = false } = {}) {
    const ctx = await this.ensureContext();
    const { buffer, meta } = await renderToAudioBuffer(message, ctx, {
      deltaDb: this.deltaDb,
      neutral,
      ambientSeed: this.ambientSeed,
      watermarkNoiseSeed: this.watermarkNoiseSeed,
    });
    this.lastMeta = meta;
    return { buffer, meta };
  }

  /**
   * Prepare A/B buffers from the same seeds for imperceptibility testing.
   */
  async prepareAB(message) {
    const a = await this.render(message, { neutral: true });
    const b = await this.render(message, { neutral: false });
    this.bufferA = a.buffer;
    this.bufferB = b.buffer;
    this.lastMeta = b.meta;
    return { a, b };
  }

  async play(message) {
    const check = this.validate(message);
    if (!check.ok) throw new Error(check.error);

    await this.stop();
    const ctx = await this.ensureContext();

    let buffer;
    if (isDebugMode() && this.abMode === 'A' && this.bufferA) {
      buffer = this.bufferA;
    } else if (isDebugMode() && this.abMode === 'B' && this.bufferB) {
      buffer = this.bufferB;
    } else {
      const rendered = await this.render(message, { neutral: false });
      buffer = rendered.buffer;
      if (isDebugMode()) {
        // Also build A for switching
        const a = await this.render(message, { neutral: true });
        this.bufferA = a.buffer;
        this.bufferB = buffer;
      }
    }

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 1;
    this.gainNode.connect(ctx.destination);

    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.connect(this.gainNode);
    this.playing = true;
    this._emit('playing');

    this.source.onended = () => {
      this.playing = false;
      this.source = null;
      this._emit('ended');
    };
    this.source.start(0);
    return this.lastMeta;
  }

  async switchAB(mode) {
    // mode: 'A' | 'B' — seamless-ish restart from current logical buffer
    this.abMode = mode;
    if (!this.playing) return;
    // Restart playback of the selected buffer without click: quick fade
    const ctx = await this.ensureContext();
    const buffer = mode === 'A' ? this.bufferA : this.bufferB;
    if (!buffer) return;

    if (this.gainNode) {
      const now = ctx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(0, now + 0.012);
    }
    const oldSource = this.source;
    setTimeout(() => {
      try {
        if (oldSource) oldSource.stop();
      } catch {
        /* already stopped */
      }
    }, 15);

    await new Promise((r) => setTimeout(r, 20));

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0;
    this.gainNode.connect(ctx.destination);
    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.connect(this.gainNode);
    this.playing = true;
    const t = ctx.currentTime;
    this.gainNode.gain.linearRampToValueAtTime(1, t + 0.012);
    this.source.onended = () => {
      this.playing = false;
      this.source = null;
      this._emit('ended');
    };
    this.source.start(0);
    this._emit('playing');
  }

  async stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* ignore */
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {
        /* ignore */
      }
      this.gainNode = null;
    }
    this.playing = false;
    this._emit('stopped');
  }

  setDeltaDb(db) {
    if (!WATERMARK_DELTA_DB_OPTIONS.includes(db)) {
      throw new Error(`Invalid delta ${db}`);
    }
    this.deltaDb = db;
    this.bufferA = null;
    this.bufferB = null;
  }

  _emit(state) {
    if (this.onState) this.onState(state, this);
  }

  getDebugInfo() {
    const meta = this.lastMeta;
    if (!meta) return null;
    const enc = meta.encoded;
    return {
      sampleRate: meta.sampleRate,
      rawFrame: Array.from(enc.rawFrame),
      crc: '0x' + enc.crc.toString(16).toUpperCase().padStart(4, '0'),
      hammingBits: enc.hammingBits.length,
      scrambledBits: enc.scrambled.length,
      deltaDb: meta.deltaDb,
      durationMs: meta.durationMs,
      peak: meta.peak,
      rms: meta.rms,
      rmsDb: meta.rmsDb,
      abMode: this.abMode,
      constants: CONSTANTS,
      totalTxMs: TOTAL_TX_MS,
    };
  }
}

export { MAX_MESSAGE_LEN, WATERMARK_DELTA_DB_OPTIONS };
