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

  /** Trimmed keep-lists (≤8) used by PA trees. Full banks remain in cells. */
  treeBanks: {
    "cucina|M|2": ["forno", "piatto", "vetro", "tappo", "rullo", "torchio", "banco", "spiedo"],
    "cucina|M|3+": ["lavello", "coltello", "cucchiaio", "mestolo", "barattolo", "coperchio", "tagliere", "frigorifero"],
    "cucina|F|2": ["tazza", "teglia", "brocca", "fiasca", "moka", "griglia", "pinza", "coppa"],
    "cucina|F|3+": ["padella", "scodella", "forchetta", "pentola", "bottiglia", "tovaglia", "ciotola", "spatola"],
    "bagno|M|2": ["specchio", "bidet", "water", "fono", "tubo", "secchio"],
    "bagno|M|3+": ["lavandino", "dentifricio", "rasoio", "asciugamano", "rubinetto", "sapone", "shampoo", "pettine"],
    "bagno|F|2": ["doccia", "vasca", "spugna", "crema", "cuffia", "carta"],
    "bagno|F|3+": ["spazzola", "saponetta", "salvietta", "lozione", "toilette", "limetta", "doccetta", "pomata"],
    "casa|M|2": ["letto", "quadro", "libro", "vaso", "cavo", "muro", "sofà", "tetto"],
    "casa|M|3+": ["aspirapolvere", "lampadario", "armadio", "televisore", "tappeto", "telecomando", "cuscino", "comodino"],
    "casa|F|2": ["porta", "sedia", "tenda", "scala", "presa", "cassa", "radio", "sveglia"],
    "casa|F|3+": ["poltrona", "finestra", "lampada", "libreria", "scrivania", "cornice", "credenza", "lavatrice"]
  },

  trees: {
    "cucina|M|2": {
      letter: "R",
      yes: {
        letter: "T",
        yes: {
          letter: "V",
          yes: { reveal: ["vetro"] },
          no: { reveal: ["torchio"] }
        },
        no: {
          letter: "F",
          yes: { reveal: ["forno"] },
          no: { reveal: ["rullo"] }
        }
      },
      no: {
        letter: "I",
        yes: {
          letter: "A",
          yes: { reveal: ["piatto"] },
          no: { reveal: ["spiedo"] }
        },
        no: {
          letter: "T",
          yes: { reveal: ["tappo"] },
          no: { reveal: ["banco"] }
        }
      }
    },
    "cucina|M|3+": {
      letter: "A",
      yes: {
        letter: "E",
        yes: {
          letter: "V",
          yes: { reveal: ["lavello"] },
          no: { reveal: ["tagliere"] }
        },
        no: {
          letter: "C",
          yes: { reveal: ["cucchiaio"] },
          no: { reveal: ["barattolo"] }
        }
      },
      no: {
        letter: "C",
        yes: {
          letter: "L",
          yes: { reveal: ["coltello"] },
          no: { reveal: ["coperchio"] }
        },
        no: {
          letter: "M",
          yes: { reveal: ["mestolo"] },
          no: { reveal: ["frigorifero"] }
        }
      }
    },
    "cucina|F|2": {
      letter: "I",
      yes: {
        letter: "G",
        yes: {
          letter: "T",
          yes: { reveal: ["teglia"] },
          no: { reveal: ["griglia"] }
        },
        no: {
          letter: "F",
          yes: { reveal: ["fiasca"] },
          no: { reveal: ["pinza"] }
        }
      },
      no: {
        letter: "C",
        yes: {
          letter: "B",
          yes: { reveal: ["brocca"] },
          no: { reveal: ["coppa"] }
        },
        no: {
          letter: "T",
          yes: { reveal: ["tazza"] },
          no: { reveal: ["moka"] }
        }
      }
    },
    "cucina|F|3+": {
      letter: "E",
      yes: {
        letter: "D",
        yes: {
          letter: "P",
          yes: { reveal: ["padella"] },
          no: { reveal: ["scodella"] }
        },
        no: {
          letter: "F",
          yes: { reveal: ["forchetta"] },
          no: { reveal: ["pentola"] }
        }
      },
      no: {
        letter: "G",
        yes: {
          letter: "B",
          yes: { reveal: ["bottiglia"] },
          no: { reveal: ["tovaglia"] }
        },
        no: {
          letter: "C",
          yes: { reveal: ["ciotola"] },
          no: { reveal: ["spatola"] }
        }
      }
    },
    "bagno|M|2": {
      letter: "I",
      yes: {
        letter: "P",
        yes: { reveal: ["specchio"] },
        no: {
          letter: "B",
          yes: { reveal: ["bidet"] },
          no: { reveal: ["secchio"] }
        }
      },
      no: {
        letter: "W",
        yes: { reveal: ["water"] },
        no: {
          letter: "F",
          yes: { reveal: ["fono"] },
          no: { reveal: ["tubo"] }
        }
      }
    },
    "bagno|M|3+": {
      letter: "E",
      yes: {
        letter: "R",
        yes: {
          letter: "D",
          yes: { reveal: ["dentifricio"] },
          no: { reveal: ["rubinetto"] }
        },
        no: {
          letter: "S",
          yes: { reveal: ["sapone"] },
          no: { reveal: ["pettine"] }
        }
      },
      no: {
        letter: "N",
        yes: {
          letter: "L",
          yes: { reveal: ["lavandino"] },
          no: { reveal: ["asciugamano"] }
        },
        no: {
          letter: "R",
          yes: { reveal: ["rasoio"] },
          no: { reveal: ["shampoo"] }
        }
      }
    },
    "bagno|F|2": {
      letter: "I",
      yes: {
        letter: "D",
        yes: { reveal: ["doccia"] },
        no: { reveal: ["cuffia"] }
      },
      no: {
        letter: "S",
        yes: {
          letter: "V",
          yes: { reveal: ["vasca"] },
          no: { reveal: ["spugna"] }
        },
        no: {
          letter: "E",
          yes: { reveal: ["crema"] },
          no: { reveal: ["carta"] }
        }
      }
    },
    "bagno|F|3+": {
      letter: "I",
      yes: {
        letter: "A",
        yes: {
          letter: "S",
          yes: { reveal: ["salvietta"] },
          no: { reveal: ["limetta"] }
        },
        no: {
          letter: "Z",
          yes: { reveal: ["lozione"] },
          no: { reveal: ["toilette"] }
        }
      },
      no: {
        letter: "S",
        yes: {
          letter: "Z",
          yes: { reveal: ["spazzola"] },
          no: { reveal: ["saponetta"] }
        },
        no: {
          letter: "D",
          yes: { reveal: ["doccetta"] },
          no: { reveal: ["pomata"] }
        }
      }
    },
    "casa|M|2": {
      letter: "A",
      yes: {
        letter: "V",
        yes: {
          letter: "S",
          yes: { reveal: ["vaso"] },
          no: { reveal: ["cavo"] }
        },
        no: {
          letter: "Q",
          yes: { reveal: ["quadro"] },
          no: { reveal: ["sofà"] }
        }
      },
      no: {
        letter: "L",
        yes: {
          letter: "E",
          yes: { reveal: ["letto"] },
          no: { reveal: ["libro"] }
        },
        no: {
          letter: "M",
          yes: { reveal: ["muro"] },
          no: { reveal: ["tetto"] }
        }
      }
    },
    "casa|M|3+": {
      letter: "R",
      yes: {
        letter: "P",
        yes: {
          letter: "S",
          yes: { reveal: ["aspirapolvere"] },
          no: { reveal: ["lampadario"] }
        },
        no: {
          letter: "D",
          yes: { reveal: ["armadio"] },
          no: { reveal: ["televisore"] }
        }
      },
      no: {
        letter: "T",
        yes: {
          letter: "P",
          yes: { reveal: ["tappeto"] },
          no: { reveal: ["telecomando"] }
        },
        no: {
          letter: "U",
          yes: { reveal: ["cuscino"] },
          no: { reveal: ["comodino"] }
        }
      }
    },
    "casa|F|2": {
      letter: "E",
      yes: {
        letter: "D",
        yes: {
          letter: "S",
          yes: { reveal: ["sedia"] },
          no: { reveal: ["tenda"] }
        },
        no: {
          letter: "P",
          yes: { reveal: ["presa"] },
          no: { reveal: ["sveglia"] }
        }
      },
      no: {
        letter: "O",
        yes: {
          letter: "P",
          yes: { reveal: ["porta"] },
          no: { reveal: ["radio"] }
        },
        no: {
          letter: "L",
          yes: { reveal: ["scala"] },
          no: { reveal: ["cassa"] }
        }
      }
    },
    "casa|F|3+": {
      letter: "L",
      yes: {
        letter: "P",
        yes: {
          letter: "O",
          yes: { reveal: ["poltrona"] },
          no: { reveal: ["lampada"] }
        },
        no: {
          letter: "B",
          yes: { reveal: ["libreria"] },
          no: { reveal: ["lavatrice"] }
        }
      },
      no: {
        letter: "S",
        yes: {
          letter: "F",
          yes: { reveal: ["finestra"] },
          no: { reveal: ["scrivania"] }
        },
        no: {
          letter: "O",
          yes: { reveal: ["cornice"] },
          no: { reveal: ["credenza"] }
        }
      }
    }
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
  const target = normalizeWord(word);
  function walk(node, path) {
    if (!node) return null;
    if (node.reveal) {
      return node.reveal.map((w) => normalizeWord(w)).includes(target)
        ? path
        : null;
    }
    if (node.silentPass) {
      return node.silentPass.map((w) => normalizeWord(w)).includes(target)
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

export function normalizeWord(word) {
  return String(word)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

export function letterInWord(word, letter) {
  return normalizeWord(word).includes(letter.toLowerCase());
}

// keep helper available for future silentPass leaves
void reveal;
