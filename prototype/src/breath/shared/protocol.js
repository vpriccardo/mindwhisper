/**
 * Mindwhisper protocol v4 — soft dual-tone chimes (not a continuous modem).
 * Word is whispered as sparse bowl-like pairs under the spa bed.
 * No handshake glide. Up to 20 letters.
 */

const MindwhisperProtocol = (() => {
  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const MAX_CHARS = 20;

  const LOOP_DUR = 15;
  const INHALE_AT = 2.0;
  const EXHALE_AT = 8.5;
  const TAP_GAP = 0.14;

  /** 6×7 grid → 42 pairs (charset + SYNC + spare). */
  const LOWS = [760, 840, 920, 1010, 1110, 1220];
  const HIGHS = [1680, 1840, 2010, 2200, 2400, 2620, 2860];

  const SYNC_IDX = 40; // reserved pair
  const CHIME_DUR = 0.16;
  const CHIME_GAP = 0.42;
  const WORD_GAP = 1.6;
  /** Brief peak — average energy stays low; not a continuous drone. */
  const CHIME_GAIN = 0.055;

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

  function pairForIndex(idx) {
    const i = ((idx % (LOWS.length * HIGHS.length)) + LOWS.length * HIGHS.length)
      % (LOWS.length * HIGHS.length);
    return {
      low: LOWS[i % LOWS.length],
      high: HIGHS[Math.floor(i / LOWS.length) % HIGHS.length],
      idx: i,
    };
  }

  function indexFromTones(lowFreq, highFreq) {
    let bestL = -1;
    let bestH = -1;
    let dL = Infinity;
    let dH = Infinity;
    for (let i = 0; i < LOWS.length; i++) {
      const d = Math.abs(LOWS[i] - lowFreq);
      if (d < dL) {
        dL = d;
        bestL = i;
      }
    }
    for (let i = 0; i < HIGHS.length; i++) {
      const d = Math.abs(HIGHS[i] - highFreq);
      if (d < dH) {
        dH = d;
        bestH = i;
      }
    }
    if (bestL < 0 || bestH < 0) return null;
    if (dL > 45 || dH > 55) return null;
    return bestL + bestH * LOWS.length;
  }

  function symbolForChar(ch) {
    const idx = charIndex(ch);
    if (idx < 0) return null;
    return pairForIndex(idx);
  }

  function symbolForLength(len) {
    const n = Math.max(1, Math.min(MAX_CHARS, len | 0));
    // Length uses indices 0..19 (same as first 20 charset slots is fine —
    // stream position tells RX this is length, not a letter).
    return pairForIndex(n - 1);
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

  /** Soft dual partial — like a distant bowl, not a modem carrier. */
  function playChime(ctx, destination, low, high, time, peak = CHIME_GAIN) {
    const nodes = [];
    [low, high].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const filt = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      filt.type = "bandpass";
      filt.frequency.value = freq;
      filt.Q.value = 6;
      osc.connect(filt);
      filt.connect(gain);
      gain.connect(destination);
      const p = peak * (i === 0 ? 1 : 0.85);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(p, time + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + CHIME_DUR);
      osc.start(time);
      osc.stop(time + CHIME_DUR + 0.04);
      nodes.push(osc, filt, gain);
    });
    return nodes;
  }

  /**
   * Whisper the word as: SYNC → LENGTH → chars… then pause and repeat.
   * Sparse enough to hide under spa ambience.
   */
  function startDataMultiplex(ctx, destination, word, startTime) {
    const w = normalizeWord(word);
    const wordLen = Math.max(1, w.length);
    const symbols = [];
    symbols.push(pairForIndex(SYNC_IDX));
    symbols.push(symbolForLength(wordLen));
    for (let i = 0; i < wordLen; i++) {
      symbols.push(symbolForChar(w[i]));
    }

    let stopped = false;
    let timer = null;
    let live = [];

    function scheduleCycle(at) {
      if (stopped) return;
      let t = at;
      symbols.forEach((sym) => {
        if (!sym) return;
        const nodes = playChime(ctx, destination, sym.low, sym.high, t);
        live.push(...nodes);
        t += CHIME_DUR + CHIME_GAP;
      });
      const next = t + WORD_GAP;
      const waitMs = Math.max(50, (next - ctx.currentTime) * 1000);
      timer = setTimeout(() => {
        live = [];
        scheduleCycle(ctx.currentTime + 0.05);
      }, waitMs);
    }

    scheduleCycle(Math.max(startTime, ctx.currentTime + 0.05));

    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        const t = ctx.currentTime;
        live.forEach((n) => {
          try {
            if (n.stop) n.stop(t);
            if (n.disconnect) n.disconnect();
          } catch (_) {}
        });
        live = [];
      },
    };
  }

  return {
    CHARSET,
    MAX_CHARS,
    LOOP_DUR,
    INHALE_AT,
    EXHALE_AT,
    TAP_GAP,
    LOWS,
    HIGHS,
    SYNC_IDX,
    CHIME_DUR,
    CHIME_GAP,
    WORD_GAP,
    CHIME_GAIN,
    normalizeWord,
    charIndex,
    pairForIndex,
    indexFromTones,
    symbolForChar,
    symbolForLength,
    playTap,
    playBreathTaps,
    playChime,
    startDataMultiplex,
  };
})();

if (typeof window !== "undefined") {
  window.MindwhisperProtocol = MindwhisperProtocol;
}
