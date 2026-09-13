/**
 * RX: soft dual-tone chime decode + local Watch-style breath taps.
 * Listens for sparse bowl-like pairs (SYNC → length → letters).
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
let tapCtx = null;
let processor = null;
let muteGain = null;
let microphone = null;
let stream = null;
let isListening = false;
let sessionStartTime = null;
let breathInterval = null;
let breathAudioTimer = null;
let sessionTimer = null;
let decodeTimer = null;
let decodedWord = "";
let phase = "idle";

let sampleRate = 48000;
let blockSize = 4096;
let sampleBuf = null;
let sampleIdx = 0;

/** Stream assembler */
let expect = "sync"; // sync | len | chars
let expectLen = 0;
let built = [];
let lastSymbolAt = 0;
let candidateVotes = {};
let stableCount = 0;
let lastCandidate = "";
let symbolCooldownUntil = 0;

let breathEpochMs = null;
let nextBreathSched = { inhale: 0, exhale: 0 };
let lastEnergy = 0;
let tapCooldownUntil = 0;

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

function resetAssemble() {
  expect = "sync";
  expectLen = 0;
  built = [];
  lastSymbolAt = 0;
  candidateVotes = {};
  stableCount = 0;
  lastCandidate = "";
  symbolCooldownUntil = 0;
}

function bestTone(samples, freqs) {
  let bestF = null;
  let bestP = 0;
  let second = 0;
  for (const f of freqs) {
    const p = goertzelPower(samples, f, sampleRate);
    if (p > bestP) {
      second = bestP;
      bestP = p;
      bestF = f;
    } else if (p > second) {
      second = p;
    }
  }
  return { freq: bestF, power: bestP, second };
}

function detectSymbol(samples) {
  const proto = P();
  const low = bestTone(samples, proto.LOWS);
  const high = bestTone(samples, proto.HIGHS);
  if (!low.freq || !high.freq) return null;

  // Both partials present, clear winners, enough energy
  const lowOk = low.power > low.second * 1.25 && low.power > 2e-7;
  const highOk = high.power > high.second * 1.25 && high.power > 2e-7;
  if (!lowOk || !highOk) return null;

  const idx = proto.indexFromTones(low.freq, high.freq);
  if (idx == null) return null;
  return { idx, low: low.freq, high: high.freq, power: low.power + high.power };
}

function onSymbol(sym) {
  const proto = P();
  const now = performance.now();
  if (now < symbolCooldownUntil) return;
  // Ignore repeats of same pair within a chime window
  if (now - lastSymbolAt < 220) return;
  lastSymbolAt = now;
  symbolCooldownUntil = now + 280;

  if (sym.idx === proto.SYNC_IDX) {
    expect = "len";
    built = [];
    expectLen = 0;
    if (handshakeValue) {
      handshakeValue.textContent = "Hearing whisper…";
      handshakeValue.classList.add("active");
    }
    return;
  }

  if (expect === "sync") return;

  if (expect === "len") {
    const len = (sym.idx % proto.MAX_CHARS) + 1;
    expectLen = len;
    expect = "chars";
    built = [];
    if (handshakeValue) {
      handshakeValue.textContent = `Length ${len}…`;
    }
    return;
  }

  if (expect === "chars") {
    const ch = proto.CHARSET[sym.idx];
    if (!ch || sym.idx >= proto.CHARSET.length) {
      // garbage — resync
      expect = "sync";
      built = [];
      return;
    }
    built.push(ch);
    if (handshakeValue) {
      handshakeValue.textContent = `Hearing "${built.join("")}"…`;
    }
    if (built.length >= expectLen) {
      const word = built.join("").slice(0, expectLen);
      voteWord(word);
      expect = "sync";
      built = [];
    }
  }
}

function voteWord(word) {
  if (!word) return;
  candidateVotes[word] = (candidateVotes[word] || 0) + 1;
  logToConsole(`Whisper: "${word}" (${candidateVotes[word]})`, "info");

  if (word === lastCandidate) stableCount++;
  else {
    lastCandidate = word;
    stableCount = 1;
  }

  // Lock after 2 matching full cycles (or 1 if very confident vote count)
  const votes = candidateVotes[word] || 0;
  if (stableCount >= 2 || votes >= 2) lockWord(word);
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
    if (!breathEpochMs) breathEpochMs = Date.now();
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(updateSessionTime, 1000);
    startBreathVisualization();
    ensureBreathAudio();
  }
}

function softRealignBreath() {
  const proto = P();
  const elapsed = (Date.now() - breathEpochMs) / 1000;
  const cycle = ((elapsed % proto.LOOP_DUR) + proto.LOOP_DUR) % proto.LOOP_DUR;
  const targets = [proto.INHALE_AT, proto.EXHALE_AT];
  let nearest = targets[0];
  let bestDist = Infinity;
  for (const t of targets) {
    const d = Math.min(Math.abs(cycle - t), proto.LOOP_DUR - Math.abs(cycle - t));
    if (d < bestDist) {
      bestDist = d;
      nearest = t;
    }
  }
  if (bestDist < 1.2) {
    breathEpochMs = Date.now() - nearest * 1000;
    logToConsole("Breath phase soft-realigned", "info");
  }
}

function processBlock() {
  const sym = detectSymbol(sampleBuf);
  if (sym) onSymbol(sym);

  let sum = 0;
  for (let i = 0; i < sampleBuf.length; i++) sum += sampleBuf[i] * sampleBuf[i];
  const energy = Math.sqrt(sum / sampleBuf.length);
  const now = performance.now();
  if (
    energy > lastEnergy * 3.5 &&
    energy > 0.02 &&
    now > tapCooldownUntil &&
    breathEpochMs != null
  ) {
    softRealignBreath();
    tapCooldownUntil = now + 600;
  }
  lastEnergy = energy * 0.7 + lastEnergy * 0.3;
}

function tickDecode() {
  if (!isListening) return;
  if (decodedWord) return;
  if (handshakeValue && expect === "sync") {
    handshakeValue.textContent = "Listening for soft chimes…";
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

async function startListening() {
  try {
    updateStatus("Requesting microphone…", false);
    logToConsole("Arming mic — soft chime whisper + breath taps", "info");

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
    // ~85ms windows — match brief chimes
    blockSize = sampleRate >= 44100 ? 4096 : 2048;
    sampleBuf = new Float32Array(blockSize);
    sampleIdx = 0;
    resetAssemble();

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
    decodedWord = "";
    breathEpochMs = Date.now();
    nextBreathSched = { inhale: 0, exhale: 0 };

    if (wordValue) {
      wordValue.textContent = "—";
      wordValue.classList.remove("active");
    }
    if (handshakeValue) {
      handshakeValue.textContent = "Listening for soft chimes…";
      handshakeValue.classList.remove("active");
    }

    updateStatus("Listening", true);
    listenBtn.disabled = true;
    stopBtn.disabled = false;

    ensureBreathAudio();
    startBreathVisualization();

    decodeTimer = setInterval(tickDecode, 800);
    logToConsole(`Sample ${sampleRate} Hz — soft dual-tone whisper`, "info");
    logToConsole("Breath: single tap = in, double tap = out", "info");
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
  if (breathAudioTimer) clearTimeout(breathAudioTimer);
  breathAudioTimer = null;
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
  if (tapCtx) {
    tapCtx.close();
    tapCtx = null;
  }

  sessionStartTime = null;
  breathEpochMs = null;
  decodedWord = "";
  resetAssemble();
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

logToConsole("RX ready — soft chime whisper, Watch-style breath taps.", "info");
