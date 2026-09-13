/**
 * Consumer meditation session — word seed → breath pattern + soundscape.
 * No hidden audio channel — pure listening experience.
 */

const wordInput = document.getElementById("word");
const soundSelect = document.getElementById("soundscape");
const form = document.getElementById("seed-form");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const viewport = document.getElementById("viewport");
const bloom = document.getElementById("bloom");
const orbLabel = document.getElementById("orb-label");
const phaseCopy = document.getElementById("phase-copy");
const meterFill = document.getElementById("meter-fill");
const soundGrid = document.getElementById("sound-grid");

let audioCtx = null;
let spa = null;
let master = null;
let playing = false;
let loopStart = 0;
let loopDur = 15;
let inhaleAt = 2;
let exhaleAt = 8.5;
let raf = null;
let pattern = null;
let lastPhase = "rest";
let lastTapPhase = "rest";

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function rnd(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function patternFromWord(word) {
  const h = hash(word.toLowerCase());
  const cycle = 12 + Math.floor(rnd(h) * 6);
  const inhale = 1.6 + rnd(h + 1) * 1.2;
  const exhale = inhale + 5.5 + rnd(h + 2) * 2.2;
  return {
    word: MindwhisperProtocol.normalizeWord(word),
    cycle,
    inhaleAt: inhale,
    exhaleAt: Math.min(exhale, cycle - 2.5),
    inhaleHold: 3.8 + rnd(h + 3) * 1.4,
    exhaleHold: 3.8 + rnd(h + 4) * 1.4,
  };
}

function fillSoundUI() {
  const list = MindwhisperSoundscapes.list();
  soundSelect.innerHTML = "";
  soundGrid.innerHTML = "";
  list.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (i === 0) opt.selected = true;
    soundSelect.appendChild(opt);

    const card = document.createElement("article");
    card.className = "sound-card";
    card.innerHTML = `<h3>${p.name}</h3><p>${p.blurb}</p>`;
    soundGrid.appendChild(card);
  });
}

function playLocalTaps(type) {
  if (!audioCtx || !master) return;
  const t = audioCtx.currentTime + 0.02;
  MindwhisperProtocol.playBreathTaps(audioCtx, master, type, t);
}

function phaseNow() {
  if (!playing || !audioCtx || !pattern) {
    return { phase: "idle", progress: 0, phaseT: 0 };
  }
  const elapsed = audioCtx.currentTime - loopStart;
  const cycle = ((elapsed % loopDur) + loopDur) % loopDur;
  const i0 = inhaleAt;
  const i1 = inhaleAt + pattern.inhaleHold;
  const e0 = exhaleAt;
  const e1 = exhaleAt + pattern.exhaleHold;

  let phase = "rest";
  let phaseT = 0;
  if (cycle >= i0 && cycle < i1) {
    phase = "inhale";
    phaseT = (cycle - i0) / pattern.inhaleHold;
  } else if (cycle >= e0 && cycle < e1) {
    phase = "exhale";
    phaseT = (cycle - e0) / pattern.exhaleHold;
  }
  return { phase, progress: cycle / loopDur, phaseT: Math.min(1, Math.max(0, phaseT)) };
}

function setBloom(scale, spinDeg, phase) {
  bloom.style.setProperty("--breath", scale.toFixed(4));
  bloom.style.setProperty("--spin", `${spinDeg.toFixed(2)}deg`);
  bloom.classList.remove("is-inhale", "is-exhale", "is-rest");
  if (phase === "inhale") bloom.classList.add("is-inhale");
  else if (phase === "exhale") bloom.classList.add("is-exhale");
  else bloom.classList.add("is-rest");
}

function tick() {
  if (!playing) return;
  const { phase, progress, phaseT } = phaseNow();
  meterFill.style.width = `${Math.min(100, progress * 100)}%`;

  const minS = 0.42;
  const maxS = 1.08;
  let scale = 0.62;
  let spin = 0;
  if (phase === "inhale") {
    scale = minS + easeInOut(phaseT) * (maxS - minS);
    spin = easeInOut(phaseT) * 28;
  } else if (phase === "exhale") {
    scale = maxS - easeInOut(phaseT) * (maxS - minS);
    spin = 28 - easeInOut(phaseT) * 28;
  } else {
    scale = 0.62;
    spin = 0;
  }
  setBloom(scale, spin, phase);

  if (phase !== lastPhase) {
    if (phase === "inhale") {
      orbLabel.textContent = "Breathe in";
      phaseCopy.textContent = "Follow the bloom as it opens";
    } else if (phase === "exhale") {
      orbLabel.textContent = "Breathe out";
      phaseCopy.textContent = "Follow the bloom as it softens";
    } else {
      orbLabel.textContent = "Rest";
      phaseCopy.textContent = "Let the sound hold you";
    }
    lastPhase = phase;
  }

  if (phase !== lastTapPhase && (phase === "inhale" || phase === "exhale")) {
    playLocalTaps(phase);
    lastTapPhase = phase;
  }
  if (phase === "rest") lastTapPhase = "rest";

  raf = requestAnimationFrame(tick);
}

async function startSession(e) {
  e.preventDefault();
  const raw = wordInput.value.trim();
  if (!raw) return;

  pattern = patternFromWord(raw);
  loopDur = pattern.cycle;
  inhaleAt = pattern.inhaleAt;
  exhaleAt = pattern.exhaleAt;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  master = audioCtx.createGain();
  master.gain.value = 1;
  master.connect(audioCtx.destination);

  const t0 = audioCtx.currentTime;
  spa = new SpaAmbience(audioCtx, master);
  await spa.start(pattern.word, t0, soundSelect.value);

  loopStart = t0 + 1.0;
  playing = true;
  lastPhase = "rest";
  lastTapPhase = "rest";
  document.body.classList.add("is-live");
  viewport.classList.add("is-live");

  startBtn.disabled = true;
  stopBtn.disabled = false;
  wordInput.disabled = true;
  soundSelect.disabled = true;
  orbLabel.textContent = "Begin";
  phaseCopy.textContent = "Find a comfortable posture";
  setBloom(0.55, 0, "rest");
  tick();
}

function stopSession() {
  playing = false;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (spa) {
    spa.stop();
    spa = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  master = null;
  document.body.classList.remove("is-live");
  viewport.classList.remove("is-live");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  wordInput.disabled = false;
  soundSelect.disabled = false;
  orbLabel.textContent = "Ready";
  phaseCopy.textContent = "Session ended";
  meterFill.style.width = "0%";
  setBloom(0.55, 0, "rest");
}

fillSoundUI();
form.addEventListener("submit", startSession);
stopBtn.addEventListener("click", stopSession);
setBloom(0.55, 0, "rest");
