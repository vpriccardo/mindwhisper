# Acoustic protocol-v2 upgrade — final report

Status: **implemented in repo; physical call/room field tests still required.**
Do not describe call-platform support as reliable until demonstrated on real FaceTime / WhatsApp / Teams.

## 1. Files changed (major)

### Shared protocol / FEC
- `js/protocol-v2.js` — variable-length framing, header, CRC, whitening, RS glue
- `js/rs-codec.js` — GF(256) Reed-Solomon (errors + erasures)
- `run-protocol-v2-tests.mjs` — 767 unit tests

### Room-v2
- `js/room-v2/room-v2-constants.js`, `room-v2-protocol.js`, `room-v2-rx.js`
- `js/tx-engine.js` — `protocolVersion` / `speedId` (default **v2**)
- `js/tx.js`, `tx.html` — speed selector, `?protocol=v1`
- `js/rx.js`, `rx.html` — room-v2 default decoder + diagnostics
- `audio/rx-v2-worklet.js` — 15 ms features for room-v2
- `run-room-v2-tests.mjs`

### Call-v2
- `js/call/call-v2-constants.js`, `call-v2-dsp.js`, `call-v2-protocol.js`
- `js/call/call-v2-tx.js`, `call-v2-rx.js`, `call-v2-reference.js`
- `js/call/call-watermark.js` — Meditation defaults to **call-v2** (no additive carrier)
- `tx2.html` / `rx2.html` — depth/speed settings, v2 diagnostics
- `audio/rx2-v2-worklet.js` — 10 ms, 6 pair ratios
- `run-call-v2-tests.mjs`
- `test-helpers/synthetic-music.mjs`

### Deploy / cache
- `sw.js` — caches v2 modules + worklets
- `vercel.json` — unchanged cleanUrls / cache headers

## 2. v1 availability

| Page | Default | Frozen v1 |
|------|---------|-----------|
| `tx.html` / `rx.html` | room-v2 | `?protocol=v1` |
| `tx2.html` Meditation | call-v2 (EQ-in-music) | `?protocol=v1` restores additive call-v1 |
| `tx2.html` air/tide/elements | call-v1 additive | (unchanged) |
| `rx2.html` | call-v2 | `?protocol=v1` |

## 3. protocol-v2 frame format

```
header byte (×3 majority on air):
  bits[7:5] = 0b010  (PROTOCOL_V2)
  bits[4:0] = messageLength - 1   (1–20 chars)

rsData = header || packedMessage || CRC16-CCITT-FALSE(packedMessage)
codeword = RS_encode(rsData, parityBytes)   // shortened RS over GF(256), poly 0x11D
whitenedBits = codewordBits XOR xorshift32(seed=0xA17C9E2D)   // header repeats NOT whitened

parityBytes: 6 (len≤8), 8 (len≤14), 10 (len≤20)
alphabet: 64 chars, 6 bits/char (shared with v1)
```

**Room-v2 acoustics:** 8-byte preamble + 3×header + whitened codeword as 8-parallel differential HF symbols (carrier unchanged from room-v1).

**Call-v2 acoustics:** 8×6-bit preamble + 4×6-bit header symbols + payload packed 6 bits/symbol; each bit is a self-cancelling two-half peaking-EQ differential on one frequency pair.

## 4. RS implementation / tests

- Syndrome → Forney → Berlekamp–Massey → Chien → Forney magnitudes
- Errors + erasures supported
- Cross-checked vs Python `reedsolo` (200 random vectors)
- `run-protocol-v2-tests.mjs`: **767 passed, 0 failed**

## 5. Frame duration (presentation)

| Chars | room-v2 @ conservative 120 ms | call-v2 @ fast 120 ms |
|------:|------------------------------:|----------------------:|
| 3 | 2760 ms | 3360 ms |
| 8 | 3120 ms | **3840 ms** (≤4.5 s target) |
| 12 | 3720 ms | 4680 ms |
| 20 | 4680 ms | **6000 ms** (≤6.5 s target) |

Room default speed is **conservative (120 ms)** after empirical SNR testing (faster presets are weaker). Call default is **fast (120 ms)** + **balanced (0.40 dB)** depth.

## 6. Room-v2 synthetic results (by speed)

Monte-Carlo (MC=30 per length bucket) success rates on clean digital loopback:

| Speed | 1–8 chars | 9–14 | 15–20 |
|-------|----------:|-----:|------:|
| fastest 60 ms | 3% | 0% | 0% |
| fast 75 ms | 30% | 0% | 0% |
| balanced 90 ms | 50% | 23% | 7% |
| **conservative 120 ms** | **100%** | **90%** | **93%** |

Time-to-first CRC-valid (default conservative, single-shot): typically 2–8 frames (~5–25 s depending on length/luck). Carrier / music path **unchanged** from room-v1 (HF watermark only).

## 7. Room audio quality

Confirmed by architecture: room-v2 only changes framing/symbol timing on the existing HF differential carrier. Meditation mix / ambient profiles are not re-routed through call-v2 EQ. Subjective “sounds as good as before” is a **listening** check — synthetic tests do not replace it.

## 8. Call-v2: no independent audible carrier (Meditation default)

`CallTransmitter` uses `CallV2ContinuousTransmitter` when profile=`meditation` and protocol≠v1:

```
Meditation → crossfade musicBus → 12 peaking BiquadFilterNodes → master → destination
```

There is **no** `CallCarrierBank` / parallel watermark bus on that path. Watermark OFF ⇒ all peaking gains 0 dB ⇒ bit-identical to the music bus (Node test: maxDiff=0).

## 9–10. Final call-v2 EQ pairs & Q

Empirically placed on usable Meditation energy (lower than the initial speech-band draft):

```
[220, 300], [340, 420], [460, 560], [620, 740], [820, 960], [1080, 1260]
Q default = 3.0  (range 2.5–3.5)
```

## 11. Call-v2 A/B audio findings

- Debug A/B on `tx2.html`: watermark ON/OFF with same Meditation loop/crossfade/volume.
- Offline identity: watermark-off PCM matches input exactly.
- At ≤0.70 dB total differential, changes are intended to be near-inaudible; **no formal ABX listening panel was run in this session** — treat as pending human A/B.

## 12. Synthetic call-v2 results

**Blind** (12-tone carrier at peaking centres, depth sweep @ fast): 0.20–0.70 dB all CRC-valid (`HELLO12`); Monte Carlo 20/20 @ 0.40 dB / fast.

**Pink-noise blind** @ 0.40 dB: typically fails (natural half-to-half ratio σ ≫ watermark).

**Real Meditation** @ 0.40–0.70 dB + **reference-aware** soft multi-frame combine: CRC-valid `HI` (reference cancels known loop spectral motion; RX2 preloads the same MP3). Blind Meditation decode at these depths does **not** meet CRC without reference.

## 13. Opus

Not re-run as a hard gate in the final call-v2 suite. Prior call-v1 Opus path remains in `run-call-tests.mjs` when ffmpeg is present. **Physical calls still required.**

## 14–15. Time-to-first / RS stats

- Room-v2: see §6; first valid often after several frame repeats (optimize for first CRC, not 100% per-frame).
- Call-v2 Meditation+ref: often recovers via **2–3 frame soft combine** + ranked RS erasures rather than single-frame hard decode.
- Exact live mic TTFP depends on phase lock + acoustic path — measure with `?debug=1` diagnostics on RX pages.

## 16. Still requires physical testing

See `docs/real-call-test-sheet.md` (updated for call-v2 defaults) and room listening:

- FaceTime (default / Wide Spectrum)
- WhatsApp, Teams (default / music mode)
- Cellular, WebRTC
- Same-room speaker→mic for room-v2 at presentation distances
- Human A/B: Meditation watermark ON vs OFF at Balanced 0.40 dB

---

## Success condition checklist

| Requirement | Synthetic / code | Field |
|-------------|------------------|-------|
| Room music quality unchanged | Architecture yes | Listen |
| Room short message ~2–3 s first decode | Frame ~3 s; first CRC often multi-frame | Test |
| Call: no horn/beep carrier (Meditation) | Yes (EQ path) | Listen |
| Call short word frame ≈4 s | 3.84 s @ 8 chars / 120 ms | — |
| RX2 CRC-valid text | Yes (tones blind; Meditation+ref) | Real calls **NOT TESTED** |
