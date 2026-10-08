// Evaluates candidate positions with the engine pool, most important (highest weight) first, through
// the eval cache: a cheap triage search for every position, a confirm search only where some move
// loses at least TRIAGE_LOSS win-% points.
import { bestOf, moveEval } from '../core/classify';
import type { PositionEval } from '../core/types';
import { winLoss } from '../core/winrate';
import type { EnginePool } from '../engine/pool';
import { abortError, isAbortError, throwIfAborted } from '../sources/http';

export interface EvalTask {
  /** Position key. */
  key: string;
  fen: string;
  /** Standard UCI moves to evaluate (besides the engine's best move). */
  moves: string[];
  /** Importance (games that reached the position): higher first. */
  weight: number;
}

export type EvalOrigin = 'cache' | 'engine';

/** A move losing at least this much at triage depth sends the position to the confirm search. */
export const TRIAGE_LOSS = 2.5;
/** This many engine failures in a row (e.g. the engine cannot load) end the run with the last error. */
const MAX_CONSECUTIVE_FAILURES = 3;

export type PoolLike = Pick<EnginePool, 'evaluatePosition' | 'size'>;

export interface EvalDeps {
  pool: PoolLike;
  /** By `${engine}|${posKey}`. */
  getCached(keys: readonly string[]): Promise<Map<string, PositionEval>>;
  putCached(ev: PositionEval): Promise<void>;
  engine: string;
  triageDepth: number;
  confirmDepth: number;
  signal?: AbortSignal;
  onResult(task: EvalTask, ev: PositionEval, origin: EvalOrigin): void | Promise<void>;
  /** A position the engine failed on (after the pool's own retry); the run continues without it. */
  onError?(task: EvalTask, err: unknown): void;
}

export interface EvalSummary {
  cacheHits: number;
  engineEvals: number;
  /** Positions without a result because the engine failed on them. */
  failed: number;
}

const byWeight = (a: EvalTask, b: EvalTask): number => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Whether some of `moves` loses at least TRIAGE_LOSS against the best evaluated move. */
export function needsConfirm(ev: PositionEval, moves: readonly string[]): boolean {
  const best = bestOf(ev);
  return moves.some(m => {
    const line = moveEval(ev, m);
    return line !== undefined && winLoss(best.score, line.score) >= TRIAGE_LOSS;
  });
}

const coversMoves = (ev: PositionEval, task: EvalTask): boolean => task.moves.every(m => moveEval(ev, m) !== undefined);

/**
 * A cached eval answers the task when it comes from this engine build, covers every move and is deep
 * enough: confirm depth, or triage depth with no move losing TRIAGE_LOSS or more (such a position would
 * never be confirmed).
 */
export function isCacheHit(ev: PositionEval, task: EvalTask, depths: { triageDepth: number; confirmDepth: number; engine?: string }): boolean {
  if (depths.engine !== undefined && ev.engine !== depths.engine) return false;
  if (!coversMoves(ev, task)) return false;
  if (ev.depth >= depths.confirmDepth) return true;
  return ev.depth >= depths.triageDepth && !needsConfirm(ev, task.moves);
}

/**
 * The task's moves plus those the cached record already holds: the new record replaces the old one,
 * and must not drop a verdict another profile or a training session put there.
 */
function movesToSearch(task: EvalTask, cached: PositionEval | undefined): string[] {
  return cached ? [...new Set([...task.moves, ...Object.keys(cached.moves)])] : task.moves;
}

/**
 * Triage search (skipped when the cache already holds a triage-depth record covering every move,
 * e.g. from a run stopped before its confirm search), then the confirm search when some move loses
 * TRIAGE_LOSS or more.
 */
async function evaluateTask(task: EvalTask, deps: EvalDeps, cached: PositionEval | undefined): Promise<PositionEval> {
  const { pool, signal } = deps;
  const moves = movesToSearch(task, cached);
  let triage: PositionEval;
  if (cached && coversMoves(cached, task) && cached.depth >= deps.triageDepth) {
    triage = cached;
  } else {
    triage = await pool.evaluatePosition(task.fen, moves, { depth: deps.triageDepth, signal });
    await deps.putCached(triage);
  }
  if (triage.depth >= deps.confirmDepth || !needsConfirm(triage, task.moves)) return triage;
  const confirmed = await pool.evaluatePosition(task.fen, moves, { depth: deps.confirmDepth, signal });
  await deps.putCached(confirmed);
  return confirmed;
}

/**
 * Evaluates every task: cache hits are reported first (highest weight first), then the rest go to the
 * engine with `pool.size` positions in flight, highest weight first. Each eval is cached as it
 * completes and reported through onResult. On abort no new position is started; the promise rejects
 * with an AbortError once the positions in flight have settled.
 */
export async function evaluateAll(tasks: readonly EvalTask[], deps: EvalDeps): Promise<EvalSummary> {
  const { signal } = deps;
  throwIfAborted(signal);
  const ordered = [...tasks].sort(byWeight);
  const cached = await deps.getCached(ordered.map(t => `${deps.engine}|${t.key}`));
  const summary: EvalSummary = { cacheHits: 0, engineEvals: 0, failed: 0 };
  const queue: Queued[] = [];
  for (const task of ordered) {
    throwIfAborted(signal);
    const found = cached.get(`${deps.engine}|${task.key}`);
    // A record of another engine build (e.g. from an imported backup) is neither used nor extended.
    const ev = found?.engine === deps.engine ? found : undefined;
    if (ev && isCacheHit(ev, task, deps)) {
      summary.cacheHits++;
      await deps.onResult(task, ev, 'cache');
    } else {
      queue.push({ task, cached: ev });
    }
  }
  await runLanes(queue, deps, summary);
  return summary;
}

interface Queued {
  task: EvalTask;
  /** The cached record that did not answer the task (too shallow or missing a move). */
  cached: PositionEval | undefined;
}

async function runLanes(queue: readonly Queued[], deps: EvalDeps, summary: EvalSummary): Promise<void> {
  let next = 0;
  let consecutiveFailures = 0;
  let fatal: { err: unknown } | null = null;
  const stopped = (): boolean => fatal !== null || deps.signal?.aborted === true;

  const lane = async (): Promise<void> => {
    while (!stopped() && next < queue.length) {
      const { task, cached } = queue[next++]!;
      let ev: PositionEval;
      try {
        ev = await evaluateTask(task, deps, cached);
      } catch (err) {
        if (isAbortError(err) || deps.signal?.aborted) return;
        summary.failed++;
        deps.onError?.(task, err);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) fatal ??= { err };
        continue;
      }
      consecutiveFailures = 0;
      summary.engineEvals++;
      try {
        await deps.onResult(task, ev, 'engine');
      } catch (err) {
        fatal ??= { err };
      }
    }
  };

  const lanes = Math.max(1, Math.min(deps.pool.size, queue.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  if (deps.signal?.aborted) throw abortError();
  if (fatal) throw (fatal as { err: unknown }).err;
}
