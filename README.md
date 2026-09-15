# Mindwhisper

Reverse Progressive Anagram coach — React, mobile-first (iPhone).

Categorie (JSON in `prototype/src/data/`):

- **Oggetti in casa** v1.3 (cucina · bagno · soggiorno)
- **Carte poker 52** (seme → figura/numero → banda se numero)
- **Animali** v0 (domestici · fattoria · selvatici)
- **Cibi** v0 (frutta-verdura · dispensa · piatti-pronti)

Cue brevi + tema bianco/nero.

## Live

https://mindwhisper.vercel.app/

## Run locally

```bash
cd prototype
npm install
npm run dev      # http://localhost:5173
npm run build
npm run preview  # http://localhost:4173
```

## Modes

- **Live** — tap spectator feedbacks; short instruction + Sì/No
- **Drill** — secret word in the chosen force; checks each tap

## Pages

- `/` — coach
- `/words` — lista parole raggruppate per categoria (per il performer)

## Legacy

Breath meditation sources remain under `prototype/src/breath/` but are not built or deployed.
