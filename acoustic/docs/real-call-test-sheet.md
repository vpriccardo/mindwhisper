# Real-call test sheet (call-v2 default)

Status legend: **NOT TESTED** until a physical two-device call is completed.
Do not mark WORKS / PARTIAL / FAILS from synthetic Opus or digital loopback alone.

Default TX2 path under test: **Meditation + call-v2** (EQ watermark, no additive carrier).  
Depth start: **Balanced 0.40 dB**. Speed start: **Fast 120 ms**.  
Fallback if unreliable: try **Robust 0.55 dB**, then slow one speed step — do not jump to an audible carrier.

Frozen call-v1 (additive) is available via `tx2.html?protocol=v1` / `rx2.html?protocol=v1` for A/B against the old horn/beep path.

| Platform | Setup | Result | Notes |
|----------|--------|--------|-------|
| FaceTime default | TX plays into call; RX mic at remote speaker | **NOT TESTED** | |
| FaceTime Wide Spectrum | Same, Wide Spectrum mic mode if available | **NOT TESTED** | |
| WhatsApp voice (default) | Same | **NOT TESTED** | |
| Microsoft Teams default | Same | **NOT TESTED** | |
| Teams high-fidelity music mode | Same, enable music/hi-fi if offered | **NOT TESTED** | |
| Cellular telephone | Handset speaker → RX mic | **NOT TESTED** | Narrowband expected |
| WebRTC browser call | TX tab + remote RX | **NOT TESTED** | |

## Procedure (call-v2)

1. Open `tx2.html` on device A (HTTPS or localhost). Profile **Meditation**. Enter a known message (e.g. `ELEPHANT`).
2. Confirm Test settings: Watermark strength **Balanced**, Transmission speed **Fast**. Optional: `?debug=1`.
3. Start a voice call to device B (FaceTime / WhatsApp / Teams / phone).
4. On device A: Start TX, volume ~60–80%, keep page foregrounded. Prefer speakerphone or “share device audio”.
5. On device B: Open `rx2.html` (same protocol default), tap **Start listening**, hold mic near the call speaker.
6. Wait at least **two full frames** (~8 s at 8 chars / 120 ms; longer for 20 chars). CRC must validate before the UI shows text.
7. Record: message recovered? time to first valid? frames combined? preamble score (`?debug=1`)? perceived audio vs plain Meditation?

## Depth / speed ladder

If CRC never lands within ~30 s:

1. Robust **0.55 dB** (keep Fast)
2. Strong **0.70 dB**
3. Slow to Balanced **140 ms** or Conservative **160 ms**
4. Only then compare against `?protocol=v1` additive path for regression context

If ON/OFF A/B is obviously audible (wah / pulsing): fail the depth setting even if decode works.

## Suggested message set

`A`, `Hi`, `TEST`, `ELEPHANT`, `Hello World`, `Aa0 -Zz`, 20-char max alphabet stress.

## Pass criteria (field)

- Correct message displayed after CRC validation.
- No network / Bluetooth / data-channel side channel used.
- Meditation remains subjectively close to the original MP3 (no modem chirps / horn).

## Lab vs field

- `node run-call-v2-tests.mjs` — pair-tone blind + Meditation reference-aware digital loopback.
- `node run-call-tests.mjs` — legacy call-v1 impairments / Opus if ffmpeg present.

Neither replaces the physical rows above.
