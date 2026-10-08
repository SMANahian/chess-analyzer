// Fixture files written by scripts/gen-fixtures.mjs (see e2e/README.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posFromFen, posKey } from '../../src/core/chess';
import { shortId } from '../../src/core/hash';
import type { BackupFile } from '../../src/db/backup';

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export const fixturePath = (name: string): string => `${FIXTURES}${name}`;
export const readFixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');

export interface Planted {
  color: 'white' | 'black';
  line: string;
  ply: number;
  fen: string;
  epd: string;
  repertoire_move: string;
  move_uci: string;
  move_san: string;
  kind: 'hangs_material' | 'offbook';
  hangs?: 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen';
  hangs_value?: number;
  probability: number;
  times_reached: number;
  times_played: number;
}

interface GameSet {
  hero: string;
  count: number;
  first_created_at: number;
  last_created_at: number;
  planted: Planted[];
}

export interface Manifest {
  seed: number;
  lichess: GameSet & { file: string };
  chesscom: GameSet & { username: string; archives: string[]; skipped: number };
  pgn: GameSet & { file: string; skipped: number };
}

export const manifest = JSON.parse(readFixture('manifest.json')) as Manifest;

/** The leak's URL id, computed with the app's own position key and hash. */
export function plantedShortId(p: Planted): string {
  const pos = posFromFen(p.fen);
  if (!pos) throw new Error(`bad fixture FEN ${p.fen}`);
  return shortId(posKey(pos), p.move_uci);
}

/**
 * Planted deviations that hang a piece (not a pawn) and that the hero played in at least `minPlayed`
 * games: whatever else the engine thinks, these must be found, as blunders.
 */
export function plantedBlunders(set: GameSet, minPlayed = 3): Planted[] {
  return set.planted.filter(p => p.kind === 'hangs_material' && (p.hangs_value ?? 0) >= 3 && p.times_played >= minPlayed);
}

/** The Lichess export fixture, one parsed JSON object per game, newest first. */
export const lichessGames: Record<string, unknown>[] = readFixture('lichess-games.ndjson')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line) as Record<string, unknown>);

/** The bundled example report (public/demo/demo.json, built by `npm run build:demo`). */
export const demo = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/demo/demo.json', import.meta.url)), 'utf8')) as BackupFile;
