/** Shared helpers for category modules. */

export function cellKey(force, ...traitValues) {
  return [force, ...traitValues].join("|");
}

export function cellKeyFromTraits(force, traits, traitValues) {
  return cellKey(force, ...traits.map((t) => traitValues[t.id]));
}

export function getCellWords(mod, key) {
  if (mod.treeBanks?.[key]) return [...mod.treeBanks[key]];
  return [...(mod.cells[key] || [])];
}

export function hasTree(mod, key) {
  return Boolean(mod.trees?.[key]);
}

export function traitsForWord(mod, word) {
  const w = word.toLowerCase();
  for (const [key, words] of Object.entries(mod.cells)) {
    if (words.includes(w) || (mod.treeBanks?.[key] || []).includes(w)) {
      const [force, ...rest] = key.split("|");
      const traitValues = {};
      mod.traits.forEach((t, i) => {
        traitValues[t.id] = rest[i];
      });
      return { force, traitValues, key };
    }
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
    groups: Object.entries(mod.cells).map(([key, words]) => {
      const [force, ...rest] = key.split("|");
      const labels = [cap(force)];
      mod.traits.forEach((t, i) => {
        const v = rest[i];
        const value = t.values.find((x) => x.id === v);
        labels.push(value?.label || v);
      });
      return {
        key,
        label: labels.join(" · "),
        words: mod.treeBanks?.[key] || words,
      };
    }),
  }));
}

export function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
