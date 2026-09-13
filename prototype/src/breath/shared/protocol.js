/**
 * Mindwhisper breath transport — continuous word beacon (iPhone-friendly)
 *
 * Design:
 * - Do NOT gate decode on handshake (fragile on iOS mic/speaker).
 * - Retransmit the word many times per minute as loud mid-band tones.
 * - Band ~1600–3100 Hz: sits above phone rumble, below harsh HF roll-off,
 *   and survives common iPhone speaker→mic paths better than 396–528 Hz.
 * - Handshake (528→396) remains a one-shot session marker for humans/future sync,
 *   but RX ignores it and only locks on word beacons.
 */

const MindwhisperProtocol = (() => {
  const TICK_FREQ = 880;
  const HANDSHAKE_START = 528;
  const HANDSHAKE_END = 396;
  const HANDSHAKE_GLIDE_START = 0.1;
  const HANDSHAKE_GLIDE_DUR = 0.8;

  /** First beacon after session start (after soft handshake). */
  const FIRST_BEACON_AT = 1.4;

  /** Retransmit interval (seconds). ~7–8 beacons/minute. */
  const BEACON_INTERVAL = 7.5;

  const START_MARKER = 1750;
  const END_MARKER = 1850;
  const TONE_DUR = 0.22;
  const GAP_DUR = 0.06;
  const MARKER_DUR = 0.2;

  // A–Z + space + 0–9 → max freq ≈ 1600 + 36*42 = 3112 Hz
  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const FREQ_BASE = 1600;
  const FREQ_STEP = 42;
  const MAX_CHARS = 20;

  const TONE_PEAK = 0.45;
  const MARKER_PEAK = 0.5;

  function normalizeWord(raw) {
    return String(raw || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, "")
      .trim()
      .slice(0, MAX_CHARS);
  }

  function charToFreq(ch) {
    const idx = CHARSET.indexOf(ch);
    if (idx < 0) return null;
    return FREQ_BASE + idx * FREQ_STEP;
  }

  function freqToChar(freq) {
    if (freq < FREQ_BASE - FREQ_STEP / 2) return null;
    const idx = Math.round((freq - FREQ_BASE) / FREQ_STEP);
    if (idx < 0 || idx >= CHARSET.length) return null;
    return CHARSET[idx];
  }

  function isNear(freq, target, tol = 28) {
    return Math.abs(freq - target) <= tol;
  }

  function payloadDuration(word) {
    const w = normalizeWord(word);
    const n = Math.max(w.length, 1);
    return MARKER_DUR + GAP_DUR + n * (TONE_DUR + GAP_DUR) + MARKER_DUR;
  }

  /** When continuous ambient/breath pad begins (after first beacon). */
  function ambientStartOffset(word) {
    return FIRST_BEACON_AT + payloadDuration(word) + 0.15;
  }

  function allDetectFreqs() {
    const freqs = [START_MARKER, END_MARKER];
    for (let i = 0; i < CHARSET.length; i++) {
      freqs.push(FREQ_BASE + i * FREQ_STEP);
    }
    return freqs;
  }

  function playTone(ctx, destination, freq, t, duration, peak) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(destination);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.015);
    gain.gain.setValueAtTime(peak, t + duration - 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /**
   * Schedule one word beacon starting at `startTime`.
   * Returns end time.
   */
  function playWordBeacon(ctx, destination, word, startTime) {
    const w = normalizeWord(word);
    let t = startTime;

    playTone(ctx, destination, START_MARKER, t, MARKER_DUR, MARKER_PEAK);
    t += MARKER_DUR + GAP_DUR;

    const chars = w.length ? w : " ";
    for (const ch of chars) {
      const f = charToFreq(ch);
      if (f != null) {
        playTone(ctx, destination, f, t, TONE_DUR, TONE_PEAK);
        t += TONE_DUR + GAP_DUR;
      }
    }

    playTone(ctx, destination, END_MARKER, t, MARKER_DUR, MARKER_PEAK);
    t += MARKER_DUR;
    return t;
  }

  /**
   * Schedule beacons from firstBeaconAt through horizonSeconds of audio time.
   */
  function scheduleBeacons(ctx, destination, word, sessionStart, horizonSeconds) {
    const times = [];
    let t = sessionStart + FIRST_BEACON_AT;
    const end = sessionStart + horizonSeconds;
    while (t < end) {
      playWordBeacon(ctx, destination, word, t);
      times.push(t);
      t += BEACON_INTERVAL;
    }
    return times;
  }

  return {
    TICK_FREQ,
    HANDSHAKE_START,
    HANDSHAKE_END,
    HANDSHAKE_GLIDE_START,
    HANDSHAKE_GLIDE_DUR,
    FIRST_BEACON_AT,
    BEACON_INTERVAL,
    START_MARKER,
    END_MARKER,
    TONE_DUR,
    GAP_DUR,
    MARKER_DUR,
    CHARSET,
    FREQ_BASE,
    FREQ_STEP,
    MAX_CHARS,
    TONE_PEAK,
    MARKER_PEAK,
    normalizeWord,
    charToFreq,
    freqToChar,
    isNear,
    payloadDuration,
    ambientStartOffset,
    allDetectFreqs,
    playWordBeacon,
    scheduleBeacons,
  };
})();

if (typeof window !== "undefined") {
  window.MindwhisperProtocol = MindwhisperProtocol;
}
