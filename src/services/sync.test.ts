import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, SyncProgress, SyncState } from '../core/types';
import * as repo from '../db/repo';
import { useTestDb } from '../db/schema';
import { setLichessCooldown } from '../sources/http';
import { fixture } from '../sources/__fixtures__/testing';
import { FakeChesscom, FakeLichess, chesscomGame, combinedFetch, lichessHistory, lichessLine } from './__fixtures__/fakes';
import { CHUNK_SIZE, LICHESS_OVERLAP_MS, importPgnIntoProfile, syncProfile } from './sync';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
const now = (): number => NOW;
const HERO: Account = { platform: 'lichess', username: 'Hero' };

beforeEach(() => {
  useTestDb();
  setLichessCooldown(0);
});
afterEach(() => setLichessCooldown(0));

async function profileWith(accounts: Account[], aliases: string[] = []): Promise<string> {
  return (await repo.createProfile({ name: 'Hero', kind: 'self', accounts, aliases })).id;
}

/** Stored source ids (without the profile prefix), sorted. */
async function storedIds(profileId: string): Promise<string[]> {
  return (await repo.getGames(profileId)).map(g => `${g.platform}:${g.sourceId}`).sort();
}

async function stateOf(profileId: string): Promise<SyncState> {
  const [state] = await repo.getSyncStates(profileId);
  return state!;
}

/** Ids of the non-aborted games of `user` created in [from, to]. */
function expectedIds(lines: Record<string, unknown>[], from: number, to: number): string[] {
  return lines
    .filter(g => g.status !== 'aborted' && (g.createdAt as number) >= from && (g.createdAt as number) <= to)
    .map(g => `lichess:${g.id as string}`)
    .sort();
}

const createdAtOf = (lines: Record<string, unknown>[]): number[] => lines.map(g => g.createdAt as number);
/** The game export requests (the run may also look up the account's game count). */
const exportsOf = (fake: FakeLichess): URL[] => fake.requests.filter(u => u.pathname.startsWith('/api/games/user/'));

describe('Lichess sync', () => {
  it('first sync: newest games first, capped by the limit; the cursor covers every received line', async () => {
    const history = lichessHistory('Hero', 40, NOW - DAY);
    const fake = new FakeLichess(history);
    const id = await profileWith([HERO]);
    const result = await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 30 });

    const url = exportsOf(fake)[0]!;
    expect(url.pathname).toBe('/api/games/user/Hero');
    expect(url.searchParams.get('sort')).toBe('dateDesc');
    expect(url.searchParams.get('max')).toBe('30');
    const newest30 = history.slice(0, 30);
    // Lines 6, 13, 20 and 27 are aborted games: received (the cursor covers them) but not stored.
    expect(result).toEqual({ added: 26, unmatched: 0, errors: [] });
    expect(await storedIds(id)).toEqual(expectedIds(history, -Infinity, Infinity).filter(k => newest30.some(g => `lichess:${g.id as string}` === k)));
    expect(await stateOf(id)).toMatchObject({
      newestCreatedAt: Math.max(...createdAtOf(newest30)),
      oldestCreatedAt: Math.min(...createdAtOf(newest30)),
      stored: 26,
      lastSyncAt: NOW,
    });
    expect((await stateOf(id)).reachedStart).toBeUndefined();
    expect((await repo.getProfile(id))!.lastSyncAt).toBe(NOW);
  });

  it('marks reachedStart when the history ends before the limit, and then only syncs forward', async () => {
    const history = lichessHistory('Hero', 12, NOW - DAY);
    const fake = new FakeLichess(history);
    const id = await profileWith([HERO]);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect((await stateOf(id)).reachedStart).toBe(true);

    fake.requests.length = 0;
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect(fake.requests).toHaveLength(1);
    const forward = fake.requests[0]!.searchParams;
    expect(forward.get('sort')).toBe('dateAsc');
    expect(Number(forward.get('since'))).toBe(NOW - DAY - LICHESS_OVERLAP_MS);
  });

  it('resumes an interrupted run without gaps: the result equals an uninterrupted run (incl. new games in between)', async () => {
    const history = lichessHistory('Hero', 250, NOW - 10 * DAY);
    const later = lichessHistory('Hero', 6, NOW - DAY, { idPrefix: 'n' });

    // Uninterrupted reference: everything at once, after the new games were played.
    const reference = await profileWith([HERO]);
    await syncProfile(reference, { fetchImpl: new FakeLichess([...history, ...later]).fetchImpl, now });

    // Interrupted in the first pass (after 130 lines), new games, then a network break during the backfill.
    const fake = new FakeLichess(history);
    const id = await profileWith([HERO]);
    fake.breakAfter = 130;
    const first = await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect(first.errors.map(e => e.kind)).toEqual(['network']);
    const afterBreak = await stateOf(id);
    expect(afterBreak.lastError).toMatch(/connection was lost/);
    // The 130 lines received before the break are stored, with a cursor that matches them exactly.
    expect(await storedIds(id)).toEqual(expectedIds(history, afterBreak.oldestCreatedAt!, afterBreak.newestCreatedAt!));
    expect(afterBreak.oldestCreatedAt).toBe(history[129]!.createdAt);

    fake.games = [...history, ...later];
    fake.requests.length = 0;
    // The forward pass returns the 6 new games plus the overlap; the backfill breaks after 50 lines.
    fake.override = url => {
      if (url.searchParams.get('sort') === 'dateDesc') fake.breakAfter = 50;
      return undefined;
    };
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    fake.override = null;
    expect(exportsOf(fake).map(u => u.searchParams.get('sort'))).toEqual(['dateAsc', 'dateDesc']);
    const third = await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect(third.errors).toEqual([]);

    expect(await storedIds(id)).toEqual(await storedIds(reference));
    const [a, b] = [await stateOf(id), await stateOf(reference)];
    expect(a).toMatchObject({ newestCreatedAt: b.newestCreatedAt, oldestCreatedAt: b.oldestCreatedAt, stored: b.stored, reachedStart: true });
    expect(a.lastError).toBeUndefined();
  });

  it('an aborted run keeps what it received and resumes from there', async () => {
    const history = lichessHistory('Hero', 120, NOW - DAY);
    const fake = new FakeLichess(history);
    const id = await profileWith([HERO]);
    const controller = new AbortController();
    const progress: SyncProgress[] = [];
    const run = syncProfile(id, {
      fetchImpl: fake.fetchImpl,
      now,
      signal: controller.signal,
      onProgress: p => {
        progress.push(p);
        if (p.fetched >= 105 && !controller.signal.aborted) controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress.at(-1)!.phase).toBe('cancelled');
    const state = await stateOf(id);
    expect(await storedIds(id)).toEqual(expectedIds(history, state.oldestCreatedAt!, state.newestCreatedAt!));
    expect(state.stored).toBe((await storedIds(id)).length);

    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect(await storedIds(id)).toEqual(expectedIds(history, -Infinity, Infinity));
  });

  it('a capped forward pass never leaves a gap: many new games arrive over several runs', async () => {
    await repo.saveSettings({ gamesPerAccount: 20 });
    const old = lichessHistory('Hero', 60, NOW - 100 * DAY);
    const fake = new FakeLichess(old);
    const id = await profileWith([HERO]);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    // 70 new games, 2 hours apart (many inside the 3-day overlap window).
    const fresh = lichessHistory('Hero', 70, NOW - DAY, { idPrefix: 'n', spacingMs: 2 * 3_600_000 });
    fake.games = [...old, ...fresh];
    for (let i = 0; i < 6; i++) await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    const state = await stateOf(id);
    expect(state.newestCreatedAt).toBe(fresh[0]!.createdAt);
    // Contiguous: every game inside the covered interval is stored.
    expect(await storedIds(id)).toEqual(expectedIds(fake.games, state.oldestCreatedAt!, state.newestCreatedAt!));
  });

  it('after a break with more new games than the run limit, the forward pass still reaches the newest game', async () => {
    const HOUR = 3_600_000;
    const T0 = NOW - 200 * DAY;
    const old = lichessHistory('Hero', 1000, T0, { idPrefix: 'o', spacingMs: HOUR });
    const fake = new FakeLichess(old);
    const id = await profileWith([HERO]);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now: () => T0 + HOUR });
    // A long break: 2,500 new games, the newest an hour ago; the default limit is 1,000 per run.
    const fresh = lichessHistory('Hero', 2500, NOW - HOUR, { idPrefix: 'n', spacingMs: 10 * 60_000 });
    fake.games = [...old, ...fresh];
    fake.requests.length = 0;
    const result = await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect(result.errors).toEqual([]);

    const games = await repo.getGames(id);
    expect(NOW - games.at(-1)!.playedAt).toBeLessThan(2 * HOUR);
    const state = await stateOf(id);
    expect(state.newestCreatedAt).toBe(fresh[0]!.createdAt);
    // No gap: every new game (and every game in the covered interval) is stored.
    const ids = await storedIds(id);
    expect(ids.filter(k => k.startsWith('lichess:n'))).toEqual(expectedIds(fresh, -Infinity, Infinity));
    expect(ids).toEqual(expectedIds(fake.games, state.oldestCreatedAt!, state.newestCreatedAt!));
    // Pages of the run limit, each continuing after the last game of the one before.
    const forward = exportsOf(fake).map(u => u.searchParams);
    expect(forward.every(q => q.get('sort') === 'dateAsc' && q.get('max') === '1000')).toBe(true);
    expect(forward.length).toBeGreaterThanOrEqual(3);
    expect(state.lastSyncAt).toBe(NOW);
  });

  it('backfills older games when gamesPerAccount is raised, until the history starts', async () => {
    await repo.saveSettings({ gamesPerAccount: 30 });
    const history = lichessHistory('Hero', 100, NOW - DAY);
    const fake = new FakeLichess(history);
    const id = await profileWith([HERO]);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect((await stateOf(id)).stored).toBeLessThanOrEqual(30);

    await repo.saveSettings({ gamesPerAccount: 60 });
    fake.requests.length = 0;
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    const backfill = fake.requests.filter(u => u.searchParams.get('sort') === 'dateDesc');
    expect(backfill.length).toBeGreaterThanOrEqual(1);
    expect(Number(backfill[0]!.searchParams.get('until'))).toBe(history[29]!.createdAt as number - 1);
    let state = await stateOf(id);
    expect(state.stored).toBeGreaterThanOrEqual(60);
    expect(state.reachedStart).toBeUndefined();
    expect(await storedIds(id)).toEqual(expectedIds(history, state.oldestCreatedAt!, state.newestCreatedAt!));

    await repo.saveSettings({ gamesPerAccount: 1000 });
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    state = await stateOf(id);
    expect(state.reachedStart).toBe(true);
    expect(await storedIds(id)).toEqual(expectedIds(history, -Infinity, Infinity));
  });

  it('attributes games by the queried account only, and counts the ones it cannot attribute', async () => {
    const lines = [
      lichessLine({ id: 'aaaaaaaa', createdAt: NOW - 3 * DAY, white: 'Hero', black: 'Rival', moves: 'e4 e5' }),
      lichessLine({ id: 'bbbbbbbb', createdAt: NOW - 2 * DAY, white: 'Rival', black: 'Hero', moves: 'd4 d5' }),
      lichessLine({ id: 'cccccccc', createdAt: NOW - DAY, white: 'Hero', black: 'Hero', moves: 'c4 c5' }),
    ];
    const id = await profileWith([HERO]);
    const result = await syncProfile(id, { fetchImpl: new FakeLichess(lines).fetchImpl, now });
    expect(result).toMatchObject({ added: 2, unmatched: 1 });
    const games = await repo.getGames(id);
    expect(games.map(g => [g.sourceId, g.color, g.opponent])).toEqual([
      ['aaaaaaaa', 'white', 'Rival'],
      ['bbbbbbbb', 'black', 'Rival'],
    ]);
  });

  it('syncs the recorded fixture export (variants, aborted, thematic and unstarted games skipped)', async () => {
    const lines = fixture('lichess-games.ndjson')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    const id = await profileWith([{ platform: 'lichess', username: 'sma-nahian' }]);
    const result = await syncProfile(id, { fetchImpl: new FakeLichess(lines).fetchImpl, now });
    expect(result).toEqual({ added: 10, unmatched: 0, errors: [] });
    expect(await stateOf(id)).toMatchObject({ stored: 10, reachedStart: true, newestCreatedAt: 1727807472123, oldestCreatedAt: 1725199205555 });
  });
});

describe('Chess.com sync', () => {
  const CC: Account = { platform: 'chesscom', username: 'HeroCC' };

  function server(): FakeChesscom {
    const fake = new FakeChesscom('HeroCC');
    fake.addMonth(2026, 6, 40, 1000);
    fake.addMonth(2026, 7, 40, 2000);
    fake.addMonth(2026, 8, 150, 3000);
    fake.addMonth(2026, 9, 40, 4000);
    fake.addMonth(2026, 10, 10, 5000);
    return fake;
  }

  it('walks archives newest first and marks only fully consumed months before the previous UTC month as done', async () => {
    const fake = server();
    const id = await profileWith([CC]);
    const result = await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect(result).toEqual({ added: 280, unmatched: 0, errors: [] });
    expect(fake.requests.slice(1).map(u => u.split('/games/')[1])).toEqual(['2026/10', '2026/09', '2026/08', '2026/07', '2026/06']);
    const state = await stateOf(id);
    expect(state.doneArchives!.map(u => u.split('/games/')[1]).sort()).toEqual(['2026/06', '2026/07', '2026/08']);
    expect(state).toMatchObject({ stored: 280, reachedStart: true });

    // Done months are never fetched again; the current and previous month always are.
    fake.requests.length = 0;
    fake.addMonth(2026, 10, 5, 6000);
    expect((await syncProfile(id, { fetchImpl: fake.fetchImpl, now })).added).toBe(5);
    expect(fake.requests.slice(1).map(u => u.split('/games/')[1])).toEqual(['2026/10', '2026/09']);
  });

  it('stops at the run limit, leaves a partly consumed month open and finishes it later', async () => {
    const fake = server();
    const id = await profileWith([CC]);
    // 10 + 40 games from Oct and Sep, then the first chunk (100) of the 150 August games.
    expect((await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 120 })).added).toBe(150);
    let state = await stateOf(id);
    expect(state.doneArchives ?? []).toEqual([]);
    expect(state.reachedStart).toBeUndefined();
    // The newest August games were kept.
    const august = (await repo.getGames(id)).filter(g => new Date(g.playedAt).getUTCMonth() === 7);
    expect(Math.min(...august.map(g => g.playedAt))).toBeGreaterThan(Date.UTC(2026, 7, 1));

    expect((await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 120 })).added).toBe(130);
    state = await stateOf(id);
    expect(state.doneArchives!.map(u => u.split('/games/')[1]).sort()).toEqual(['2026/06', '2026/07', '2026/08']);
    expect(state.stored).toBe(280);
  });

  it('stops walking into older months once gamesPerAccount games are stored', async () => {
    await repo.saveSettings({ gamesPerAccount: 45 });
    const fake = server();
    const id = await profileWith([CC]);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    expect(fake.requests.slice(1).map(u => u.split('/games/')[1])).toEqual(['2026/10', '2026/09']);
    expect((await stateOf(id)).stored).toBe(50);
  });

  it('counts games where the player is on neither side as unmatched', async () => {
    const fake = new FakeChesscom('HeroCC');
    fake.months.set('2026/10', [
      chesscomGame({ id: 1, white: 'HeroCC', black: 'x', sans: 'e4 e5', playedAt: Date.UTC(2026, 9, 2) }),
      chesscomGame({ id: 2, white: 'someone', black: 'else', sans: 'd4 d5', playedAt: Date.UTC(2026, 9, 3) }),
    ]);
    const id = await profileWith([CC]);
    expect(await syncProfile(id, { fetchImpl: fake.fetchImpl, now })).toMatchObject({ added: 1, unmatched: 1 });
  });
});

describe('errors', () => {
  it('collects per-account errors and continues with the other accounts', async () => {
    const lichess = new FakeLichess([]);
    lichess.missing.add('ghost');
    const chesscom = new FakeChesscom('HeroCC');
    chesscom.addMonth(2026, 10, 3, 1);
    const id = await profileWith([
      { platform: 'lichess', username: 'ghost' },
      { platform: 'chesscom', username: 'HeroCC' },
    ]);
    const result = await syncProfile(id, { fetchImpl: combinedFetch({ lichess, chesscom }), now });
    expect(result.added).toBe(3);
    expect(result.errors).toEqual([{ account: { platform: 'lichess', username: 'ghost' }, kind: 'not-found', message: expect.stringContaining('404') }]);
    const states = await repo.getSyncStates(id);
    expect(states.find(s => s.platform === 'lichess')!.lastError).toMatch(/404/);
    expect((await repo.getProfile(id))!.lastSyncAt).toBe(NOW);
  });

  it('a Lichess 429 reports a cooldown and skips the account until it ends', async () => {
    const fake = new FakeLichess(lichessHistory('Hero', 5, NOW - DAY));
    fake.override = () => new Response('', { status: 429 });
    const id = await profileWith([HERO]);
    const progress: SyncProgress[] = [];
    const result = await syncProfile(id, { fetchImpl: fake.fetchImpl, now, onProgress: p => progress.push(p) });
    expect(result.errors.map(e => e.kind)).toEqual(['rate-limited']);
    expect(progress.some(p => p.phase === 'cooldown' && p.cooldownUntil === NOW + 60_000)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'cooldown', errorKind: 'rate-limited' });
    expect((await repo.getProfile(id))!.lastSyncAt).toBeUndefined();

    // While the shared cooldown lasts no request is made at all (the fake clock, never the wall clock:
    // a test comparing Date.now() with a fixed NOW starts failing once that date has passed).
    fake.override = null;
    fake.requests.length = 0;
    const again = await syncProfile(id, { fetchImpl: fake.fetchImpl, now: () => NOW + 30_000 });
    expect(again.errors.map(e => e.kind)).toEqual(['rate-limited']);
    expect(fake.requests).toEqual([]);

    // Once it has ended, the account is synced again.
    const after = await syncProfile(id, { fetchImpl: fake.fetchImpl, now: () => NOW + 61_000 });
    expect(after.errors).toEqual([]);
    expect(fake.requests.some(u => u.pathname === '/api/games/user/Hero')).toBe(true);
    expect(after.added).toBeGreaterThan(0);
  });

  it('reports progress with the expected count for the current request: the account’s games, not the request max', async () => {
    const fake = new FakeLichess(lichessHistory('Hero', 25, NOW - DAY));
    const id = await profileWith([HERO]);
    const progress: SyncProgress[] = [];
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 300, onProgress: p => progress.push(p) });
    expect(progress[0]).toMatchObject({ profileId: id, phase: 'running', fetched: 0, added: 0 });
    // The account has 25 games (count.all), so the request for 300 returns 25: the bar ends full.
    expect(progress.some(p => p.expected === 25 && p.account?.username === 'Hero')).toBe(true);
    expect(progress.some(p => (p.expected ?? 0) > 25)).toBe(false);
    expect(progress.some(p => /about \d+ s left/.test(p.message ?? ''))).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'done', fetched: 25, added: 22 });
  });

  it('a backfill expects the games the account has beyond those stored, on the scale of `fetched`', async () => {
    // 400 games (none aborted); the first run stores the newest 300.
    const history = lichessHistory('Hero', 400, NOW - DAY, { spacingMs: 3_600_000 }).map(g => ({ ...g, status: 'resign' }));
    const fake = new FakeLichess(history);
    const id = await profileWith([HERO]);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 300 });
    expect((await stateOf(id)).stored).toBe(300);

    const progress: SyncProgress[] = [];
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now, onProgress: p => progress.push(p) });
    const backfill = exportsOf(fake).at(-1)!.searchParams;
    expect(backfill.get('sort')).toBe('dateDesc');
    expect(backfill.get('max')).toBe('700');
    // The forward pass re-read the overlap (no estimate); the backfill then expects 100 more lines.
    const forwardLines = progress.find(p => p.expected !== undefined)!.fetched;
    expect(progress.filter(p => p.expected !== undefined).map(p => p.expected! - forwardLines)).toContain(100);
    expect(progress.filter(p => p.phase === 'running').every(p => p.expected === undefined || p.fetched <= p.expected)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'done', fetched: forwardLines + 100 });
    expect((await stateOf(id)).stored).toBe(400);
  });

  it('without a game count (the lookup fails) the request max is the estimate, and the sync still runs', async () => {
    const fake = new FakeLichess(lichessHistory('Hero', 25, NOW - DAY));
    fake.override = url => (url.pathname.startsWith('/api/user/') ? new Response('', { status: 400 }) : undefined);
    const id = await profileWith([HERO]);
    const progress: SyncProgress[] = [];
    const result = await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 300, onProgress: p => progress.push(p) });
    expect(result).toMatchObject({ added: 22, errors: [] });
    expect(progress.some(p => p.expected === 300)).toBe(true);
  });
});

describe('importPgnIntoProfile', () => {
  const PGN = fixture('games.pgn');

  it('attributes games by alias, skips non-standard games and stores each game once across sources', async () => {
    const lines = fixture('lichess-games.ndjson')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    const id = await profileWith([{ platform: 'lichess', username: 'SMA-Nahian' }], ['sma-nahian']);
    await syncProfile(id, { fetchImpl: new FakeLichess(lines).fetchImpl, now });
    const before = await repo.countGames(id);

    const progress: SyncProgress[] = [];
    const result = await importPgnIntoProfile(id, PGN, { onProgress: p => progress.push(p) });
    // 7 games: Chess960, a [FEN] start and a forfeit are skipped; the Lichess game is already stored.
    expect(result).toEqual({ added: 3, skipped: 3, unmatched: 0, duplicates: 1 });
    expect(await repo.countGames(id)).toBe(before + 3);
    expect(progress.at(-1)).toMatchObject({ phase: 'done', added: 3 });

    // A second import adds nothing.
    expect(await importPgnIntoProfile(id, new Blob([PGN]))).toEqual({ added: 0, skipped: 3, unmatched: 0, duplicates: 4 });
  });

  it('counts games without the player as unmatched, or takes every game as one colour', async () => {
    const id = await profileWith([], ['nobody']);
    expect(await importPgnIntoProfile(id, PGN)).toEqual({ added: 0, skipped: 3, unmatched: 4, duplicates: 0 });
    const result = await importPgnIntoProfile(id, PGN, { asColor: 'black' });
    expect(result).toMatchObject({ added: 4, unmatched: 0 });
    expect((await repo.getGames(id)).every(g => g.color === 'black')).toBe(true);
  });

  it('rejects with an AbortError when aborted', async () => {
    const id = await profileWith([], ['sma-nahian']);
    const controller = new AbortController();
    controller.abort();
    await expect(importPgnIntoProfile(id, PGN, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('interrupt at every chunk boundary', () => {
  it('Lichess: abort right after each stored chunk of the first run + backfill, then resume = uninterrupted', async () => {
    await repo.saveSettings({ gamesPerAccount: 450 });
    const history = lichessHistory('Hero', 520, NOW - DAY, { spacingMs: 3_600_000 });
    const reference = await profileWith([HERO]);
    // Reference: first run (300) then the backfill to 450, uninterrupted.
    await syncProfile(reference, { fetchImpl: new FakeLichess(history).fetchImpl, now, limit: 300 });
    await syncProfile(reference, { fetchImpl: new FakeLichess(history).fetchImpl, now });
    const want = await storedIds(reference);
    const wantState = await stateOf(reference);

    for (const cut of [CHUNK_SIZE, 2 * CHUNK_SIZE, 3 * CHUNK_SIZE, 1, 99, 101, 299, 300]) {
      useTestDb();
      await repo.saveSettings({ gamesPerAccount: 450 });
      const id = await profileWith([HERO]);
      const fake = new FakeLichess(history);
      const controller = new AbortController();
      await syncProfile(id, {
        fetchImpl: fake.fetchImpl,
        now,
        limit: 300,
        signal: controller.signal,
        onProgress: p => {
          if (p.fetched >= cut && !controller.signal.aborted) controller.abort();
        },
      }).catch(() => undefined);
      // Resume: the rest of the first run, then the backfill (as the store does).
      await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 300 });
      await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
      await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
      const got = await storedIds(id);
      const state = await stateOf(id);
      expect({ cut, missing: want.filter(k => !got.includes(k)).length }).toEqual({ cut, missing: 0 });
      expect({ cut, stored: state.stored, n: got.length }).toEqual({ cut, stored: got.length, n: got.length });
      expect(state.newestCreatedAt).toBe(wantState.newestCreatedAt);
    }
  });

  it('Lichess: a network break exactly at each chunk boundary of the backfill leaves no gap', async () => {
    await repo.saveSettings({ gamesPerAccount: 1000 });
    const history = lichessHistory('Hero', 450, NOW - DAY, { spacingMs: 3_600_000 });
    for (const cut of [CHUNK_SIZE, 2 * CHUNK_SIZE, CHUNK_SIZE - 1, CHUNK_SIZE + 1]) {
      useTestDb();
      await repo.saveSettings({ gamesPerAccount: 1000 });
      const id = await profileWith([HERO]);
      const fake = new FakeLichess(history);
      await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 50 });
      fake.override = url => {
        if (url.searchParams.get('sort') === 'dateDesc') fake.breakAfter = cut;
        return undefined;
      };
      const broken = await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
      expect(broken.errors.map(e => e.kind)).toEqual(['network']);
      fake.override = null;
      await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
      const all = history.filter(g => g.status !== 'aborted').map(g => `lichess:${g.id as string}`).sort();
      expect({ cut, ids: await storedIds(id) }).toEqual({ cut, ids: all });
      expect((await stateOf(id)).reachedStart).toBe(true);
    }
  });
});

describe('reachedStart', () => {
  it('an account without games at its first sync still backfills once it has played more than the first-run limit', async () => {
    const fake = new FakeLichess([]);
    const id = await profileWith([HERO]);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 300 });
    // Later the player has 500 games: first-run pass (300 newest) then the backfill.
    fake.games = lichessHistory('Hero', 500, NOW - DAY, { spacingMs: 3_600_000 });
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now, limit: 300 });
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now });
    const all = fake.games.filter(g => g.status !== 'aborted').length;
    expect(await repo.countGames(id)).toBe(all);
  });
});

describe('attribution', () => {
  it('uses the queried account only: the profile’s Lichess name as a Chess.com opponent is not "both sides"', async () => {
    const fake = new FakeChesscom('HeroCC');
    fake.months.set('2026/10', [
      chesscomGame({ id: 1, white: 'Hero', black: 'HeroCC', sans: 'e4 e5', playedAt: Date.UTC(2026, 9, 2) }),
      chesscomGame({ id: 2, white: 'herocc', black: 'Someone', sans: 'd4 d5', playedAt: Date.UTC(2026, 9, 3) }),
    ]);
    const id = await profileWith([HERO, { platform: 'chesscom', username: 'HeroCC' }]);
    const lichess = new FakeLichess([]);
    const result = await syncProfile(id, { fetchImpl: combinedFetch({ lichess, chesscom: fake }), now });
    expect(result).toMatchObject({ added: 2, unmatched: 0, errors: [] });
    expect((await repo.getGames(id)).map(g => [g.sourceId, g.color, g.opponent])).toEqual([
      ['live/1', 'black', 'Hero'],
      ['live/2', 'white', 'Someone'],
    ]);
  });
});

describe('Chess.com month boundaries', () => {
  it('across the new year: December is the previous month (not done), November is done', async () => {
    const fake = new FakeChesscom('HeroCC');
    fake.addMonth(2026, 11, 5, 100);
    fake.addMonth(2026, 12, 5, 200);
    fake.addMonth(2027, 1, 5, 300);
    const id = await profileWith([{ platform: 'chesscom', username: 'HeroCC' }]);
    const jan1 = (): number => Date.UTC(2027, 0, 1, 0, 30);
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now: jan1 });
    expect((await stateOf(id)).doneArchives!.map(u => u.split('/games/')[1])).toEqual(['2026/11']);
    // A month later December is old: fetched once more, then done.
    fake.requests.length = 0;
    const feb1 = (): number => Date.UTC(2027, 1, 1, 0, 30);
    fake.addMonth(2026, 12, 2, 250); // late-finishing games archived in December
    expect((await syncProfile(id, { fetchImpl: fake.fetchImpl, now: feb1 })).added).toBe(2);
    expect((await stateOf(id)).doneArchives!.map(u => u.split('/games/')[1]).sort()).toEqual(['2026/11', '2026/12']);
    fake.requests.length = 0;
    await syncProfile(id, { fetchImpl: fake.fetchImpl, now: feb1 });
    expect(fake.requests.slice(1).map(u => u.split('/games/')[1])).toEqual(['2027/01']);
  });
});
