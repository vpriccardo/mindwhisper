/**
 * RX: read continuous quiet slot tones (no beacon / handshake gate).
 * Integrates Goertzel over time so all letters appear together.
 */

function goertzelPower(samples, freq, sampleRate) {
  const n = samples.length;
  const k = Math.round((n * freq) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}

let audioContext = null;
let processor = null;
let muteGain = null;
let microphone = null;
let stream = null;
let isListening = false;
let sessionStartTime = null;
let breathInterval = null;
let sessionTimer = null;
let decodeTimer = null;
let decodedWord = "";
let phase = "idle";

let sampleRate = 48000;
let blockSize = 8192;
let sampleBuf = null;
let sampleIdx = 0;
let slotVotes = null; // per slot: Map char -> score
let stableCount = 0;
let lastCandidate = "";

const listenBtn = document.getElementById("listen-btn");
const stopBtn = document.getElementById("stop-btn");
const consoleDiv = document.getElementById("console");
const statusValue = document.getElementById("status-value");
const handshakeValue = document.getElementById("handshake-value");
const wordValue = document.getElementById("word-value");
const timeValue = document.getElementById("time-value");
const breathCircle = document.getElementById("breath-circle");
const breathLabel = document.getElementById("breath-label");

function P() {
  return window.MindwhisperProtocol;
}

function logToConsole(message, type = "info") {
  const line = document.createElement("div");
  line.className = `console-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  consoleDiv.appendChild(line);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;
}

function updateStatus(status, isActive = false) {
  statusValue.textContent = status;
  statusValue.classList.toggle("active", isActive);
}

function updateSessionTime() {
  if (!sessionStartTime) return;
  const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  timeValue.textContent = `${minutes}:${seconds}`;
}

function resetVotes() {
  const proto = P();
  slotVotes = Array.from({ length: proto.MAX_CHARS }, () => ({}));
  stableCount = 0;
  lastCandidate = "";
}

function processBlock() {
  const proto = P();
  // Accumulate soft evidence every block
  for (let slot = 0; slot < proto.MAX_CHARS; slot++) {
    let bestCh = null;
    let bestPow = 0;
    let emptyPow = 0;
    const center = proto.SLOT_CENTERS[slot];
    emptyPow = goertzelPower(sampleBuf, center + proto.EMPTY_OFFSET, sampleRate);

    for (let i = 0; i < proto.CHARSET.length; i++) {
      const f = center + i * proto.CHAR_STEP;
      const pow = goertzelPower(sampleBuf, f, sampleRate);
      if (pow > bestPow) {
        bestPow = pow;
        bestCh = proto.CHARSET[i];
      }
    }

    // Slot considered active if best letter beats empty + noise margin
    const active = bestPow > emptyPow * 2.5 && bestPow > 1e-6;
    if (active && bestCh) {
      slotVotes[slot][bestCh] = (slotVotes[slot][bestCh] || 0) + bestPow;
    }
  }
}

function currentEstimate() {
  const proto = P();
  let word = "";
  let trailingEmpty = true;
  // Build from left; stop at first consistently empty slot after content
  const letters = [];
  for (let slot = 0; slot < proto.MAX_CHARS; slot++) {
    const votes = slotVotes[slot];
    let best = null;
    let bestScore = 0;
    for (const [ch, score] of Object.entries(votes)) {
      if (score > bestScore) {
        bestScore = score;
        best = ch;
      }
    }
    letters.push(bestScore > 0 ? best : null);
  }

  // Trim trailing nulls; allow internal nulls as gaps only if rare — prefer contiguous
  let end = letters.length;
  while (end > 0 && letters[end - 1] == null) end--;
  for (let i = 0; i < end; i++) {
    if (letters[i] == null) {
      // hole — treat as unstable
      return { word: "", holes: true };
    }
    word += letters[i];
  }
  return { word, holes: false };
}

function tickDecode() {
  if (!isListening) return;
  const { word, holes } = currentEstimate();
  if (!word || holes || word.length < 1) {
    if (handshakeValue) handshakeValue.textContent = "Integrating…";
    return;
  }

  if (word === lastCandidate) {
    stableCount++;
  } else {
    lastCandidate = word;
    stableCount = 1;
    logToConsole(`Candidate: "${word}"`, "info");
  }

  if (handshakeValue) {
    handshakeValue.textContent = `Hearing ${word.length} letters…`;
    handshakeValue.classList.add("active");
  }

  // Need several agreeing estimates (continuous tones → should stabilize)
  if (stableCount >= 4) {
    lockWord(word);
  }
}

function lockWord(word) {
  if (word === decodedWord) return;
  decodedWord = word;
  if (wordValue) {
    wordValue.textContent = decodedWord;
    wordValue.classList.add("active");
  }
  updateStatus("Word locked", true);
  logToConsole(`WORD: "${decodedWord}"`, "handshake");

  if (phase !== "synced") {
    phase = "synced";
    sessionStartTime = Date.now();
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(updateSessionTime, 1000);
    startBreathVisualization();
  }

  // Keep integrating — can refine if needed
  stableCount = 4;
}

function onAudio(e) {
  if (!isListening || !sampleBuf) return;
  const input = e.inputBuffer.getChannelData(0);
  for (let i = 0; i < input.length; i++) {
    sampleBuf[sampleIdx++] = input[i];
    if (sampleIdx >= blockSize) {
      processBlock();
      sampleIdx = 0;
    }
  }
}

function startBreathVisualization() {
  const cycleTime = 15000;
  function updateBreath() {
    if (!isListening || !sessionStartTime || phase !== "synced") return;
    const elapsed = (Date.now() - sessionStartTime) % cycleTime;
    if (elapsed >= 2000 && elapsed < 7000) {
      if (!breathCircle.classList.contains("inhale")) {
        breathCircle.classList.remove("exhale");
        breathCircle.classList.add("inhale");
        breathCircle.textContent = "Inhale";
        breathLabel.textContent = `Word: ${decodedWord} — breathe in…`;
      }
    } else if (elapsed >= 8500 && elapsed < 13500) {
      if (!breathCircle.classList.contains("exhale")) {
        breathCircle.classList.remove("inhale");
        breathCircle.classList.add("exhale");
        breathCircle.textContent = "Exhale";
        breathLabel.textContent = `Word: ${decodedWord} — breathe out…`;
      }
    } else if (
      breathCircle.classList.contains("inhale") ||
      breathCircle.classList.contains("exhale")
    ) {
      breathCircle.classList.remove("inhale", "exhale");
      breathCircle.textContent = decodedWord || "Rest";
      breathLabel.textContent = decodedWord
        ? `Decoded: ${decodedWord}`
        : "Resting…";
    }
  }
  updateBreath();
  breathInterval = setInterval(updateBreath, 200);
}

async function startListening() {
  try {
    updateStatus("Requesting microphone…", false);
    logToConsole("Arming mic — continuous quiet chord decode", "info");

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();
    sampleRate = audioContext.sampleRate;
    blockSize = sampleRate >= 44100 ? 8192 : 4096;
    sampleBuf = new Float32Array(blockSize);
    sampleIdx = 0;
    resetVotes();

    microphone = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = onAudio;
    muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    microphone.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(audioContext.destination);

    isListening = true;
    phase = "locking";
    decodedWord = "";

    if (wordValue) {
      wordValue.textContent = "—";
      wordValue.classList.remove("active");
    }
    if (handshakeValue) {
      handshakeValue.textContent = "Integrating…";
      handshakeValue.classList.remove("active");
    }

    updateStatus("Listening to pad", true);
    listenBtn.disabled = true;
    stopBtn.disabled = false;

    decodeTimer = setInterval(tickDecode, 700);
    logToConsole(`Sample ${sampleRate} Hz, block ${blockSize}`, "info");
    logToConsole("No beeps — reading hidden partials in the ambience", "info");
    logToConsole("Hold phones close / volume medium-high; wait a few seconds", "info");
  } catch (error) {
    console.error(error);
    logToConsole("Error: " + error.message, "error");
    updateStatus("Error", false);
  }
}

function stopListening() {
  isListening = false;
  phase = "idle";
  if (decodeTimer) clearInterval(decodeTimer);
  decodeTimer = null;
  if (breathInterval) clearInterval(breathInterval);
  breathInterval = null;
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;

  if (processor) {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch (_) {}
    processor = null;
  }
  if (muteGain) {
    try { muteGain.disconnect(); } catch (_) {}
    muteGain = null;
  }
  if (microphone) {
    try { microphone.disconnect(); } catch (_) {}
    microphone = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  sessionStartTime = null;
  decodedWord = "";
  updateStatus("Idle", false);
  if (handshakeValue) {
    handshakeValue.textContent = "Not locked";
    handshakeValue.classList.remove("active");
  }
  if (wordValue) {
    wordValue.textContent = "—";
    wordValue.classList.remove("active");
  }
  timeValue.textContent = "00:00";
  breathCircle.classList.remove("inhale", "exhale");
  breathCircle.textContent = "Ready";
  breathLabel.textContent = "Waiting for session…";
  logToConsole("Stopped", "warning");
  listenBtn.disabled = false;
  stopBtn.disabled = true;
}

listenBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);

logToConsole("RX ready — continuous ambient decode (no chirps).", "info");
