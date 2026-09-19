/**
 * RX: digital room sync + local breath presentation.
 * No microphone decode — the word never rides in the audio.
 */

let tapCtx = null;
let isListening = false;
let sessionStartTime = null;
let breathInterval = null;
let breathAudioTimer = null;
let sessionTimer = null;
let decodedWord = "";
let phase = "idle";
let syncListener = null;

let breathEpochMs = null;
let nextBreathSched = { inhale: 0, exhale: 0 };

const roomInput = document.getElementById("room-input");
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

function lockWord(word) {
  const normalized = P().normalizeWord(word);
  if (!normalized || normalized === decodedWord) return;
  decodedWord = normalized;
  if (wordValue) {
    wordValue.textContent = decodedWord;
    wordValue.classList.add("active");
  }
  if (handshakeValue) {
    handshakeValue.textContent = "Word received";
    handshakeValue.classList.add("active");
  }
  updateStatus("Word locked", true);
  logToConsole(`WORD: "${decodedWord}"`, "handshake");

  if (phase !== "synced") {
    phase = "synced";
    sessionStartTime = Date.now();
    if (!breathEpochMs) breathEpochMs = Date.now();
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(updateSessionTime, 1000);
    startBreathVisualization();
    ensureBreathAudio();
  }
}

function ensureBreathAudio() {
  if (!tapCtx) {
    tapCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (tapCtx.state === "suspended") tapCtx.resume();
  if (!breathEpochMs) breathEpochMs = Date.now();
  if (breathAudioTimer) return;

  const proto = P();
  function schedule() {
    if (!isListening) return;
    const now = Date.now();
    const elapsed = (now - breathEpochMs) / 1000;
    const cycle = ((elapsed % proto.LOOP_DUR) + proto.LOOP_DUR) % proto.LOOP_DUR;
    const t = tapCtx.currentTime + 0.05;

    if (
      cycle >= proto.INHALE_AT &&
      cycle < proto.INHALE_AT + 0.08 &&
      now > nextBreathSched.inhale
    ) {
      proto.playBreathTaps(tapCtx, tapCtx.destination, "inhale", t);
      nextBreathSched.inhale = now + 500;
    }
    if (
      cycle >= proto.EXHALE_AT &&
      cycle < proto.EXHALE_AT + 0.08 &&
      now > nextBreathSched.exhale
    ) {
      proto.playBreathTaps(tapCtx, tapCtx.destination, "exhale", t);
      nextBreathSched.exhale = now + 500;
    }
    breathAudioTimer = setTimeout(schedule, 50);
  }
  schedule();
}

function startBreathVisualization() {
  const proto = P();
  function updateBreath() {
    if (!isListening || breathEpochMs == null) return;
    const elapsed = (Date.now() - breathEpochMs) / 1000;
    const cycle = ((elapsed % proto.LOOP_DUR) + proto.LOOP_DUR) % proto.LOOP_DUR;

    if (cycle >= proto.INHALE_AT && cycle < proto.INHALE_AT + 4.5) {
      if (!breathCircle.classList.contains("inhale")) {
        breathCircle.classList.remove("exhale");
        breathCircle.classList.add("inhale");
        breathCircle.textContent = "Inhale";
        breathLabel.textContent = decodedWord
          ? `${decodedWord} — breathe in`
          : "Breathe in";
      }
    } else if (cycle >= proto.EXHALE_AT && cycle < proto.EXHALE_AT + 4.5) {
      if (!breathCircle.classList.contains("exhale")) {
        breathCircle.classList.remove("inhale");
        breathCircle.classList.add("exhale");
        breathCircle.textContent = "Exhale";
        breathLabel.textContent = decodedWord
          ? `${decodedWord} — breathe out`
          : "Breathe out";
      }
    } else if (
      breathCircle.classList.contains("inhale") ||
      breathCircle.classList.contains("exhale")
    ) {
      breathCircle.classList.remove("inhale", "exhale");
      breathCircle.textContent = decodedWord || "Rest";
      breathLabel.textContent = decodedWord ? `Word: ${decodedWord}` : "Rest";
    }
  }
  updateBreath();
  breathInterval = setInterval(updateBreath, 100);
}

function ensureRoom() {
  let room = MindwhisperSync.normalizeRoom(roomInput.value);
  if (!room) {
    room = localStorage.getItem("mw-room") || MindwhisperSync.randomRoom();
    roomInput.value = room;
  }
  localStorage.setItem("mw-room", room);
  return room;
}

async function startListening() {
  const room = ensureRoom();
  try {
    updateStatus("Connecting…", false);
    logToConsole(`Joining room ${room}…`, "info");

    if (syncListener) {
      syncListener.destroy();
      syncListener = null;
    }

    isListening = true;
    phase = "locking";
    decodedWord = "";
    breathEpochMs = Date.now();
    nextBreathSched = { inhale: 0, exhale: 0 };

    if (wordValue) {
      wordValue.textContent = "—";
      wordValue.classList.remove("active");
    }
    if (handshakeValue) {
      handshakeValue.textContent = "Connecting…";
      handshakeValue.classList.remove("active");
    }

    syncListener = MindwhisperSync.createListener(
      room,
      (word) => lockWord(word),
      (state, info) => {
        if (state === "linked") {
          updateStatus("Linked — waiting for word", true);
          if (handshakeValue) handshakeValue.textContent = "Linked";
          logToConsole("Linked to TX room", "handshake");
        } else if (state === "connecting") {
          updateStatus("Connecting…", false);
          if (handshakeValue) handshakeValue.textContent = "Connecting…";
        } else if (state === "closed") {
          if (handshakeValue) handshakeValue.textContent = "Reconnecting…";
          logToConsole("Link closed — retrying", "warning");
        } else if (state === "error") {
          logToConsole(`Sync error: ${info && info.message}`, "error");
        }
      },
    );

    listenBtn.disabled = true;
    stopBtn.disabled = false;
    roomInput.disabled = true;

    // Local breath guidance ready even before word arrives
    ensureBreathAudio();
    startBreathVisualization();
  } catch (error) {
    console.error(error);
    logToConsole("Error: " + error.message, "error");
    updateStatus("Error", false);
    isListening = false;
  }
}

function stopListening() {
  isListening = false;
  phase = "idle";
  if (breathInterval) clearInterval(breathInterval);
  breathInterval = null;
  if (breathAudioTimer) clearTimeout(breathAudioTimer);
  breathAudioTimer = null;
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;
  if (syncListener) {
    syncListener.destroy();
    syncListener = null;
  }
  if (tapCtx) {
    tapCtx.close();
    tapCtx = null;
  }

  sessionStartTime = null;
  breathEpochMs = null;
  decodedWord = "";
  updateStatus("Idle", false);
  if (handshakeValue) {
    handshakeValue.textContent = "Not connected";
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
  roomInput.disabled = false;
}

roomInput.value = localStorage.getItem("mw-room") || MindwhisperSync.randomRoom();
localStorage.setItem("mw-room", MindwhisperSync.normalizeRoom(roomInput.value));

listenBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);

logToConsole("RX ready — digital room sync, clean audio on TX.", "info");
