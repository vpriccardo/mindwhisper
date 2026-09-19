/**
 * Centralized acoustic mix / calibration config.
 * Freeze winning values here; Test Settings UI only reads these presets.
 *
 * Room/call relative dB = watermark RMS relative to meditation music RMS.
 * Differential modulation depth (Δ) is NOT controlled here — see protocol / call-constants.
 */

export const ACOUSTIC_CONFIG = Object.freeze({
  meditationMusicGain: 1.0,
  masterGain: 0.92,
  /** Smooth live preset / watermark A-B transitions */
  carrierGainRampMs: 100,

  room: Object.freeze({
    /**
     * Production default when Meditation is selected.
     * Tuned for phone↔phone at ~1–2 m with light room noise. Stronger
     * presets help harsh rooms / weak laptop mics; quieter presets trade
     * range for presentation.
     */
    productionCarrierDb: -18,
    defaultPreset: 'veryStrong',
    presets: Object.freeze({
      veryStrong: -18,
      strong: -20,
      balanced: -23,
      subtle: -26,
      verySubtle: -29,
      extreme: -32,
    }),
    labels: Object.freeze({
      veryStrong: 'Very strong',
      strong: 'Strong',
      balanced: 'Balanced',
      subtle: 'Subtle',
      verySubtle: 'Very subtle',
      extreme: 'Extreme',
    }),
    descriptions: Object.freeze({
      balanced:
        'Quieter mix; may need a quieter room or closer range.',
      subtle:
        'Quieter carrier. Prefer short messages and a quiet room.',
      verySubtle: 'Cleaner sound. May require repeated frames.',
      extreme: 'Experimental. Prioritises invisibility over fast decoding.',
      strong: 'Strong carrier; good for quiet rooms.',
      veryStrong:
        'Recommended for phone↔phone at ~1–2 m until CRC is reliable.',
    }),
  }),

  call: Object.freeze({
    productionBaseDb: -18,
    productionEnhancementDb: -24,
    defaultPreset: 'balanced',
    presets: Object.freeze({
      veryStrong: Object.freeze({ baseDb: -12, enhancementDb: -18 }),
      strong: Object.freeze({ baseDb: -15, enhancementDb: -21 }),
      balanced: Object.freeze({ baseDb: -18, enhancementDb: -24 }),
      subtle: Object.freeze({ baseDb: -21, enhancementDb: -27 }),
      verySubtle: Object.freeze({ baseDb: -24, enhancementDb: -30 }),
    }),
    labels: Object.freeze({
      veryStrong: 'Very strong',
      strong: 'Strong',
      balanced: 'Balanced',
      subtle: 'Subtle',
      verySubtle: 'Very subtle',
    }),
    descriptions: Object.freeze({
      veryStrong: 'Maximum robustness for difficult calls.',
      strong: 'Prioritises call reliability.',
      balanced: 'Recommended starting point.',
      subtle: 'Cleaner presentation; may need more repeated frames.',
      verySubtle: 'Experimental. Tests the practical audibility limit.',
    }),
  }),
});

export const ROOM_PRESET_ORDER = Object.freeze([
  'veryStrong',
  'strong',
  'balanced',
  'subtle',
  'verySubtle',
  'extreme',
]);

export const CALL_PRESET_ORDER = Object.freeze([
  'veryStrong',
  'strong',
  'balanced',
  'subtle',
  'verySubtle',
]);

/**
 * RX sensitivity — multiplies the preamble-correlation threshold used to
 * gate frame detection (room `PREAMBLE_CORRELATION_MIN` / call
 * `CALL_PREAMBLE_CORRELATION_MIN`). Lower multiplier = more sensitive
 * (detects weaker/attenuated signal sooner, but more false "detected"
 * candidates that then fail CRC in loud/noisy environments). Higher
 * multiplier = stricter (fewer false detections in traffic/crowd/music
 * noise, but needs a cleaner signal to lock).
 */
export const RX_SENSITIVITY = Object.freeze({
  /** Phone↔phone primary: High unlocks weaker preambles sooner. */
  defaultPreset: 'high',
  multipliers: Object.freeze({
    high: 0.82,
    normal: 1.0,
    low: 1.25,
  }),
  labels: Object.freeze({
    high: 'High',
    normal: 'Normal',
    low: 'Low (noisy places)',
  }),
  descriptions: Object.freeze({
    high: 'Most sensitive. Try for weak/attenuated paths (e.g. laptop mic). May show more failed-frame churn in loud rooms.',
    normal: 'Recommended for phone↔phone.',
    low: 'Requires a stronger, cleaner signal before attempting a decode — use in loud/noisy environments (street, traffic, background music) to cut down false detections.',
  }),
});

export const RX_SENSITIVITY_ORDER = Object.freeze(['high', 'normal', 'low']);

export function rxThresholdMultiplierForSensitivity(id) {
  return (
    RX_SENSITIVITY.multipliers[id] ??
    RX_SENSITIVITY.multipliers[RX_SENSITIVITY.defaultPreset]
  );
}

export function roomCarrierDbForPreset(presetId) {
  const p = ACOUSTIC_CONFIG.room.presets[presetId];
  return p != null ? p : ACOUSTIC_CONFIG.room.productionCarrierDb;
}

export function callLevelsForPreset(presetId) {
  const p = ACOUSTIC_CONFIG.call.presets[presetId];
  if (p) return { baseDb: p.baseDb, enhancementDb: p.enhancementDb };
  return {
    baseDb: ACOUSTIC_CONFIG.call.productionBaseDb,
    enhancementDb: ACOUSTIC_CONFIG.call.productionEnhancementDb,
  };
}

/** Format for UI: −26 */
export function formatRelativeDb(db) {
  const n = Number(db);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toFixed(0);
  return n <= 0 ? `−${abs}` : `+${abs}`;
}

/**
 * Gain that places a reference-level carrier at musicRmsDb + relativeDb.
 * carrierRefRmsDb = RMS of the carrier generator at unity bus / unity carrierLevel.
 */
export function relativeDbToGain(musicRmsDb, relativeDb, carrierRefRmsDb) {
  if (
    !Number.isFinite(musicRmsDb) ||
    !Number.isFinite(relativeDb) ||
    !Number.isFinite(carrierRefRmsDb)
  ) {
    return Math.pow(10, relativeDb / 20);
  }
  const targetRmsDb = musicRmsDb + relativeDb;
  return Math.pow(10, (targetRmsDb - carrierRefRmsDb) / 20);
}

export function measureFloat32Stats(samples) {
  let sumSq = 0;
  let peak = 0;
  const n = samples.length || 1;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / n);
  return {
    rms,
    rmsDb: 20 * Math.log10(Math.max(rms, 1e-12)),
    peak,
    peakDb: 20 * Math.log10(Math.max(peak, 1e-12)),
  };
}

export function measureAudioBufferStats(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  let sumSq = 0;
  let peak = 0;
  const n = len * ch || 1;
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
      sumSq += data[i] * data[i];
    }
  }
  const rms = Math.sqrt(sumSq / n);
  return {
    rms,
    rmsDb: 20 * Math.log10(Math.max(rms, 1e-12)),
    peak,
    peakDb: 20 * Math.log10(Math.max(peak, 1e-12)),
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    channels: ch,
  };
}

/**
 * Room/call protocol selection.
 * Default is protocol-v2. Frozen v1 remains at `?protocol=v1`.
 */
export function getProtocolVersion() {
  return new URLSearchParams(location.search).get('protocol') === 'v1' ? 'v1' : 'v2';
}

export function isDebugMode() {
  return new URLSearchParams(location.search).get('debug') === '1';
}

/** Ramp a GainNode smoothly (absolute AudioContext time). */
export function rampGainTo(gainNode, value, ctx, rampMs = ACOUSTIC_CONFIG.carrierGainRampMs) {
  if (!gainNode || !ctx) return;
  const now = ctx.currentTime;
  const t = Math.max(0.02, (rampMs || 100) / 1000);
  const cur = Math.max(0.00001, gainNode.gain.value);
  try {
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(cur, now);
    gainNode.gain.linearRampToValueAtTime(Math.max(0, value), now + t);
  } catch {
    gainNode.gain.value = value;
  }
}
