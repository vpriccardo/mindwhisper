/**
 * Mindwhisper breath transport protocol (v1)
 *
 * Timeline from session start (AudioContext time):
 *   0.00–0.10s  sync tick (880 Hz)
 *   0.10–1.00s  handshake glide 528 → 396 Hz
 *   1.50s       word payload start marker (1200 Hz)
 *   …           one tone per character
 *   …           word payload end marker (1300 Hz)
 *   then        ambient pad + 15s breath cycle begins
 *
 * Alphabet: A–Z, space, digits 0–9 (accents stripped / uppercased).
 */

const MindwhisperProtocol = (() => {
  const TICK_FREQ = 880;
  const HANDSHAKE_START = 528;
  const HANDSHAKE_END = 396;
  const HANDSHAKE_GLIDE_START = 0.1;
  const HANDSHAKE_GLIDE_DUR = 0.8;
  const PAYLOAD_START_TIME = 1.5;

  const START_MARKER = 1200;
  const END_MARKER = 1300;
  const TONE_DUR = 0.18;
  const GAP_DUR = 0.05;
  const MARKER_DUR = 0.15;

  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const FREQ_BASE = 1500;
  const FREQ_STEP = 45;
  const MAX_CHARS = 24;

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

  function isNear(freq, target, tol = 35) {
    return Math.abs(freq - target) <= tol;
  }

  function payloadDuration(word) {
    const w = normalizeWord(word);
    const n = Math.max(w.length, 1);
    return MARKER_DUR + GAP_DUR + n * (TONE_DUR + GAP_DUR) + MARKER_DUR;
  }

  /** Absolute AudioContext time when ambient/breath loop starts. */
  function ambientStartOffset(word) {
    return PAYLOAD_START_TIME + payloadDuration(word) + 0.2;
  }

  /**
   * Schedule word payload tones on ctx starting at `startTime`.
   * Returns end time of payload.
   */
  function playWordPayload(ctx, destination, word, startTime) {
    const w = normalizeWord(word);
    let t = startTime;

    function beep(freq, duration, peak = 0.22) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(destination);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.02);
      gain.gain.linearRampToValueAtTime(peak * 0.7, t + duration * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.start(t);
      osc.stop(t + duration + 0.02);
      t += duration + GAP_DUR;
    }

    beep(START_MARKER, MARKER_DUR, 0.28);
    if (w.length === 0) {
      beep(charToFreq(" "), TONE_DUR);
    } else {
      for (const ch of w) {
        const f = charToFreq(ch);
        if (f != null) beep(f, TONE_DUR);
      }
    }
    beep(END_MARKER, MARKER_DUR, 0.28);
    return t;
  }

  return {
    TICK_FREQ,
    HANDSHAKE_START,
    HANDSHAKE_END,
    HANDSHAKE_GLIDE_START,
    HANDSHAKE_GLIDE_DUR,
    PAYLOAD_START_TIME,
    START_MARKER,
    END_MARKER,
    TONE_DUR,
    GAP_DUR,
    MARKER_DUR,
    CHARSET,
    FREQ_BASE,
    FREQ_STEP,
    MAX_CHARS,
    normalizeWord,
    charToFreq,
    freqToChar,
    isNear,
    payloadDuration,
    ambientStartOffset,
    playWordPayload,
  };
})();

if (typeof window !== "undefined") {
  window.MindwhisperProtocol = MindwhisperProtocol;
}
