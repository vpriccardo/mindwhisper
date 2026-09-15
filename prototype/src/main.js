import {
  oggettiCasa,
  cellKey,
  getCellWords,
  hasTree,
  traitsForWord,
  wordsInZona,
  pathForWord,
  letterInWord,
} from "./modules/oggetti-casa.js";

const mod = oggettiCasa;

const stageEl = document.getElementById("stage");
const crumbsEl = document.getElementById("crumbs");
const contextEl = document.getElementById("context");
const flashEl = document.getElementById("flash");
const btnBack = document.getElementById("btn-back");
const btnRestart = document.getElementById("btn-restart");
const btnOuts = document.getElementById("btn-outs");
const outsDialog = document.getElementById("outs-dialog");
const outsList = document.getElementById("outs-list");

const STEPS = ["zona", "genere", "sillabe", "leaf", "finish"];

/** @type {{ mode: 'live'|'drill', step: string, zona: string|null, genere: string|null, sillabe: string|null, node: any, history: object[], secret: string|null, peek: boolean, pathLog: string[], drillExpected: object|null }} */
let state = createInitialState("live");

function createInitialState(mode) {
  return {
    mode,
    step: "zona",
    zona: null,
    genere: null,
    sillabe: null,
    node: null,
    history: [],
    secret: null,
    peek: false,
    pathLog: [],
    drillExpected: null,
  };
}

function currentKey() {
  if (!state.zona || !state.genere || !state.sillabe) return null;
  return cellKey(state.zona, state.genere, state.sillabe);
}

function remainingWords() {
  const key = currentKey();
  if (!key) {
    if (state.zona) return wordsInZona(mod, state.zona);
    return [];
  }
  if (state.node) return wordsUnderNode(state.node);
  return getCellWords(mod, key);
}

function wordsUnderNode(node) {
  if (!node) return [];
  if (node.reveal) return [...node.reveal];
  if (node.silentPass) return [...node.silentPass];
  return [...wordsUnderNode(node.yes), ...wordsUnderNode(node.no)];
}

function showFlash(message, kind) {
  flashEl.hidden = false;
  flashEl.textContent = message;
  flashEl.className = `flash is-${kind}`;
  clearTimeout(showFlash._t);
  showFlash._t = setTimeout(() => {
    flashEl.hidden = true;
  }, 2200);
}

function pushHistory() {
  state.history.push({
    step: state.step,
    zona: state.zona,
    genere: state.genere,
    sillabe: state.sillabe,
    node: state.node,
    pathLog: [...state.pathLog],
  });
}

function renderCrumbs() {
  const labels = {
    zona: "Zona",
    genere: "Genere",
    sillabe: "Sillabe",
    leaf: "PA",
    finish: "Reveal",
  };
  const idx = STEPS.indexOf(state.step);
  crumbsEl.innerHTML = STEPS.map((id, i) => {
    let cls = "crumb";
    if (i < idx) cls += " is-done";
    if (i === idx) cls += " is-now";
    const value =
      id === "zona"
        ? state.zona
        : id === "genere"
          ? state.genere
          : id === "sillabe"
            ? state.sillabe
            : null;
    const text = value ? `${labels[id]} · ${value}` : labels[id];
    return `<span class="${cls}">${text}</span>`;
  }).join("");
}

function renderContext() {
  const words = remainingWords();
  const parts = [];

  if (state.mode === "drill") {
    if (state.secret) {
      const shown = state.peek ? state.secret : "••••••••";
      parts.push(
        `Parola segreta: <button type="button" class="secret-btn" id="peek-btn">${shown}</button>`,
      );
    } else {
      parts.push("Scegli la zona — poi estraggo una parola per il drill.");
    }
  } else if (words.length) {
    parts.push(`Candidati: <strong>${words.length}</strong>`);
    if (state.step === "leaf" || state.step === "finish") {
      parts.push(`<span class="bank">${words.map((w) => `<span>${w}</span>`).join("")}</span>`);
    }
  }

  if (!parts.length) {
    contextEl.hidden = true;
    contextEl.innerHTML = "";
    return;
  }
  contextEl.hidden = false;
  contextEl.innerHTML = parts.join(" · ");
  const peek = document.getElementById("peek-btn");
  if (peek) {
    peek.addEventListener("click", () => {
      state.peek = !state.peek;
      renderContext();
    });
  }
}

function setStage(html) {
  stageEl.innerHTML = html;
  // re-trigger enter animation
  stageEl.style.animation = "none";
  void stageEl.offsetWidth;
  stageEl.style.animation = "";
}

function renderZona() {
  setStage(`
    <p class="eyebrow">Force</p>
    <p class="script">Scegli la zona da forzare.</p>
    <p class="script-note">Una sola per la sera — o equivoque tra le tre.</p>
    <div class="actions cols-3" id="choices"></div>
  `);
  const wrap = document.getElementById("choices");
  for (const [id, script] of Object.entries(mod.forceScripts)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.innerHTML = `<span class="label">${cap(id)}</span><span class="hint">${script}</span>`;
    btn.addEventListener("click", () => chooseZona(id));
    wrap.appendChild(btn);
  }
}

function chooseZona(zona) {
  if (state.mode === "drill") {
    // In drill, zona must match secret once drawn — draw after zona pick
  }
  pushHistory();
  state.zona = zona;
  state.pathLog.push(`zona:${zona}`);

  if (state.mode === "drill" && !state.secret) {
    const pool = wordsInZona(mod, zona);
    state.secret = pool[Math.floor(Math.random() * pool.length)];
    state.drillExpected = traitsForWord(mod, state.secret);
  }

  if (state.mode === "drill" && state.drillExpected && state.drillExpected.zona !== zona) {
    showFlash(`Drill: la parola è in ${cap(state.drillExpected.zona)}.`, "bad");
    state.zona = null;
    state.pathLog.pop();
    state.history.pop();
    render();
    return;
  }

  state.step = "genere";
  render();
}

function renderGenere() {
  const trait = mod.traits.find((t) => t.id === "genere");
  setStage(`
    <p class="eyebrow">Frame 1 — Genere</p>
    <p class="script">${escapeHtml(mod.forceScripts[state.zona])}</p>
    <p class="script-note">${escapeHtml(mod.lockScript)}</p>
    <p class="script" style="margin-top:1rem">${escapeHtml(trait.frameScript)}</p>
    <div class="actions cols-2" id="choices"></div>
  `);
  const wrap = document.getElementById("choices");
  for (const v of trait.values) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.innerHTML = `<span class="label">${v.label}</span><span class="hint">${v.hint}</span>`;
    btn.addEventListener("click", () => chooseTrait("genere", v.id));
    wrap.appendChild(btn);
  }
}

function renderSillabe() {
  const trait = mod.traits.find((t) => t.id === "sillabe");
  setStage(`
    <p class="eyebrow">Frame 2 — Respiro / sillabe</p>
    <p class="script">${escapeHtml(trait.frameScript)}</p>
    <div class="actions cols-2" id="choices"></div>
  `);
  const wrap = document.getElementById("choices");
  for (const v of trait.values) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.innerHTML = `<span class="label">${v.label}</span><span class="hint">${v.hint}</span>`;
    btn.addEventListener("click", () => chooseTrait("sillabe", v.id));
    wrap.appendChild(btn);
  }
}

function chooseTrait(which, value) {
  if (state.mode === "drill" && state.drillExpected) {
    const expected = state.drillExpected[which];
    if (expected !== value) {
      showFlash(`Atteso ${expected} (parola: ${state.secret}).`, "bad");
      return;
    }
    showFlash("Ok.", "ok");
  }

  pushHistory();
  state[which] = value;
  state.pathLog.push(`${which}:${value}`);

  if (which === "genere") {
    state.step = "sillabe";
  } else {
    enterLeaf();
  }
  render();
}

function enterLeaf() {
  const key = currentKey();
  state.pathLog.push(`cell:${key}`);

  if (hasTree(mod, key)) {
    state.node = mod.trees[key];
    state.step = "leaf";
    return;
  }

  // No tree yet — bank + pending
  state.node = null;
  state.step = "leaf";
}

function renderLeaf() {
  const key = currentKey();
  const words = getCellWords(mod, key);

  if (!hasTree(mod, key)) {
    setStage(`
      <p class="eyebrow">Foglia · ${key}</p>
      <p class="script">${escapeHtml(mod.intoLeafScript)}</p>
      <p class="pending">Albero PA non ancora verificato per questa cella. Banca chiusa sotto — usa outs se serve.</p>
      <div class="bank">${words.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="actions" style="margin-top:1.25rem">
        <button type="button" class="choice" id="finish-bank">
          <span class="label">Chiudi / outs</span>
          <span class="hint">Vai al reveal della banca</span>
        </button>
      </div>
    `);
    document.getElementById("finish-bank").addEventListener("click", () => {
      pushHistory();
      state.step = "finish";
      state.node = { reveal: words, pending: true };
      render();
    });
    return;
  }

  const node = state.node;
  if (node.reveal || node.silentPass) {
    pushHistory();
    state.step = "finish";
    render();
    return;
  }

  setStage(`
    <p class="eyebrow">Reverse PA · lettera</p>
    <p class="script">${escapeHtml(mod.intoLeafScript)}</p>
    <p class="script-note">Sto pulendo il rumore sulla lettera…</p>
    <div class="actions cols-2" id="choices"></div>
  `);
  const wrap = document.getElementById("choices");

  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "choice big-letter";
  yes.innerHTML = `<span class="label">${node.letter}? · Sì</span><span class="hint">C’è ${node.letter}</span>`;
  yes.addEventListener("click", () => chooseLetter("yes"));
  wrap.appendChild(yes);

  const no = document.createElement("button");
  no.type = "button";
  no.className = "choice big-letter";
  no.innerHTML = `<span class="label">${node.letter}? · No</span><span class="hint">Non c’è ${node.letter}</span>`;
  no.addEventListener("click", () => chooseLetter("no"));
  wrap.appendChild(no);
}

function chooseLetter(answer) {
  const node = state.node;
  if (state.mode === "drill" && state.secret) {
    const expected = letterInWord(state.secret, node.letter) ? "yes" : "no";
    if (answer !== expected) {
      showFlash(
        `Atteso ${expected === "yes" ? "Sì" : "No"} per «${node.letter}» (${state.secret}).`,
        "bad",
      );
      return;
    }
    showFlash("Ok.", "ok");
  }

  pushHistory();
  state.pathLog.push(`${node.letter}:${answer}`);
  state.node = answer === "yes" ? node.yes : node.no;

  if (state.node.reveal || state.node.silentPass) {
    state.step = "finish";
  }
  render();
}

function renderFinish() {
  const node = state.node;
  const words = node?.reveal || node?.silentPass || getCellWords(mod, currentKey());
  const silent = Boolean(node?.silentPass);
  const pending = Boolean(node?.pending);

  let body;
  if (pending) {
    body = `
      <p class="eyebrow">Banca · tree pending</p>
      <p class="script">Foglia senza albero — shortlist:</p>
      <div class="bank">${words.map((w) => `<span>${w}</span>`).join("")}</div>
    `;
  } else if (silent) {
    body = `
      <p class="eyebrow">Silent / pass</p>
      <p class="script">Due restano — Trinity finish.</p>
      <p class="reveal-word">${words.join(" · ")}</p>
    `;
  } else if (words.length === 1) {
    body = `
      <p class="eyebrow">Reveal</p>
      <p class="script">Con convinzione:</p>
      <p class="reveal-word">${words[0]}</p>
    `;
  } else {
    body = `
      <p class="eyebrow">Reveal</p>
      <p class="script">Binario finale:</p>
      <p class="reveal-word">${words.join(" / ")}</p>
    `;
  }

  if (state.mode === "drill" && state.secret) {
    const hit = words.map((w) => w.toLowerCase()).includes(state.secret.toLowerCase());
    const tree = mod.trees[currentKey()];
    const ideal = tree ? pathForWord(tree, state.secret) : null;
    const idealStr = ideal
      ? ideal.map((p) => `${p.letter}:${p.answer === "yes" ? "Sì" : "No"}`).join(" → ")
      : "—";
    body += `
      <p class="summary">
        Drill: <strong>${state.secret}</strong> —
        ${hit ? "in target ✓" : "fuori target"}<br />
        Path: <code>${state.pathLog.join(" · ")}</code><br />
        Ideale PA: <code>${idealStr}</code>
      </p>
    `;
  }

  body += `
    <div class="actions" style="margin-top:1.25rem">
      <button type="button" class="choice" id="again">
        <span class="label">Nuova prova</span>
        <span class="hint">${state.mode === "drill" ? "Nuova parola nella stessa modalità" : "Ricomincia dal force"}</span>
      </button>
    </div>
  `;

  setStage(body);
  document.getElementById("again").addEventListener("click", () => {
    const mode = state.mode;
    state = createInitialState(mode);
    render();
  });
}

function render() {
  renderCrumbs();
  btnBack.disabled = state.history.length === 0;

  if (state.step === "zona") renderZona();
  else if (state.step === "genere") renderGenere();
  else if (state.step === "sillabe") renderSillabe();
  else if (state.step === "leaf") renderLeaf();
  else renderFinish();

  renderContext();
}

function goBack() {
  const prev = state.history.pop();
  if (!prev) return;
  state.step = prev.step;
  state.zona = prev.zona;
  state.genere = prev.genere;
  state.sillabe = prev.sillabe;
  state.node = prev.node;
  state.pathLog = prev.pathLog;
  render();
}

function restart() {
  const mode = state.mode;
  state = createInitialState(mode);
  flashEl.hidden = true;
  render();
}

function fillOuts() {
  const zona = state.zona || "zona";
  outsList.innerHTML = mod.outs
    .map(
      (o) => `
      <article class="out-card">
        <h3>${escapeHtml(o.title)}</h3>
        <p>${escapeHtml(o.script.replace("[zona]", zona))}</p>
      </article>`,
    )
    .join("");
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Mode toggle
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state = createInitialState(btn.dataset.mode);
    flashEl.hidden = true;
    render();
  });
});

btnBack.addEventListener("click", goBack);
btnRestart.addEventListener("click", restart);
btnOuts.addEventListener("click", () => {
  fillOuts();
  outsDialog.showModal();
});

render();
