# Optional spa bed loop (licensed audio)

By default Mindwhisper **synthesizes** a spa/meditation bed in the browser
(works fully offline, no downloads).

If you have a properly licensed track (e.g. from your Epidemic Sound
subscription), you may place a looped file here:

- `spa-loop.mp3` (preferred)
- `spa-loop.ogg`
- `spa-loop.wav`
- `spa-loop.m4a`

On start, TX will try to load `/tx/assets/spa-loop.*` and use it as the
ambient bed. If missing, the procedural spa bed is used.

**Do not commit Epidemic Sound files to this public repo** unless your
license explicitly allows redistribution. Keep licensed loops local or
in a private deploy asset store.

Tips for a seamless loop:
- Prefer 30–60s of soft ambient with no hard edits at the seam
- Export with a short crossfade at loop points
- Keep peak level moderate so breath taps and the quiet data layer stay balanced
