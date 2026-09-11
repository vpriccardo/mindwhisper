/**
 * AENV1 double-chirp preamble: 80 ms up + 80 ms down, unit RMS, Hann fades.
 */

import {
  AENV_VERSION_SEED,
  PREAMBLE_F0_HZ,
  PREAMBLE_F1_HZ,
  PREAMBLE_HALF_SAMPLES,
  PREAMBLE_SAMPLES,
  SAMPLE_RATE,
} from "./constants";

function logChirp(
  out: Float32Array,
  offset: number,
  n: number,
  fStart: number,
  fEnd: number,
  phase0: number,
): number {
  // Instantaneous frequency: f(t) = f0 * (f1/f0)^(t/T)
  const T = n / SAMPLE_RATE;
  const k = Math.log(fEnd / fStart);
  let phase = phase0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = fStart * Math.exp((k * t) / T);
    out[offset + i] = Math.sin(phase);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
  }
  return phase;
}

function applyHannFades(buf: Float32Array, fade: number): void {
  const n = buf.length;
  const f = Math.min(fade, Math.floor(n / 4));
  for (let i = 0; i < f; i++) {
    const w = 0.5 * (1 - Math.cos((Math.PI * i) / f));
    buf[i]! *= w;
    buf[n - 1 - i]! *= w;
  }
}

function unitRms(buf: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  const rms = Math.sqrt(sum / buf.length) || 1;
  const g = 1 / rms;
  for (let i = 0; i < buf.length; i++) buf[i]! *= g;
}

let cached: Float32Array | null = null;
let cachedChecksum = 0;

/** Build (or return cached) unit-RMS preamble waveform. Fixed polarity. */
export function getPreambleWaveform(): Float32Array {
  if (cached) return cached;
  const out = new Float32Array(PREAMBLE_SAMPLES);
  let phase = 0;
  phase = logChirp(
    out,
    0,
    PREAMBLE_HALF_SAMPLES,
    PREAMBLE_F0_HZ,
    PREAMBLE_F1_HZ,
    phase,
  );
  // Continuous phase into down-chirp
  logChirp(
    out,
    PREAMBLE_HALF_SAMPLES,
    PREAMBLE_HALF_SAMPLES,
    PREAMBLE_F1_HZ,
    PREAMBLE_F0_HZ,
    phase,
  );
  applyHannFades(out, Math.round(0.002 * SAMPLE_RATE));
  // Remove DC
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i]!;
  mean /= out.length;
  for (let i = 0; i < out.length; i++) out[i]! -= mean;
  unitRms(out);
  // Fixed polarity: ensure first non-trivial sample positive-ish via checksum sign
  let checksum = AENV_VERSION_SEED >>> 0;
  for (let i = 0; i < out.length; i++) {
    checksum = (checksum + Math.imul((out[i]! * 1e6) | 0, i + 1)) >>> 0;
  }
  if (out[100]! < 0) {
    for (let i = 0; i < out.length; i++) out[i]! = -out[i]!;
    checksum = (~checksum) >>> 0;
  }
  cached = out;
  cachedChecksum = checksum;
  return out;
}

export function preambleChecksum(): number {
  getPreambleWaveform();
  return cachedChecksum;
}

/** Decimated 12 kHz copy for coarse correlation. */
export function getPreambleDecimated12k(): Float32Array {
  const full = getPreambleWaveform();
  const factor = 4; // 48k → 12k
  const n = Math.floor(full.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += full[i * factor + k]!;
    out[i] = s / factor;
  }
  unitRms(out);
  return out;
}
