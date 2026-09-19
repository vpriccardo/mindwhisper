import { letterInWord, normalizeWord } from "./helpers.js";

const LETTERS = "ABCDEFGHILMNOPQRSTUVZ".split("");

/**
 * Factory Reverse PA tree: depth ≤ maxDepth, unique single-word reveals when possible.
 * Prefers splits with a smaller yes-side (RPA “mostly NO” feel).
 */
export function buildTree(words, maxDepth = 3) {
  const unique = [...new Set(words.map((w) => w.toLowerCase()))];
  return build(unique, maxDepth);
}

function build(words, depthLeft) {
  if (words.length === 0) return { reveal: [] };
  if (words.length === 1) return { reveal: [words[0]] };

  if (depthLeft <= 0) {
    return words.length <= 2
      ? { reveal: [...words] }
      : { reveal: [...words], pending: true };
  }

  const split = bestSplit(words);
  if (!split) {
    return words.length <= 2
      ? { reveal: [...words] }
      : { reveal: [...words], pending: true };
  }

  return {
    letter: split.letter,
    yes: build(split.yes, depthLeft - 1),
    no: build(split.no, depthLeft - 1),
  };
}

function bestSplit(words) {
  let best = null;
  for (const letter of LETTERS) {
    const yes = [];
    const no = [];
    for (const w of words) {
      if (letterInWord(w, letter)) yes.push(w);
      else no.push(w);
    }
    if (!yes.length || !no.length) continue;
    // Prefer smaller yes-side, then balanced partitions, then fewer total imbalance.
    const score =
      yes.length * 1000 +
      Math.abs(yes.length - no.length) * 10 +
      Math.max(yes.length, no.length);
    if (!best || score < best.score) {
      best = { letter, yes, no, score };
    }
  }
  return best;
}

/** Convert craft JSON tree node ({ ask, yes, no } | { word }) → runtime PA node. */
export function convertCraftNode(node) {
  if (!node) return null;
  if (node.word) return { reveal: [node.word] };
  if (node.reveal) return { reveal: [...node.reveal] };
  if (node.silentPass) return { silentPass: [...node.silentPass] };
  if (node.ask) {
    const letter = String(node.ask).replace(/\?/g, "").trim().toUpperCase();
    return {
      letter,
      yes: convertCraftNode(node.yes),
      no: convertCraftNode(node.no),
    };
  }
  if (node.letter) {
    return {
      letter: node.letter,
      yes: convertCraftNode(node.yes),
      no: convertCraftNode(node.no),
    };
  }
  return null;
}

/** Words that appear under a craft/runtime tree (for validating keep-lists). */
export function wordsInCraftRoot(root) {
  const node = root?.ask || root?.letter || root?.word ? root : root;
  const converted = convertCraftNode(node);
  const out = [];
  function walk(n) {
    if (!n) return;
    if (n.reveal) out.push(...n.reveal);
    if (n.silentPass) out.push(...n.silentPass);
    walk(n.yes);
    walk(n.no);
  }
  walk(converted);
  return out.map(normalizeWord);
}
