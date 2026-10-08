#!/usr/bin/env node
// Downloads the stockfish.js npm tarball and extracts only the lite single-threaded build into
// public/engine/. Usage: node scripts/update-engine.mjs [version]   (default: latest)
// Requires `npm` and `tar` on PATH. Prints SHA-256 checksums for public/engine/README.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'engine');
const version = process.argv[2] ?? 'latest';
const work = mkdtempSync(join(tmpdir(), 'sf-update-'));

try {
  console.log(`Fetching stockfish@${version} (this is a large tarball, ~160 MB)...`);
  execFileSync('npm', ['pack', `stockfish@${version}`, '--silent'], { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] });
  const tarball = readdirSync(work).find(f => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', tarball], { cwd: work });
  const bin = join(work, 'package', 'bin');
  const js = readdirSync(bin).find(f => /^stockfish-\d+-lite-single\.js$/.test(f));
  if (!js) throw new Error('lite single-threaded build not found in package');
  const wasm = js.replace(/\.js$/, '.wasm');
  for (const f of readdirSync(outDir)) {
    if (/^stockfish-.*\.(js|wasm)$/.test(f)) rmSync(join(outDir, f));
  }
  copyFileSync(join(bin, js), join(outDir, js));
  copyFileSync(join(bin, wasm), join(outDir, wasm));
  copyFileSync(join(work, 'package', 'Copying.txt'), join(outDir, 'COPYING.txt'));
  for (const f of [js, wasm]) {
    const sum = createHash('sha256').update(readFileSync(join(outDir, f))).digest('hex');
    console.log(`${f}  ${sum}`);
  }
  console.log(`\nUpdated ${outDir}. If the file name changed, update ENGINE_FILE in src/engine/engine.ts.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
