/**
 * RX: continuous Goertzel decode of word beacons (no handshake gate).
 * Tuned for iPhone speaker → mic: mid-band markers, longer dwell, no AGC.
 */

function createGoertzel(freq, sampleRate, blockSize) {
  const k = Math.round((blockSize * freq) / sampleRate);
  const w = (2 * Math.PI * k) / blockSize;
  const coeff = 2 * Math.cos(w);
  return { freq, coeff, q1: 0, q2: 0, n: 0, blockSize };
}

function goertzelPush(g, sample) {
  const q0 = g.coeff * g.q1 - g.q2 + sample;
  g.q2 = g.q1;
  g.q1 = q0;
  g.n++;
}

function goertzelMagnitude(g) {
  const mag = Math.sqrt(g.q1 * g.q1 + g.q2 * g.q2 - g.coeff * g.q1 * g.q2);
  g.q1 = 0;
  g.q2 = 0;
  g.n = 0;
  return mag;
}

let audioContext = null;
let processor = null;
let microphone = null;
let stream = null;
let isListening = false;
let sessionStartTime = null;
let breathInterval = null;
let sessionTimer = null;
let decodedWord = "";
let phase = "idle"; // idle | locking | synced

let detectors = [];
let blockSize = 2048;
let sampleBuf = null;
let sampleIdx = 0;

let sawStart = false;
let chars = [];
let lastSymbolAt = 0;
let lastChar = null;
let startMarkerHits = 0;
let symbolHits = {};
let decodeCooldownUntil = 0;

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

function initDetectors(sampleRate) {
  const proto = P();
  // ~40–50 ms blocks at 48k → responsive; ~85 ms at 24k
  blockSize = sampleRate >= 44100 ? 2048 : 1024;
  sampleBuf = new Float32Array(blockSize);
  sampleIdx = 0;
  detectors = proto.allDetectFreqs().map((f) => createGoertzel(f, sampleRate, blockSize));
}

function processBlock() {
  const proto = P();
  const now = performance.now();
  if (now < decodeCooldownUntil) {
    sampleIdx = 0;
    return;
  }

  let best = null;
  for (const g of detectors) {
    // Feed block
    g.q1 = 0;
    g.q2 = 0;
    for (let i = 0; i < blockSize; i++) goertzelPush(g, sampleBuf[i]);
    const mag = goertzelMagnitude(g);
    if (!best || mag > best.mag) best = { freq: g.freq, mag };
  }

  // Noise floor gate — absolute mag depends on mic gain; use relative later if needed
  const threshold = 8;
  if (!best || best.mag < threshold) {
    startMarkerHits = 0;
    return;
  }

  const freq = best.freq;

  if (!sawStart) {
    if (proto.isNear(freq, proto.START_MARKER, 30)) {
      startMarkerHits++;
      if (startMarkerHits >= 2) {
        sawStart = true;
        chars = [];
        lastChar = null;
        lastSymbolAt = now;
        symbolHits = {};
        startMarkerHits = 0;
        if (handshakeValue) {
          handshakeValue.textContent = "Beacon locked";
          handshakeValue.classList.add("active");
        }
        updateStatus("Decoding…", true);
        logToConsole(`Start marker @ ${freq.toFixed(0)} Hz`, "handshake");
      }
    } else {
      startMarkerHits = 0;
    }
    return;
  }

  // End marker
  if (proto.isNear(freq, proto.END_MARKER, 30)) {
    finishDecode();
    return;
  }

  // Ignore start marker repeats while in payload
  if (proto.isNear(freq, proto.START_MARKER, 30)) return;

  const ch = proto.freqToChar(freq);
  if (ch == null) return;

  const key = ch;
  symbolHits[key] = (symbolHits[key] || 0) + 1;

  // Require dwell + gap from previous accept
  const minGap = proto.TONE_DUR * 1000 * 0.55;
  if (now - lastSymbolAt < minGap) return;

  if (symbolHits[key] >= 2) {
    if (ch !== lastChar || now - lastSymbolAt > proto.TONE_DUR * 1000 * 1.2) {
      chars.push(ch);
      lastChar = ch;
      lastSymbolAt = now;
      symbolHits = {};
      logToConsole(`'${ch}' (${freq.toFixed(0)} Hz)`, "info");
      if (chars.length >= proto.MAX_CHARS) finishDecode();
    }
  }
}

function finishDecode() {
  if (!sawStart) return;
  const word = chars.join("").trim();
  sawStart = false;
  chars = [];
  startMarkerHits = 0;
  symbolHits = {};

  // Brief cooldown so we don't immediately re-parse the same beacon's end/start
  decodeCooldownUntil = performance.now() + 400;

  if (!word) {
    logToConsole("Empty beacon — keep listening", "warning");
    return;
  }

  const isNew = word !== decodedWord;
  decodedWord = word;

  if (wordValue) {
    wordValue.textContent = decodedWord;
    wordValue.classList.add("active");
  }

  if (phase !== "synced") {
    phase = "synced";
    sessionStartTime = Date.now();
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(updateSessionTime, 1000);
    startBreathVisualization();
  }

  updateStatus("Word locked", true);
  logToConsole(
    isNew ? `WORD: "${decodedWord}"` : `WORD confirmed: "${decodedWord}"`,
    "handshake",
  );
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
    logToConsole("Requesting mic (echoCancellation/AGC off)…", "info");

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

    initDetectors(audioContext.sampleRate);
    microphone = audioContext.createMediaStreamSource(stream);

    // ScriptProcessor is deprecated but still the most reliable on iOS Safari
    // for raw PCM without AudioWorklet registration headaches.
    const bufferLen = 2048;
    processor = audioContext.createScriptProcessor(bufferLen, 1, 1);
    processor.onaudioprocess = onAudio;
    microphone.connect(processor);
    processor.connect(audioContext.destination);
    // Mute monitoring so we don't create feedback through the phone speaker
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    processor.disconnect();
    microphone.connect(processor);
    processor.connect(mute);
    mute.connect(audioContext.destination);

    isListening = true;
    phase = "locking";
    decodedWord = "";
    sawStart = false;
    chars = [];
    decodeCooldownUntil = 0;

    if (wordValue) {
      wordValue.textContent = "—";
      wordValue.classList.remove("active");
    }
    if (handshakeValue) {
      handshakeValue.textContent = "Scanning beacons…";
      handshakeValue.classList.remove("active");
    }

    updateStatus("Listening for word", true);
    listenBtn.disabled = true;
    stopBtn.disabled = false;

    logToConsole(`Sample rate ${audioContext.sampleRate} Hz, Goertzel block ${blockSize}`, "info");
    logToConsole("No handshake gate — waiting for continuous word beacons (~every 7.5s)", "info");
    logToConsole("Tip: TX speaker volume high; RX iPhone mic unobstructed", "info");
  } catch (error) {
    console.error(error);
    logToConsole("Error: " + error.message, "error");
    updateStatus("Error", false);
  }
}

function stopListening() {
  isListening = false;
  phase = "idle";

  if (breathInterval) clearInterval(breathInterval);
  breathInterval = null;
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;

  if (processor) {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch (_) {}
    processor = null;
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

logToConsole("RX ready — continuous word beacon decode (iPhone mid-band).", "info");
