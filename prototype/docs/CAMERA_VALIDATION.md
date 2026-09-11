# Real-camera validation matrix (Hidden envelope)

Repeatable matrix for measuring acquisition under physical display→camera
conditions. Do not tune only on one screen/camera pair.

## Setup

- Spectator displays (≥2 if available): different brightness/technology
  (e.g. laptop LCD + phone OLED).
- Performer cameras (≥2 if available): Continuity Camera / iPhone and a second
  phone or webcam.
- Secure context: `http://127.0.0.1:8001/` performer, `http://127.0.0.1:8000/`
  spectator.

## Factors

| Factor | Levels |
|--------|--------|
| Display brightness | 30%, 60%, 100% |
| Ambient light | indoor warm, indoor dim, bright diffuse daylight |
| Carrier height in frame | 240, 320, 480 px |
| Off-axis angle | 0°, 20°, 35° |
| Motion | stationary; 0.5–1.0 s passing glimpse |
| Trials per condition | 20 |

## Counts to record

For each condition: found, locked correctly, no lock, wrong lock, time to lock
(ms or frames). Commit aggregates as JSON/CSV under `prototype/test-results/`
**without** camera images or user data.

## Declared v1 support envelope

- ≥60% of watermark mask visible
- carrier ≥240 px high in camera frame
- off-axis ≲35°
- glare/occlusion ≤15%
- enough light/focus for flap/seal/paper texture

Wider stress cases (180 px / 40° / 20% occlusion) may be reported separately and
must never wrong-lock.

## Honesty

Results are measurements, not guarantees. If hardware is unavailable, leave this
gate outstanding rather than inventing numbers.
