/**
 * Meditation presentation audio — preload, decode once, overlapping crossfade loop.
 * Independent of watermark modulation. Asset: ./audio/meditation-loop-v1.mp3
 */

export const MEDITATION_ASSET_URL = './audio/meditation-loop-v1.mp3';
export const MUSIC_CROSSFADE_SECONDS = 8;
export const MUSIC_INITIAL_FADE_SECONDS = 0.8;
export const MUSIC_STOP_FADE_SECONDS = 0.8;
/** Native decoded level — do not boost. Tunable only via ACOUSTIC_CONFIG. */
export const MEDITATION_MUSIC_GAIN_DEFAULT = 1.0;
export const MEDITATION_ASSET_MAX_BYTES = 665600; // 650 KiB warn/fail threshold

const CURVE_LEN = 256;

function createFadeInCurve(length = CURVE_LEN) {
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / (length - 1);
    curve[i] = Math.sin(t * Math.PI * 0.5);
  }
  return curve;
}

function createFadeOutCurve(length = CURVE_LEN) {
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / (length - 1);
    curve[i] = Math.cos(t * Math.PI * 0.5);
  }
  return curve;
}

const fadeInCurve = createFadeInCurve();
const fadeOutCurve = createFadeOutCurve();

/** Shared fetch — one request for the page lifetime. */
let bytesPromise = null;
let loadMeta = {
  startedAt: 0,
  finishedAt: 0,
  bytes: 0,
  error: null,
};

export function preloadMeditationAudio() {
  if (!bytesPromise) {
    loadMeta.startedAt = performance.now();
    loadMeta.error = null;
    bytesPromise = fetch(MEDITATION_ASSET_URL, { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Audio fetch failed: ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((buf) => {
        loadMeta.finishedAt = performance.now();
        loadMeta.bytes = buf.byteLength;
        if (buf.byteLength > MEDITATION_ASSET_MAX_BYTES) {
          console.warn(
            `Meditation asset ${buf.byteLength} bytes exceeds ${MEDITATION_ASSET_MAX_BYTES}`
          );
        }
        return buf;
      })
      .catch((err) => {
        loadMeta.error = String(err && err.message ? err.message : err);
        loadMeta.finishedAt = performance.now();
        bytesPromise = null; // allow retry
        throw err;
      });
  }
  return bytesPromise;
}

export function getMeditationLoadMeta() {
  return { ...loadMeta, assetUrl: MEDITATION_ASSET_URL };
}

export async function ensureMeditationBytes() {
  return preloadMeditationAudio();
}

/**
 * Decode once per AudioContext sample-rate session.
 * Returns { buffer, decodeMs }.
 */
const decodedByCtx = new WeakMap();

export async function decodeMeditationBuffer(audioContext) {
  let entry = decodedByCtx.get(audioContext);
  if (entry && entry.buffer) return entry;

  const t0 = performance.now();
  const bytes = await ensureMeditationBytes();
  // copy — decodeAudioData may detach the ArrayBuffer
  const copy = bytes.slice(0);
  const buffer = await audioContext.decodeAudioData(copy);
  entry = {
    buffer,
    decodeMs: performance.now() - t0,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  };
  decodedByCtx.set(audioContext, entry);
  return entry;
}

/** Session-scoped music loudness — computed once after first decode. */
let musicStatsCache = null;

export function getMeditationMusicStats() {
  return musicStatsCache ? { ...musicStatsCache } : null;
}

export function setMeditationMusicStats(stats) {
  musicStatsCache = stats ? { ...stats } : null;
}

/**
 * Two-source overlapping loop on the Web Audio clock.
 * Connects into musicBus (GainNode); does not touch watermark routing.
 */
export class CrossfadeMusicEngine {
  constructor(audioContext, musicBus, opts = {}) {
    this.ctx = audioContext;
    this.musicBus = musicBus;
    this.crossfadeS = opts.crossfadeSeconds ?? MUSIC_CROSSFADE_SECONDS;
    this.musicGain = opts.musicGain ?? MEDITATION_MUSIC_GAIN_DEFAULT;
    this.buffer = null;
    this.cycleDuration = 0;
    this.nextStartTime = 0;
    this.active = new Set(); // { source, gain }
    this.timer = null;
    this.playing = false;
    this.stopping = false;
    this.SCHEDULE_AHEAD_S = 12;
    this.TICK_MS = 400;
  }

  async prepare(buffer) {
    this.buffer = buffer;
    this.cycleDuration = Math.max(
      1,
      buffer.duration - this.crossfadeS
    );
  }

  start({ when = null, initialFadeS = MUSIC_INITIAL_FADE_SECONDS } = {}) {
    if (!this.buffer || this.playing) return;
    this.playing = true;
    this.stopping = false;
    const t0 = when != null ? when : this.ctx.currentTime + 0.05;
    this.musicBus.gain.cancelScheduledValues(t0);
    this.musicBus.gain.setValueAtTime(0.0001, t0);
    this.musicBus.gain.linearRampToValueAtTime(
      this.musicGain,
      t0 + Math.max(0.05, initialFadeS)
    );
    this.nextStartTime = t0;
    this._scheduleOne(t0, true);
    this.nextStartTime = t0 + this.cycleDuration;
    this._tick();
  }

  _scheduleOne(startTime, isFirst) {
    if (!this.buffer || this.stopping) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(this.musicBus);

    const dur = this.buffer.duration;
    const fade = Math.min(this.crossfadeS, dur * 0.45);
    const fadeEnd = startTime + fade;
    const fadeOutStart = startTime + dur - fade;

    // Equal-power in / out
    try {
      g.gain.setValueAtTime(0, startTime);
      g.gain.setValueCurveAtTime(fadeInCurve, startTime, fade);
      // Hold at 1 between fades
      g.gain.setValueAtTime(1, fadeEnd);
      g.gain.setValueCurveAtTime(fadeOutCurve, fadeOutStart, fade);
    } catch {
      g.gain.setValueAtTime(1, startTime);
    }

    const entry = { source: src, gain: g, startTime, endTime: startTime + dur };
    this.active.add(entry);
    src.onended = () => {
      this.active.delete(entry);
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        /* ignore */
      }
    };

    const startAt = startTime < this.ctx.currentTime ? this.ctx.currentTime : startTime;
    try {
      src.start(startAt);
      src.stop(startTime + dur + 0.05);
    } catch {
      this.active.delete(entry);
    }
    void isFirst;
  }

  _tick() {
    if (!this.playing || this.stopping) return;
    const horizon = this.ctx.currentTime + this.SCHEDULE_AHEAD_S;
    while (this.nextStartTime < horizon) {
      this._scheduleOne(this.nextStartTime, false);
      this.nextStartTime += this.cycleDuration;
    }
    // Prune finished (onended should handle; belt-and-suspenders)
    for (const entry of [...this.active]) {
      if (entry.endTime < this.ctx.currentTime - 0.5) {
        try {
          entry.source.stop();
        } catch {
          /* ignore */
        }
        this.active.delete(entry);
      }
    }
    this.timer = setTimeout(() => this._tick(), this.TICK_MS);
  }

  async stop({ fadeS = MUSIC_STOP_FADE_SECONDS } = {}) {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.ctx.currentTime;
    try {
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setValueAtTime(
        Math.max(0.0001, this.musicBus.gain.value),
        now
      );
      this.musicBus.gain.linearRampToValueAtTime(0, now + fadeS);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, fadeS * 1000 + 40));
    for (const entry of [...this.active]) {
      try {
        entry.source.stop();
      } catch {
        /* ignore */
      }
      try {
        entry.source.disconnect();
        entry.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
    this.playing = false;
    this.stopping = false;
  }

  setMusicGain(g) {
    this.musicGain = Math.max(0.05, Math.min(1.2, g));
    if (this.playing && !this.stopping) {
      const t = this.ctx.currentTime;
      this.musicBus.gain.cancelScheduledValues(t);
      this.musicBus.gain.setValueAtTime(this.musicGain, t);
    }
  }

  setCrossfadeSeconds(s) {
    this.crossfadeS = Math.max(5, Math.min(12, s));
    if (this.buffer) {
      this.cycleDuration = Math.max(1, this.buffer.duration - this.crossfadeS);
    }
  }

  getDebugInfo() {
    return {
      playing: this.playing,
      activeSources: this.active.size,
      nextStartTime: this.nextStartTime,
      cycleDuration: this.cycleDuration,
      crossfadeSeconds: this.crossfadeS,
      musicGain: this.musicGain,
      bufferDuration: this.buffer?.duration ?? null,
    };
  }
}
