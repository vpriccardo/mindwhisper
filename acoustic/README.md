# Mindwhisper Acoustic

Hide a short text message inside calm ambient sound. One iPhone plays a meditative rain/air texture; another listens with its microphone and recovers the message. There is **no network path** for the payload — transmission is acoustic only.

## Architecture

```text
TX:
text → packing → CRC-16 → Hamming(7,4) → interleave → scramble
    → procedural ambient + differential spectral watermark → speaker

RX:
microphone → AudioWorklet (16 band-pass energies / 20 ms)
    → preamble correlation → channel calibration → soft bits
    → descramble → deinterleave → Hamming → CRC → text
```

## Acoustic principle

Data is carried as very small **relative energy differences** (±Δ/2 dB, default Δ = 1.5 dB) between paired narrow noise bands in the 5.2–9.7 kHz range. Those bands are part of a continuous rainfall/air texture, not standalone modem tones, chirps, or ultrasound. The ambient bed (warm pad + soft wind + fine rain) masks the watermark psychoacoustically.

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
- http://localhost:8080/tx.html — transmitter
- http://localhost:8080/rx.html — receiver
- http://localhost:8080/tx.html?debug=1 — TX engineering mode (Δ, A/B)
- http://localhost:8080/rx.html?debug=1 — RX diagnostics / field stats

### Automated tests

```bash
cd acoustic
node run-tests.mjs
```

Browser harnesses:

- `/tests/protocol-tests.html`
- `/tests/dsp-tests.html`
- `/tests/simulation-tests.html`

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

`manifest.webmanifest` + `sw.js` cache the app shell (cache-first, versioned as `mw-acoustic-v1`). After one successful online load, TX/RX work without network (microphone still requires a secure context).

## Deploy to Vercel (static)

Production is published with the Mindwhisper coach on the same project:

| URL | App |
|-----|-----|
| https://mindwhisper.vercel.app/ | RPA coach |
| https://mindwhisper.vercel.app/acoustic/ | Acoustic watermark home |
| https://mindwhisper.vercel.app/acoustic/tx | Transmitter |
| https://mindwhisper.vercel.app/acoustic/rx | Receiver |

The Vite build copies `acoustic/` into `prototype/dist/acoustic` (`npm run copy:acoustic`). SPA rewrites exclude `/acoustic/*`.

Standalone deploy of only the acoustic folder is still possible:

```bash
cd acoustic
npx vercel --prod --yes
```

HTTPS is required for microphone + AudioWorklet in production.

## Repository layout

```text
acoustic/
  index.html  tx.html  rx.html
  css/app.css
  js/protocol.js crc16.js hamming.js ambient.js watermark.js tx.js rx.js rx-decoder.js
  audio/rx-worklet.js
  tests/*.html
  manifest.webmanifest  sw.js  icons/icon.svg
  vercel.json  run-tests.mjs  README.md
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
