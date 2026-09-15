/**
 * CategoryModule — Carte da gioco (IT)
 * Semi francesi · figure / numeri · Reverse PA on Italian value names.
 */

export const carteGioco = {
  id: "carte-gioco-it",
  title: "Carte da gioco",
  forceLabel: "Seme",
  forcePrompt: "Quale seme?",
  forceOptions: {
    cuori: "Cuori",
    quadri: "Quadri",
    fiori: "Fiori",
    picche: "Picche",
  },

  traits: [
    {
      id: "tipo",
      label: "Tipo",
      prompt: "Figura o numero?",
      values: [
        { id: "figura", label: "Figura", hint: "Asso · Fante · Donna · Re" },
        { id: "numero", label: "Numero", hint: "Dal 2 al 10" },
      ],
    },
  ],

  letterPrompt: (letter) => `Contiene la ${letter}?`,

  cells: {
    "cuori|figura": ["asso", "fante", "donna", "re"],
    "cuori|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci"],
    "quadri|figura": ["asso", "fante", "donna", "re"],
    "quadri|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci"],
    "fiori|figura": ["asso", "fante", "donna", "re"],
    "fiori|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci"],
    "picche|figura": ["asso", "fante", "donna", "re"],
    "picche|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci"],
  },

  treeBanks: {
    "cuori|figura": ["asso", "fante", "donna", "re"],
    "cuori|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove"],
    "quadri|figura": ["asso", "fante", "donna", "re"],
    "quadri|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove"],
    "fiori|figura": ["asso", "fante", "donna", "re"],
    "fiori|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove"],
    "picche|figura": ["asso", "fante", "donna", "re"],
    "picche|numero": ["due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove"],
  },

  trees: {
    "cuori|figura": figuraTree(),
    "quadri|figura": figuraTree(),
    "fiori|figura": figuraTree(),
    "picche|figura": figuraTree(),
    "cuori|numero": numeroTree(),
    "quadri|numero": numeroTree(),
    "fiori|numero": numeroTree(),
    "picche|numero": numeroTree(),
  },

  outs: [
    {
      id: "soft-restart",
      title: "Soft restart",
      script: "Una carta più semplice, stesso seme ([force]).",
    },
    {
      id: "trinity",
      title: "Trinity",
      script: "Nomina tre carte di quel seme → equivoque sulla giusta.",
    },
    {
      id: "colore",
      title: "Colore",
      script: "Rosso o nero? — solo se sei bloccato sul seme.",
    },
  ],
};

function figuraTree() {
  return {
    letter: "F",
    yes: { reveal: ["fante"] },
    no: {
      letter: "S",
      yes: { reveal: ["asso"] },
      no: {
        letter: "D",
        yes: { reveal: ["donna"] },
        no: { reveal: ["re"] },
      },
    },
  };
}

function numeroTree() {
  return {
    letter: "T",
    yes: {
      letter: "R",
      yes: {
        letter: "E",
        yes: { reveal: ["tre"] },
        no: { reveal: ["quattro"] },
      },
      no: {
        letter: "S",
        yes: { reveal: ["sette"] },
        no: { reveal: ["otto"] },
      },
    },
    no: {
      letter: "U",
      yes: {
        letter: "D",
        yes: { reveal: ["due"] },
        no: { reveal: ["cinque"] },
      },
      no: {
        letter: "S",
        yes: { reveal: ["sei"] },
        no: { reveal: ["nove"] },
      },
    },
  };
}
