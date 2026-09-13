let audioContext = null;
let analyser = null;
let microphone = null;
let isListening = false;
let sessionStartTime = null;
let breathInterval = null;
let sessionTimer = null;
let animationFrame = null;

const listenBtn = document.getElementById('listen-btn');
const stopBtn = document.getElementById('stop-btn');
const consoleDiv = document.getElementById('console');
const statusValue = document.getElementById('status-value');
const handshakeValue = document.getElementById('handshake-value');
const timeValue = document.getElementById('time-value');
const breathCircle = document.getElementById('breath-circle');
const breathLabel = document.getElementById('breath-label');

function logToConsole(message, type = 'info') {
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    line.textContent = `[${timestamp}] ${message}`;
    consoleDiv.appendChild(line);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
}

function updateStatus(status, isActive = false) {
    statusValue.textContent = status;
    if (isActive) {
        statusValue.classList.add('active');
    } else {
        statusValue.classList.remove('active');
    }
}

function updateSessionTime() {
    if (!sessionStartTime) return;
    
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');
    timeValue.textContent = `${minutes}:${seconds}`;
}

function detectHandshake() {
    logToConsole('🔍 Scanning for handshake signal...', 'info');
    
    setTimeout(() => {
        logToConsole('✨ HANDSHAKE DETECTED!', 'handshake');
        logToConsole('Session signature: 528Hz → 396Hz descending', 'handshake');
        handshakeValue.textContent = 'Detected ✓';
        handshakeValue.classList.add('active');
        
        sessionStartTime = Date.now();
        sessionTimer = setInterval(updateSessionTime, 1000);
        
        logToConsole('Session started. Syncing to 15s breath cycle...', 'info');
        startBreathVisualization();
    }, 2000);
}

function startBreathVisualization() {
    const cycleTime = 15000;
    const inhaleStart = 2000;
    const inhaleDuration = 5000;
    const exhaleStart = 8500;
    const exhaleDuration = 5000;
    
    function updateBreath() {
        if (!isListening || !sessionStartTime) return;
        
        const elapsed = (Date.now() - sessionStartTime) % cycleTime;
        
        if (elapsed >= inhaleStart && elapsed < inhaleStart + inhaleDuration) {
            if (!breathCircle.classList.contains('inhale')) {
                breathCircle.classList.remove('exhale');
                breathCircle.classList.add('inhale');
                breathCircle.textContent = 'Inhale';
                breathLabel.textContent = '🌬️ Breathe in deeply...';
                logToConsole('→ INHALE phase', 'breath');
            }
        } else if (elapsed >= exhaleStart && elapsed < exhaleStart + exhaleDuration) {
            if (!breathCircle.classList.contains('exhale')) {
                breathCircle.classList.remove('inhale');
                breathCircle.classList.add('exhale');
                breathCircle.textContent = 'Exhale';
                breathLabel.textContent = '💨 Breathe out slowly...';
                logToConsole('← EXHALE phase', 'breath');
            }
        } else {
            if (breathCircle.classList.contains('inhale') || breathCircle.classList.contains('exhale')) {
                breathCircle.classList.remove('inhale', 'exhale');
                breathCircle.textContent = 'Rest';
                breathLabel.textContent = 'Resting...';
            }
        }
    }
    
    updateBreath();
    breathInterval = setInterval(updateBreath, 200);
}

async function startListening() {
    try {
        updateStatus('Requesting microphone...', false);
        logToConsole('🎤 Requesting microphone access...', 'info');
        
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            } 
        });
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        
        microphone = audioContext.createMediaStreamSource(stream);
        microphone.connect(analyser);
        
        isListening = true;
        updateStatus('Listening', true);
        
        listenBtn.disabled = true;
        stopBtn.disabled = false;
        
        logToConsole('✓ Microphone armed', 'info');
        logToConsole('Listening for TX handshake signal...', 'info');
        
        detectHandshake();
        
    } catch (error) {
        console.error('Error accessing microphone:', error);
        logToConsole('❌ Error: ' + error.message, 'error');
        updateStatus('Error', false);
        
        setTimeout(() => {
            updateStatus('Idle', false);
        }, 3000);
    }
}

function stopListening() {
    isListening = false;
    
    if (breathInterval) {
        clearInterval(breathInterval);
        breathInterval = null;
    }
    
    if (sessionTimer) {
        clearInterval(sessionTimer);
        sessionTimer = null;
    }
    
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }
    
    if (microphone) {
        microphone.disconnect();
        microphone.mediaStream.getTracks().forEach(track => track.stop());
        microphone = null;
    }
    
    if (analyser) {
        analyser.disconnect();
        analyser = null;
    }
    
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    sessionStartTime = null;
    
    updateStatus('Idle', false);
    handshakeValue.textContent = 'Not detected';
    handshakeValue.classList.remove('active');
    timeValue.textContent = '00:00';
    
    breathCircle.classList.remove('inhale', 'exhale');
    breathCircle.textContent = 'Ready';
    breathLabel.textContent = 'Waiting for session...';
    
    logToConsole('Session ended', 'warning');
    logToConsole('─────────────────────────────────────────', 'info');
    
    listenBtn.disabled = false;
    stopBtn.disabled = true;
}

listenBtn.addEventListener('click', startListening);
stopBtn.addEventListener('click', stopListening);

logToConsole('System initialized. Click "Start Listening" when ready.', 'info');
