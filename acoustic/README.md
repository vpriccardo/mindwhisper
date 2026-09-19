# Mindwhisper Acoustic

Hide a short text message inside calm ambient sound. One iPhone plays meditation music (or the asset-free Air fallback); another listens with its microphone and recovers the message. There is **no network path** for the payload — transmission is acoustic only.

## Architecture

```text
shared protocol-v2 (packing → CRC → Reed-Solomon → whitening)
  ├── room-v2 (default) — tx.html / rx.html  (?protocol=v1 → room-v1)
  └── call-v2 (default Meditation) — tx2.html / rx2.html  (?protocol=v1 → call-v1)
```

```text
TX (room-v2):
text → protocol-v2 → HF differential watermark on Meditation/Air → speaker

TX (call-v2 Meditation):
text → protocol-v2 → tiny peaking-EQ watermark IN the Meditation bus → speaker
  (no separate horn/beep carrier)

RX:
microphone → AudioWorklet (band ratios)
    → preamble → soft bits → RS (+ optional erasures / multi-frame) → CRC → text
```

Frozen **v1** (Hamming + additive call carrier) remains at `?protocol=v1`.

See `docs/protocol-v2-report.md` for the full upgrade report.

## Sound profiles

Normal UI:

| Profile | ID | Role |
|---------|----|------|
| **Meditation** (default) | `meditation` | Trimmed ~44 s MP3 (~500 KB) + existing watermark / call support bed |
| **Air** | `air` | Original procedural atmospheric sound — reliability fallback (no MP3) |

Tide / Elements procedural experiments remain available only behind `?debug=1`.

### Meditation presentation layer

Meditation uses **one** locally hosted, approximately **500 KB** MP3 (`audio/meditation-loop-v1.mp3`). It is downloaded once on page load (`fetch` + `force-cache`) and cached by the PWA. The music is **not** the data channel — the hidden message is added live with the existing watermark system. Two overlapping `AudioBufferSourceNode`s with an 8-second equal-power crossfade create continuous playback (no hard `source.loop` seam). Air remains the asset-free fallback if the MP3 cannot load.

In Meditation mode the mix is intentionally **music + data-bearing carrier only** (no Air bed, no decorative hiss). Carrier loudness is calibrated in **dB relative to music RMS** via `js/acoustic-config.js` and the temporary **Test settings** presets on TX / TX2. RX pages expose **Test diagnostics** for comparable field logs. Do not change RX thresholds while calibrating TX.

```text
meditation audio file
        +
minimum live watermark carrier
        ↓
final speaker output
```

Prepare / refresh the production asset from the Freesound source (kept out of deploy):

```bash
# Place source at: source-audio/583998__stanrams__meditation-one.mp3
./scripts/prepare-meditation-audio.sh
```

**Licence:** Creative Commons Attribution-NonCommercial 4.0 (Stan Rams / stanrams, Freesound 583998). See `audio/CREDITS.md` and [credits.html](credits.html).

**This sound cannot be used commercially under the current licence. For commercial deployment, replace it with an appropriately licensed asset or obtain permission from the creator.**

## Acoustic principle

Data is carried as very small **relative energy differences** (±Δ/2 dB) between paired noise bands under the selected presentation profile, not modem tones, chirps, or ultrasound.

- **room-v1:** 5.2–9.7 kHz pairs, default Δ = 3.5 dB, ~120 ms symbols
- **call-v1:** 620–3180 Hz base pairs (+ optional ~3.8–7.9 kHz), default Δ = 1.2 dB, chip-spread 320 ms symbols

TX plays **continuously** until Stop: the same encoded frame repeats while music / ambient evolves independently.

This is **watermarking, not cryptography**. Anyone with the decoder can attempt recovery.

## Quick start (local)

```bash
cd acoustic
# Any static file server on localhost (HTTPS not required for localhost mic):
python3 -m http.server 8080
# or: npx --yes serve -p 8080
```

Open:

- http://localhost:8080/ — home
- http://localhost:8080/tx.html / rx.html — room-v1
- http://localhost:8080/tx2.html / rx2.html — call-v1
- Add `?debug=1` for engineering panels (Δ, watermark A/B on TX2, quality bars on RX2)

### Automated tests

```bash
cd acoustic
node run-ambient-tests.mjs  # Tide/Elements tonality + periodicity aids + Air freeze
node run-tests.mjs          # room-v1 decode matrix (air / tide / elements)
node run-meditation-mix-tests.mjs  # Meditation carrier-dB preset matrix (synthetic)
node run-call-tests.mjs     # call-v1 impairments + Monte-Carlo
```

### Field calibration (Meditation)

Keep phones, distance, volume, and RX settings fixed. On TX choose a **Signal strength** preset; on RX press **Reset test counters**, then run ≥60 s and record first-decode time / valid / failed frames.

Room start ladder: Balanced (−23), Subtle (−26), Very subtle (−29), Extreme (−32).  
Call start ladder: Balanced, Subtle, Very subtle (per FaceTime / WhatsApp / Teams). Prefer one preset stronger than the first inconsistent edge; freeze winners in `js/acoustic-config.js`.

File-size gate for the meditation asset (fails if > 650 KB):

```bash
node -e "const fs=require('fs'); const n=fs.statSync('audio/meditation-loop-v1.mp3').size; if(n>665600){console.error('TOO LARGE',n);process.exit(1)}; console.log('OK',n)"
```

Browser harnesses:

- `/tests/protocol-tests.html`
- `/tests/dsp-tests.html`
- `/tests/simulation-tests.html`
- `/tests/call-channel-tests.html`
- `/docs/real-call-test-sheet.md` — FaceTime/WhatsApp/Teams/phone (**NOT TESTED** until physical)
- `/docs/room-profile-test-sheet.md` — iPhone distance listening for Tide/Elements/Air
- `/docs/ambient-engine.md` — nature engine notes (+ future Fire profile)
## Two-phone procedure

1. Install/open TX and RX over **HTTPS** (or localhost) on two iPhones; optionally Add to Home Screen (PWA).
2. On TX, enter 1–20 characters from `A–Z a–z 0–9 space hyphen`.
3. Set TX volume roughly **50–70%**.
4. On RX, tap **Start listening** and grant microphone access.
5. Tap **Play ambient sound** on TX; keep both pages foregrounded.
6. After ~16 s, RX should show the message when CRC validates.

Distance targets (engineering goals, not claims until measured): 0.5–3 m in a quiet room; 5 m experimental.

## Character set & frame

- Alphabet: 64 symbols → 6 bits each, max 20 characters.
- Raw frame (19 bytes): `version(0x01) | length | packed[15] | CRC16_hi | CRC16_lo`
- CRC-16/CCITT-FALSE over first 17 bytes (`"123456789"` → `0x29B1`)
- Hamming(7,4) even parity on every nibble → 266 bits + 6 pad = 272
- Interleave `p(i) = (73 * i) mod 272`, then xorshift32 whitening (`seed 0xC0FFEE42`)
- 8-symbol hidden preamble + 34 data symbols × 120 ms; frame repeated **3×** (~15.12 s) with 600 ms ambient fade in/out (~16.3 s total)

## Privacy

- No transmitted message leaves the device except as sound.
- No microphone audio is uploaded or stored persistently.
- No server processes messages.
- No analytics, accounts, cookies, or third-party scripts/CDNs.
- Feature buffers exist only in memory for decoding.

## Offline / PWA

`manifest.webmanifest` + `sw.js` cache the app shell and `audio/meditation-loop-v1.mp3` (cache-first, versioned as `mw-acoustic-v12-meditation-loop-v1`). After one successful online load, TX/RX work without network (microphone still requires a secure context). When the music file changes, ship `meditation-loop-v2.mp3` and bump the SW cache version.

## Deploy to Vercel (static)

Production is published with the Mindwhisper coach on the same project:

| URL | App |
|-----|-----|
| https://mindwhisper.vercel.app/ | RPA coach |
| https://mindwhisper.vercel.app/acoustic/ | Acoustic watermark home |
| https://mindwhisper.vercel.app/acoustic/tx | Room-v1 transmit |
| https://mindwhisper.vercel.app/acoustic/rx | Room-v1 receive |
| https://mindwhisper.vercel.app/acoustic/tx2 | Call-v1 transmit |
| https://mindwhisper.vercel.app/acoustic/rx2 | Call-v1 receive |

The Vite build copies `acoustic/` into `prototype/dist/acoustic` (`npm run copy:acoustic`). SPA rewrites exclude `/acoustic/*` and map clean URLs for `tx` / `rx` / `tx2` / `rx2`.

Standalone deploy of only the acoustic folder is still possible:

```bash
cd acoustic
npx vercel --prod --yes
```

HTTPS is required for microphone + AudioWorklet in production.

## Repository layout

```text
acoustic/
  index.html  tx.html  rx.html  tx2.html  rx2.html  credits.html
  css/app.css
  js/protocol.js … room modules …
  js/meditation-audio.js   preload + crossfade music engine
  js/call/…          call-v1 acoustic layer
  audio/meditation-loop-v1.mp3  audio/CREDITS.md
  audio/rx-worklet.js  audio/rx2-worklet.js
  tests/*.html
  manifest.webmanifest  sw.js  icons/icon.svg
  vercel.json  run-tests.mjs  run-call-*.mjs  README.md

scripts/prepare-meditation-audio.sh
source-audio/   # full Freesound source (gitignored; not deployed)
public/audio/   # CREDITS + mirrored production MP3
```

## Limitations

- Imperceptibility is not guaranteed for every listener or listening condition.
- Range depends on room acoustics, phone orientation, and volume.
- Safari may ignore requested mic DSP constraints (`echoCancellation: false`, etc.); RX still runs and inspects actual `track.getSettings()`.
- Not cryptographically secure; short same-room messages only.
- **Real iPhone pair testing is required** before claiming reliable range. Automated coverage here is synthetic (PCM loopback + impairments).

## Tuning knobs (real devices)

Most likely to need adjustment first:

1. Watermark depth Δ (`0.75`–`6.0` dB; production default **3.5**) — prefer the lowest reliable value (`?debug=1` on TX)
2. Band width (~55–200 Hz) / Q / cascade order
3. Preamble correlation threshold (default `0.35`)
4. Symbol duration (100–150 ms) if timing is fragile
5. Channel soft weights from preamble SNR
6. Soft-combine spacing tolerance across the three TX repetitions

Do **not** fall back to audible modem tones if reliability is poor — tune the watermark first.

## Possible future research (not in this build)

Direct-sequence spread-spectrum watermarks, psychoacoustic masking models, Reed–Solomon/BCH, adaptive channel selection, optional encryption, learned watermarking.

## Deviations from the original brief

- Application lives under `acoustic/` so it does not displace the existing Mindwhisper React coach at repo root / Vercel Vite app.
- TX uses deterministic procedural rendering into an `AudioBuffer` at the live `AudioContext` sample rate (OfflineAudioContext used when available for buffer allocation compatibility; DSP itself is offline-rendered in JS for timing determinism).
- Soft bits are indexed as `symbol * 8 + channel` matching preamble bit7→ch0 packing.
- **Default watermark depth Δ = 3.5 dB** (spec suggested 1.5 dB). At 1.5 dB, adjacent-band crosstalk left clean digital loopback below CRC reliability even with 3-frame soft combining. Debug mode still exposes 0.75–6.0 dB so real-device tuning can chase the lowest perceptible-but-reliable value.
- Band design width is **140 Hz** (spec ~160 Hz) with **cascaded** band-pass stages on TX and RX for sharper skirts.
- Ambient rain energy is **notched** at the 16 watermark centres before the modulated texture is mixed in, so uncorrelated bed energy does not dilute pair ratios.
- RX searches **local preamble-correlation maxima** and soft-combines peaks spaced one frame apart.
