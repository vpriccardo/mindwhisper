import { buildTree, convertCraftNode, wordsInCraftRoot } from "./buildTree.js";
import { cap, normalizeWord } from "./helpers.js";

const TRAIT_META = {
  gender: {
    id: "gender",
    label: "Genere",
    prompt: "È Maschile o Femminile?",
    valueMeta: {
      M: { label: "M", hint: "Maschile" },
      F: { label: "F", hint: "Femminile" },
    },
  },
  syllables: {
    id: "syllables",
    label: "Sillabe",
    prompt: "Ha 2 o più sillabe? (parola corta o lunga?)",
    valueMeta: {
      "2": { label: "2", hint: "Corta · 2 sillabe" },
      "3+": { label: "3+", hint: "Lunga · 3+" },
    },
  },
  tipo: {
    id: "tipo",
    label: "Tipo",
    prompt: "Figura o numero?",
    valueMeta: {
      figura: { label: "Figura", hint: "Asso · Fante · Donna · Re" },
      numero: { label: "Numero", hint: "Dal 2 al 10" },
    },
  },
  banda: {
    id: "banda",
    label: "Banda",
    prompt: "Basso (2–5) o alto (6–10)?",
    valueMeta: {
      basso: { label: "Basso", hint: "2 · 3 · 4 · 5" },
      alto: { label: "Alto", hint: "6 · 7 · 8 · 9 · 10" },
    },
  },
};

const DEFAULT_OUTS = [
  {
    id: "soft-restart",
    title: "Soft restart",
    script: "Qualcosa di più semplice, sempre in [force].",
  },
  {
    id: "trinity",
    title: "Trinity",
    script: "Nomina ad alta voce tre voci in quella zona → equivoque sul giusto.",
  },
];

function zoneLabel(zone) {
  return zone
    .split("-")
    .map((p) => cap(p))
    .join(" · ");
}

function mapTrait(raw) {
  const meta = TRAIT_META[raw.id] || {
    id: raw.id,
    label: cap(raw.id),
    prompt: `${cap(raw.id)}?`,
    valueMeta: {},
  };
  return {
    id: raw.id,
    label: meta.label,
    prompt: meta.prompt,
    when: raw.when || null,
    values: raw.values.map((v) => ({
      id: v,
      label: meta.valueMeta[v]?.label || String(v),
      hint: meta.valueMeta[v]?.hint || "",
    })),
  };
}

function cellsToMap(cells) {
  const out = {};
  for (const cell of cells) {
    out[cell.id] = [...cell.words];
  }
  return out;
}

function indexLeafTrees(leafTrees) {
  const byCell = {};
  if (!leafTrees) return byCell;
  if (Array.isArray(leafTrees)) {
    for (const entry of leafTrees) {
      if (entry?.cellId && entry?.root) byCell[entry.cellId] = entry.root;
    }
  } else {
    Object.assign(byCell, leafTrees);
  }
  return byCell;
}

function indexTemplates(templates) {
  if (!templates) return {};
  return { ...templates };
}

function trimBank(words, max = 8) {
  return words.slice(0, Math.min(max, words.length));
}

function treeCoversBank(root, bank) {
  const covered = new Set(wordsInCraftRoot(root));
  return bank.every((w) => covered.has(normalizeWord(w)));
}

/**
 * Load a craft Category JSON into the runtime CategoryModule shape.
 * @param {object} raw - parsed category JSON
 * @param {{ extraLeafTrees?: object|array, trimLeaf?: number }} [opts]
 */
export function loadCategory(raw, opts = {}) {
  const trimLeaf = opts.trimLeaf ?? 8;
  const traits = (raw.traits || []).map(mapTrait);
  const cells = cellsToMap(raw.cells || []);
  const forceOptions = Object.fromEntries((raw.zones || []).map((z) => [z, zoneLabel(z)]));

  const leafByCell = {
    ...indexLeafTrees(raw.leafTrees),
    ...indexLeafTrees(opts.extraLeafTrees),
  };
  const templates = indexTemplates(raw.leafTreeTemplates);

  const treeBanks = {};
  const trees = {};

  for (const [key, words] of Object.entries(cells)) {
    let bank = null;
    let tree = null;

    // Explicit per-cell craft tree
    if (leafByCell[key]) {
      const root = leafByCell[key];
      const keep = wordsInCraftRoot(root);
      const keepInCell = keep.filter((w) =>
        words.some((x) => normalizeWord(x) === w),
      );
      // Prefer craft keep order/list when all leaves are still in the cell
      if (keepInCell.length && treeCoversBank(root, keepInCell)) {
        bank = keepInCell.map(
          (nw) => words.find((x) => normalizeWord(x) === nw) || nw,
        );
        tree = convertCraftNode(root);
      }
    }

    // Template by cell suffix (carte)
    if (!tree) {
      for (const [suffix, tpl] of Object.entries(templates)) {
        const applies = tpl.appliesToCellSuffix || `|${suffix}`;
        if (!key.endsWith(applies) && !key.endsWith(suffix)) continue;
        const root = tpl.root;
        const keep = wordsInCraftRoot(root);
        if (keep.length && treeCoversBank(root, keep)) {
          bank = keep.map((nw) => words.find((x) => normalizeWord(x) === nw) || nw);
          tree = convertCraftNode(root);
          break;
        }
      }
    }

    if (!bank) bank = trimBank(words, trimLeaf);
    if (!tree) tree = buildTree(bank, 3);

    treeBanks[key] = bank;
    trees[key] = tree;
  }

  const forceLabel =
    raw.zoneRole === "seme" ? "Seme" : "Zona";
  const forcePrompt =
    raw.zoneRole === "seme" ? "Quale seme?" : "Quale zona?";

  return {
    id: raw.id,
    title: raw.label || raw.id,
    version: raw.version || null,
    forceLabel,
    forcePrompt,
    forceOptions,
    traits,
    letterPrompt: (letter) => `Contiene la ${letter}?`,
    cells,
    treeBanks,
    trees,
    outs: raw.outs || DEFAULT_OUTS,
    revealForm: raw.namingLocks?.revealForm || null,
    zoneRole: raw.zoneRole || "zona",
  };
}
