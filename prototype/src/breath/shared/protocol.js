/**
 * Mindwhisper protocol v3.1
 * - Up to 20 letters: 5 slots × 4 frames
 * - Unused slots send an explicit EMPTY tone (not silence → less noise garbage)
 * - Continuous LENGTH carrier so RX knows where the word ends
 * - Watch-style breath taps for presentation
 */

const MindwhisperProtocol = (() => {
  const HANDSHAKE_START = 528;
  const HANDSHAKE_END = 396;
  const HANDSHAKE_GLIDE_START = 0.15;
  const HANDSHAKE_GLIDE_DUR = 1.0;

  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const MAX_CHARS = 20;
  const NUM_SLOTS = 5;
  const NUM_FRAMES = 4;
  const FRAME_DUR = 3.5;
  const FRAME_CROSSFADE = 0.25;

  const LOOP_DUR = 15;
  const INHALE_AT = 2.0;
  const EXHALE_AT = 8.5;
  const TAP_GAP = 0.14;

  const SLOT_CENTERS = [720, 1040, 1360, 1680, 2000];
  const CHAR_STEP = 8.0;
  /** Clear empty marker below letter band for that slot. */
  const EMPTY_OFFSET = -24;

  const FRAME_META = [455, 495, 535, 575];

  /** Length 1..20 below frame-meta band (no overlap with slots). */
  const LENGTH_BASE = 330;
  const LENGTH_STEP = 5;

  const DATA_GAIN = 0.01;
  const EMPTY_GAIN = 0.009;
  const META_GAIN = 0.008;
  const LENGTH_GAIN = 0.008;

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

  function lengthFreq(len) {
    const n = Math.max(1, Math.min(MAX_CHARS, len | 0));
    return LENGTH_BASE + n * LENGTH_STEP;
  }

  function freqToLength(freq) {
    const n = Math.round((freq - LENGTH_BASE) / LENGTH_STEP);
    if (n < 1 || n > MAX_CHARS) return null;
    return n;
  }

  function allLengthFreqs() {
    const out = [];
    for (let n = 1; n <= MAX_CHARS; n++) out.push(lengthFreq(n));
    return out;
  }

  function slotFreq(slot, ch) {
    const center = SLOT_CENTERS[slot];
    if (center == null) return null;
    if (ch == null || ch === "") return center + EMPTY_OFFSET;
    const idx = charIndex(ch);
    if (idx < 0) return center + EMPTY_OFFSET;
    return center + idx * CHAR_STEP;
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

  function playBreathTaps(ctx, destination, type, time) {
    if (type === "inhale") {
      playTap(ctx, destination, time, 0.075);
    } else {
      playTap(ctx, destination, time, 0.07);
      playTap(ctx, destination, time + TAP_GAP, 0.065);
    }
  }

  function startDataMultiplex(ctx, destination, word, startTime) {
    const w = normalizeWord(word);
    const wordLen = Math.max(1, w.length);
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

    const lenOsc = ctx.createOscillator();
    const lenGain = ctx.createGain();
    lenOsc.type = "sine";
    lenOsc.frequency.value = lengthFreq(wordLen);
    lenOsc.connect(lenGain);
    lenGain.connect(destination);
    lenGain.gain.setValueAtTime(0, startTime);
    lenGain.gain.linearRampToValueAtTime(LENGTH_GAIN, startTime + 1.2);
    lenOsc.start(startTime);

    for (let s = 0; s < NUM_SLOTS; s++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 2600;
      osc.type = "sine";
      const ch0 = charAt(w, s);
      osc.frequency.value = slotFreq(s, ch0);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(
        ch0 != null ? DATA_GAIN : EMPTY_GAIN,
        startTime + 1.2,
      );
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
        const targetGain = ch != null ? DATA_GAIN : EMPTY_GAIN;
        slotOsc[s].frequency.setTargetAtTime(freq, at, 0.05);
        const g = slotGain[s].gain;
        g.cancelScheduledValues(at);
        g.setValueAtTime(g.value, at);
        g.linearRampToValueAtTime(targetGain * 0.4, at + FRAME_CROSSFADE * 0.35);
        g.linearRampToValueAtTime(targetGain, at + FRAME_CROSSFADE);
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
      nodes: [...slotOsc, metaOsc, lenOsc],
      gains: [...slotGain, metaGain, lenGain],
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        const t = ctx.currentTime;
        [...slotGain, metaGain, lenGain].forEach((g) => {
          try {
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(g.gain.value, t);
            g.gain.linearRampToValueAtTime(0.001, t + 0.25);
          } catch (_) {}
        });
        [...slotOsc, metaOsc, lenOsc].forEach((o) => {
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
    LENGTH_BASE,
    LENGTH_STEP,
    DATA_GAIN,
    normalizeWord,
    charIndex,
    lengthFreq,
    freqToLength,
    allLengthFreqs,
    slotFreq,
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
