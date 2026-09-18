#!/usr/bin/env node
/**
 * Copy the static acoustic watermark app into Vite dist/acoustic
 * so production serves it at https://…/acoustic/
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, '..', 'acoustic');
const dest = join(root, 'dist', 'acoustic');

if (!existsSync(src)) {
  console.error('acoustic/ source not found at', src);
  process.exit(1);
}

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

// Keep deploy payload lean — not needed at runtime
for (const name of [
  'vercel.json',
  'run-tests.mjs',
  'run-call-tests.mjs',
  'run-call-loopback.mjs',
  'README.md',
  'docs',
]) {
  rmSync(join(dest, name), { recursive: true, force: true });
}

console.log('Copied acoustic app → dist/acoustic');
