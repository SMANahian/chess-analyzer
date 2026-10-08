import { describe, expect, it } from 'vitest';
import { START_FEN, playUci, posFromFen, posKey, toStandardUci } from '../core/chess';
import type { PositionEval } from '../core/types';
import { winLoss, winPercent } from '../core/winrate';
import { ENGINE_ID } from '../engine/engine';
import { FakePool, type ScoreTable } from './__fixtures__/fakes';
import { TRIAGE_LOSS, evaluateAll, isCacheHit, needsConfirm, type EvalOrigin, type EvalTask } from './scheduler';

const keyOf = (fen: string): string => posKey(posFromFen(fen)!);
const AFTER_E4 = playUci(START_FEN, 'e2e4')!;
const AFTER_D4 = playUci(START_FEN, 'd2d4')!;
const AFTER_C4 = playUci(START_FEN, 'c2c4')!;

const task = (fen: string, moves: string[], weight: number): EvalTask => ({ key: keyOf(fen), fen, moves, weight });

/** In-memory eval cache. */
function memoryCache(initial: PositionEval[] = []): {
  store: Map<string, PositionEval>;
  puts: PositionEval[];
  getCached(keys: readonly string[]): Promise<Map<string, PositionEval>>;
  putCached(ev: PositionEval): Promise<void>;
} {
  const store = new Map(initial.map(ev => [ev.key, ev]));
  const puts: PositionEval[] = [];
  return {
    store,
    puts,
    getCached: async keys => new Map(keys.flatMap(k => (store.has(k) ? [[k, store.get(k)!] as const] : []))),
    putCached: async ev => {
      puts.push(ev);
      store.set(ev.key, ev);
    },
  };
}

function run(tasks: EvalTask[], pool: FakePool, cache = memoryCache(), opts: { signal?: AbortSignal } = {}) {
  const results: { key: string; origin: EvalOrigin; depth: number }[] = [];
  const promise = evaluateAll(tasks, {
    pool,
    getCached: cache.getCached,
    putCached: cache.putCached,
    engine: ENGINE_ID,
    triageDepth: 10,
    confirmDepth: 14,
    signal: opts.signal,
    onResult: (t, ev, origin) => {
      results.push({ key: t.key, origin, depth: ev.depth });
    },
  });
  return { promise, results, cache };
}

/** Up to 40 distinct positions: after each of the 20 first moves, and after each one's first reply. */
function manyPositions(n: number): string[] {
  const after = (fen: string): string[] => {
    const pos = posFromFen(fen)!;
    return [...pos.allDests()].flatMap(([from, dests]) => [...dests].map(to => playUci(fen, toStandardUci(pos, { from, to }))!));
  };
  const first = after(START_FEN);
  return [...first, ...first.map(fen => after(fen)[0]!)].slice(0, n);
}

describe('evaluateAll', () => {
  it('evaluates highest weight first, with at most pool.size positions in flight', async () => {
    const pool = new FakePool(2);
    pool.delayMs = 5;
    const tasks = [task(AFTER_C4, ['g8f6'], 2), task(START_FEN, ['e2e4'], 9), task(AFTER_E4, ['c7c5'], 5), task(AFTER_D4, ['d7d5'], 1)];
    const { promise } = run(tasks, pool);
    const summary = await promise;
    expect(pool.calls.map(c => c.posKey)).toEqual([START_FEN, AFTER_E4, AFTER_C4, AFTER_D4].map(keyOf));
    expect(pool.maxInFlight).toBe(2);
    expect(summary).toEqual({ cacheHits: 0, engineEvals: 4, failed: 0 });
  });

  it('confirms at the confirm depth only when some move loses at least 2.5 at triage depth', async () => {
    const table: ScoreTable = {
      [keyOf(START_FEN)]: { e2e4: 30, f2f3: -60 }, // f3 loses ≈ 8 win-% → confirm
      [keyOf(AFTER_E4)]: { c7c5: 30, e7e5: 25 }, // ≈ 0.5 → triage is enough
    };
    const pool = new FakePool(1, table);
    const { promise, results, cache } = run([task(START_FEN, ['e2e4', 'f2f3'], 2), task(AFTER_E4, ['c7c5', 'e7e5'], 1)], pool);
    await promise;
    expect(pool.calls.map(c => [c.posKey, c.depth])).toEqual([
      [keyOf(START_FEN), 10],
      [keyOf(START_FEN), 14],
      [keyOf(AFTER_E4), 10],
    ]);
    expect(results).toEqual([
      { key: keyOf(START_FEN), origin: 'engine', depth: 14 },
      { key: keyOf(AFTER_E4), origin: 'engine', depth: 10 },
    ]);
    // Every eval is cached as it completes; the confirm eval replaces the triage one.
    expect(cache.puts.map(e => e.depth)).toEqual([10, 14, 10]);
    expect(cache.store.get(`${ENGINE_ID}|${keyOf(START_FEN)}`)!.depth).toBe(14);
  });

  it('uses the cache when it covers every move and is deep enough, before any engine work', async () => {
    const table: ScoreTable = { [keyOf(START_FEN)]: { e2e4: 30, f2f3: -60 } };
    const seed = new FakePool(1, table);
    const deep = await seed.evaluatePosition(START_FEN, ['e2e4', 'f2f3'], { depth: 14 });
    const quiet = await seed.evaluatePosition(AFTER_E4, ['c7c5'], { depth: 10 });
    const pool = new FakePool(1, table);
    const { promise, results } = run(
      [
        task(AFTER_D4, ['d7d5'], 9), // not cached
        task(START_FEN, ['e2e4', 'f2f3'], 5), // confirm-depth hit
        task(AFTER_E4, ['c7c5'], 3), // triage-depth hit: nothing loses 2.5
      ],
      pool,
      memoryCache([deep, quiet]),
    );
    const summary = await promise;
    expect(results.map(r => [r.key, r.origin])).toEqual([
      [keyOf(START_FEN), 'cache'],
      [keyOf(AFTER_E4), 'cache'],
      [keyOf(AFTER_D4), 'engine'],
    ]);
    expect(pool.calls.map(c => c.posKey)).toEqual([keyOf(AFTER_D4)]);
    expect(summary).toMatchObject({ cacheHits: 2, engineEvals: 1 });
  });

  it('re-evaluates a cached position when a new move was played there or the cached depth is too low', async () => {
    const table: ScoreTable = { [keyOf(START_FEN)]: { e2e4: 30, f2f3: -60 } };
    const seed = new FakePool(1, table);
    const triageOnly = await seed.evaluatePosition(START_FEN, ['e2e4', 'f2f3'], { depth: 10 });
    expect(isCacheHit(triageOnly, task(START_FEN, ['e2e4', 'f2f3'], 1), { triageDepth: 10, confirmDepth: 14 })).toBe(false);
    const deep = await seed.evaluatePosition(START_FEN, ['e2e4'], { depth: 18 });
    expect(isCacheHit(deep, task(START_FEN, ['e2e4'], 1), { triageDepth: 10, confirmDepth: 14 })).toBe(true);
    expect(isCacheHit(deep, task(START_FEN, ['e2e4', 'g1f3'], 1), { triageDepth: 10, confirmDepth: 14 })).toBe(false);
    const shallow = await seed.evaluatePosition(START_FEN, ['e2e4'], { depth: 8 });
    expect(isCacheHit(shallow, task(START_FEN, ['e2e4'], 1), { triageDepth: 10, confirmDepth: 14 })).toBe(false);
    expect(needsConfirm(triageOnly, ['e2e4'])).toBe(false);
    expect(needsConfirm(triageOnly, ['f2f3'])).toBe(true);
  });

  it('on abort starts nothing new and rejects with an AbortError after the positions in flight settle', async () => {
    const pool = new FakePool(2);
    pool.delayMs = 20;
    const controller = new AbortController();
    const tasks = [START_FEN, AFTER_E4, AFTER_D4, AFTER_C4].map((fen, i) => task(fen, [], 10 - i));
    const { promise, results } = run(tasks, pool, memoryCache(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.inFlight).toBe(0);
    expect(pool.calls).toHaveLength(2);
    expect(results).toEqual([]);
  });

  it('rejects at once when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const pool = new FakePool(1);
    await expect(run([task(START_FEN, [], 1)], pool, memoryCache(), { signal: controller.signal }).promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.calls).toEqual([]);
  });

  it('skips a position the engine fails on, and gives up after three failures in a row', async () => {
    const pool = new FakePool(1);
    pool.failOn.add(keyOf(AFTER_E4));
    const errors: string[] = [];
    const cache = memoryCache();
    const summary = await evaluateAll([task(START_FEN, [], 3), task(AFTER_E4, [], 2), task(AFTER_D4, [], 1)], {
      pool,
      ...cache,
      engine: ENGINE_ID,
      triageDepth: 10,
      confirmDepth: 14,
      onResult: () => undefined,
      onError: (t, err) => errors.push(`${t.key}: ${(err as Error).message}`),
    });
    expect(summary).toEqual({ cacheHits: 0, engineEvals: 2, failed: 1 });
    expect(errors).toHaveLength(1);

    const broken = new FakePool(1);
    for (const fen of [START_FEN, AFTER_E4, AFTER_D4, AFTER_C4]) broken.failOn.add(keyOf(fen));
    const tasks = [START_FEN, AFTER_E4, AFTER_D4, AFTER_C4].map((fen, i) => task(fen, [], 10 - i));
    await expect(run(tasks, broken).promise).rejects.toThrow(/engine crashed/);
    expect(broken.calls).toHaveLength(3);
  });

  it('stops when onResult throws (e.g. the database is full)', async () => {
    const pool = new FakePool(1);
    const cache = memoryCache();
    await expect(
      evaluateAll([task(START_FEN, [], 2), task(AFTER_E4, [], 1)], {
        pool,
        ...cache,
        engine: ENGINE_ID,
        triageDepth: 10,
        confirmDepth: 14,
        onResult: () => {
          throw new Error('QuotaExceededError');
        },
      }),
    ).rejects.toThrow('QuotaExceededError');
    expect(pool.calls).toHaveLength(1);
  });
});

describe('scheduler under stress', () => {
  for (const size of [1, 4]) {
    it(`pool size ${size}: every task settles exactly once, failures are recorded and the run continues`, async () => {
      const fens = manyPositions(40);
      expect(fens).toHaveLength(40);
      const pool = new FakePool(size);
      pool.delayMs = 1;
      fens.forEach((fen, i) => i % 5 === 0 && pool.failOn.add(keyOf(fen)));
      const results: string[] = [];
      const errors: string[] = [];
      const summary = await evaluateAll(
        fens.map((fen, i) => task(fen, [], 100 - i)),
        {
          pool,
          ...memoryCache(),
          engine: ENGINE_ID,
          triageDepth: 10,
          confirmDepth: 14,
          onResult: t => void results.push(t.key),
          onError: t => void errors.push(t.key),
        },
      );
      expect(summary).toEqual({ cacheHits: 0, engineEvals: 32, failed: 8 });
      expect(new Set(results).size).toBe(32);
      expect(errors).toHaveLength(8);
      expect(pool.maxInFlight).toBeLessThanOrEqual(size);
      expect(pool.inFlight).toBe(0);
    });
  }

  it('aborting with four positions in flight: rejects once they settle, never reports afterwards', async () => {
    const fens = manyPositions(20);
    const pool = new FakePool(4);
    pool.delayMs = 15;
    const controller = new AbortController();
    const reported: string[] = [];
    let settled = false;
    const run = evaluateAll(
      fens.map((fen, i) => task(fen, [], 50 - i)),
      {
        pool,
        ...memoryCache(),
        engine: ENGINE_ID,
        triageDepth: 10,
        confirmDepth: 14,
        signal: controller.signal,
        onResult: t => {
          if (settled) throw new Error('reported after the run settled');
          reported.push(t.key);
        },
      },
    ).finally(() => (settled = true));
    setTimeout(() => controller.abort(), 40);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.inFlight).toBe(0);
    expect(reported.length).toBeLessThan(20);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(pool.calls.length).toBeLessThanOrEqual(reported.length + 4);
  });

  it('zero-move tasks and an all-cache-hit run finish without engine work', async () => {
    const fens = manyPositions(6);
    const seed = new FakePool(1);
    const cached = await Promise.all(fens.map(fen => seed.evaluatePosition(fen, [], { depth: 14 })));
    const pool = new FakePool(4);
    const origins: EvalOrigin[] = [];
    const summary = await evaluateAll(
      fens.map((fen, i) => task(fen, [], i)),
      { pool, ...memoryCache(cached), engine: ENGINE_ID, triageDepth: 10, confirmDepth: 14, onResult: (_t, _ev, o) => void origins.push(o) },
    );
    expect(summary).toEqual({ cacheHits: 6, engineEvals: 0, failed: 0 });
    expect(pool.calls).toEqual([]);
    expect(origins.every(o => o === 'cache')).toBe(true);
  });
});

describe('cache rules', () => {
  it('a cached record of another engine build under the same key is not a hit', async () => {
    const seed = new FakePool(1);
    const ev = await seed.evaluatePosition(START_FEN, ['e2e4'], { depth: 18 });
    const foreign: PositionEval = { ...ev, engine: 'sf18-full@1' };
    const pool = new FakePool(1);
    const summary = await evaluateAll([task(START_FEN, ['e2e4'], 1)], {
      pool,
      ...memoryCache([foreign]),
      engine: ENGINE_ID,
      triageDepth: 10,
      confirmDepth: 14,
      onResult: () => undefined,
    });
    expect(summary.cacheHits).toBe(0);
    expect(pool.calls).toHaveLength(1);
  });

  it('re-evaluating for a new move keeps the moves the cached record already had (training verdicts, other profiles)', async () => {
    const table: ScoreTable = { [keyOf(START_FEN)]: { e2e4: 30, g1f3: 25, b1c3: 10 } };
    const seed = new FakePool(1, table);
    const cached = await seed.evaluatePosition(START_FEN, ['e2e4', 'g1f3'], { depth: 14 });
    const cache = memoryCache([cached]);
    const pool = new FakePool(1, table);
    await evaluateAll([task(START_FEN, ['e2e4', 'b1c3'], 1)], { pool, ...cache, engine: ENGINE_ID, triageDepth: 10, confirmDepth: 14, onResult: () => undefined });
    const stored = cache.store.get(`${ENGINE_ID}|${keyOf(START_FEN)}`)!;
    expect(Object.keys(stored.moves).sort()).toEqual(['b1c3', 'e2e4', 'g1f3']);
  });

  it('a cached triage record that already shows a 2.5 loss goes straight to the confirm search', async () => {
    const table: ScoreTable = { [keyOf(START_FEN)]: { e2e4: 30, f2f3: -60 } };
    const seed = new FakePool(1, table);
    const triage = await seed.evaluatePosition(START_FEN, ['e2e4', 'f2f3'], { depth: 10 });
    const pool = new FakePool(1, table);
    await evaluateAll([task(START_FEN, ['e2e4', 'f2f3'], 1)], { pool, ...memoryCache([triage]), engine: ENGINE_ID, triageDepth: 10, confirmDepth: 14, onResult: () => undefined });
    expect(pool.calls.map(c => c.depth)).toEqual([14]);
  });

  it('confirms at exactly the 2.5 threshold and not below it', () => {
    // cp at which a move loses exactly TRIAGE_LOSS against a 0.00 best move.
    const k = 0.00368208;
    const target = 50 - TRIAGE_LOSS;
    const cp = -Math.log(2 / ((target - 50) / 50 + 1) - 1) / k;
    const at = (played: number): PositionEval => ({
      key: 'k',
      posKey: 'p',
      fen: START_FEN,
      engine: ENGINE_ID,
      depth: 10,
      best: { move: 'e2e4', score: { cp: 0 }, pv: ['e2e4'], depth: 10 },
      moves: { f2f3: { move: 'f2f3', score: { cp: played }, pv: ['f2f3'], depth: 10 } },
      updatedAt: 0,
    });
    expect(winPercent({ cp })).toBeCloseTo(target, 9);
    expect(winLoss({ cp: 0 }, { cp: cp - 0.01 })).toBeGreaterThan(TRIAGE_LOSS);
    expect(needsConfirm(at(cp - 0.01), ['f2f3'])).toBe(true);
    expect(needsConfirm(at(cp + 0.01), ['f2f3'])).toBe(false);
    // "Every move": one losing move among several good ones is enough.
    expect(needsConfirm(at(cp - 0.01), ['e2e4', 'f2f3'])).toBe(true);
  });
});
