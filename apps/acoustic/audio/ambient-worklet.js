/**
 * Continuous procedural ambience AudioWorklet (Tide / Elements).
 *
 * Production TX still mixes ambient via main-thread render(n) so the watermark
 * layer stays independent. This worklet provides a continuous, allocation-light
 * path for listening / debug when no protocol mix is required.
 *
 * No audio assets. State evolves until the node is destroyed — no loops.
 *
 * Messages:
 *   { type: 'config', profile: 'tide'|'elements', seed?: number, solo?: string }
 *   { type: 'gain', value: number }
 */
class AmbientNatureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.profile = opts.profile === 'elements' ? 'elements' : 'tide';
    this.seed = (opts.seed >>> 0) || 0xa11ce55;
    this.gain = typeof opts.gain === 'number' ? opts.gain : 0.85;
    this.solo = opts.solo || 'full';
    this._init(sampleRate);
    this.port.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'config') {
        if (m.profile === 'tide' || m.profile === 'elements') this.profile = m.profile;
        if (typeof m.seed === 'number') this.seed = m.seed >>> 0 || 0x1;
        if (m.solo) this.solo = m.solo;
        this._init(sampleRate);
      } else if (m.type === 'gain' && typeof m.value === 'number') {
        this.gain = m.value;
      }
    };
  }

  _xorshift(seed) {
    let state = seed >>> 0 || 0x1;
    return {
      next() {
        let x = state >>> 0;
        x ^= (x << 13) >>> 0;
        x ^= x >>> 17;
        x ^= (x << 5) >>> 0;
        state = x >>> 0;
        return state;
      },
      nextFloat() {
        return this.next() / 0x100000000;
      },
      nextGaussian() {
        const u1 = Math.max(this.nextFloat(), 1e-12);
        const u2 = this.nextFloat();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      },
    };
  }

  _init(sr) {
    this.sr = sr;
    this.rng = this._xorshift(this.seed);
    this.rng2 = this._xorshift(this.seed ^ 0x9e3779b9);
    this.brown = 0;
    this.dcX = 0;
    this.dcY = 0;
    // Paul Kellet pink
    this.b0 = 0;
    this.b1 = 0;
    this.b2 = 0;
    this.b3 = 0;
    this.b4 = 0;
    this.b5 = 0;
    this.b6 = 0;
    this.lpY = [0, 0, 0, 0, 0, 0];
    this.hpIn = [0, 0, 0];
    this.hpOut = [0, 0, 0];
    this.mod = 0.5;
    this.modT = 0.5;
    this.modN = Math.floor(sr * 2);
    this.t = 0;
    this.nextWave = 3;
    this.waveStart = -100;
    this.rise = 2.2;
    this.crest = 0.5;
    this.release = 4;
    this.waveAmp = 1;
    this.dropRate = 12 / sr;
  }

  _pink(white) {
    this.b0 = 0.99886 * this.b0 + white * 0.0555179;
    this.b1 = 0.99332 * this.b1 + white * 0.0750759;
    this.b2 = 0.969 * this.b2 + white * 0.153852;
    this.b3 = 0.8665 * this.b3 + white * 0.3104856;
    this.b4 = 0.55 * this.b4 + white * 0.5329522;
    this.b5 = -0.7616 * this.b5 - white * 0.016898;
    const pink =
      this.b0 +
      this.b1 +
      this.b2 +
      this.b3 +
      this.b4 +
      this.b5 +
      this.b6 +
      white * 0.5362;
    this.b6 = white * 0.115926;
    return pink * 0.11;
  }

  _brown(white) {
    this.brown = 0.996 * this.brown + 0.04 * white;
    const x = this.brown;
    this.dcY = x - this.dcX + 0.995 * this.dcY;
    this.dcX = x;
    return this.dcY;
  }

  _lp(i, x, coef) {
    this.lpY[i] = (1 - coef) * x + coef * this.lpY[i];
    return this.lpY[i];
  }

  _hp(i, x, coef) {
    const y = coef * (this.hpOut[i] + x - this.hpIn[i]);
    this.hpIn[i] = x;
    this.hpOut[i] = y;
    return y;
  }

  _smoothstep(x) {
    const t = x < 0 ? 0 : x > 1 ? 1 : x;
    return t * t * (3 - 2 * t);
  }

  _waveEnv(wt) {
    if (wt < 0) return 0;
    if (wt < this.rise) {
      const s = this._smoothstep(wt / this.rise);
      return s * s;
    }
    if (wt < this.rise + this.crest) return 0.96;
    if (wt < this.rise + this.crest + this.release) {
      const x = (wt - this.rise - this.crest) / this.release;
      return Math.max(0, Math.exp(-2.4 * x) * 0.85 + (1 - x) * (1 - x) * 0.15);
    }
    return 0;
  }

  _nextMod() {
    if (--this.modN <= 0) {
      this.modT = this.rng.nextFloat();
      this.modN = Math.floor(this.sr * (1.5 + this.rng.nextFloat() * 6));
    }
    this.mod = 0.9992 * this.mod + 0.0008 * this.modT;
    return this.mod;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const sr = this.sr;
    for (let i = 0; i < n; i++) {
      const white = this.rng.nextGaussian();
      const pink = this._pink(white);
      const brown = this._brown(white);
      const mod = this._nextMod();
      let s = 0;

      if (this.profile === 'tide') {
        if (this.t >= this.nextWave) {
          this.waveStart = this.t;
          this.rise = 1.8 + this.rng2.nextFloat() * 1.2;
          this.crest = 0.3 + this.rng2.nextFloat() * 0.5;
          this.release = 3 + this.rng2.nextFloat() * 2.5;
          this.waveAmp = 0.82 + this.rng2.nextFloat() * 0.28;
          // ~N(8,1.2) clamped via sum-of-uniforms
          let g = 0;
          for (let k = 0; k < 6; k++) g += this.rng2.nextFloat();
          const iv = Math.min(10.5, Math.max(5.8, 8 + ((g - 3) / Math.SQRT2) * 1.2));
          this.nextWave = this.t + iv;
        }
        const env = this._waveEnv(this.t - this.waveStart) * this.waveAmp;
        const bed = this._lp(0, this._hp(0, brown, 0.995), 0.96) * (0.72 + 0.28 * mod);
        const body = this._lp(1, this._hp(1, brown * 0.8 + pink * 0.2, 0.99), 0.85) * env;
        const foam = this._lp(2, this._hp(2, pink, 0.97), 0.7) * env * (0.4 + 0.6 * env);
        const spray = this._lp(3, pink * 0.3 + white * 0.05, 0.55) * (0.05 + env * 0.12);
        s = bed * 0.16 + body * 0.42 + foam * 0.28 + spray;
      } else {
        // Elements: rain + wind + sparse distant water
        const rain = this._lp(0, this._hp(0, pink * 0.7 + white * 0.2, 0.92), 0.55) *
          (0.78 + 0.22 * mod);
        let drop = 0;
        if (this.rng.nextFloat() < this.dropRate * (0.6 + mod)) {
          drop = white * (0.08 + this.rng.nextFloat() * 0.2);
        }
        drop = this._lp(1, drop, 0.6);
        const wind =
          this._lp(2, this._hp(1, brown, 0.995), 0.88) * (0.7 + 0.3 * mod);
        if (this.t >= this.nextWave) {
          this.waveStart = this.t;
          this.rise = 2 + this.rng2.nextFloat();
          this.crest = 0.5;
          this.release = 4 + this.rng2.nextFloat() * 2;
          this.waveAmp = 0.6;
          this.nextWave = this.t + 9 + this.rng2.nextFloat() * 6;
        }
        const wEnv = this._waveEnv(this.t - this.waveStart) * this.waveAmp;
        const water = this._lp(3, brown, 0.97) * wEnv;
        s = rain * 0.38 + drop * 0.14 + wind * 0.22 + water * 0.1;
      }

      out[i] = Math.max(-1, Math.min(1, s * this.gain));
      this.t += 1 / sr;
    }
    return true;
  }
}

registerProcessor('ambient-nature-processor', AmbientNatureProcessor);
