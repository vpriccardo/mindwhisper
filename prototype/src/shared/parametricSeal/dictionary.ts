/**
 * PENV1 dictionary index: unique concepts, aliases share the canonical index.
 */

import { HIDDEN_DICTIONARY_META } from "../../generated/hiddenDictionaryMeta";
import { INDEX_MAX } from "./constants";

export type ParametricEntry = {
  index: number;
  conceptId: string;
  canonicalWord: string;
};

const byConcept = new Map<string, ParametricEntry>();
const surfaceToIndex = new Map<string, number>();
const byIndex: ParametricEntry[] = [];

(function build() {
  const concepts: { conceptId: string; canonicalWord: string }[] = [];
  const seen = new Set<string>();
  for (const s of HIDDEN_DICTIONARY_META.surfaces) {
    if (seen.has(s.conceptId)) continue;
    seen.add(s.conceptId);
    concepts.push({ conceptId: s.conceptId, canonicalWord: s.canonicalWord });
  }
  concepts.sort((a, b) =>
    a.canonicalWord < b.canonicalWord
      ? -1
      : a.canonicalWord > b.canonicalWord
        ? 1
        : 0,
  );
  if (concepts.length >= INDEX_MAX) {
    throw new Error("PENV1 dictionary exceeds 11-bit index space.");
  }
  for (let i = 0; i < concepts.length; i++) {
    const e: ParametricEntry = {
      index: i,
      conceptId: concepts[i]!.conceptId,
      canonicalWord: concepts[i]!.canonicalWord,
    };
    byIndex.push(e);
    byConcept.set(e.conceptId, e);
  }
  for (const s of HIDDEN_DICTIONARY_META.surfaces) {
    const e = byConcept.get(s.conceptId);
    if (e) surfaceToIndex.set(s.surface, e.index);
  }
})();

export const PARAMETRIC_WORD_COUNT = byIndex.length;

export function indexForSurface(normalized: string): number | null {
  const idx = surfaceToIndex.get(normalized);
  return idx === undefined ? null : idx;
}

export function entryAtIndex(index: number): ParametricEntry | null {
  return byIndex[index] ?? null;
}

export function entryForSurface(normalized: string): ParametricEntry | null {
  const idx = indexForSurface(normalized);
  if (idx === null) return null;
  return entryAtIndex(idx);
}
