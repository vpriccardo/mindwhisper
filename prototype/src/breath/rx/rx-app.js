/**
 * RX: decode soft musical bowl beacons via Goertzel on scale pitches.
 * Longer notes + cents matching → fewer dropped letters than modem beeps.
 */

function createGoertzel(freq, sampleRate, blockSize) {
  const k = Math.round((blockSize * freq) / sampleRate);
  const w = (2 * Math.PI * k) / blockSize;
  const coeff = 2 * Math.cos(w);
  return { freq, midi: null, coeff, q1: 0, q2: 0, blockSize };
}

function goertzelMag(g, samples) {
  let q1 = 0;
  let q2 = 0;
  const c = g.coeff;
  for (let i = 0; i < samples.length; i++) {
    const q0 = c * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return Math.sqrt(q1 * q1 + q2 * q2 - c * q1 * q2);
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
let decodedWord = "";
let phase = "idle";

let detectors = [];
let blockSize = 4096;
let sampleBuf = null;
let sampleIdx = 0;

let mode = "hunt"; // hunt | data | endcheck
let chars = [];
let lastAcceptAt = 0;
let lastChar = null;
let startHits = 0;
let endHits = 0;
let decodeCooldownUntil = 0;
let energyHist = [];

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
  blockSize = sampleRate >= 44100 ? 4096 : 2048;
  sampleBuf = new Float32Array(blockSize);
  sampleIdx = 0;
  detectors = proto.allDetectFreqs().map((f) => {
    const g = createGoertzel(f, sampleRate, blockSize);
    g.midi = proto.freqToMidi(f);
    return g;
  });
}

function topPitches(samples, n = 3) {
  const scored = detectors.map((g) => ({
    freq: g.freq,
    midi: g.midi,
    mag: goertzelMag(g, samples),
  }));
  scored.sort((a, b) => b.mag - a.mag);
  return scored.slice(0, n);
}

function rms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

function processBlock() {
  const proto = P();
  const now = performance.now();
  if (now < decodeCooldownUntil) return;

  const levels = topPitches(sampleBuf, 4);
  const best = levels[0];
  const energy = rms(sampleBuf);
  energyHist.push(energy);
  if (energyHist.length > 30) energyHist.shift();
  const noiseFloor =
    energyHist.reduce((a, b) => a + b, 0) / Math.max(energyHist.length, 1);

  // Adaptive gate: bowl must rise above pad/noise
  const magGate = Math.max(12, noiseFloor * 800);
  if (!best || best.mag < magGate) return;

  const start0 = proto.midiToFreq(proto.START_MIDIS[0]);
  const start1 = proto.midiToFreq(proto.START_MIDIS[1]);
  const end0 = proto.midiToFreq(proto.END_MIDIS[0]);
  const end1 = proto.midiToFreq(proto.END_MIDIS[1]);

  if (mode === "hunt") {
    const hitStart =
      proto.isNearFreq(best.freq, start0, 50) ||
      proto.isNearFreq(best.freq, start1, 50) ||
      levels.some((l) => proto.isNearFreq(l.freq, start0, 50) && l.mag > magGate * 0.7);
    if (hitStart) {
      startHits++;
      if (startHits >= 2) {
        mode = "data";
        chars = [];
        lastChar = null;
        lastAcceptAt = now;
        endHits = 0;
        startHits = 0;
        if (handshakeValue) {
          handshakeValue.textContent = "Phrase heard";
          handshakeValue.classList.add("active");
        }
        updateStatus("Listening to chime…", true);
        logToConsole("Opening motif — receiving word phrase", "handshake");
      }
    } else {
      startHits = 0;
    }
    return;
  }

  // End motif?
  const hitEnd =
    proto.isNearFreq(best.freq, end0, 50) ||
    proto.isNearFreq(best.freq, end1, 50);
  if (hitEnd && chars.length > 0) {
    endHits++;
    if (endHits >= 2) {
      finishDecode();
    }
    return;
  }
  endHits = 0;

  // Ignore lingering start pitches
  if (
    proto.isNearFreq(best.freq, start0, 40) ||
    proto.isNearFreq(best.freq, start1, 40)
  ) {
    return;
  }

  const ch = proto.freqToChar(best.freq);
  if (ch == null) return;

  // ~0.9s notes → accept at most one char per ~0.65s
  const minGap = proto.NOTE_DUR * 1000 * 0.7;
  if (now - lastAcceptAt < minGap) return;

  // Require the pitch to be clearly dominant
  if (levels[1] && best.mag < levels[1].mag * 1.15 && levels[1].mag > magGate) {
    // Ambiguous — skip
    return;
  }

  if (ch === lastChar && now - lastAcceptAt < proto.NOTE_DUR * 1000 * 1.1) {
    return;
  }

  chars.push(ch);
  lastChar = ch;
  lastAcceptAt = now;
  logToConsole(`♪ ${ch}`, "info");

  if (chars.length >= proto.MAX_CHARS) finishDecode();
}

function finishDecode() {
  const word = chars.join("").trim();
  mode = "hunt";
  chars = [];
  startHits = 0;
  endHits = 0;
  decodeCooldownUntil = performance.now() + 800;

  if (!word) {
    logToConsole("Phrase ended empty — waiting for next cycle", "warning");
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
    isNew ? `WORD: "${decodedWord}"` : `Confirmed: "${decodedWord}"`,
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
    logToConsole("Arming mic for soft bowl phrases…", "info");

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

    processor = audioContext.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = onAudio;
    muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    microphone.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(audioContext.destination);

    isListening = true;
    phase = "locking";
    mode = "hunt";
    decodedWord = "";
    chars = [];
    decodeCooldownUntil = 0;
    energyHist = [];

    if (wordValue) {
      wordValue.textContent = "—";
      wordValue.classList.remove("active");
    }
    if (handshakeValue) {
      handshakeValue.textContent = "Listening…";
      handshakeValue.classList.remove("active");
    }

    updateStatus("Listening for chimes", true);
    listenBtn.disabled = true;
    stopBtn.disabled = false;

    logToConsole(`Goertzel @ ${audioContext.sampleRate} Hz, block ${blockSize}`, "info");
    logToConsole("Waiting for soft bowl phrase (~every 15s)", "info");
  } catch (error) {
    console.error(error);
    logToConsole("Error: " + error.message, "error");
    updateStatus("Error", false);
  }
}

function stopListening() {
  isListening = false;
  phase = "idle";
  mode = "hunt";

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

logToConsole("RX ready — musical bowl phrases (not modem beeps).", "info");
