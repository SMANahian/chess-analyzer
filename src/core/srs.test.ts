import { describe, expect, it } from 'vitest';
import { INITIAL_EASE, MIN_EASE, autoGrade, gradeReview, isDue, newReview } from './srs';
import type { Grade, ReviewState } from './types';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

describe('newReview / isDue', () => {
  it('creates a card that is due immediately', () => {
    const r = newReview('m1', 'p1', T0);
    expect(r).toEqual({ mistakeId: 'm1', profileId: 'p1', due: T0, interval: 0, ease: INITIAL_EASE, reps: 0, lapses: 0 });
    expect(isDue(r, T0)).toBe(true);
    expect(isDue(r, T0 - 1)).toBe(false);
  });

  it('treats a card without review state as due', () => {
    expect(isDue(undefined, T0)).toBe(true);
  });
});

describe('gradeReview', () => {
  it('follows the interval progression over a sequence of grades', () => {
    const steps: [Grade, number, number][] = [
      // grade, expected interval (days), expected ease
      ['good', 1, 2.5],
      ['good', 3, 2.5],
      ['good', 7.5, 2.5],
      ['hard', 9, 2.35],
      ['again', 0, 2.15],
      ['good', 1, 2.15],
      ['good', 3, 2.15],
      ['easy', 3 * 2.15 * 1.3, 2.3],
      ['good', 3 * 2.15 * 1.3 * 2.3, 2.3],
    ];
    let r = newReview('m', 'p', T0);
    let now = T0;
    for (const [grade, interval, ease] of steps) {
      r = gradeReview(r, grade, now);
      expect(r.interval, grade).toBeCloseTo(interval, 9);
      expect(r.ease, grade).toBe(ease);
      expect(r.lastGrade).toBe(grade);
      expect(r.lastReviewedAt).toBe(now);
      expect(r.due).toBe(grade === 'again' ? now + 10 * 60_000 : now + Math.round(interval * DAY));
      now = r.due;
    }
    expect(r.lapses).toBe(1);
    expect(r.reps).toBe(4);
  });

  it('resets reps and counts lapses on again', () => {
    let r = newReview('m', 'p', T0);
    r = gradeReview(r, 'good', T0);
    r = gradeReview(r, 'good', T0 + DAY);
    r = gradeReview(r, 'again', T0 + 4 * DAY);
    expect(r).toMatchObject({ interval: 0, reps: 0, lapses: 1, due: T0 + 4 * DAY + 600_000 });
  });

  it('gives hard at least one day', () => {
    expect(gradeReview(newReview('m', 'p', T0), 'hard', T0).interval).toBe(1);
    expect(gradeReview({ ...newReview('m', 'p', T0), reps: 3, interval: 10 }, 'hard', T0).interval).toBe(12);
  });

  it('never lets ease drop below 1.3', () => {
    let r = newReview('m', 'p', T0);
    for (let i = 0; i < 20; i++) r = gradeReview(r, i % 2 ? 'again' : 'hard', T0 + i);
    expect(r.ease).toBe(MIN_EASE);
  });

  it('easy is longer than good is longer than or equal to hard', () => {
    const r: ReviewState = { ...newReview('m', 'p', T0), reps: 4, interval: 10, ease: 2.2 };
    const days = (g: Grade) => gradeReview(r, g, T0).interval;
    expect(days('easy')).toBeGreaterThan(days('good'));
    expect(days('good')).toBeGreaterThan(days('hard'));
    expect(days('again')).toBe(0);
  });

  it('is deterministic and does not mutate its input', () => {
    const r = newReview('m', 'p', T0);
    const copy = { ...r };
    expect(gradeReview(r, 'easy', T0 + 5)).toEqual(gradeReview(r, 'easy', T0 + 5));
    expect(r).toEqual(copy);
  });
});

describe('autoGrade', () => {
  const prev = (patch: Partial<ReviewState>): ReviewState => ({ ...newReview('m', 'p', T0), ...patch });

  it('grades a first-try acceptable move good, or easy after a good review of ≥ 3 days', () => {
    expect(autoGrade({ outcome: 'correct', tries: 1, hinted: false })).toBe('good');
    expect(autoGrade({ outcome: 'correct', tries: 1, hinted: false, previous: prev({ interval: 3, lastGrade: 'good' }) })).toBe('easy');
    expect(autoGrade({ outcome: 'correct', tries: 1, hinted: false, previous: prev({ interval: 2.9, lastGrade: 'good' }) })).toBe('good');
    expect(autoGrade({ outcome: 'correct', tries: 1, hinted: false, previous: prev({ interval: 9, lastGrade: 'hard' }) })).toBe('good');
  });

  it('keeps grading easy after an easy review (a successful review is "also good")', () => {
    expect(autoGrade({ outcome: 'correct', tries: 1, hinted: false, previous: prev({ interval: 5, lastGrade: 'easy' }) })).toBe('easy');
    // A card answered perfectly every time must not alternate easy / good.
    let r = newReview('m', 'p', T0);
    const grades: Grade[] = [];
    for (let i = 0; i < 6; i++) {
      const grade = autoGrade({ outcome: 'correct', tries: 1, hinted: false, previous: i === 0 ? undefined : r });
      grades.push(grade);
      r = gradeReview(r, grade, r.due);
    }
    expect(grades).toEqual(['good', 'good', 'easy', 'easy', 'easy', 'easy']);
  });

  it('grades hard after a hint, a second try or a low-confidence move', () => {
    expect(autoGrade({ outcome: 'correct', tries: 1, hinted: true })).toBe('hard');
    expect(autoGrade({ outcome: 'correct', tries: 2, hinted: false })).toBe('hard');
    expect(autoGrade({ outcome: 'low-confidence', tries: 1, hinted: false, previous: prev({ interval: 9, lastGrade: 'good' }) })).toBe('hard');
  });

  it('grades the habit move or wrong tries again', () => {
    expect(autoGrade({ outcome: 'habit', tries: 1, hinted: false })).toBe('again');
    expect(autoGrade({ outcome: 'wrong', tries: 2, hinted: false })).toBe('again');
    expect(autoGrade({ outcome: 'wrong', tries: 1, hinted: true })).toBe('again');
  });
});
