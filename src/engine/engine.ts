// UCI driver for one Stockfish instance (a Web Worker in the app, a child process in Node tests).
// One operation at a time per engine; every search is bounded by a watchdog, and an aborted search is
// sequenced as stop → bestmove → isready → readyok so nothing from it can leak into the next one.
import { posFromFen } from '../core/chess';
import type { LineEval } from '../core/types';
import { parseBestMove, parseInfo, type InfoLine } from './uci';

export const ENGINE_FILE = 'stockfish-19-lite-single.js';
/** Engine build id incl. eval version; bump the suffix to invalidate cached evals. */
export const ENGINE_ID = 'sf19-lite@1';

export interface EngineWorkerLike {
  postMessage(msg: string): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

export interface SearchParams {
  fen: string;
  depth: number;
  /** Standard UCI. Restricts the root moves; the result's PV is asserted to start with one of them. */
  searchMoves?: string[];
  signal?: AbortSignal;
}

export interface SearchResult {
  line: LineEval;
  nodes: number;
  timeMs: number;
}

const DEFAULT_HASH_MB = 16;
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
/** How long `stop` may take to produce `bestmove` before the engine is considered hung. */
const STOP_TIMEOUT_MS = 5_000;
/** Stockfish's MAX_PLY is 246. */
const MAX_DEPTH = 245;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Per-search watchdog: no `bestmove` within this time → the worker is terminated. */
export function searchTimeoutMs(depth: number): number {
  return Math.max(30_000, 40 * depth * depth);
}

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** The line handler of the operation currently talking to the engine, tagged with its sequence number. */
interface Listener {
  seq: number;
  onLine(line: string): void;
  fail(err: Error): void;
}

type Timer = ReturnType<typeof setTimeout>;

export class UciEngine {
  private readonly worker: EngineWorkerLike;
  private readonly hashMb: number;
  private readonly initTimeoutMs: number;
  private deadError: Error | null = null;
  /** Killed by terminate(): not a load failure, even when it happens during init. */
  private terminated = false;
  private initPromise: Promise<void> | null = null;
  /** Serialises init/newGame/search; never rejects. */
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;
  private listener: Listener | null = null;

  constructor(worker: EngineWorkerLike, opts: { hashMb?: number; initTimeoutMs?: number } = {}) {
    this.worker = worker;
    this.hashMb = opts.hashMb ?? DEFAULT_HASH_MB;
    this.initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    worker.onmessage = e => this.onMessage(e);
    worker.onerror = e => this.die(new Error(`Engine worker error: ${describeError(e)}`));
  }

  get alive(): boolean {
    return this.deadError === null;
  }

  /** uci → uciok, Hash + MultiPV 1, isready → readyok. Memoised; rejects (and kills the engine) on timeout. */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.enqueue(() => this.handshake()).catch((err: unknown) => {
        throw isLoadError(err) || this.terminated ? err : loadError(describeError(err));
      });
      this.initPromise.catch(() => {}); // callers get the rejection; this only silences the memo copy
    }
    return this.initPromise;
  }

  /** ucinewgame + isready: clears the hash so results do not depend on what was searched before. */
  newGame(): Promise<void> {
    return this.enqueueReady(async () => {
      this.send('ucinewgame');
      await this.sync();
    });
  }

  search(p: SearchParams): Promise<SearchResult> {
    const invalid = validateSearch(p);
    if (invalid) return Promise.reject(invalid);
    return this.enqueueReady(() => this.runSearch(p), p.signal);
  }

  terminate(): void {
    if (!this.deadError) this.terminated = true;
    this.die(new Error('Engine terminated'));
  }

  private send(cmd: string): void {
    if (!this.deadError) this.worker.postMessage(cmd);
  }

  private onMessage(e: unknown): void {
    const text = messageText(e);
    if (text === undefined) return;
    for (const line of text.split(/\r?\n/)) {
      if (line && !this.deadError) this.listener?.onLine(line);
    }
  }

  /** Marks the engine dead, kills the worker and fails the operation in progress. Idempotent. */
  private die(err: Error): void {
    if (this.deadError) return;
    this.deadError = err;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    try {
      this.worker.terminate();
    } catch {
      // already gone
    }
    const l = this.listener;
    this.listener = null;
    l?.fail(err);
  }

  /** Runs `op` after every previously queued operation. A signal that aborts while queued rejects at once. */
  private enqueue<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      const run = async (): Promise<void> => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return; // already rejected while queued
        try {
          if (this.deadError) throw this.deadError;
          resolve(await op());
        } catch (err) {
          reject(err);
        }
      };
      this.tail = this.tail.then(run);
    });
  }

  private enqueueReady<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const ready = this.init();
    return this.enqueue(async () => {
      await ready;
      return op();
    }, signal);
  }

  /**
   * Routes engine output to the operation that is now talking to the engine (lines arriving between
   * operations are dropped). It is told about death (timeouts kill the engine) and returns a function
   * that detaches it — only while it is still the current one, so a late cleanup cannot detach a successor.
   * On an engine that is already dead it fails at once (asynchronously, so the caller can finish wiring
   * up): die() is idempotent, so a timeout armed after the death could never fail it, and the operation
   * — and every one queued behind it — would hang forever.
   */
  private listen(onLine: (line: string) => void, fail: (err: Error) => void): () => void {
    const dead = this.deadError;
    if (dead) {
      queueMicrotask(() => fail(dead));
      return () => {};
    }
    const seq = ++this.seq;
    this.listener = { seq, onLine, fail };
    return () => {
      if (this.listener?.seq === seq) this.listener = null;
    };
  }

  /** Sends `cmd` and resolves on the first line equal to `expected`. An expired timeout kills the engine. */
  private request(cmd: string, expected: string, timeout?: { ms: number; error: () => Error }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = timeout ? setTimeout(() => this.die(timeout.error()), timeout.ms) : undefined;
      const finish = (err?: Error): void => {
        clearTimeout(timer);
        clear();
        if (err) reject(err);
        else resolve();
      };
      const clear = this.listen(line => {
        if (line === expected) finish();
      }, finish);
      this.send(cmd); // after listen(): a reply can never arrive before its listener
    });
  }

  private sync(): Promise<void> {
    const ms = this.initTimeoutMs;
    return this.request('isready', 'readyok', { ms, error: () => new Error(`Engine did not answer isready within ${ms} ms`) });
  }

  /** One timer covers the whole handshake: a wasm served with the wrong MIME type fails silently. */
  private async handshake(): Promise<void> {
    const timer = setTimeout(() => this.die(loadError(`no answer within ${this.initTimeoutMs / 1000} s`)), this.initTimeoutMs);
    try {
      await this.request('uci', 'uciok');
      this.send(`setoption name Hash value ${this.hashMb}`);
      this.send('setoption name MultiPV value 1');
      await this.request('isready', 'readyok');
    } finally {
      clearTimeout(timer);
    }
  }

  private async runSearch(p: SearchParams): Promise<SearchResult> {
    // The queued-phase abort listener is gone by now; an abort in the gap must not start a search.
    if (p.signal?.aborted) throw abortError();
    const collector = new InfoCollector();
    let aborted = false;
    let bestmove: string | null;
    try {
      bestmove = await this.goAndWait(p, collector, () => (aborted = true));
    } catch (err) {
      throw aborted ? abortError() : err;
    }
    if (aborted) {
      await this.sync().catch(() => {}); // a hung engine was killed by the timeout; the caller asked to abort anyway
      throw abortError();
    }
    return buildResult(p, bestmove, collector);
  }

  /** Sends position + go and waits for `bestmove` (after `stop` when the signal aborts). */
  private goAndWait(p: SearchParams, collector: InfoCollector, onAborted: () => void): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const limit = searchTimeoutMs(p.depth);
      const watchdog = (): void =>
        this.die(new Error(`Engine watchdog: no result within ${limit / 1000} s at depth ${p.depth}; the engine was terminated`));
      let timer: Timer = setTimeout(watchdog, limit);
      const onAbort = (): void => {
        onAborted();
        clearTimeout(timer);
        // Armed before `stop` is sent: a worker that fails synchronously finishes this search inside send().
        timer = setTimeout(() => this.die(new Error('Engine did not stop')), STOP_TIMEOUT_MS);
        this.send('stop');
      };
      const finish = (result: { best: string | null } | Error): void => {
        clearTimeout(timer);
        p.signal?.removeEventListener('abort', onAbort);
        clear();
        if (result instanceof Error) reject(result);
        else resolve(result.best);
      };
      const clear = this.listen(line => {
        const bm = parseBestMove(line);
        if (bm) return finish(bm);
        const info = parseInfo(line);
        if (info) collector.add(info);
      }, finish);
      p.signal?.addEventListener('abort', onAbort, { once: true });
      const moves = p.searchMoves?.length ? ` searchmoves ${p.searchMoves.join(' ')}` : '';
      this.send(`position fen ${p.fen}`);
      this.send(`go depth ${p.depth}${moves}`);
    });
  }
}

/**
 * Keeps, for multipv 1, the last exact line of the highest depth. Bound lines (aspiration fails,
 * iterations cut short) are not exact and only serve as a fallback.
 */
class InfoCollector {
  private exact: InfoLine | undefined;
  private latest: InfoLine | undefined;
  nodes = 0;
  timeMs = 0;

  add(info: InfoLine): void {
    if (info.nodes !== undefined) this.nodes = Math.max(this.nodes, info.nodes);
    if (info.timeMs !== undefined) this.timeMs = Math.max(this.timeMs, info.timeMs);
    if ((info.multipv ?? 1) !== 1 || !info.score || !info.pv?.length) return;
    this.latest = info;
    if (!info.bound && (info.depth ?? 0) >= (this.exact?.depth ?? 0)) this.exact = info;
  }

  best(): InfoLine | undefined {
    return this.exact ?? this.latest;
  }
}

function buildResult(p: SearchParams, bestmove: string | null, collector: InfoCollector): SearchResult {
  if (bestmove === null) throw new Error(`No legal moves in this position (checkmate or stalemate): ${p.fen}`);
  const info = collector.best();
  const move = info?.pv?.[0];
  if (!info?.score || !info.pv || !move) throw new Error(`Engine returned no evaluation for ${p.fen}`);
  if (p.searchMoves?.length && !p.searchMoves.includes(move)) {
    // Stockfish silently searches every move when no searchmoves entry is legal (e.g. e1h1 castling).
    const requested = p.searchMoves.join(' ');
    throw new Error(`Engine ignored searchmoves ${requested} (it searched ${move}); moves must be legal standard UCI`);
  }
  return {
    line: { move, score: info.score, pv: info.pv, depth: info.depth ?? 0 },
    nodes: collector.nodes,
    timeMs: collector.timeMs,
  };
}

function validateSearch(p: SearchParams): Error | null {
  if (!Number.isInteger(p.depth) || p.depth < 1 || p.depth > MAX_DEPTH) return new Error(`Invalid search depth: ${p.depth}`);
  if (/[\r\n]/.test(p.fen) || !posFromFen(p.fen)) return new Error(`Invalid FEN: ${p.fen}`);
  const bad = p.searchMoves?.find(m => !UCI_MOVE.test(m));
  if (bad !== undefined) return new Error(`Invalid searchmoves entry: ${bad}`);
  return null;
}

const LOAD_ERROR_PREFIX = 'Chess engine failed to load';

function loadError(detail: string): Error {
  return new Error(
    `${LOAD_ERROR_PREFIX} (${detail}). Check that engine/${ENGINE_FILE.replace(/\.js$/, '.wasm')} ` +
      'is served with Content-Type application/wasm.',
  );
}

function isLoadError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(LOAD_ERROR_PREFIX);
}

/** Worker messages are strings; some hosts wrap them once more as { data: string }. */
function messageText(e: unknown): string | undefined {
  if (typeof e === 'string') return e;
  const data = typeof e === 'object' && e !== null ? (e as { data?: unknown }).data : undefined;
  if (typeof data === 'string') return data;
  const inner = typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : undefined;
  return typeof inner === 'string' ? inner : undefined;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message || 'unknown error';
  }
  return String(e);
}

/**
 * The bundled Stockfish as a classic Web Worker (the wasm is resolved next to the script).
 * Typed as EngineWorkerLike too: Worker's onmessage takes a MessageEvent, which TS cannot match
 * structurally against `{ data: unknown }` even though every message has `data`.
 */
export function createStockfishWorker(baseUrl?: string): Worker & EngineWorkerLike {
  const base = baseUrl ?? import.meta.env.BASE_URL;
  const dir = base.endsWith('/') ? base : `${base}/`;
  return new Worker(`${dir}engine/${ENGINE_FILE}`) as Worker & EngineWorkerLike;
}
