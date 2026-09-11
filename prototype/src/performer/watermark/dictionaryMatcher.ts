/**
 * Soft dictionary matching for HENV1 tokens.
 *
 * Retains top-32 salt hypotheses. Signs are looked up from a compact
 * Int8 typed-array table (surfaces × 256 × 56) built once per digest table.
 */

import {
  HENV_BIT_COUNT,
  HENV_DIGEST_BYTES,
  tokenToBits,
} from "../../shared/hiddenEnvelopeProtocol";

export type SurfaceMeta = {
  surface: string;
  conceptId: string;
  canonicalWord: string;
  matchType: string;
};

export type MatchCandidate = {
  surface: string;
  canonicalWord: string;
  conceptId: string;
  matchType: string;
  salt8: number;
  score: number;
  estimatedBitErrors: number;
};

export type MatchFailReason = "no_dictionary_candidate" | "ambiguous_candidate" | null;

export type MatchResult = {
  best: MatchCandidate | null;
  second: MatchCandidate | null;
  margin: number;
  saltLikelihood: number;
  saltMargin: number;
  topSalt: number | null;
  exactHardMatch: boolean;
  ambiguous: boolean;
  unique: boolean;
  failReason: MatchFailReason;
  matchMs: number;
};

const signsCache = new WeakMap();

/**
 * Precompute codeword signs: length surfaces*256*56, values ±1.
 */
export function buildCodewordSignsTable(
  surfaces: readonly SurfaceMeta[],
  digestTable: Uint8Array,
): Int8Array {
  const n = surfaces.length * 256 * HENV_BIT_COUNT;
  const signs = new Int8Array(n);
  const token = new Uint8Array(7);
  for (let si = 0; si < surfaces.length; si++) {
    for (let salt = 0; salt < 256; salt++) {
      const off = (si * 256 + salt) * HENV_DIGEST_BYTES;
      token[0] = salt;
      token.set(digestTable.subarray(off, off + HENV_DIGEST_BYTES), 1);
      const bits = tokenToBits(token);
      const base = (si * 256 + salt) * HENV_BIT_COUNT;
      for (let i = 0; i < HENV_BIT_COUNT; i++) {
        signs[base + i] = bits[i]! === 1 ? 1 : -1;
      }
    }
  }
  signsCache.set(digestTable, signs);
  return signs;
}

function getSigns(
  surfaces: readonly SurfaceMeta[],
  digestTable: Uint8Array,
): Int8Array {
  let signs = signsCache.get(digestTable);
  if (!signs || signs.length !== surfaces.length * 256 * HENV_BIT_COUNT) {
    signs = buildCodewordSignsTable(surfaces, digestTable);
  }
  return signs;
}

/**
 * @param digestTable Uint8Array length surfaces*256*6
 */
export function scoreHiddenDictionary(input: {
  soft: Float64Array;
  surfaces: readonly SurfaceMeta[];
  digestTable: Uint8Array;
  topSalts?: number;
  ambiguousMargin?: number;
}): MatchResult {
  const t0 = performance.now();
  const { soft, surfaces, digestTable } = input;
  const topSalts = input.topSalts ?? 32;
  const ambiguousMargin = input.ambiguousMargin ?? 1.0;
  if (soft.length !== HENV_BIT_COUNT) {
    throw new Error("soft length must be 56");
  }

  const signs = getSigns(surfaces, digestTable);

  // Rank salts by likelihood from first 8 soft bits (salt byte).
  const saltScores: { salt: number; score: number }[] = [];
  for (let salt = 0; salt < 256; salt++) {
    let score = 0;
    for (let bit = 0; bit < 8; bit++) {
      const expected = (salt >> (7 - bit)) & 1;
      const sign = expected === 1 ? 1 : -1;
      score += soft[bit]! * sign;
    }
    saltScores.push({ salt, score });
  }
  saltScores.sort((a, b) => b.score - a.score);
  const retained = saltScores.slice(0, topSalts);
  const saltLikelihood = retained[0]?.score ?? 0;
  const saltMargin =
    retained.length >= 2
      ? retained[0]!.score - retained[1]!.score
      : saltLikelihood;
  const topSalt = retained[0]?.salt ?? null;

  // Track best/second only — avoid sorting surfaces×salts (~40k) each frame.
  let best: MatchCandidate | null = null;
  let second: MatchCandidate | null = null;
  for (const { salt } of retained) {
    for (let si = 0; si < surfaces.length; si++) {
      const meta = surfaces[si]!;
      const base = (si * 256 + salt) * HENV_BIT_COUNT;
      let score = 0;
      let errors = 0;
      for (let i = 0; i < HENV_BIT_COUNT; i++) {
        const sign = signs[base + i]!;
        score += soft[i]! * sign;
        const hard = soft[i]! >= 0 ? 1 : 0;
        const bit = sign > 0 ? 1 : 0;
        if (hard !== bit) errors++;
      }
      const cand: MatchCandidate = {
        surface: meta.surface,
        canonicalWord: meta.canonicalWord,
        conceptId: meta.conceptId,
        matchType: meta.matchType,
        salt8: salt,
        score,
        estimatedBitErrors: errors,
      };
      if (!best || cand.score > best.score) {
        second = best;
        best = cand;
      } else if (!second || cand.score > second.score) {
        second = cand;
      }
    }
  }

  const margin = best && second ? best.score - second.score : best ? best.score : 0;
  const matchMs = performance.now() - t0;

  if (!best) {
    return {
      best: null,
      second: null,
      margin: 0,
      saltLikelihood,
      saltMargin,
      topSalt,
      exactHardMatch: false,
      ambiguous: false,
      unique: false,
      failReason: "no_dictionary_candidate",
      matchMs,
    };
  }

  let exactHardMatch = false;
  let unique = true;
  let ambiguous = false;
  let failReason: MatchFailReason = null;

  const hardBits = new Int8Array(HENV_BIT_COUNT);
  for (let i = 0; i < HENV_BIT_COUNT; i++) hardBits[i] = soft[i]! >= 0 ? 1 : 0;
  const off = surfaces.findIndex((s) => s.surface === best.surface);
  if (off >= 0) {
    const base = (off * 256 + best.salt8) * HENV_BIT_COUNT;
    exactHardMatch = true;
    for (let i = 0; i < HENV_BIT_COUNT; i++) {
      const bit = signs[base + i]! > 0 ? 1 : 0;
      if (bit !== hardBits[i]!) {
        exactHardMatch = false;
        break;
      }
    }
  }

  if (
    second &&
    second.conceptId !== best.conceptId &&
    margin < ambiguousMargin
  ) {
    ambiguous = true;
    unique = false;
    failReason = "ambiguous_candidate";
  }

  return {
    best,
    second,
    margin,
    saltLikelihood,
    saltMargin,
    topSalt,
    exactHardMatch,
    ambiguous,
    unique,
    failReason,
    matchMs,
  };
}

export function topCandidates(
  result: MatchResult,
  n: number,
): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  if (result.best) out.push(result.best);
  if (result.second) out.push(result.second);
  return out.slice(0, n);
}

export type ExactTokenMatch = {
  surface: string;
  canonicalWord: string;
  conceptId: string;
  matchType: string;
  salt8: number;
  ambiguous: boolean;
};

/**
 * Exact HENV1 token → dictionary lookup (CRC-validated path).
 * Never falls back to nearest-neighbor soft matching.
 */
export function exactLookupByToken(input: {
  token: Uint8Array;
  surfaces: readonly SurfaceMeta[];
  digestTable: Uint8Array;
}): ExactTokenMatch | null {
  if (input.token.length !== 7) {
    throw new Error("exactLookupByToken expects 7-byte HENV1 token");
  }
  const salt8 = input.token[0]!;
  const digest = input.token.subarray(1, 7);
  const hits: ExactTokenMatch[] = [];
  for (let si = 0; si < input.surfaces.length; si++) {
    const off = (si * 256 + salt8) * HENV_DIGEST_BYTES;
    let ok = true;
    for (let i = 0; i < HENV_DIGEST_BYTES; i++) {
      if (input.digestTable[off + i] !== digest[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const meta = input.surfaces[si]!;
    hits.push({
      surface: meta.surface,
      canonicalWord: meta.canonicalWord,
      conceptId: meta.conceptId,
      matchType: meta.matchType,
      salt8,
      ambiguous: false,
    });
  }
  if (hits.length === 0) return null;
  // Unique by conceptId
  const concepts = new Set(hits.map((h) => h.conceptId));
  if (concepts.size !== 1) {
    return { ...hits[0]!, ambiguous: true };
  }
  return { ...hits[0]!, ambiguous: false };
}
