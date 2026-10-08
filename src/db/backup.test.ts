import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from '../core/chess';
import { DEFAULT_SETTINGS, type PositionEval } from '../core/types';
import { winLoss } from '../core/winrate';
import { setLichessCooldown } from '../sources/http';
import { FakeLichess, lichessLine, storedGame, testMistake } from '../services/__fixtures__/fakes';
import { syncProfile } from '../services/sync';
import { LEGACY_ENGINE, clearAllData, exportBackup, importBackup, legacyMistake, type BackupFile } from './backup';
import * as repo from './repo';
import { getDb, useTestDb } from './schema';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
/** White to move, both sides can castle short (1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.d3 Nf6). */
const ITALIAN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5';
const NOW = Date.UTC(2026, 9, 8, 12);
const fenAt = (sans: string): string => sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN);

beforeEach(() => {
  useTestDb();
});

const anEval = (key: string): PositionEval => ({
  key: `sf|${key}`,
  posKey: key,
  fen: START_FEN,
  engine: 'sf',
  depth: 14,
  best: { move: 'e2e4', score: { cp: 30 }, pv: ['e2e4'], depth: 14 },
  moves: {},
  updatedAt: 1,
});

async function populate(): Promise<{ self: string; scout: string }> {
  const self = (await repo.createProfile({ name: 'Hero', kind: 'self', accounts: [{ platform: 'lichess', username: 'Hero' }], aliases: ['hero'] }, 1)).id;
  const scout = (await repo.createProfile({ name: 'Rival', kind: 'opponent', accounts: [{ platform: 'chesscom', username: 'Rival' }], aliases: [] }, 2)).id;
  await repo.addGames([storedGame(self, 'g1', 'e4 e5 Nf3', 'white', 10), storedGame(scout, 'g2', 'd4 d5', 'black', 20)], {
    key: `${self}|lichess|hero`,
    profileId: self,
    platform: 'lichess',
    username: 'Hero',
    stored: 1,
    newestCreatedAt: 10,
  });
  const m = testMistake(self, AFTER_E4, 'c7c5');
  await repo.upsertMistakes([m, testMistake(scout, AFTER_E4, 'a7a6')]);
  await repo.saveGrade({ mistakeId: m.id, profileId: self, due: 5, interval: 1, ease: 2.5, reps: 1, lapses: 0 }, { mistakeId: m.id, profileId: self, at: 4, grade: 'good' });
  await repo.saveSettings({ preset: 'thorough', sessionSize: 15 });
  await repo.putEval(anEval('k1'));
  return { self, scout };
}

const comparable = (b: BackupFile): unknown => ({
  ...b,
  exportedAt: 0,
  attempts: b.attempts.map(({ id: _id, ...a }) => a),
});

describe('v3 export / import', () => {
  it('round-trips every table', async () => {
    await populate();
    const exported = await exportBackup({ includeEvals: true, now: 42 });
    expect(exported).toMatchObject({ app: 'chess-analyzer', version: 3, exportedAt: 42 });
    expect(exported.profiles).toHaveLength(2);
    expect(exported.settings).toEqual({ ...DEFAULT_SETTINGS, preset: 'thorough', sessionSize: 15 });
    expect(exported.evals).toHaveLength(1);

    await clearAllData();
    expect(await repo.listProfiles()).toEqual([]);

    const json: unknown = JSON.parse(JSON.stringify(exported));
    expect(await importBackup(json)).toEqual({ profiles: 2, games: 2, mistakes: 2 });
    expect(comparable(await exportBackup({ includeEvals: true }))).toEqual(comparable(exported));
  });

  it('leaves evals out unless asked', async () => {
    await populate();
    expect((await exportBackup()).evals).toBeUndefined();
  });

  it('replaces existing data but keeps the eval cache', async () => {
    const { self } = await populate();
    const backup = await exportBackup();
    // Changes after the backup are discarded by the import.
    await repo.createProfile({ name: 'Extra', kind: 'opponent', accounts: [], aliases: [] });
    await repo.upsertMistakes([testMistake(self, AFTER_E4, 'h7h6')]);
    await repo.putEval(anEval('k2'));
    await importBackup(backup);
    expect((await repo.listProfiles()).map(p => p.name)).toEqual(['Hero', 'Rival']);
    expect(await repo.getMistakes(self)).toHaveLength(1);
    expect((await repo.getEvals(['sf|k1', 'sf|k2'])).size).toBe(2);
  });

  it('rejects malformed files without touching the database', async () => {
    const { self } = await populate();
    const good = await exportBackup();
    const cases: [unknown, RegExp][] = [
      [null, /not a Chess Analyzer backup/],
      [{ hello: 1 }, /not a Chess Analyzer backup/],
      [{ ...good, version: 4 }, /version 4/],
      [{ ...good, games: 'nope' }, /"games"/],
      [{ ...good, mistakes: [...good.mistakes, { id: 'x' }] }, /mistakes\[2\]/],
      [{ ...good, games: [...good.games, { ...good.games[0]!, key: 'z', profileId: 'ghost' }] }, /belongs to no profile/],
      [{ ...good, profiles: [...good.profiles, { ...good.profiles[0]!, id: 'second-self' }] }, /more than one own profile/],
    ];
    for (const [data, message] of cases) await expect(importBackup(data)).rejects.toThrow(message);
    expect(await repo.getMistakes(self)).toHaveLength(1);
    expect(await repo.listProfiles()).toHaveLength(2);
  });

  it('is all-or-nothing when a write fails half-way', async () => {
    const { self } = await populate();
    const good = await exportBackup();
    // Two attempts are fine; two mistakes with the same id make bulkAdd fail after the clear.
    const broken = { ...good, mistakes: [...good.mistakes, good.mistakes[0]!] };
    await expect(importBackup(broken)).rejects.toThrow();
    expect(await repo.getMistakes(self)).toHaveLength(1);
    expect(await repo.countGames(self)).toBe(1);
  });

  it('merge mode replaces only the backup profiles and can import them as another kind', async () => {
    const source = await populate();
    const demo = await exportBackup();
    await clearAllData();
    const mine = (await repo.createProfile({ name: 'Me', kind: 'self', accounts: [], aliases: [] })).id;
    await repo.saveSettings({ sessionSize: 3 });

    await expect(importBackup(demo, { mode: 'merge' })).rejects.toThrow(/already an own profile/);
    expect(await repo.listProfiles()).toHaveLength(1);

    expect(await importBackup(demo, { mode: 'merge', asKind: 'opponent', demo: true })).toEqual({ profiles: 2, games: 2, mistakes: 2 });
    const profiles = await repo.listProfiles();
    expect(profiles.map(p => [p.name, p.kind, p.demo === true])).toEqual([
      ['Hero', 'opponent', true],
      ['Rival', 'opponent', true],
      ['Me', 'self', false],
    ]);
    expect((await repo.getSettings()).sessionSize).toBe(3);
    expect(await repo.getMistakes(source.self)).toHaveLength(1);

    // Importing again replaces the earlier copy instead of duplicating it.
    await importBackup(demo, { mode: 'merge', asKind: 'opponent' });
    expect(await repo.listProfiles()).toHaveLength(3);
    expect(await repo.getAttempts(source.self)).toHaveLength(1);
    expect(await repo.getMistakes(mine)).toEqual([]);
  });
});

describe('legacy v2 import', () => {
  const legacyRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1,
    color: 'black',
    fen: AFTER_E4,
    user_move: 'f7f6',
    top_moves: ['c7c5', 'e7e5', 'f7f6'],
    avg_cp_loss: 180,
    pair_count: 4,
    mastered: false,
    mastered_at: null,
    snoozed: false,
    snoozed_at: null,
    opening_eco: 'B00',
    opening_name: "King's Pawn Game",
    analyzed_at: '2025-03-01T10:00:00',
    move_list: 'e2e4',
    ...over,
  });

  it('maps a v2 mistake to a v3 Mistake', () => {
    const m = legacyMistake(legacyRow(), 'p1', NOW)!;
    const key = posKey(posFromFen(AFTER_E4)!);
    const loss = winLoss({ cp: 0 }, { cp: -180 });
    expect(m).toMatchObject({
      id: `p1|${key}|f7f6`,
      profileId: 'p1',
      posKey: key,
      color: 'black',
      move: 'f7f6',
      bestMove: 'c7c5',
      acceptable: ['c7c5', 'e7e5'],
      count: 4,
      ply: 1,
      path: ['e2e4'],
      kind: 'mistake',
      status: 'active',
      engine: LEGACY_ENGINE,
      openingEco: 'B00',
      openingName: "King's Pawn Game",
      createdAt: Date.parse('2025-03-01T10:00:00'),
      updatedAt: NOW,
    });
    expect(m.winLoss).toBeCloseTo(loss, 6);
    expect(m.severity).toBe('blunder');
    expect(m.confidence).toBe('normal');
    expect(m.occurrences).toHaveLength(4);
    expect(m.occurrences.every(o => o.m === 'f7f6' && o.s === 'unknown')).toBe(true);
    expect(m.impact).toBeGreaterThan(0);
  });

  it('maps small losses to low-confidence inaccuracies, mastered and snoozed rows, and castling', () => {
    expect(legacyMistake(legacyRow({ avg_cp_loss: 55 }), 'p', NOW)).toMatchObject({ severity: 'inaccuracy', confidence: 'low' });
    expect(legacyMistake(legacyRow({ mastered: true }), 'p', NOW)!.status).toBe('mastered');
    expect(legacyMistake(legacyRow({ snoozed: 1 }), 'p', NOW)).toMatchObject({ status: 'active', snoozedUntil: NOW + 30 * 86_400_000 });
    const castle = legacyMistake(legacyRow({ fen: ITALIAN, user_move: 'e1h1', top_moves: ['c2c3'], move_list: '' }), 'p', NOW)!;
    expect(castle).toMatchObject({ move: 'e1g1', color: 'white', ply: 8, path: [] });
  });

  it('skips rows it cannot map', () => {
    expect(legacyMistake(legacyRow({ fen: 'garbage' }), 'p', NOW)).toBeNull();
    expect(legacyMistake(legacyRow({ user_move: 'e2e4' }), 'p', NOW)).toBeNull(); // illegal for Black
    expect(legacyMistake(legacyRow({ top_moves: ['f7f6'] }), 'p', NOW)).toBeNull(); // no best move besides the habit
    expect(legacyMistake('nope', 'p', NOW)).toBeNull();
    // A path that does not lead to the position is dropped, the mistake is kept.
    expect(legacyMistake(legacyRow({ move_list: 'd2d4' }), 'p', NOW)!.path).toEqual([]);
  });

  it('creates an "Imported" own profile with the synced accounts', async () => {
    const backup = {
      backup_version: 2,
      created_at: '2025-03-02T00:00:00',
      mistakes: [legacyRow(), legacyRow({ id: 2 }), legacyRow({ id: 3, fen: 'bad' }), legacyRow({ id: 4, user_move: 'g7g5', mastered: true })],
      sync_configs: [
        { color: 'white', platform: 'lichess', username: 'Hero' },
        { color: 'black', platform: 'lichess', username: 'hero' },
        { color: 'white', platform: 'chesscom', username: 'HeroCC' },
      ],
      pgn_files: [],
    };
    expect(await importBackup(backup, { now: NOW })).toEqual({ profiles: 1, games: 0, mistakes: 2 });
    const [profile] = await repo.listProfiles();
    expect(profile).toMatchObject({
      name: 'Imported',
      kind: 'self',
      accounts: [
        { platform: 'lichess', username: 'Hero' },
        { platform: 'chesscom', username: 'HeroCC' },
      ],
    });
    const ms = await repo.getMistakes(profile!.id);
    expect(ms.map(m => [m.move, m.status]).sort()).toEqual([
      ['f7f6', 'active'],
      ['g7g5', 'mastered'],
    ]);
  });

  it('merges into an existing own profile without overwriting its mistakes', async () => {
    const self = (await repo.createProfile({ name: 'Me', kind: 'self', accounts: [{ platform: 'lichess', username: 'hero' }], aliases: [] })).id;
    const existing = testMistake(self, AFTER_E4, 'f7f6', { count: 9 });
    await repo.upsertMistakes([existing]);
    const backup = { backup_version: 2, mistakes: [legacyRow(), legacyRow({ user_move: 'g7g5' })], sync_configs: [{ platform: 'chesscom', username: 'X' }] };
    expect(await importBackup(backup, { now: NOW })).toEqual({ profiles: 0, games: 0, mistakes: 1 });
    const profiles = await repo.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.accounts).toEqual([
      { platform: 'lichess', username: 'hero' },
      { platform: 'chesscom', username: 'X' },
    ]);
    const ms = await repo.getMistakes(self);
    expect(ms).toHaveLength(2);
    expect(ms.find(m => m.move === 'f7f6')!.count).toBe(9);
  });
});

describe('clearAllData', () => {
  it('empties every table, settings included', async () => {
    await populate();
    await clearAllData();
    expect(Object.values(await repo.tableCounts()).every(n => n === 0)).toBe(true);
    expect(await repo.getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

interface V2Game {
  id?: string;
  white: string;
  black: string;
  date: string;
  time: string;
  sans: string;
  result: string;
}

/** A game as the old app stored it: Lichess exports keep their Site link, uploaded OTB games do not. */
function v2Pgn(g: V2Game): string {
  const movetext = g.sans
    .split(' ')
    .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san))
    .join(' ');
  return [
    `[Event "${g.id ? 'Rated Blitz game' : 'Club match'}"]`,
    `[Site "${g.id ? `https://lichess.org/${g.id}` : 'Dhaka BAN'}"]`,
    `[Date "${g.date}"]`,
    `[White "${g.white}"]`,
    `[Black "${g.black}"]`,
    `[Result "${g.result}"]`,
    `[UTCDate "${g.date}"]`,
    `[UTCTime "${g.time}"]`,
    '[WhiteElo "1500"]',
    '[BlackElo "1480"]',
    '[TimeControl "180+2"]',
    '',
    `${movetext} ${g.result}`,
    '',
  ].join('\n');
}

const WHITE_GAMES: V2Game[] = [
  { id: 'abcd1234', white: 'hero', black: 'rival1', date: '2025.03.01', time: '10:00:00', sans: 'e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5', result: '0-1' },
  { id: 'efgh5678', white: 'hero', black: 'rival2', date: '2025.03.02', time: '11:30:00', sans: 'e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5', result: '0-1' },
  { white: 'hero', black: 'Rahman, Karim', date: '2025.02.20', time: '15:00:00', sans: 'e4 c6 d4 d5 e5 Bf5', result: '1/2-1/2' },
];
const BLACK_GAMES: V2Game[] = [{ id: 'ijkl9012', white: 'rival3', black: 'hero', date: '2025.03.03', time: '09:15:00', sans: 'd4 Nf6 c4 c5 d5 e6', result: '1-0' }];

const TRAP = fenAt('e4 e5 Nf3 Nc6 Bc4 Nd4');

/** Shaped like chess_analyzer/db.py export_backup(): every column of every table, as the old app wrote it. */
function realisticV2Backup(): Record<string, unknown> {
  const mistake = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 1,
    color: 'white',
    fen: TRAP,
    user_move: 'f3e5',
    top_moves: ['f3d4', 'e1g1'],
    avg_cp_loss: 240,
    pair_count: 2,
    mastered: false,
    mastered_at: null,
    snoozed: false,
    snoozed_at: null,
    opening_eco: 'C50',
    opening_name: 'Italian Game: Blackburne-Kostić Gambit',
    analyzed_at: '2025-03-04T08:00:00.123456+00:00',
    ...over,
  });
  return {
    backup_version: 2,
    created_at: '2025-03-05T12:00:00.654321+00:00',
    schema_version: 9,
    pgn_files: [
      { color: 'black', content: BLACK_GAMES.map(v2Pgn).join('\n'), game_count: 1, uploaded_at: '2025-03-04T07:00:00+00:00' },
      { color: 'white', content: `﻿${WHITE_GAMES.map(v2Pgn).join('\r\n')}`, game_count: 3, uploaded_at: '2025-03-04T07:00:00+00:00' },
    ],
    mistakes: [
      mistake({}),
      mistake({ id: 2, color: 'black', fen: AFTER_E4, user_move: 'f7f6', top_moves: ['c7c5', 'e7e5'], avg_cp_loss: 95, pair_count: 7, mastered: true, mastered_at: '2025-03-04T09:00:00+00:00' }),
      mistake({ id: 3, color: 'black', fen: AFTER_E4, user_move: 'g7g5', top_moves: ['e7e5'], avg_cp_loss: 160, snoozed: true, snoozed_at: '2025-03-04T09:00:00+00:00' }),
      // An old-format row the importer cannot map (python-chess FEN with a bad move): skipped, not fatal.
      mistake({ id: 4, user_move: 'e2e5' }),
    ],
    sync_configs: [
      { color: 'white', platform: 'lichess', username: 'Hero', last_synced_at: '2025-03-04T07:00:00+00:00', created_at: '2025-01-01T00:00:00+00:00' },
      { color: 'black', platform: 'lichess', username: 'hero', last_synced_at: null, created_at: '2025-01-01T00:00:00+00:00' },
    ],
    synced_game_ids: [{ platform: 'lichess', username: 'Hero', game_id: 'abcd1234', color: 'white', added_at: '2025-03-04T07:00:00+00:00' }],
    practice_sessions: [{ color: 'white', correct: 3, total: 5, best_streak: 2, started_at: '2025-03-04T10:00:00+00:00', finished_at: '2025-03-04T10:05:00+00:00' }],
  };
}

describe('legacy v2 backup from the old app', () => {
  beforeEach(() => {
    setLichessCooldown(0);
  });

  it('restores the accounts, the games of both colours and the mistakes; a later sync adds no duplicates', async () => {
    expect(await importBackup(realisticV2Backup(), { now: NOW })).toEqual({ profiles: 1, games: 4, mistakes: 3 });
    const [profile] = await repo.listProfiles();
    expect(profile).toMatchObject({ kind: 'self', name: 'Imported', accounts: [{ platform: 'lichess', username: 'Hero' }] });
    const games = await repo.getGames(profile!.id);
    expect(games.map(g => [g.platform, g.sourceId.slice(0, 8), g.color, g.outcome])).toEqual([
      ['pgn', expect.any(String), 'white', 'draw'],
      ['lichess', 'abcd1234', 'white', 'loss'],
      ['lichess', 'efgh5678', 'white', 'loss'],
      ['lichess', 'ijkl9012', 'black', 'loss'],
    ]);
    const ms = new Map((await repo.getMistakes(profile!.id)).map(m => [m.move, m]));
    expect(ms.get('f3e5')).toMatchObject({ status: 'active', engine: LEGACY_ENGINE, bestMove: 'f3d4', color: 'white', count: 2 });
    expect(ms.get('f7f6')!.status).toBe('mastered');
    expect(ms.get('g7g5')!.snoozedUntil).toBeGreaterThan(NOW);
    expect(ms.get('f3e5')!.createdAt).toBe(Date.parse('2025-03-04T08:00:00.123Z'));

    // The same Lichess games from the API are recognised by their id.
    const api = [
      lichessLine({ id: 'abcd1234', createdAt: Date.UTC(2025, 2, 1, 10), white: 'Hero', black: 'rival1', moves: WHITE_GAMES[0]!.sans, winner: 'black' }),
      lichessLine({ id: 'ijkl9012', createdAt: Date.UTC(2025, 2, 3, 9, 15), white: 'rival3', black: 'Hero', moves: BLACK_GAMES[0]!.sans, winner: 'white' }),
    ];
    const r = await syncProfile(profile!.id, { fetchImpl: new FakeLichess(api).fetchImpl, now: () => NOW });
    expect(r).toMatchObject({ added: 0, errors: [] });
    expect(await repo.countGames(profile!.id)).toBe(4);
  });

  it('a damaged games blob does not stop the mistakes from being imported', async () => {
    const backup = { ...realisticV2Backup(), pgn_files: [{ color: 'white', content: '[Event "x"]\n\n1. e4 e5 2. Ke3?? Qh4 *' }, { color: 'purple', content: 7 }] };
    const result = await importBackup(backup, { now: NOW });
    expect(result).toMatchObject({ mistakes: 3 });
    expect(result.games).toBeLessThanOrEqual(1);
  });
});

describe('export with rows of a deleted profile', () => {
  it('leaves orphan rows out, so the file can be restored', async () => {
    const self = (await repo.createProfile({ name: 'Me', kind: 'self', accounts: [], aliases: [] })).id;
    await repo.addGames([storedGame(self, 'g1', 'e4 e5', 'white', NOW)]);
    // Rows an interrupted job wrote after its profile was deleted (an older version could do that).
    await getDb().mistakes.put(testMistake('gone', AFTER_E4, 'f7f6'));
    await repo.addGames([storedGame('gone', 'g2', 'd4 d5', 'white', NOW)]);
    const file = await exportBackup({ now: NOW });
    expect(file.mistakes).toEqual([]);
    expect(file.games.map(g => g.profileId)).toEqual([self]);
    await expect(importBackup(JSON.parse(JSON.stringify(file)))).resolves.toMatchObject({ profiles: 1, games: 1, mistakes: 0 });
  });
});

describe('positions', () => {
  it('the imported mistake has the same id as one the new analysis would produce (merging keeps its status)', async () => {
    await importBackup(realisticV2Backup(), { now: NOW });
    const [profile] = await repo.listProfiles();
    const m = (await repo.getMistakes(profile!.id)).find(x => x.move === 'f7f6')!;
    expect(m.id).toBe(`${profile!.id}|${posKey(posFromFen(AFTER_E4)!)}|f7f6`);
  });
});
