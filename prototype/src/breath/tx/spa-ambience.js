/**
 * Procedural spa / meditation ambience (Epidemic Sound–adjacent feel).
 * Fully synthesized — works offline, no third-party audio downloads.
 *
 * Optional: place a licensed loop at /tx/assets/spa-loop.mp3|ogg|wav and
 * it will be used as the bed instead (crossfaded seamless loop).
 */
class SpaAmbience {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.nodes = [];
    this.sources = [];
    this.started = false;
    this.bus = null;
    this.sampleSource = null;
  }

  async start(word, startTime) {
    if (this.started) return;
    this.started = true;

    const bus = this.ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.destination);
    this.bus = bus;
    this.nodes.push(bus);

    // Soft master duck-in
    bus.gain.setValueAtTime(0, startTime);
    bus.gain.linearRampToValueAtTime(1, startTime + 2.5);

    const usedSample = await this.tryLoadSampleLoop(bus, startTime);
    if (!usedSample) {
      this.buildSyntheticSpa(bus, word, startTime);
    }

    this.createReverbTail(bus, startTime);
  }

  async tryLoadSampleLoop(bus, startTime) {
    const candidates = [
      "/tx/assets/spa-loop.mp3",
      "/tx/assets/spa-loop.ogg",
      "/tx/assets/spa-loop.wav",
      "/tx/assets/spa-loop.m4a",
      // Freesound CC sample (stanrams — meditation-one)
      "/tx/assets/583998__stanrams__meditation-one.mp3",
    ];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) continue;
        const arr = await res.arrayBuffer();
        const buffer = await this.ctx.decodeAudioData(arr.slice(0));
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        // Crossfade loop edges slightly via gain envelope on a duplicate? simple loop OK
        const filter = this.ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 5000;
        const gain = this.ctx.createGain();
        gain.gain.value = 0.55;
        src.connect(filter);
        filter.connect(gain);
        gain.connect(bus);
        src.start(startTime);
        this.sampleSource = src;
        this.sources.push(src);
        this.nodes.push(filter, gain);
        return true;
      } catch (_) {
        // try next
      }
    }
    return false;
  }

  hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  rnd(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  /** Impulse response for a soft spa hall. */
  createReverbTail(input, startTime) {
    const seconds = 3.2;
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const impulse = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.8) * 0.35;
      }
    }
    const convolver = this.ctx.createConvolver();
    convolver.buffer = impulse;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.45;
    const dry = this.ctx.createGain();
    dry.gain.value = 0.7;

    // Split: dry stays, wet through convolver
    // Re-route: input already is bus — add send
    const send = this.ctx.createGain();
    send.gain.value = 0.55;
    input.connect(send);
    send.connect(convolver);
    convolver.connect(wet);
    wet.connect(this.destination);

    this.nodes.push(convolver, wet, dry, send);
  }

  buildSyntheticSpa(bus, word, startTime) {
    const h = this.hash((word || "spa").toLowerCase());

    // --- Warm root drone (C-ish cluster, detuned) ---
    const roots = [65.4, 98.0, 130.8, 196.0]; // C2 G2 C3 G3
    roots.forEach((f, i) => {
      const seed = h + i * 17;
      this.addPadVoice(bus, {
        freq: f * (1 + (this.rnd(seed) - 0.5) * 0.004),
        detune: (this.rnd(seed + 1) - 0.5) * 8,
        gain: 0.045 + this.rnd(seed + 2) * 0.02,
        lfoRate: 0.02 + this.rnd(seed + 3) * 0.04,
        lfoDepth: 0.25,
        cutoff: 220 + i * 40,
        startTime,
      });
    });

    // --- Soft fifth / airy shimmer (very quiet) ---
    const airs = [261.6, 329.6, 392.0]; // C4 E4 G4
    airs.forEach((f, i) => {
      const seed = h + 100 + i * 13;
      this.addPadVoice(bus, {
        freq: f,
        detune: (this.rnd(seed) - 0.5) * 6,
        gain: 0.012 + this.rnd(seed + 1) * 0.008,
        lfoRate: 0.015 + this.rnd(seed + 2) * 0.03,
        lfoDepth: 0.4,
        cutoff: 900,
        startTime,
      });
    });

    // --- Word-colored quiet partial (still low, musical) ---
    const color = 110 + (h % 90);
    this.addPadVoice(bus, {
      freq: color,
      detune: 0,
      gain: 0.028,
      lfoRate: 0.035,
      lfoDepth: 0.3,
      cutoff: 350,
      startTime,
    });

    // --- Soft room / breath air (pink) ---
    this.addAirTexture(bus, startTime);

    // --- Occasional distant bowl (sparse, spa-like — not data) ---
    this.scheduleSparseBowls(bus, startTime, h);
  }

  addPadVoice(bus, { freq, detune, gain, lfoRate, lfoDepth, cutoff, startTime }) {
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const merge = this.ctx.createGain();
    const harm = this.ctx.createGain();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();

    osc.type = "sine";
    osc2.type = "sine";
    osc.frequency.value = freq;
    osc2.frequency.value = freq * 2;
    osc.detune.value = detune;
    osc2.detune.value = detune * 1.2;
    harm.gain.value = 0.2;
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    filter.Q.value = 0.4;
    g.gain.value = gain;
    lfo.frequency.value = lfoRate;
    lfoG.gain.value = gain * lfoDepth;
    lfo.connect(lfoG);
    lfoG.connect(g.gain);

    osc.connect(merge);
    osc2.connect(harm);
    harm.connect(merge);
    merge.connect(filter);
    filter.connect(g);
    g.connect(bus);

    lfo.start(startTime);
    osc.start(startTime);
    osc2.start(startTime);
    this.sources.push(osc, osc2, lfo);
    this.nodes.push(g, harm, filter, merge, lfoG);
  }

  addAirTexture(bus, startTime) {
    const n = this.ctx.sampleRate * 5;
    const buffer = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      // Paul Kellet pink-ish
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 280;
    bp.Q.value = 0.6;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    const g = this.ctx.createGain();
    g.gain.value = 0.04;
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();
    lfo.frequency.value = 0.04;
    lfoG.gain.value = 0.012;
    lfo.connect(lfoG);
    lfoG.connect(g.gain);
    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    g.connect(bus);
    lfo.start(startTime);
    src.start(startTime);
    this.sources.push(src, lfo);
    this.nodes.push(bp, lp, g, lfoG);
  }

  scheduleSparseBowls(bus, startTime, hash) {
    // First bowl after ~6s, then every ~18–25s — soft, distant
    let t = startTime + 6 + (hash % 5);
    const strike = (time, freq, peak) => {
      const osc = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 1200;
      osc.type = "sine";
      osc2.type = "sine";
      osc.frequency.value = freq;
      osc2.frequency.value = freq * 2.01;
      osc.connect(f);
      osc2.connect(f);
      f.connect(g);
      g.connect(bus);
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(peak, time + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, time + 4.5);
      osc.start(time);
      osc2.start(time);
      osc.stop(time + 5);
      osc2.stop(time + 5);
    };

    // Schedule a handful ahead; spa feel = rare
    for (let i = 0; i < 8; i++) {
      const freq = 196 * Math.pow(2, ((hash + i * 3) % 5) / 12); // around G3 neighborhood
      strike(t, freq, 0.035);
      t += 18 + (hash % 7) + i * 0.3;
    }
  }

  stop() {
    const t = this.ctx.currentTime;
    if (this.bus) {
      try {
        this.bus.gain.cancelScheduledValues(t);
        this.bus.gain.setValueAtTime(this.bus.gain.value, t);
        this.bus.gain.linearRampToValueAtTime(0.001, t + 0.4);
      } catch (_) {}
    }
    this.sources.forEach((s) => {
      try { s.stop(t + 0.45); } catch (_) {}
    });
    this.sources = [];
    this.nodes = [];
    this.sampleSource = null;
    this.bus = null;
    this.started = false;
  }
}

if (typeof window !== "undefined") {
  window.SpaAmbience = SpaAmbience;
}
