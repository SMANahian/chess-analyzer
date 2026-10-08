import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_FILE, UciEngine, createStockfishWorker, searchTimeoutMs, type EngineWorkerLike } from './engine';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ITALIAN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

type Responder = (cmd: string, w: FakeWorker) => void;

/** Scripted worker: records every command; replies asynchronously like a real Worker. */
class FakeWorker implements EngineWorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: string[] = [];
  terminated = false;
  constructor(public respond: Responder = handshake()) {}

  postMessage(cmd: string): void {
    this.sent.push(cmd);
    if (!this.terminated) this.respond(cmd, this);
  }

  emit(...lines: string[]): void {
    void Promise.resolve().then(() => {
      for (const data of lines) if (!this.terminated) this.onmessage?.({ data });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  commands(prefix: string): string[] {
    return this.sent.filter(c => c.startsWith(prefix));
  }
}

/** Answers uci/isready; `onGo` (and `onStop`) script the searches. */
function handshake(onGo?: Responder, onStop?: Responder): Responder {
  return (cmd, w) => {
    if (cmd === 'uci') w.emit('id name Fake', 'option name Hash type spin default 16 min 1 max 33554432', 'uciok');
    else if (cmd === 'isready') w.emit('readyok');
    else if (cmd.startsWith('go ')) onGo?.(cmd, w);
    else if (cmd === 'stop') onStop?.(cmd, w);
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function info(depth: number, cp: number, pv: string, extra = ''): string {
  return `info depth ${depth} seldepth ${depth + 2} multipv 1 score cp ${cp}${extra} nodes ${depth * 1000} nps 500000 hashfull 0 time ${depth * 2} pv ${pv}`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('UciEngine.init', () => {
  it('runs the uci handshake with Hash and MultiPV 1', async () => {
    const w = new FakeWorker();
    const engine = new UciEngine(w, { hashMb: 32 });
    await engine.init();
    expect(w.sent).toEqual(['uci', 'setoption name Hash value 32', 'setoption name MultiPV value 1', 'isready']);
    expect(engine.alive).toBe(true);
  });

  it('defaults Hash to 16 MB and is memoised', async () => {
    const w = new FakeWorker();
    const engine = new UciEngine(w);
    await Promise.all([engine.init(), engine.init()]);
    await engine.init();
    expect(w.commands('uci')).toEqual(['uci']);
    expect(w.sent).toContain('setoption name Hash value 16');
  });

  it('rejects with a wasm/MIME diagnostic and kills the worker when the engine never answers', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker(() => {}); // a wasm served with the wrong MIME type: silence
    const engine = new UciEngine(w);
    const ready = engine.init();
    const outcome = expect(ready).rejects.toThrow(/failed to load.*engine\/stockfish-19-lite-single\.wasm.*application\/wasm/);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(engine.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(engine.alive).toBe(false);
    expect(w.terminated).toBe(true);
  });

  it('honours initTimeoutMs', async () => {
    vi.useFakeTimers();
    const engine = new UciEngine(new FakeWorker(() => {}), { initTimeoutMs: 500 });
    const outcome = expect(engine.init()).rejects.toThrow(/failed to load/);
    await vi.advanceTimersByTimeAsync(500);
    await outcome;
  });

  it('rejects with the load diagnostic when the worker errors during init', async () => {
    const w = new FakeWorker(cmd => {
      if (cmd === 'uci') w.onerror?.({ message: 'NetworkError: script not found' });
    });
    const engine = new UciEngine(w);
    await expect(engine.init()).rejects.toThrow(/failed to load \(Engine worker error: NetworkError: script not found\)/);
    expect(engine.alive).toBe(false);
  });
});

describe('UciEngine messages', () => {
  it('accepts strings, { data: string } wrappers and multi-line chunks', async () => {
    const w = new FakeWorker(cmd => {
      if (cmd === 'uci') w.onmessage?.({ data: { data: 'id name Fake\nuciok' } });
      if (cmd === 'isready') (w.onmessage as unknown as (e: unknown) => void)('readyok');
      if (cmd.startsWith('go')) w.onmessage?.({ data: `${info(5, 20, 'e2e4 e7e5')}\r\nbestmove e2e4 ponder e7e5` });
    });
    const engine = new UciEngine(w);
    const r = await engine.search({ fen: START, depth: 5 });
    expect(r.line).toEqual({ move: 'e2e4', score: { cp: 20 }, pv: ['e2e4', 'e7e5'], depth: 5 });
  });
});

describe('UciEngine.newGame', () => {
  it('sends ucinewgame and waits for readyok', async () => {
    const w = new FakeWorker();
    const engine = new UciEngine(w);
    await engine.newGame();
    expect(w.sent.slice(-2)).toEqual(['ucinewgame', 'isready']);
  });
});

describe('UciEngine.search', () => {
  it('sends position + go and keeps the last exact line of the highest depth', async () => {
    const w = new FakeWorker(
      handshake((_cmd, w) =>
        w.emit(
          'info string NNUE evaluation using nn-61e7af4bb97d.nnue',
          info(9, 40, 'c2c3 g8f6'),
          info(10, 31, 'e1g1 g8f6 d2d3'),
          'info depth 10 currmove e1g1 currmovenumber 1',
          info(10, 33, 'd2d3 g8f6'),
          info(11, 16, 'e1g1 g8f6', ' upperbound'),
          'bestmove e1g1 ponder g8f6',
        ),
      ),
    );
    const engine = new UciEngine(w);
    const r = await engine.search({ fen: ITALIAN, depth: 10 });
    expect(w.sent.slice(-2)).toEqual([`position fen ${ITALIAN}`, 'go depth 10']);
    expect(r.line).toEqual({ move: 'd2d3', score: { cp: 33 }, pv: ['d2d3', 'g8f6'], depth: 10 });
    expect(r.nodes).toBe(11_000);
    expect(r.timeMs).toBe(22);
  });

  it('passes searchmoves and accepts a PV that starts with one of them', async () => {
    const w = new FakeWorker(handshake((_c, w) => w.emit(info(8, 18, 'e1g1 g8f6'), 'bestmove e1g1 ponder g8f6')));
    const engine = new UciEngine(w);
    const r = await engine.search({ fen: ITALIAN, depth: 8, searchMoves: ['e1g1'] });
    expect(w.sent.at(-1)).toBe('go depth 8 searchmoves e1g1');
    expect(r.line.move).toBe('e1g1');
  });

  it('rejects when Stockfish ignored searchmoves and searched every move', async () => {
    // Real behaviour for `searchmoves e1h1`: the token is dropped and the best move (c2c3) comes back.
    const w = new FakeWorker(handshake((_c, w) => w.emit(info(6, 19, 'c2c3 g8f6'), 'bestmove c2c3 ponder g8f6')));
    const engine = new UciEngine(w);
    await expect(engine.search({ fen: ITALIAN, depth: 6, searchMoves: ['e1h1'] })).rejects.toThrow(/ignored searchmoves e1h1/);
    expect(engine.alive).toBe(true);
  });

  it("rejects 'bestmove (none)' as a position without legal moves", async () => {
    const mated = '3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1';
    const w = new FakeWorker(handshake((_c, w) => w.emit('info depth 0 score mate 0', 'bestmove (none)')));
    const engine = new UciEngine(w);
    await expect(engine.search({ fen: mated, depth: 5 })).rejects.toThrow(/No legal moves/);
    expect(engine.alive).toBe(true);
  });

  it('keeps mate scores', async () => {
    const fen = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
    const w = new FakeWorker(
      handshake((_c, w) => w.emit('info depth 5 seldepth 2 multipv 1 score mate 1 nodes 100 nps 10000 hashfull 0 time 10 pv d1d8', 'bestmove d1d8')),
    );
    const r = await new UciEngine(w).search({ fen, depth: 5 });
    expect(r.line.score).toEqual({ mate: 1 });
  });

  it('validates input without talking to the engine', async () => {
    const w = new FakeWorker();
    const engine = new UciEngine(w);
    await expect(engine.search({ fen: 'not a fen', depth: 5 })).rejects.toThrow(/Invalid FEN/);
    await expect(engine.search({ fen: `${START}\ngo infinite`, depth: 5 })).rejects.toThrow(/Invalid FEN/);
    await expect(engine.search({ fen: START, depth: 0 })).rejects.toThrow(/depth/);
    await expect(engine.search({ fen: START, depth: 5, searchMoves: ['O-O'] })).rejects.toThrow(/searchmoves/);
    expect(w.commands('position')).toEqual([]);
  });

  it('runs one search at a time', async () => {
    const gos: FakeWorker[] = [];
    const w = new FakeWorker(handshake((_c, w) => gos.push(w)));
    const engine = new UciEngine(w);
    const a = engine.search({ fen: START, depth: 5 });
    const b = engine.search({ fen: ITALIAN, depth: 5 });
    await flush();
    expect(w.commands('position')).toEqual([`position fen ${START}`]);
    w.emit(info(5, 20, 'e2e4'), 'bestmove e2e4');
    expect((await a).line.move).toBe('e2e4');
    await flush();
    expect(w.commands('position')).toEqual([`position fen ${START}`, `position fen ${ITALIAN}`]);
    w.emit(info(5, 30, 'c2c3'), 'bestmove c2c3');
    expect((await b).line.move).toBe('c2c3');
  });
});

describe('UciEngine abort', () => {
  it('stops, waits for bestmove and readyok, then rejects with AbortError; stale lines never leak', async () => {
    let search = 0;
    const w = new FakeWorker(
      handshake(
        (_c, w) => {
          search++;
          if (search === 1) w.emit(info(10, 25, 'e2e4 e7e5'));
          else w.emit(info(8, 30, 'd2d4 d7d5'), 'bestmove d2d4 ponder d7d5');
        },
        (_c, w) =>
          w.emit(
            info(30, 999, 'h2h4'), // late lines of the aborted search, after `stop`
            info(12, 5, 'e2e4 e7e5', ' upperbound'),
            'bestmove e2e4 ponder e7e5',
          ),
      ),
    );
    const realRespond = w.respond;
    w.respond = (cmd, worker) => {
      // A stale bestmove sneaking in before readyok must not resolve the next search.
      if (cmd === 'isready' && search === 1) worker.emit('bestmove h2h4');
      realRespond(cmd, worker);
    };
    const engine = new UciEngine(w);
    await engine.init();
    const ac = new AbortController();
    const first = engine.search({ fen: START, depth: 20, signal: ac.signal });
    const second = engine.search({ fen: START, depth: 8 });
    await flush();
    ac.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(first).rejects.toBeInstanceOf(DOMException);
    const r = await second;
    expect(r.line).toEqual({ move: 'd2d4', score: { cp: 30 }, pv: ['d2d4', 'd7d5'], depth: 8 });
    const tail = w.sent.slice(w.sent.indexOf('go depth 20'));
    expect(tail).toEqual(['go depth 20', 'stop', 'isready', `position fen ${START}`, 'go depth 8']);
    expect(engine.alive).toBe(true);
  });

  it('rejects at once when aborted while queued, and never sends that search', async () => {
    const w = new FakeWorker(handshake());
    const engine = new UciEngine(w);
    const first = engine.search({ fen: START, depth: 5 });
    const ac = new AbortController();
    const queued = engine.search({ fen: ITALIAN, depth: 5, signal: ac.signal });
    await flush();
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    w.emit(info(5, 20, 'e2e4'), 'bestmove e2e4');
    expect((await first).line.move).toBe('e2e4');
    await flush();
    expect(w.commands('position')).toEqual([`position fen ${START}`]);
  });

  it('rejects an already aborted signal without sending anything', async () => {
    const w = new FakeWorker();
    const engine = new UciEngine(w);
    await engine.init();
    const before = w.sent.length;
    await expect(engine.search({ fen: START, depth: 5, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(w.sent.length).toBe(before);
  });

  it('kills an engine that does not answer stop', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker(handshake());
    const engine = new UciEngine(w);
    await engine.init();
    const ac = new AbortController();
    const p = engine.search({ fen: START, depth: 10, signal: ac.signal });
    const outcome = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    ac.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(engine.alive).toBe(false);
    expect(w.terminated).toBe(true);
  });
});

describe('UciEngine watchdog and death', () => {
  it('scales the watchdog with depth', () => {
    expect(searchTimeoutMs(10)).toBe(30_000);
    expect(searchTimeoutMs(40)).toBe(64_000);
  });

  it('terminates the worker and marks the engine dead when bestmove never comes', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker(handshake((_c, w) => w.emit(info(1, 10, 'e2e4'))));
    const engine = new UciEngine(w);
    await engine.init();
    const p = engine.search({ fen: START, depth: 14 });
    const outcome = expect(p).rejects.toThrow(/watchdog/);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(engine.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(engine.alive).toBe(false);
    expect(w.terminated).toBe(true);
    await expect(engine.search({ fen: START, depth: 5 })).rejects.toThrow(/watchdog/);
  });

  it('gives deep searches more time', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker(handshake());
    const engine = new UciEngine(w);
    await engine.init();
    const p = engine.search({ fen: START, depth: 40 });
    const outcome = expect(p).rejects.toThrow(/watchdog/);
    await vi.advanceTimersByTimeAsync(63_999);
    expect(engine.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it('fails the running and the queued searches on worker error', async () => {
    const w = new FakeWorker(handshake());
    const engine = new UciEngine(w);
    const a = engine.search({ fen: START, depth: 5 });
    const b = engine.search({ fen: START, depth: 5 });
    await flush();
    w.onerror?.(new Error('RuntimeError: unreachable'));
    await expect(a).rejects.toThrow(/Engine worker error: RuntimeError: unreachable/);
    await expect(b).rejects.toThrow(/Engine worker error/);
    expect(engine.alive).toBe(false);
    expect(w.terminated).toBe(true);
  });

  it('settles init when the engine dies between two handshake requests (a later timeout must not be a no-op)', async () => {
    vi.useFakeTimers();
    let engine: UciEngine | undefined;
    const w = new FakeWorker(cmd => {
      // 'uciok' resolves the first request; the engine is killed before the handshake sends isready.
      if (cmd === 'uci') void Promise.resolve().then(() => {
        w.onmessage?.({ data: 'uciok' });
        engine?.terminate();
      });
    });
    engine = new UciEngine(w);
    let settled: unknown;
    const init = engine.init().catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBeInstanceOf(Error);
    expect(String(await init)).toMatch(/terminated/);
  });

  it('settles an aborted search when the engine dies right after its bestmove, before the isready sync', async () => {
    vi.useFakeTimers();
    let engine: UciEngine | undefined;
    const w = new FakeWorker(
      handshake(undefined, (_c, w) => {
        void Promise.resolve().then(() => {
          w.onmessage?.({ data: 'bestmove e2e4' });
          engine?.terminate();
        });
      }),
    );
    engine = new UciEngine(w);
    await engine.init();
    const ac = new AbortController();
    let settled: unknown;
    const search = engine.search({ fen: START, depth: 20, signal: ac.signal }).catch((e: unknown) => (settled = e));
    await flush();
    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toMatchObject({ name: 'AbortError' });
    await search;
  });

  it('reports terminate() during init as a termination, not as a wasm load failure', async () => {
    const engine = new UciEngine(new FakeWorker(() => {}));
    const init = engine.init();
    await flush();
    engine.terminate();
    const err: unknown = await init.catch((e: unknown) => e);
    expect(String(err)).toMatch(/terminated/);
    expect(String(err)).not.toMatch(/failed to load|application\/wasm/);
  });

  it('terminate() rejects pending work', async () => {
    const w = new FakeWorker(handshake());
    const engine = new UciEngine(w);
    const a = engine.search({ fen: START, depth: 5 });
    await flush();
    engine.terminate();
    await expect(a).rejects.toThrow(/terminated/);
    expect(engine.alive).toBe(false);
    await expect(engine.newGame()).rejects.toThrow(/terminated/);
  });
});

describe('createStockfishWorker', () => {
  class StubWorker {
    constructor(readonly url: string) {}
  }

  it('loads the engine next to the given base URL', () => {
    vi.stubGlobal('Worker', StubWorker);
    expect((createStockfishWorker('/chess-analyzer/') as unknown as StubWorker).url).toBe(`/chess-analyzer/engine/${ENGINE_FILE}`);
    expect((createStockfishWorker('https://example.org/app') as unknown as StubWorker).url).toBe(`https://example.org/app/engine/${ENGINE_FILE}`);
  });

  it('defaults to the Vite base URL', () => {
    vi.stubGlobal('Worker', StubWorker);
    expect((createStockfishWorker() as unknown as StubWorker).url).toBe(`${import.meta.env.BASE_URL}engine/${ENGINE_FILE}`);
  });
});
