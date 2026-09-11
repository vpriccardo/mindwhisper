import { normalizeWord } from "../protocol";
import {
  createHiddenToken,
  tokenToHex,
  type HiddenToken,
} from "../../shared/hiddenEnvelopeProtocol";
import { SAMPLE_RATE, TOTAL_SAMPLES } from "../../shared/audioSeal/constants";
import { encodeAenvPacket } from "../../shared/audioSeal/packet";
import { renderAudioSeal } from "../audioSeal/renderAudioSeal";
import {
  float32ToWavBlob,
  playFloat32Mono,
  stopPlayback,
  unlockAudioContext,
} from "../audioSeal/playback";
import { decodeAudioSealBuffer } from "../../performer/audioSeal/decodeAudioSeal";
import { HIDDEN_DICTIONARY_META } from "../../generated/hiddenDictionaryMeta";

const wordEl = document.getElementById("word") as HTMLInputElement;
const normEl = document.getElementById("norm") as HTMLElement;
const saltEl = document.getElementById("salt") as HTMLInputElement;
const wmdbEl = document.getElementById("wmdb") as HTMLSelectElement;
const diagEl = document.getElementById("diag") as HTMLElement;
const loopOut = document.getElementById("loop-out") as HTMLElement;
const wave = document.getElementById("wave") as HTMLCanvasElement;
const spec = document.getElementById("spec") as HTMLCanvasElement;

let token: HiddenToken | null = null;
let lastMix: Float32Array | null = null;
let lastCover: Float32Array | null = null;
let lastWm: Float32Array | null = null;
let digestTable: Uint8Array | null = null;

async function loadDigest(): Promise<Uint8Array> {
  if (digestTable) return digestTable;
  const res = await fetch("../assets/envelope/hiddenDigestTable.bin", {
    cache: "no-store",
  });
  digestTable = new Uint8Array(await res.arrayBuffer());
  return digestTable;
}

function updateNorm(): void {
  normEl.textContent = normalizeWord(wordEl.value) || "—";
}

function drawWave(samples: Float32Array): void {
  const ctx = wave.getContext("2d")!;
  const w = wave.width;
  const h = wave.height;
  ctx.fillStyle = "#0d0f11";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#8fb896";
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / w));
  for (let x = 0; x < w; x++) {
    const i = x * step;
    const y = h / 2 - samples[i]! * (h * 0.45);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawSpecStub(samples: Float32Array): void {
  // Lightweight magnitude strip (not a full spectrogram) for lab orientation.
  const ctx = spec.getContext("2d")!;
  const w = spec.width;
  const h = spec.height;
  ctx.fillStyle = "#0d0f11";
  ctx.fillRect(0, 0, w, h);
  const cols = w;
  const win = Math.floor(samples.length / cols);
  for (let x = 0; x < cols; x++) {
    let e = 0;
    const off = x * win;
    for (let i = 0; i < win; i++) {
      const v = samples[off + i] ?? 0;
      e += v * v;
    }
    const rms = Math.sqrt(e / Math.max(1, win));
    const bar = Math.min(h, Math.round(rms * h * 8));
    ctx.fillStyle = `rgb(${40 + bar}, ${80 + bar}, 70)`;
    ctx.fillRect(x, h - bar, 1, bar);
  }
}

function showDiag(lines: string[]): void {
  diagEl.textContent = lines.join("\n");
}

async function generateAndPlay(play: "loop" | "once" | false = "loop"): Promise<void> {
  unlockAudioContext();
  const normalized = normalizeWord(wordEl.value);
  if (!normalized) {
    showDiag(["Enter a word."]);
    return;
  }
  const saltRaw = saltEl.value.trim();
  const salt =
    saltRaw === "" ? undefined : Math.max(0, Math.min(255, Number(saltRaw)));
  token = await createHiddenToken(normalized, salt);
  const watermarkDb = Number(wmdbEl.value);
  const rendered = await renderAudioSeal({
    token: token.token,
    watermarkDb,
    cover: salt !== undefined ? { seed: 0x5eed0000 ^ salt } : undefined,
  });
  lastMix = rendered.mixed;
  lastCover = rendered.cover;
  lastWm = rendered.watermarkOnly;
  const enc = encodeAenvPacket(token.token);
  showDiag([
    `token=${rendered.tokenHex}`,
    `crc=0x${rendered.crc.toString(16).padStart(4, "0")}`,
    `fecBits=${enc.codedBits.length}`,
    `sampleRate=${SAMPLE_RATE}`,
    `durationSamples=${TOTAL_SAMPLES}`,
    `loopPeriodS=2.1 (preamble sync each cycle)`,
    `coverSeed=${rendered.coverSeed}`,
    `watermarkDb=${rendered.diagnostics.watermarkDb}`,
    `coverRms=${rendered.diagnostics.coverRms.toFixed(5)}`,
    `wmRms=${rendered.diagnostics.watermarkRms.toFixed(5)}`,
    `ratioDb=${rendered.diagnostics.globalRatioDb.toFixed(2)}`,
    `peakDbfs=${rendered.diagnostics.peakDbfs.toFixed(2)}`,
    `renderMs=${rendered.diagnostics.renderMs.toFixed(1)}`,
  ]);
  drawWave(rendered.mixed);
  drawSpecStub(rendered.mixed);
  if (play === "loop") {
    await playFloat32Mono(rendered.mixed, { restart: true, loop: true });
  } else if (play === "once") {
    await playFloat32Mono(rendered.mixed, { restart: true, loop: false });
  }
}

function download(samples: Float32Array | null, name: string): void {
  if (!samples) return;
  const blob = float32ToWavBlob(samples);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

wordEl.addEventListener("input", updateNorm);
document.getElementById("generate")!.addEventListener("click", () => {
  void generateAndPlay("loop");
});
document.getElementById("play-once")!.addEventListener("click", () => {
  void (async () => {
    if (!lastMix) await generateAndPlay(false);
    if (lastMix) await playFloat32Mono(lastMix, { restart: true, loop: false });
  })();
});
document.getElementById("repeat")!.addEventListener("click", () => {
  void (async () => {
    if (!token) {
      await generateAndPlay("loop");
      return;
    }
    unlockAudioContext();
    const watermarkDb = Number(wmdbEl.value);
    const rendered = await renderAudioSeal({
      token: token.token,
      watermarkDb,
    });
    lastMix = rendered.mixed;
    lastCover = rendered.cover;
    lastWm = rendered.watermarkOnly;
    showDiag([
      `token=${rendered.tokenHex} (unchanged)`,
      `coverSeed=${rendered.coverSeed} (fresh)`,
      `watermarkDb=${rendered.diagnostics.watermarkDb}`,
      `loop=true (preamble sync each 2.1s cycle)`,
      `renderMs=${rendered.diagnostics.renderMs.toFixed(1)}`,
    ]);
    drawWave(rendered.mixed);
    await playFloat32Mono(rendered.mixed, { restart: true, loop: true });
  })();
});
document.getElementById("stop")!.addEventListener("click", () => stopPlayback());
document.getElementById("cover")!.addEventListener("click", () => {
  void (async () => {
    if (!lastCover) await generateAndPlay(false);
    if (lastCover) await playFloat32Mono(lastCover, { restart: true, loop: false });
  })();
});
document.getElementById("encoded")!.addEventListener("click", () => {
  void (async () => {
    if (!lastMix) await generateAndPlay(false);
    if (lastMix) await playFloat32Mono(lastMix, { restart: true, loop: true });
  })();
});
document.getElementById("loopback")!.addEventListener("click", () => {
  void (async () => {
    if (!lastMix || !token) await generateAndPlay(false);
    const table = await loadDigest();
    const result = decodeAudioSealBuffer({
      samples: lastMix!,
      surfaces: HIDDEN_DICTIONARY_META.surfaces,
      digestTable: table,
      allowShort: true,
    });
    loopOut.textContent = result.ok
      ? `LOOPBACK OK word=${result.match.canonicalWord} token=${result.tokenHex} decodeMs=${result.decodeMs.toFixed(1)}`
      : `LOOPBACK FAIL ${result.failReason}`;
  })();
});
document.getElementById("dl-mix")!.addEventListener("click", () =>
  download(lastMix, "aenv1-mixed.wav"),
);
document.getElementById("dl-cover")!.addEventListener("click", () =>
  download(lastCover, "aenv1-cover.wav"),
);
document.getElementById("dl-wm")!.addEventListener("click", () =>
  download(lastWm, "aenv1-watermark.wav"),
);

updateNorm();
void tokenToHex;
