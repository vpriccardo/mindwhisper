/**
 * Dev/test-only helper: synthesize broadband "music-like" PCM with real
 * energy spread across ~150-4000 Hz (pink-noise based) for Node tests that
 * need a stand-in music signal without decoding the real MP3 asset (see
 * decode-meditation.mjs for tests that DO use the real asset via ffmpeg).
 * NOT used by production code.
 */
export function makeBroadbandMusic(n, sampleRate, seed = 12345) {
  let s = seed >>> 0;
  function rnd() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  }
  const out = new Float32Array(n);
  // Paul Kellet's pink-noise approximation — broadband, roughly 1/f spectrum,
  // giving every call-v2 band real, non-trivial energy to modulate.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const white = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    out[i] = pink * 0.11;
  }
  return out;
}
