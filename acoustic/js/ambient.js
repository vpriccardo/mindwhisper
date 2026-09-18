/**
 * Procedural ambient utilities + re-exports of profile renderers.
 */
export {
  renderAmbient,
  renderAmbientProfile,
  createAmbientStream,
  AMBIENT_PROFILES,
  DEFAULT_AMBIENT_PROFILE,
  PROFILE_IDS,
} from './ambient-profiles.js';

/**
 * Apply raised-cosine fade in/out in-place.
 */
export function applyFades(buffer, sampleRate, fadeInMs, fadeOutMs) {
  const fadeInN = Math.min(buffer.length, Math.floor((fadeInMs / 1000) * sampleRate));
  const fadeOutN = Math.min(buffer.length, Math.floor((fadeOutMs / 1000) * sampleRate));
  for (let i = 0; i < fadeInN; i++) {
    const x = i / fadeInN;
    const g = 0.5 - 0.5 * Math.cos(Math.PI * x);
    buffer[i] *= g;
  }
  for (let i = 0; i < fadeOutN; i++) {
    const x = i / fadeOutN;
    const g = 0.5 - 0.5 * Math.cos(Math.PI * (1 - x));
    buffer[buffer.length - 1 - i] *= g;
  }
}

/**
 * Normalize so peak <= peakTarget; return { peak, rms }.
 */
export function normalizePeak(buffer, peakTarget = 0.85) {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]);
    if (a > peak) peak = a;
    sumSq += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSq / buffer.length);
  if (peak > 1e-12) {
    const scale = peakTarget / peak;
    for (let i = 0; i < buffer.length; i++) buffer[i] *= scale;
    peak = peakTarget;
    return { peak, rms: rms * scale, scale };
  }
  return { peak, rms, scale: 1 };
}

export function measureRmsDbFs(buffer) {
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i];
  const rms = Math.sqrt(sumSq / buffer.length);
  return 20 * Math.log10(Math.max(rms, 1e-12));
}
