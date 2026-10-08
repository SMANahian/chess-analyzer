import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from '../core/chess';
import { OpeningBook, type OpeningsJson } from '../core/openings';
import { DEFAULT_SETTINGS, type AnalysisProgress, type Mistake } from '../core/types';
import { winLoss } from '../core/winrate';
import * as repo from '../db/repo';
import { useTestDb } from '../db/schema';
import { ENGINE_ID } from '../engine/engine';
import { setLichessCooldown } from '../sources/http';
import { fixture } from '../sources/__fixtures__/testing';
import { FakeLichess, FakePool, LINES, storedGame, testMistake, type ScoreTable } from './__fixtures__/fakes';
import { HYSTERESIS_LOSS, analyzeProfile, presetDepths } from './analysis';
import { syncProfile } from './sync';

let book: OpeningBook;
beforeAll(() => {
  book = OpeningBook.fromJson(JSON.parse(readFileSync(new URL('../../public/data/openings.json', import.meta.url), 'utf8')) as OpeningsJson);
});

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
const now = (): number => NOW;

const fenAt = (sans: string): string => sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN);
const keyOf = (fen: string): string => posKey(posFromFen(fen)!);

/** 4.Nxe5? in the Blackburne-Shilling trap, and 5.Nxf7?? after 4...Qg5. */
const P1 = fenAt('e4 e5 Nf3 Nc6 Bc4 Nd4');
const P2 = fenAt('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5');
const TABLE: ScoreTable = {
  [keyOf(P1)]: { f3e5: -250, f3d4: 40, e1g1: 30 },
  [keyOf(P2)]: { e5f7: -900, e5g4: -80 },
  // After the habit moves (for opponent refutations): Black to move.
  [keyOf(playUci(P1, 'f3e5')!)]: { d8g5: 300, d4e6: 60 },
  [keyOf(playUci(P2, 'e5f7')!)]: { g5g2: 900 },
};

beforeEach(() => {
  useTestDb();
  setLichessCooldown(0);
});

async function trapProfile(kind: 'self' | 'opponent' = 'self'): Promise<string> {
  const id = (await repo.createProfile({ name: 'Hero', kind, accounts: [], aliases: [] })).id;
  const games = [
    storedGame(id, 't1', LINES.trap!, 'white', NOW - 30 * DAY),
    storedGame(id, 't2', LINES.trap!, 'white', NOW - 20 * DAY),
    storedGame(id, 't3', LINES.trap!, 'white', NOW - 10 * DAY),
    storedGame(id, 'i1', LINES.italian!, 'white', NOW - 5 * DAY),
    storedGame(id, 'i2', LINES.italian!, 'white', NOW - 4 * DAY),
  ];
  // Distinct opponents make distinct content keys.
  await repo.addGames(games.map((g, i) => ({ ...g, contentKey: `${g.contentKey}#${i}` })));
  return id;
}

const ids = (ms: readonly Mistake[]): string[] => ms.map(m => m.move).sort();
const p1Id = (profileId: string): string => `${profileId}|${keyOf(P1)}|f3e5`;
const p2Id = (profileId: string): string => `${profileId}|${keyOf(P2)}|e5f7`;

describe('presetDepths', () => {
  it('maps presets to triage/confirm depths; an override replaces the confirm depth', () => {
    expect(presetDepths({ ...DEFAULT_SETTINGS, preset: 'quick' })).toEqual({ triage: 8, confirm: 10 });
    expect(presetDepths(DEFAULT_SETTINGS)).toEqual({ triage: 10, confirm: 14 });
    expect(presetDepths({ ...DEFAULT_SETTINGS, preset: 'thorough' })).toEqual({ triage: 12, confirm: 18 });
    expect(presetDepths({ ...DEFAULT_SETTINGS, depthOverride: 20 })).toEqual({ triage: 10, confirm: 20 });
    expect(presetDepths({ ...DEFAULT_SETTINGS, depthOverride: 6 })).toEqual({ triage: 6, confirm: 6 });
  });
});

describe('analyzeProfile', () => {
  it('finds the planted habits end to end: triage, confirm, classify, dependencies', async () => {
    const id = await trapProfile();
    const pool = new FakePool(2, TABLE);
    const progress: AnalysisProgress[] = [];
    const batches: Mistake[][] = [];
    const result = await analyzeProfile(id, { pool, book, now, onProgress: p => progress.push(p), onMistakes: ms => batches.push(ms) });

    const stored = await repo.getMistakes(id);
    expect(ids(stored)).toEqual(['e5f7', 'f3e5']);
    expect(result).toEqual({ mistakes: 2, positions: progress.at(-1)!.totalPositions, complete: true });
    const [nxe5, nxf7] = [stored.find(m => m.move === 'f3e5')!, stored.find(m => m.move === 'e5f7')!];
    expect(nxe5).toMatchObject({
      id: p1Id(id),
      color: 'white',
      count: 3,
      positionCount: 3,
      bestMove: 'f3d4',
      acceptable: ['f3d4'],
      severity: 'blunder',
      confidence: 'normal',
      kind: 'mistake',
      evalDepth: 14,
      engine: ENGINE_ID,
      status: 'active',
      lastOutcome: 'habit',
      lastPlayedAt: NOW - 10 * DAY,
      createdAt: NOW,
      path: sansToUci('e4 e5 Nf3 Nc6 Bc4 Nd4'.split(' '), 40),
    });
    expect(nxe5.winLoss).toBeCloseTo(winLoss({ cp: 40 }, { cp: -250 }), 6);
    expect(nxe5.openingName).toMatch(/Blackburne/);
    expect(nxe5.dependsOn).toBeUndefined();
    expect(nxf7.dependsOn).toBe(nxe5.id);

    // Triage everything at depth 10; confirm at 14 only the two losing positions.
    const confirms = pool.calls.filter(c => c.depth === 14).map(c => c.posKey).sort();
    expect(confirms).toEqual([keyOf(P1), keyOf(P2)].sort());
    expect(pool.calls.filter(c => c.depth === 10)).toHaveLength(result.positions);

    const last = progress.at(-1)!;
    expect(progress[0]!.phase).toBe('preparing');
    expect(last).toMatchObject({ phase: 'done', gamesUsed: 5, donePositions: last.totalPositions, cacheHits: 0, engineEvals: last.totalPositions, mistakesFound: 2 });
    expect(last.weightDone).toBe(last.weightTotal);
    expect(batches.flat().some(m => m.id === nxf7.id && m.dependsOn === nxe5.id)).toBe(true);
    expect((await repo.getProfile(id))!.lastAnalysisAt).toBe(NOW);
  });

  it('re-analysis comes from the cache and keeps user decisions', async () => {
    const id = await trapProfile();
    const pool = new FakePool(2, TABLE);
    await analyzeProfile(id, { pool, book, now });
    await repo.patchMistake(p1Id(id), { status: 'ignored', ignoreReason: 'repertoire' });
    const calls = pool.calls.length;

    const progress: AnalysisProgress[] = [];
    await analyzeProfile(id, { pool, book, now: () => NOW + DAY, onProgress: p => progress.push(p) });
    expect(pool.calls).toHaveLength(calls);
    expect(progress.at(-1)).toMatchObject({ cacheHits: progress.at(-1)!.totalPositions, engineEvals: 0 });
    const m = (await repo.getMistakes(id)).find(x => x.id === p1Id(id))!;
    expect(m).toMatchObject({ status: 'ignored', ignoreReason: 'repertoire', createdAt: NOW, updatedAt: NOW + DAY });
  });

  it('analyses synced fixture games and finds the habit the scripted engine planted', async () => {
    const lines = fixture('lichess-games.ndjson')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    const id = (await repo.createProfile({ name: 'SMA', kind: 'self', accounts: [{ platform: 'lichess', username: 'SMA-Nahian' }], aliases: [] })).id;
    await syncProfile(id, { fetchImpl: new FakeLichess(lines).fetchImpl, now });
    // The engine says 1.e4 loses: the profile played it in all 5 of its White games.
    const pool = new FakePool(3, { [keyOf(START_FEN)]: { e2e4: -150, d2d4: 30 } });
    const result = await analyzeProfile(id, { pool, book, now });
    expect(result.complete).toBe(true);
    const ms = await repo.getMistakes(id);
    expect(ms.map(m => [m.move, m.count, m.positionCount, m.color, m.severity])).toEqual([['e2e4', 5, 5, 'white', 'blunder']]);
    expect(ms[0]!.occurrences).toHaveLength(5);
  });

  it('reconciles after a complete run: no history → deleted, history → dormant, reviewed and still ≥ 3 → kept', async () => {
    const id = await trapProfile();
    const pool = new FakePool(2, TABLE);
    await analyzeProfile(id, { pool, book, now });
    const review = (mistakeId: string) => ({ mistakeId, profileId: id, due: NOW, interval: 1, ease: 2.5, reps: 1, lapses: 0 });
    await repo.putReview(review(p1Id(id)));
    await repo.putReview(review(p2Id(id)));
    const stale = testMistake(id, fenAt('d4'), 'g7g5');
    const staleReviewed = testMistake(id, fenAt('d4'), 'f7f5');
    await repo.upsertMistakes([stale, staleReviewed]);
    await repo.putReview(review(staleReviewed.id));

    // The engine changes its mind: 4.Nxe5 now loses ≈ 4 (kept: reviewed, ≥ 3), 5.Nxf7 ≈ 2 (dormant).
    const revised = new FakePool(1, { [keyOf(P1)]: { f3d4: 20, f3e5: -25 }, [keyOf(P2)]: { e5g4: 0, e5f7: -22 } });
    await repo.putEval(await revised.evaluatePosition(P1, ['f3e5'], { depth: 14 }));
    await repo.putEval(await revised.evaluatePosition(P2, ['e5f7'], { depth: 14 }));
    const result = await analyzeProfile(id, { pool, book, now });
    expect(result).toMatchObject({ mistakes: 1, complete: true });

    const rows = new Map((await repo.getMistakes(id)).map(m => [m.id, m]));
    const kept = rows.get(p1Id(id))!;
    expect(kept.dormant).toBeUndefined();
    expect(kept.winLoss).toBeGreaterThanOrEqual(HYSTERESIS_LOSS);
    expect(kept.winLoss).toBeLessThan(5);
    expect(kept).toMatchObject({ severity: 'inaccuracy', confidence: 'low' });
    expect(rows.get(p2Id(id))!.dormant).toBe(true);
    expect(rows.get(staleReviewed.id)!.dormant).toBe(true);
    expect(rows.has(stale.id)).toBe(false);
  });

  it('without a review history a move losing less than 5 is not a mistake', async () => {
    const id = await trapProfile();
    const pool = new FakePool(1, { [keyOf(P1)]: { f3d4: 20, f3e5: -25 } });
    expect((await analyzeProfile(id, { pool, book, now })).mistakes).toBe(0);
  });

  it('an aborted run keeps the mistakes found so far, rejects with AbortError and does not reconcile', async () => {
    const id = await trapProfile();
    const stale = testMistake(id, fenAt('d4'), 'g7g5');
    await repo.upsertMistakes([stale]);
    const pool = new FakePool(1, TABLE);
    const controller = new AbortController();
    // Abort as the second confirm search starts: the first confirmed position is classified by then.
    pool.onCall = () => {
      if (pool.calls.filter(c => c.depth === 14).length === 2) controller.abort();
    };
    const progress: AnalysisProgress[] = [];
    await expect(analyzeProfile(id, { pool, book, now, signal: controller.signal, onProgress: p => progress.push(p) })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const stored = await repo.getMistakes(id);
    expect(stored.map(m => m.id).sort()).toEqual([stale.id, pool.calls.find(c => c.depth === 14)!.posKey === keyOf(P1) ? p1Id(id) : p2Id(id)].sort());
    expect(progress.at(-1)!.phase).toBe('cancelled');
    expect((await repo.getProfile(id))!.lastAnalysisAt).toBeUndefined();
  });

  it('a position the engine fails on makes the run incomplete: results are stored, nothing is reconciled', async () => {
    const id = await trapProfile();
    const stale = testMistake(id, fenAt('d4'), 'g7g5');
    await repo.upsertMistakes([stale]);
    const pool = new FakePool(1, TABLE);
    pool.failOn.add(keyOf(P2));
    const progress: AnalysisProgress[] = [];
    const result = await analyzeProfile(id, { pool, book, now, onProgress: p => progress.push(p) });
    expect(result).toMatchObject({ mistakes: 1, complete: false });
    expect((await repo.getMistakes(id)).map(m => m.id).sort()).toEqual([p1Id(id), stale.id].sort());
    expect(progress.at(-1)).toMatchObject({ phase: 'done', error: '1 position could not be evaluated.' });
  });

  it('leaves a profile without games untouched (e.g. mistakes imported from the old app)', async () => {
    const id = (await repo.createProfile({ name: 'Imported', kind: 'self', accounts: [], aliases: [] })).id;
    const imported = testMistake(id, fenAt('e4'), 'f7f6');
    await repo.upsertMistakes([imported]);
    expect(await analyzeProfile(id, { pool: new FakePool(1), book, now })).toEqual({ mistakes: 0, positions: 0, complete: true });
    expect(await repo.getMistakes(id)).toEqual([imported]);
  });

  it('adds refutations for an opponent profile: the punishing reply after each habit move', async () => {
    const id = await trapProfile('opponent');
    const pool = new FakePool(2, TABLE);
    await analyzeProfile(id, { pool, book, now });
    const rows = new Map((await repo.getMistakes(id)).map(m => [m.id, m]));
    const after = playUci(P1, 'f3e5')!;
    expect(rows.get(p1Id(id))!.refutation).toEqual({
      fen: after,
      posKey: keyOf(after),
      bestMove: 'd8g5',
      bestLine: ['d8g5'],
      score: { cp: 300 },
      acceptable: ['d8g5'],
      depth: 14,
    });
    expect(rows.get(p2Id(id))!.refutation!.bestMove).toBe('g5g2');
    expect(pool.calls.filter(c => c.posKey === keyOf(after))).toEqual([expect.objectContaining({ moves: [], depth: 14 })]);

    // A re-analysis reuses the stored refutations.
    const calls = pool.calls.length;
    await analyzeProfile(id, { pool, book, now });
    expect(pool.calls).toHaveLength(calls);
    expect((await repo.getMistakes(id)).every(m => m.refutation !== undefined)).toBe(true);
  });

  it('writes results in batches while the run is going', async () => {
    const id = await trapProfile();
    const pool = new FakePool(1, TABLE);
    // 11 searches of 100 ms; a batch is written at most 300 ms after its first mistake.
    pool.delayMs = 100;
    const batches: { size: number; callsSoFar: number }[] = [];
    await analyzeProfile(id, { pool, book, now, onMistakes: ms => batches.push({ size: ms.length, callsSoFar: pool.calls.length }) });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0]!.callsSoFar).toBeLessThan(pool.calls.length);
    // The final batch carries only the rows whose dependency link changed (5.Nxf7 now depends on 4.Nxe5).
    expect(batches.at(-1)!.size).toBe(1);
  });
});

describe('dependency links', () => {
  /** Black falls for the trap: 3...Nd4 then 4...Qg5 (which only arises after 3...Nd4). */
  const TRAP_BLACK = 'e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5 Nxf7 Qxg2';
  const AFTER_BC4 = fenAt('e4 e5 Nf3 Nc6 Bc4');
  const AFTER_NXE5 = fenAt('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5');
  const SICILIAN = fenAt('e4 c5 Nf3 d6 d4');
  const BLACK_TABLE: ScoreTable = { [keyOf(AFTER_BC4)]: { c6d4: -150, f8c5: 30 }, [keyOf(AFTER_NXE5)]: { d8g5: -300, d4e6: -100 } };

  async function blackTrapProfile(): Promise<string> {
    const id = (await repo.createProfile({ name: 'Hero', kind: 'self', accounts: [], aliases: [] })).id;
    const games = [0, 1, 2].map(i => storedGame(id, `t${i}`, TRAP_BLACK, 'black', NOW - i * DAY));
    games.push(...[0, 1].map(i => storedGame(id, `s${i}`, 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6', 'black', NOW - i * DAY)));
    await repo.addGames(games.map((g, i) => ({ ...g, contentKey: `${g.contentKey}#${i}` })));
    return id;
  }

  it('an incomplete run (one unrelated position fails) keeps the stored links of the rows it rewrites', async () => {
    const id = await blackTrapProfile();
    expect((await analyzeProfile(id, { pool: new FakePool(1, BLACK_TABLE), book, now })).complete).toBe(true);
    const child = (await repo.getMistakes(id)).find(m => m.move === 'd8g5')!;
    const parent = (await repo.getMistakes(id)).find(m => m.move === 'c6d4')!;
    expect(child.dependsOn).toBe(parent.id);

    // A re-analysis at other depths (preset change), with an engine failure on an unrelated position.
    await repo.saveSettings({ preset: 'thorough' });
    const failing = new FakePool(1, BLACK_TABLE);
    failing.failOn.add(keyOf(SICILIAN));
    const r2 = await analyzeProfile(id, { pool: failing, book, now });
    expect(r2.complete).toBe(false);
    const rewritten = (await repo.getMistakes(id)).find(m => m.move === 'd8g5')!;
    expect(rewritten.evalDepth).toBe(18);
    expect(rewritten.dependsOn).toBe(parent.id);
  });

  it('a complete run removes a link that no longer applies, and rewrites only the rows whose link changed', async () => {
    const id = await trapProfile();
    await analyzeProfile(id, { pool: new FakePool(2, TABLE), book, now });
    expect((await repo.getMistakes(id)).find(m => m.id === p2Id(id))!.dependsOn).toBe(p1Id(id));

    // The engine changes its mind about 4.Nxe5: no longer a mistake, so 5.Nxf7 has no parent any more.
    await engineSays(FINE);
    const spy = vi.spyOn(repo, 'upsertMistakes');
    const reported: Mistake[][] = [];
    try {
      const result = await analyzeProfile(id, { pool: new FakePool(2, TABLE), book, now, onMistakes: ms => reported.push(ms) });
      expect(result).toMatchObject({ mistakes: 1, complete: true });
      const linkWrites = spy.mock.calls.filter(([, opts]) => opts?.keepLinks !== true);
      expect(linkWrites.map(([rows]) => rows.map(m => m.id))).toEqual([[p2Id(id)]]);
      expect(spy.mock.calls.filter(([, opts]) => opts?.keepLinks === true).flatMap(([rows]) => rows.map(m => m.id))).toEqual([p2Id(id)]);
    } finally {
      spy.mockRestore();
    }
    expect(reported.at(-1)!.map(m => [m.id, m.dependsOn])).toEqual([[p2Id(id), undefined]]);
    const rows = await repo.getMistakes(id);
    expect(rows.map(m => m.id)).toEqual([p2Id(id)]);
    expect(rows[0]!.dependsOn).toBeUndefined();

    // A run that changes no link writes no extra rows.
    const again = vi.spyOn(repo, 'upsertMistakes');
    try {
      await analyzeProfile(id, { pool: new FakePool(2, TABLE), book, now });
      expect(again.mock.calls.filter(([, opts]) => opts?.keepLinks !== true)).toEqual([]);
    } finally {
      again.mockRestore();
    }
  });
});

describe('progress estimate', () => {
  it('is based on the remaining searches, not positions: the first estimate is close although the first position costs most', async () => {
    const id = (await repo.createProfile({ name: 'Hero', kind: 'self', accounts: [], aliases: [] })).id;
    // White plays ten different first moves (4 games each), then always h4 and Rh3: one costly position
    // first (most games, ten moves), then twenty cheap ones (one move each).
    const firsts = ['a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'Nc3', 'Nf3', 'c4'];
    const games = firsts.flatMap((first, i) =>
      [0, 1, 2, 3].map(j => storedGame(id, `g${i}-${j}`, `${first} a6 h4 a5 Rh3`, 'white', NOW - (i * 4 + j) * 60_000)),
    );
    await repo.addGames(games.map((g, i) => ({ ...g, contentKey: `${g.contentKey}#${i}` })));
    let clock = 1_000;
    const pool = new FakePool(1);
    // Each search costs 10 ms of the fake clock: a position with n moves costs (n + 1) searches.
    pool.onCall = call => {
      clock += 10 * (call.moves.length + 1);
    };
    const reports: { at: number; etaMs: number }[] = [];
    const result = await analyzeProfile(id, {
      pool,
      book,
      now,
      clock: () => clock,
      onProgress: p => {
        if (p.phase === 'evaluating' && p.etaMs !== undefined) reports.push({ at: clock, etaMs: p.etaMs });
      },
    });
    expect(result).toMatchObject({ positions: 21, complete: true });
    const end = clock;
    const first = reports[0]!;
    const remaining = end - first.at;
    expect(remaining).toBeGreaterThan(0);
    expect(first.etaMs).toBeGreaterThanOrEqual(remaining / 2);
    expect(first.etaMs).toBeLessThanOrEqual(remaining * 2);
    // Every estimate stays within 2× of the truth.
    for (const r of reports.filter(r => end - r.at > 0)) expect(r.etaMs / (end - r.at)).toBeLessThanOrEqual(2);
  });

  it('gives no estimate before the first result of every engine lane is in', async () => {
    const id = await trapProfile();
    let clock = 0;
    const pool = new FakePool(4, TABLE);
    pool.onCall = () => {
      clock += 50;
    };
    const etas: { engineEvals: number; etaMs: number }[] = [];
    await analyzeProfile(id, {
      pool,
      book,
      now,
      clock: () => clock,
      onProgress: p => {
        if (p.phase === 'evaluating' && p.etaMs !== undefined) etas.push({ engineEvals: p.engineEvals, etaMs: p.etaMs });
      },
    });
    expect(etas.every(e => e.engineEvals >= 4)).toBe(true);
  });
});

const BAD: ScoreTable = { [keyOf(P1)]: { f3e5: -250, f3d4: 40 } };
const FINE: ScoreTable = { [keyOf(P1)]: { f3e5: 35, f3d4: 40 } };

/** Replaces the cached eval of P1 (as if the engine build changed its mind) at confirm depth. */
async function engineSays(table: ScoreTable): Promise<void> {
  await repo.putEval(await new FakePool(1, table).evaluatePosition(P1, ['f3e5'], { depth: 14 }));
}

describe('opponent refutations', () => {
  it('an engine error on one refutation is recorded; the others are stored and nothing runs after the analysis settles', async () => {
    const id = await trapProfile('opponent');
    const pool = new FakePool(2, TABLE);
    pool.failOn.add(keyOf(playUci(P1, 'f3e5')!));
    // The other refutation search is slow: it must finish (and be stored) before the analysis settles.
    pool.onCall = call => {
      pool.delayMs = call.posKey === keyOf(playUci(P2, 'e5f7')!) ? 60 : 0;
    };
    const errors: string[] = [];
    const result = await analyzeProfile(id, { pool, book, now: () => NOW, onPositionError: fen => errors.push(fen) });
    const settledCalls = pool.calls.length;
    expect(result).toMatchObject({ mistakes: 2, complete: false });
    expect(errors).toEqual([playUci(P1, 'f3e5')]);
    const rows = await repo.getMistakes(id);
    expect(rows.find(m => m.move === 'e5f7')!.refutation!.bestMove).toBe('g5g2');
    expect(rows.find(m => m.move === 'f3e5')!.refutation).toBeUndefined();
    expect((await repo.getProfile(id))!.lastAnalysisAt).toBe(NOW);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(pool.calls).toHaveLength(settledCalls);

    // The next run only searches the missing refutation.
    pool.failOn.clear();
    pool.onCall = null;
    const again = await analyzeProfile(id, { pool, book, now: () => NOW });
    expect(again.complete).toBe(true);
    expect(pool.calls.slice(settledCalls).map(c => c.posKey)).toEqual([keyOf(playUci(P1, 'f3e5')!)]);
  });
});

describe('re-analysis keeps the user’s history', () => {
  it('a reviewed mistake that went dormant comes back active when produced again, with its status and review', async () => {
    const id = await trapProfile();
    await analyzeProfile(id, { pool: new FakePool(1, BAD), book, now: () => NOW });
    const mid = `${id}|${keyOf(P1)}|f3e5`;
    await repo.putReview({ mistakeId: mid, profileId: id, due: NOW + DAY, interval: 1, ease: 2.5, reps: 1, lapses: 0 });

    await engineSays(FINE);
    await analyzeProfile(id, { pool: new FakePool(1, FINE), book, now: () => NOW + DAY });
    expect((await repo.getMistakes(id)).find(m => m.id === mid)).toMatchObject({ dormant: true, status: 'active' });

    await engineSays(BAD);
    await analyzeProfile(id, { pool: new FakePool(1, BAD), book, now: () => NOW + 2 * DAY });
    const back = (await repo.getMistakes(id)).find(m => m.id === mid)!;
    expect(back.dormant).toBeUndefined();
    expect(back).toMatchObject({ status: 'active', createdAt: NOW, updatedAt: NOW + 2 * DAY });
    expect(await repo.getReviews(id)).toHaveLength(1);
  });

  it('snooze and ignore decisions survive a re-analysis that changes the numbers', async () => {
    const id = await trapProfile();
    await analyzeProfile(id, { pool: new FakePool(1, BAD), book, now: () => NOW });
    const mid = `${id}|${keyOf(P1)}|f3e5`;
    await repo.patchMistake(mid, { snoozedUntil: NOW + 5 * DAY });
    await engineSays({ [keyOf(P1)]: { f3e5: -400, f3d4: 40 } });
    await analyzeProfile(id, { pool: new FakePool(1, BAD), book, now: () => NOW + DAY });
    const m = (await repo.getMistakes(id)).find(x => x.id === mid)!;
    expect(m.snoozedUntil).toBe(NOW + 5 * DAY);
    expect(m.scorePlayed).toEqual({ cp: -400 });
    expect(m.engine).toBe(ENGINE_ID);
  });
});
