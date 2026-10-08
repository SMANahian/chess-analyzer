import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from '../core/chess';
import { OpeningBook, type OpeningsJson } from '../core/openings';
import { DEFAULT_FILTERS, DEFAULT_SETTINGS } from '../core/types';
import { exportBackup } from '../db/backup';
import * as repo from '../db/repo';
import { useTestDb } from '../db/schema';
import { setLichessCooldown } from '../sources/http';
import { fixture } from '../sources/__fixtures__/testing';
import {
  FakeChesscom,
  FakeLichess,
  FakePool,
  combinedFetch,
  lichessHistory,
  lichessLine,
  storedGame,
  testMistake,
  type ScoreTable,
} from '../services/__fixtures__/fakes';
import { buildSession } from '../services/training';
import * as store from './store';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
const fenAt = (sans: string): string => sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN);
const keyOf = (fen: string): string => posKey(posFromFen(fen)!);

/** Hero (Black) plays 3...Nd4 after 1.e4 e5 2.Nf3 Nc6 3.Bc4 in the trap games; the engine hates it. */
const AFTER_BC4 = fenAt('e4 e5 Nf3 Nc6 Bc4');
const TABLE: ScoreTable = { [keyOf(AFTER_BC4)]: { c6d4: -150, f8c5: 30 } };

let book: OpeningBook;
beforeAll(() => {
  book = OpeningBook.fromJson(JSON.parse(readFileSync(new URL('../../public/data/openings.json', import.meta.url), 'utf8')) as OpeningsJson);
});

let lichess: FakeLichess;
let pool: FakePool;

beforeEach(async () => {
  await store.__resetForTests();
  useTestDb();
  setLichessCooldown(0);
  lichess = new FakeLichess(lichessHistory('hero', 400, NOW - DAY));
  pool = new FakePool(2, TABLE);
  store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW });
});

afterEach(async () => {
  await store.__resetForTests();
  vi.unstubAllGlobals();
  setLichessCooldown(0);
});

const HERO = { platform: 'lichess' as const, username: 'hero' };

async function setupHero(): Promise<void> {
  await store.init();
  await store.setupSelf([HERO]);
  await store.__jobsIdle();
}

/** New games for hero (White) in the English, 1.c4 e5 2.Nc3: positions the engine has not seen yet. */
function englishGames(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    lichessLine({ id: `en${String(i).padStart(6, '0')}`, createdAt: NOW - DAY / 2 + i * 60_000, white: 'hero', black: `x${i}`, moves: 'c4 e5 Nc3 Nf6 g3 d5' }),
  );
}

/** Calls `action` once, as soon as an analysis reports the given phase; returns the action's promise. */
function onAnalysisPhase(phase: string, action: () => Promise<unknown>): { started(): Promise<unknown>; stop(): void } {
  let promise: Promise<unknown> | undefined;
  const stop = store.analysisProgress.subscribe(p => {
    if (p?.phase === phase && promise === undefined) promise = action();
  });
  return {
    started: async () => {
      await vi.waitFor(() => expect(promise).toBeDefined(), { timeout: 5000 });
      return promise;
    },
    stop,
  };
}

describe('init', () => {
  it('opens an empty database with the defaults', async () => {
    await store.init();
    expect(store.ready.value).toBe(true);
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);
    expect(store.filters.value).toEqual(DEFAULT_FILTERS);
    expect(store.profiles.value).toEqual([]);
    expect(store.selfProfile.value).toBeNull();
    expect(store.visibleMistakes.value).toEqual([]);
    expect(store.dueCount.value).toBe(0);
  });

  it('restores persisted filters, ignoring fields of the wrong type', async () => {
    const data = new Map<string, string>([['ca:filters', JSON.stringify({ color: 'black', minGames: 'x', speeds: ['blitz'], opening: null })]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    await store.init();
    expect(store.filters.value).toEqual({ ...DEFAULT_FILTERS, color: 'black', speeds: ['blitz'] });
    store.setFilters({ sort: 'loss' });
    expect(JSON.parse(data.get('ca:filters')!)).toMatchObject({ color: 'black', sort: 'loss' });
  });

  it('a deep link sets up the own profile and starts the first analysis', async () => {
    const replaceState = vi.fn();
    vi.stubGlobal('location', { hash: '#/?lichess=hero', search: '', pathname: '/app/' });
    vi.stubGlobal('history', { replaceState });
    await store.init();
    await store.__jobsIdle();
    expect(store.selfProfile.value).toMatchObject({ name: 'Hero', accounts: [{ platform: 'lichess', username: 'Hero' }] });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app/#/');
    expect(store.mistakes.value.length).toBeGreaterThan(0);
  });

  it('a deep link for other accounts than the own profile asks first', async () => {
    await setupHero();
    await store.__resetForTests();
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW });
    vi.stubGlobal('location', { hash: '#/?lichess=someone&chesscom=else', search: '', pathname: '/' });
    vi.stubGlobal('history', { replaceState: () => undefined });
    await store.init();
    await store.__jobsIdle();
    expect(store.selfProfile.value!.accounts).toEqual([{ platform: 'lichess', username: 'Hero' }]);
    expect(store.notice.value).toMatchObject({ kind: 'info', action: { label: 'Analyse someone / else instead' } });
  });

  it('auto-syncs on open when the last sync is older than 6 hours', async () => {
    await setupHero();
    await store.__resetForTests();
    lichess.requests.length = 0;
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW + 7 * 3_600_000 });
    await store.init();
    await store.__jobsIdle();
    expect(lichess.requests.some(u => u.pathname.startsWith('/api/games/user/'))).toBe(true);

    await store.__resetForTests();
    lichess.requests.length = 0;
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW + 8 * 3_600_000 });
    await store.init();
    await store.__jobsIdle();
    expect(lichess.requests).toEqual([]);
  });

  it('auto-sync is off when the setting says so', async () => {
    await setupHero();
    await store.updateSettings({ autoSync: false });
    await store.__resetForTests();
    lichess.requests.length = 0;
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW + 30 * DAY });
    await store.init();
    await store.__jobsIdle();
    expect(lichess.requests).toEqual([]);
  });
});

describe('setupSelf and refresh', () => {
  it('first run: newest 300 games, analyse, backfill, analyse again', async () => {
    const analysisPhases: string[] = [];
    const stop = store.analysisProgress.subscribe(p => {
      if (p && analysisPhases.at(-1) !== p.phase) analysisPhases.push(p.phase);
    });
    await store.init();
    const profile = await store.setupSelf([{ platform: 'lichess', username: ' hero ' }]);
    expect(profile).toMatchObject({ kind: 'self', name: 'Hero', accounts: [{ platform: 'lichess', username: 'Hero' }] });
    await store.__jobsIdle();
    stop();

    const exports = lichess.requests.filter(u => u.pathname.startsWith('/api/games/user/')).map(u => Object.fromEntries(u.searchParams));
    expect(exports[0]).toMatchObject({ sort: 'dateDesc', max: '300' });
    expect(exports.slice(1).map(q => q.sort)).toEqual(['dateAsc', 'dateDesc']);
    expect(exports[2]).toMatchObject({ max: String(1000 - (300 - Math.floor(300 / 7))) });
    expect(analysisPhases.filter(p => p === 'done')).toHaveLength(2);

    // 400 games, every 7th aborted.
    expect(store.games.value).toHaveLength(400 - Math.floor(400 / 7));
    expect(store.mistakes.value.map(m => [m.move, m.color])).toEqual([['c6d4', 'black']]);
    expect(store.visibleMistakes.value.map(m => m.move)).toEqual(['c6d4']);
    expect(store.dueCount.value).toBe(1);
    expect(store.syncProgress.value!.phase).toBe('done');
    expect(store.analysisProgress.value!.phase).toBe('done');
    expect(store.busy.value).toBe(false);
    expect(store.selfProfile.value).toMatchObject({ lastSyncAt: NOW, lastAnalysisAt: NOW });
    expect(store.settings.value.storagePersisted).toBe(false);
    expect(store.getMistakeByShortId(store.mistakes.value[0]!.shortId)).toBe(store.mistakes.value[0]);
  });

  it('a refresh without new games does not re-analyse', async () => {
    await setupHero();
    const calls = pool.calls.length;
    const phases: string[] = [];
    const stop = store.analysisProgress.subscribe(p => p && phases.push(p.phase));
    phases.length = 0;
    await store.refresh();
    stop();
    expect(phases).toEqual([]);
    expect(pool.calls).toHaveLength(calls);
    // Changed analysis settings do trigger it (from the cache: no new engine work for unchanged depths).
    await store.updateSettings({ openingPlies: 16 });
    await store.refresh();
    expect(store.analysisProgress.value!.phase).toBe('done');
  });

  it('rejects unknown and closed accounts with a friendly error naming the account', async () => {
    await store.init();
    lichess.missing.add('ghost');
    const err = await store.setupSelf([{ platform: 'lichess', username: 'ghost' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(store.AccountError);
    expect(err).toMatchObject({ kind: 'not-found', account: { platform: 'lichess', username: 'ghost' }, message: expect.stringContaining('“ghost”') });

    const cc = new FakeChesscom('Closed1');
    const closedFetch = combinedFetch({
      lichess,
      other: async input => (String(input).endsWith('/closed1') ? Response.json({ username: 'closed1', status: 'closed:fair_play_violations' }) : cc.fetchImpl(input)),
    });
    store.__setTestDeps({ fetchImpl: closedFetch, pool, book, now: () => NOW });
    await expect(store.setupSelf([{ platform: 'chesscom', username: 'Closed1' }])).rejects.toMatchObject({ kind: 'closed' });
    await expect(store.setupSelf([{ platform: 'lichess', username: '  ' }])).rejects.toThrow(/Enter a Lichess or Chess.com username/);
    expect(store.selfProfile.value).toBeNull();
  });

  it('accepts an account it cannot check (blocked request) with a notice; the failed sync is reported', async () => {
    await store.init();
    // Not a TypeError, so nothing is retried (retries with back-off are covered by the sources tests).
    const blocked = (async () => {
      throw new Error('blocked by an extension');
    }) as typeof fetch;
    store.__setTestDeps({ fetchImpl: blocked, pool, book, now: () => NOW });
    const notices: string[] = [];
    const stop = store.notice.subscribe(n => n && notices.push(`${n.kind}: ${n.text}`));
    const profile = await store.setupSelf([HERO]);
    expect(profile.accounts).toEqual([HERO]);
    await store.__jobsIdle();
    stop();
    expect(notices[0]).toMatch(/^info: Couldn't check the Lichess account “hero”/);
    expect(notices.at(-1)).toMatch(/^error: Lichess “hero”: .*blocked by an extension/);
    expect(store.syncProgress.value).toMatchObject({ phase: 'error', errorKind: 'unknown' });
  });

  it('rejects an account whose site cannot be reached at all (CORS, offline) and stores nothing', async () => {
    await store.init();
    let calls = 0;
    const unreachable = (async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    store.__setTestDeps({ fetchImpl: unreachable, pool, book, now: () => NOW });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const setup = store.setupSelf([HERO]);
      const settled = expect(setup).rejects.toMatchObject({ name: 'AccountError', kind: 'network', account: HERO });
      await vi.advanceTimersByTimeAsync(10_000); // fetchWithRetry's back-off: 1 + 2 + 4 s
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toBe(4);
    expect(store.selfProfile.value).toBeNull();
    expect(await repo.listProfiles()).toEqual([]);
  });

  it('a first sync that fails for every account neither analyses nothing nor backfills; the retry is still a first run', async () => {
    await store.init();
    const exports = (): URL[] => lichess.requests.filter(u => u.pathname.startsWith('/api/games/user/'));
    lichess.override = url => (url.pathname.startsWith('/api/games/user/') ? new Response('', { status: 403 }) : undefined);
    await store.setupSelf([HERO]);
    await store.__jobsIdle();
    expect(exports()).toHaveLength(1);
    expect(store.syncProgress.value).toMatchObject({ phase: 'error' });
    expect(store.analysisProgress.value).toBeNull();
    expect(store.selfProfile.value?.lastAnalysisAt).toBeUndefined();

    // Lichess answers again: the newest 300 first, analysed, then the backfill.
    lichess.override = null;
    await store.refresh();
    expect(exports()[1]?.searchParams.get('max')).toBe('300');
    expect(store.games.value).toHaveLength(400 - Math.floor(400 / 7)); // every 7th game was aborted
    expect(store.selfProfile.value?.lastAnalysisAt).toBe(NOW);
  });

  it('updateSelfAccounts drops the games of a platform that has no account left', async () => {
    await setupHero();
    const cc = new FakeChesscom('HeroCC');
    cc.addMonth(2026, 10, 4, 1);
    store.__setTestDeps({ fetchImpl: combinedFetch({ lichess, chesscom: cc }), pool, book, now: () => NOW });
    await store.updateSelfAccounts([{ platform: 'chesscom', username: 'HeroCC' }]);
    await store.__jobsIdle();
    expect(store.selfProfile.value).toMatchObject({ name: 'HeroCC', accounts: [{ platform: 'chesscom', username: 'HeroCC' }] });
    expect(store.games.value.map(g => g.platform)).toEqual(['chesscom', 'chesscom', 'chesscom', 'chesscom']);
    expect(await repo.getSyncStates(store.selfProfile.value!.id)).toHaveLength(1);
  });

  it('an account added while a refresh runs is downloaded: that refresh read the old accounts, so a new one replaces it', async () => {
    const cc = new FakeChesscom('HeroCC');
    cc.addMonth(2026, 10, 4, 1);
    store.__setTestDeps({ fetchImpl: combinedFetch({ lichess, chesscom: cc }), pool, book, now: () => NOW });
    await setupHero();
    // New games, so the next refresh has engine work; the user adds an account in Settings meanwhile.
    lichess.games = [...lichess.games, ...englishGames(4)];
    pool.delayMs = 30;
    const change = onAnalysisPhase('evaluating', () => store.updateSelfAccounts([HERO, { platform: 'chesscom', username: 'HeroCC' }]));
    const running = store.refresh().catch((err: unknown) => err);
    await change.started();
    change.stop();
    // The running refresh was stopped (an abort, which the UI does not report)…
    expect(await running).toMatchObject({ name: 'AbortError' });
    await store.__jobsIdle();
    // …and the one updateSelfAccounts started synced both accounts and analysed.
    expect(cc.requests.some(u => u.endsWith('/games/archives'))).toBe(true);
    expect(store.games.value.filter(g => g.platform === 'chesscom')).toHaveLength(4);
    expect((await repo.getSyncStates(store.selfProfile.value!.id)).map(s => s.platform).sort()).toEqual(['chesscom', 'lichess']);
    expect(store.analysisProgress.value).toMatchObject({ phase: 'done', gamesUsed: store.games.value.length });
  });

  it('an account added while a re-analysis runs lets it finish (only a refresh read the accounts), then syncs it', async () => {
    const cc = new FakeChesscom('HeroCC');
    cc.addMonth(2026, 10, 4, 1);
    store.__setTestDeps({ fetchImpl: combinedFetch({ lichess, chesscom: cc }), pool, book, now: () => NOW });
    await setupHero();
    await store.updateSettings({ openingPlies: 16 });
    pool.delayMs = 30;
    const phases: string[] = [];
    const stop = store.analysisProgress.subscribe(p => p && phases.push(p.phase));
    const change = onAnalysisPhase('evaluating', () => store.updateSelfAccounts([HERO, { platform: 'chesscom', username: 'HeroCC' }]));
    await store.analyze();
    await change.started();
    change.stop();
    await store.__jobsIdle();
    stop();
    expect(phases).not.toContain('cancelled');
    expect(store.games.value.filter(g => g.platform === 'chesscom')).toHaveLength(4);
  });

  it('replacing the only account with one that has no games yet removes the old leaks (reviewed ones stay, dormant)', async () => {
    await setupHero();
    const id = store.selfProfile.value!.id;
    // Two leaks of the old (mistyped) account: c6d4 was trained, the other one never.
    const [card] = await store.startSession();
    await store.gradeCard(card!, 'good');
    await repo.upsertMistakes([testMistake(id, fenAt('e4'), 'f7f6')]);
    const fresh = new FakeLichess([]);
    store.__setTestDeps({ fetchImpl: fresh.fetchImpl, pool, book, now: () => NOW });
    await store.updateSelfAccounts([{ platform: 'lichess', username: 'newbie' }]);
    await store.__jobsIdle();

    expect(await repo.countGames(id)).toBe(0);
    expect(store.visibleMistakes.value).toEqual([]);
    expect(store.trainingCounts.value.total).toBe(0);
    expect((await repo.getMistakes(id)).map(m => [m.move, m.dormant])).toEqual([['c6d4', true]]);
    expect(store.reviews.value.size).toBe(1);
    // Starts over as never analysed: the new account's first refresh is a quick first pass.
    expect(store.selfProfile.value).toMatchObject({ name: 'newbie', accounts: [{ platform: 'lichess', username: 'newbie' }] });
    expect(store.selfProfile.value!.lastAnalysisAt).toBeUndefined();
    expect(fresh.requests.find(u => u.pathname.startsWith('/api/games/user/'))?.searchParams.get('max')).toBe('300');
  });

  it('a settings change made while an analysis runs is not recorded as applied: the next refresh applies it', async () => {
    // 4...Nd4 looks bad up to depth 14 but is fine at depth 18 (the Thorough confirm depth).
    pool = new FakePool(2, { [keyOf(AFTER_BC4)]: { c6d4: (d: number) => (d >= 18 ? 30 : -150), f8c5: 30 } });
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW });
    await setupHero();
    expect(store.mistakes.value.map(m => m.move)).toEqual(['c6d4']);
    lichess.games = [...lichess.games, ...englishGames(4)];
    pool.delayMs = 30;
    // The user picks Thorough while the refresh's analysis (Standard, 10 → 14) runs.
    const change = onAnalysisPhase('evaluating', () => store.updateSettings({ preset: 'thorough' }));
    await store.refresh();
    await change.started();
    change.stop();
    expect(pool.calls.some(c => c.depth === 18)).toBe(false);
    expect(store.settings.value.preset).toBe('thorough');

    pool.delayMs = 0;
    await store.refresh();
    expect(pool.calls.some(c => c.depth === 18)).toBe(true);
    expect(store.visibleMistakes.value).toEqual([]);
  });

  it('cancelJobs stops a running analysis and keeps what was found', async () => {
    await store.init();
    pool.delayMs = 30;
    await store.setupSelf([HERO]);
    await vi.waitFor(() => expect(store.analysisProgress.value?.phase).toBe('evaluating'), { timeout: 5000 });
    store.cancelJobs();
    await store.__jobsIdle();
    expect(store.analysisProgress.value!.phase).toBe('cancelled');
    expect(store.busy.value).toBe(false);
    expect(store.selfProfile.value!.lastAnalysisAt).toBeUndefined();
    await expect(store.refresh()).resolves.toBeUndefined();
  });

  it('the same job requested twice runs once', async () => {
    await setupHero();
    lichess.requests.length = 0;
    await Promise.all([store.refresh(), store.refresh()]);
    expect(lichess.requests.filter(u => u.searchParams.get('sort') === 'dateAsc')).toHaveLength(1);
  });
});

describe('mistakes found while an analysis runs', () => {
  it('reach the signal at most once per MISTAKES_MERGE_MS (not every write batch); the end state equals the database', async () => {
    // Hero (Black) answers each of 20 first moves with 1...a6, twice: 20 positions, each a leak.
    const firsts = ['a3', 'a4', 'b3', 'b4', 'c3', 'c4', 'd3', 'd4', 'e3', 'e4', 'f3', 'f4', 'g3', 'g4', 'h3', 'h4', 'Na3', 'Nc3', 'Nf3', 'Nh3'];
    const table: ScoreTable = Object.fromEntries(firsts.map(f => [keyOf(fenAt(f)), { a7a6: -150, e7e6: 30 }]));
    const self = await repo.ensureSelfProfile({ name: 'hero', accounts: [], aliases: [] }, NOW);
    await repo.addGames(firsts.flatMap((f, i) => [0, 1].map(j => storedGame(self.id, `g${i}-${j}`, `${f} a6`, 'black', NOW - (2 * i + j) * 3_600_000))));
    // One engine, 40 ms per search, two searches per position: a run of about 1.6 s.
    pool = new FakePool(1, table);
    pool.delayMs = 40;
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW });
    await store.init();

    const writes = vi.spyOn(repo, 'upsertMistakes');
    const merges: number[] = [];
    const stop = store.mistakes.subscribe(() => {
      if (store.analysisProgress.value?.phase === 'evaluating') merges.push(performance.now());
    });
    await store.analyze();
    stop();

    // The database got a batch every FLUSH_MS (300 ms); the signal far fewer updates, a second apart.
    const batches = writes.mock.calls.length;
    expect(batches).toBeGreaterThanOrEqual(4);
    expect(merges.length).toBeGreaterThanOrEqual(1);
    expect(merges.length).toBeLessThan(batches);
    for (let i = 1; i < merges.length; i++) expect(merges[i]! - merges[i - 1]!).toBeGreaterThanOrEqual(store.MISTAKES_MERGE_MS - 20);
    // The end of the run reloads what was stored.
    expect(store.mistakes.value).toHaveLength(20);
    expect(store.mistakes.value).toEqual(await repo.getMistakes(self.id));
  });
});

describe('mistakes, filters and settings', () => {
  it('snooze hides a mistake until the date; restore and ignore update the signal and the database', async () => {
    await setupHero();
    const m = store.mistakes.value[0]!;
    await store.setMistakeStatus(m.id, 'active', { snoozeDays: 3 });
    expect(store.mistakes.value[0]!.snoozedUntil).toBe(NOW + 3 * DAY);
    expect(store.visibleMistakes.value).toEqual([]);
    await store.setMistakeStatus(m.id, 'active');
    expect(store.mistakes.value[0]!.snoozedUntil).toBeUndefined();
    expect(store.visibleMistakes.value).toHaveLength(1);
    await store.setMistakeStatus(m.id, 'ignored', { reason: 'repertoire' });
    expect((await repo.getMistakes(m.profileId))[0]).toMatchObject({ status: 'ignored', ignoreReason: 'repertoire' });
    expect(store.visibleMistakes.value).toEqual([]);
  });

  it('view filters apply live', async () => {
    await setupHero();
    store.setFilters({ color: 'white' });
    expect(store.visibleMistakes.value).toEqual([]);
    store.setFilters({ color: 'black', sort: 'due' });
    expect(store.visibleMistakes.value.map(m => m.move)).toEqual(['c6d4']);
  });

  it('updateSettings saves and publishes the settings', async () => {
    await store.init();
    await store.updateSettings({ preset: 'quick', newPerDay: 2 });
    expect(store.settings.value).toMatchObject({ preset: 'quick', newPerDay: 2 });
    expect(await repo.getSettings()).toMatchObject({ preset: 'quick', newPerDay: 2 });
  });
});

describe('training', () => {
  it('session, judged moves (cached, known and live) and grading', async () => {
    await setupHero();
    const cards = await store.startSession();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ isNew: true, mistake: { move: 'c6d4' } });

    expect(await store.submitMove(card, 'c6d4')).toEqual({ kind: 'habit' });
    expect(await store.submitMove(card, 'f8c5')).toMatchObject({ kind: 'correct', best: true });
    const callsBefore = pool.calls.length;
    // An unknown move is evaluated live at the confirm depth, interactive priority.
    const verdict = await store.submitMove(card, 'g8f6');
    expect(verdict).toMatchObject({ kind: 'correct', best: false });
    expect(pool.calls.slice(callsBefore)).toEqual([expect.objectContaining({ moves: ['g8f6', 'f8c5'], depth: 14, priority: 'interactive' })]);
    expect(store.mistakes.value[0]!.acceptable).toContain('g8f6');
    // The verdict is remembered: no second engine call.
    expect(await store.submitMove({ ...card, mistake: store.mistakes.value[0]! }, 'g8f6')).toMatchObject({ kind: 'correct' });
    expect(pool.calls).toHaveLength(callsBefore + 1);

    const relearn = await store.gradeCard(card, 'again');
    expect(relearn).toMatchObject({ reps: 0, lapses: 1, due: NOW + 10 * 60_000 });
    // Grading the same card object again builds on the stored review and counts the new card once.
    const review = await store.gradeCard(card, 'good');
    expect(review).toMatchObject({ reps: 1, lapses: 1, due: NOW + DAY });
    expect(store.reviews.value.get(card.mistake.id)).toEqual(review);
    expect(store.dueCount.value).toBe(0);
    expect(await store.startSession()).toEqual([]);
  });

  it('the daily new-card limit counts cards started today', async () => {
    await setupHero();
    await store.updateSettings({ newPerDay: 0 });
    expect(await store.startSession()).toEqual([]);
    expect(store.dueCount.value).toBe(0);
  });

  it('trainingCounts tells due reviews from new positions available today (the example data)', async () => {
    const demo = readFileSync(new URL('../../public/demo/demo.json', import.meta.url), 'utf8');
    // Two days after the example was made: every review is due, and no card was started "today" in any time zone.
    const at = (JSON.parse(demo) as { exportedAt: number }).exportedAt + 2 * DAY;
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => at });
    await store.init();
    await store.importData(new Blob([demo]));
    const unlimited = (newToday: number): number =>
      buildSession(store.mistakes.value, [...store.reviews.value.values()], at, { size: Number.MAX_SAFE_INTEGER, newToday, newPerDay: 5 }).length;

    expect(store.settings.value.newPerDay).toBe(5);
    expect(store.trainingCounts.value).toEqual({ dueReviews: 6, newAvailable: 5, total: 11 });
    expect(store.trainingCounts.value.total).toBe(unlimited(0));
    expect(store.dueCount.value).toBe(11);

    // Today's five new cards are started: only the reviews are left.
    const unseen = store.visibleMistakes.value.filter(m => !store.reviews.value.has(m.id)).slice(0, 5);
    for (const m of unseen) await repo.addAttempt({ mistakeId: m.id, profileId: m.profileId, at, grade: 'good' });
    await store.startSession(); // reloads today's new-card count
    expect(store.trainingCounts.value).toEqual({ dueReviews: 6, newAvailable: 0, total: 6 });
    expect(store.trainingCounts.value.total).toBe(unlimited(5));

    // A review graded now is due again later.
    const [card] = await store.startSession();
    expect(card!.isNew).toBe(false);
    await store.gradeCard(card!, 'good');
    expect(store.trainingCounts.value).toEqual({ dueReviews: 5, newAvailable: 0, total: 5 });
  });

  it('practiceStats: attempts per local day and the current streak', async () => {
    await setupHero();
    const id = store.selfProfile.value!.id;
    for (const [daysAgo, grade] of [
      [0, 'good'],
      [0, 'again'],
      [1, 'hard'],
      [2, 'good'],
      [4, 'good'],
    ] as const) {
      await repo.addAttempt({ mistakeId: 'm', profileId: id, at: NOW - daysAgo * DAY, grade });
    }
    const stats = await store.practiceStats(7);
    expect(stats.byDay).toHaveLength(7);
    expect(stats.byDay.map(d => d.total)).toEqual([0, 0, 1, 0, 1, 1, 2]);
    expect(stats.byDay.at(-1)).toMatchObject({ total: 2, correct: 1 });
    expect(stats.streak).toBe(3);
  });

  it('the streak may end yesterday', async () => {
    await setupHero();
    const id = store.selfProfile.value!.id;
    await repo.addAttempt({ mistakeId: 'm', profileId: id, at: NOW - DAY, grade: 'good' });
    await repo.addAttempt({ mistakeId: 'm', profileId: id, at: NOW - 2 * DAY, grade: 'good' });
    expect((await store.practiceStats(3)).streak).toBe(2);
  });
});

describe('scout', () => {
  it('adds a scouted player, syncs at most 500 of their games, analyses with refutations and offers a prep drill', async () => {
    await setupHero();
    const rival = new FakeLichess(lichessHistory('rival', 30, NOW - DAY, { idPrefix: 'r' }));
    const after = playUci(AFTER_BC4, 'c6d4')!;
    const scoutPool = new FakePool(2, { ...TABLE, [keyOf(after)]: { f3e5: 120, c2c3: -60 } });
    store.__setTestDeps({ fetchImpl: combinedFetch({ lichess: rival }), pool: scoutPool, book, now: () => NOW });
    const profile = await store.addScout({ accounts: [{ platform: 'lichess', username: 'rival' }] });
    expect(profile).toMatchObject({ kind: 'opponent', name: 'rival' });
    await store.__jobsIdle();
    expect(rival.requests.find(u => u.pathname.startsWith('/api/games/'))!.searchParams.get('max')).toBe('500');
    expect(store.scoutProfiles.value.map(p => p.id)).toEqual([profile.id]);

    const scout = await store.loadScout(profile.id);
    expect(scout.games.length).toBeGreaterThan(0);
    expect(scout.mistakes.map(m => [m.move, m.refutation?.bestMove])).toEqual([['c6d4', 'f3e5']]);
    // Scouted mistakes never enter the own training queue.
    expect(store.mistakes.value.every(m => m.profileId !== profile.id)).toBe(true);

    const drill = await store.startSession({ profileId: profile.id });
    expect(drill).toHaveLength(1);
    expect(await store.submitMove(drill[0]!, 'f3e5')).toEqual({ kind: 'correct', best: true });
    expect(await store.submitMove(drill[0]!, 'c2c3')).toMatchObject({ kind: 'wrong' });

    await store.removeProfile(profile.id);
    expect(store.scoutProfiles.value).toEqual([]);
    expect(await repo.getMistakes(profile.id)).toEqual([]);
  });
});

describe('PGN import', () => {
  it('without an own profile creates one from the chosen name, imports and analyses', async () => {
    await store.init();
    const names = await store.scanPgn(new Blob([fixture('games.pgn')]));
    expect(names[0]).toEqual({ name: 'SMA-Nahian', games: 7 });
    await store.importPgn(new Blob([fixture('games.pgn')]), { aliases: ['SMA-Nahian'] });
    expect(store.selfProfile.value).toMatchObject({ name: 'SMA-Nahian', aliases: ['sma-nahian'], accounts: [] });
    expect(store.games.value).toHaveLength(4);
    expect(store.notice.value).toMatchObject({ kind: 'success', text: expect.stringMatching(/^Imported 4 games · 3 skipped/) });
    // The analysis continues in the background.
    await store.__jobsIdle();
    expect(store.analysisProgress.value!.phase).toBe('done');
    expect(store.selfProfile.value!.lastAnalysisAt).toBe(NOW);
  });

  it('two files imported one after the other are both imported', async () => {
    await store.init();
    const otb = '[White "Me"]\n[Black "Other"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n';
    const second = '[White "Someone"]\n[Black "Me"]\n[Result "0-1"]\n\n1. d4 d5 0-1\n';
    await Promise.all([store.importPgn(new Blob([otb]), { aliases: ['Me'] }), store.importPgn(new Blob([second]), { aliases: ['Me'] })]);
    await store.__jobsIdle();
    expect(store.games.value.map(g => g.color).sort()).toEqual(['black', 'white']);
  });

  it('imports into the own profile as one colour', async () => {
    await setupHero();
    await store.importPgn(new Blob([fixture('games.pgn')]), { asColor: 'white' });
    expect(store.games.value.filter(g => g.platform !== 'lichess' || g.sourceId === 'Xk3jP9qa')).toHaveLength(4);
  });
});

describe('data', () => {
  it('export → clear → import restores everything', async () => {
    await setupHero();
    const blob = await store.exportData();
    expect(blob.type).toBe('application/json');
    expect(store.settings.value.lastBackupAt).toBe(NOW);
    const mistakeIds = store.mistakes.value.map(m => m.id);

    await store.clearData();
    expect(store.profiles.value).toEqual([]);
    expect(store.mistakes.value).toEqual([]);
    expect(store.settings.value).toEqual(DEFAULT_SETTINGS);

    await store.importData(blob);
    expect(store.selfProfile.value!.name).toBe('Hero');
    expect(store.mistakes.value.map(m => m.id)).toEqual(mistakeIds);
    expect(store.notice.value).toMatchObject({ kind: 'success' });
    await expect(store.importData(new Blob(['not json']))).rejects.toThrow(/not valid JSON/);
  });

  it('a backup restored on another device keeps that device’s storage state, so persistence is requested there', async () => {
    // Device A: storage is persistent.
    await setupHero();
    await store.updateSettings({ storagePersisted: true });
    const blob = await store.exportData();
    // Device B: a fresh browser whose storage is not persistent yet.
    await store.__resetForTests();
    useTestDb();
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } });
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => NOW });
    await store.init();
    await store.importData(blob);
    expect(store.selfProfile.value!.name).toBe('Hero');
    expect(store.settings.value.storagePersisted).toBeUndefined();
    await store.analyze();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.settings.value.storagePersisted).toBe(true);
  });

  it('exports the visible mistakes as PGN', async () => {
    await setupHero();
    const pgn = await (await store.exportMistakesPgn()).text();
    expect(pgn).toContain('[Event "Chess Analyzer: Hero"]');
    expect(pgn.match(/\[Event /g)).toHaveLength(1);
  });

  it('loadDemo becomes the own profile when there is none, and a separate profile otherwise', async () => {
    // A demo file: a backup of a populated profile.
    const demoId = (await repo.createProfile({ name: 'Demo player', kind: 'self', accounts: [], aliases: [] })).id;
    await repo.addGames([storedGame(demoId, 'd1', 'e4 e5 Nf3', 'white', NOW)]);
    const demo = await exportBackup();
    useTestDb();
    const serveDemo = combinedFetch({ lichess, other: async input => (String(input) === '/demo/demo.json' ? Response.json(demo) : new Response('', { status: 404 })) });
    store.__setTestDeps({ fetchImpl: serveDemo, pool, book, now: () => NOW });

    await store.init();
    await store.loadDemo();
    expect(store.selfProfile.value).toMatchObject({ id: demoId, demo: true });
    // Loading it again keeps it the own profile.
    await store.loadDemo();
    expect(store.profiles.value).toHaveLength(1);

    // Setting up real accounts replaces the demo.
    await store.setupSelf([HERO]);
    await store.__jobsIdle();
    expect(store.selfProfile.value!.demo).toBeUndefined();
    expect(await repo.getProfile(demoId)).toBeUndefined();

    await store.loadDemo();
    expect(store.selfProfile.value!.name).toBe('Hero');
    expect(store.scoutProfiles.value).toMatchObject([{ id: demoId, kind: 'opponent', demo: true }]);
  });

  it('diagnostics reports versions, engine, storage and table counts', async () => {
    await setupHero();
    const d = await store.diagnostics();
    expect(d).toMatchObject({ version: expect.any(String), engine: 'sf19-lite@1', enginePoolSize: 2, analysisDepths: { triage: 10, confirm: 14 } });
    expect(d.counts).toMatchObject({ profiles: 1, mistakes: 1 });
    expect(Array.isArray(d.lastErrors)).toBe(true);
  });
});

describe('deepLinkAccounts', () => {
  it('reads accounts from the hash query or the query string', () => {
    expect(store.deepLinkAccounts('#/?lichess=SMA-Nahian&chesscom=SMA-Nahian')).toEqual([
      { platform: 'lichess', username: 'SMA-Nahian' },
      { platform: 'chesscom', username: 'SMA-Nahian' },
    ]);
    expect(store.deepLinkAccounts('#/leaks', '?lichess=x')).toEqual([{ platform: 'lichess', username: 'x' }]);
    expect(store.deepLinkAccounts('#/', '')).toEqual([]);
  });
});
