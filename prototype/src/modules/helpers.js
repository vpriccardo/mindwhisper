/** Shared helpers for category modules. */

export function cellKey(force, ...traitValues) {
  return [force, ...traitValues].join("|");
}

export function traitApplies(trait, traitValues) {
  if (!trait?.when) return true;
  return Object.entries(trait.when).every(([k, v]) => traitValues[k] === v);
}

/** Traits that apply given current answers (skips conditional traits that don't match). */
export function applicableTraits(traits, traitValues = {}) {
  return traits.filter((t) => traitApplies(t, traitValues));
}

/** Next unanswered applicable trait, or null if cell is fully addressed. */
export function nextTrait(traits, traitValues = {}) {
  for (const t of traits) {
    if (!traitApplies(t, traitValues)) continue;
    if (traitValues[t.id] == null) return t;
  }
  return null;
}

export function traitsComplete(traits, traitValues = {}) {
  return nextTrait(traits, traitValues) === null;
}

export function cellKeyFromTraits(force, traits, traitValues) {
  if (!force) return null;
  const parts = [force];
  for (const t of traits) {
    if (!traitApplies(t, traitValues)) continue;
    if (traitValues[t.id] == null) return null;
    parts.push(traitValues[t.id]);
  }
  return parts.join("|");
}

export function getCellWords(mod, key) {
  if (mod.treeBanks?.[key]) return [...mod.treeBanks[key]];
  return [...(mod.cells[key] || [])];
}

export function hasTree(mod, key) {
  return Boolean(mod.trees?.[key]);
}

/** Infer force + traitValues for a known word (drill). */
export function traitsForWord(mod, word) {
  const w = word.toLowerCase();
  for (const [key, words] of Object.entries(mod.cells)) {
    const bank = mod.treeBanks?.[key] || words;
    if (!words.includes(w) && !bank.includes(w)) continue;

    const parts = key.split("|");
    const force = parts[0];
    const rest = parts.slice(1);
    const traitValues = {};
    let i = 0;
    for (const t of mod.traits) {
      if (!traitApplies(t, traitValues)) continue;
      traitValues[t.id] = rest[i++];
    }
    return { force, traitValues, key };
  }
  return null;
}

export function wordsInForce(mod, force) {
  const out = [];
  for (const [key, words] of Object.entries(mod.cells)) {
    if (!key.startsWith(`${force}|`)) continue;
    const bank = mod.treeBanks?.[key] || words;
    for (const w of bank) {
      if (!out.includes(w)) out.push(w);
    }
  }
  return out;
}

export function pathForWord(tree, word) {
  const target = normalizeWord(word);
  function walk(node, path) {
    if (!node) return null;
    if (node.reveal) {
      return node.reveal.map((w) => normalizeWord(w)).includes(target) ? path : null;
    }
    if (node.silentPass) {
      return node.silentPass.map((w) => normalizeWord(w)).includes(target) ? path : null;
    }
    if (node.letter) {
      const yes = walk(node.yes, [...path, { letter: node.letter, answer: "yes" }]);
      if (yes) return yes;
      return walk(node.no, [...path, { letter: node.letter, answer: "no" }]);
    }
    return null;
  }
  return walk(tree, []);
}

export function normalizeWord(word) {
  return String(word)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

export function letterInWord(word, letter) {
  return normalizeWord(word).includes(letter.toLowerCase());
}

export function wordsUnderNode(node) {
  if (!node) return [];
  if (node.reveal) return [...node.reveal];
  if (node.silentPass) return [...node.silentPass];
  return [...wordsUnderNode(node.yes), ...wordsUnderNode(node.no)];
}

export function groupWordsByCategory(modules) {
  return modules.map((mod) => ({
    id: mod.id,
    title: mod.title,
    groups: Object.entries(mod.cells).map(([key, words]) => ({
      key,
      label: labelForCellKey(mod, key),
      words,
      showTrim: mod.treeBanks?.[key] || words,
    })),
  }));
}

function labelForCellKey(mod, key) {
  const parts = key.split("|");
  const force = parts[0];
  const rest = parts.slice(1);
  const labels = [mod.forceOptions?.[force] || cap(force)];
  const traitValues = {};
  let i = 0;
  for (const t of mod.traits) {
    if (!traitApplies(t, traitValues)) continue;
    const v = rest[i++];
    if (v == null) break;
    traitValues[t.id] = v;
    const value = t.values.find((x) => x.id === v);
    labels.push(value?.label || v);
  }
  return labels.join(" · ");
}

export function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
