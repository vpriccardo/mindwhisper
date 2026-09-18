# Real-call test sheet (call-v1)

Status legend: **NOT TESTED** until a physical two-device call is completed.
Do not mark WORKS / PARTIAL / FAILS from synthetic Opus alone.

| Platform | Setup | Result | Notes |
|----------|--------|--------|-------|
| FaceTime default | TX plays into call; RX mic at remote speaker | **NOT TESTED** | |
| FaceTime Wide Spectrum | Same, Wide Spectrum mic mode if available | **NOT TESTED** | |
| WhatsApp voice (default) | Same | **NOT TESTED** | |
| Microsoft Teams default | Same | **NOT TESTED** | |
| Teams high-fidelity music mode | Same, enable music/hi-fi if offered | **NOT TESTED** | |
| Cellular telephone | Handset speaker → RX mic | **NOT TESTED** | Narrowband expected |
| WebRTC browser call | TX tab + remote RX | **NOT TESTED** | |

## Procedure

1. Open `tx2.html` on device A (HTTPS or localhost). Enter a known message (e.g. `ELEPHANT`).
2. Start a voice call to device B (FaceTime / WhatsApp / Teams / phone).
3. On device A: Start TX, set volume ~60–80%, keep page foregrounded. Prefer speakerphone or “share device audio” if available.
4. On device B: Open `rx2.html`, tap **Start listening**, hold mic near the call speaker (or use speakerphone).
5. Wait at least **two full frames** (~40 s). CRC must validate before the UI shows text.
6. Record: message recovered? attempts? sync state (`?debug=1`)? perceived audio quality?

## Suggested message set

`A`, `Hi`, `TEST`, `ELEPHANT`, `Hello World`, `Aa0 -Zz`, 20-char max alphabet stress.

## Pass criteria (field)

- Correct message displayed after CRC validation.
- No network / Bluetooth / data-channel side channel used.
- Ambient remains subjectively calm (no modem chirps).

## Lab vs field

Automated `node run-call-tests.mjs` covers synthetic band-limit / AGC / noise / Opus (if ffmpeg). It does **not** replace real-call rows above.
