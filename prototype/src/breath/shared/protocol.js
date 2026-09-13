/**
 * Mindwhisper ambient word beacon — musical, not modem.
 *
 * Encoding uses soft singing-bowl style notes on an equal-tempered scale
 * (slow attack/release, quiet 2nd harmonic). Pitches are musical intervals,
 * not linear Hz steps — so the phrase reads as a short meditation chime,
 * not data chirps.
 *
 * Beacons once per breath cycle (~15s), not a dense modem stream.
 * Handshake (528→396) stays as a one-shot session perfume only; RX does
 * not depend on it.
 */

const MindwhisperProtocol = (() => {
  const TICK_FREQ = 880;
  const HANDSHAKE_START = 528;
  const HANDSHAKE_END = 396;
  const HANDSHAKE_GLIDE_START = 0.1;
  const HANDSHAKE_GLIDE_DUR = 0.8;

  const FIRST_BEACON_AT = 2.0;
  /** Align with 15s breath cycle — sparse, intentional. */
  const BEACON_INTERVAL = 15.0;

  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const MAX_CHARS = 16;

  /** Soft note length (singing-bowl). */
  const NOTE_DUR = 0.9;
  const NOTE_GAP = 0.22;
  const MOTIF_GAP = 0.35;

  /**
   * Musical pitch set: MIDI 72..107 → C5..B7-ish, phone-audible but not screechy.
   * Index i in CHARSET → midiToFreq(72 + i) for data notes.
   */
  const MIDI_BASE = 72; // C5 ≈ 523 Hz

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function charToMidi(ch) {
    const idx = CHARSET.indexOf(ch);
    if (idx < 0) return null;
    return MIDI_BASE + idx;
  }

  function charToFreq(ch) {
    const midi = charToMidi(ch);
    return midi == null ? null : midiToFreq(midi);
  }

  function freqToMidi(freq) {
    return Math.round(69 + 12 * Math.log2(freq / 440));
  }

  function freqToChar(freq) {
    const midi = freqToMidi(freq);
    const idx = midi - MIDI_BASE;
    if (idx < 0 || idx >= CHARSET.length) return null;
    return CHARSET[idx];
  }

  function isNearFreq(freq, target, cents = 45) {
    if (freq <= 0 || target <= 0) return false;
    const c = 1200 * Math.log2(freq / target);
    return Math.abs(c) <= cents;
  }

  function isNear(freq, target, tolHz = 18) {
    return Math.abs(freq - target) <= tolHz;
  }

  /** Start motif: open fifth C5–G5 (musical “begin”). */
  const START_MIDIS = [72, 79];
  /** End motif: descending E5–C5. */
  const END_MIDIS = [76, 72];

  function normalizeWord(raw) {
    return String(raw || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, "")
      .trim()
      .slice(0, MAX_CHARS);
  }

  function payloadDuration(word) {
    const w = normalizeWord(word);
    const n = Math.max(w.length, 1);
    const startLen = START_MIDIS.length * (NOTE_DUR * 0.55 + MOTIF_GAP);
    const endLen = END_MIDIS.length * (NOTE_DUR * 0.55 + MOTIF_GAP);
    return startLen + n * (NOTE_DUR + NOTE_GAP) + endLen;
  }

  function ambientStartOffset(word) {
    return FIRST_BEACON_AT + 0.3;
  }

  function allDetectFreqs() {
    const freqs = [];
    for (let i = 0; i < CHARSET.length; i++) {
      freqs.push(midiToFreq(MIDI_BASE + i));
    }
    START_MIDIS.forEach((m) => freqs.push(midiToFreq(m)));
    END_MIDIS.forEach((m) => freqs.push(midiToFreq(m)));
    return [...new Set(freqs.map((f) => Math.round(f * 10) / 10))];
  }

  /**
   * Soft bowl partials: fundamental + quiet octave/fifth colour.
   */
  function playBowl(ctx, destination, freq, t, duration, peak = 0.11) {
    const partials = [
      { mul: 1, amp: 1 },
      { mul: 2, amp: 0.22 },
      { mul: 3, amp: 0.08 },
    ];
    for (const p of partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = Math.min(6000, freq * p.mul * 2.5);
      osc.type = "sine";
      osc.frequency.value = freq * p.mul;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(destination);

      const amp = peak * p.amp;
      const attack = Math.min(0.12, duration * 0.15);
      const release = Math.min(0.55, duration * 0.55);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(amp, t + attack);
      gain.gain.setValueAtTime(amp * 0.85, t + duration - release);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    }
  }

  function playMotif(ctx, destination, midis, t, peak = 0.1) {
    let cursor = t;
    const noteLen = NOTE_DUR * 0.55;
    for (const midi of midis) {
      playBowl(ctx, destination, midiToFreq(midi), cursor, noteLen, peak);
      cursor += noteLen + MOTIF_GAP * 0.5;
    }
    return cursor + MOTIF_GAP * 0.5;
  }

  function playWordBeacon(ctx, destination, word, startTime) {
    const w = normalizeWord(word);
    let t = startTime;

    t = playMotif(ctx, destination, START_MIDIS, t, 0.1);

    const chars = w.length ? w : " ";
    for (const ch of chars) {
      const f = charToFreq(ch);
      if (f != null) {
        playBowl(ctx, destination, f, t, NOTE_DUR, 0.12);
        t += NOTE_DUR + NOTE_GAP;
      }
    }

    t = playMotif(ctx, destination, END_MIDIS, t, 0.09);
    return t;
  }

  return {
    TICK_FREQ,
    HANDSHAKE_START,
    HANDSHAKE_END,
    HANDSHAKE_GLIDE_START,
    HANDSHAKE_GLIDE_DUR,
    FIRST_BEACON_AT,
    BEACON_INTERVAL,
    CHARSET,
    MAX_CHARS,
    NOTE_DUR,
    NOTE_GAP,
    MOTIF_GAP,
    MIDI_BASE,
    START_MIDIS,
    END_MIDIS,
    normalizeWord,
    midiToFreq,
    charToMidi,
    charToFreq,
    freqToMidi,
    freqToChar,
    isNearFreq,
    isNear,
    payloadDuration,
    ambientStartOffset,
    allDetectFreqs,
    playBowl,
    playWordBeacon,
  };
})();

if (typeof window !== "undefined") {
  window.MindwhisperProtocol = MindwhisperProtocol;
}
