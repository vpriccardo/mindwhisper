/**
 * Procedural soundscapes for Mindwhisper (offline, no large downloads).
 * Each preset documents inspiration / allowed-use notes in `credit`.
 */
const MindwhisperSoundscapes = (() => {
  const PRESETS = [
    {
      id: "temple-one",
      name: "Temple One",
      blurb: "Soft recorded meditation bed",
      credit:
        "meditation one.mp3 by stanrams — https://freesound.org/s/583998/ — License: Attribution NonCommercial 4.0",
      kind: "sample",
      urls: [
        "/assets/583998__stanrams__meditation-one.mp3",
        "/tx/assets/583998__stanrams__meditation-one.mp3",
      ],
    },
    {
      id: "mist-grove",
      name: "Mist Grove",
      blurb: "Warm drones in a humid clearing",
      credit:
        "Original Web Audio synthesis (Mindwhisper). No third-party audio files.",
      kind: "synth",
      palette: "grove",
    },
    {
      id: "tide-room",
      name: "Tide Room",
      blurb: "Low shore noise and slow harmonics",
      credit:
        "Original Web Audio synthesis (Mindwhisper). Pink-noise texture technique is public-domain signal processing.",
      kind: "synth",
      palette: "tide",
    },
    {
      id: "ember-hall",
      name: "Ember Hall",
      blurb: "Darker hall resonance, sparse bowls",
      credit:
        "Original Web Audio synthesis (Mindwhisper). Convolution reverb from generated impulse (no proprietary IR).",
      kind: "synth",
      palette: "ember",
    },
    {
      id: "glass-still",
      name: "Glass Still",
      blurb: "Bright air and gentle glass-like partials",
      credit:
        "Original Web Audio synthesis (Mindwhisper). No third-party audio files.",
      kind: "synth",
      palette: "glass",
    },
  ];

  function byId(id) {
    return PRESETS.find((p) => p.id === id) || PRESETS[0];
  }

  function list() {
    return PRESETS.slice();
  }

  return { PRESETS, byId, list };
})();

if (typeof window !== "undefined") {
  window.MindwhisperSoundscapes = MindwhisperSoundscapes;
}
