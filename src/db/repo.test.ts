import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { START_FEN } from '../core/chess';
import { toStoredGame } from '../core/games';
import { DEFAULT_SETTINGS, type StoredGame, type SyncState } from '../core/types';
import { rawGame, storedGame, testMistake } from '../services/__fixtures__/fakes';
import * as repo from './repo';
import { useTestDb } from './schema';

const SICILIAN = 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const NOW = Date.UTC(2026, 9, 8, 12);
const TRAP = 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#';

beforeEach(() => {
  useTestDb();
});

async function newSelf(): Promise<string> {
  return (await repo.createProfile({ name: 'Hero', kind: 'self', accounts: [{ platform: 'lichess', username: 'Hero' }], aliases: [] }, 5)).id;
}

function syncState(profileId: string, over: Partial<SyncState> = {}): SyncState {
  return { key: `${profileId}|lichess|hero`, profileId, platform: 'lichess', username: 'Hero', stored: 0, ...over };
}

/** The same quick trap (same players, day and moves) as a game of `platform` with id `id`. */
const game = (id: string, platform: 'lichess' | 'chesscom' | 'pgn', at = NOW) =>
  toStoredGame(rawGame({ id, sans: TRAP, white: 'Hero', black: 'Rival', playedAt: at, platform }), 'p1', 'white');

describe('settings and meta', () => {
  it('returns the defaults, then merges saved patches over them', async () => {
    expect(await repo.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await repo.saveSettings({ preset: 'quick' })).toEqual({ ...DEFAULT_SETTINGS, preset: 'quick' });
    await repo.saveSettings({ sessionSize: 20 });
    expect(await repo.getSettings()).toEqual({ ...DEFAULT_SETTINGS, preset: 'quick', sessionSize: 20 });
  });

  it('stores arbitrary meta values', async () => {
    expect(await repo.getMeta('job')).toBeUndefined();
    await repo.setMeta('job', { profileId: 'p', startedAt: 1 });
    expect(await repo.getMeta('job')).toEqual({ profileId: 'p', startedAt: 1 });
    await repo.deleteMeta('job');
    expect(await repo.getMeta('job')).toBeUndefined();
  });
});

describe('profiles', () => {
  it('creates profiles with distinct ids, lists them oldest first and updates them', async () => {
    const a = await repo.createProfile({ name: 'A', kind: 'self', accounts: [], aliases: [] }, 20);
    const b = await repo.createProfile({ name: 'B', kind: 'opponent', accounts: [], aliases: [] }, 10);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^me-/);
    expect(b.id).toMatch(/^op-/);
    expect((await repo.listProfiles()).map(p => p.name)).toEqual(['B', 'A']);
    await repo.updateProfile(a.id, { lastSyncAt: 99, name: 'A2' });
    expect(await repo.getProfile(a.id)).toMatchObject({ name: 'A2', lastSyncAt: 99, createdAt: 20 });
  });

  it('ensureSelfProfile creates the own profile once, even when called concurrently', async () => {
    const [a, b] = await Promise.all([
      repo.ensureSelfProfile({ name: 'A', accounts: [], aliases: [] }),
      repo.ensureSelfProfile({ name: 'B', accounts: [], aliases: [] }),
    ]);
    expect(a.id).toBe(b.id);
    expect((await repo.listProfiles()).filter(p => p.kind === 'self')).toHaveLength(1);
  });

  it('addAliases merges lower-cased names without duplicates', async () => {
    const id = await newSelf();
    await Promise.all([repo.addAliases(id, ['Hero ', 'ME']), repo.addAliases(id, ['me', 'other'])]);
    expect((await repo.getProfile(id))!.aliases.sort()).toEqual(['hero', 'me', 'other']);
    await repo.addAliases('missing', ['x']);
  });

  it('deleteProfile cascades to games, sync state, mistakes, reviews and attempts but keeps cached evals', async () => {
    const id = await newSelf();
    const other = await newSelf();
    await repo.addGames([storedGame(id, 'g1', SICILIAN, 'white', 1), storedGame(other, 'g1', SICILIAN, 'white', 1)], syncState(id));
    const m = testMistake(id, AFTER_E4, 'c7c5');
    await repo.upsertMistakes([m, testMistake(other, AFTER_E4, 'c7c5')]);
    await repo.putReview({ mistakeId: m.id, profileId: id, due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 });
    await repo.addAttempt({ mistakeId: m.id, profileId: id, at: 1, grade: 'good' });
    await repo.putEval({ key: 'e|k', posKey: 'k', fen: START_FEN, engine: 'e', depth: 10, best: { move: 'e2e4', score: { cp: 1 }, pv: ['e2e4'], depth: 10 }, moves: {}, updatedAt: 0 });

    await repo.deleteProfile(id);

    expect(await repo.getProfile(id)).toBeUndefined();
    expect(await repo.countGames(id)).toBe(0);
    expect(await repo.getSyncStates(id)).toEqual([]);
    expect(await repo.getMistakes(id)).toEqual([]);
    expect(await repo.getReviews(id)).toEqual([]);
    expect(await repo.getAttempts(id)).toEqual([]);
    expect(await repo.countGames(other)).toBe(1);
    expect(await repo.getMistakes(other)).toHaveLength(1);
    expect((await repo.getEvals(['e|k'])).size).toBe(1);
  });
});

describe('addGames', () => {
  it('is insert-only: an existing key is skipped and the stored row is not overwritten', async () => {
    const id = await newSelf();
    const g = storedGame(id, 'g1', SICILIAN, 'white', 1000);
    expect(await repo.addGames([g])).toBe(1);
    expect(await repo.addGames([{ ...g, opponent: 'changed' }])).toBe(0);
    expect((await repo.getGamesByKeys([g.key]))[0]!.opponent).toBe(g.opponent);
  });

  it('skips a game whose contentKey is already stored for the profile (same game from another source)', async () => {
    const id = await newSelf();
    const api = storedGame(id, 'abcdefgh', SICILIAN, 'white', Date.UTC(2024, 4, 1, 12));
    const fromPgn: StoredGame = { ...api, key: `${id}|pgn:ffff0000`, platform: 'pgn', sourceId: 'ffff0000' };
    expect(await repo.addGames([api])).toBe(1);
    expect(await repo.addGames([fromPgn])).toBe(0);
    // Another profile may store the same game.
    const other = await newSelf();
    expect(await repo.addGames([{ ...api, key: `${other}|lichess:abcdefgh`, profileId: other }])).toBe(1);
  });

  it('de-duplicates within one batch, by key and by contentKey', async () => {
    const id = await newSelf();
    const a = storedGame(id, 'a', SICILIAN, 'white', 1);
    const b = storedGame(id, 'b', 'd4 d5 c4', 'black', 2);
    const sameContent: StoredGame = { ...b, key: `${id}|pgn:x`, platform: 'pgn', sourceId: 'x' };
    expect(await repo.addGames([a, a, b, sameContent])).toBe(2);
    expect(await repo.countGames(id)).toBe(2);
  });

  it('writes the SyncState in the same transaction, with the number of games actually added', async () => {
    const id = await newSelf();
    const g1 = storedGame(id, 'g1', SICILIAN, 'white', 1);
    const g2 = storedGame(id, 'g2', 'd4 d5 c4', 'white', 2);
    await repo.addGames([g1]);
    const added = await repo.addGames([g1, g2], n => syncState(id, { stored: 10 + n, newestCreatedAt: 2 }));
    expect(added).toBe(1);
    expect(await repo.getSyncStates(id)).toEqual([syncState(id, { stored: 11, newestCreatedAt: 2 })]);
  });

  it('never moves the cursor when the games cannot be written', async () => {
    const id = await newSelf();
    await repo.putSyncState(syncState(id, { newestCreatedAt: 1 }));
    const good = storedGame(id, 'g1', SICILIAN, 'white', 1);
    const bad = { ...storedGame(id, 'g2', 'd4', 'white', 2), playedAt: Number.NaN, key: undefined } as unknown as StoredGame;
    await expect(repo.addGames([good, bad], syncState(id, { newestCreatedAt: 999 }))).rejects.toThrow();
    expect(await repo.countGames(id)).toBe(0);
    expect((await repo.getSyncStates(id))[0]!.newestCreatedAt).toBe(1);
  });

  it('getGames returns the profile games oldest first', async () => {
    const id = await newSelf();
    await repo.addGames([storedGame(id, 'b', SICILIAN, 'white', 20), storedGame(id, 'a', 'd4 d5', 'white', 10), storedGame(id, 'c', 'c4', 'white', 30)]);
    expect((await repo.getGames(id)).map(g => g.playedAt)).toEqual([10, 20, 30]);
  });

  it('deleteGamesOfPlatform only removes that platform', async () => {
    const id = await newSelf();
    const g = storedGame(id, 'a', SICILIAN, 'white', 1);
    await repo.addGames([g, { ...storedGame(id, 'b', 'd4', 'white', 2), key: `${id}|chesscom:live/1`, platform: 'chesscom', sourceId: 'live/1' }]);
    expect(await repo.deleteGamesOfPlatform(id, 'chesscom')).toBe(1);
    expect((await repo.getGames(id)).map(x => x.key)).toEqual([g.key]);
  });
});

describe('mistakes', () => {
  it('upsertMistakes keeps user decisions, createdAt and an earlier refutation, and clears dormant', async () => {
    const id = await newSelf();
    const refutation = { fen: START_FEN, posKey: 'k', bestMove: 'd7d5', bestLine: ['d7d5'], score: { cp: 50 }, acceptable: ['d7d5'], depth: 14 };
    const old = testMistake(id, AFTER_E4, 'c7c5', {
      status: 'ignored',
      ignoreReason: 'repertoire',
      snoozedUntil: 5000,
      dormant: true,
      refutation,
      createdAt: 1,
      count: 2,
    });
    await repo.upsertMistakes([old]);
    const fresh = testMistake(id, AFTER_E4, 'c7c5', { count: 7, createdAt: 900, updatedAt: 900 });
    const [stored] = await repo.upsertMistakes([fresh]);
    expect(stored).toMatchObject({ status: 'ignored', ignoreReason: 'repertoire', snoozedUntil: 5000, createdAt: 1, count: 7, updatedAt: 900, refutation });
    expect(stored!.dormant).toBeUndefined();
    expect(await repo.getMistakes(id)).toEqual([stored]);
  });

  it('upsertMistakes with keepLinks keeps a stored dependsOn when the fresh row has none; by default the fresh link is written as is', async () => {
    const id = await newSelf();
    const parent = testMistake(id, START_FEN, 'f2f3');
    await repo.upsertMistakes([testMistake(id, AFTER_E4, 'c7c5', { dependsOn: parent.id, count: 2 })]);
    const unlinked = testMistake(id, AFTER_E4, 'c7c5', { count: 5 });

    const [kept] = await repo.upsertMistakes([unlinked], { keepLinks: true });
    expect(kept).toMatchObject({ dependsOn: parent.id, count: 5 });
    expect((await repo.getMistakes(id))[0]!.dependsOn).toBe(parent.id);
    // A fresh link replaces the stored one either way.
    const [relinked] = await repo.upsertMistakes([{ ...unlinked, dependsOn: 'other' }], { keepLinks: true });
    expect(relinked!.dependsOn).toBe('other');

    // Without keepLinks (the linked rows of a complete analysis) a link that no longer applies is removed.
    const [cleared] = await repo.upsertMistakes([unlinked]);
    expect(cleared!.dependsOn).toBeUndefined();
    expect((await repo.getMistakes(id))[0]!.dependsOn).toBeUndefined();
  });

  it('upsertMistakes inserts new rows as given', async () => {
    const id = await newSelf();
    const m = testMistake(id, AFTER_E4, 'c7c5');
    expect(await repo.upsertMistakes([m])).toEqual([m]);
    expect(await repo.upsertMistakes([])).toEqual([]);
  });

  it('reconcileMistakes deletes rows without history and marks the others dormant', async () => {
    const id = await newSelf();
    const keep = testMistake(id, AFTER_E4, 'c7c5');
    const plain = testMistake(id, AFTER_E4, 'a7a6');
    const reviewed = testMistake(id, AFTER_E4, 'h7h6');
    const mastered = testMistake(id, AFTER_E4, 'g7g5', { status: 'mastered' });
    const snoozed = testMistake(id, AFTER_E4, 'f7f6', { snoozedUntil: 10 });
    const alreadyDormant = testMistake(id, AFTER_E4, 'b7b5', { status: 'ignored', dormant: true });
    await repo.upsertMistakes([keep, plain, reviewed, mastered, snoozed]);
    await repo.upsertMistakes([alreadyDormant]);
    await repo.putReview({ mistakeId: reviewed.id, profileId: id, due: 0, interval: 1, ease: 2.5, reps: 1, lapses: 0 });

    expect(await repo.reconcileMistakes(id, new Set([keep.id]))).toEqual({ deleted: 1, dormant: 3 });
    const rows = new Map((await repo.getMistakes(id)).map(m => [m.id, m]));
    expect(rows.has(plain.id)).toBe(false);
    expect(rows.get(keep.id)!.dormant).toBeUndefined();
    expect([reviewed, mastered, snoozed, alreadyDormant].map(m => rows.get(m.id)!.dormant)).toEqual([true, true, true, true]);
  });

  it('patchMistake applies a decision and removes fields set to undefined', async () => {
    const id = await newSelf();
    const m = testMistake(id, AFTER_E4, 'c7c5', { snoozedUntil: 50, ignoreReason: 'other' });
    await repo.upsertMistakes([m]);
    await repo.patchMistake(m.id, { status: 'mastered', snoozedUntil: undefined, ignoreReason: undefined }, 77);
    const [row] = await repo.getMistakes(id);
    expect(row).toMatchObject({ status: 'mastered', updatedAt: 77 });
    expect('snoozedUntil' in row!).toBe(false);
    expect('ignoreReason' in row!).toBe(false);
  });

  it('getMistakeByShortId finds a row, optionally within one profile', async () => {
    const a = await newSelf();
    const b = await newSelf();
    const ma = testMistake(a, AFTER_E4, 'c7c5');
    const mb = testMistake(b, AFTER_E4, 'c7c5');
    await repo.upsertMistakes([ma, mb]);
    expect(ma.shortId).toBe(mb.shortId);
    expect((await repo.getMistakeByShortId(ma.shortId, b))!.id).toBe(mb.id);
    expect(await repo.getMistakeByShortId(ma.shortId)).toBeDefined();
    expect(await repo.getMistakeByShortId('0000000000')).toBeUndefined();
  });
});

describe('reviews and attempts', () => {
  it('saveGrade writes the review and the attempt; getAttempts filters by time, oldest first', async () => {
    const id = await newSelf();
    const review = { mistakeId: 'm1', profileId: id, due: 10, interval: 1, ease: 2.5, reps: 1, lapses: 0 };
    await repo.saveGrade(review, { mistakeId: 'm1', profileId: id, at: 300, grade: 'good' });
    await repo.addAttempt({ mistakeId: 'm1', profileId: id, at: 100, grade: 'again' });
    await repo.addAttempt({ mistakeId: 'm2', profileId: 'someone-else', at: 200, grade: 'good' });
    expect(await repo.getReviews(id)).toEqual([review]);
    expect((await repo.getAttempts(id)).map(a => a.at)).toEqual([100, 300]);
    expect((await repo.getAttempts(id, 200)).map(a => a.grade)).toEqual(['good']);
    expect(typeof (await repo.getAttempts(id))[0]!.id).toBe('number');
  });

  it('tableCounts reports every table', async () => {
    const id = await newSelf();
    await repo.addGames([storedGame(id, 'g', SICILIAN, 'white', 1)]);
    expect(await repo.tableCounts()).toMatchObject({ profiles: 1, games: 1, mistakes: 0, evals: 0, meta: 0 });
  });
});

describe('deleteGamesOfAccount', () => {
  it('removes only the games that account played on its site, either colour', async () => {
    const asBlack = toStoredGame(rawGame({ id: 'b0000001', sans: 'd4 d5', white: 'Rival', black: 'HERO', playedAt: NOW, platform: 'lichess' }), 'p1', 'black');
    const otherAccount = toStoredGame(rawGame({ id: 'o0000001', sans: 'c4', white: 'hero2', black: 'Rival', playedAt: NOW, platform: 'lichess' }), 'p1', 'white');
    const sameNameElsewhere = toStoredGame(rawGame({ id: 'live/9', sans: 'e4', white: 'hero', black: 'x', playedAt: NOW, platform: 'chesscom' }), 'p1', 'white');
    await repo.addGames([game('aaaaaaaa', 'lichess'), asBlack, otherAccount, sameNameElsewhere]);
    expect(await repo.deleteGamesOfAccount('p1', { platform: 'lichess', username: ' Hero ' })).toBe(2);
    expect((await repo.getGames('p1')).map(g => g.sourceId).sort()).toEqual(['live/9', 'o0000001']);
  });
});

describe('contentKey de-duplication is cross-source only', () => {
  it('keeps two different games of one site with the same players, day and moves (a quick rematch)', async () => {
    expect(await repo.addGames([game('aaaaaaaa', 'lichess'), game('bbbbbbbb', 'lichess', NOW + 60_000)])).toBe(2);
    expect(await repo.addGames([game('cccccccc', 'lichess', NOW + 120_000)])).toBe(1);
    expect(await repo.countGames('p1')).toBe(3);
  });

  it('still stores a game once when it comes from a PGN file and from a site', async () => {
    expect(await repo.addGames([game('aaaaaaaa', 'lichess')])).toBe(1);
    expect(await repo.addGames([game('f00dfeedf00dfeed', 'pgn')])).toBe(0);
    // And the other way round, also within one batch.
    useTestDb();
    expect(await repo.addGames([game('f00dfeedf00dfeed', 'pgn'), game('live/1', 'chesscom')])).toBe(1);
    expect(await repo.addGames([game('f00dfeedf00dfeed', 'pgn')])).toBe(0);
  });
});
