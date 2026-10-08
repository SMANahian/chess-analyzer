// Store behaviour across interruptions and changes of state: cancelled, failed and resumed jobs,
// profiles and accounts changed while jobs run, other tabs, backups (incl. the old app's), daily limits.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from '../core/chess';
import { OpeningBook, type OpeningsJson } from '../core/openings';
import { exportBackup } from '../db/backup';
import * as repo from '../db/repo';
import { getDb, useTestDb } from '../db/schema';
import { setLichessCooldown } from '../sources/http';
import { FakeLichess, FakePool, lichessHistory, lichessLine, storedGame, type ScoreTable } from '../services/__fixtures__/fakes';
import { CHANNEL, JOB_LOCK } from '../services/jobs';
import * as store from './store';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
const fenAt = (sans: string): string => sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN);
const keyOf = (fen: string): string => posKey(posFromFen(fen)!);

const AFTER_BC4 = fenAt('e4 e5 Nf3 Nc6 Bc4');
/** New games: hero (White) plays 2.Nc3?? in the English after 1.c4 e5. */
const AFTER_C4_E5 = fenAt('c4 e5');
const TABLE: ScoreTable = { [keyOf(AFTER_BC4)]: { c6d4: -150, f8c5: 30 }, [keyOf(AFTER_C4_E5)]: { b1c3: -200, g2g3: 30 } };

let book: OpeningBook;
beforeAll(() => {
  book = OpeningBook.fromJson(JSON.parse(readFileSync(new URL('../../public/data/openings.json', import.meta.url), 'utf8')) as OpeningsJson);
});

let lichess: FakeLichess;
let pool: FakePool;
let clock = NOW;

beforeEach(async () => {
  await store.__resetForTests();
  useTestDb();
  setLichessCooldown(0);
  clock = NOW;
  lichess = new FakeLichess(lichessHistory('hero', 120, NOW - DAY));
  pool = new FakePool(2, TABLE);
  store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => clock });
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

function englishGames(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    lichessLine({ id: `en${String(i).padStart(6, '0')}`, createdAt: NOW - DAY / 2 + i * 60_000, white: 'hero', black: `x${i}`, moves: 'c4 e5 Nc3 Nf6 g3 d5' }),
  );
}

const moves = (): string[] => store.mistakes.value.map(m => m.move).sort();

describe('analysis that did not finish', () => {
  it('a cancelled analysis of newly synced games is finished by the next refresh, even without new games', async () => {
    await setupHero();
    expect(moves()).toEqual(['c6d4']);
    lichess.games = [...lichess.games, ...englishGames(4)];
    clock = NOW + DAY;
    // Cancel as soon as the new position reaches the engine.
    pool.onCall = call => {
      if (call.posKey === keyOf(AFTER_C4_E5)) store.cancelJobs();
    };
    await store.refresh().catch(() => undefined);
    await store.__jobsIdle();
    expect(store.analysisProgress.value!.phase).toBe('cancelled');
    pool.onCall = null;
    await store.refresh();
    expect(moves()).toEqual(['b1c3', 'c6d4']);
  });

  it('an analysis with positions the engine failed on runs again at the next refresh', async () => {
    pool.failOn.add(keyOf(AFTER_BC4));
    await setupHero();
    expect(store.analysisProgress.value).toMatchObject({ phase: 'done', error: expect.stringMatching(/could not be evaluated/) });
    // Not silent: a notice, and the failing position in the diagnostics.
    expect(store.notice.value).toMatchObject({ kind: 'error', text: '1 position could not be evaluated. The next refresh tries them again.' });
    expect(((await store.diagnostics()).lastErrors as { context: string }[]).some(e => e.context.startsWith('analysis '))).toBe(true);
    expect(moves()).toEqual([]);
    pool.failOn.clear();
    await store.refresh();
    expect(moves()).toEqual(['c6d4']);
  });
});

describe('removeProfile while its job runs', () => {
  it('leaves no rows behind, so a backup made afterwards can be restored', async () => {
    await store.init();
    pool.delayMs = 20;
    await store.setupSelf([HERO]);
    await vi.waitFor(() => expect(store.analysisProgress.value?.phase).toBe('evaluating'), { timeout: 5000 });
    // Let a few results be buffered by the writer.
    await new Promise(resolve => setTimeout(resolve, 60));
    await store.removeProfile(store.selfProfile.value!.id);
    await store.__jobsIdle();
    await new Promise(resolve => setTimeout(resolve, 400));
    const db = getDb();
    expect({ games: await db.games.count(), mistakes: await db.mistakes.count(), syncState: await db.syncState.count() }).toEqual({
      games: 0,
      mistakes: 0,
      syncState: 0,
    });
    const blob = await store.exportData();
    await store.clearData();
    await expect(store.importData(blob)).resolves.toBeUndefined();
  });
});

describe('legacy backup over the example profile', () => {
  it('a v2 backup imported while the demo is the own profile is not deleted by the next setupSelf', async () => {
    const demoId = (await repo.createProfile({ name: 'Demo', kind: 'self', accounts: [], aliases: [], demo: true })).id;
    await repo.addGames([storedGame(demoId, 'd1', 'e4 e5 Nf3', 'white', NOW)]);
    await store.init();
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const v2 = {
      backup_version: 2,
      created_at: '2026-01-01T10:00:00.123456+00:00',
      schema_version: 7,
      pgn_files: [],
      mistakes: [
        {
          id: 1,
          color: 'black',
          fen: afterE4,
          user_move: 'f7f6',
          top_moves: ['c7c5', 'e7e5'],
          avg_cp_loss: 160,
          pair_count: 5,
          mastered: false,
          mastered_at: null,
          snoozed: false,
          snoozed_at: null,
          opening_eco: 'B00',
          opening_name: "King's Pawn Game",
          analyzed_at: '2026-01-01T09:00:00.000001+00:00',
        },
      ],
      sync_configs: [{ color: 'black', platform: 'lichess', username: 'hero', last_synced_at: null, created_at: '2025-12-01T00:00:00+00:00' }],
      synced_game_ids: [],
      practice_sessions: [],
    };
    await store.importData(new Blob([JSON.stringify(v2)]));
    expect(store.selfProfile.value!.demo).not.toBe(true);
    expect(store.mistakes.value.map(m => m.move)).toEqual(['f7f6']);
    expect(store.games.value).toEqual([]);
  });
});

describe('backup round trip', () => {
  it('export → clear → import gives identical rows in every table', async () => {
    await setupHero();
    const m = store.mistakes.value[0]!;
    await store.setMistakeStatus(m.id, 'active', { snoozeDays: 2 });
    const [card] = await store.startSession();
    if (card) await store.gradeCard(card, 'hard');
    const before = await exportBackup({ now: 1 });
    const blob = await store.exportData();
    await store.clearData();
    await store.importData(blob);
    const after = await exportBackup({ now: 1 });
    const strip = (b: typeof before): unknown => ({ ...b, settings: { ...b.settings, lastBackupAt: 0 }, attempts: b.attempts.map(({ id: _id, ...a }) => a) });
    expect(strip(after)).toEqual(strip(before));
  });
});

describe('daily new-card limit', () => {
  it('counts the cards first attempted today, also after a backup restore', async () => {
    lichess.games = [...lichess.games, ...englishGames(4)];
    await setupHero();
    await store.updateSettings({ newPerDay: 1 });
    expect(moves()).toEqual(['b1c3', 'c6d4']);
    const [card] = await store.startSession();
    await store.gradeCard(card!, 'good');
    expect(await store.startSession()).toEqual([]);
    const blob = await store.exportData();
    await store.clearData();
    await store.importData(blob);
    expect(await store.startSession()).toEqual([]);
    expect(store.dueCount.value).toBe(0);
    // Tomorrow: the reviewed card is due again (interval 1 day), and the other card is offered.
    clock = NOW + DAY;
    expect((await store.startSession()).map(c => c.isNew)).toEqual([false, true]);
  });
});

describe('first run', () => {
  it('a first sync interrupted early still gives a quick first analysis (300 more games) before the backfill', async () => {
    lichess = new FakeLichess(lichessHistory('hero', 700, NOW - DAY, { spacingMs: 3_600_000 }));
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => clock });
    await store.init();
    const stopSync = store.syncProgress.subscribe(p => {
      if (p && p.fetched >= 130 && p.phase === 'running') store.cancelJobs();
    });
    await store.setupSelf([HERO]);
    await store.__jobsIdle();
    stopSync();
    expect(await repo.countGames(store.selfProfile.value!.id)).toBeGreaterThan(0);

    const done: number[] = [];
    const stop = store.analysisProgress.subscribe(p => p?.phase === 'done' && done.push(p.gamesUsed));
    await store.refresh();
    stop();
    const all = 700 - Math.floor(700 / 7);
    expect(done).toHaveLength(2);
    // The ~130 games of the interrupted run plus at most 300 more.
    expect(done[0]).toBeLessThanOrEqual(130 + 300);
    expect(done[1]).toBe(all);
  });
});

describe('another tab holds the job lock', () => {
  it('a PGN import is refused with an error instead of being dropped; a refresh just waits for that tab', async () => {
    await store.init();
    // Another tab holds the lock for good.
    vi.stubGlobal('navigator', {
      locks: { request: async (_n: string, _o: unknown, cb: (lock: unknown) => Promise<unknown>) => cb(null), query: async () => ({ held: [{ name: 'chess-analyzer:jobs' }] }) },
    });
    const pgn = '[White "Me"]\n[Black "Other"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n';
    await expect(store.importPgn(new Blob([pgn]), { aliases: ['Me'] })).rejects.toThrow(/another tab/i);
    expect(store.otherTabBusy.value).toBe(true);
    await expect(store.refresh()).resolves.toBeUndefined();
  });
});

describe('another tab that goes away mid-job', () => {
  /** Web Locks as in a browser: the other tab holds the job lock until it is closed. */
  function otherTab(): { close(): void } {
    let held = true;
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_n: string, _o: unknown, cb: (lock: unknown) => Promise<unknown>) => cb(held ? null : {}),
        query: async () => ({ held: held ? [{ name: JOB_LOCK }] : [] }),
      },
    });
    return {
      close: () => {
        held = false;
      },
    };
  }

  it('otherTabBusy is cleared once no tab holds the job lock, although "job-done" never came', async () => {
    const tab = otherTab();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await store.init();
      expect(store.otherTabBusy.value).toBe(true);
      // Its job keeps running: still busy after a check.
      await vi.advanceTimersByTimeAsync(store.OTHER_TAB_POLL_MS);
      expect(store.otherTabBusy.value).toBe(true);
      // Meanwhile it stored games; then the tab is closed (or crashes) mid-job: no 'job-done' message.
      const id = (await repo.ensureSelfProfile({ name: 'hero', accounts: [], aliases: [] }, NOW)).id;
      await repo.addGames([storedGame(id, 'a', 'e4 e5 Nf3', 'white', NOW)]);
      tab.close();
      await vi.advanceTimersByTimeAsync(store.OTHER_TAB_POLL_MS);
      await vi.waitFor(() => expect(store.otherTabBusy.value).toBe(false));
      // What it stored is shown.
      await vi.waitFor(() => expect(store.games.value).toHaveLength(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('is re-checked at once when the page becomes visible (timers are throttled in hidden tabs)', async () => {
    const tab = otherTab();
    const onVisible: (() => void)[] = [];
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hidden: false,
      addEventListener: (type: string, cb: () => void) => type === 'visibilitychange' && onVisible.push(cb),
      removeEventListener() {},
    });
    await store.init();
    expect(store.otherTabBusy.value).toBe(true);
    tab.close();
    for (const cb of onVisible) cb();
    await vi.waitFor(() => expect(store.otherTabBusy.value).toBe(false));
  });

  it('without a way to query the lock, only "job-done" clears it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const tabA = new BroadcastChannel(CHANNEL);
    try {
      await store.init();
      tabA.postMessage({ type: 'job-started', profileId: 'p' });
      await vi.waitFor(() => expect(store.otherTabBusy.value).toBe(true));
      await vi.advanceTimersByTimeAsync(3 * store.OTHER_TAB_POLL_MS);
      expect(store.otherTabBusy.value).toBe(true);
      tabA.postMessage({ type: 'job-done', profileId: 'p' });
      await vi.waitFor(() => expect(store.otherTabBusy.value).toBe(false));
    } finally {
      tabA.close();
      vi.useRealTimers();
    }
  });
});

describe('the job record cannot be written (storage full, database closed)', () => {
  it('the job still releases the screen wake lock and tells the other tabs it is over', async () => {
    let held = 0;
    vi.stubGlobal('document', { visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('navigator', {
      wakeLock: {
        request: async () => {
          held++;
          return { release: async () => void held-- };
        },
      },
    });
    await store.init();
    const p = await repo.createProfile({ name: 'rival', kind: 'opponent', accounts: [], aliases: [] });
    const tabB = new BroadcastChannel(CHANNEL);
    const heard: string[] = [];
    tabB.onmessage = (e: MessageEvent) => heard.push((e.data as { type: string }).type);
    const meta = getDb().meta;
    const put = meta.put.bind(meta);
    meta.put = ((row: { key: string; value: unknown }, key?: unknown) =>
      row.key === 'job' ? Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError')) : put(row, key as never)) as typeof meta.put;
    try {
      await expect(store.analyze(p.id)).rejects.toThrow(/quota/);
      await vi.waitFor(() => expect(heard).toEqual(['job-started', 'job-done']));
      expect(held).toBe(0);
      expect(store.busy.value).toBe(false);
    } finally {
      tabB.close();
    }
  });
});

describe('scouted players', () => {
  it('keep only their newest SCOUT_GAMES games per account, also after later refreshes', async () => {
    await store.init();
    const rival = new FakeLichess(lichessHistory('rival', 1400, NOW - DAY, { idPrefix: 'r', spacingMs: 3_600_000 }));
    store.__setTestDeps({ fetchImpl: rival.fetchImpl, pool, book, now: () => clock });
    const profile = await store.addScout({ accounts: [{ platform: 'lichess', username: 'rival' }] });
    await store.__jobsIdle();
    await store.refresh(profile.id);
    await store.refresh(profile.id);
    const received = rival.requests.filter(u => u.pathname.startsWith('/api/games/'));
    expect(received.every(u => Number(u.searchParams.get('max') ?? Infinity) <= store.SCOUT_GAMES)).toBe(true);
    const stored = (await store.loadScout(profile.id)).games.length;
    expect(stored).toBeLessThanOrEqual(store.SCOUT_GAMES);
  });
});

describe('changing accounts while jobs are queued', () => {
  it('the refresh for the new accounts runs even though the old one was still queued behind another job', async () => {
    await setupHero();
    const rival = new FakeLichess(lichessHistory('rival', 40, NOW - DAY, { idPrefix: 'r' }));
    const other = new FakeLichess(lichessHistory('hero2', 30, NOW - DAY, { idPrefix: 'h' }));
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rival')) return rival.fetchImpl(input, init);
      if (url.includes('/hero2')) return other.fetchImpl(input, init);
      return lichess.fetchImpl(input, init);
    }) as typeof fetch;
    store.__setTestDeps({ fetchImpl, pool, book, now: () => clock });
    pool.delayMs = 20;
    // A scout analysis runs; the own refresh waits behind it.
    await store.addScout({ accounts: [{ platform: 'lichess', username: 'rival' }] });
    const queued = store.refresh().catch(() => undefined);
    await store.updateSelfAccounts([{ platform: 'lichess', username: 'hero2' }]);
    await queued;
    await store.__jobsIdle();
    expect(other.requests.some(u => u.pathname.startsWith('/api/games/user/'))).toBe(true);
    expect(store.games.value.length).toBeGreaterThan(0);
    expect(store.games.value.every(g => g.sourceId.startsWith('h'))).toBe(true);
  });
});

describe('cancelJobs during a sync', () => {
  it('stops the sync, never starts its analysis, leaves nothing busy, and the next refresh completes', async () => {
    lichess = new FakeLichess(lichessHistory('hero', 400, NOW - DAY));
    store.__setTestDeps({ fetchImpl: lichess.fetchImpl, pool, book, now: () => clock });
    await store.init();
    const phases: string[] = [];
    const stop = store.analysisProgress.subscribe(p => p && phases.push(p.phase));
    const stopSync = store.syncProgress.subscribe(p => {
      if (p && p.fetched >= 150 && p.phase === 'running') store.cancelJobs();
    });
    await store.setupSelf([HERO]);
    await store.__jobsIdle();
    stopSync();
    stop();
    expect(store.syncProgress.value!.phase).toBe('cancelled');
    expect(phases).toEqual([]);
    expect(store.busy.value).toBe(false);
    expect(await repo.getMeta('job')).toBeUndefined();
    await store.refresh();
    expect(store.analysisProgress.value!.phase).toBe('done');
    expect(store.games.value.length).toBe(400 - Math.floor(400 / 7));
  });
});
