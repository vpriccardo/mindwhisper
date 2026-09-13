import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "dist");

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const breath = join(__dirname, "src", "breath");

// Homepage (meditation app)
copyFile(join(breath, "home", "index.html"), join(dist, "index.html"));
copyFile(join(breath, "home", "home.css"), join(dist, "home.css"));
copyFile(join(breath, "home", "home-app.js"), join(dist, "home-app.js"));
copyFile(join(breath, "shared", "protocol.js"), join(dist, "protocol.js"));
copyFile(join(breath, "shared", "soundscapes.js"), join(dist, "soundscapes.js"));
copyFile(join(breath, "tx", "spa-ambience.js"), join(dist, "spa-ambience.js"));
copyDir(join(breath, "home", "assets"), join(dist, "assets"));
// Ensure sample present even if only under tx/assets
const sample = "583998__stanrams__meditation-one.mp3";
const txSample = join(breath, "tx", "assets", sample);
const homeSample = join(dist, "assets", sample);
if (existsSync(txSample) && !existsSync(homeSample)) {
  mkdirSync(join(dist, "assets"), { recursive: true });
  cpSync(txSample, homeSample);
}

// TX (unchanged surface)
const txDist = join(dist, "tx");
mkdirSync(txDist, { recursive: true });
copyFile(join(breath, "tx", "index.html"), join(txDist, "index.html"));
copyFile(join(breath, "tx", "tx-app.js"), join(txDist, "tx-app.js"));
copyFile(join(breath, "tx", "audio-engine.js"), join(txDist, "audio-engine.js"));
copyFile(join(breath, "tx", "spa-ambience.js"), join(txDist, "spa-ambience.js"));
copyFile(join(breath, "shared", "protocol.js"), join(txDist, "protocol.js"));
copyFile(join(breath, "shared", "soundscapes.js"), join(txDist, "soundscapes.js"));
copyFile(join(breath, "shared", "sync.js"), join(txDist, "sync.js"));
copyFile(join(breath, "shared", "peerjs.min.js"), join(txDist, "peerjs.min.js"));
copyDir(join(breath, "tx", "assets"), join(txDist, "assets"));

// RX decode (unlisted helper for shared sessions)
const rxDist = join(dist, "rx");
mkdirSync(rxDist, { recursive: true });
copyFile(join(breath, "rx", "index.html"), join(rxDist, "index.html"));
copyFile(join(breath, "rx", "rx-app.js"), join(rxDist, "rx-app.js"));
copyFile(join(breath, "shared", "protocol.js"), join(rxDist, "protocol.js"));
copyFile(join(breath, "shared", "sync.js"), join(rxDist, "sync.js"));
copyFile(join(breath, "shared", "peerjs.min.js"), join(rxDist, "peerjs.min.js"));

console.log("Mindwhisper breath app built → dist/");
