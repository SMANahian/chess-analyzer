// A pool of UCI engines, one position per engine at a time. Positions are independent, so N
// single-threaded engines scale almost linearly; `ucinewgame` before each position makes every result
// independent of pool size and scheduling order.
import { normalizeUci, posFromFen, posKey } from '../core/chess';
import type { LineEval, PositionEval } from '../core/types';
import { ENGINE_ID, UciEngine, abortError, isAbortError, type EngineWorkerLike } from './engine';

export type Priority = 'background' | 'interactive';

export interface PoolEnv {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  coarsePointer?: boolean;
}

const MAX_POOL_SIZE = 4;
/** Assumed when the browser does not report hardwareConcurrency (→ 2 engines). */
const FALLBACK_CORES = 3;
const DEFAULT_IDLE_MS = 60_000;

/**
 * min(cores − 1, 4); at most 2 on touch devices or deviceMemory ≤ 4 GB, 1 on deviceMemory ≤ 2 GB
 * (each worker costs ≈ 60–70 MB). Reads `navigator` when `env` is omitted.
 */
export function defaultPoolSize(env: PoolEnv = browserEnv()): number {
  const reported = env.hardwareConcurrency;
  const cores = reported !== undefined && reported >= 1 ? Math.floor(reported) : FALLBACK_CORES;
  const memory = env.deviceMemory;
  let size = Math.min(cores - 1, MAX_POOL_SIZE);
  if (env.coarsePointer || (memory !== undefined && memory <= 4)) size = Math.min(size, 2);
  if (memory !== undefined && memory <= 2) size = Math.min(size, 1);
  return Math.max(1, size);
}

function browserEnv(): PoolEnv {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return { hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, coarsePointer };
}

interface Job {
  fen: string;
  posKey: string;
  /** Legal, de-duplicated standard UCI. */
  moves: string[];
  depth: number;
  signal: AbortSignal | undefined;
  resolve(ev: PositionEval): void;
  reject(err: unknown): void;
}

interface Slot {
  engine: UciEngine | null;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class EnginePool {
  readonly size: number;
  private readonly createWorker: () => EngineWorkerLike;
  private readonly hashMb: number | undefined;
  private readonly idleMs: number;
  private readonly slots: Slot[] = [];
  /** Interactive jobs run before background ones; FIFO within a class. */
  private readonly queues: Record<Priority, Job[]> = { interactive: [], background: [] };
  private closed = false;

  constructor(opts: { size: number; createWorker: () => EngineWorkerLike; hashMb?: number; idleMs?: number }) {
    this.size = Math.max(1, Math.floor(opts.size) || 1);
    this.createWorker = opts.createWorker;
    this.hashMb = opts.hashMb;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  }

  get busyCount(): number {
    return this.slots.filter(s => s.busy).length;
  }

  /** newGame, best-move search, then one searchmoves search per move in `moves` that is not the best move. */
  evaluatePosition(
    fen: string,
    moves: readonly string[],
    opts: { depth: number; signal?: AbortSignal; priority?: Priority },
  ): Promise<PositionEval> {
    if (this.closed) return Promise.reject(new Error('Engine pool terminated'));
    if (opts.signal?.aborted) return Promise.reject(abortError());
    const pos = posFromFen(fen);
    if (!pos) return Promise.reject(new Error(`Invalid FEN: ${fen}`));
    if (!Number.isInteger(opts.depth) || opts.depth < 1) return Promise.reject(new Error(`Invalid search depth: ${opts.depth}`));
    const queue = this.queues[opts.priority ?? 'background'];
    return new Promise<PositionEval>((resolve, reject) => {
      const signal = opts.signal;
      const onAbort = (): void => {
        // A running job is stopped by its engine through the same signal; its slot stays busy until
        // the engine is free, but the caller hears at once (the engine may still be loading).
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        job.reject(abortError());
      };
      const settle = <T>(fn: (v: T) => void) => (v: T): void => {
        signal?.removeEventListener('abort', onAbort);
        fn(v);
      };
      const job: Job = {
        fen,
        posKey: posKey(pos),
        moves: legalMoves(fen, moves),
        depth: opts.depth,
        signal,
        resolve: settle(resolve),
        reject: settle(reject),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(job);
      this.pump();
    });
  }

  /** Kills every engine; queued and running jobs reject. */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error('Engine pool terminated');
    for (const queue of Object.values(this.queues)) {
      for (const job of queue.splice(0)) job.reject(err);
    }
    for (const slot of this.slots.splice(0)) {
      clearIdle(slot);
      slot.engine?.terminate();
    }
  }

  private pump(): void {
    while (!this.closed && this.hasQueuedJob()) {
      const slot = this.freeSlot();
      const job = slot && this.nextJob();
      if (!slot || !job) return;
      void this.run(slot, job);
    }
  }

  private hasQueuedJob(): boolean {
    return this.queues.interactive.length > 0 || this.queues.background.length > 0;
  }

  private nextJob(): Job | undefined {
    return this.queues.interactive.shift() ?? this.queues.background.shift();
  }

  /** An idle slot (preferring a live engine), or a new one while below `size`. */
  private freeSlot(): Slot | null {
    const idle = this.slots.filter(s => !s.busy);
    const warm = idle.find(s => s.engine?.alive) ?? idle[0];
    if (warm) return warm;
    if (this.slots.length >= this.size) return null;
    const slot: Slot = { engine: null, busy: false, idleTimer: null };
    this.slots.push(slot);
    return slot;
  }

  private async run(slot: Slot, job: Job): Promise<void> {
    slot.busy = true;
    clearIdle(slot);
    try {
      job.resolve(await this.attempt(slot, job));
    } catch (err) {
      job.reject(err);
    } finally {
      slot.busy = false;
      this.scheduleIdle(slot);
      this.pump();
    }
  }

  /** If the engine dies mid-job (crash, watchdog), respawn it once and retry the job once. */
  private async attempt(slot: Slot, job: Job): Promise<PositionEval> {
    for (let retried = false; ; retried = true) {
      const engine = await this.engineFor(slot);
      try {
        return await evaluateOn(engine, job);
      } catch (err) {
        if (this.closed) throw err;
        if (isAbortError(err) || job.signal?.aborted) throw abortError();
        if (engine.alive || retried) throw err;
      }
    }
  }

  /** The slot's engine, (re)spawned and initialised. Init failures are not retried: they are configuration errors. */
  private async engineFor(slot: Slot): Promise<UciEngine> {
    if (!slot.engine?.alive) {
      slot.engine?.terminate();
      slot.engine = new UciEngine(this.createWorker(), { hashMb: this.hashMb });
    }
    await slot.engine.init();
    return slot.engine;
  }

  private scheduleIdle(slot: Slot): void {
    clearIdle(slot);
    if (this.closed || slot.busy || !Number.isFinite(this.idleMs)) return; // Infinity = keep engines
    slot.idleTimer = setTimeout(() => this.retire(slot), this.idleMs);
  }

  /** Terminates an idle engine unless it is the last live one (kept warm for training). */
  private retire(slot: Slot): void {
    slot.idleTimer = null;
    if (this.closed || slot.busy) return;
    const othersAlive = this.slots.some(s => s !== slot && s.engine?.alive);
    if (!othersAlive && slot.engine?.alive) return;
    slot.engine?.terminate();
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
  }
}

function clearIdle(slot: Slot): void {
  if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
  slot.idleTimer = null;
}

/** Standard UCI, legal in `fen`, de-duplicated. Illegal moves never reach the engine (it would ignore them silently). */
/**
 * The legal moves of `moves` in standard UCI, deduplicated and sorted. The searches of one position share
 * the engine's hash table, so a move's score can depend on the moves searched before it; a fixed order
 * makes an evaluation depend only on the position, the set of moves and the depth (not on how a caller
 * happened to order them, e.g. by game counts that change as games are added).
 */
function legalMoves(fen: string, moves: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of moves) {
    const uci = normalizeUci(fen, m);
    if (uci) out.add(uci);
  }
  return [...out].sort();
}

async function evaluateOn(engine: UciEngine, job: Job): Promise<PositionEval> {
  const { fen, depth, signal } = job;
  if (signal?.aborted) throw abortError(); // aborted while the engine was loading
  await engine.newGame();
  const best = (await engine.search({ fen, depth, signal })).line;
  const lines: Record<string, LineEval> = { [best.move]: best };
  for (const move of job.moves) {
    if (lines[move]) continue;
    lines[move] = (await engine.search({ fen, depth, searchMoves: [move], signal })).line;
  }
  return {
    key: `${ENGINE_ID}|${job.posKey}`,
    posKey: job.posKey,
    fen,
    engine: ENGINE_ID,
    depth,
    best,
    moves: lines,
    updatedAt: Date.now(),
  };
}
