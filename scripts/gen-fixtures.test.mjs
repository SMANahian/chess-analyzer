// The committed e2e fixtures are exactly what the generator writes (so they can always be rebuilt),
// and the manifest's ground truth — which the e2e tests assert against — matches the games.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';
import { afterAll, describe, expect, it } from 'vitest';
import { makeRng, writeFixtures } from './gen-fixtures.mjs';

const COMMITTED = fileURLToPath(new URL('../e2e/fixtures/', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'ca-fixtures-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function files(dir, prefix = '') {
  return readdirSync(dir)
    .sort()
    .flatMap(name => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

describe('gen-fixtures', () => {
  const manifest = writeFixtures({ out });

  it('reproduces the committed fixtures byte for byte', () => {
    expect(files(out)).toEqual(files(COMMITTED));
    for (const name of files(out)) expect(readFileSync(join(out, name), 'utf8'), name).toBe(readFileSync(join(COMMITTED, name), 'utf8'));
  });

  it("counts the planted habits like the app does (distinct games, the hero's first visit)", () => {
    const games = readFileSync(join(out, 'lichess-games.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const hero = manifest.lichess.hero.toLowerCase();
    expect(games).toHaveLength(manifest.lichess.count);
    for (const p of manifest.lichess.planted) {
      let reached = 0;
      let played = 0;
      for (const g of games) {
        if (g.players[p.color].user?.id !== hero) continue;
        const pos = Chess.default();
        for (const san of g.moves.split(' ')) {
          const move = parseSan(pos, san);
          if (makeFen(pos.toSetup(), { epd: true }) === p.epd) {
            reached++;
            if (san === p.move_san) played++;
            break;
          }
          pos.play(move);
        }
      }
      expect({ reached, played }, `${p.color} ${p.move_san}`).toEqual({ reached: p.times_reached, played: p.times_played });
    }
    // Enough material for the e2e tests: several piece-hanging habits, each in at least 3 games.
    expect(manifest.lichess.planted.filter(p => (p.hangs_value ?? 0) >= 3 && p.times_played >= 3).length).toBeGreaterThanOrEqual(3);
  });

  it('has a seeded, uniform-looking random generator', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const xs = Array.from({ length: 10_000 }, () => a.random());
    expect(Array.from({ length: 10_000 }, () => b.random())).toEqual(xs);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1);
    expect(makeRng(43).random()).not.toBe(makeRng(42).random());
  });
});
