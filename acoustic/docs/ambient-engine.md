# Ambient sound engine notes

## Profiles

| ID | Role |
|----|------|
| `tide` | Flagship coastal texture (stochastic waves + sea bed + foam/spray) |
| `elements` | Soft rain, wind, distant water |
| `air` | Frozen reliability reference — do not regenerate with Tide algorithms |

Legacy id `breathing` aliases to `tide`.

## Architecture

```
createAmbientSession({ profile, transport: 'room'|'call', sampleRate, seed })
        ↓
  continuous render(n)  — no loops, no audio files
        ↓
  TX notches + watermark carriers (independent timeline)
```

Shared nature DSP: `js/ambient-core.js`, `js/ambient-nature.js`.
Room wrapper: `js/ambient-profiles.js`. Call wrapper: `js/call/call-ambient.js`.

Optional continuous worklet (listening / future): `audio/ambient-worklet.js`.
Production TX keeps main-thread `render(n)` so watermark mixing stays intact.

## Future (not implemented)

**Fire** — low filtered noise + stochastic crackle events. Same asset-free procedural approach.

## Diagnostics

```bash
node run-ambient-tests.mjs   # tonality + periodicity aids
node run-tests.mjs           # room decode matrix (air/tide/elements)
node run-call-tests.mjs      # call decode matrix
```

Final acceptance is listening on real iPhone speakers — code compliance is not proof of “sounds realistic”.
