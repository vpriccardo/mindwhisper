/**
 * Consumer meditation session — word seed → breath pattern + soundscape.
 * No magic / decode UI. TX left separate at /tx.
 */

const wordInput = document.getElementById("word");
const soundSelect = document.getElementById("soundscape");
const creditEl = document.getElementById("sound-credit");
const form = document.getElementById("seed-form");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const stage = document.getElementById("stage");
const orb = document.getElementById("orb");
const orbLabel = document.getElementById("orb-label");
const phaseCopy = document.getElementById("phase-copy");
const seedChip = document.getElementById("seed-chip");
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
let breathTimer = null;
let pattern = null;

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

/** Derive a calm breath cycle from the word seed. */
function patternFromWord(word) {
  const h = hash(word.toLowerCase());
  const cycle = 12 + Math.floor(rnd(h) * 6); // 12–17s
  const inhale = 1.6 + rnd(h + 1) * 1.2;
  const exhale = inhale + 5.5 + rnd(h + 2) * 2.2;
  return {
    word: MindwhisperProtocol.normalizeWord(word),
    cycle,
    inhaleAt: inhale,
    exhaleAt: Math.min(exhale, cycle - 2.5),
    inhaleHold: 3.5 + rnd(h + 3) * 1.5,
    exhaleHold: 3.5 + rnd(h + 4) * 1.5,
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
    card.innerHTML = `<h3>${p.name}</h3><p>${p.blurb}</p><p class="attr">${p.credit}</p>`;
    soundGrid.appendChild(card);
  });
  updateCredit();
}

function updateCredit() {
  const p = MindwhisperSoundscapes.byId(soundSelect.value);
  creditEl.textContent = p ? p.credit : "";
}

function playLocalTaps(type) {
  if (!audioCtx || !master) return;
  const t = audioCtx.currentTime + 0.02;
  MindwhisperProtocol.playBreathTaps(audioCtx, master, type, t);
}

function phaseNow() {
  if (!playing || !audioCtx) return { phase: "idle", progress: 0 };
  const elapsed = audioCtx.currentTime - loopStart;
  const cycle = ((elapsed % loopDur) + loopDur) % loopDur;
  let phase = "rest";
  if (cycle >= inhaleAt && cycle < inhaleAt + pattern.inhaleHold) phase = "inhale";
  else if (cycle >= exhaleAt && cycle < exhaleAt + pattern.exhaleHold) phase = "exhale";
  return { phase, progress: cycle / loopDur, cycle };
}

let lastPhase = "rest";

function tick() {
  if (!playing) return;
  const { phase, progress } = phaseNow();
  meterFill.style.width = `${Math.min(100, progress * 100)}%`;

  if (phase !== lastPhase) {
    orb.classList.remove("inhale", "exhale");
    if (phase === "inhale") {
      orb.classList.add("inhale");
      orbLabel.textContent = "Inhale";
      phaseCopy.textContent = "Soft tap — breathe in";
      playLocalTaps("inhale");
    } else if (phase === "exhale") {
      orb.classList.add("exhale");
      orbLabel.textContent = "Exhale";
      phaseCopy.textContent = "Double tap — breathe out";
      playLocalTaps("exhale");
    } else {
      orbLabel.textContent = "Rest";
      phaseCopy.textContent = "Let the sound hold you";
    }
    lastPhase = phase;
  }
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

  spa = new SpaAmbience(audioCtx, master);
  const t0 = audioCtx.currentTime;
  await spa.start(pattern.word, t0, soundSelect.value);

  loopStart = t0 + 1.0;
  playing = true;
  lastPhase = "rest";

  stage.hidden = false;
  seedChip.textContent = `Seed · ${pattern.word}`;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  wordInput.disabled = true;
  soundSelect.disabled = true;
  orbLabel.textContent = "Begin";
  phaseCopy.textContent = "Find a comfortable posture";
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
  startBtn.disabled = false;
  stopBtn.disabled = true;
  wordInput.disabled = false;
  soundSelect.disabled = false;
  orb.classList.remove("inhale", "exhale");
  orbLabel.textContent = "Ready";
  phaseCopy.textContent = "Session ended";
  meterFill.style.width = "0%";
}

fillSoundUI();
soundSelect.addEventListener("change", updateCredit);
form.addEventListener("submit", startSession);
stopBtn.addEventListener("click", stopSession);
