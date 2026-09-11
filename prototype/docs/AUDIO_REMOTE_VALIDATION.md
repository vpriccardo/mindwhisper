# Audio remote-call validation

Same-laptop speaker→mic success does **not** validate remote/conferencing channels.

## Topologies (test separately)

1. Spectator page on phone, call on a separate laptop/tablet.
2. Spectator page and call on the same phone (expected risky: routing / AEC).
3. Performer decoder phone listening near the performer computer speaker.
4. Imported recording captured from the conferencing output (lab WAV import).

## Platforms

Record through real calls using at least Zoom and Google Meet where available,
with **default** noise suppression first. Do not ask ordinary spectators to enable
“original sound” / music mode; defaults are the target.

## Reporting

For each topology/platform, record:

- correct lock / no-lock / wrong-lock counts;
- platform and OS versions;
- noise-suppression and AGC settings if visible;
- only short purpose-made seal recordings (no voices or personal data).

Report the same-phone spectator topology separately; do not generalize from the
two-device topology.
