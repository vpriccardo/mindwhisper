# Audio perceptual / audibility evaluation (manual gate)

The natural seal sound (paper close + wax stamp) is **intentionally audible**.
The encoded AENV1 data layer must not present as beeps, modem tones, Morse, or a
separate artificial layer.

## Protocol

1. Render pairs of cover-only vs encoded seals at matched loudness (`watermarkDb`
   provisional −18 dBFS relative to cover RMS in the data region).
2. Randomize order; double-blind when possible.
3. Ask each listener:
   - Which clip (if either) contains hidden data?
   - Any beep, whistle, chirp, metallic tone, or discomfort?
4. Test on headphones and on phone/laptop speakers.
5. Prefer including younger listeners (high-frequency sensitivity differs).

## Pass criteria (release gate)

Do **not** call the data layer perceptually hidden until:

- at least 20 listeners perform no better than chance on identifying encoded clips
  within the declared analysis;
- no systematic tonal artifact is reported.

Until then, treat audibility as an open manual gate. Never claim absolute
inaudibility.
