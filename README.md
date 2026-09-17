# Mindwhisper

Reverse Progressive Anagram coach — React, mobile-first (iPhone) — see `prototype/`.

## Acoustic watermark (new)

Same-room hidden messages inside calm ambient sound (no network payload path):

```bash
cd acoustic
python3 -m http.server 8080
# open http://localhost:8080/
node run-tests.mjs
```

Full docs: [`acoustic/README.md`](acoustic/README.md). Deploy that folder as a static Vercel project (root directory `acoustic`).

## Coach (prototype)

Categorie from craft portfolio (`prototype/src/data/`):

| Meta | Category | Pack |
|------|----------|------|
| casa | **Oggetti in casa** | v1.4-trim (96, foglie n=8) |
| vivo | **Animali** | v0.1-trim (96) |
| vivo | **Cibi** | v0.1-trim (96) |
| gioco | **Carte poker 52** | v1 (52 + leafTrees) |

Cue brevi + tema bianco/nero.

## Live

https://mindwhisper.vercel.app/

## Run coach locally

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
