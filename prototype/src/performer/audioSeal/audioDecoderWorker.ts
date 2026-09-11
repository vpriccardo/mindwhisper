/**
 * Dedicated decoder Worker for AENV1 microphone / WAV decode.
 */

import {
  AUDIO_MANIFEST,
  PACKET_LOOP_PERIOD_S,
  SAMPLE_RATE,
} from "../../shared/audioSeal/constants";
import { HIDDEN_DICTIONARY_META } from "../../generated/hiddenDictionaryMeta";
import type { SurfaceMeta } from "../watermark/dictionaryMatcher";
import { AudioLockPolicy } from "./audioLockPolicy";
import { decodeAudioSealBuffer, PACKET_FROM_PREAMBLE } from "./decodeAudioSeal";
import { detectPreambleDetailed } from "./preambleDetector";
import { resampleToCanonical } from "./resample";
import { MonoRingBuffer } from "./ringBuffer";
import type {
  AudioDiagnostics,
  AudioScanState,
  AudioWorkerInMessage,
  AudioWorkerOutMessage,
} from "./types";

declare const self: DedicatedWorkerGlobalScope;

let digestTable: Uint8Array | null = null;
let surfaces: SurfaceMeta[] = HIDDEN_DICTIONARY_META.surfaces as SurfaceMeta[];
const ring = new MonoRingBuffer();
const lockPolicy = new AudioLockPolicy();
let state: AudioScanState = "IDLE";
let droppedChunks = 0;
let candidates = 0;
let crcFailures = 0;
let noMatch = 0;
let duplicates = 0;
let locks = 0;
let lastDiagAt = 0;
let listenStartedMs = 0;
let lastFailReason: string | null = null;
let bestPreambleScore: number | null = null;
/** Total canonical samples ever pushed (for shifting pending offsets). */
let totalPushed = 0;
let lastDecodeAttemptMs = 0;
/** Emitted one best-effort (CRC-fail) hex for manual inspection. */
let postedRawPayload = false;
/** Suppress re-decoding the same loop iteration. */
let lastAttempt: {
  offsetAtPush: number;
  pushedAt: number;
  tMs: number;
} | null = null;

let pendingPreamble: {
  offsetAtPush: number;
  pushedAt: number;
  score: number;
  sidelobeRatio: number;
  timeScale: number;
  tMs: number;
} | null = null;

const DECODE_MIN_INTERVAL_MS = 100;
const ATTEMPT_SUPPRESS_S = PACKET_LOOP_PERIOD_S * 0.95;
const ATTEMPT_OFFSET_TOL = 480; // 10 ms

function post(msg: AudioWorkerOutMessage): void {
  self.postMessage(msg);
}

function baseDiag(partial: Partial<AudioDiagnostics> = {}): AudioDiagnostics {
  return {
    state,
    inputDbfs: partial.inputDbfs ?? -90,
    clippedPct: partial.clippedPct ?? 0,
    sampleRate: partial.sampleRate ?? SAMPLE_RATE,
    resampled: partial.resampled ?? false,
    preambleScore: partial.preambleScore ?? null,
    sidelobeRatio: partial.sidelobeRatio ?? null,
    timeScale: partial.timeScale ?? null,
    viterbiMetric: partial.viterbiMetric ?? null,
    viterbiMargin: partial.viterbiMargin ?? null,
    crcOk: partial.crcOk ?? null,
    snrEstimate: partial.snrEstimate ?? null,
    decodeMs: partial.decodeMs ?? null,
    lastFailReason: partial.lastFailReason ?? lastFailReason,
    bestPreambleScore: partial.bestPreambleScore ?? bestPreambleScore,
    candidates,
    crcFailures,
    noMatch,
    duplicates,
    locks,
    droppedChunks,
    // UI used to show per-sample wrap counts; now show fill %.
    bufferOverruns: Math.round(ring.fillRatio * 100),
    ringFillPct: Math.round(ring.fillRatio * 100),
    echoCancellation: partial.echoCancellation,
    noiseSuppression: partial.noiseSuppression,
    autoGainControl: partial.autoGainControl,
    trackSettings: partial.trackSettings,
  };
}

function levelStats(samples: Float32Array): { dbfs: number; clippedPct: number } {
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
    if (a >= 0.99) clipped++;
  }
  return {
    dbfs: peak > 0 ? 20 * Math.log10(peak) : -90,
    clippedPct: (100 * clipped) / Math.max(1, samples.length),
  };
}

function setState(s: AudioScanState, force = false): void {
  if (state === s) return;
  // Latch LOCKED until explicit clear/stop (force) — do not bounce to DECODING/LISTENING.
  if (
    !force &&
    state === "LOCKED" &&
    (s === "DECODING" || s === "PREAMBLE" || s === "LISTENING")
  ) {
    return;
  }
  state = s;
  post({ type: "status", state });
}

function windowOffsetOf(absoluteAtPush: number, pushedAt: number): number | null {
  const scrolled = totalPushed - pushedAt;
  const off = absoluteAtPush - scrolled;
  if (off < 0) return null;
  return off;
}

function wasRecentlyAttempted(offsetInWindow: number, tMs: number): boolean {
  if (!lastAttempt) return false;
  if (tMs - lastAttempt.tMs > ATTEMPT_SUPPRESS_S * 1000) return false;
  const prev = windowOffsetOf(lastAttempt.offsetAtPush, lastAttempt.pushedAt);
  if (prev === null) return false;
  return Math.abs(prev - offsetInWindow) <= ATTEMPT_OFFSET_TOL;
}

function markAttempted(offsetInWindow: number, tMs: number): void {
  lastAttempt = {
    offsetAtPush: offsetInWindow,
    pushedAt: totalPushed,
    tMs,
  };
}

function tryDecode(sampleRate: number, tMs: number, force = false): void {
  if (!digestTable) return;
  if (!force && tMs - lastDecodeAttemptMs < DECODE_MIN_INTERVAL_MS) return;
  lastDecodeAttemptMs = tMs;

  try {
    const levels = levelStats(
      ring.snapshotTail(Math.min(ring.length, SAMPLE_RATE)),
    );

    // Once locked, keep the word latched; only refresh level diagnostics.
    if (lockPolicy.locked || state === "LOCKED") {
      maybeDiag(levels, sampleRate, Math.abs(sampleRate - SAMPLE_RATE) >= 0.5, {
        lastFailReason: "latched",
        bestPreambleScore,
      });
      return;
    }

    const window = ring.snapshotTail(
      Math.min(ring.length, SAMPLE_RATE * 5),
    );
    if (window.length < PACKET_FROM_PREAMBLE) {
      lastFailReason = "buffering";
      maybeDiag(levels, sampleRate, Math.abs(sampleRate - SAMPLE_RATE) >= 0.5);
      return;
    }

    const scan = detectPreambleDetailed(window, { preferLatest: true });
    if (scan.bestScore > (bestPreambleScore ?? -1)) {
      bestPreambleScore = scan.bestScore;
    }

    let hit = scan.hit;
    if (!hit && pendingPreamble) {
      const adj = windowOffsetOf(
        pendingPreamble.offsetAtPush,
        pendingPreamble.pushedAt,
      );
      if (adj !== null) {
        const need = adj + Math.ceil(PACKET_FROM_PREAMBLE * pendingPreamble.timeScale);
        if (need <= window.length) {
          hit = {
            offset: adj,
            score: pendingPreamble.score,
            sidelobeRatio: pendingPreamble.sidelobeRatio,
            timeScale: pendingPreamble.timeScale,
          };
        }
      } else {
        pendingPreamble = null;
      }
    }

    if (!hit) {
      lastFailReason = "no_preamble";
      pendingPreamble = null;
      maybeDiag(levels, sampleRate, Math.abs(sampleRate - SAMPLE_RATE) >= 0.5, {
        lastFailReason: "no_preamble",
        bestPreambleScore,
        preambleScore: bestPreambleScore,
      });
      return;
    }

    const need = hit.offset + Math.ceil(PACKET_FROM_PREAMBLE * hit.timeScale);
    if (need > window.length) {
      pendingPreamble = {
        offsetAtPush: hit.offset,
        pushedAt: totalPushed,
        score: hit.score,
        sidelobeRatio: hit.sidelobeRatio,
        timeScale: hit.timeScale,
        tMs,
      };
      lastFailReason = "incomplete_packet";
      maybeDiag(levels, sampleRate, true, {
        preambleScore: hit.score,
        sidelobeRatio: hit.sidelobeRatio,
        timeScale: hit.timeScale,
        bestPreambleScore,
        lastFailReason: "incomplete_packet",
      });
      return;
    }
    pendingPreamble = null;

    if (wasRecentlyAttempted(hit.offset, tMs)) {
      lastFailReason = "await_next_loop";
      maybeDiag(levels, sampleRate, true, {
        preambleScore: hit.score,
        sidelobeRatio: hit.sidelobeRatio,
        timeScale: hit.timeScale,
        bestPreambleScore,
        lastFailReason: "await_next_loop",
      });
      return;
    }

    candidates++;
    markAttempted(hit.offset, tMs);
    setState("DECODING");
    const result = decodeAudioSealBuffer({
      samples: window,
      surfaces,
      digestTable,
      knownHit: hit,
      preferLatest: true,
    });
    if (!result.ok) {
      lastFailReason = result.failReason;
      if (result.failReason === "crc" || result.failReason === "crc_fail") {
        crcFailures++;
      } else if (
        result.failReason === "no_dictionary_match" ||
        result.failReason === "ambiguous_match"
      ) {
        noMatch++;
      }
      const rawHex = result.rawTokenHex ?? null;
      maybeDiag(levels, sampleRate, true, {
        preambleScore: result.preambleScore ?? hit.score,
        sidelobeRatio: result.sidelobeRatio ?? hit.sidelobeRatio,
        timeScale: result.timeScale ?? hit.timeScale,
        crcOk: false,
        decodeMs: result.decodeMs,
        bestPreambleScore,
        lastFailReason: result.failReason,
        lastTokenHex: rawHex,
      });
      // Surface one best-effort hex for manual copy when CRC fails.
      if (rawHex && !postedRawPayload) {
        postedRawPayload = true;
        const diag = baseDiag({
          inputDbfs: levels.dbfs,
          clippedPct: levels.clippedPct,
          sampleRate,
          resampled: Math.abs(sampleRate - SAMPLE_RATE) >= 0.5,
          preambleScore: result.preambleScore ?? hit.score,
          crcOk: false,
          decodeMs: result.decodeMs,
          bestPreambleScore,
          lastFailReason: result.failReason,
          lastTokenHex: rawHex,
        });
        post({
          type: "payload",
          info: {
            tokenHex: rawHex,
            crcOk: false,
            word: null,
            surface: null,
            preambleScore: result.preambleScore ?? hit.score,
            timeToLockMs: listenStartedMs ? tMs - listenStartedMs : undefined,
            note: "CRC failed — hex is best-effort only; compare with TX token=",
          },
          diag,
        });
      }
      if (state !== "LOCKED") setState("LISTENING");
      return;
    }

    // CRC-valid token: latch payload for manual copy even without dictionary match.
    const word = result.match?.canonicalWord ?? null;
    const timeToLockMs = listenStartedMs ? tMs - listenStartedMs : undefined;
    locks++;
    lastFailReason = word ? null : "token_only_no_dictionary_match";
    setState("LOCKED");
    // Force lock policy so further loops stay latched.
    lockPolicy.evaluate({
      tokenHex: result.tokenHex,
      canonicalWord: word ?? result.tokenHex,
      preambleScore: Math.max(result.preambleScore, AUDIO_MANIFEST.preambleCorrThreshold),
      sidelobeRatio: Math.max(result.sidelobeRatio, AUDIO_MANIFEST.preambleSidelobeRatio),
      viterbiMargin: Math.max(result.viterbiMargin, AUDIO_MANIFEST.viterbiMarginMin),
      clipped: false,
      nowMs: tMs,
    });

    const diag = baseDiag({
      inputDbfs: levels.dbfs,
      clippedPct: levels.clippedPct,
      sampleRate,
      resampled: Math.abs(sampleRate - SAMPLE_RATE) >= 0.5,
      preambleScore: result.preambleScore,
      sidelobeRatio: result.sidelobeRatio,
      timeScale: result.timeScale,
      viterbiMetric: result.viterbiMetric,
      viterbiMargin: result.viterbiMargin,
      crcOk: true,
      snrEstimate: result.snrEstimate,
      decodeMs: result.decodeMs,
      bestPreambleScore,
      lastFailReason,
      lastTokenHex: result.tokenHex,
    });

    post({
      type: "payload",
      info: {
        tokenHex: result.tokenHex,
        crcOk: true,
        word,
        surface: result.match?.surface ?? null,
        preambleScore: result.preambleScore,
        viterbiMargin: result.viterbiMargin,
        snrEstimate: result.snrEstimate,
        timeToLockMs,
        note: word
          ? "CRC ok + dictionary match"
          : "CRC ok — copy tokenHex and look up manually (no auto dictionary match)",
      },
      diag,
    });

    if (result.match) {
      post({
        type: "lock",
        info: {
          word: result.match.canonicalWord,
          surface: result.match.surface,
          conceptId: result.match.conceptId,
          matchType: result.match.matchType,
          tokenHex: result.tokenHex,
          timeToLockMs,
          preambleScore: result.preambleScore,
          viterbiMargin: result.viterbiMargin,
          snrEstimate: result.snrEstimate,
        },
        diag,
      });
    }
  } catch (err) {
    lastFailReason = err instanceof Error ? err.message : "worker_exception";
    if (state !== "LOCKED") setState("LISTENING");
    post({
      type: "error",
      message: lastFailReason,
    });
  }
}

function maybeDiag(
  levels: { dbfs: number; clippedPct: number },
  sampleRate: number,
  resampled: boolean,
  extra: Partial<AudioDiagnostics> = {},
): void {
  const now = Date.now();
  if (now - lastDiagAt < 250) return;
  lastDiagAt = now;
  post({
    type: "diag",
    diag: baseDiag({
      inputDbfs: levels.dbfs,
      clippedPct: levels.clippedPct,
      sampleRate,
      resampled,
      ...extra,
    }),
  });
}

function resetCounters(): void {
  ring.clear();
  lockPolicy.reset();
  totalPushed = 0;
  pendingPreamble = null;
  lastAttempt = null;
  bestPreambleScore = null;
  lastFailReason = null;
  lastDecodeAttemptMs = 0;
  postedRawPayload = false;
}

self.onmessage = (ev: MessageEvent<AudioWorkerInMessage>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    digestTable = new Uint8Array(msg.digestTable);
    if (msg.surfacesJson) {
      surfaces = JSON.parse(msg.surfacesJson) as SurfaceMeta[];
    }
    resetCounters();
    candidates = 0;
    crcFailures = 0;
    noMatch = 0;
    duplicates = 0;
    locks = 0;
    droppedChunks = 0;
    setState("LISTENING", true);
    listenStartedMs = performance.now();
    post({ type: "ready" });
    return;
  }
  if (msg.type === "reset") {
    resetCounters();
    lockPolicy.clear();
    setState("LISTENING", true);
    listenStartedMs = performance.now();
    return;
  }
  if (msg.type === "stop") {
    resetCounters();
    setState("IDLE", true);
    return;
  }
  if (msg.type === "pcm") {
    if (!digestTable) return;
    const canonical =
      Math.abs(msg.sampleRate - SAMPLE_RATE) < 0.5
        ? msg.samples
        : resampleToCanonical(msg.samples, msg.sampleRate);
    ring.push(canonical);
    totalPushed += canonical.length;
    tryDecode(SAMPLE_RATE, msg.tMs);
    return;
  }
  if (msg.type === "wav") {
    if (!digestTable) {
      post({ type: "error", message: "Worker not initialized." });
      return;
    }
    resetCounters();
    const canonical =
      Math.abs(msg.sampleRate - SAMPLE_RATE) < 0.5
        ? msg.samples
        : resampleToCanonical(msg.samples, msg.sampleRate);
    ring.push(canonical);
    totalPushed += canonical.length;
    setState("DECODING");
    const result = decodeAudioSealBuffer({
      samples: canonical,
      surfaces,
      digestTable,
      allowShort: true,
    });
    const levels = levelStats(canonical);
    if (!result.ok) {
      if (result.failReason === "crc" || result.failReason === "crc_fail") {
        crcFailures++;
      } else noMatch++;
      lastFailReason = result.failReason;
      const rawHex = result.rawTokenHex ?? null;
      post({
        type: "diag",
        diag: baseDiag({
          inputDbfs: levels.dbfs,
          clippedPct: levels.clippedPct,
          sampleRate: SAMPLE_RATE,
          resampled: Math.abs(msg.sampleRate - SAMPLE_RATE) >= 0.5,
          crcOk: false,
          decodeMs: result.decodeMs,
          preambleScore: result.preambleScore ?? null,
          lastFailReason: result.failReason,
          lastTokenHex: rawHex,
        }),
      });
      if (rawHex) {
        post({
          type: "payload",
          info: {
            tokenHex: rawHex,
            crcOk: false,
            word: null,
            surface: null,
            note: "WAV decode CRC failed — best-effort hex",
          },
          diag: baseDiag({
            inputDbfs: levels.dbfs,
            crcOk: false,
            lastTokenHex: rawHex,
            lastFailReason: result.failReason,
          }),
        });
      }
      setState("LISTENING", true);
      return;
    }
    locks++;
    setState("LOCKED", true);
    const word = result.match?.canonicalWord ?? null;
    const diag = baseDiag({
      inputDbfs: levels.dbfs,
      sampleRate: SAMPLE_RATE,
      preambleScore: result.preambleScore,
      sidelobeRatio: result.sidelobeRatio,
      timeScale: result.timeScale,
      viterbiMetric: result.viterbiMetric,
      viterbiMargin: result.viterbiMargin,
      crcOk: true,
      snrEstimate: result.snrEstimate,
      decodeMs: result.decodeMs,
      lastTokenHex: result.tokenHex,
    });
    post({
      type: "payload",
      info: {
        tokenHex: result.tokenHex,
        crcOk: true,
        word,
        surface: result.match?.surface ?? null,
        preambleScore: result.preambleScore,
        viterbiMargin: result.viterbiMargin,
        snrEstimate: result.snrEstimate,
        note: word
          ? "CRC ok + dictionary match"
          : "CRC ok — token only (no dictionary match)",
      },
      diag,
    });
    if (result.match) {
      lockPolicy.evaluate({
        tokenHex: result.tokenHex,
        canonicalWord: result.match.canonicalWord,
        preambleScore: result.preambleScore,
        sidelobeRatio: result.sidelobeRatio,
        viterbiMargin: result.viterbiMargin,
        clipped: false,
        nowMs: performance.now(),
      });
      post({
        type: "lock",
        info: {
          word: result.match.canonicalWord,
          surface: result.match.surface,
          conceptId: result.match.conceptId,
          matchType: result.match.matchType,
          tokenHex: result.tokenHex,
          preambleScore: result.preambleScore,
          viterbiMargin: result.viterbiMargin,
          snrEstimate: result.snrEstimate,
        },
        diag,
      });
    }
  }
};

void droppedChunks;
