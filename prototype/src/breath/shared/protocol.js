/**
 * Mindwhisper protocol v3
 * - Up to 20 letters via 5 quiet slots × 4 time frames (no chirp stream)
 * - Soft Watch-style breath taps (presentation + optional RX realign)
 * - Warm pad stays separate from sparse data partials
 */

const MindwhisperProtocol = (() => {
  const HANDSHAKE_START = 528;
  const HANDSHAKE_END = 396;
  const HANDSHAKE_GLIDE_START = 0.15;
  const HANDSHAKE_GLIDE_DUR = 1.0;

  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const MAX_CHARS = 20;
  const NUM_SLOTS = 5;
  const NUM_FRAMES = 4; // 5×4 = 20
  const FRAME_DUR = 3.0;
  const FRAME_CROSSFADE = 0.2;

  /** Breath cycle (presentation). */
  const LOOP_DUR = 15;
  const INHALE_AT = 2.0;
  const EXHALE_AT = 8.5;
  const TAP_GAP = 0.14; // double-tap spacing

  /**
   * Only 5 simultaneous data tones (much less buzz than 8–20).
   * Centers spaced for CHAR_STEP×37 span.
   */
  const SLOT_CENTERS = [720, 1040, 1360, 1680, 2000];
  const CHAR_STEP = 8.0;
  const EMPTY_OFFSET = -12;

  /** Quiet frame-id carriers (below data band). */
  const FRAME_META = [455, 495, 535, 575];

  const DATA_GAIN = 0.011;
  const META_GAIN = 0.008;

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
    if (ch == null || ch === "") return center + EMPTY_OFFSET;
    const idx = charIndex(ch);
    if (idx < 0) return center + EMPTY_OFFSET;
    return center + idx * CHAR_STEP;
  }

  function freqToCharInSlot(slot, freq) {
    const center = SLOT_CENTERS[slot];
    if (center == null || freq == null) return null;
    const delta = freq - center;
    if (delta < EMPTY_OFFSET + CHAR_STEP * 0.5) return null;
    const idx = Math.round(delta / CHAR_STEP);
    if (idx < 0 || idx >= CHARSET.length) return null;
    return CHARSET[idx];
  }

  function charAt(word, globalIndex) {
    const w = normalizeWord(word);
    if (globalIndex < 0 || globalIndex >= w.length) return null;
    return w[globalIndex];
  }

  function frameChars(word, frame) {
    const out = [];
    for (let s = 0; s < NUM_SLOTS; s++) {
      out.push(charAt(word, frame * NUM_SLOTS + s));
    }
    return out;
  }

  function makeNoiseBuffer(ctx, seconds = 0.08) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Soft Apple Watch–like tap: short filtered noise, no pitched beep.
   */
  function playTap(ctx, destination, time, peak = 0.07) {
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(ctx, 0.06);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 320;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    src.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.055);
    src.start(time);
    src.stop(time + 0.07);
  }

  /** Inhale = one tap; exhale = double tap. */
  function playBreathTaps(ctx, destination, type, time) {
    if (type === "inhale") {
      playTap(ctx, destination, time, 0.075);
    } else {
      playTap(ctx, destination, time, 0.07);
      playTap(ctx, destination, time + TAP_GAP, 0.065);
    }
  }

  /**
   * Time-multiplexed quiet data: 5 slot oscillators + 1 frame meta.
   * Frequencies rotate every FRAME_DUR. Returns controller { stop, nodes }.
   */
  function startDataMultiplex(ctx, destination, word, startTime) {
    const w = normalizeWord(word);
    const slotOsc = [];
    const slotGain = [];
    const metaOsc = ctx.createOscillator();
    const metaGain = ctx.createGain();

    metaOsc.type = "sine";
    metaOsc.frequency.value = FRAME_META[0];
    metaOsc.connect(metaGain);
    metaGain.connect(destination);
    metaGain.gain.setValueAtTime(0, startTime);
    metaGain.gain.linearRampToValueAtTime(META_GAIN, startTime + 1.2);
    metaOsc.start(startTime);

    for (let s = 0; s < NUM_SLOTS; s++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 2800;
      osc.type = "sine";
      const ch0 = charAt(w, s);
      osc.frequency.value = slotFreq(s, ch0);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      const on = ch0 != null;
      gain.gain.setValueAtTime(0, startTime);
      if (on) gain.gain.linearRampToValueAtTime(DATA_GAIN, startTime + 1.2);
      osc.start(startTime);
      slotOsc.push(osc);
      slotGain.push(gain);
    }

    let frame = 0;
    let timer = null;
    let stopped = false;

    function applyFrame(f, at) {
      const chars = frameChars(w, f);
      metaOsc.frequency.setTargetAtTime(FRAME_META[f], at, 0.05);
      for (let s = 0; s < NUM_SLOTS; s++) {
        const ch = chars[s];
        const freq = slotFreq(s, ch);
        slotOsc[s].frequency.setTargetAtTime(freq, at, 0.04);
        const g = slotGain[s].gain;
        g.cancelScheduledValues(at);
        g.setValueAtTime(g.value, at);
        if (ch != null) {
          g.linearRampToValueAtTime(DATA_GAIN * 0.3, at + FRAME_CROSSFADE * 0.3);
          g.linearRampToValueAtTime(DATA_GAIN, at + FRAME_CROSSFADE);
        } else {
          g.linearRampToValueAtTime(0.001, at + FRAME_CROSSFADE);
        }
      }
    }

    applyFrame(0, startTime);

    function tick() {
      if (stopped) return;
      frame = (frame + 1) % NUM_FRAMES;
      applyFrame(frame, ctx.currentTime);
      timer = setTimeout(tick, FRAME_DUR * 1000);
    }
    timer = setTimeout(tick, FRAME_DUR * 1000);

    return {
      nodes: [...slotOsc, metaOsc],
      gains: [...slotGain, metaGain],
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        const t = ctx.currentTime;
        [...slotGain, metaGain].forEach((g) => {
          try {
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(g.gain.value, t);
            g.gain.linearRampToValueAtTime(0.001, t + 0.25);
          } catch (_) {}
        });
        [...slotOsc, metaOsc].forEach((o) => {
          try { o.stop(t + 0.3); } catch (_) {}
        });
      },
    };
  }

  return {
    HANDSHAKE_START,
    HANDSHAKE_END,
    HANDSHAKE_GLIDE_START,
    HANDSHAKE_GLIDE_DUR,
    CHARSET,
    MAX_CHARS,
    NUM_SLOTS,
    NUM_FRAMES,
    FRAME_DUR,
    LOOP_DUR,
    INHALE_AT,
    EXHALE_AT,
    TAP_GAP,
    SLOT_CENTERS,
    CHAR_STEP,
    EMPTY_OFFSET,
    FRAME_META,
    DATA_GAIN,
    normalizeWord,
    charIndex,
    slotFreq,
    freqToCharInSlot,
    charAt,
    frameChars,
    playTap,
    playBreathTaps,
    startDataMultiplex,
  };
})();

if (typeof window !== "undefined") {
  window.MindwhisperProtocol = MindwhisperProtocol;
}
