const engine = new MindwhisperEngine();

const wordInput = document.getElementById("word-input");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const statusDiv = document.getElementById("status");
const breathStage = document.getElementById("breath-stage");
const bloom = document.getElementById("bloom");
const bloomLabel = document.getElementById("bloom-label");

let raf = null;

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function updateStatus(text, isActive = false) {
  const statusText = document.createElement("div");
  statusText.className = "status-text";
  statusText.textContent = text;
  statusDiv.innerHTML = "";
  statusDiv.appendChild(statusText);
  if (isActive) statusDiv.classList.add("active");
  else statusDiv.classList.remove("active");
}

function setBloom(scale, spin, label) {
  bloom.style.setProperty("--breath", scale.toFixed(4));
  bloom.style.setProperty("--spin", `${spin.toFixed(2)}deg`);
  bloomLabel.textContent = label;
}

function tickBreathVisual() {
  if (!engine.isPlaying) return;
  const p = engine.getPhase();
  const P = MindwhisperProtocol;
  const inhaleHold = 4.5;
  const exhaleHold = 4.5;
  const minS = 0.45;
  const maxS = 1.05;

  if (p.phase === "inhale") {
    const t = Math.min(1, Math.max(0, (p.cycleTime - P.INHALE_AT) / inhaleHold));
    const e = easeInOut(t);
    setBloom(minS + e * (maxS - minS), e * 26, "Breathe in");
  } else if (p.phase === "exhale") {
    const t = Math.min(1, Math.max(0, (p.cycleTime - P.EXHALE_AT) / exhaleHold));
    const e = easeInOut(t);
    setBloom(maxS - e * (maxS - minS), 26 - e * 26, "Breathe out");
  } else if (p.phase === "opening") {
    setBloom(0.55, 0, "Starting…");
  } else {
    setBloom(0.62, 0, "Rest");
  }
  raf = requestAnimationFrame(tickBreathVisual);
}

async function startSession() {
  const word = wordInput.value.trim();
  if (!word) {
    updateStatus("Please enter a word first");
    setTimeout(() => updateStatus("Enter a word and press Start"), 2000);
    return;
  }
  try {
    startBtn.disabled = true;
    updateStatus("Starting session…", true);
    await engine.start(word);
    const normalized = engine.normalizedWord || word;
    updateStatus(`Session · ${normalized}`, true);
    breathStage.hidden = false;
    setBloom(0.55, 0, "Begin");
    tickBreathVisual();
    stopBtn.disabled = false;
    wordInput.disabled = true;
  } catch (error) {
    console.error(error);
    updateStatus("Error starting session. Try again.");
    startBtn.disabled = false;
    setTimeout(() => updateStatus("Enter a word and press Start"), 3000);
  }
}

function stopSession() {
  engine.stop();
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  breathStage.hidden = true;
  updateStatus("Session ended. Enter a new word to begin again.");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  wordInput.disabled = false;
  wordInput.value = "";
  wordInput.focus();
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
wordInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter" && !startBtn.disabled) startSession();
});
updateStatus("Enter a word and press Start");
wordInput.focus();
