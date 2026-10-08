// Spaced repetition (SM-2 style) with automatic grading. Intervals are in days, `due` in ms.
// Deterministic: every function takes `now` instead of reading the clock.
import type { Grade, ReviewState } from './types';

const DAY_MS = 86_400_000;
const RELEARN_MS = 10 * 60_000;
export const INITIAL_EASE = 2.5;
export const MIN_EASE = 1.3;

/** Rounded to 0.01 so repeated ±0.15/0.2 steps do not accumulate float noise. */
const easeOf = (ease: number): number => Math.max(MIN_EASE, Math.round(ease * 100) / 100);
const dueAfter = (now: number, days: number): number => now + Math.round(days * DAY_MS);

/** A card that has never been reviewed: due immediately. */
export function newReview(mistakeId: string, profileId: string, now: number): ReviewState {
  return { mistakeId, profileId, due: now, interval: 0, ease: INITIAL_EASE, reps: 0, lapses: 0 };
}

/** reps 0 → 1 day, reps 1 → 3 days, then interval × ease. */
function goodInterval(r: ReviewState): number {
  if (r.reps <= 0) return 1;
  if (r.reps === 1) return 3;
  return Math.max(1, r.interval * r.ease);
}

/**
 * again: relearn in 10 minutes (interval 0, reps reset, lapses + 1, ease − 0.2);
 * hard: max(1, interval × 1.2) days, ease − 0.15; good: see goodInterval;
 * easy: good interval × 1.3, ease + 0.15. Ease never drops below 1.3.
 */
export function gradeReview(r: ReviewState, grade: Grade, now: number): ReviewState {
  const reviewed = { ...r, lastReviewedAt: now, lastGrade: grade };
  switch (grade) {
    case 'again':
      return { ...reviewed, interval: 0, due: now + RELEARN_MS, reps: 0, lapses: r.lapses + 1, ease: easeOf(r.ease - 0.2) };
    case 'hard': {
      const interval = Math.max(1, r.interval * 1.2);
      return { ...reviewed, interval, due: dueAfter(now, interval), reps: r.reps + 1, ease: easeOf(r.ease - 0.15) };
    }
    case 'good': {
      const interval = goodInterval(r);
      return { ...reviewed, interval, due: dueAfter(now, interval), reps: r.reps + 1, ease: easeOf(r.ease) };
    }
    case 'easy': {
      const interval = goodInterval(r) * 1.3;
      return { ...reviewed, interval, due: dueAfter(now, interval), reps: r.reps + 1, ease: easeOf(r.ease + 0.15) };
    }
  }
}

/** A card without review state has never been seen and is due (as a new card). */
export function isDue(r: ReviewState | undefined, now: number): boolean {
  return r === undefined || r.due <= now;
}

export type AttemptOutcome = 'correct' | 'low-confidence' | 'habit' | 'wrong';

/**
 * Grade for a finished card (ARCHITECTURE.md "Training").
 * - `outcome`: 'habit' if the habit move was played on any try; otherwise the verdict of the last try
 *   ('correct' = an acceptable move, 'low-confidence' = a move losing 5–7.5, 'wrong' = gave up or missed).
 * - `tries`: moves played including the last one (1 = first try).
 * - `previous`: the review state before this attempt (undefined for a new card).
 */
export function autoGrade(a: { outcome: AttemptOutcome; tries: number; hinted: boolean; previous?: ReviewState }): Grade {
  switch (a.outcome) {
    case 'habit':
    case 'wrong':
      return 'again';
    case 'low-confidence':
      return 'hard';
    case 'correct': {
      if (a.hinted || a.tries > 1) return 'hard';
      // "The previous review was also good": an easy review counts too, or a card answered
      // perfectly every time would alternate easy / good.
      const p = a.previous;
      return p !== undefined && (p.lastGrade === 'good' || p.lastGrade === 'easy') && p.interval >= 3 ? 'easy' : 'good';
    }
  }
}
