# Room-v1 iPhone profile test sheet

Physical acceptance for Tide / Elements / Air. Compare every failed Tide/Elements trial against **Air** before changing protocol.

## Setup

- TX: `tx.html` (HTTPS or localhost), `?debug=1` optional
- RX: `rx.html` on a second iPhone
- Same room, quiet environment
- Known message e.g. `ELEPHANT`
- Volume ~60–80%; keep both pages foregrounded

## Distances

For each profile, record at:

| Distance | Tide decode | Tide TTFM | Tide quality | Tide sound | Elements … | Air … |
|----------|-------------|-----------|--------------|------------|------------|-------|
| 0.5 m | | | | | | |
| 1 m | | | | | | |
| 2 m | | | | | | |
| 3 m | | | | | | |

Columns:

- **decode**: success / fail / partial
- **TTFM**: time to first message (s)
- **signal quality**: from RX debug if available
- **sound**: subjective 1–5 (calm nature vs whale/synth)

## Subjective gates

| Profile | Should evoke | Must not evoke |
|---------|--------------|----------------|
| Tide | calm ocean, natural breathing cadence | whales, synth drones, sirens |
| Elements | soft rain, gentle wind, distant water | storm, white-noise machine, thunder |
| Air | soft atmospheric texture (abstract OK) | modem chirps |

## Listening (no watermark)

`tx.html?debug=1` → Play A (neutral) or Start with watermark depth irrelevant for ambient-only offline A.

Listen **≥ 2 minutes** per profile. Note loop seams, irritation, obvious periodicity.

Then listen with watermark ON (same seed). There should be no obvious signal-related difference.

## Rule

Do **not** change room-v1 watermark frequencies based on one failed Tide test without an Air control at the same distance.
