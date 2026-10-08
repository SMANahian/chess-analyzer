#!/usr/bin/env node
// Builds public/data/openings.json from the vendored lichess-org/chess-openings TSVs (CC0).
// Output: { version, count, entries: [[epd, eco, name], ...] } where epd is the position key
// (board, turn, castling, legal en-passant square) reached at the end of each named line.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'data', 'openings');
const outFile = join(root, 'public', 'data', 'openings.json');

function epdOf(pos) {
  // makeFen(toSetup()) only writes an en-passant square when a legal capture exists.
  return makeFen(pos.toSetup()).split(' ').slice(0, 4).join(' ');
}

const entries = [];
const seen = new Set();
let skipped = 0;
for (const file of readdirSync(srcDir).filter(f => f.endsWith('.tsv')).sort()) {
  const lines = readFileSync(join(srcDir, file), 'utf8').split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split('\t');
    if (!eco || !name || !pgn) { skipped++; continue; }
    const pos = Chess.default();
    let ok = true;
    for (const token of pgn.trim().split(/\s+/)) {
      if (/^\d+\.+$/.test(token)) continue;
      const move = parseSan(pos, token);
      if (!move) { ok = false; break; }
      pos.play(move);
    }
    if (!ok) { skipped++; continue; }
    const epd = epdOf(pos);
    if (seen.has(epd)) continue;
    seen.add(epd);
    entries.push([epd, eco, name]);
  }
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ version: 1, count: entries.length, entries }));
console.log(`openings: ${entries.length} positions -> ${outFile}${skipped ? ` (${skipped} lines skipped)` : ''}`);
