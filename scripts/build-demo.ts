// Builds public/demo/demo.json, the bundled example report behind "See an example report": 500
// synthetic games of "Demo Player" (the model of scripts/gen-fixtures.mjs: a fixed repertoire with
// planted habitual mistakes) run through the app's real pipeline in Node — PGN import, storage
// (fake-indexeddb), aggregation, Stockfish 19 lite (the vendored WASM via engine/nodeWorker, standard
// preset), classification — plus a short training history, exported as a v3 backup without evals.
// Run it with `npm run build:demo` (scripts/build-demo.mjs loads this file through Vite's module runner).
import 'fake-indexeddb/auto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFilters } from '../src/core/filters';
import { OpeningBook, type OpeningsJson } from '../src/core/openings';
import { DEFAULT_FILTERS, type Grade, type Mistake, type Profile, type ReviewState } from '../src/core/types';
import { exportBackup, type BackupFile } from '../src/db/backup';
import * as repo from '../src/db/repo';
import { getDb, useTestDb } from '../src/db/schema';
import { createNodeEngineWorker } from '../src/engine/nodeWorker';
import { EnginePool } from '../src/engine/pool';
import { analyzeProfile } from '../src/services/analysis';
import { importPgnIntoProfile } from '../src/services/sync';
import { recordGrade } from '../src/services/training';
import { END_TIME, buildRepertoire, generateGames, loadBook, pgnGame } from './gen-fixtures.mjs';

const OUT = fileURLToPath(new URL('../public/demo/demo.json', import.meta.url));
const OPENINGS = fileURLToPath(new URL('../public/data/openings.json', import.meta.url));
const SEED = 7_350_211;
const GAMES = 500;
const DAY = 86_400_000;
/** The demo's "today": a week after its newest game. Fixed, so the output is reproducible. */
const NOW = END_TIME + 8 * DAY;
const MAX_BYTES = 1.5 * 1024 * 1024;

const PROFILE: Profile = {
  id: 'demo',
  name: 'Demo Player',
  kind: 'self',
  // No accounts: the example never syncs.
  accounts: [],
  aliases: ['demo player'],
  createdAt: NOW - 120 * DAY,
  demo: true,
};

/** A few weeks of training on the top leaks: [days before NOW, grade] per card, oldest first. */
const HISTORY: readonly (readonly [number, Grade])[][] = [
  [
    [13, 'good'],
    [12, 'good'],
    [9, 'good'],
  ],
  [
    [11, 'again'],
    [11, 'hard'],
    [8, 'good'],
  ],
  [
    [7, 'good'],
    [6, 'good'],
  ],
  [
    [4, 'again'],
    [4, 'good'],
  ],
  [[2, 'good']],
  [[1, 'hard']],
];

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function importGames(): Promise<number> {
  const book = loadBook();
  const games = generateGames({ book, rep: buildRepertoire(book, SEED + 1), seed: SEED, count: GAMES, hero: PROFILE.name });
  const pgn = games.map(g => pgnGame(g, { utc: true })).join('\n');
  const r = await importPgnIntoProfile(PROFILE.id, pgn);
  if (r.added !== GAMES || r.unmatched > 0) throw new Error(`expected ${GAMES} games, imported ${JSON.stringify(r)}`);
  return r.added;
}

async function analyse(workers: number): Promise<{ positions: number; mistakes: number }> {
  const book = OpeningBook.fromJson(JSON.parse(readFileSync(OPENINGS, 'utf8')) as OpeningsJson);
  const pool = new EnginePool({ size: workers, createWorker: () => createNodeEngineWorker(), idleMs: Infinity });
  let shown = -1;
  try {
    const result = await analyzeProfile(PROFILE.id, {
      pool,
      book,
      now: () => NOW,
      onProgress: p => {
        const pct = p.weightTotal > 0 ? Math.floor((10 * p.weightDone) / p.weightTotal) * 10 : 0;
        if (p.phase === 'evaluating' && pct !== shown) {
          shown = pct;
          log(`  ${pct}% · ${p.donePositions}/${p.totalPositions} positions · ${p.mistakesFound} mistakes`);
        }
      },
    });
    if (!result.complete) throw new Error('the analysis left positions unevaluated');
    return result;
  } finally {
    pool.terminate();
  }
}

/** Reviews and attempts on the top leaks, one mastered leak and (if any) one book line kept as repertoire. */
async function addTraining(): Promise<{ reviews: number; attempts: number }> {
  const listed = applyFilters(await repo.getMistakes(PROFILE.id), DEFAULT_FILTERS, NOW).filter(m => m.kind === 'mistake' && m.confidence === 'normal');
  if (listed.length < HISTORY.length + 1) throw new Error(`only ${listed.length} leaks to train`);
  let attempts = 0;
  for (const [i, steps] of HISTORY.entries()) {
    const mistake: Mistake = listed[i]!;
    let review: ReviewState | undefined;
    for (const [k, [daysAgo, grade]] of steps.entries()) {
      // Same-day retries come a quarter of an hour apart.
      review = await recordGrade({ mistake, review, isNew: review === undefined }, grade, NOW - daysAgo * DAY + k * 15 * 60_000);
      attempts++;
    }
  }
  await repo.patchMistake(listed[HISTORY.length]!.id, { status: 'mastered' }, NOW - 3 * DAY);
  const book = (await repo.getMistakes(PROFILE.id)).find(m => m.kind === 'book' && m.status === 'active');
  if (book) await repo.patchMistake(book.id, { status: 'ignored', ignoreReason: 'repertoire' }, NOW - 5 * DAY);
  return { reviews: HISTORY.length, attempts };
}

export async function main(args: readonly string[]): Promise<void> {
  const flag = args.indexOf('--workers');
  const workers = Math.max(1, flag >= 0 ? Number(args[flag + 1]) || 1 : 2);
  const t0 = Date.now();
  useTestDb('chess-analyzer-demo-build');
  await repo.saveSettings({ preset: 'standard' });
  await getDb().profiles.put(PROFILE);

  log(`demo: importing ${GAMES} games of ${PROFILE.name}`);
  const games = await importGames();
  log(`demo: analysing with ${workers} engine(s), standard preset`);
  const { positions, mistakes } = await analyse(workers);
  const training = await addTraining();

  const backup: BackupFile = await exportBackup({ now: NOW });
  if (backup.evals !== undefined) throw new Error('the demo must not carry evals');
  const json = `${JSON.stringify(backup)}\n`;
  if (json.length > MAX_BYTES) throw new Error(`demo.json would be ${(json.length / 1024 / 1024).toFixed(2)} MB (limit 1.5 MB)`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);

  const kinds = new Map<string, number>();
  for (const m of backup.mistakes) {
    const label = m.kind === 'book' ? `book ${m.severity}` : m.severity;
    kinds.set(label, (kinds.get(label) ?? 0) + 1);
  }
  const bySeverity = [...kinds].map(([label, n]) => `${n} ${label}`).join(', ');
  log(
    `demo: ${games} games, ${positions} positions, ${mistakes} mistakes (${bySeverity}), ${training.reviews} reviews / ${training.attempts} attempts` +
      ` → ${OUT} (${(statSync(OUT).size / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
}
