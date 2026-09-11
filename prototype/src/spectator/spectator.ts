import { createSeal, ensureWebCrypto, normalizeWord } from "./protocol";
import { renderStandardQr } from "./transports/standardQr";
import { renderWaxSeal } from "./transports/waxSeal";
import { renderPostalMark } from "./transports/postalMark";
import {
  getCachedCleanForDebug,
  renderHiddenEnvelope,
} from "./transports/hiddenEnvelope";
import { embedHiddenWatermark } from "./watermark/embed";
import { ENVELOPE_MANIFEST } from "../generated/envelopeManifest";
import { srgbToYCbCr } from "../shared/ycbcr";
import type { TransportId } from "./transports/types";
import {
  createHiddenToken,
  tokenToHex,
  type HiddenToken,
} from "../shared/hiddenEnvelopeProtocol";
import { renderAudioSeal } from "./audioSeal/renderAudioSeal";
import {
  playFloat32Mono,
  releaseAudioResources,
  stopPlayback,
  unlockAudioContext,
} from "./audioSeal/playback";

/** Sealed-session state kept only in module memory (never storage/DOM attrs). */
let sealedNormalized: string | null = null;
let sealedPayload: string | null = null;
let sealedHiddenToken: HiddenToken | null = null;
let sealedObjectUrl: string | null = null;
let currentTransport: TransportId = "hidden";
let audioHintShown = false;

const wordInput = document.getElementById("word-input") as HTMLInputElement;
const normPreview = document.getElementById("norm-preview") as HTMLElement;
const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
const composeError = document.getElementById("compose-error") as HTMLElement;
const composeForm = document.getElementById("compose-form") as HTMLElement;
const sealedSection = document.getElementById("sealed") as HTMLElement;
const payloadField = document.getElementById("payload-field") as HTMLTextAreaElement;
const transportHost = document.getElementById("transport-host") as HTMLElement;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
const revealBtn = document.getElementById("reveal-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const revealOut = document.getElementById("reveal-out") as HTMLElement;
const copyStatus = document.getElementById("copy-status") as HTMLElement;
const sealedError = document.getElementById("sealed-error") as HTMLElement;
const netStatus = document.getElementById("net-status") as HTMLElement;
const debugPanel = document.getElementById("henv-debug") as HTMLElement | null;
const repeatSealBtn = document.getElementById("repeat-seal-btn") as HTMLButtonElement | null;
const stopSealBtn = document.getElementById("stop-seal-btn") as HTMLButtonElement | null;
const audioHint = document.getElementById("audio-hint") as HTMLElement | null;

const debugMode = new URLSearchParams(location.search).get("debug") === "1";
const strongSignalMode =
  debugMode &&
  new URLSearchParams(location.search).get("henvSignal") === "strong";
/** Development-only multiplier — never production-safe. */
const STRONG_SIGNAL_FACTOR = 3.0;
const baseUrl = new URL("./", location.href).toString();

function effectiveAlpha(): number {
  return strongSignalMode
    ? ENVELOPE_MANIFEST.alpha * STRONG_SIGNAL_FACTOR
    : ENVELOPE_MANIFEST.alpha;
}

function sealedHiddenHex(): string | null {
  return sealedHiddenToken ? tokenToHex(sealedHiddenToken.token) : null;
}

function setError(el: HTMLElement, message: string | null): void {
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function updatePreview(): void {
  const norm = normalizeWord(wordInput.value);
  normPreview.textContent = norm || "—";
}

function updateNetStatus(): void {
  const online = navigator.onLine;
  netStatus.textContent = online
    ? "Browser: online (reported status)"
    : "Browser: offline (reported status)";
}

function selectedTransport(): TransportId {
  const checked = document.querySelector(
    'input[name="transport"]:checked',
  ) as HTMLInputElement | null;
  const value = checked?.value;
  if (value === "wax" || value === "postal" || value === "qr" || value === "hidden") {
    return value;
  }
  return "hidden";
}

function revokeObjectUrl(): void {
  if (sealedObjectUrl) {
    URL.revokeObjectURL(sealedObjectUrl);
    sealedObjectUrl = null;
  }
}

function zeroToken(token: HiddenToken | null): void {
  if (!token) return;
  token.token.fill(0);
  token.digest6.fill(0);
  token.salt8 = 0;
  token.normalizedWord = "";
}

async function playSealSound(options?: { freshCover?: boolean }): Promise<void> {
  if (!sealedHiddenToken) return;
  try {
    // Same HENV1 token every play; optional fresh cover seed on explicit restart.
    const rendered = await renderAudioSeal({
      token: sealedHiddenToken.token,
      cover: options?.freshCover ? {} : undefined,
    });
    // Loop continuously: each cycle starts with the AENV1 double-chirp preamble
    // so the receiver can sync without relying on a single missed play.
    await playFloat32Mono(rendered.mixed, { restart: true, loop: true });
    if (audioHint) {
      audioHint.hidden = true;
      audioHint.textContent = "";
    }
    audioHintShown = false;
  } catch {
    if (audioHint && !audioHintShown) {
      audioHint.hidden = false;
      audioHint.textContent = "Tap the seal to close the envelope.";
      audioHintShown = true;
    }
  }
}

async function renderTransport(
  payload: string,
  transport: TransportId,
): Promise<void> {
  transportHost.replaceChildren();
  revokeObjectUrl();

  if (transport === "hidden") {
    if (!sealedHiddenToken) throw new Error("No sealed HENV1 token.");
    const result = await renderHiddenEnvelope(
      transportHost,
      sealedHiddenToken,
      baseUrl,
      { alphaOverride: effectiveAlpha() },
    );
    sealedObjectUrl = result.objectUrl;
    payloadField.value = sealedHiddenHex() ?? "";
    if (debugMode) {
      await renderDebugView(
        sealedHiddenHex()!,
        result.encodeMs,
        result.clippedPercent,
      );
    }
    // Natural repeat: tap the envelope image
    const img = transportHost.querySelector("img");
    img?.addEventListener("click", () => {
      void playSealSound();
    });
    return;
  }

  if (debugPanel) debugPanel.hidden = true;

  // Visible diagnostics transports use Protocol v1 payload.
  payloadField.value = payload;
  if (transport === "qr") {
    transportHost.className = "transport-host transport-qr";
    const canvas = document.createElement("canvas");
    canvas.className = "qr-canvas";
    canvas.setAttribute("aria-label", "Seal QR");
    transportHost.appendChild(canvas);
    await renderStandardQr(canvas, payload, 320);
    return;
  }
  if (transport === "wax") {
    renderWaxSeal(transportHost, payload);
    return;
  }
  renderPostalMark(transportHost, payload);
}

async function renderDebugView(
  tokenHex: string,
  encodeMs: number,
  clippedPercent: number,
): Promise<void> {
  if (!debugPanel) return;
  const cached = getCachedCleanForDebug();
  if (!cached || !sealedNormalized || !sealedHiddenToken) return;
  debugPanel.hidden = false;
  debugPanel.replaceChildren();

  const token = sealedHiddenToken.token;
  const embedded = embedHiddenWatermark({
    rgba: cached.rgba,
    width: cached.width,
    height: cached.height,
    token,
    alpha: effectiveAlpha(),
    mask: cached.mask,
    basisFields: cached.basisFields,
  });

  const mkImg = (rgba: Uint8ClampedArray, w: number, h: number, label: string) => {
    const c = document.createElement("canvas");
    c.width = Math.min(320, w);
    c.height = Math.round((c.width * h) / w);
    const ctx = c.getContext("2d")!;
    const full = document.createElement("canvas");
    full.width = w;
    full.height = h;
    full.getContext("2d")!.putImageData(new ImageData(rgba, w, h), 0, 0);
    ctx.drawImage(full, 0, 0, c.width, c.height);
    const wrap = document.createElement("figure");
    const cap = document.createElement("figcaption");
    cap.textContent = label;
    wrap.appendChild(c);
    wrap.appendChild(cap);
    return wrap;
  };

  // 20× chroma difference
  const diff = new Uint8ClampedArray(cached.rgba.length);
  for (let p = 0; p < cached.width * cached.height; p++) {
    const o = p * 4;
    const c0 = srgbToYCbCr(cached.rgba[o]!, cached.rgba[o + 1]!, cached.rgba[o + 2]!);
    const c1 = srgbToYCbCr(embedded.rgba[o]!, embedded.rgba[o + 1]!, embedded.rgba[o + 2]!);
    const d = Math.max(-128, Math.min(127, 20 * ((c1.cb - c0.cb) - (c1.cr - c0.cr)) / 2));
    const v = Math.round(128 + d);
    diff[o] = v;
    diff[o + 1] = v;
    diff[o + 2] = v;
    diff[o + 3] = 255;
  }

  debugPanel.appendChild(mkImg(cached.rgba, cached.width, cached.height, "Clean"));
  debugPanel.appendChild(mkImg(embedded.rgba, embedded.width, embedded.height, "Encoded"));
  debugPanel.appendChild(mkImg(diff, cached.width, cached.height, "20× chroma diff"));
  const stats = document.createElement("pre");
  const lines = [
    `alpha=${effectiveAlpha()}${ENVELOPE_MANIFEST.alphaProvisional ? " (provisional base)" : ""}`,
    `manifestAlpha=${ENVELOPE_MANIFEST.alpha}`,
    `token=${tokenHex}`,
    `clipped%=${clippedPercent.toFixed(3)}`,
    `encodeMs=${encodeMs.toFixed(1)}`,
    `salt=${token[0]}`,
  ];
  if (strongSignalMode) {
    lines.unshift(
      "STRONG SIGNAL — not an invisibility test",
      `henvSignal=strong ×${STRONG_SIGNAL_FACTOR} (development only)`,
    );
  }
  stats.textContent = lines.join("\n");
  if (strongSignalMode) {
    stats.style.color = "#c45c26";
    stats.style.fontWeight = "600";
  }
  debugPanel.appendChild(stats);
}

async function onGenerate(): Promise<void> {
  setError(composeError, null);
  copyStatus.textContent = "";
  setError(sealedError, null);
  revealOut.hidden = true;
  revealOut.textContent = "";

  // Unlock AudioContext synchronously on the click gesture BEFORE awaits.
  try {
    unlockAudioContext();
  } catch {
    /* audio optional */
  }

  try {
    ensureWebCrypto();
  } catch (err) {
    setError(composeError, err instanceof Error ? err.message : String(err));
    return;
  }

  const normalized = normalizeWord(wordInput.value);
  if (!normalized) {
    setError(composeError, "Enter a word with at least one letter A–Z.");
    return;
  }

  generateBtn.disabled = true;
  try {
    const { payload } = await createSeal(normalized);
    // One HENV1 token per sealed session — shared by image and audio.
    zeroToken(sealedHiddenToken);
    sealedHiddenToken = await createHiddenToken(normalized);
    sealedNormalized = normalized;
    sealedPayload = payload;
    currentTransport = selectedTransport();

    payloadField.value = payload;
    await renderTransport(payload, currentTransport);
    // Play closure/stamp sound with the same token (non-blocking for visual).
    void playSealSound();

    wordInput.value = "";
    wordInput.disabled = true;
    normPreview.textContent = "—";
    composeForm.hidden = true;
    sealedSection.hidden = false;
  } catch (err) {
    setError(composeError, err instanceof Error ? err.message : String(err));
  } finally {
    generateBtn.disabled = false;
  }
}

async function onTransportChange(): Promise<void> {
  if (!sealedPayload || !sealedNormalized || !sealedHiddenToken) return;
  const next = selectedTransport();
  currentTransport = next;
  setError(sealedError, null);
  try {
    // Re-render only — reuse the same HENV1 token and Protocol v1 payload.
    await renderTransport(sealedPayload, next);
  } catch (err) {
    setError(sealedError, err instanceof Error ? err.message : String(err));
  }
}

async function onCopy(): Promise<void> {
  const text =
    currentTransport === "hidden" ? sealedHiddenHex() : sealedPayload;
  if (!text) return;
  copyStatus.textContent = "";
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      copyStatus.textContent = "Copied.";
      return;
    }
  } catch {
    // fall through
  }
  payloadField.focus();
  payloadField.select();
  copyStatus.textContent = "Select and copy manually (Ctrl/Cmd+C).";
}

function onReveal(): void {
  if (!sealedNormalized) return;
  revealOut.hidden = false;
  revealOut.textContent = sealedNormalized;
}

function onReset(): void {
  stopPlayback();
  releaseAudioResources();
  zeroToken(sealedHiddenToken);
  sealedHiddenToken = null;
  sealedNormalized = null;
  sealedPayload = null;
  revokeObjectUrl();
  wordInput.value = "";
  wordInput.disabled = false;
  updatePreview();
  payloadField.value = "";
  transportHost.replaceChildren();
  sealedSection.hidden = true;
  composeForm.hidden = false;
  revealOut.hidden = true;
  revealOut.textContent = "";
  copyStatus.textContent = "";
  setError(composeError, null);
  setError(sealedError, null);
  if (audioHint) {
    audioHint.hidden = true;
    audioHint.textContent = "";
  }
  audioHintShown = false;
  if (debugPanel) {
    debugPanel.hidden = true;
    debugPanel.replaceChildren();
  }
  wordInput.focus();
}

wordInput.addEventListener("input", updatePreview);
generateBtn.addEventListener("click", () => {
  void onGenerate();
});
copyBtn.addEventListener("click", () => {
  void onCopy();
});
revealBtn.addEventListener("click", onReveal);
resetBtn.addEventListener("click", onReset);
repeatSealBtn?.addEventListener("click", () => {
  // Restart the looping packet (same token, fresh cover texture).
  void playSealSound({ freshCover: true });
});
stopSealBtn?.addEventListener("click", () => {
  stopPlayback();
});
for (const input of document.querySelectorAll('input[name="transport"]')) {
  input.addEventListener("change", () => {
    void onTransportChange();
  });
}
window.addEventListener("online", updateNetStatus);
window.addEventListener("offline", updateNetStatus);

updatePreview();
updateNetStatus();
