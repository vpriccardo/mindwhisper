class MindwhisperEngine {
    constructor() {
        this.audioContext = null;
        this.isPlaying = false;
        this.loopStartTime = 0;
        this.loopDuration = 15;
        this.handshakeDuration = 1.5;
        this.currentWord = '';
        this.oscillators = [];
        this.gainNodes = [];
        this.masterGain = null;
        this.noiseNode = null;
        this.schedulerTimer = null;
        this.nextScheduleTime = 0;
        this.scheduleAhead = 30.0;
        this.breathCallbacks = [];
    }

    async initialize() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    seededRandom(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    generateAmbienceParams(word) {
        const hash = this.simpleHash(word.toLowerCase());
        const params = {
            baseFreqs: [],
            volumes: [],
            detunes: [],
            lfoRates: []
        };

        for (let i = 0; i < 5; i++) {
            const seed = hash + i * 1000;
            const freq = 80 + this.seededRandom(seed) * 300;
            const volume = 0.06 + this.seededRandom(seed + 100) * 0.09;
            const detune = (this.seededRandom(seed + 200) - 0.5) * 20;
            const lfoRate = 0.1 + this.seededRandom(seed + 300) * 0.4;
            
            params.baseFreqs.push(freq);
            params.volumes.push(volume);
            params.detunes.push(detune);
            params.lfoRates.push(lfoRate);
        }

        return params;
    }

    playHandshake() {
        const now = this.audioContext.currentTime;
        
        const tick = this.audioContext.createOscillator();
        const tickGain = this.audioContext.createGain();
        
        tick.connect(tickGain);
        tickGain.connect(this.masterGain);
        
        tick.frequency.value = 880;
        tickGain.gain.setValueAtTime(0, now);
        tickGain.gain.linearRampToValueAtTime(0.1, now + 0.005);
        tickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        
        tick.start(now);
        tick.stop(now + 0.1);
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.masterGain);
        
        osc.frequency.setValueAtTime(528, now + 0.1);
        osc.frequency.exponentialRampToValueAtTime(396, now + 0.9);
        
        gain.gain.setValueAtTime(0, now + 0.1);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.15);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.5);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
        
        osc.start(now + 0.1);
        osc.stop(now + 1.3);
    }

    createAmbientLayer(frequency, volume, detune, lfoRate, startTime) {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const lfoGain = this.audioContext.createGain();
        const lfo = this.audioContext.createOscillator();
        const filter = this.audioContext.createBiquadFilter();
        
        osc.type = 'sine';
        osc.frequency.value = frequency;
        osc.detune.value = detune;
        
        filter.type = 'lowpass';
        filter.frequency.value = 800;
        filter.Q.value = 1;
        
        lfo.frequency.value = lfoRate;
        lfoGain.gain.value = volume * 0.3;
        
        gain.gain.value = volume * 0.7;
        
        lfo.connect(lfoGain);
        lfoGain.connect(gain.gain);
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        this.oscillators.push(osc);
        this.oscillators.push(lfo);
        this.gainNodes.push(gain);
        
        lfo.start(startTime);
        
        return osc;
    }
    
    createNoiseLayer(startTime) {
        const bufferSize = this.audioContext.sampleRate * 2;
        const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const data = buffer.getChannelData(0);
        
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        
        const noise = this.audioContext.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        
        const noiseFilter = this.audioContext.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.value = 200;
        noiseFilter.Q.value = 1;
        
        const noiseGain = this.audioContext.createGain();
        noiseGain.gain.value = 0.015;
        
        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.masterGain);
        
        this.noiseNode = noise;
        this.gainNodes.push(noiseGain);
        
        noise.start(startTime);
    }

    playBreathCue(type, time) {
        const osc1 = this.audioContext.createOscillator();
        const osc2 = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        filter.type = 'lowpass';
        filter.frequency.value = 2000;
        filter.Q.value = 2;
        
        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        const duration = 0.4;
        
        if (type === 'inhale') {
            osc1.frequency.setValueAtTime(440, time);
            osc1.frequency.linearRampToValueAtTime(550, time + duration);
            
            osc2.frequency.setValueAtTime(880, time);
            osc2.frequency.linearRampToValueAtTime(1100, time + duration);
            
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.08, time + 0.08);
            gain.gain.linearRampToValueAtTime(0.05, time + duration * 0.7);
            gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
        } else {
            osc1.frequency.setValueAtTime(440, time);
            osc1.frequency.linearRampToValueAtTime(330, time + duration);
            
            osc2.frequency.setValueAtTime(880, time);
            osc2.frequency.linearRampToValueAtTime(660, time + duration);
            
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.08, time + 0.08);
            gain.gain.linearRampToValueAtTime(0.05, time + duration * 0.7);
            gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
        }
        
        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.start(time);
        osc2.start(time);
        osc1.stop(time + duration + 0.1);
        osc2.stop(time + duration + 0.1);
    }
    
    scheduleBreathsForLoop(loopNumber) {
        const loopTime = this.loopStartTime + (loopNumber * this.loopDuration);
        const inhaleTime = loopTime + 2;
        const exhaleTime = loopTime + 8.5;
        
        if (inhaleTime > this.nextScheduleTime) {
            this.playBreathCue('inhale', inhaleTime);
            this.notifyBreath('inhale', inhaleTime);
        }
        
        if (exhaleTime > this.nextScheduleTime) {
            this.playBreathCue('exhale', exhaleTime);
            this.notifyBreath('exhale', exhaleTime);
        }
    }
    
    scheduler() {
        if (!this.isPlaying) return;
        
        const now = this.audioContext.currentTime;
        
        while (this.nextScheduleTime < now + this.scheduleAhead) {
            const loopNumber = Math.floor((this.nextScheduleTime - this.loopStartTime) / this.loopDuration);
            this.scheduleBreathsForLoop(loopNumber);
            this.nextScheduleTime += this.loopDuration;
        }
        
        this.schedulerTimer = setTimeout(() => this.scheduler(), 5000);
    }
    
    onBreath(callback) {
        this.breathCallbacks.push(callback);
    }
    
    notifyBreath(type, time) {
        this.breathCallbacks.forEach(cb => cb(type, time));
    }
    
    getPhase() {
        if (!this.isPlaying || !this.audioContext) {
            return { phase: 'idle', elapsed: 0, cycleProgress: 0 };
        }
        
        const now = this.audioContext.currentTime;
        const elapsed = now - this.loopStartTime;
        const cycleTime = elapsed % this.loopDuration;
        const cycleProgress = cycleTime / this.loopDuration;
        
        let phase = 'rest';
        if (cycleTime >= 2 && cycleTime < 7) {
            phase = 'inhale';
        } else if (cycleTime >= 8.5 && cycleTime < 13.5) {
            phase = 'exhale';
        }
        
        return {
            phase,
            elapsed,
            cycleTime,
            cycleProgress,
            loopNumber: Math.floor(elapsed / this.loopDuration)
        };
    }

    async start(word) {
        await this.initialize();
        
        if (this.isPlaying) {
            this.stop();
        }
        
        this.currentWord = word;
        this.isPlaying = true;
        this.breathCallbacks = [];
        
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = 1.0;
        this.masterGain.connect(this.audioContext.destination);
        
        this.playHandshake();
        
        const params = this.generateAmbienceParams(word);
        
        const actualStartTime = this.audioContext.currentTime + this.handshakeDuration;
        
        for (let i = 0; i < params.baseFreqs.length; i++) {
            const osc = this.createAmbientLayer(
                params.baseFreqs[i],
                params.volumes[i],
                params.detunes[i],
                params.lfoRates[i],
                actualStartTime
            );
            osc.start(actualStartTime);
        }
        
        this.createNoiseLayer(actualStartTime);
        
        this.loopStartTime = actualStartTime;
        this.nextScheduleTime = actualStartTime;
        
        this.scheduler();
    }

    stop() {
        this.isPlaying = false;
        
        if (this.schedulerTimer) {
            clearTimeout(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        
        this.oscillators.forEach(osc => {
            try {
                osc.stop();
            } catch (e) {
                // Already stopped
            }
        });
        
        if (this.noiseNode) {
            try {
                this.noiseNode.stop();
            } catch (e) {
                // Already stopped
            }
            this.noiseNode = null;
        }
        
        this.oscillators = [];
        this.gainNodes = [];
        this.breathCallbacks = [];
        
        if (this.masterGain) {
            this.masterGain.disconnect();
            this.masterGain = null;
        }
    }

    getStatus() {
        return {
            isPlaying: this.isPlaying,
            word: this.currentWord,
            duration: this.loopDuration
        };
    }
}
