# Mindwhisper

Reverse Progressive Anagram coach — **Oggetti di casa** (IT).

Live cue sheet + drill trainer for the magician phone: force zona → genere → sillabe → Reverse PA → reveal.

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

- **Live** — tap spectator feedbacks; UI shows the next script line, letter, or reveal
- **Drill** — app picks a secret word in the chosen zona; checks each tap against the expected path

Verified PA trees (v1): Casa · M · 3+, Cucina · F · 3+. Other cells show the closed bank + outs.

## Legacy

Breath meditation sources remain under `prototype/src/breath/` but are not built or deployed.
