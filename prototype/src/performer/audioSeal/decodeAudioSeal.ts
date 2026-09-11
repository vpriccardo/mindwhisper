/**
 * Digital / offline AENV1 decode path shared by tests and Worker.
 */

import {
  AUDIO_MANIFEST,
  PACKET_FROM_PREAMBLE,
} from "../../shared/audioSeal/constants";
import { decodeAenvPacketSoft } from "../../shared/audioSeal/packet";
import { tokenToHex } from "../../shared/hiddenEnvelopeProtocol";
import {
  exactLookupByToken,
  type ExactTokenMatch,
  type SurfaceMeta,
} from "../watermark/dictionaryMatcher";
import { detectPreamble, type PreambleHit } from "./preambleDetector";
import { softDemodulate } from "./softDemodulator";

export type AudioDecodeSuccess = {
  ok: true;
  token: Uint8Array;
  tokenHex: string;
  /** Null when CRC passed but digest is not in the local dictionary. */
  match: ExactTokenMatch | null;
  preambleScore: number;
  sidelobeRatio: number;
  timeScale: number;
  viterbiMetric: number;
  viterbiMargin: number;
  snrEstimate: number;
  decodeMs: number;
  preambleOffset: number;
};

export type AudioDecodeFailure = {
  ok: false;
  failReason: string;
  decodeMs: number;
  preambleScore?: number;
  sidelobeRatio?: number;
  timeScale?: number;
  /** Best-effort hex when Viterbi produced bytes but CRC failed. */
  rawTokenHex?: string;
};

export type AudioDecodeResult = AudioDecodeSuccess | AudioDecodeFailure;

export { PACKET_FROM_PREAMBLE };

/** Residual sync search around a preamble hit (acoustic path). */
const OFFSET_TRIES = [0, -4, 4, -8, 8, -12, 12, -16, 16, -24, 24, -32, 32] as const;

type AttemptOk = AudioDecodeSuccess;
type AttemptFail = AudioDecodeFailure & { crcCandidate?: boolean };

function tryDemodAndMatch(input: {
  samples: Float32Array;
  hit: PreambleHit;
  offsetDelta: number;
  surfaces: readonly SurfaceMeta[];
  digestTable: Uint8Array;
}): AttemptOk | AttemptFail | null {
  const offset = input.hit.offset + input.offsetDelta;
  if (offset < 0) return null;
  const demod = softDemodulate({
    samples: input.samples,
    preambleOffset: offset,
    timeScale: input.hit.timeScale,
  });
  const decoded = decodeAenvPacketSoft(demod.soft);
  if (!decoded.token || !decoded.viterbi) {
    return {
      ok: false,
      failReason: decoded.failReason ?? "decode_fail",
      decodeMs: 0,
      preambleScore: input.hit.score,
      sidelobeRatio: input.hit.sidelobeRatio,
      timeScale: input.hit.timeScale,
    };
  }

  const tokenHex = tokenToHex(decoded.token);
  if (!decoded.ok || !decoded.crcOk) {
    return {
      ok: false,
      failReason: decoded.failReason ?? "crc",
      decodeMs: 0,
      preambleScore: input.hit.score,
      sidelobeRatio: input.hit.sidelobeRatio,
      timeScale: input.hit.timeScale,
      rawTokenHex: tokenHex,
    };
  }

  if (decoded.viterbi.margin < AUDIO_MANIFEST.viterbiMarginMin) {
    // CRC ok — still treat as payload success for manual latch; margin is soft.
  }

  const match = exactLookupByToken({
    token: decoded.token,
    surfaces: input.surfaces,
    digestTable: input.digestTable,
  });
  if (match?.ambiguous) {
    return {
      ok: true,
      token: decoded.token,
      tokenHex,
      match: null,
      preambleScore: input.hit.score,
      sidelobeRatio: input.hit.sidelobeRatio,
      timeScale: input.hit.timeScale,
      viterbiMetric: decoded.viterbi.bestMetric,
      viterbiMargin: decoded.viterbi.margin,
      snrEstimate: demod.snrEstimate,
      decodeMs: 0,
      preambleOffset: offset,
    };
  }

  return {
    ok: true,
    token: decoded.token,
    tokenHex,
    match: match && !match.ambiguous ? match : null,
    preambleScore: input.hit.score,
    sidelobeRatio: input.hit.sidelobeRatio,
    timeScale: input.hit.timeScale,
    viterbiMetric: decoded.viterbi.bestMetric,
    viterbiMargin: decoded.viterbi.margin,
    snrEstimate: demod.snrEstimate,
    decodeMs: 0,
    preambleOffset: offset,
  };
}

export function decodeAudioSealBuffer(input: {
  samples: Float32Array;
  surfaces: readonly SurfaceMeta[];
  digestTable: Uint8Array;
  corrThreshold?: number;
  /** When true, skip waiting for full packet length (tests with exact buffers). */
  allowShort?: boolean;
  /** Skip re-detect when the worker already located the preamble. */
  knownHit?: PreambleHit;
  preferLatest?: boolean;
}): AudioDecodeResult {
  const t0 = performance.now();
  const hit =
    input.knownHit ??
    detectPreamble(input.samples, {
      corrThreshold: input.corrThreshold,
      preferLatest: input.preferLatest,
    });
  if (!hit) {
    return { ok: false, failReason: "no_preamble", decodeMs: performance.now() - t0 };
  }

  const need = hit.offset + Math.ceil(PACKET_FROM_PREAMBLE * hit.timeScale);
  if (!input.allowShort && need > input.samples.length) {
    return {
      ok: false,
      failReason: "incomplete_packet",
      decodeMs: performance.now() - t0,
      preambleScore: hit.score,
      sidelobeRatio: hit.sidelobeRatio,
      timeScale: hit.timeScale,
    };
  }

  let lastFail: AudioDecodeFailure = {
    ok: false,
    failReason: "decode_fail",
    decodeMs: 0,
    preambleScore: hit.score,
    sidelobeRatio: hit.sidelobeRatio,
    timeScale: hit.timeScale,
  };

  for (const delta of OFFSET_TRIES) {
    const attempt = tryDemodAndMatch({
      samples: input.samples,
      hit,
      offsetDelta: delta,
      surfaces: input.surfaces,
      digestTable: input.digestTable,
    });
    if (!attempt) continue;
    if (attempt.ok) {
      return { ...attempt, decodeMs: performance.now() - t0 };
    }
    lastFail = attempt;
  }

  return { ...lastFail, decodeMs: performance.now() - t0 };
}
