/**
 * Spectator AudioContext playback helpers.
 * Create/resume context synchronously on the user gesture before awaits.
 *
 * AENV1 packets are designed to loop: each cycle starts with the same
 * double-chirp preamble so the receiver can re-sync continuously.
 */

import { SAMPLE_RATE } from "../../shared/audioSeal/constants";

let sharedCtx: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let playing = false;
let looping = false;

export function unlockAudioContext(): AudioContext {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AC({ sampleRate: SAMPLE_RATE });
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

export function getAudioContext(): AudioContext | null {
  return sharedCtx;
}

export function stopPlayback(): void {
  if (activeSource) {
    try {
      activeSource.onended = null;
      activeSource.stop();
    } catch {
      /* already stopped */
    }
    try {
      activeSource.disconnect();
    } catch {
      /* */
    }
    activeSource = null;
  }
  playing = false;
  looping = false;
}

export function isPlaying(): boolean {
  return playing;
}

export function isLooping(): boolean {
  return looping;
}

/**
 * Play mono Float32 samples at canonical (or resampled) rate.
 * When `loop` is true, the buffer repeats until stopPlayback() — each
 * iteration re-emits the packet preamble as the sync marker.
 */
export async function playFloat32Mono(
  samples: Float32Array,
  options?: { onEnded?: () => void; restart?: boolean; loop?: boolean },
): Promise<void> {
  const ctx = unlockAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
  if (playing) {
    if (options?.restart === false) return;
    stopPlayback();
  }

  let playback = samples;
  if (Math.abs(ctx.sampleRate - SAMPLE_RATE) > 1) {
    playback = resampleLinear(samples, SAMPLE_RATE, ctx.sampleRate);
  }

  const buffer = ctx.createBuffer(1, playback.length, ctx.sampleRate);
  buffer.copyToChannel(Float32Array.from(playback), 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = options?.loop === true;
  src.connect(ctx.destination);
  activeSource = src;
  playing = true;
  looping = src.loop;
  src.onended = () => {
    if (activeSource === src) {
      activeSource = null;
      playing = false;
      looping = false;
    }
    options?.onEnded?.();
  };
  src.start();
}

function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const outLen = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

/** Build a WAV Blob (PCM 16-bit mono) for lab download. */
export function float32ToWavBlob(
  samples: Float32Array,
  sampleRate = SAMPLE_RATE,
): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(off, (x * 0x7fff) | 0, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function releaseAudioResources(): void {
  stopPlayback();
  if (sharedCtx && sharedCtx.state !== "closed") {
    void sharedCtx.close();
  }
  sharedCtx = null;
}
