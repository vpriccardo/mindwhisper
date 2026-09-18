# call-v1 final report (§69)

Generated from the working tree after clean loopback + impairment harness passed.

## 1. Files created

| Path | Role |
|------|------|
| `tx2.html` | Call TX UI |
| `rx2.html` | Call RX UI |
| `js/call/call-constants.js` | Bands, timing, preamble, Δ, packing helpers |
| `js/call/call-carrier.js` | Textured 12+12 band carriers (not pure tones) |
| `js/call/call-ambient.js` | Call-resilient Breathing / Elements / Air + codec bed |
| `js/call/call-tx.js` | Continuous TX + offline PCM render |
| `js/call/call-rx.js` | Feature extractor + live mic + offline PCM decode |
| `js/call/call-sync.js` | Preamble search, soft bits, SEARCH/TRACK/CONFIRMED |
| `js/call/call-combiner.js` | Multi-frame soft combining |
| `js/call/call-watermark.js` | TX UI controller |
| `js/call/BOUNDARY.js` | Ownership note vs room-v1 |
| `audio/rx2-worklet.js` | 24-band feature worklet (~20 ms) |
| `tests/call-channel-tests.html` | Browser packing + short loopback |
| `run-call-loopback.mjs` | Focused clean TX→RX |
| `run-call-tests.mjs` | Packing + impairments + optional Opus |
| `docs/real-call-test-sheet.md` | Physical call matrix |
| `docs/call-v1-report.md` | This report |

## 2. Files modified (shared / room shell)

| Path | Change |
|------|--------|
| `js/protocol.js` | `encodeProtectedPayload` / `encodeCallMessage` (+4 pad → 46×6) — room encode path unchanged |
| `index.html` | Same-room + voice/video-call entry groups |
| `css/app.css` | Home section labels |
| `manifest.webmanifest` | Description covers call path |
| `sw.js` | Cache call assets (best-effort); cache bump |
| `tx.html` / `rx.html` | Nav links to call pages only (acoustic behaviour unchanged) |

## 3. Room-v1 intact

- Entry points remain `tx.html` / `rx.html`.
- Room watermark bands, ambient profiles, and DSP path are separate from `js/call/*`.
- Protocol packing tests still assert shared 272-bit scrambled payload.
- Prior full `node run-tests.mjs` run: **144 passed, 0 failed** (reconfirmed after call DSP work).

## 4. Shared protocol reused

`encodeMessage` → CRC-16 → Hamming(266) → pad 6 → interleave → scramble = **272** protected bits.

Call layer: `encodeCallMessage` appends **4 zero pad bits** → **276** → **46 × 6-bit** symbols. Decode strips pad then `decodeFromBits`.

## 5. Frame duration

`58 symbols × 320 ms = 18 560 ms` (`CALL_FRAME_MS`).

## 6. Frequency bands

Base (§7) and enhancement (§16) as in `call-constants.js` (`CALL_BASE_CHANNELS`, `CALL_ENHANCEMENT_CHANNELS`).

## 7. Spreading code

`CALL_CHIP_CODE = [+1,+1,-1,+1,-1,-1,+1,-1]`, `CHIP_MS=40`, 8 chips/symbol.

## 8. Preamble

12 symbols (`CALL_PREAMBLE`), same chip-spread modulation as data; balanced 6 ones / 6 zeros per channel.

## 9. Base + enhancement combining

Base decode first. Enhancement soft bits merged only if preamble score/quality gates pass; `enhancementWeight=0` is valid. Base-alone loopback verified.

## 10. RX synchronization

Feature grid ~20 ms; local preamble peaks; CRC required before display.

## 11. Tracking / loss of lock

After CRC-valid frame: TRACK/CONFIRMED with ±200 ms window; 2 missed frames → SEARCH.

## 12. Multi-frame combining

Failed CRC soft frames stored; combiner tries 2- then 3-frame weighted averages before FEC/CRC.

## 13. Synthetic success rates

### Clean loopback (`run-call-loopback.mjs`)

**16/16 passed** at production **Δ=2.0 dB** (multi-partial carriers + light noise fill), including 20-char and base-only. Focused clean MC **40/40** at the same Δ.

### Impairment matrix

`CALL_MC=40` at **Δ=2.0** — **34 passed, 0 failed** (every scenario assertion green):

| Scenario | Rate (n=40) |
|----------|-------------|
| clean | 40/40 (100%) |
| band4k | 40/40 (100%) |
| band3k4 | 40/40 (100%) |
| agc | 40/40 (100%) |
| eq | 40/40 (100%) |
| noise15 | 40/40 (100%) |
| speech | 40/40 (100%) |
| resample44k | 40/40 (100%) |
| drift50 | 40/40 (100%) |
| reverb | 40/40 (100%) |
| dropouts | 40/40 (100%) |
| packetLoss | 40/40 (100%) |
| comboCall | 40/40 (100%) |

Opus 24 kbps roundtrip: **PASS**.

Earlier reduced run at Δ=1.2 (`CALL_MC=10`) was softer (~80–90% majors) — raising Δ to 2.0 and stabilizing carriers recovered the matrix.

Full ≥100/scenario still available via `CALL_MC=100 node run-call-tests.mjs` (long; not required once n=40 is saturated).

## 14. After ~4 kHz low-pass

`band4k` / `band3k4` = **100%** at N=40 (Δ=2.0) — base layer survives without enhancement.

## 15. Gain / EQ / noise / dropout

All **100%** at N=40 (see matrix). Soft assertion floors remain in the harness for dropout/packetLoss/comboCall.

## 16. Real Opus / codec

ffmpeg Opus 24 kbps mono roundtrip: **PASS** (`OPUSTEST`). Broader bitrate sweep not automated.

## 17. Not physically tested

All rows in `docs/real-call-test-sheet.md` remain **NOT TESTED** (FaceTime, WhatsApp, Teams, cellular, WebRTC).

## 18. Likely post-field tuning knobs

1. `BASE_TOTAL_DIFFERENTIAL_DB` (production **2.0**; try 1.5 in good channels, raise toward 2.5–3.5 if WhatsApp/FaceTime shreds SNR)
2. `CALL_CARRIER_LEVEL` / ambient mix / notch depth
3. Band edges / carrier partial vs noise mix
4. `CHIP_MS` (30–60) and preamble threshold
5. Multi-frame combine depth (2–4)

## Production defaults (current)

- Δ base: **2.0 dB** with multi-partial in-band carriers (noise fill ≈0.06)
- Enhancement Δ: **0.9 dB**
- Carrier level: **0.95**, ambient mix: **0.72**
- Frame: **18.56 s** continuous retransmit
- Codec bed centres stay in inter-channel gaps only
