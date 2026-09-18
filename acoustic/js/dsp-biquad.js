/**
 * Shared biquad helpers for TX watermark and RX feature extraction.
 */

export function designBandpass(centreHz, sampleRate, bandwidthHz) {
  const nyquist = sampleRate * 0.5;
  if (centreHz >= nyquist * 0.95) {
    throw new Error(`Centre ${centreHz} Hz too close to Nyquist ${nyquist}`);
  }
  const Q = centreHz / bandwidthHz;
  const w0 = (2 * Math.PI * centreHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    centreHz,
    Q,
  };
}

export function designBandReject(centreHz, sampleRate, bandwidthHz) {
  const Q = centreHz / bandwidthHz;
  const w0 = (2 * Math.PI * centreHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const b0 = 1;
  const b1 = -2 * cosw0;
  const b2 = 1;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    centreHz,
    Q,
  };
}

export function createBiquadState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

export function processBiquad(sample, coef, state) {
  const y =
    coef.b0 * sample +
    coef.b1 * state.x1 +
    coef.b2 * state.x2 -
    coef.a1 * state.y1 -
    coef.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = sample;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}
