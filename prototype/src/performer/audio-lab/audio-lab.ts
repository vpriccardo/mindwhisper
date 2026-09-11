import { HIDDEN_DICTIONARY_META } from "../../generated/hiddenDictionaryMeta";
import { hexToToken } from "../../shared/hiddenEnvelopeProtocol";
import { exactLookupByToken } from "../watermark/dictionaryMatcher";
import {
  listAudioInputDevices,
  startAudioScanner,
  type AudioScannerHandle,
} from "../audioSeal/audioScanner";
import type { AudioDiagnostics, AudioPayloadInfo } from "../audioSeal/types";

const micEl = document.getElementById("mic") as HTMLSelectElement;
const stateEl = document.getElementById("state") as HTMLElement;
const wordEl = document.getElementById("word") as HTMLElement;
const tokenEl = document.getElementById("token") as HTMLInputElement;
const payloadNoteEl = document.getElementById("payload-note") as HTMLElement;
const diagEl = document.getElementById("diag") as HTMLElement;
const errEl = document.getElementById("err") as HTMLElement;
const meterEl = document.getElementById("meter") as HTMLElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const wave = document.getElementById("wave") as HTMLCanvasElement;

let handle: AudioScannerHandle | null = null;
let lastDiagAt = 0;
/** Latched CRC-ok token — cleared only by Clear / new read (or Stop). */
let latchedToken: string | null = null;
let latchedCrcOk = false;
let latchedWord: string | null = null;
let digestTable: Uint8Array | null = null;

async function loadDigest(): Promise<Uint8Array> {
  if (digestTable) return digestTable;
  const res = await fetch(
    new URL("../assets/envelope/hiddenDigestTable.bin", location.href).toString(),
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error("Failed to load digest table");
  digestTable = new Uint8Array(await res.arrayBuffer());
  return digestTable;
}

function clearLatch(): void {
  latchedToken = null;
  latchedCrcOk = false;
  latchedWord = null;
  tokenEl.value = "";
  wordEl.textContent = "—";
  payloadNoteEl.textContent = "";
}

function applyPayload(info: AudioPayloadInfo): void {
  // CRC-ok always wins and latches permanently until Clear.
  if (latchedCrcOk && !info.crcOk) return;
  if (latchedCrcOk && info.crcOk && info.tokenHex === latchedToken) {
    if (info.word && !latchedWord) {
      latchedWord = info.word;
      wordEl.textContent = info.word;
    }
    return;
  }

  tokenEl.value = info.tokenHex;
  payloadNoteEl.textContent = `${info.crcOk ? "CRC ok" : "CRC FAIL"} — ${info.note}`;
  if (info.crcOk) {
    latchedToken = info.tokenHex;
    latchedCrcOk = true;
    stateEl.textContent = "LOCKED (token)";
    if (info.word) {
      latchedWord = info.word;
      wordEl.textContent = info.word;
      stateEl.textContent = "LOCKED";
    } else {
      wordEl.textContent = "(token only — use Lookup or paste)";
    }
    try {
      navigator.vibrate?.(50);
    } catch {
      /* */
    }
  } else if (!latchedToken) {
    // Provisional best-effort hex until a CRC-ok arrives.
    latchedToken = info.tokenHex;
    stateEl.textContent = "TOKEN (crc fail)";
    wordEl.textContent = "—";
  }
}

async function lookupToken(hex: string): Promise<void> {
  errEl.textContent = "";
  try {
    const token = hexToToken(hex.trim());
    const table = await loadDigest();
    const match = exactLookupByToken({
      token,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable: table,
    });
    if (!match) {
      wordEl.textContent = "(no dictionary match)";
      payloadNoteEl.textContent = `Looked up ${hex.trim()} — not in dictionary.`;
      return;
    }
    if (match.ambiguous) {
      wordEl.textContent = "(ambiguous)";
      payloadNoteEl.textContent = `Looked up ${hex.trim()} — ambiguous match.`;
      return;
    }
    latchedWord = match.canonicalWord;
    wordEl.textContent = match.canonicalWord;
    payloadNoteEl.textContent = `Manual lookup OK — surface=${match.surface} (${match.matchType})`;
    stateEl.textContent = latchedCrcOk ? "LOCKED" : "LOOKUP";
  } catch (e) {
    errEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

async function refreshMics(): Promise<void> {
  const prev = micEl.value;
  micEl.replaceChildren();
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = "Default";
  micEl.appendChild(opt);
  try {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      /* */
    }
    const devices = await listAudioInputDevices();
    for (const d of devices) {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Mic ${micEl.options.length}`;
      micEl.appendChild(o);
    }
    if (prev && [...micEl.options].some((x) => x.value === prev)) micEl.value = prev;
  } catch (e) {
    errEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

function renderDiag(diag: AudioDiagnostics): void {
  const now = performance.now();
  if (now - lastDiagAt < 250) return;
  lastDiagAt = now;
  const settings = handle?.getTrackSettings?.() ?? {};
  diagEl.textContent = [
    `state=${diag.state}`,
    `LAST_FAIL=${diag.lastFailReason ?? "—"}`,
    `lastTokenHex=${diag.lastTokenHex ?? latchedToken ?? "—"}`,
    `inputDbfs=${diag.inputDbfs.toFixed(1)} (want ≥ −35 while chirping)`,
    `clipped%=${diag.clippedPct.toFixed(2)}`,
    `sampleRate=${diag.sampleRate} resampled=${diag.resampled}`,
    `AEC=${diag.echoCancellation} NS=${diag.noiseSuppression} AGC=${diag.autoGainControl}`,
    `bestCorr=${diag.bestPreambleScore?.toFixed(3) ?? "—"} preamble=${diag.preambleScore?.toFixed(3) ?? "—"} sidelobe=${diag.sidelobeRatio?.toFixed(2) ?? "—"}`,
    `timeScale=${diag.timeScale ?? "—"}`,
    `viterbiMetric=${diag.viterbiMetric?.toFixed(2) ?? "—"} margin=${diag.viterbiMargin?.toFixed(2) ?? "—"}`,
    `crcOk=${diag.crcOk} snr=${diag.snrEstimate?.toFixed(1) ?? "—"} decodeMs=${diag.decodeMs?.toFixed(1) ?? "—"}`,
    `candidates=${diag.candidates} crcFail=${diag.crcFailures} noMatch=${diag.noMatch}`,
    `duplicates=${diag.duplicates} locks=${diag.locks} dropped=${diag.droppedChunks} ringFill%=${diag.ringFillPct ?? diag.bufferOverruns}`,
    `track=${JSON.stringify(settings)}`,
    "",
    "Compare latched token with TX diag token=… — match ⇒ audio path works.",
    "TX http://127.0.0.1:8000/audio-lab/  —  RX this page (:8001).",
  ].join("\n");
  const pct = Math.max(0, Math.min(100, ((diag.inputDbfs + 60) / 60) * 100));
  meterEl.style.width = `${pct}%`;
}

startBtn.addEventListener("click", () => {
  void (async () => {
    errEl.textContent = "";
    clearLatch();
    startBtn.disabled = true;
    try {
      handle?.stop();
      void loadDigest();
      handle = await startAudioScanner({
        deviceId: micEl.value || undefined,
        workerUrl: new URL("../audioDecoderWorker.js", location.href).toString(),
        workletUrl: new URL("../audioCaptureWorklet.js", location.href).toString(),
        digestTableUrl: new URL(
          "../assets/envelope/hiddenDigestTable.bin",
          location.href,
        ).toString(),
        callbacks: {
          onStatus: (s) => {
            if (latchedCrcOk) {
              stateEl.textContent = latchedWord ? "LOCKED" : "LOCKED (token)";
              return;
            }
            stateEl.textContent = s;
          },
          onPayload: (info) => {
            applyPayload(info);
          },
          onLock: (info) => {
            applyPayload({
              tokenHex: info.tokenHex,
              crcOk: true,
              word: info.word,
              surface: info.surface,
              preambleScore: info.preambleScore,
              viterbiMargin: info.viterbiMargin,
              snrEstimate: info.snrEstimate,
              timeToLockMs: info.timeToLockMs,
              note: "CRC ok + dictionary match",
            });
          },
          onDiagnostics: (diag) => {
            if (latchedCrcOk) {
              renderDiag({
                ...diag,
                state: "LOCKED",
                lastFailReason: "latched",
                lastTokenHex: latchedToken,
              });
              return;
            }
            renderDiag(diag);
          },
          onError: (m) => {
            errEl.textContent = m;
          },
        },
      });
      stopBtn.disabled = false;
      await refreshMics();
    } catch (e) {
      errEl.textContent = e instanceof Error ? e.message : String(e);
      startBtn.disabled = false;
    }
  })();
});

stopBtn.addEventListener("click", () => {
  handle?.stop();
  handle = null;
  clearLatch();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  stateEl.textContent = "IDLE";
});

document.getElementById("clear")!.addEventListener("click", () => {
  handle?.reset();
  clearLatch();
  stateEl.textContent = "LISTENING";
});

document.getElementById("copy-token")!.addEventListener("click", () => {
  const hex = tokenEl.value.trim();
  if (!hex) {
    errEl.textContent = "No token latched yet.";
    return;
  }
  void navigator.clipboard.writeText(hex).then(
    () => {
      payloadNoteEl.textContent = `Copied ${hex}`;
    },
    () => {
      tokenEl.select();
      errEl.textContent = "Clipboard blocked — token selected, copy manually.";
    },
  );
});

document.getElementById("lookup-token")!.addEventListener("click", () => {
  const hex = tokenEl.value.trim();
  if (!hex) {
    errEl.textContent = "No token to look up.";
    return;
  }
  void lookupToken(hex);
});

document.getElementById("wav")!.addEventListener("change", (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file || !handle) {
    errEl.textContent = handle
      ? "No file"
      : "Start listening first (or after start, import WAV).";
    return;
  }
  void file.arrayBuffer().then(async (ab) => {
    const view = new DataView(ab);
    if (
      String.fromCharCode(
        view.getUint8(0),
        view.getUint8(1),
        view.getUint8(2),
        view.getUint8(3),
      ) !== "RIFF"
    ) {
      errEl.textContent = "Not a RIFF WAV";
      return;
    }
    let offset = 12;
    let sampleRate = 48000;
    let bits = 16;
    let dataOffset = 0;
    let dataBytes = 0;
    while (offset + 8 <= view.byteLength) {
      const id = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
      );
      const size = view.getUint32(offset + 4, true);
      if (id === "fmt ") {
        sampleRate = view.getUint32(offset + 12, true);
        bits = view.getUint16(offset + 22, true);
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataBytes = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!dataOffset) {
      errEl.textContent = "WAV data chunk missing";
      return;
    }
    const count = Math.floor(dataBytes / (bits / 8));
    const samples = new Float32Array(count);
    if (bits === 16) {
      for (let i = 0; i < count; i++) {
        samples[i] = view.getInt16(dataOffset + i * 2, true) / 0x8000;
      }
    } else {
      errEl.textContent = "Only 16-bit PCM WAV supported in lab import";
      return;
    }
    handle!.decodeWav(samples, sampleRate);
  });
});

void wave;
void refreshMics();
