import { afterEach, describe, expect, it, vi } from 'vitest';
import { START_FEN } from '../core/chess';
import { ENGINE_ID, type EngineWorkerLike } from './engine';
import { EnginePool, defaultPoolSize } from './pool';

const ITALIAN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';
const AFTER_C4 = 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1';
const AFTER_NF3 = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1';
const MATED = '3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1';

const BEST: Record<string, string> = { [START_FEN]: 'e2e4', [ITALIAN]: 'c2c3', [MATED]: '(none)' };
const SCORES: Record<string, number> = { e2e4: 30, d2d4: 28, g2g4: -90, f2f3: -60, c2c3: 25, e1g1: 18, d2d3: 15 };

/**
 * A tiny fake Stockfish: answers the handshake, and for `go` reports the best move (or the single
 * searchmoves entry) with a fixed score. `delay` holds each search open (ms, real timers; 0 = microtask).
 */
class Farm {
  readonly workers: FakeEngine[] = [];
  active = 0;
  maxActive = 0;
  delay = 0;
  /** Worker index → what it does on its first `go`. */
  failOnGo = new Set<number>();
  hangOnGo = new Set<number>();

  create = (): EngineWorkerLike => {
    const w = new FakeEngine(this, this.workers.length);
    this.workers.push(w);
    return w;
  };

  allSent(): string[] {
    return this.workers.flatMap(w => w.sent);
  }
}

class FakeEngine implements EngineWorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: string[] = [];
  terminated = false;
  private fen = '';
  private pending: (() => void) | null = null;

  constructor(
    private readonly farm: Farm,
    readonly index: number,
  ) {}

  postMessage(cmd: string): void {
    this.sent.push(cmd);
    if (this.terminated) return;
    if (cmd === 'uci') this.reply('id name Fake', 'uciok');
    else if (cmd === 'isready') this.reply('readyok');
    else if (cmd.startsWith('position fen ')) this.fen = cmd.slice('position fen '.length);
    else if (cmd.startsWith('go ')) this.go(cmd);
    else if (cmd === 'stop') this.pending?.();
  }

  terminate(): void {
    this.terminated = true;
  }

  private reply(...lines: string[]): void {
    void Promise.resolve().then(() => {
      for (const data of lines) if (!this.terminated) this.onmessage?.({ data });
    });
  }

  private go(cmd: string): void {
    if (this.farm.failOnGo.has(this.index)) {
      void Promise.resolve().then(() => this.onerror?.(new Error('RuntimeError: memory access out of bounds')));
      return;
    }
    if (this.farm.hangOnGo.has(this.index)) return;
    const depth = Number(/go depth (\d+)/.exec(cmd)?.[1]);
    const move = /searchmoves (\S+)/.exec(cmd)?.[1] ?? BEST[this.fen] ?? 'e2e4';
    this.farm.active++;
    this.farm.maxActive = Math.max(this.farm.maxActive, this.farm.active);
    const finish = (): void => {
      if (this.pending !== finish) return;
      this.pending = null;
      this.farm.active--;
      if (move === '(none)') return this.reply('info depth 0 score mate 0', 'bestmove (none)');
      const cp = SCORES[move] ?? 0;
      this.reply(`info depth ${depth} seldepth ${depth} multipv 1 score cp ${cp} nodes 1000 nps 1000 time 1 pv ${move} e7e5`, `bestmove ${move}`);
    };
    this.pending = finish;
    if (this.farm.delay > 0) setTimeout(finish, this.farm.delay);
    else void Promise.resolve().then(finish);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

/** `position fen` commands in the order the pool sent them (one per search). */
function positions(farm: Farm): string[] {
  return farm.allSent().filter(c => c.startsWith('position fen ')).map(c => c.slice('position fen '.length));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('EnginePool.evaluatePosition', () => {
  it('runs a best-move search, then searchmoves for every other requested move', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const before = Date.now();
    const ev = await pool.evaluatePosition(START_FEN, ['e2e4', 'g2g4', 'f2f3'], { depth: 8 });
    const posKey = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
    expect(ev).toMatchObject({ key: `${ENGINE_ID}|${posKey}`, posKey, fen: START_FEN, engine: ENGINE_ID, depth: 8 });
    expect(ev.best).toEqual({ move: 'e2e4', score: { cp: 30 }, pv: ['e2e4', 'e7e5'], depth: 8 });
    expect(Object.keys(ev.moves).sort()).toEqual(['e2e4', 'f2f3', 'g2g4']);
    expect(ev.moves.e2e4).toEqual(ev.best);
    expect(ev.moves.g2g4?.score).toEqual({ cp: -90 });
    expect(ev.updatedAt).toBeGreaterThanOrEqual(before);
    // The other moves in UCI order, whatever the order asked for.
    expect(farm.allSent().filter(c => c.startsWith('go '))).toEqual(['go depth 8', 'go depth 8 searchmoves f2f3', 'go depth 8 searchmoves g2g4']);
    pool.terminate();
  });

  it('searches the same moves in the same order however the caller orders them (shared hash table)', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    await pool.evaluatePosition(START_FEN, ['g2g4', 'a2a3', 'f2f3', 'a2a3'], { depth: 8 });
    const first = farm.allSent().filter(c => c.startsWith('go '));
    await pool.evaluatePosition(START_FEN, ['f2f3', 'g2g4', 'a2a3'], { depth: 8 });
    expect(farm.allSent().filter(c => c.startsWith('go ')).slice(first.length)).toEqual(first);
    expect(first).toEqual(['go depth 8', 'go depth 8 searchmoves a2a3', 'go depth 8 searchmoves f2f3', 'go depth 8 searchmoves g2g4']);
    pool.terminate();
  });

  it('sends ucinewgame + isready before every position (determinism)', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    await Promise.all([
      pool.evaluatePosition(START_FEN, ['d2d4'], { depth: 6 }),
      pool.evaluatePosition(ITALIAN, ['d2d3'], { depth: 6 }),
      pool.evaluatePosition(START_FEN, [], { depth: 6 }),
    ]);
    const protocol = farm.workers[0]!.sent.filter(c => !c.startsWith('setoption') && c !== 'uci');
    expect(protocol).toEqual([
      'isready',
      'ucinewgame', 'isready', `position fen ${START_FEN}`, 'go depth 6', `position fen ${START_FEN}`, 'go depth 6 searchmoves d2d4',
      'ucinewgame', 'isready', `position fen ${ITALIAN}`, 'go depth 6', `position fen ${ITALIAN}`, 'go depth 6 searchmoves d2d3',
      'ucinewgame', 'isready', `position fen ${START_FEN}`, 'go depth 6',
    ]);
    pool.terminate();
  });

  it('drops illegal moves and converts king-takes-rook castling before searching', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const ev = await pool.evaluatePosition(ITALIAN, ['e1h1', 'e1g1', 'a1a5', 'e1d1', 'O-O', 'h1f1'], { depth: 8 });
    const sent = farm.allSent();
    expect(sent.filter(c => c.startsWith('go '))).toEqual(['go depth 8', 'go depth 8 searchmoves e1g1', 'go depth 8 searchmoves h1f1']);
    expect(sent.some(c => /e1h1|a1a5|e1d1|O-O/.test(c))).toBe(false);
    expect(Object.keys(ev.moves).sort()).toEqual(['c2c3', 'e1g1', 'h1f1']);
    expect(ev.moves.e1g1).toMatchObject({ move: 'e1g1', score: { cp: 18 } });
    pool.terminate();
  });

  it('does not search the best move twice, whatever its spelling', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const ev = await pool.evaluatePosition(START_FEN, ['e2e4', 'e2e4'], { depth: 5 });
    expect(farm.allSent().filter(c => c.startsWith('go '))).toEqual(['go depth 5']);
    expect(ev.moves).toEqual({ e2e4: ev.best });
    pool.terminate();
  });

  it('rejects invalid input and positions without legal moves', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    await expect(pool.evaluatePosition('garbage', [], { depth: 5 })).rejects.toThrow(/Invalid FEN/);
    await expect(pool.evaluatePosition(START_FEN, [], { depth: 0 })).rejects.toThrow(/depth/);
    expect(farm.workers).toHaveLength(0);
    await expect(pool.evaluatePosition(MATED, [], { depth: 5 })).rejects.toThrow(/No legal moves/);
    pool.terminate();
  });
});

describe('EnginePool scheduling', () => {
  it('runs interactive jobs before background ones, FIFO within a class', async () => {
    const farm = new Farm();
    farm.delay = 2;
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const jobs = [
      pool.evaluatePosition(START_FEN, [], { depth: 5 }), // starts at once
      pool.evaluatePosition(AFTER_E4, [], { depth: 5, priority: 'background' }),
      pool.evaluatePosition(AFTER_D4, [], { depth: 5, priority: 'interactive' }),
      pool.evaluatePosition(AFTER_C4, [], { depth: 5 }),
      pool.evaluatePosition(AFTER_NF3, [], { depth: 5, priority: 'interactive' }),
    ];
    await Promise.all(jobs);
    expect(positions(farm)).toEqual([START_FEN, AFTER_D4, AFTER_NF3, AFTER_E4, AFTER_C4]);
    pool.terminate();
  });

  it('creates engines lazily and runs at most `size` positions at once', async () => {
    const farm = new Farm();
    farm.delay = 3;
    const pool = new EnginePool({ size: 3, createWorker: farm.create });
    expect(farm.workers).toHaveLength(0);
    const fens = [START_FEN, AFTER_E4, AFTER_D4, AFTER_C4, AFTER_NF3, ITALIAN, START_FEN];
    const jobs = fens.map(fen => pool.evaluatePosition(fen, ['e2e4', 'd2d4'], { depth: 5 }));
    await flush();
    expect(pool.busyCount).toBe(3);
    const results = await Promise.all(jobs);
    expect(results.map(r => r.fen)).toEqual(fens);
    expect(farm.workers).toHaveLength(3);
    expect(farm.maxActive).toBe(3);
    expect(pool.busyCount).toBe(0);
    pool.terminate();
  });

  it('a single job uses a single engine', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 4, createWorker: farm.create });
    await pool.evaluatePosition(START_FEN, ['d2d4', 'g2g4'], { depth: 5 });
    expect(farm.workers).toHaveLength(1);
    pool.terminate();
  });
});

describe('EnginePool failures', () => {
  it('respawns a dead engine once and retries the job', async () => {
    const farm = new Farm();
    farm.failOnGo.add(0);
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const ev = await pool.evaluatePosition(START_FEN, ['d2d4'], { depth: 6 });
    expect(ev.best.move).toBe('e2e4');
    expect(farm.workers).toHaveLength(2);
    expect(farm.workers[0]!.terminated).toBe(true);
    pool.terminate();
  });

  it('rejects after the retry also dies, and recovers for the next job', async () => {
    const farm = new Farm();
    farm.failOnGo.add(0).add(1);
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    await expect(pool.evaluatePosition(START_FEN, [], { depth: 6 })).rejects.toThrow(/memory access out of bounds/);
    expect(farm.workers).toHaveLength(2);
    const ev = await pool.evaluatePosition(START_FEN, [], { depth: 6 });
    expect(ev.best.move).toBe('e2e4');
    expect(farm.workers).toHaveLength(3);
    pool.terminate();
  });

  it('retries a job whose engine hit the watchdog', async () => {
    vi.useFakeTimers();
    const farm = new Farm();
    farm.hangOnGo.add(0);
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const p = pool.evaluatePosition(START_FEN, [], { depth: 10 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await p).best.move).toBe('e2e4');
    expect(farm.workers.map(w => w.terminated)).toEqual([true, false]);
    pool.terminate();
  });

  it('does not retry init failures (a misconfigured wasm will not load on a second try)', async () => {
    vi.useFakeTimers();
    const silent: EngineWorkerLike = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} };
    const createWorker = vi.fn(() => silent);
    const pool = new EnginePool({ size: 1, createWorker });
    const outcome = expect(pool.evaluatePosition(START_FEN, [], { depth: 5 })).rejects.toThrow(/failed to load.*application\/wasm/);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(createWorker).toHaveBeenCalledTimes(1);
    pool.terminate();
  });
});

describe('EnginePool abort and shutdown', () => {
  it('removes an aborted queued job without searching it', async () => {
    const farm = new Farm();
    farm.delay = 2;
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const running = pool.evaluatePosition(START_FEN, [], { depth: 5 });
    const ac = new AbortController();
    const queued = pool.evaluatePosition(ITALIAN, [], { depth: 5, signal: ac.signal });
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await running;
    await flush();
    expect(positions(farm)).toEqual([START_FEN]);
    pool.terminate();
  });

  it('stops a running job, then keeps using the same engine', async () => {
    const farm = new Farm();
    farm.delay = 50;
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const ac = new AbortController();
    const running = pool.evaluatePosition(START_FEN, ['d2d4'], { depth: 20, signal: ac.signal });
    const next = pool.evaluatePosition(ITALIAN, [], { depth: 5 });
    await vi.waitFor(() => expect(farm.allSent()).toContain('go depth 20'));
    ac.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect((await next).best.move).toBe('c2c3');
    const sent = farm.workers[0]!.sent;
    expect(sent.slice(sent.indexOf('go depth 20'), sent.indexOf('go depth 20') + 3)).toEqual(['go depth 20', 'stop', 'isready']);
    expect(sent).not.toContain('go depth 20 searchmoves d2d4');
    expect(farm.workers).toHaveLength(1);
    pool.terminate();
  });

  it('rejects a running job at once on abort, even while its engine is still loading; the slot stays busy until the engine is free', async () => {
    vi.useFakeTimers();
    const silent: EngineWorkerLike = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} };
    const pool = new EnginePool({ size: 1, createWorker: () => silent });
    const ac = new AbortController();
    let settled: unknown;
    const running = pool.evaluatePosition(START_FEN, [], { depth: 5, signal: ac.signal }).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.busyCount).toBe(1);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toMatchObject({ name: 'AbortError' });
    expect(pool.busyCount).toBe(1); // the engine is still loading: nothing else may use it yet
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.busyCount).toBe(0);
    await running;
    pool.terminate();
  });

  it('terminate() while an engine is loading reports termination, not a wasm load failure', async () => {
    const silent: EngineWorkerLike = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} };
    const pool = new EnginePool({ size: 1, createWorker: () => silent });
    const job = pool.evaluatePosition(START_FEN, [], { depth: 5 });
    await flush();
    pool.terminate();
    const err: unknown = await job.catch((e: unknown) => e);
    expect(String(err)).toMatch(/terminated/);
    expect(String(err)).not.toMatch(/application\/wasm/);
  });

  it('rejects an already aborted signal immediately', async () => {
    const farm = new Farm();
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    await expect(pool.evaluatePosition(START_FEN, [], { depth: 5, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(farm.workers).toHaveLength(0);
  });

  it('terminate() rejects queued and running jobs and kills every engine', async () => {
    const farm = new Farm();
    farm.delay = 50;
    const pool = new EnginePool({ size: 1, createWorker: farm.create });
    const running = pool.evaluatePosition(START_FEN, [], { depth: 5 });
    const queued = pool.evaluatePosition(ITALIAN, [], { depth: 5 });
    await flush();
    pool.terminate();
    await expect(running).rejects.toThrow(/terminated/);
    await expect(queued).rejects.toThrow(/terminated/);
    expect(farm.workers.every(w => w.terminated)).toBe(true);
    await expect(pool.evaluatePosition(START_FEN, [], { depth: 5 })).rejects.toThrow(/terminated/);
  });

  it('terminates idle engines after idleMs but keeps one warm', async () => {
    vi.useFakeTimers();
    const farm = new Farm();
    const pool = new EnginePool({ size: 3, createWorker: farm.create, idleMs: 1_000 });
    await Promise.all([START_FEN, AFTER_E4, AFTER_D4].map(fen => pool.evaluatePosition(fen, [], { depth: 5 })));
    expect(farm.workers).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(farm.workers.filter(w => w.terminated)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(farm.workers.filter(w => w.terminated)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(farm.workers.filter(w => w.terminated)).toHaveLength(2);
    await pool.evaluatePosition(ITALIAN, [], { depth: 5 }); // served by the warm engine
    expect(farm.workers).toHaveLength(3);
    pool.terminate();
  });
});

describe('defaultPoolSize', () => {
  it('uses cores − 1, capped at 4', () => {
    expect(defaultPoolSize({ hardwareConcurrency: 16 })).toBe(4);
    expect(defaultPoolSize({ hardwareConcurrency: 4 })).toBe(3);
    expect(defaultPoolSize({ hardwareConcurrency: 2 })).toBe(1);
    expect(defaultPoolSize({ hardwareConcurrency: 1 })).toBe(1);
  });

  it('limits touch and low-memory devices', () => {
    expect(defaultPoolSize({ hardwareConcurrency: 8, coarsePointer: true })).toBe(2);
    expect(defaultPoolSize({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(2);
    expect(defaultPoolSize({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(4);
    expect(defaultPoolSize({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(1);
    expect(defaultPoolSize({ hardwareConcurrency: 8, deviceMemory: 0.5, coarsePointer: true })).toBe(1);
  });

  it('assumes 2 engines when the core count is unknown', () => {
    expect(defaultPoolSize({})).toBe(2);
    expect(defaultPoolSize({ hardwareConcurrency: 0 })).toBe(2);
  });

  it('reads navigator and matchMedia when no env is given', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 12, deviceMemory: 8 });
    expect(defaultPoolSize()).toBe(4);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }));
    expect(defaultPoolSize()).toBe(2);
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('matchMedia', undefined);
    expect(defaultPoolSize()).toBe(2);
  });
});
