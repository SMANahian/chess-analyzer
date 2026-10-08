// Training: session building (due reviews first, then new cards by impact, parents before children),
// move judging against the stored verdicts and the eval cache, live evaluation of unknown moves, and
// grading (spaced repetition).
import { normalizeUci } from '../core/chess';
import { bestOf, moveEval } from '../core/classify';
import { applyFilters } from '../core/filters';
import { gradeReview, newReview } from '../core/srs';
import {
  DEFAULT_FILTERS,
  type Grade,
  type LineEval,
  type Mistake,
  type MoveVerdict,
  type PositionEval,
  type ReviewState,
  type SessionCard,
  type ViewFilters,
} from '../core/types';
import { LOW_CONFIDENCE_BELOW, THRESHOLDS, winLoss } from '../core/winrate';
import * as repo from '../db/repo';
import type { PoolLike } from './scheduler';

export type { MoveVerdict, SessionCard } from '../core/types';

export interface SessionOptions {
  size: number;
  /** New cards already started today. */
  newToday: number;
  newPerDay: number;
  /** View filters for the session (default: DEFAULT_FILTERS, i.e. no book and no low-confidence items). */
  filters?: Partial<ViewFilters>;
}

/** Puts each card's parent (dependsOn), when it is in the session, before it; otherwise keeps the order. */
function parentsFirst(cards: readonly SessionCard[]): SessionCard[] {
  const byId = new Map(cards.map(c => [c.mistake.id, c]));
  const placed = new Set<string>();
  const out: SessionCard[] = [];
  const place = (card: SessionCard, depth: number): void => {
    if (placed.has(card.mistake.id)) return;
    const parent = card.mistake.dependsOn === undefined ? undefined : byId.get(card.mistake.dependsOn);
    // linkDependencies never creates cycles (a parent has a lower ply); the depth bound is a guard.
    if (parent && depth < cards.length) place(parent, depth + 1);
    placed.add(card.mistake.id);
    out.push(card);
  };
  for (const card of cards) place(card, 0);
  return out;
}

/**
 * A training session: due reviews first (oldest due first), then new cards by impact (at most
 * newPerDay − newToday), at most `size` cards, parents before their children. Only listed items count
 * (active, not dormant, not snoozed) that pass the filters; book and low-confidence items are left out
 * unless the filters show them.
 */
export function buildSession(ms: readonly Mistake[], reviews: readonly ReviewState[], now: number, opts: SessionOptions): SessionCard[] {
  const filters: ViewFilters = { ...DEFAULT_FILTERS, ...opts.filters };
  const review = new Map(reviews.map(r => [r.mistakeId, r]));
  const original = new Map(ms.map(m => [m.id, m]));
  const due: { card: SessionCard; impact: number }[] = [];
  const fresh: { card: SessionCard; impact: number }[] = [];
  for (const view of applyFilters(ms, filters, now)) {
    const mistake = original.get(view.id)!;
    const r = review.get(view.id);
    if (!r) fresh.push({ card: { mistake, isNew: true }, impact: view.viewImpact });
    else if (r.due <= now) due.push({ card: { mistake, review: r, isNew: false }, impact: view.viewImpact });
  }
  due.sort((a, b) => a.card.review!.due - b.card.review!.due || b.impact - a.impact);
  fresh.sort((a, b) => b.impact - a.impact);
  const size = Math.max(0, opts.size);
  const picked = due.slice(0, size).map(d => d.card);
  const newSlots = Math.min(Math.max(0, opts.newPerDay - opts.newToday), size - picked.length);
  picked.push(...pickNew(fresh.map(f => f.card), newSlots));
  return parentsFirst(picked);
}

/**
 * Up to `slots` new cards by impact, a card's never-seen parents (dependsOn, themselves new cards here)
 * first: the child position usually arises only after the parent's error, so it is learned second.
 */
function pickNew(byImpact: readonly SessionCard[], slots: number): SessionCard[] {
  const byId = new Map(byImpact.map(c => [c.mistake.id, c]));
  const chosen = new Set<SessionCard>();
  for (const card of byImpact) {
    if (chosen.size >= slots) break;
    const chain: SessionCard[] = [];
    for (let c: SessionCard | undefined = card; c && !chosen.has(c) && !chain.includes(c); ) {
      chain.unshift(c);
      c = c.mistake.dependsOn === undefined ? undefined : byId.get(c.mistake.dependsOn);
    }
    for (const c of chain.slice(0, slots - chosen.size)) chosen.add(c);
  }
  return [...chosen];
}

const correct = (best: boolean, line: LineEval | undefined): MoveVerdict =>
  line ? { kind: 'correct', best, line } : { kind: 'correct', best };

/** An evaluated move by its loss against the best evaluated move: < 5 correct, < 7.5 low-confidence, else wrong. */
function verdictByLoss(ev: PositionEval, move: string): MoveVerdict {
  const line = moveEval(ev, move);
  if (!line) return { kind: 'unknown' };
  const best = bestOf(ev);
  const loss = winLoss(best.score, line.score);
  if (loss < THRESHOLDS.inaccuracy) return correct(move === best.move, line);
  if (loss < LOW_CONFIDENCE_BELOW) return { kind: 'low-confidence', loss, line };
  return { kind: 'wrong', loss, line };
}

/**
 * Judges a training move (standard or king-takes-rook UCI): the habit move, a known acceptable move,
 * or — with the position's cached eval — any evaluated move by its loss. Anything else is 'unknown'
 * (evaluate it with evaluateTrainingMove).
 */
export function judgeMove(m: Mistake, uci: string, ev?: PositionEval): MoveVerdict {
  const move = normalizeUci(m.fen, uci);
  if (move === undefined) return { kind: 'unknown' };
  if (move === m.move) return { kind: 'habit' };
  const usable = ev && ev.posKey === m.posKey ? ev : undefined;
  if (move === m.bestMove || m.acceptable.includes(move)) return correct(move === m.bestMove, usable && moveEval(usable, move));
  return usable ? verdictByLoss(usable, move) : { kind: 'unknown' };
}

/** Writes a live training eval to the cache: merged into a same-depth record, never replacing a different-depth one. */
async function cacheTrainingEval(fresh: PositionEval): Promise<PositionEval> {
  const existing = (await repo.getEvals([fresh.key])).get(fresh.key);
  if (existing && existing.depth !== fresh.depth) return fresh;
  const merged: PositionEval = existing ? { ...existing, moves: { ...fresh.moves, ...existing.moves }, updatedAt: fresh.updatedAt } : fresh;
  await repo.putEval(merged);
  return merged;
}

/**
 * Evaluates an unknown move live (interactive priority) with the same deterministic search as the
 * analysis: the move and the stored best move from the same root at `depth`. The eval goes to the
 * cache and an acceptable move to the mistake's acceptable list, so the same move always gets the same
 * verdict. The caller updates its copy of `m.acceptable` from the verdict.
 */
export async function evaluateTrainingMove(pool: PoolLike, m: Mistake, uci: string, depth: number, signal?: AbortSignal): Promise<MoveVerdict> {
  const move = normalizeUci(m.fen, uci);
  if (move === undefined) return { kind: 'unknown' };
  if (move === m.move) return { kind: 'habit' };
  const fresh = await pool.evaluatePosition(m.fen, [move, m.bestMove], { depth, signal, priority: 'interactive' });
  const ev = await cacheTrainingEval(fresh);
  const verdict = judgeMove(m, move, ev);
  if (verdict.kind === 'correct' && move !== m.bestMove && !m.acceptable.includes(move)) {
    await repo.patchMistake(m.id, { acceptable: [...m.acceptable, move] });
  }
  return verdict;
}

/** Applies the grade to the card's review state (a new one for a new card) and stores it with the attempt. */
export async function recordGrade(card: SessionCard, grade: Grade, now: number): Promise<ReviewState> {
  const { mistake } = card;
  const previous = card.review ?? newReview(mistake.id, mistake.profileId, now);
  const next = gradeReview(previous, grade, now);
  await repo.saveGrade(next, { mistakeId: mistake.id, profileId: mistake.profileId, at: now, grade });
  return next;
}

// ── Scout prep drills ─────────────────────────────────────────────────────

/**
 * Judges your reply in a prep drill: the position after the opponent's habit move (`m.refutation.fen`).
 * Correct when it is the refutation or another known acceptable reply; other moves are evaluated live.
 */
export async function judgeRefutationMove(pool: PoolLike, m: Mistake, uci: string, depth: number, signal?: AbortSignal): Promise<MoveVerdict> {
  const r = m.refutation;
  if (!r) return { kind: 'unknown' };
  const move = normalizeUci(r.fen, uci);
  if (move === undefined) return { kind: 'unknown' };
  if (move === r.bestMove || r.acceptable.includes(move)) return correct(move === r.bestMove, undefined);
  const ev = await pool.evaluatePosition(r.fen, [move, r.bestMove], { depth, signal, priority: 'interactive' });
  return verdictByLoss(ev, move);
}
