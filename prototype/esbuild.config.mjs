import * as esbuild from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isTest = process.argv.includes("--test");
const skipPrepare = process.argv.includes("--skip-prepare");

const shared = {
  bundle: true,
  target: ["es2020"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
};

function runNode(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: __dirname,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`${script} failed with status ${r.status}`);
  }
}

function prepareGenerated() {
  if (skipPrepare) return;
  runNode(join(__dirname, "scripts", "generate-hidden-dictionary.mjs"));
  runNode(join(__dirname, "scripts", "prepare-carrier.mjs"));
}

function copyEnvelopeAssets(destRoot) {
  const envDir = join(destRoot, "assets", "envelope");
  mkdirSync(envDir, { recursive: true });
  for (const name of [
    "envelope-base-v1.png",
    "envelope-mask-v1.bin",
    "envelope-basis-v1.bin",
  ]) {
    cpSync(
      join(__dirname, "src", "assets", "envelope", name),
      join(envDir, name),
    );
  }
  cpSync(
    join(__dirname, "src", "generated", "hiddenDigestTable.bin"),
    join(envDir, "hiddenDigestTable.bin"),
  );
}

function copyOpenCv(destRoot) {
  const src = join(
    __dirname,
    "node_modules",
    "@techstark",
    "opencv-js",
    "dist",
    "opencv.js",
  );
  if (!existsSync(src)) {
    throw new Error("OpenCV.js missing; run npm install.");
  }
  const destDir = join(destRoot, "assets", "opencv");
  mkdirSync(destDir, { recursive: true });
  cpSync(src, join(destDir, "opencv.js"));
  // Also keep a vendor copy inside the repo tree for offline reference.
  const vendorDir = join(__dirname, "vendor", "opencv");
  mkdirSync(vendorDir, { recursive: true });
  cpSync(src, join(vendorDir, "opencv.js"));
}

async function buildProduction() {
  prepareGenerated();

  const distSpectator = join(__dirname, "dist", "spectator");
  const distPerformer = join(__dirname, "dist", "performer");
  rmSync(join(__dirname, "dist"), { recursive: true, force: true });
  mkdirSync(distSpectator, { recursive: true });
  mkdirSync(distPerformer, { recursive: true });

  await esbuild.build({
    ...shared,
    platform: "browser",
    entryPoints: [join(__dirname, "src", "spectator", "spectator.ts")],
    outfile: join(distSpectator, "spectator.js"),
    minify: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: true,
  });

  await esbuild.build({
    ...shared,
    platform: "browser",
    entryPoints: [join(__dirname, "src", "performer", "performer.ts")],
    outfile: join(distPerformer, "performer.js"),
    minify: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: true,
  });

  await esbuild.build({
    ...shared,
    platform: "browser",
    format: "iife",
    entryPoints: [
      join(__dirname, "src", "performer", "watermark", "hiddenEnvelopeWorker.ts"),
    ],
    outfile: join(distPerformer, "hiddenEnvelopeWorker.js"),
    minify: true,
  });

  await esbuild.build({
    ...shared,
    platform: "browser",
    format: "iife",
    entryPoints: [
      join(__dirname, "src", "performer", "audioSeal", "audioDecoderWorker.ts"),
    ],
    outfile: join(distPerformer, "audioDecoderWorker.js"),
    minify: true,
  });

  // AudioWorklet must be a classic/module script loadable via addModule.
  await esbuild.build({
    ...shared,
    platform: "browser",
    format: "esm",
    entryPoints: [
      join(__dirname, "src", "performer", "audioSeal", "audioCaptureWorklet.ts"),
    ],
    outfile: join(distPerformer, "audioCaptureWorklet.js"),
    minify: true,
  });

  // Labs
  const specLab = join(distSpectator, "audio-lab");
  const perfLab = join(distPerformer, "audio-lab");
  mkdirSync(specLab, { recursive: true });
  mkdirSync(perfLab, { recursive: true });

  await esbuild.build({
    ...shared,
    platform: "browser",
    entryPoints: [join(__dirname, "src", "spectator", "audio-lab", "audio-lab.ts")],
    outfile: join(specLab, "audio-lab.js"),
    minify: true,
  });
  await esbuild.build({
    ...shared,
    platform: "browser",
    entryPoints: [join(__dirname, "src", "performer", "audio-lab", "audio-lab.ts")],
    outfile: join(perfLab, "audio-lab.js"),
    minify: true,
  });

  cpSync(
    join(__dirname, "src", "spectator", "index.html"),
    join(distSpectator, "index.html"),
  );
  cpSync(
    join(__dirname, "src", "spectator", "spectator.css"),
    join(distSpectator, "spectator.css"),
  );
  cpSync(
    join(__dirname, "src", "performer", "index.html"),
    join(distPerformer, "index.html"),
  );
  cpSync(
    join(__dirname, "src", "performer", "performer.css"),
    join(distPerformer, "performer.css"),
  );
  cpSync(
    join(__dirname, "src", "spectator", "audio-lab", "index.html"),
    join(specLab, "index.html"),
  );
  cpSync(
    join(__dirname, "src", "spectator", "audio-lab", "audio-lab.css"),
    join(specLab, "audio-lab.css"),
  );
  cpSync(
    join(__dirname, "src", "performer", "audio-lab", "index.html"),
    join(perfLab, "index.html"),
  );
  cpSync(
    join(__dirname, "src", "performer", "audio-lab", "audio-lab.css"),
    join(perfLab, "audio-lab.css"),
  );

  copyEnvelopeAssets(distSpectator);
  copyEnvelopeAssets(distPerformer);
  copyOpenCv(distPerformer);

  // Content-hash manifest note for ops.
  const png = readFileSync(
    join(__dirname, "src", "assets", "envelope", "envelope-base-v1.png"),
  );
  writeFileSync(
    join(distSpectator, "assets", "envelope", "ASSET_MANIFEST.json"),
    JSON.stringify(
      {
        carrierId: "envelope-v1",
        pngBytes: png.length,
      },
      null,
      2,
    ),
  );
  cpSync(
    join(distSpectator, "assets", "envelope", "ASSET_MANIFEST.json"),
    join(distPerformer, "assets", "envelope", "ASSET_MANIFEST.json"),
  );
}

async function buildTestBundle() {
  prepareGenerated();
  const outDir = join(__dirname, "test", ".bundle");
  mkdirSync(outDir, { recursive: true });

  const entries = [
    ["protocol.ts", "protocol.mjs", join("src", "spectator", "protocol.ts")],
    [
      "hiddenEnvelopeProtocol.ts",
      "hiddenEnvelopeProtocol.mjs",
      join("src", "shared", "hiddenEnvelopeProtocol.ts"),
    ],
    [
      "watermarkBasis.ts",
      "watermarkBasis.mjs",
      join("src", "shared", "watermarkBasis.ts"),
    ],
    ["embed.ts", "embed.mjs", join("src", "spectator", "watermark", "embed.ts")],
    [
      "dictionaryMatcher.ts",
      "dictionaryMatcher.mjs",
      join("src", "performer", "watermark", "dictionaryMatcher.ts"),
    ],
    [
      "frameAccumulator.ts",
      "frameAccumulator.mjs",
      join("src", "performer", "watermark", "frameAccumulator.ts"),
    ],
    [
      "lockPolicy.ts",
      "lockPolicy.mjs",
      join("src", "performer", "watermark", "lockPolicy.ts"),
    ],
    [
      "extractSoftBits.ts",
      "extractSoftBits.mjs",
      join("src", "performer", "watermark", "extractSoftBits.ts"),
    ],
    [
      "templateAlign.ts",
      "templateAlign.mjs",
      join("src", "performer", "watermark", "templateAlign.ts"),
    ],
    [
      "aztecCore.ts",
      "aztecCore.mjs",
      join("src", "spectator", "transports", "aztecCore.ts"),
    ],
    [
      "payloadValidate.ts",
      "payloadValidate.mjs",
      join("src", "performer", "payloadValidate.ts"),
    ],
    [
      "acquisition.ts",
      "acquisition.mjs",
      join("src", "performer", "acquisition.ts"),
    ],
    [
      "envelopeManifest.ts",
      "envelopeManifest.mjs",
      join("src", "generated", "envelopeManifest.ts"),
    ],
    [
      "hiddenDictionaryMeta.ts",
      "hiddenDictionaryMeta.mjs",
      join("src", "generated", "hiddenDictionaryMeta.ts"),
    ],
    // AENV1
    [
      "constants.ts",
      "audioSealConstants.mjs",
      join("src", "shared", "audioSeal", "constants.ts"),
    ],
    ["crc16.ts", "audioSealCrc16.mjs", join("src", "shared", "audioSeal", "crc16.ts")],
    [
      "convolutional.ts",
      "audioSealConvolutional.mjs",
      join("src", "shared", "audioSeal", "convolutional.ts"),
    ],
    [
      "interleave.ts",
      "audioSealInterleave.mjs",
      join("src", "shared", "audioSeal", "interleave.ts"),
    ],
    ["packet.ts", "audioSealPacket.mjs", join("src", "shared", "audioSeal", "packet.ts")],
    [
      "preamble.ts",
      "audioSealPreamble.mjs",
      join("src", "shared", "audioSeal", "preamble.ts"),
    ],
    [
      "symbolBasis.ts",
      "audioSealSymbolBasis.mjs",
      join("src", "shared", "audioSeal", "symbolBasis.ts"),
    ],
    [
      "coverSound.ts",
      "coverSound.mjs",
      join("src", "spectator", "audioSeal", "coverSound.ts"),
    ],
    [
      "renderAudioSeal.ts",
      "renderAudioSeal.mjs",
      join("src", "spectator", "audioSeal", "renderAudioSeal.ts"),
    ],
    [
      "decodeAudioSeal.ts",
      "decodeAudioSeal.mjs",
      join("src", "performer", "audioSeal", "decodeAudioSeal.ts"),
    ],
    ["resample.ts", "resample.mjs", join("src", "performer", "audioSeal", "resample.ts")],
    [
      "ringBuffer.ts",
      "ringBuffer.mjs",
      join("src", "performer", "audioSeal", "ringBuffer.ts"),
    ],
    [
      "audioLockPolicy.ts",
      "audioLockPolicy.mjs",
      join("src", "performer", "audioSeal", "audioLockPolicy.ts"),
    ],
  ];

  for (const [, outfile, entry] of entries) {
    await esbuild.build({
      ...shared,
      entryPoints: [join(__dirname, entry)],
      outfile: join(outDir, outfile),
      format: "esm",
      platform: "node",
      minify: false,
    });
  }
}

if (isTest) {
  await buildTestBundle();
} else {
  await buildProduction();
}
