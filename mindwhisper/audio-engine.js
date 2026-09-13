class MindwhisperEngine {
    constructor() {
        this.audioContext = null;
        this.isPlaying = false;
        this.loopStartTime = 0;
        this.loopDuration = 15; // 15 seconds
        this.currentWord = '';
        this.oscillators = [];
        this.gainNodes = [];
        this.masterGain = null;
        this.breathScheduler = null;
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
            detunes: []
        };

        for (let i = 0; i < 5; i++) {
            const seed = hash + i * 1000;
            const freq = 80 + this.seededRandom(seed) * 300;
            const volume = 0.05 + this.seededRandom(seed + 100) * 0.08;
            const detune = (this.seededRandom(seed + 200) - 0.5) * 20;
            
            params.baseFreqs.push(freq);
            params.volumes.push(volume);
            params.detunes.push(detune);
        }

        return params;
    }

    playHandshake() {
        const now = this.audioContext.currentTime;
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.masterGain);
        
        osc.frequency.setValueAtTime(528, now);
        osc.frequency.exponentialRampToValueAtTime(396, now + 0.8);
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.4);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
        
        osc.start(now);
        osc.stop(now + 1.2);
    }

    createAmbientLayer(frequency, volume, detune) {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        osc.type = 'sine';
        osc.frequency.value = frequency;
        osc.detune.value = detune;
        
        filter.type = 'lowpass';
        filter.frequency.value = 800;
        filter.Q.value = 1;
        
        gain.gain.value = volume;
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        
        this.oscillators.push(osc);
        this.gainNodes.push(gain);
        
        return osc;
    }

    playBreathCue(type, time) {
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.masterGain);
        
        if (type === 'inhale') {
            osc.frequency.setValueAtTime(440, time);
            osc.frequency.linearRampToValueAtTime(550, time + 0.15);
            
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.15, time + 0.05);
            gain.gain.linearRampToValueAtTime(0, time + 0.15);
        } else {
            osc.frequency.setValueAtTime(440, time);
            osc.frequency.linearRampToValueAtTime(330, time + 0.15);
            
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.15, time + 0.05);
            gain.gain.linearRampToValueAtTime(0, time + 0.15);
        }
        
        osc.type = 'sine';
        osc.start(time);
        osc.stop(time + 0.2);
    }

    scheduleBreaths(startTime) {
        const inhaleTime = startTime + 2;
        const exhaleTime = startTime + 8.5;
        
        this.playBreathCue('inhale', inhaleTime);
        this.playBreathCue('exhale', exhaleTime);
    }

    async start(word) {
        await this.initialize();
        
        if (this.isPlaying) {
            this.stop();
        }
        
        this.currentWord = word;
        this.isPlaying = true;
        
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = 1.0;
        this.masterGain.connect(this.audioContext.destination);
        
        this.playHandshake();
        
        const params = this.generateAmbienceParams(word);
        
        const handshakeDuration = 1.5;
        const actualStartTime = this.audioContext.currentTime + handshakeDuration;
        
        for (let i = 0; i < params.baseFreqs.length; i++) {
            const osc = this.createAmbientLayer(
                params.baseFreqs[i],
                params.volumes[i],
                params.detunes[i]
            );
            osc.start(actualStartTime);
        }
        
        this.loopStartTime = actualStartTime;
        
        this.scheduleBreaths(actualStartTime);
        
        this.breathScheduler = setInterval(() => {
            if (this.isPlaying) {
                const nextLoopStart = this.audioContext.currentTime + 0.5;
                this.scheduleBreaths(nextLoopStart);
            }
        }, this.loopDuration * 1000);
    }

    stop() {
        this.isPlaying = false;
        
        if (this.breathScheduler) {
            clearInterval(this.breathScheduler);
            this.breathScheduler = null;
        }
        
        this.oscillators.forEach(osc => {
            try {
                osc.stop();
            } catch (e) {
                // Already stopped
            }
        });
        
        this.oscillators = [];
        this.gainNodes = [];
        
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
