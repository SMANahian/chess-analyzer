// Analysis of one profile: aggregate its games (two passes, in chunks), evaluate the candidate positions
// through the scheduler and eval cache, classify each result as it arrives and store the mistakes in
// small batches, then (only after a complete run) link dependencies and reconcile old rows.
import { Aggregator, type Candidate } from '../core/aggregate';
import { playUci, posFromFen, posKey } from '../core/chess';
import { acceptableMoves, bestOf, classifyCandidate, linkDependencies } from '../core/classify';
import { loadOpeningBook, type OpeningBook } from '../core/openings';
import {
  ANALYSIS_MIN_LOSS,
  MAX_STORED_PLIES,
  type AnalysisPreset,
  type AnalysisProgress,
  type Mistake,
  type PositionEval,
  type Refutation,
  type Settings,
  type StoredGame,
} from '../core/types';
import * as repo from '../db/repo';
import { ENGINE_ID } from '../engine/engine';
import { isAbortError, throwIfAborted, yieldToEventLoop } from '../sources/http';
import { evaluateAll, type EvalOrigin, type EvalTask, type PoolLike } from './scheduler';

export const PRESET_DEPTHS: Readonly<Record<AnalysisPreset, { triage: number; confirm: number }>> = {
  quick: { triage: 8, confirm: 10 },
  standard: { triage: 10, confirm: 14 },
  thorough: { triage: 12, confirm: 18 },
};
/** A reviewed mistake stays (instead of going dormant) while its loss is at least this (hysteresis). */
export const HYSTERESIS_LOSS = 3;
/** Games per aggregation slice; between slices the event loop runs once AGGREGATE_BUDGET_MS have passed. */
const AGGREGATE_SLICE = 25;
/** Main-thread time aggregation may take before it yields (a long task is ≥ 50 ms, even on slow phones). */
const AGGREGATE_BUDGET_MS = 8;
/** Classified mistakes are written (and reported) in batches at most this far apart. */
const FLUSH_MS = 300;
/** Progress reports are throttled to one per this many ms (phase changes always report). */
const PROGRESS_MS = 100;
/** Refutation searches failing this many times in a row (e.g. the engine cannot load) end the run. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** No time estimate until this share of the engine-bound work is done. */
const ETA_MIN_FRACTION = 0.05;
/** Weight of a new estimate against the running one (which counts down with the clock). */
const ETA_SMOOTHING = 0.3;

export interface AnalysisDeps {
  pool: PoolLike;
  book?: OpeningBook;
  signal?: AbortSignal;
  /**
   * The analysis settings to use (default: the stored settings, read when the run starts). The caller
   * passes the settings it records as "analysed with", so a change made during the run is never
   * recorded as applied.
   */
  settings?: Pick<Settings, 'openingPlies' | 'preset' | 'depthOverride'>;
  /** Timestamps of the results (runAt, lastAnalysisAt, impact). */
  now?: () => number;
  /** Elapsed-time clock for the progress estimate (default Date.now). */
  clock?: () => number;
  onProgress?(p: AnalysisProgress): void;
  /** Mistakes as stored (user decisions merged in), batch by batch. */
  onMistakes?(ms: Mistake[]): void;
  /**
   * A position the engine failed on (after the pool's own retry). The run goes on without it, ends
   * with complete = false and a progress error, and links/reconciles nothing; running it again retries.
   */
  onPositionError?(fen: string, err: unknown): void;
}

export interface AnalysisResult {
  mistakes: number;
  positions: number;
  /**
   * Every position was evaluated (no engine failure), including opponent refutations. Dependencies and
   * reconcile run when every candidate position was evaluated; a missing refutation alone still allows them.
   */
  complete: boolean;
}

/** quick 8/10, standard 10/14, thorough 12/18; a depth override replaces the confirm depth. */
export function presetDepths(s: Pick<Settings, 'preset' | 'depthOverride'>): { triage: number; confirm: number } {
  const preset = PRESET_DEPTHS[s.preset] ?? PRESET_DEPTHS.standard;
  if (!(s.depthOverride > 0)) return { ...preset };
  const confirm = Math.floor(s.depthOverride);
  return { triage: Math.min(preset.triage, confirm), confirm };
}

// ── Aggregation ───────────────────────────────────────────────────────────

/** Both aggregation passes in small slices, yielding to the event loop whenever the time budget is used up. */
async function aggregateInChunks(games: readonly StoredGame[], openingPlies: number, signal?: AbortSignal): Promise<Candidate[]> {
  const agg = new Aggregator({ openingPlies: Math.min(openingPlies, MAX_STORED_PLIES) });
  let sliceStart = performance.now();
  for (const pass of [agg.count.bind(agg), agg.detail.bind(agg)]) {
    for (let i = 0; i < games.length; i += AGGREGATE_SLICE) {
      pass(games.slice(i, i + AGGREGATE_SLICE));
      if (performance.now() - sliceStart >= AGGREGATE_BUDGET_MS) {
        await yieldToEventLoop();
        throwIfAborted(signal);
        sliceStart = performance.now();
      }
    }
  }
  await yieldToEventLoop();
  throwIfAborted(signal);
  return agg.candidates();
}

async function bookOrNothing(book: OpeningBook | undefined): Promise<OpeningBook | undefined> {
  if (book) return book;
  try {
    return await loadOpeningBook();
  } catch {
    return undefined; // opening names and book awareness are a bonus: analyse without them
  }
}

// ── Progress ──────────────────────────────────────────────────────────────

/**
 * Engine searches a position costs (the best move, then one per other candidate move): the unit of
 * work for the estimate. Positions come most-played first, and those have the most moves, so counting
 * positions would overestimate the remaining time several times over early in a run.
 */
export const searchesOf = (task: Pick<EvalTask, 'moves'>): number => task.moves.length + 1;

class Progress {
  value: AnalysisProgress;
  private lastEmit = 0;
  /** Work (searches) of the current phase: total and done. */
  private phaseUnits = 0;
  private phaseDone = 0;
  /** Engine-bound work done in this phase, since `engineEpoch` (after the cache hits). */
  private engineUnits = 0;
  private engineResults = 0;
  private engineEpoch: number;
  /** Results in flight at once: the estimate waits until the first wave is in. */
  private lanes = 1;
  private eta: { ms: number; at: number } | null = null;

  constructor(
    profileId: string,
    startedAt: number,
    private readonly clock: () => number,
    private readonly onProgress?: (p: AnalysisProgress) => void,
  ) {
    this.engineEpoch = clock();
    this.value = {
      profileId,
      phase: 'preparing',
      gamesUsed: 0,
      totalPositions: 0,
      donePositions: 0,
      weightDone: 0,
      weightTotal: 0,
      cacheHits: 0,
      engineEvals: 0,
      mistakesFound: 0,
      startedAt,
    };
  }

  /** Reports at once (phase changes, totals). */
  set(patch: Partial<AnalysisProgress>): void {
    this.value = { ...this.value, ...patch };
    this.lastEmit = this.clock();
    this.onProgress?.(this.value);
  }

  /** A new phase of `units` searches (evaluation, then refutations), `lanes` at a time: the estimate starts over. */
  startPhase(units: number, lanes: number, patch: Partial<AnalysisProgress>): void {
    this.phaseUnits = units;
    this.phaseDone = 0;
    this.engineUnits = 0;
    this.engineResults = 0;
    this.engineEpoch = this.clock();
    this.lanes = Math.max(1, lanes);
    this.eta = null;
    this.set({ ...patch, etaMs: undefined });
  }

  /**
   * One position done. The estimate = remaining searches × measured time per search of the
   * engine-bound part (cache hits all come first and cost nothing), once ETA_MIN_FRACTION of that part
   * and a first result per lane are in; smoothed against the running estimate, which counts down.
   */
  result(weight: number, units: number, origin: EvalOrigin | 'refutation', mistakesFound: number): void {
    const v = { ...this.value, donePositions: this.value.donePositions + 1, weightDone: this.value.weightDone + weight, mistakesFound };
    const t = this.clock();
    this.phaseDone += units;
    if (origin === 'cache') {
      v.cacheHits++;
      this.engineEpoch = t;
    } else {
      v.engineEvals++;
      this.engineUnits += units;
      this.engineResults++;
      const remaining = Math.max(0, this.phaseUnits - this.phaseDone);
      if (this.engineResults >= this.lanes && this.engineUnits >= ETA_MIN_FRACTION * (this.engineUnits + remaining)) {
        const raw = (remaining * (t - this.engineEpoch)) / this.engineUnits;
        const running = this.eta ? Math.max(0, this.eta.ms - (t - this.eta.at)) : raw;
        const ms = this.eta ? running + ETA_SMOOTHING * (raw - running) : raw;
        this.eta = { ms, at: t };
        v.etaMs = Math.max(0, Math.round(ms));
      }
    }
    this.value = v;
    if (t - this.lastEmit >= PROGRESS_MS || v.donePositions === v.totalPositions) this.set({});
  }
}

// ── Batched writes ────────────────────────────────────────────────────────

/**
 * Buffers classified mistakes and upserts them at most FLUSH_MS apart, one write at a time. The rows
 * carry no dependency links yet (only a complete run computes them), so a stored row keeps its link.
 */
class MistakeWriter {
  private buffer: Mistake[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failure: { err: unknown } | null = null;
  /** The link (dependsOn) of each written row as stored. */
  readonly storedLinks = new Map<string, string | undefined>();

  constructor(private readonly onMistakes?: (ms: Mistake[]) => void) {}

  /** Throws the error of an earlier failed write, which ends the run. */
  add(ms: readonly Mistake[]): void {
    if (this.failure) throw this.failure.err;
    if (ms.length === 0) return;
    this.buffer.push(...ms);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  private flush(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    this.chain = this.chain.then(async () => {
      if (batch.length === 0 || this.failure) return;
      try {
        const stored = await repo.upsertMistakes(batch, { keepLinks: true });
        for (const m of stored) this.storedLinks.set(m.id, m.dependsOn);
        this.onMistakes?.(stored);
      } catch (err) {
        this.failure = { err };
      }
    });
    return this.chain;
  }

  /** Writes what is buffered; rejects if any write failed. */
  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
    if (this.failure) throw this.failure.err;
  }
}

// ── Refutations (opponent profiles) ───────────────────────────────────────

/** The punishing reply to an opponent's habit move, from the position after it (your turn). */
async function refutationFor(m: Mistake, pool: PoolLike, depth: number, signal?: AbortSignal): Promise<Refutation | null> {
  const fen = playUci(m.fen, m.move);
  const pos = fen && posFromFen(fen);
  if (!fen || !pos) return null;
  const key = posKey(pos);
  const cacheKey = `${ENGINE_ID}|${key}`;
  let ev: PositionEval | undefined = (await repo.getEvals([cacheKey])).get(cacheKey);
  if (!ev || ev.depth < depth) {
    const hadRecord = ev !== undefined;
    ev = await pool.evaluatePosition(fen, [], { depth, signal });
    // Never replace a record that covers more moves (it may be one of the user's own positions).
    if (!hadRecord) await repo.putEval(ev);
  }
  const best = bestOf(ev);
  if (!best.move) return null; // the habit move mates or stalemates: nothing to punish
  return {
    fen,
    posKey: key,
    bestMove: best.move,
    bestLine: best.pv[0] === best.move ? [...best.pv] : [best.move],
    score: best.score,
    acceptable: acceptableMoves(ev),
    depth: ev.depth,
  };
}

/**
 * Refutations for the produced mistakes that lack one at this depth, `pool.size` at a time. Like the
 * scheduler, an engine failure on one position is recorded (onPositionError) and the rest go on; three
 * in a row end the run with that error. Every lane settles before this returns or throws, so nothing is
 * searched or written after the analysis has ended. Returns the number of failed positions.
 */
async function addRefutations(profileId: string, producedIds: ReadonlySet<string>, depth: number, deps: AnalysisDeps, progress: Progress): Promise<number> {
  const stored = await repo.getMistakes(profileId);
  const todo = stored.filter(m => producedIds.has(m.id) && !(m.refutation && m.refutation.depth >= depth));
  if (todo.length === 0) return 0;
  // One search per refutation, at the confirm depth: a phase of its own for the estimate.
  const lanes = Math.min(deps.pool.size, todo.length);
  progress.startPhase(todo.length, lanes, { phase: 'evaluating', totalPositions: progress.value.totalPositions + todo.length });
  let next = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let fatal: { err: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (fatal === null && !deps.signal?.aborted && next < todo.length) {
      const m = todo[next++]!;
      try {
        const refutation = await refutationFor(m, deps.pool, depth, deps.signal);
        consecutiveFailures = 0;
        if (refutation) {
          const rows = await repo.upsertMistakes([{ ...m, refutation }]);
          deps.onMistakes?.(rows);
        }
      } catch (err) {
        if (isAbortError(err) || deps.signal?.aborted) return;
        failed++;
        deps.onPositionError?.(playUci(m.fen, m.move) ?? m.fen, err);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) fatal ??= { err };
        continue;
      }
      progress.result(0, 1, 'refutation', progress.value.mistakesFound);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  throwIfAborted(deps.signal);
  if (fatal) throw (fatal as { err: unknown }).err;
  return failed;
}

// ── Analysis ──────────────────────────────────────────────────────────────

/** Positions (and mistake ids) with training history: those get the hysteresis threshold. */
async function reviewedMistakes(profileId: string): Promise<{ ids: Set<string>; positions: Set<string> }> {
  const [reviews, mistakes] = await Promise.all([repo.getReviews(profileId), repo.getMistakes(profileId)]);
  const ids = new Set(reviews.map(r => r.mistakeId));
  return { ids, positions: new Set(mistakes.filter(m => ids.has(m.id)).map(m => m.posKey)) };
}

/**
 * Analyses the profile's stored games. Mistakes are written as results arrive, so an aborted run keeps
 * its partial results (and rejects with an AbortError). Only a complete run links dependencies and
 * reconciles: rows no longer produced are deleted, or marked dormant when they have history; a
 * reviewed mistake stays while its loss is ≥ HYSTERESIS_LOSS. Opponent profiles then get refutations.
 * A profile without games is left untouched.
 */
export async function analyzeProfile(profileId: string, deps: AnalysisDeps): Promise<AnalysisResult> {
  const now = deps.now ?? Date.now;
  const runAt = now();
  const progress = new Progress(profileId, runAt, deps.clock ?? Date.now, deps.onProgress);
  const writer = new MistakeWriter(deps.onMistakes);
  progress.set({});
  try {
    const profile = await repo.getProfile(profileId);
    if (!profile) throw new Error(`No profile ${profileId}`);
    const settings = deps.settings ?? (await repo.getSettings());
    const depths = presetDepths(settings);
    const games = await repo.getGames(profileId);
    const candidates = await aggregateInChunks(games, settings.openingPlies, deps.signal);
    const [book, reviewed] = await Promise.all([bookOrNothing(deps.book), reviewedMistakes(profileId)]);
    const byKey = new Map(candidates.map(c => [c.key, c]));
    const produced = new Map<string, Mistake>();

    const classify = (c: Candidate, ev: PositionEval): Mistake[] => {
      const keepLow = reviewed.positions.has(c.key);
      const ms = classifyCandidate(c, ev, { profileId, book, now: runAt, minLoss: keepLow ? HYSTERESIS_LOSS : ANALYSIS_MIN_LOSS });
      return keepLow ? ms.filter(m => m.winLoss >= ANALYSIS_MIN_LOSS || reviewed.ids.has(m.id)) : ms;
    };

    const tasks: EvalTask[] = candidates.map(c => ({ key: c.key, fen: c.fen, moves: c.moves, weight: c.weight }));
    progress.startPhase(
      tasks.reduce((sum, t) => sum + searchesOf(t), 0),
      deps.pool.size,
      { phase: 'evaluating', gamesUsed: games.length, totalPositions: candidates.length, weightTotal: candidates.reduce((sum, c) => sum + c.weight, 0) },
    );
    const summary = await evaluateAll(tasks, {
      pool: deps.pool,
      getCached: repo.getEvals,
      putCached: repo.putEval,
      engine: ENGINE_ID,
      triageDepth: depths.triage,
      confirmDepth: depths.confirm,
      signal: deps.signal,
      onResult: (task, ev, origin) => {
        const ms = classify(byKey.get(task.key)!, ev);
        for (const m of ms) produced.set(m.id, m);
        writer.add(ms);
        progress.result(task.weight, searchesOf(task), origin, produced.size);
      },
      onError: (task, err) => deps.onPositionError?.(task.fen, err),
    });
    await writer.close();

    if (summary.failed === 0 && games.length > 0) {
      const all = [...produced.values()];
      linkDependencies(all);
      // Every row is stored already (with its earlier link): rewrite only those whose link changed,
      // removed links included (no keepLinks), instead of every row with all its occurrences again.
      const relinked = all.filter(m => !writer.storedLinks.has(m.id) || writer.storedLinks.get(m.id) !== m.dependsOn);
      if (relinked.length > 0) {
        // Two statements: `onMistakes?.(await …)` would skip the write when there is no listener.
        const rows = await repo.upsertMistakes(relinked);
        deps.onMistakes?.(rows);
      }
      await repo.reconcileMistakes(profileId, new Set(produced.keys()));
    }
    const failed =
      summary.failed + (profile.kind === 'opponent' ? await addRefutations(profileId, new Set(produced.keys()), depths.confirm, deps, progress) : 0);
    await repo.updateProfile(profileId, { lastAnalysisAt: now() });
    progress.set({
      phase: 'done',
      etaMs: 0,
      ...(failed > 0 ? { error: `${failed} position${failed === 1 ? '' : 's'} could not be evaluated.` } : {}),
    });
    return { mistakes: produced.size, positions: candidates.length, complete: failed === 0 };
  } catch (err) {
    await writer.close().catch(() => undefined);
    const aborted = isAbortError(err) || deps.signal?.aborted === true;
    progress.set({ phase: aborted ? 'cancelled' : 'error', etaMs: undefined, ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err) }) });
    throw err;
  }
}
