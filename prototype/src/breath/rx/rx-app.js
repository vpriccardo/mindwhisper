/**
 * RX: multiplexed quiet slots + local Watch-style breath taps.
 * Breath taps are presentation cues; mic energy can softly realign phase.
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
let blockSize = 8192;
let sampleBuf = null;
let sampleIdx = 0;

/** votes[frame][slot] = { letters: {ch:score}, empty: score } */
let frameVotes = null;
let lengthVotes = null; // { len: score }
let stableCount = 0;
let lastCandidate = "";

/** Soft breath clock (ms epoch of cycle 0). */
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

function resetVotes() {
  const proto = P();
  frameVotes = Array.from({ length: proto.NUM_FRAMES }, () =>
    Array.from({ length: proto.NUM_SLOTS }, () => ({ letters: {}, empty: 0 })),
  );
  lengthVotes = {};
  stableCount = 0;
  lastCandidate = "";
}

function detectFrame(samples) {
  const proto = P();
  let best = 0;
  let bestPow = 0;
  let second = 0;
  for (let f = 0; f < proto.NUM_FRAMES; f++) {
    const pow = goertzelPower(samples, proto.FRAME_META[f], sampleRate);
    if (pow > bestPow) {
      second = bestPow;
      bestPow = pow;
      best = f;
    } else if (pow > second) {
      second = pow;
    }
  }
  // Require clear winner so we don't smear votes across frames
  const confident = bestPow > second * 1.35 && bestPow > 1e-8;
  return { frame: best, confident, power: bestPow };
}

function detectLength(samples) {
  const proto = P();
  let bestN = null;
  let bestPow = 0;
  for (let n = 1; n <= proto.MAX_CHARS; n++) {
    const pow = goertzelPower(samples, proto.lengthFreq(n), sampleRate);
    if (pow > bestPow) {
      bestPow = pow;
      bestN = n;
    }
  }
  return { len: bestN, power: bestPow };
}

function processBlock() {
  const proto = P();
  const { frame, confident } = detectFrame(sampleBuf);
  if (!confident) return;

  const lenHit = detectLength(sampleBuf);
  if (lenHit.len != null && lenHit.power > 1e-8) {
    lengthVotes[lenHit.len] = (lengthVotes[lenHit.len] || 0) + lenHit.power;
  }

  for (let slot = 0; slot < proto.NUM_SLOTS; slot++) {
    let bestCh = null;
    let bestPow = 0;
    const center = proto.SLOT_CENTERS[slot];
    const emptyPow = goertzelPower(
      sampleBuf,
      center + proto.EMPTY_OFFSET,
      sampleRate,
    );

    for (let i = 0; i < proto.CHARSET.length; i++) {
      const f = center + i * proto.CHAR_STEP;
      const pow = goertzelPower(sampleBuf, f, sampleRate);
      if (pow > bestPow) {
        bestPow = pow;
        bestCh = proto.CHARSET[i];
      }
    }

    const cell = frameVotes[frame][slot];
    // Explicit empty tone wins → mark empty (critical to stop garbage tail)
    if (emptyPow > bestPow * 1.15 && emptyPow > 1e-8) {
      cell.empty += emptyPow;
    } else if (bestCh && bestPow > emptyPow * 1.4 && bestPow > 1e-8) {
      cell.letters[bestCh] = (cell.letters[bestCh] || 0) + bestPow;
    }
  }

  // Soft tap realign from mic energy (non-blocking)
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
    softRealignBreath(now);
    tapCooldownUntil = now + 600;
  }
  lastEnergy = energy * 0.7 + lastEnergy * 0.3;
}

function softRealignBreath(nowPerf) {
  const proto = P();
  const elapsed = (Date.now() - breathEpochMs) / 1000;
  const cycle = ((elapsed % proto.LOOP_DUR) + proto.LOOP_DUR) % proto.LOOP_DUR;
  // Snap toward nearest inhale or exhale mark
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

function bestChar(cell) {
  let best = null;
  let score = 0;
  for (const [ch, s] of Object.entries(cell.letters || {})) {
    if (s > score) {
      score = s;
      best = ch;
    }
  }
  const empty = cell.empty || 0;
  // Empty wins if stronger than best letter
  if (empty > score * 1.1) return null;
  if (score <= 0) return null;
  return best;
}

function bestLength() {
  let best = null;
  let score = 0;
  for (const [n, s] of Object.entries(lengthVotes || {})) {
    if (s > score) {
      score = s;
      best = Number(n);
    }
  }
  return score > 0 ? best : null;
}

function currentEstimate() {
  const proto = P();
  const letters = [];
  for (let f = 0; f < proto.NUM_FRAMES; f++) {
    for (let s = 0; s < proto.NUM_SLOTS; s++) {
      letters.push(bestChar(frameVotes[f][s]));
    }
  }

  const len = bestLength();

  // Prefer explicit length carrier — ignore garbage after that
  if (len != null) {
    if (letters.slice(0, len).some((ch) => ch == null)) {
      return { word: "", holes: true, len };
    }
    return { word: letters.slice(0, len).join(""), holes: false, len };
  }

  // Fallback: stop at first empty (contiguous prefix)
  let end = 0;
  while (end < letters.length && letters[end] != null) end++;
  if (end === 0) return { word: "", holes: true, len: null };
  return { word: letters.slice(0, end).join(""), holes: false, len: null };
}

function tickDecode() {
  if (!isListening) return;
  const { word, holes, len } = currentEstimate();
  if (!word || holes) {
    if (handshakeValue) {
      handshakeValue.textContent = len
        ? `Length ${len} — filling letters…`
        : "Integrating frames…";
    }
    return;
  }

  if (word === lastCandidate) stableCount++;
  else {
    lastCandidate = word;
    stableCount = 1;
    logToConsole(
      len != null ? `Candidate[${len}]: "${word}"` : `Candidate: "${word}"`,
      "info",
    );
  }

  if (handshakeValue) {
    handshakeValue.textContent = `Hearing "${word}"…`;
    handshakeValue.classList.add("active");
  }

  // Need agreement; require length lock when available
  const need = len != null ? 3 : 5;
  if (stableCount >= need) lockWord(word);
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
  stableCount = 3;
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

    // Fire if we just crossed a mark (poll ~50ms)
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
    logToConsole("Arming mic — quiet multiplex decode + breath taps", "info");

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
    breathEpochMs = Date.now();
    nextBreathSched = { inhale: 0, exhale: 0 };

    if (wordValue) {
      wordValue.textContent = "—";
      wordValue.classList.remove("active");
    }
    if (handshakeValue) {
      handshakeValue.textContent = "Integrating…";
      handshakeValue.classList.remove("active");
    }

    updateStatus("Listening", true);
    listenBtn.disabled = true;
    stopBtn.disabled = false;

    // Magician hears breath taps immediately (presentation)
    ensureBreathAudio();
    startBreathVisualization();

    decodeTimer = setInterval(tickDecode, 800);
    logToConsole(`Sample ${sampleRate} Hz — up to ${P().MAX_CHARS} letters`, "info");
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

logToConsole("RX ready — warm pad decode, Watch-style breath taps.", "info");
