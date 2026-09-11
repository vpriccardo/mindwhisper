#!/usr/bin/env node
/**
 * Generate Hidden-envelope dictionary metadata + digest table.
 * Fails the build if two different surfaces collide for the same salt.
 *
 * Digest table layout: for surfaceIndex in 0..N-1, for salt in 0..255,
 * 6 bytes at offset (surfaceIndex * 256 + salt) * 6.
 */

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPO = join(ROOT, "..");
const CSV_PATH = join(REPO, "data", "italian_words.csv");
const OUT_DIR = join(ROOT, "src", "generated");
const GENERATION_VERSION = 1;

function normalizeWord(word) {
  const decomposed = word.trim().normalize("NFKD");
  const asciiOnly = Array.from(decomposed)
    .filter((ch) => !/\p{M}/u.test(ch))
    .join("");
  return Array.from(asciiOnly.toUpperCase())
    .filter((ch) => ch >= "A" && ch <= "Z")
    .join("");
}

async function sha256First6(salt8, normalized) {
  const wordBytes = Buffer.from(normalized, "utf8");
  const input = Buffer.alloc(1 + wordBytes.length);
  input[0] = salt8;
  wordBytes.copy(input, 1);
  return createHash("sha256").update(input).digest().subarray(0, 6);
}

async function loadSurfaces(csvPath) {
  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let header = null;
  /** @type {{ surface: string, conceptId: string, canonicalWord: string, matchType: string }[]} */
  const rows = [];
  const seen = new Map();

  for await (const line of rl) {
    if (!header) {
      header = line.split(",");
      continue;
    }
    if (!line.trim()) continue;
    // CSV may contain commas in later unused fields; take first three columns carefully.
    const parts = parseCsvLine(line);
    const conceptId = parts[0] ?? "";
    const canonicalRaw = parts[1] ?? "";
    const aliasesRaw = parts[2] ?? "";
    const canonical = normalizeWord(canonicalRaw);
    if (!canonical) continue;

    addSurface(seen, rows, {
      surface: canonical,
      conceptId,
      canonicalWord: canonical,
      matchType: "canonical",
    });

    if (aliasesRaw.trim()) {
      for (const aliasPart of aliasesRaw.split("|")) {
        const alias = normalizeWord(aliasPart);
        if (!alias || alias === canonical) continue;
        addSurface(seen, rows, {
          surface: alias,
          conceptId,
          canonicalWord: canonical,
          matchType: "alias",
        });
      }
    }
  }

  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function addSurface(seen, rows, mapping) {
  const key = mapping.surface;
  const existing = seen.get(key);
  if (existing) {
    // Same surface already indexed (duplicate row) — keep first mapping list style.
    return;
  }
  seen.set(key, mapping);
  rows.push(mapping);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const csvBytes = readFileSync(CSV_PATH);
  const csvSha256 = createHash("sha256").update(csvBytes).digest("hex");
  const surfaces = await loadSurfaces(CSV_PATH);
  if (surfaces.length === 0) {
    throw new Error("No dictionary surfaces loaded.");
  }

  const table = Buffer.alloc(surfaces.length * 256 * 6);
  /** @type {Map<string, string>} */
  const collisions = new Map();

  for (let si = 0; si < surfaces.length; si++) {
    const surface = surfaces[si].surface;
    for (let salt = 0; salt < 256; salt++) {
      const digest = await sha256First6(salt, surface);
      const offset = (si * 256 + salt) * 6;
      digest.copy(table, offset);
      const key = `${salt.toString(16).padStart(2, "0")}:${digest.toString("hex")}`;
      const prev = collisions.get(key);
      if (prev !== undefined && prev !== surface) {
        throw new Error(
          `HENV1 collision: salt=${salt} digest=${digest.toString("hex")} for surfaces ${prev} and ${surface}`,
        );
      }
      collisions.set(key, surface);
    }
    if ((si + 1) % 200 === 0) {
      console.log(`digest table: ${si + 1}/${surfaces.length} surfaces`);
    }
  }

  const binPath = join(OUT_DIR, "hiddenDigestTable.bin");
  writeFileSync(binPath, table);

  const tableSha256 = createHash("sha256").update(table).digest("hex");
  const metaPath = join(OUT_DIR, "hiddenDictionaryMeta.ts");
  const metaJson = {
    generationVersion: GENERATION_VERSION,
    protocolId: "HENV1",
    sourceCsvSha256: csvSha256,
    digestTableSha256: tableSha256,
    surfaceCount: surfaces.length,
    saltCount: 256,
    digestBytes: 6,
    surfaces: surfaces.map((s) => ({
      surface: s.surface,
      conceptId: s.conceptId,
      canonicalWord: s.canonicalWord,
      matchType: s.matchType,
    })),
  };

  writeFileSync(
    metaPath,
    `/* Auto-generated by scripts/generate-hidden-dictionary.mjs — do not edit. */\n` +
      `export const HIDDEN_DICTIONARY_META = ${JSON.stringify(metaJson, null, 2)} as const;\n` +
      `export type HiddenDictionaryMeta = typeof HIDDEN_DICTIONARY_META;\n`,
  );

  console.log(
    `Wrote ${surfaces.length} surfaces, digest table ${table.length} bytes, sha256=${tableSha256.slice(0, 16)}…`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
