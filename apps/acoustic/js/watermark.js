/**
 * Differential spectral watermark modulation helpers + offline render entry.
 * Sixteen narrow-band noise components; relative energy encodes bits.
 */

import {
  BANDWIDTH_HZ,
  FRAME_REPETITIONS,
  WATERMARK_DELTA_DB_DEFAULT,
  TOTAL_TX_MS,
} from './protocol.js';
import {
  designBandpass as designBandpassCore,
  designBandReject as designBandRejectCore,
  createBiquadState,
  processBiquad,
} from './dsp-biquad.js';
import { renderProfileTransmission } from './tx-engine.js';

export function designBandpass(centreHz, sampleRate, bandwidthHz = BANDWIDTH_HZ) {
  return designBandpassCore(centreHz, sampleRate, bandwidthHz);
}

export function designBandReject(centreHz, sampleRate, bandwidthHz = BANDWIDTH_HZ) {
  return designBandRejectCore(centreHz, sampleRate, bandwidthHz);
}

export { createBiquadState, processBiquad };

/**
 * Render a finite watermarked clip (legacy ~16 s path and synthetic tests).
 * Uses the continuous streaming engine with frameCount repetitions.
 */
export function renderWatermarkedAudio(opts) {
  const {
    message,
    sampleRate,
    deltaDb = WATERMARK_DELTA_DB_DEFAULT,
    neutral = false,
    profileId = 'air',
    frameCount = FRAME_REPETITIONS,
    includeFadeIn = true,
    includeFadeOut = true,
    ...rest
  } = opts;

  const rendered = renderProfileTransmission({
    message,
    sampleRate,
    profileId,
    frameCount,
    deltaDb,
    neutral,
    includeFadeIn,
    includeFadeOut,
    ...rest,
  });

  return {
    ...rendered,
    durationMs: rendered.durationMs,
    symbolCount: frameCount * (rendered.frameSamples / rendered.symbolSamples),
    expectedSymbols: frameCount * (rendered.frameSamples / rendered.symbolSamples),
    neutral,
  };
}

export async function renderToAudioBuffer(message, audioContext, options = {}) {
  const sampleRate = audioContext.sampleRate;
  const rendered = renderWatermarkedAudio({
    message,
    sampleRate,
    ...options,
  });

  const buffer = audioContext.createBuffer(1, rendered.samples.length, sampleRate);
  buffer.copyToChannel(rendered.samples, 0);
  return { buffer, meta: rendered };
}

export async function renderOffline(message, sampleRate = 48000, options = {}) {
  const length = Math.round((TOTAL_TX_MS / 1000) * sampleRate);
  let ctx = null;
  if (typeof OfflineAudioContext !== 'undefined') {
    try {
      ctx = new OfflineAudioContext(1, length, sampleRate);
    } catch {
      ctx = null;
    }
  }
  const rendered = renderWatermarkedAudio({ message, sampleRate, ...options });
  if (ctx) {
    const buffer = ctx.createBuffer(1, rendered.samples.length, sampleRate);
    buffer.copyToChannel(rendered.samples, 0);
    return { buffer, meta: rendered, usedOfflineContext: true };
  }
  return { buffer: null, meta: rendered, usedOfflineContext: false, samples: rendered.samples };
}
