/**
 * RX: real microphone FFT handshake (528→396) + word tone decode.
 */
const P = () => window.MindwhisperProtocol;

let audioContext = null;
let analyser = null;
let microphone = null;
let stream = null;
let isListening = false;
let sessionStartTime = null;
let breathInterval = null;
let sessionTimer = null;
let rafId = null;
let decodedWord = "";
let phase = "idle"; // idle | handshake | payload | synced

const freqHistory = []; // {t, f} recent dominant in handshake band
const payloadPeaks = []; // recent peaks for tone decoding
let payloadChars = [];
let sawStartMarker = false;
let lastToneAt = 0;
let lastDecodedChar = null;

const listenBtn = document.getElementById("listen-btn");
const stopBtn = document.getElementById("stop-btn");
const consoleDiv = document.getElementById("console");
const statusValue = document.getElementById("status-value");
const handshakeValue = document.getElementById("handshake-value");
const wordValue = document.getElementById("word-value");
const timeValue = document.getElementById("time-value");
const breathCircle = document.getElementById("breath-circle");
const breathLabel = document.getElementById("breath-label");

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

function binToFreq(bin) {
  return (bin * audioContext.sampleRate) / analyser.fftSize;
}

function peakInRange(data, fMin, fMax) {
  const binHz = audioContext.sampleRate / analyser.fftSize;
  const i0 = Math.max(1, Math.floor(fMin / binHz));
  const i1 = Math.min(data.length - 1, Math.ceil(fMax / binHz));
  let bestI = i0;
  let best = -Infinity;
  for (let i = i0; i <= i1; i++) {
    if (data[i] > best) {
      best = data[i];
      bestI = i;
    }
  }
  return { freq: binToFreq(bestI), mag: best };
}

function analyseFrame() {
  if (!isListening || !analyser) return;
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);
  const now = performance.now();
  const proto = P();

  if (phase === "handshake" || phase === "idle") {
    const peak = peakInRange(data, 350, 600);
    if (peak.mag > -55) {
      freqHistory.push({ t: now, f: peak.freq, mag: peak.mag });
      while (freqHistory.length > 40) freqHistory.shift();
      maybeDetectHandshake();
    }
  }

  if (phase === "payload") {
    const peak = peakInRange(data, 1100, 3200);
    if (peak.mag > -50) {
      handlePayloadPeak(peak.freq, peak.mag, now);
    }
  }

  rafId = requestAnimationFrame(analyseFrame);
}

function maybeDetectHandshake() {
  if (phase !== "handshake" && phase !== "idle") return;
  if (freqHistory.length < 8) return;
  const proto = P();
  const recent = freqHistory.slice(-20);
  const first = recent.slice(0, 5);
  const last = recent.slice(-5);
  const avg = (arr) => arr.reduce((s, x) => s + x.f, 0) / arr.length;
  const f0 = avg(first);
  const f1 = avg(last);
  const dt = (last[last.length - 1].t - first[0].t) / 1000;

  // Descending glide: start near 528, end near 396, over ~0.3–1.5s
  const startedHigh = f0 > 470 && f0 < 580;
  const endedLow = f1 > 360 && f1 < 450;
  const descended = f0 - f1 > 60;
  const durationOk = dt > 0.25 && dt < 2.0;

  if (startedHigh && endedLow && descended && durationOk) {
    phase = "payload";
    sawStartMarker = false;
    payloadChars = [];
    lastToneAt = 0;
    lastDecodedChar = null;
    handshakeValue.textContent = "Detected ✓";
    handshakeValue.classList.add("active");
    updateStatus("Decoding word…", true);
    logToConsole(
      `HANDSHAKE DETECTED (${f0.toFixed(0)}→${f1.toFixed(0)} Hz over ${dt.toFixed(2)}s)`,
      "handshake",
    );
    logToConsole("Listening for word payload tones…", "info");
    freqHistory.length = 0;
  }
}

function handlePayloadPeak(freq, mag, now) {
  const proto = P();

  if (!sawStartMarker) {
    if (proto.isNear(freq, proto.START_MARKER, 40)) {
      sawStartMarker = true;
      lastToneAt = now;
      logToConsole("Word start marker", "info");
    }
    return;
  }

  // Debounce: one symbol per tone slot
  if (now - lastToneAt < proto.TONE_DUR * 1000 * 0.7) return;

  if (proto.isNear(freq, proto.END_MARKER, 40)) {
    finishWordDecode();
    return;
  }

  const ch = proto.freqToChar(freq);
  if (ch != null) {
    // Avoid double-counting same sustained tone
    if (ch === lastDecodedChar && now - lastToneAt < proto.TONE_DUR * 1000 * 1.4) {
      return;
    }
    payloadChars.push(ch);
    lastDecodedChar = ch;
    lastToneAt = now;
    logToConsole(`Tone → '${ch}' (${freq.toFixed(0)} Hz)`, "info");

    if (payloadChars.length >= proto.MAX_CHARS) {
      finishWordDecode();
    }
  }
}

function finishWordDecode() {
  if (phase !== "payload") return;
  const proto = P();
  decodedWord = payloadChars.join("").trim();
  phase = "synced";

  if (wordValue) {
    wordValue.textContent = decodedWord || "(empty)";
    wordValue.classList.add("active");
  }

  sessionStartTime = Date.now();
  sessionTimer = setInterval(updateSessionTime, 1000);
  updateStatus("Synced", true);
  logToConsole(
    decodedWord
      ? `WORD DECODED: "${decodedWord}"`
      : "Word payload ended (empty)",
    "handshake",
  );
  logToConsole("Breath cycle locked to session start", "info");
  startBreathVisualization();
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
        breathLabel.textContent = decodedWord
          ? `Word: ${decodedWord} — breathe in…`
          : "Breathe in deeply…";
      }
    } else if (elapsed >= 8500 && elapsed < 13500) {
      if (!breathCircle.classList.contains("exhale")) {
        breathCircle.classList.remove("inhale");
        breathCircle.classList.add("exhale");
        breathCircle.textContent = "Exhale";
        breathLabel.textContent = decodedWord
          ? `Word: ${decodedWord} — breathe out…`
          : "Breathe out slowly…";
      }
    } else if (
      breathCircle.classList.contains("inhale") ||
      breathCircle.classList.contains("exhale")
    ) {
      breathCircle.classList.remove("inhale", "exhale");
      breathCircle.textContent = "Rest";
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
    logToConsole("Requesting microphone access…", "info");

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.4;

    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    isListening = true;
    phase = "handshake";
    decodedWord = "";
    freqHistory.length = 0;
    payloadChars = [];
    sawStartMarker = false;

    if (wordValue) {
      wordValue.textContent = "—";
      wordValue.classList.remove("active");
    }
    handshakeValue.textContent = "Listening…";
    handshakeValue.classList.remove("active");

    updateStatus("Armed — play TX", true);
    listenBtn.disabled = true;
    stopBtn.disabled = false;

    logToConsole("Microphone armed", "info");
    logToConsole("Listening for 528→396 Hz handshake (real FFT)…", "info");
    rafId = requestAnimationFrame(analyseFrame);
  } catch (error) {
    console.error(error);
    logToConsole("Error: " + error.message, "error");
    updateStatus("Error", false);
  }
}

function stopListening() {
  isListening = false;
  phase = "idle";

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (breathInterval) clearInterval(breathInterval);
  breathInterval = null;
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;

  if (microphone) {
    microphone.disconnect();
    microphone = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
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
  decodedWord = "";
  updateStatus("Idle", false);
  handshakeValue.textContent = "Not detected";
  handshakeValue.classList.remove("active");
  if (wordValue) {
    wordValue.textContent = "—";
    wordValue.classList.remove("active");
  }
  timeValue.textContent = "00:00";
  breathCircle.classList.remove("inhale", "exhale");
  breathCircle.textContent = "Ready";
  breathLabel.textContent = "Waiting for session…";
  logToConsole("Stopped", "warning");
  logToConsole("─────────────────────────────────────────", "info");
  listenBtn.disabled = false;
  stopBtn.disabled = true;
}

listenBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);

logToConsole("RX ready. Arm mic, then start TX on another device (or same speaker→mic).", "info");
