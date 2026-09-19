/**
 * Mindwhisper protocol — breath presentation helpers only.
 * Word sync is digital (see sync.js). Nothing is encoded into the audio.
 */

const MindwhisperProtocol = (() => {
  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const MAX_CHARS = 20;

  const LOOP_DUR = 15;
  const INHALE_AT = 2.0;
  const EXHALE_AT = 8.5;
  const TAP_GAP = 0.14;

  function normalizeWord(raw) {
    return String(raw || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, "")
      .trim()
      .slice(0, MAX_CHARS);
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

  return {
    CHARSET,
    MAX_CHARS,
    LOOP_DUR,
    INHALE_AT,
    EXHALE_AT,
    TAP_GAP,
    normalizeWord,
    playTap,
    playBreathTaps,
  };
})();

if (typeof window !== "undefined") {
  window.MindwhisperProtocol = MindwhisperProtocol;
}
