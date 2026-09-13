/**
 * Mindwhisper — continuous quiet spectral encoding (no beacons / no modem).
 *
 * The word is held as a stable set of very soft partials under the pad.
 * One tone per character slot; frequency inside the slot encodes the letter.
 * To a listener this is just a slightly richer drone — no chirps, no phrases.
 *
 * RX averages Goertzel energy per slot and maps the peak back to a character.
 */

const MindwhisperProtocol = (() => {
  const TICK_FREQ = 880;
  const HANDSHAKE_START = 528;
  const HANDSHAKE_END = 396;
  const HANDSHAKE_GLIDE_START = 0.1;
  const HANDSHAKE_GLIDE_DUR = 0.9;

  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const MAX_CHARS = 8;

  /**
   * Slot centers (Hz). Spacing > charset span so letters don't bleed.
   * CHAR_STEP 8 Hz × 37 ≈ 296 Hz; centers ~320 Hz apart.
   */
  const SLOT_CENTERS = [900, 1220, 1540, 1860, 2180, 2500, 2820, 3140];
  const CHAR_STEP = 8.0;
  const EMPTY_OFFSET = -12;

  /** Quiet but still pickable on iPhone speaker→mic. */
  const DATA_GAIN = 0.02;
  const DATA_GAIN_2ND = 0.005;

  function normalizeWord(raw) {
    return String(raw || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, "")
      .trim()
      .slice(0, MAX_CHARS);
  }

  function charIndex(ch) {
    return CHARSET.indexOf(ch);
  }

  function slotFreq(slot, ch) {
    const center = SLOT_CENTERS[slot];
    if (center == null) return null;
    if (ch == null || ch === "") {
      return center + EMPTY_OFFSET;
    }
    const idx = charIndex(ch);
    if (idx < 0) return center + EMPTY_OFFSET;
    return center + idx * CHAR_STEP;
  }

  function freqToCharInSlot(slot, freq) {
    const center = SLOT_CENTERS[slot];
    if (center == null || freq == null) return null;
    const delta = freq - center;
    if (delta < EMPTY_OFFSET + CHAR_STEP * 0.5) return null; // empty
    const idx = Math.round(delta / CHAR_STEP);
    if (idx < 0 || idx >= CHARSET.length) return null;
    return CHARSET[idx];
  }

  function candidateFreqsForSlot(slot) {
    const freqs = [slotFreq(slot, null)];
    for (let i = 0; i < CHARSET.length; i++) {
      freqs.push(SLOT_CENTERS[slot] + i * CHAR_STEP);
    }
    return freqs;
  }

  function allDetectFreqs() {
    const out = [];
    for (let s = 0; s < MAX_CHARS; s++) {
      out.push(...candidateFreqsForSlot(s));
    }
    return out;
  }

  function wordToSlotFreqs(word) {
    const w = normalizeWord(word);
    const freqs = [];
    for (let s = 0; s < MAX_CHARS; s++) {
      const ch = s < w.length ? w[s] : null;
      freqs.push({ slot: s, ch, freq: slotFreq(s, ch), active: s < w.length });
    }
    return freqs;
  }

  /**
   * Start continuous quiet data partials. Returns oscillator nodes to stop later.
   */
  function startDataChord(ctx, destination, word, startTime) {
    const nodes = [];
    const slots = wordToSlotFreqs(word);
    for (const slot of slots) {
      if (!slot.active) continue; // unused slots stay silent (length = # active)

      for (const [mul, gainMul] of [
        [1, DATA_GAIN],
        [2, DATA_GAIN_2ND],
      ]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = slot.freq * mul;
        filter.Q.value = 8;
        osc.type = "sine";
        osc.frequency.value = slot.freq * mul;
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(destination);
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(gainMul, startTime + 1.5);
        osc.start(startTime);
        nodes.push({ osc, gain });
      }
    }
    return nodes;
  }

  return {
    TICK_FREQ,
    HANDSHAKE_START,
    HANDSHAKE_END,
    HANDSHAKE_GLIDE_START,
    HANDSHAKE_GLIDE_DUR,
    CHARSET,
    MAX_CHARS,
    SLOT_CENTERS,
    CHAR_STEP,
    EMPTY_OFFSET,
    DATA_GAIN,
    normalizeWord,
    charIndex,
    slotFreq,
    freqToCharInSlot,
    candidateFreqsForSlot,
    allDetectFreqs,
    wordToSlotFreqs,
    startDataChord,
  };
})();

if (typeof window !== "undefined") {
  window.MindwhisperProtocol = MindwhisperProtocol;
}
