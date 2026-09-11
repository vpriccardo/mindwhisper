import { AcquisitionController } from "./acquisition";
import { validatePayloadText } from "./payloadValidate";
import { listVideoInputDevices, startScanner, type ScannerHandle } from "./scanner";
import {
  startHiddenScanner,
  type HiddenScannerHandle,
} from "./watermark/hiddenScanner";
import type { WorkerDiagnostics } from "./watermark/types";
import {
  listAudioInputDevices,
  startAudioScanner,
  type AudioScannerHandle,
} from "./audioSeal/audioScanner";
import type { AudioDiagnostics } from "./audioSeal/types";

type RecoverJson = {
  ok: boolean;
  result?: {
    matchedSurface: string;
    canonicalWord: string;
    conceptId: string;
    matchType: string;
  };
  matches?: Array<{
    matchedSurface: string;
    canonicalWord: string;
    conceptId: string;
    matchType: string;
  }>;
  diagnostics?: {
    conceptCount: number;
    candidateCount: number;
    matchCount: number;
    parseMs: number;
    searchMs: number;
    serverTotalMs: number;
  };
  debug?: {
    digestHex: string;
    saltHex: string;
  };
  error?: {
    code: string;
    message: string;
  };
};

type ScanMode = "audio" | "hidden" | "visible";

const acquisition = new AcquisitionController();
let scanner: ScannerHandle | null = null;
let hiddenScanner: HiddenScannerHandle | null = null;
let audioScanner: AudioScannerHandle | null = null;
let abortController: AbortController | null = null;
let lastEmptyUiAt = 0;
let lastDiagUiAt = 0;
let henvStatus = "Searching";
let recoveredWord: string | null = null;

const urlParams = new URLSearchParams(location.search);
const debugMode = urlParams.get("debug") === "1";
/** Development-only spectator signal ladder — inferred when same query is present. */
const strongSignalMode =
  debugMode && urlParams.get("henvSignal") === "strong";
const baseUrl = new URL("./", location.href).toString();

const payloadInput = document.getElementById("payload-input") as HTMLTextAreaElement;
const recoverBtn = document.getElementById("recover-btn") as HTMLButtonElement;
const formError = document.getElementById("form-error") as HTMLElement;
const resultSection = document.getElementById("result") as HTMLElement;
const resultDl = document.getElementById("result-dl") as HTMLDListElement;
const diagnosticsSection = document.getElementById("diagnostics") as HTMLElement;
const diagnosticsDl = document.getElementById("diagnostics-dl") as HTMLDListElement;
const debugDl = document.getElementById("debug-dl") as HTMLDListElement;
const scanStateEl = document.getElementById("scan-state") as HTMLElement;
const camError = document.getElementById("cam-error") as HTMLElement;
const camStart = document.getElementById("cam-start") as HTMLButtonElement;
const camStop = document.getElementById("cam-stop") as HTMLButtonElement;
const camRefresh = document.getElementById("cam-refresh") as HTMLButtonElement;
const camDevice = document.getElementById("cam-device") as HTMLSelectElement;
const camVideo = document.getElementById("cam-video") as HTMLVideoElement;
const clearLockBtn = document.getElementById("clear-lock") as HTMLButtonElement;
const lockFormat = document.getElementById("lock-format") as HTMLElement;
const lockPayload = document.getElementById("lock-payload") as HTMLElement;
const lockAcquired = document.getElementById("lock-acquired") as HTMLElement;
const lockSeen = document.getElementById("lock-seen") as HTMLElement;
const recoveredWordEl = document.getElementById("recovered-word") as HTMLElement;
const henvDebugEl = document.getElementById("henv-debug-dl") as HTMLDListElement | null;
const henvStatusEl = document.getElementById("henv-status") as HTMLElement | null;
const henvOverlay = document.getElementById("henv-overlay") as HTMLCanvasElement | null;
const modeAudio = document.getElementById("mode-audio") as HTMLInputElement | null;
const modeHidden = document.getElementById("mode-hidden") as HTMLInputElement;
const modeVisible = document.getElementById("mode-visible") as HTMLInputElement;
const micStart = document.getElementById("mic-start") as HTMLButtonElement | null;
const micStop = document.getElementById("mic-stop") as HTMLButtonElement | null;
const micRefresh = document.getElementById("mic-refresh") as HTMLButtonElement | null;
const micDevice = document.getElementById("mic-device") as HTMLSelectElement | null;
const audioControls = document.getElementById("audio-controls") as HTMLElement | null;
const cameraControls = document.getElementById("camera-controls") as HTMLElement | null;
const camPreviewWrap = document.getElementById("cam-preview-wrap") as HTMLElement | null;
const audioLevelEl = document.getElementById("audio-level") as HTMLElement | null;

let henvStatusLabel = "Audio: idle";

function selectedMode(): ScanMode {
  if (modeVisible?.checked) return "visible";
  if (modeHidden?.checked) return "hidden";
  return "audio";
}

function syncModeUi(): void {
  const mode = selectedMode();
  if (audioControls) audioControls.hidden = mode !== "audio";
  if (cameraControls) cameraControls.hidden = mode === "audio";
  if (camPreviewWrap) camPreviewWrap.hidden = mode === "audio";
  if (audioLevelEl) audioLevelEl.hidden = mode !== "audio";
  if (mode === "audio") {
    henvStatusLabel = "Audio: idle";
  } else if (mode === "hidden") {
    henvStatusLabel = "Hidden: idle";
  } else {
    henvStatusLabel = "Visible: idle";
  }
  refreshLockUi();
}

function clearDl(dl: HTMLDListElement): void {
  dl.replaceChildren();
}

function addRow(
  dl: HTMLDListElement,
  label: string,
  value: string,
  className?: string,
): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (className) dd.className = className;
  dl.append(dt, dd);
}

function setFormError(message: string | null): void {
  if (!message) {
    formError.hidden = true;
    formError.textContent = "";
    return;
  }
  formError.hidden = false;
  formError.textContent = message;
}

function setCamError(message: string | null): void {
  if (!message) {
    camError.hidden = true;
    camError.textContent = "";
    return;
  }
  camError.hidden = false;
  camError.textContent = message;
}

function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return `${ms.toFixed(0)} ms`;
}

function refreshLockUi(): void {
  const snap = acquisition.snapshot;
  const mode = selectedMode();
  if (mode === "audio") {
    scanStateEl.textContent = `State: ${henvStatus}`;
    if (henvStatusEl) henvStatusEl.textContent = henvStatusLabel;
  } else if (mode === "hidden") {
    scanStateEl.textContent = `State: ${henvStatus}`;
    if (henvStatusEl) henvStatusEl.textContent = henvStatusLabel;
  } else {
    scanStateEl.textContent = `State: ${snap.state}`;
    if (henvStatusEl) henvStatusEl.textContent = "Visible: idle";
  }
  lockFormat.textContent = snap.opticalFormat ?? (snap.lockedPayload ? "paste" : "—");
  lockPayload.textContent = snap.lockedPayload ?? "—";
  lockAcquired.textContent = fmtTime(snap.acquiredAt);
  lockSeen.textContent = fmtTime(snap.lastSeenAt);
  recoveredWordEl.textContent = recoveredWord ?? "—";

  clearDl(debugDl);
  addRow(debugDl, "Decode attempts", String(snap.debug.attempts));
  addRow(debugDl, "Valid detections", String(snap.debug.validDetections));
  addRow(debugDl, "Invalid recognized", String(snap.debug.invalidRecognized));
  addRow(debugDl, "Avg decode ms", snap.debug.avgDecodeMs.toFixed(1));
  addRow(debugDl, "Recover API calls", String(snap.recoverCalls));
  addRow(debugDl, "Generation", String(snap.generation));
  if (snap.cameraError) addRow(debugDl, "Camera error", snap.cameraError);
  if (snap.recoveryError) addRow(debugDl, "Recovery error", snap.recoveryError);
}

function drawHenvOverlay(diag: WorkerDiagnostics): void {
  if (!debugMode || !henvOverlay) return;
  const wrap = henvOverlay.parentElement;
  if (!wrap) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (w <= 0 || h <= 0) return;
  if (henvOverlay.width !== w || henvOverlay.height !== h) {
    henvOverlay.width = w;
    henvOverlay.height = h;
  }
  henvOverlay.hidden = false;
  const ctx = henvOverlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const srcW = diag.captureDebug?.sourceVideoWidth || camVideo.videoWidth || 1;
  const srcH = diag.captureDebug?.sourceVideoHeight || camVideo.videoHeight || 1;
  // object-fit: cover mapping
  const scale = Math.max(w / srcW, h / srcH);
  const dispW = srcW * scale;
  const dispH = srcH * scale;
  const offX = (w - dispW) / 2;
  const offY = (h - dispH) / 2;
  const map = (p: { x: number; y: number }) => ({
    x: offX + p.x * scale,
    y: offY + p.y * scale,
  });
  if (diag.quad && diag.quad.length === 4) {
    ctx.strokeStyle = "rgba(196, 163, 90, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const p0 = map(diag.quad[0]!);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < 4; i++) {
      const p = map(diag.quad[i]!);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  if (diag.projectedHeightPx > 0 && diag.projectedHeightPx < 240) {
    ctx.fillStyle = "rgba(224, 112, 112, 0.92)";
    ctx.font = "14px ui-monospace, monospace";
    ctx.fillText(
      `Envelope height ${diag.projectedHeightPx.toFixed(0)}px < 240 — move closer`,
      8,
      20,
    );
  }
}

acquisition.onRecover((payload, generation) => {
  void runRecover(payload, generation);
});

async function runRecover(payload: string, generation: number): Promise<void> {
  abortController?.abort();
  abortController = new AbortController();
  const t0 = performance.now();
  try {
    const res = await fetch("/api/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
      signal: abortController.signal,
    });
    const json = (await res.json()) as RecoverJson;
    if (!acquisition.isCurrentGeneration(generation)) return;
    const roundTrip = performance.now() - t0;

    if (json.ok && json.result) {
      acquisition.markRecovered(generation);
      recoveredWord = json.result.canonicalWord;
      resultSection.hidden = false;
      clearDl(resultDl);
      addRow(resultDl, "Canonical word", json.result.canonicalWord);
      addRow(resultDl, "Matched surface", json.result.matchedSurface);
      addRow(resultDl, "Concept ID", json.result.conceptId);
      addRow(resultDl, "Match type", json.result.matchType);
    } else if (
      json.error?.code === "NO_DICTIONARY_MATCH" ||
      json.error?.code === "AMBIGUOUS_MATCH"
    ) {
      acquisition.markNoMatch(generation, json.error.message);
      recoveredWord = null;
      resultSection.hidden = false;
      clearDl(resultDl);
      addRow(resultDl, "Error", json.error.message);
    } else {
      acquisition.markRecoveryError(
        generation,
        json.error?.message ?? `HTTP ${res.status}`,
      );
      recoveredWord = null;
    }

    diagnosticsSection.hidden = false;
    clearDl(diagnosticsDl);
    addRow(diagnosticsDl, "Browser round-trip ms", roundTrip.toFixed(1));
    if (json.diagnostics) {
      addRow(diagnosticsDl, "Parse ms", String(json.diagnostics.parseMs));
      addRow(diagnosticsDl, "Search ms", String(json.diagnostics.searchMs));
      addRow(diagnosticsDl, "Server total ms", String(json.diagnostics.serverTotalMs));
      addRow(diagnosticsDl, "Concepts", String(json.diagnostics.conceptCount));
      addRow(diagnosticsDl, "Candidates", String(json.diagnostics.candidateCount));
      addRow(diagnosticsDl, "Matches", String(json.diagnostics.matchCount));
    }
    if (json.debug) {
      addRow(diagnosticsDl, "Digest", json.debug.digestHex, "mono");
      addRow(diagnosticsDl, "Salt", json.debug.saltHex, "mono");
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    if (!acquisition.isCurrentGeneration(generation)) return;
    acquisition.markRecoveryError(
      generation,
      err instanceof Error ? err.message : "Recover failed",
    );
  }
  refreshLockUi();
}

async function onManualRecover(): Promise<void> {
  setFormError(null);
  const check = validatePayloadText(payloadInput.value);
  if (!check.ok) {
    setFormError(check.message);
    return;
  }
  const generation = acquisition.lockFromPaste(check.payload, performance.now());
  refreshLockUi();
  await runRecover(check.payload, generation);
}

async function populateDevices(): Promise<void> {
  const previous = camDevice.value;
  camDevice.replaceChildren();
  const optDefault = document.createElement("option");
  optDefault.value = "";
  optDefault.textContent = "Default / environment";
  camDevice.appendChild(optDefault);
  try {
    // Permission probe so Continuity Camera / iPhone labels appear.
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: true,
        });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        /* labels may stay empty until Start */
      }
    }
    const devices = await listVideoInputDevices();
    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${camDevice.options.length}`;
      camDevice.appendChild(opt);
    }
    if (previous && [...camDevice.options].some((o) => o.value === previous)) {
      camDevice.value = previous;
    }
  } catch {
    // ignore until permission granted
  }
}

function stopAllScanners(): void {
  scanner?.stop();
  scanner = null;
  hiddenScanner?.stop();
  hiddenScanner = null;
  audioScanner?.stop();
  audioScanner = null;
}

async function onStartCamera(): Promise<void> {
  setCamError(null);
  acquisition.beginRequestCamera();
  refreshLockUi();
  camStart.disabled = true;
  recoveredWord = null;
  henvStatus = "Searching";
  henvStatusLabel = "Searching for envelope";

  try {
    if (!window.isSecureContext) {
      throw new Error(
        "Camera requires a secure context (https or http://127.0.0.1 / localhost).",
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not available in this browser.");
    }

    stopAllScanners();
    const mode = selectedMode();

    if (mode === "hidden") {
      if (henvOverlay) henvOverlay.hidden = !debugMode;
      hiddenScanner = await startHiddenScanner({
        video: camVideo,
        deviceId: camDevice.value || undefined,
        workerUrl: new URL("./hiddenEnvelopeWorker.js", location.href).toString(),
        baseUrl,
        debug: debugMode,
        callbacks: {
          onStatus: (s, label) => {
            henvStatus =
              s === "searching"
                ? "Searching"
                : s === "envelope_found"
                  ? "Envelope found"
                  : s === "reading"
                    ? "Reading"
                    : s === "signal_weak"
                      ? "Signal weak"
                      : s === "locked"
                        ? "Locked"
                        : s;
            henvStatusLabel =
              label ??
              (s === "locked"
                ? "Locked"
                : s === "signal_weak"
                  ? "Signal too weak — move closer or improve light"
                  : s === "reading"
                    ? "Reading hidden signal"
                    : s === "envelope_found"
                      ? "Envelope located — hold briefly"
                      : "Searching for envelope");
            refreshLockUi();
          },
          onLock: (info) => {
            const gen = acquisition.lockFromHiddenEnvelope({
              canonicalWord: info.word,
              tokenHex: info.tokenHex ?? "",
              nowMs: performance.now(),
            });
            if (!acquisition.isCurrentGeneration(gen) && gen !== acquisition.snapshot.generation) {
              return;
            }
            recoveredWord = info.word;
            henvStatus = "Locked";
            henvStatusLabel = "Locked";
            resultSection.hidden = false;
            clearDl(resultDl);
            addRow(resultDl, "Canonical word", info.word);
            addRow(resultDl, "Format", "HIDDEN_ENVELOPE_V1");
            if (info.timeToLockMs != null) {
              addRow(resultDl, "Time to lock ms", info.timeToLockMs.toFixed(0));
            }
            refreshLockUi();
          },
          onDiagnostics: (diag) => {
            drawHenvOverlay(diag);
            if (!debugMode || !henvDebugEl) return;
            const now = performance.now();
            if (now - lastDiagUiAt < 250) return;
            lastDiagUiAt = now;
            renderHenvDebug(diag);
          },
          onError: (message) => setCamError(message),
        },
      });
    } else {
      scanner = await startScanner({
        video: camVideo,
        deviceId: camDevice.value || undefined,
        onEvent: (event) => {
          const now = performance.now();
          if (event.kind === "error") {
            acquisition.setCameraError(event.message);
            setCamError(event.message);
            refreshLockUi();
            return;
          }
          if (event.kind === "empty") {
            acquisition.noteDecodeAttempt(event.decodeMs);
            acquisition.noteAbsence(now);
            if (now - lastEmptyUiAt > 250) {
              lastEmptyUiAt = now;
              refreshLockUi();
            }
            return;
          }
          acquisition.noteDecodeAttempt(event.decodeMs);
          acquisition.onRecognized({
            text: event.text,
            format: event.format,
            nowMs: now,
            decodeMs: event.decodeMs,
          });
          refreshLockUi();
        },
      });
    }
    acquisition.beginScanning();
    camStop.disabled = false;
    await populateDevices();
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === "NotAllowedError"
        ? "Camera permission denied."
        : err instanceof DOMException && err.name === "NotFoundError"
          ? "No camera device found."
          : err instanceof DOMException && err.name === "NotReadableError"
            ? "Camera is already in use."
            : err instanceof Error
              ? err.message
              : "Camera error.";
    acquisition.setCameraError(message);
    setCamError(message);
    camStart.disabled = false;
  }
  refreshLockUi();
}

function renderHenvDebug(diag: WorkerDiagnostics): void {
  if (!henvDebugEl) return;
  clearDl(henvDebugEl);
  addRow(
    henvDebugEl,
    "Signal mode",
    strongSignalMode
      ? "STRONG (dev ladder — not invisibility test)"
      : "normal (manifest alpha)",
  );
  addRow(henvDebugEl, "OpenCV ready", diag.opencvReady ? "yes" : "no");
  addRow(henvDebugEl, "Align mode", diag.alignMode);
  addRow(henvDebugEl, "Align path", diag.alignPath);
  addRow(henvDebugEl, "Search frames", String(diag.searchFrameCount));
  addRow(henvDebugEl, "Track frames", String(diag.trackFrameCount));
  addRow(henvDebugEl, "Inliers", String(diag.inliers));
  addRow(henvDebugEl, "Inlier ratio", diag.inlierRatio.toFixed(3));
  addRow(henvDebugEl, "Reproj error", diag.reprojError.toFixed(2));
  addRow(henvDebugEl, "Valid carrier %", diag.validCarrierPct.toFixed(1));
  addRow(henvDebugEl, "Projected height px", diag.projectedHeightPx.toFixed(0));
  addRow(henvDebugEl, "Sharpness", diag.sharpness.toFixed(1));
  addRow(henvDebugEl, "Quality", diag.quality.toFixed(3));
  addRow(henvDebugEl, "Reject", diag.rejectReason ?? "—");
  addRow(henvDebugEl, "Match fail", diag.matchFailReason ?? "—");
  addRow(henvDebugEl, "Buffer len", String(diag.bufferLen));
  addRow(henvDebugEl, "Independent frames", diag.independentFrames.toFixed(2));
  addRow(henvDebugEl, "Total weight", diag.totalWeight.toFixed(3));
  addRow(henvDebugEl, "Soft score", diag.softScore.toFixed(2));
  addRow(henvDebugEl, "Soft score margin", diag.softScoreMargin.toFixed(2));
  addRow(henvDebugEl, "Second soft score", diag.secondSoftScore.toFixed(2));
  addRow(henvDebugEl, "Avg |soft|", diag.avgAbsSoft.toFixed(4));
  addRow(henvDebugEl, "Residual chroma RMS", diag.residualChromaRms.toFixed(3));
  addRow(
    henvDebugEl,
    "Affine Cb",
    `scale=${diag.affineCbScale.toFixed(3)} bias=${diag.affineCbBias.toFixed(2)}`,
  );
  addRow(
    henvDebugEl,
    "Affine Cr",
    `scale=${diag.affineCrScale.toFixed(3)} bias=${diag.affineCrBias.toFixed(2)}`,
  );
  addRow(
    henvDebugEl,
    "Top salt",
    diag.saltHypothesis != null
      ? `${diag.saltHypothesis} (margin ${diag.saltMargin.toFixed(2)})`
      : "—",
  );
  addRow(
    henvDebugEl,
    "Est. hard bit errors",
    diag.estimatedBitErrors != null ? String(diag.estimatedBitErrors) : "—",
  );
  addRow(henvDebugEl, "Dropped frames", String(diag.droppedFrames));
  addRow(henvDebugEl, "Skipped frames", String(diag.skippedFrames));
  if (diag.captureDebug) {
    addRow(
      henvDebugEl,
      "Source video",
      `${diag.captureDebug.sourceVideoWidth}×${diag.captureDebug.sourceVideoHeight}`,
    );
    addRow(
      henvDebugEl,
      "Worker bitmap",
      `${diag.captureDebug.workerBitmapWidth}×${diag.captureDebug.workerBitmapHeight}`,
    );
    addRow(henvDebugEl, "Capture ms", diag.captureDebug.captureMs.toFixed(1));
    addRow(henvDebugEl, "Frames submitted", String(diag.captureDebug.framesSubmitted));
    addRow(henvDebugEl, "In-flight", String(diag.captureDebug.inFlight));
  }
  addRow(henvDebugEl, "Total ms", diag.totalMs.toFixed(1));
  for (const [k, v] of Object.entries(diag.stageMs)) {
    addRow(henvDebugEl, `Stage ${k} ms`, v.toFixed(1));
  }
  if (diag.softValues && diag.softValues.length) {
    addRow(
      henvDebugEl,
      "Soft values (first 8)",
      diag.softValues
        .slice(0, 8)
        .map((v) => v.toFixed(2))
        .join(", "),
    );
  }
  diag.topCandidates.forEach((c, i) => {
    addRow(
      henvDebugEl,
      `Candidate ${i + 1}`,
      `${c.word} soft score=${c.score.toFixed(2)}${c.margin != null ? ` margin=${c.margin.toFixed(2)}` : ""}`,
    );
  });
}

function onStopCamera(): void {
  stopAllScanners();
  acquisition.stopToIdle();
  if (!acquisition.snapshot.lockedPayload) {
    acquisition.forceIdle();
  }
  camStart.disabled = false;
  camStop.disabled = true;
  refreshLockUi();
}

function onClearLock(): void {
  abortController?.abort();
  acquisition.clearLockedResult(performance.now());
  recoveredWord = null;
  henvStatus = selectedMode() === "audio" ? "Listening" : "Searching";
  henvStatusLabel =
    selectedMode() === "audio" ? "Listening" : "Searching for envelope";
  hiddenScanner?.reset();
  audioScanner?.reset();
  if (henvOverlay) {
    const ctx = henvOverlay.getContext("2d");
    ctx?.clearRect(0, 0, henvOverlay.width, henvOverlay.height);
  }
  resultSection.hidden = true;
  diagnosticsSection.hidden = true;
  clearDl(resultDl);
  clearDl(diagnosticsDl);
  refreshLockUi();
}

async function populateMics(): Promise<void> {
  if (!micDevice) return;
  const previous = micDevice.value;
  micDevice.replaceChildren();
  const optDefault = document.createElement("option");
  optDefault.value = "";
  optDefault.textContent = "Default";
  micDevice.appendChild(optDefault);
  try {
    const devices = await listAudioInputDevices();
    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mic ${micDevice.options.length}`;
      micDevice.appendChild(opt);
    }
    if (previous && [...micDevice.options].some((o) => o.value === previous)) {
      micDevice.value = previous;
    }
  } catch {
    /* */
  }
}

async function onStartMic(): Promise<void> {
  setCamError(null);
  if (!micStart || !micStop) return;
  micStart.disabled = true;
  henvStatus = "Listening";
  henvStatusLabel = "Listening";
  try {
    stopAllScanners();
    audioScanner = await startAudioScanner({
      deviceId: micDevice?.value || undefined,
      workerUrl: new URL("./audioDecoderWorker.js", location.href).toString(),
      workletUrl: new URL("./audioCaptureWorklet.js", location.href).toString(),
      digestTableUrl: new URL(
        "./assets/envelope/hiddenDigestTable.bin",
        location.href,
      ).toString(),
      callbacks: {
        onStatus: (s) => {
          // Keep LOCKED until Clear / new read — ignore transient decoder states.
          if (recoveredWord && acquisition.snapshot.lockedPayload) {
            henvStatus = "LOCKED";
            henvStatusLabel = "Locked";
            refreshLockUi();
            return;
          }
          henvStatus = s;
          henvStatusLabel =
            s === "LOCKED"
              ? "Locked"
              : s === "DECODING"
                ? "Decoding"
                : s === "PREAMBLE"
                  ? "Preamble"
                  : s === "LISTENING"
                    ? "Listening"
                    : s;
          refreshLockUi();
        },
        onPayload: (info) => {
          lockPayload.textContent = info.tokenHex;
          lockFormat.textContent = info.crcOk
            ? "AUDIO_SEAL_V1 (HENV1 token)"
            : "AUDIO_SEAL_V1 (CRC fail — best effort)";
          resultSection.hidden = false;
          if (!info.crcOk) {
            clearDl(resultDl);
            addRow(resultDl, "Token hex (copy)", info.tokenHex);
            addRow(resultDl, "CRC", "fail — compare with TX token=");
            addRow(resultDl, "Note", info.note);
            refreshLockUi();
            return;
          }
          // CRC-ok: latch token; word if auto-matched, else wait for lock/manual.
          acquisition.lockFromAudioSeal({
            canonicalWord: info.word ?? `TOKEN:${info.tokenHex}`,
            tokenHex: info.tokenHex,
            nowMs: performance.now(),
          });
          if (info.word) {
            recoveredWord = info.word;
            henvStatus = "LOCKED";
            henvStatusLabel = "Locked";
            clearDl(resultDl);
            addRow(resultDl, "Canonical word", info.word);
            addRow(resultDl, "Format", "AUDIO_SEAL_V1");
            addRow(resultDl, "Token hex", info.tokenHex);
            if (info.surface) addRow(resultDl, "Matched surface", info.surface);
          } else {
            recoveredWord = null;
            henvStatus = "LOCKED";
            henvStatusLabel = "Token latched (no auto word)";
            clearDl(resultDl);
            addRow(resultDl, "Token hex (copy)", info.tokenHex);
            addRow(resultDl, "CRC", "ok");
            addRow(
              resultDl,
              "Note",
              "Copy token and use Lookup in audio-lab, or compare with TX token=",
            );
          }
          refreshLockUi();
        },
        onLock: (info) => {
          const gen = acquisition.lockFromAudioSeal({
            canonicalWord: info.word,
            tokenHex: info.tokenHex,
            nowMs: performance.now(),
          });
          void gen;
          recoveredWord = info.word;
          henvStatus = "LOCKED";
          henvStatusLabel = "Locked";
          resultSection.hidden = false;
          lockPayload.textContent = info.tokenHex;
          lockFormat.textContent = "AUDIO_SEAL_V1 (HENV1 token)";
          clearDl(resultDl);
          addRow(resultDl, "Canonical word", info.word);
          addRow(resultDl, "Format", "AUDIO_SEAL_V1");
          addRow(resultDl, "Matched surface", info.surface);
          addRow(resultDl, "Token hex", info.tokenHex);
          if (info.timeToLockMs != null) {
            addRow(resultDl, "Time to lock ms", info.timeToLockMs.toFixed(0));
          }
          try {
            navigator.vibrate?.(40);
          } catch {
            /* */
          }
          refreshLockUi();
        },
        onDiagnostics: (diag: AudioDiagnostics) => {
          if (!debugMode || !henvDebugEl) return;
          const now = performance.now();
          if (now - lastDiagUiAt < 250) return;
          lastDiagUiAt = now;
          clearDl(henvDebugEl);
          addRow(henvDebugEl, "State", diag.state);
          addRow(henvDebugEl, "Input dBFS", diag.inputDbfs.toFixed(1));
          addRow(henvDebugEl, "Clipped %", diag.clippedPct.toFixed(2));
          addRow(henvDebugEl, "Sample rate", String(diag.sampleRate));
          addRow(henvDebugEl, "Resampled", diag.resampled ? "yes" : "no");
          addRow(
            henvDebugEl,
            "Preamble",
            diag.preambleScore != null ? diag.preambleScore.toFixed(3) : "—",
          );
          addRow(
            henvDebugEl,
            "Viterbi margin",
            diag.viterbiMargin != null ? diag.viterbiMargin.toFixed(2) : "—",
          );
          addRow(henvDebugEl, "CRC ok", diag.crcOk == null ? "—" : String(diag.crcOk));
          addRow(henvDebugEl, "Locks", String(diag.locks));
          addRow(henvDebugEl, "CRC failures", String(diag.crcFailures));
          addRow(henvDebugEl, "No match", String(diag.noMatch));
          addRow(henvDebugEl, "Duplicates", String(diag.duplicates));
        },
        onLevel: (dbfs) => {
          if (audioLevelEl) audioLevelEl.textContent = `Level: ${dbfs.toFixed(1)} dBFS`;
        },
        onError: (message) => setCamError(message),
      },
    });
    acquisition.beginScanning();
    micStop.disabled = false;
    await populateMics();
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === "NotAllowedError"
        ? "Microphone permission denied."
        : err instanceof Error
          ? err.message
          : "Microphone error.";
    setCamError(message);
    micStart.disabled = false;
  }
  refreshLockUi();
}

function onStopMic(): void {
  audioScanner?.stop();
  audioScanner = null;
  acquisition.stopToIdle();
  if (!acquisition.snapshot.lockedPayload) {
    acquisition.forceIdle();
  }
  if (micStart) micStart.disabled = false;
  if (micStop) micStop.disabled = true;
  henvStatus = "IDLE";
  henvStatusLabel = "Audio: idle";
  refreshLockUi();
}

async function onDeviceChange(): Promise<void> {
  if (!scanner && !hiddenScanner) return;
  // Restart stream on newly selected Continuity Camera / device.
  onStopCamera();
  await onStartCamera();
}

function cleanup(): void {
  stopAllScanners();
  abortController?.abort();
}

function onModeChange(): void {
  stopAllScanners();
  if (camStart) camStart.disabled = false;
  if (camStop) camStop.disabled = true;
  if (micStart) micStart.disabled = false;
  if (micStop) micStop.disabled = true;
  syncModeUi();
}

recoverBtn.addEventListener("click", () => {
  void onManualRecover();
});
camStart.addEventListener("click", () => {
  void onStartCamera();
});
camStop.addEventListener("click", onStopCamera);
camRefresh?.addEventListener("click", () => {
  void populateDevices();
});
camDevice.addEventListener("change", () => {
  void onDeviceChange();
});
micStart?.addEventListener("click", () => {
  void onStartMic();
});
micStop?.addEventListener("click", onStopMic);
micRefresh?.addEventListener("click", () => {
  void populateMics();
});
modeAudio?.addEventListener("change", onModeChange);
modeHidden?.addEventListener("change", onModeChange);
modeVisible?.addEventListener("change", onModeChange);
clearLockBtn.addEventListener("click", onClearLock);
window.addEventListener("pagehide", cleanup);
window.addEventListener("beforeunload", cleanup);

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void populateDevices();
    void populateMics();
  });
}

void populateDevices();
void populateMics();
syncModeUi();
refreshLockUi();
