const engine = new MindwhisperEngine();

const wordInput = document.getElementById('word-input');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusDiv = document.getElementById('status');

let breathInterval = null;
let breathPhase = 'idle';

function updateStatus(text, isActive = false) {
    const statusText = statusDiv.querySelector('.status-text') || 
                       document.createElement('div');
    statusText.className = 'status-text';
    statusText.textContent = text;
    
    statusDiv.innerHTML = '';
    statusDiv.appendChild(statusText);
    
    if (isActive) {
        statusDiv.classList.add('active');
        
        const breathIndicator = document.createElement('div');
        breathIndicator.className = 'breath-indicator';
        breathIndicator.id = 'breath-indicator';
        breathIndicator.textContent = 'Listen for breath cues...';
        statusDiv.appendChild(breathIndicator);
    } else {
        statusDiv.classList.remove('active');
    }
}

function animateBreathCycle() {
    const indicator = document.getElementById('breath-indicator');
    if (!indicator) return;
    
    const cycleTime = 15000;
    const inhaleStart = 2000;
    const inhaleDuration = 5000;
    const exhaleStart = 8500;
    const exhaleDuration = 5000;
    
    function updateBreathPhase() {
        if (!engine.isPlaying) return;
        
        const elapsed = Date.now() % cycleTime;
        
        if (elapsed >= inhaleStart && elapsed < inhaleStart + inhaleDuration) {
            indicator.textContent = '🌬️ Breathe in...';
            indicator.style.color = '#667eea';
        } else if (elapsed >= exhaleStart && elapsed < exhaleStart + exhaleDuration) {
            indicator.textContent = '💨 Breathe out...';
            indicator.style.color = '#764ba2';
        } else {
            indicator.textContent = 'Listen for breath cues...';
            indicator.style.color = '#999';
        }
    }
    
    updateBreathPhase();
    breathInterval = setInterval(updateBreathPhase, 200);
}

async function startSession() {
    const word = wordInput.value.trim();
    
    if (!word) {
        updateStatus('⚠️ Please enter a word first');
        setTimeout(() => updateStatus('Enter a word and press Start'), 2000);
        return;
    }
    
    try {
        startBtn.disabled = true;
        updateStatus('🎵 Initializing session...', true);
        
        await engine.start(word);
        
        updateStatus(`✨ Meditating with: "${word}"`, true);
        animateBreathCycle();
        
        startBtn.disabled = true;
        stopBtn.disabled = false;
        wordInput.disabled = true;
        
    } catch (error) {
        console.error('Error starting session:', error);
        updateStatus('❌ Error starting session. Please try again.');
        startBtn.disabled = false;
        setTimeout(() => updateStatus('Enter a word and press Start'), 3000);
    }
}

function stopSession() {
    engine.stop();
    
    if (breathInterval) {
        clearInterval(breathInterval);
        breathInterval = null;
    }
    
    updateStatus('Session ended. Enter a new word to begin again.');
    
    startBtn.disabled = false;
    stopBtn.disabled = true;
    wordInput.disabled = false;
    wordInput.value = '';
    wordInput.focus();
}

startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);

wordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !startBtn.disabled) {
        startSession();
    }
});

updateStatus('Enter a word and press Start');
wordInput.focus();
