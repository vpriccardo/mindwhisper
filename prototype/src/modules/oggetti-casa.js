/**
 * CategoryModule — Oggetti di casa (IT) v1.1
 * Lexicon + presentation + verified Reverse PA trees (Casa M·3+, Cucina F·3+).
 */

function reveal(a, b) {
  return { reveal: [a, b] };
}

export const oggettiCasa = {
  id: "oggetti-casa-it",
  title: "Oggetti di casa",
  lockScript: "Bloccalo. Non dirmelo. Solo tienilo fermo.",
  intoLeafScript: "Ora è più netto…",

  forceScripts: {
    casa: "Pensa a un oggetto in casa — qualcosa di concreto, che puoi indicare. Non un’idea astratta: una cosa.",
    cucina:
      "Pensa a un oggetto in cucina — di tutti i giorni. Non il frigo enorme come “stanza”: qualcosa che sta in cucina.",
    bagno: "Pensa a un oggetto in bagno — qualcosa che usi lì, semplice.",
  },

  traits: [
    {
      id: "genere",
      label: "Genere",
      frameScript:
        "Sto prendendo il peso della parola… mi arriva più da una cosa che si dice il che la — resto sul maschile, o sto sbagliando verso?",
      values: [
        { id: "M", label: "M", hint: "Conferma / resta sul maschile" },
        { id: "F", label: "F", hint: "Stai sbagliando / femminile" },
      ],
    },
    {
      id: "sillabe",
      label: "Sillabe",
      frameScript:
        "Adesso allineo il respiro alla parola — una pulsazione per pezzo. Ne sento due… resto su due, o è più lunga?",
      values: [
        { id: "2", label: "2", hint: "Due / ok" },
        { id: "3+", label: "3+", hint: "Più lunga" },
      ],
    },
  ],

  /** Full §4 banks (v1.1). Keys: zona|genere|sillabe */
  cells: {
    "cucina|M|2": [
      "forno",
      "piatto",
      "vetro",
      "tappo",
      "rullo",
      "torchio",
      "banco",
      "spiedo",
    ],
    "cucina|M|3+": [
      "lavello",
      "coltello",
      "cucchiaio",
      "mestolo",
      "barattolo",
      "coperchio",
      "tagliere",
      "tostapane",
      "scolapasta",
      "frigorifero",
    ],
    "cucina|F|2": [
      "tazza",
      "teglia",
      "brocca",
      "fiasca",
      "moka",
      "griglia",
      "pinza",
      "coppa",
    ],
    "cucina|F|3+": [
      "pentola",
      "padella",
      "forchetta",
      "bottiglia",
      "tovaglia",
      "ciotola",
      "caffettiera",
      "dispensa",
      "spatola",
      "scodella",
    ],
    "bagno|M|2": ["specchio", "bidet", "water", "fono", "tubo", "secchio"],
    "bagno|M|3+": [
      "lavandino",
      "dentifricio",
      "rasoio",
      "asciugamano",
      "rubinetto",
      "portasapone",
      "sapone",
      "shampoo",
      "pettine",
      "collutorio",
    ],
    "bagno|F|2": ["doccia", "vasca", "spugna", "crema", "cuffia", "carta"],
    "bagno|F|3+": [
      "spazzola",
      "saponetta",
      "salvietta",
      "lozione",
      "toilette",
      "limetta",
      "doccetta",
      "pomata",
    ],
    "casa|M|2": [
      "letto",
      "quadro",
      "libro",
      "vaso",
      "cavo",
      "muro",
      "sofà",
      "baule",
      "tetto",
      "fondo",
    ],
    "casa|M|3+": [
      "comodino",
      "tappeto",
      "cuscino",
      "armadio",
      "lampadario",
      "calorifero",
      "ventilatore",
      "aspirapolvere",
      "telecomando",
      "televisore",
    ],
    "casa|F|2": [
      "porta",
      "sedia",
      "tenda",
      "scala",
      "panca",
      "presa",
      "culla",
      "cassa",
      "radio",
      "sveglia",
    ],
    "casa|F|3+": [
      "poltrona",
      "finestra",
      "lampada",
      "libreria",
      "scrivania",
      "cornice",
      "credenza",
      "lavatrice",
      "mensola",
      "stampante",
    ],
  },

  /** Trimmed keep-lists used by verified trees (§5). */
  treeBanks: {
    "casa|M|3+": [
      "aspirapolvere",
      "lampadario",
      "armadio",
      "televisore",
      "tappeto",
      "telecomando",
      "cuscino",
      "comodino",
    ],
    "cucina|F|3+": [
      "padella",
      "scodella",
      "forchetta",
      "pentola",
      "bottiglia",
      "tovaglia",
      "ciotola",
      "spatola",
    ],
  },

  trees: {
    "casa|M|3+": {
      letter: "R",
      yes: {
        letter: "P",
        yes: {
          letter: "S",
          yes: { reveal: ["aspirapolvere"] },
          no: { reveal: ["lampadario"] },
        },
        no: {
          letter: "D",
          yes: { reveal: ["armadio"] },
          no: { reveal: ["televisore"] },
        },
      },
      no: {
        letter: "T",
        yes: {
          letter: "P",
          yes: { reveal: ["tappeto"] },
          no: { reveal: ["telecomando"] },
        },
        no: {
          letter: "U",
          yes: { reveal: ["cuscino"] },
          no: { reveal: ["comodino"] },
        },
      },
    },
    "cucina|F|3+": {
      letter: "E",
      yes: {
        letter: "D",
        yes: {
          letter: "P",
          yes: { reveal: ["padella"] },
          no: { reveal: ["scodella"] },
        },
        no: {
          letter: "F",
          yes: { reveal: ["forchetta"] },
          no: { reveal: ["pentola"] },
        },
      },
      no: {
        letter: "G",
        yes: {
          letter: "B",
          yes: { reveal: ["bottiglia"] },
          no: { reveal: ["tovaglia"] },
        },
        no: {
          letter: "C",
          yes: { reveal: ["ciotola"] },
          no: { reveal: ["spatola"] },
        },
      },
    },
  },

  outs: [
    {
      id: "soft-restart",
      title: "Soft restart",
      script: "Qualcosa di più semplice, sempre in [zona].",
    },
    {
      id: "trinity",
      title: "Trinity",
      script:
        "Nomina ad alta voce tre oggetti in quella zona → equivoque sul giusto.",
    },
    {
      id: "il-o-la",
      title: "Ultima risorsa (genere)",
      script: "Il o la? — uccide la purezza; usalo solo se sei bloccato.",
    },
  ],
};

export function cellKey(zona, genere, sillabe) {
  return `${zona}|${genere}|${sillabe}`;
}

export function getCellWords(mod, key) {
  if (mod.treeBanks[key]) return [...mod.treeBanks[key]];
  return [...(mod.cells[key] || [])];
}

export function hasTree(mod, key) {
  return Boolean(mod.trees[key]);
}

/** Infer traits for a known word (drill). */
export function traitsForWord(mod, word) {
  const w = word.toLowerCase();
  for (const [key, words] of Object.entries(mod.cells)) {
    if (words.includes(w) || (mod.treeBanks[key] || []).includes(w)) {
      const [zona, genere, sillabe] = key.split("|");
      return { zona, genere, sillabe, key };
    }
  }
  return null;
}

/** Words in a zona across all trait cells. */
export function wordsInZona(mod, zona) {
  const out = [];
  for (const [key, words] of Object.entries(mod.cells)) {
    if (!key.startsWith(`${zona}|`)) continue;
    const bank = mod.treeBanks[key] || words;
    for (const w of bank) {
      if (!out.includes(w)) out.push(w);
    }
  }
  return out;
}

/**
 * Walk a tree to find the yes/no path that reveals `word`.
 * Returns array of { letter, answer: 'yes'|'no' } or null.
 */
export function pathForWord(tree, word) {
  const target = word.toLowerCase();
  function walk(node, path) {
    if (!node) return null;
    if (node.reveal) {
      return node.reveal.map((w) => w.toLowerCase()).includes(target)
        ? path
        : null;
    }
    if (node.silentPass) {
      return node.silentPass.map((w) => w.toLowerCase()).includes(target)
        ? path
        : null;
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

export function letterInWord(word, letter) {
  return word.toLowerCase().includes(letter.toLowerCase());
}

// keep helper available for future silentPass leaves
void reveal;
