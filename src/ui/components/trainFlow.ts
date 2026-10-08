// Pure model of one training card (ARCHITECTURE.md "Training"): what the board shows, the replay
// before the question, how a verdict moves the attempt along (retry / reveal / done), and the grade.
import { replay } from '../../core/chess';
import { autoGrade, type AttemptOutcome } from '../../core/srs';
import type { Color, Grade, Mistake, MoveVerdict, ReviewState, Score, SessionCard } from '../../core/types';

/** Wrong tries (the habit counts as one) before the answer is revealed. */
export const MAX_FAILURES = 2;

export interface CardSpec {
  /** Position the user plays from. */
  fen: string;
  userColor: Color;
  /** Moves from the standard start to `fen`. */
  path: string[];
  /** The opponent's move that led to `fen` (highlighted). */
  lastMove?: string;
  /** The move a hint points at and a reveal shows. */
  best: string;
  /** Engine line from `fen`, starting with `best`. */
  bestLine: string[];
  /** The best move's score (side to move at `fen`). */
  bestScore: Score;
  /** The user's own habit (self cards); undefined in prep drills. */
  habit?: string;
  /** The habit move and the engine's punishment, from `fen`. */
  habitLine?: string[];
  /** A prep drill: punish a scouted player's habit (m.refutation). */
  prep: boolean;
}

const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');

/**
 * Self cards: the mistake's position, answer = best move. Prep drills (a scouted player's mistake with
 * a refutation): the position after *their* habit move, from your side, answer = the refutation.
 */
export function cardSpec(m: Mistake): CardSpec {
  const r = m.refutation;
  if (r) {
    const path = [...m.path, m.move];
    return { fen: r.fen, userColor: opposite(m.color), path, lastMove: m.move, best: r.bestMove, bestLine: r.bestLine, bestScore: r.score, prep: true };
  }
  return {
    fen: m.fen,
    userColor: m.color,
    path: m.path,
    lastMove: m.path[m.path.length - 1],
    best: m.bestMove,
    bestLine: m.bestLine,
    bestScore: m.scoreBest,
    habit: m.move,
    habitLine: m.playedLine,
    prep: false,
  };
}

/** The last `plies` moves of `path` and the position they start from; null when there is nothing to replay. */
export function replayPlan(path: readonly string[], plies: number): { fromFen: string; ucis: string[] } | null {
  const n = Math.min(Math.max(0, Math.floor(plies)), path.length);
  if (n === 0) return null;
  const steps = replay(path, path.length, true);
  if (steps.length < path.length) return null; // an illegal path: show the position without a replay
  const start = path.length - n;
  return { fromFen: steps[start]!.fen, ucis: path.slice(start) };
}

export interface Attempt {
  /** Judged moves so far (unknown verdicts do not count). */
  tries: number;
  failures: number;
  /** Hints used: 1 = piece highlighted, 2 = arrow shown. */
  hints: number;
  /** The habit move was played on some try. */
  habit: boolean;
  last: AttemptOutcome | null;
  /** The answer was shown (after MAX_FAILURES or "Show me"). */
  revealed: boolean;
}

export const NEW_ATTEMPT: Attempt = { tries: 0, failures: 0, hints: 0, habit: false, last: null, revealed: false };

export type Next = 'done' | 'retry' | 'reveal' | 'ignore';

/** Applies a verdict: done on a correct or playable move; retry, then reveal, after failures. */
export function afterVerdict(a: Attempt, v: MoveVerdict): { attempt: Attempt; next: Next } {
  switch (v.kind) {
    case 'unknown':
      return { attempt: a, next: 'ignore' };
    case 'correct':
    case 'low-confidence': {
      const last: AttemptOutcome = v.kind === 'correct' ? 'correct' : 'low-confidence';
      return { attempt: { ...a, tries: a.tries + 1, last }, next: 'done' };
    }
    case 'habit':
    case 'wrong': {
      const failures = a.failures + 1;
      const attempt: Attempt = { ...a, tries: a.tries + 1, failures, last: v.kind, habit: a.habit || v.kind === 'habit' };
      return { attempt, next: failures >= MAX_FAILURES ? 'reveal' : 'retry' };
    }
  }
}

export const reveal = (a: Attempt): Attempt => ({ ...a, revealed: true });
export const hint = (a: Attempt): Attempt => ({ ...a, hints: Math.min(2, a.hints + 1) });

/** The attempt's outcome for grading: the habit on any try wins, then a reveal, then the last verdict. */
export function attemptOutcome(a: Attempt): AttemptOutcome {
  if (a.habit) return 'habit';
  if (a.revealed || a.last === null) return 'wrong';
  return a.last;
}

export function gradeAttempt(a: Attempt, previous?: ReviewState): Grade {
  return autoGrade({ outcome: attemptOutcome(a), tries: Math.max(1, a.tries), hinted: a.hints > 0, previous });
}

/** First-try success without help (for the session score and streak). */
export const cleanSolve = (a: Attempt): boolean => attemptOutcome(a) === 'correct' && a.tries === 1 && a.hints === 0;

/**
 * Whether finishing this card changes the schedule. A card that is new or due is graded; extra
 * practice on cards that are not due yet leaves the schedule alone.
 */
export function isGraded(card: SessionCard, now: number): boolean {
  return card.isNew || card.review === undefined || card.review.due <= now;
}

/** Cards for "practise anyway": soonest due first (never reviewed ones by list order), `size` at most. */
export function practiceCards(ms: readonly Mistake[], reviews: ReadonlyMap<string, ReviewState>, size: number): SessionCard[] {
  const due = (m: Mistake): number => reviews.get(m.id)?.due ?? Infinity;
  return ms
    .map((m, i) => ({ m, i }))
    .sort((a, b) => due(a.m) - due(b.m) || a.i - b.i)
    .slice(0, Math.max(0, size))
    .map(({ m }) => {
      const review = reviews.get(m.id);
      return review ? { mistake: m, review, isNew: false } : { mistake: m, isNew: true };
    });
}
