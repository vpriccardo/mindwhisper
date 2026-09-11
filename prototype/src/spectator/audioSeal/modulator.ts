/**
 * Mask AENV1 watermark under cover sound.
 */

import {
  BOUNDARY_FADE_SAMPLES,
  DATA_SAMPLES,
  DATA_START,
  MASK_WINDOW_SAMPLES,
  PEAK_LIMIT_DBFS,
  PREAMBLE_SAMPLES,
  PREAMBLE_START,
  TOTAL_SAMPLES,
  WATERMARK_DB_PROVISIONAL,
} from "../../shared/audioSeal/constants";
import { getPreambleWaveform } from "../../shared/audioSeal/preamble";
import { modulateInterleavedBits } from "../../shared/audioSeal/symbolBasis";

export type MixDiagnostics = {
  coverRms: number;
  watermarkRms: number;
  watermarkDb: number;
  globalRatioDb: number;
  peak: number;
  peakDbfs: number;
  scaleApplied: number;
  renderMs: number;
};

export type ModulateResult = {
  mixed: Float32Array;
  watermarkOnly: Float32Array;
  cover: Float32Array;
  diagnostics: MixDiagnostics;
};

function rmsOf(buf: Float32Array, start: number, len: number): number {
  let sum = 0;
  const end = Math.min(buf.length, start + len);
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / n);
}

function smoothMaskGain(
  cover: Float32Array,
  watermarkDb: number,
): Float32Array {
  const gain = new Float32Array(TOTAL_SAMPLES);
  const linear = Math.pow(10, watermarkDb / 20);
  const win = MASK_WINDOW_SAMPLES;
  // Per-window cover RMS → local gain; floor where cover is very quiet
  const floorRms = 1e-4;
  for (let start = 0; start < TOTAL_SAMPLES; start += win) {
    const len = Math.min(win, TOTAL_SAMPLES - start);
    const local = Math.max(rmsOf(cover, start, len), floorRms);
    const g = local * linear;
    for (let i = 0; i < len; i++) gain[start + i] = g;
  }
  // Smooth gain (simple 3-tap)
  const smoothed = new Float32Array(TOTAL_SAMPLES);
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    const a = gain[Math.max(0, i - 1)]!;
    const b = gain[i]!;
    const c = gain[Math.min(TOTAL_SAMPLES - 1, i + 1)]!;
    smoothed[i] = (a + b + c) / 3;
  }
  return smoothed;
}

export function mixAudioSeal(input: {
  cover: Float32Array;
  interleavedBits: Int8Array;
  watermarkDb?: number;
}): ModulateResult {
  const t0 = performance.now();
  if (input.cover.length !== TOTAL_SAMPLES) {
    throw new Error("Cover must be TOTAL_SAMPLES long.");
  }
  const watermarkDb = input.watermarkDb ?? WATERMARK_DB_PROVISIONAL;
  const watermark = new Float32Array(TOTAL_SAMPLES);

  // Place preamble (boosted vs data for sync robustness; still under cover)
  const preamble = getPreambleWaveform();
  // +18 dB vs data watermark — acoustic speaker→mic needs a clear sync spike
  const preambleBoost = Math.pow(10, 18 / 20);
  for (let i = 0; i < PREAMBLE_SAMPLES; i++) {
    watermark[PREAMBLE_START + i] = preamble[i]! * preambleBoost;
  }

  // Place data DSSS
  const data = modulateInterleavedBits(input.interleavedBits);
  if (data.length !== DATA_SAMPLES) throw new Error("Data length mismatch");
  for (let i = 0; i < DATA_SAMPLES; i++) {
    watermark[DATA_START + i] = data[i]!;
  }

  const maskGain = smoothMaskGain(input.cover, watermarkDb);
  const mixed = new Float32Array(TOTAL_SAMPLES);
  const watermarkScaled = new Float32Array(TOTAL_SAMPLES);
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    const w = watermark[i]! * maskGain[i]!;
    watermarkScaled[i] = w;
    mixed[i] = input.cover[i]! + w;
  }

  // Remove DC
  let mean = 0;
  for (let i = 0; i < TOTAL_SAMPLES; i++) mean += mixed[i]!;
  mean /= TOTAL_SAMPLES;
  for (let i = 0; i < TOTAL_SAMPLES; i++) mixed[i]! -= mean;

  // Boundary fades
  const fade = BOUNDARY_FADE_SAMPLES;
  for (let i = 0; i < fade; i++) {
    const w = 0.5 * (1 - Math.cos((Math.PI * i) / fade));
    mixed[i]! *= w;
    mixed[TOTAL_SAMPLES - 1 - i]! *= w;
  }

  // Peak limit via linear scale
  let peak = 0;
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    const a = Math.abs(mixed[i]!);
    if (a > peak) peak = a;
  }
  const peakLimit = Math.pow(10, PEAK_LIMIT_DBFS / 20);
  let scale = 1;
  if (peak > peakLimit) {
    scale = peakLimit / peak;
    for (let i = 0; i < TOTAL_SAMPLES; i++) {
      mixed[i]! *= scale;
      watermarkScaled[i]! *= scale;
    }
    peak = peakLimit;
  }

  const coverRms = rmsOf(input.cover, DATA_START, DATA_SAMPLES);
  const wmRms = rmsOf(watermarkScaled, DATA_START, DATA_SAMPLES);
  const globalRatioDb =
    wmRms > 0 && coverRms > 0 ? 20 * Math.log10(wmRms / coverRms) : -Infinity;

  return {
    mixed,
    watermarkOnly: watermarkScaled,
    cover: input.cover,
    diagnostics: {
      coverRms,
      watermarkRms: wmRms,
      watermarkDb,
      globalRatioDb,
      peak,
      peakDbfs: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      scaleApplied: scale,
      renderMs: performance.now() - t0,
    },
  };
}
