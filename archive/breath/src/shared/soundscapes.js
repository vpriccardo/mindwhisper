/**
 * Procedural soundscapes for Mindwhisper (offline, no downloads).
 */
const MindwhisperSoundscapes = (() => {
  const PRESETS = [
    {
      id: "mist-grove",
      name: "Mist Grove",
      blurb: "Warm drones in a humid clearing",
      kind: "synth",
      palette: "grove",
    },
    {
      id: "tide-room",
      name: "Tide Room",
      blurb: "Low shore noise and slow harmonics",
      kind: "synth",
      palette: "tide",
    },
    {
      id: "ember-hall",
      name: "Ember Hall",
      blurb: "Darker hall resonance, sparse bowls",
      kind: "synth",
      palette: "ember",
    },
    {
      id: "glass-still",
      name: "Glass Still",
      blurb: "Bright air and gentle glass-like partials",
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
