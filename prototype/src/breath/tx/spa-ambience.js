/**
 * Procedural spa / meditation ambience with selectable soundscapes.
 * Fully offline. Optional sample loop for Temple One.
 */
class SpaAmbience {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.nodes = [];
    this.sources = [];
    this.started = false;
    this.bus = null;
  }

  async start(word, startTime, soundscapeId = "mist-grove") {
    if (this.started) return;
    this.started = true;
    const preset =
      (window.MindwhisperSoundscapes &&
        MindwhisperSoundscapes.byId(soundscapeId)) ||
      { id: "mist-grove", kind: "synth", palette: "grove" };

    const bus = this.ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.destination);
    this.bus = bus;
    this.nodes.push(bus);
    bus.gain.setValueAtTime(0, startTime);
    bus.gain.linearRampToValueAtTime(1, startTime + 2.2);

    let usedSample = false;
    if (preset.kind === "sample" && preset.urls) {
      usedSample = await this.tryLoadSampleLoop(bus, startTime, preset.urls);
    }
    if (!usedSample) {
      this.buildSyntheticSpa(bus, word, startTime, preset.palette || "grove");
    }
    this.createReverbTail(bus, startTime, preset.palette || "grove");
  }

  async tryLoadSampleLoop(bus, startTime, urls) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) continue;
        const arr = await res.arrayBuffer();
        const buffer = await this.ctx.decodeAudioData(arr.slice(0));
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const filter = this.ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 4800;
        const gain = this.ctx.createGain();
        gain.gain.value = 0.58;
        src.connect(filter);
        filter.connect(gain);
        gain.connect(bus);
        src.start(startTime);
        this.sources.push(src);
        this.nodes.push(filter, gain);
        return true;
      } catch (_) {}
    }
    return false;
  }

  hash(str) {
    let h = 0;
    for (let i = 0; i < (str || "").length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  rnd(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  createReverbTail(input, startTime, palette) {
    const wetAmt = palette === "ember" ? 0.55 : palette === "glass" ? 0.4 : 0.45;
    const seconds = palette === "tide" ? 2.6 : 3.4;
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const impulse = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.8) * 0.32;
      }
    }
    const convolver = this.ctx.createConvolver();
    convolver.buffer = impulse;
    const wet = this.ctx.createGain();
    wet.gain.value = wetAmt;
    const send = this.ctx.createGain();
    send.gain.value = 0.5;
    input.connect(send);
    send.connect(convolver);
    convolver.connect(wet);
    wet.connect(this.destination);
    this.nodes.push(convolver, wet, send);
  }

  buildSyntheticSpa(bus, word, startTime, palette) {
    const h = this.hash((word || "spa").toLowerCase());
    const configs = {
      grove: {
        roots: [65.4, 98.0, 130.8, 196.0],
        airs: [261.6, 329.6, 392.0],
        airGain: 0.012,
        noise: 0.04,
        bowls: true,
      },
      tide: {
        roots: [55, 82.4, 110, 164.8],
        airs: [220, 277, 330],
        airGain: 0.008,
        noise: 0.07,
        bowls: false,
      },
      ember: {
        roots: [49, 73.4, 98, 146.8],
        airs: [196, 246.9],
        airGain: 0.01,
        noise: 0.03,
        bowls: true,
      },
      glass: {
        roots: [82.4, 123.5, 164.8],
        airs: [329.6, 415.3, 523.3],
        airGain: 0.018,
        noise: 0.025,
        bowls: true,
      },
    };
    const c = configs[palette] || configs.grove;

    c.roots.forEach((f, i) => {
      const seed = h + i * 17;
      this.addPadVoice(bus, {
        freq: f * (1 + (this.rnd(seed) - 0.5) * 0.004),
        detune: (this.rnd(seed + 1) - 0.5) * 8,
        gain: 0.045 + this.rnd(seed + 2) * 0.02,
        lfoRate: 0.02 + this.rnd(seed + 3) * 0.04,
        lfoDepth: 0.25,
        cutoff: 200 + i * 35,
        startTime,
      });
    });

    c.airs.forEach((f, i) => {
      const seed = h + 100 + i * 13;
      this.addPadVoice(bus, {
        freq: f,
        detune: (this.rnd(seed) - 0.5) * 6,
        gain: c.airGain + this.rnd(seed + 1) * 0.006,
        lfoRate: 0.015 + this.rnd(seed + 2) * 0.03,
        lfoDepth: 0.4,
        cutoff: palette === "glass" ? 1400 : 900,
        startTime,
      });
    });

    this.addAirTexture(bus, startTime, c.noise, palette);
    if (c.bowls) this.scheduleSparseBowls(bus, startTime, h, palette);
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

  addAirTexture(bus, startTime, level, palette) {
    const n = this.ctx.sampleRate * 5;
    const buffer = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
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
    bp.frequency.value = palette === "tide" ? 180 : 280;
    bp.Q.value = palette === "tide" ? 0.4 : 0.6;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = palette === "tide" ? 900 : 600;
    const g = this.ctx.createGain();
    g.gain.value = level;
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();
    lfo.frequency.value = 0.04;
    lfoG.gain.value = level * 0.3;
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

  scheduleSparseBowls(bus, startTime, hash, palette) {
    let t = startTime + 6 + (hash % 5);
    const base = palette === "ember" ? 147 : palette === "glass" ? 247 : 196;
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
    for (let i = 0; i < 8; i++) {
      const freq = base * Math.pow(2, ((hash + i * 3) % 5) / 12);
      strike(t, freq, 0.032);
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
    this.bus = null;
    this.started = false;
  }
}

if (typeof window !== "undefined") {
  window.SpaAmbience = SpaAmbience;
}
