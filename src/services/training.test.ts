import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from '../core/chess';
import type { Mistake, PositionEval, ReviewState } from '../core/types';
import * as repo from '../db/repo';
import { useTestDb } from '../db/schema';
import { ENGINE_ID } from '../engine/engine';
import { FakePool, testMistake } from './__fixtures__/fakes';
import { buildSession, evaluateTrainingMove, judgeMove, judgeRefutationMove, recordGrade, sessionCounts } from './training';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
const fenAt = (sans: string): string => sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN);
const keyOf = (fen: string): string => posKey(posFromFen(fen)!);

/** 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4: the habit is 4.Nxe5?, best 4.Nxd4. */
const P1 = fenAt('e4 e5 Nf3 Nc6 Bc4 Nd4');
/** 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.d3 Bc5: White can castle (habit) or play c3. */
const ITALIAN = fenAt('e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5');

const review = (m: Mistake, due: number, over: Partial<ReviewState> = {}): ReviewState => ({
  mistakeId: m.id,
  profileId: m.profileId,
  due,
  interval: 1,
  ease: 2.5,
  reps: 1,
  lapses: 0,
  ...over,
});

/** A distinct mistake per (position, move); its impact (recomputed from the occurrences) grows with `weight`. */
function leak(move: string, weight: number, over: Partial<Mistake> = {}): Mistake {
  const fen = fenAt('e4');
  return testMistake('p', fen, move, { winLoss: 10 + weight, bestMove: 'e7e5', acceptable: ['e7e5'], occurrences: occ(move), ...over });
}

const occ = (move: string): Mistake['occurrences'] =>
  [1, 2, 3].map(i => ({ g: `p|lichess:${move}${i}`, t: NOW - i * DAY, s: 'blitz' as const, r: true, o: 'loss' as const, m: move }));

describe('buildSession', () => {
  it('due reviews first (oldest due first), then new cards by impact up to the daily limit', () => {
    const dueLate = leak('a7a6', 1);
    const dueEarly = leak('b7b6', 1);
    const notDue = leak('g7g6', 50);
    const newBig = leak('h7h6', 40);
    const newMid = leak('f7f6', 20);
    const newSmall = leak('g7g5', 10);
    const reviews = [review(dueLate, NOW - 1000), review(dueEarly, NOW - 5000), review(notDue, NOW + DAY)];
    const ms = [newSmall, dueLate, notDue, newMid, dueEarly, newBig];
    const cards = buildSession(ms, reviews, NOW, { size: 10, newToday: 1, newPerDay: 3 });
    expect(cards.map(c => [c.mistake.move, c.isNew])).toEqual([
      ['b7b6', false],
      ['a7a6', false],
      ['h7h6', true],
      ['f7f6', true],
    ]);
    expect(cards[0]!.review).toEqual(reviews[1]);
    expect(cards[2]!.review).toBeUndefined();
  });

  it('caps the session size, due cards taking precedence', () => {
    const due = [leak('a7a6', 1), leak('b7b6', 1), leak('c7c6', 1)];
    const reviews = due.map((m, i) => review(m, NOW - i));
    const cards = buildSession([...due, leak('h7h6', 99)], reviews, NOW, { size: 2, newToday: 0, newPerDay: 5 });
    expect(cards.map(c => c.mistake.move)).toEqual(['c7c6', 'b7b6']);
    expect(buildSession([leak('h7h6', 99)], [], NOW, { size: 5, newToday: 5, newPerDay: 5 })).toEqual([]);
  });

  it('leaves out mastered, ignored, dormant, snoozed, book and (by default) low-confidence items', () => {
    const ok = leak('a7a6', 1);
    const ms = [
      ok,
      leak('b7b6', 1, { status: 'mastered' }),
      leak('c7c6', 1, { status: 'ignored' }),
      leak('d7d6', 1, { dormant: true }),
      leak('g7g6', 1, { snoozedUntil: NOW + 1 }),
      leak('h7h6', 1, { kind: 'book' }),
      leak('f7f6', 1, { confidence: 'low', winLoss: 6, severity: 'inaccuracy' }),
      leak('g7g5', 1, { snoozedUntil: NOW - 1 }),
    ];
    expect(buildSession(ms, [], NOW, { size: 20, newToday: 0, newPerDay: 20 }).map(c => c.mistake.move)).toEqual(['a7a6', 'g7g5']);
    const withLow = buildSession(ms, [], NOW, { size: 20, newToday: 0, newPerDay: 20, filters: { showLowConfidence: true } });
    expect(withLow.map(c => c.mistake.move).sort()).toEqual(['a7a6', 'f7f6', 'g7g5']);
  });

  it('applies view filters such as colour', () => {
    const black = leak('a7a6', 1);
    const white = testMistake('p', START_FEN, 'f2f3', { occurrences: occ('f2f3'), impact: 5 });
    expect(buildSession([black, white], [], NOW, { size: 5, newToday: 0, newPerDay: 5, filters: { color: 'white' } }).map(c => c.mistake.move)).toEqual(['f2f3']);
  });

  it('puts a parent before its child when both are in the session', () => {
    const parent = leak('a7a6', 1);
    const child = leak('b7b6', 30, { dependsOn: parent.id, ply: 5 });
    const grandchild = leak('c7c6', 60, { dependsOn: child.id, ply: 9 });
    const cards = buildSession([grandchild, child, parent], [], NOW, { size: 5, newToday: 0, newPerDay: 5 });
    expect(cards.map(c => c.mistake.move)).toEqual(['a7a6', 'b7b6', 'c7c6']);
  });
});

describe('sessionCounts', () => {
  const unlimited = (ms: Mistake[], rs: ReviewState[], opts: { newToday: number; newPerDay: number; filters?: { showLowConfidence: boolean } }): number =>
    buildSession(ms, rs, NOW, { size: Number.MAX_SAFE_INTEGER, ...opts }).length;

  it('tells due reviews from the new cards still allowed today; the total is an unlimited session', () => {
    const dueA = leak('a7a6', 1);
    const dueB = leak('b7b6', 1);
    const later = leak('g7g6', 50);
    const fresh = [leak('h7h6', 40), leak('f7f6', 20), leak('g7g5', 10)];
    const hidden = [leak('c7c6', 1, { status: 'mastered' }), leak('d7d6', 1, { dormant: true }), leak('e7e6', 1, { kind: 'book' })];
    const ms = [dueA, dueB, later, ...fresh, ...hidden];
    // A review of a hidden item (mastered) is not due training.
    const reviews = [review(dueA, NOW - 1000), review(dueB, NOW), review(later, NOW + DAY), review(hidden[0]!, NOW - DAY)];
    for (const [newToday, newPerDay, newAvailable] of [
      [0, 5, 3],
      [1, 3, 2],
      [3, 3, 0],
      [5, 3, 0],
    ] as const) {
      const counts = sessionCounts(ms, reviews, NOW, { newToday, newPerDay });
      expect(counts).toEqual({ dueReviews: 2, newAvailable, total: 2 + newAvailable });
      expect(counts.total).toBe(unlimited(ms, reviews, { newToday, newPerDay }));
      // A Map of reviews (as the store keeps them) gives the same counts.
      expect(sessionCounts(ms, new Map(reviews.map(r => [r.mistakeId, r])), NOW, { newToday, newPerDay })).toEqual(counts);
    }
  });

  it('applies the same filters as buildSession', () => {
    const low = leak('f7f6', 1, { confidence: 'low', winLoss: 6, severity: 'inaccuracy' });
    const ms = [leak('a7a6', 1), low];
    expect(sessionCounts(ms, [], NOW, { newToday: 0, newPerDay: 5 })).toMatchObject({ newAvailable: 1 });
    const filters = { showLowConfidence: true };
    expect(sessionCounts(ms, [], NOW, { newToday: 0, newPerDay: 5, filters })).toMatchObject({ newAvailable: 2 });
    expect(sessionCounts(ms, [], NOW, { newToday: 0, newPerDay: 5, filters }).total).toBe(unlimited(ms, [], { newToday: 0, newPerDay: 5, filters }));
  });
});

describe('judgeMove', () => {
  const m = testMistake('p', P1, 'f3e5', { bestMove: 'd1e2', acceptable: ['d1e2', 'f3d4'] });
  const ev = (scores: Record<string, number>, fen = P1): PositionEval => {
    const lines = Object.fromEntries(Object.entries(scores).map(([move, cp]) => [move, { move, score: { cp }, pv: [move], depth: 14 }]));
    const best = Object.values(lines).sort((a, b) => b.score.cp - a.score.cp)[0]!;
    return { key: `${ENGINE_ID}|${keyOf(fen)}`, posKey: keyOf(fen), fen, engine: ENGINE_ID, depth: 14, best, moves: lines, updatedAt: 0 };
  };

  it('recognises the habit, the best move and known acceptable moves', () => {
    expect(judgeMove(m, 'f3e5')).toEqual({ kind: 'habit' });
    expect(judgeMove(m, 'd1e2')).toEqual({ kind: 'correct', best: true });
    expect(judgeMove(m, 'f3d4')).toEqual({ kind: 'correct', best: false });
    expect(judgeMove(m, 'a2a3')).toEqual({ kind: 'unknown' });
    expect(judgeMove(m, 'e2e4')).toEqual({ kind: 'unknown' }); // illegal here
  });

  it('accepts king-takes-rook castling for a castling habit', () => {
    const castle = testMistake('p', ITALIAN, 'e1g1', { bestMove: 'c2c3', acceptable: ['c2c3'] });
    expect(judgeMove(castle, 'e1h1')).toEqual({ kind: 'habit' });
  });

  it('judges other evaluated moves by their loss: < 5 correct, < 7.5 low-confidence, else wrong', () => {
    const cached = ev({ d1e2: 30, a2a3: -10, h2h3: -30, b2b4: -60 });
    expect(judgeMove(m, 'a2a3', cached)).toMatchObject({ kind: 'correct', best: false, line: { move: 'a2a3' } });
    expect(judgeMove(m, 'h2h3', cached)).toMatchObject({ kind: 'low-confidence', loss: expect.closeTo(5.52, 1) });
    expect(judgeMove(m, 'b2b4', cached)).toMatchObject({ kind: 'wrong', loss: expect.closeTo(8.27, 1) });
    expect(judgeMove(m, 'd1e2', cached)).toMatchObject({ kind: 'correct', best: true, line: { move: 'd1e2' } });
    expect(judgeMove(m, 'c2c3', cached)).toEqual({ kind: 'unknown' });
    // An eval of another position is never used.
    expect(judgeMove(m, 'a2a3', ev({ a2a3: -10 }, START_FEN))).toEqual({ kind: 'unknown' });
  });
});

describe('evaluateTrainingMove', () => {
  beforeEach(() => {
    useTestDb();
  });

  async function setup(): Promise<{ m: Mistake; pool: FakePool }> {
    const id = (await repo.createProfile({ name: 'Hero', kind: 'self', accounts: [], aliases: [] })).id;
    const m = testMistake(id, P1, 'f3e5', { bestMove: 'f3d4', acceptable: ['f3d4'] });
    await repo.upsertMistakes([m]);
    const pool = new FakePool(1, { [keyOf(P1)]: { f3d4: 40, f3e5: -250, e1g1: 30, b2b4: -60 } });
    return { m, pool };
  }

  it('evaluates the move against the best move at interactive priority, caches it and remembers an acceptable move', async () => {
    const { m, pool } = await setup();
    const verdict = await evaluateTrainingMove(pool, m, 'e1h1', 14);
    expect(verdict).toMatchObject({ kind: 'correct', best: false, line: { move: 'e1g1' } });
    expect(pool.calls).toEqual([expect.objectContaining({ moves: ['e1g1', 'f3d4'], depth: 14, priority: 'interactive' })]);
    const cached = (await repo.getEvals([`${ENGINE_ID}|${keyOf(P1)}`])).get(`${ENGINE_ID}|${keyOf(P1)}`)!;
    expect(Object.keys(cached.moves).sort()).toEqual(['e1g1', 'f3d4']);
    expect((await repo.getMistakes(m.profileId))[0]!.acceptable).toEqual(['f3d4', 'e1g1']);
  });

  it('a losing move is judged wrong and does not change the acceptable list', async () => {
    const { m, pool } = await setup();
    expect(await evaluateTrainingMove(pool, m, 'b2b4', 14)).toMatchObject({ kind: 'wrong' });
    expect((await repo.getMistakes(m.profileId))[0]!.acceptable).toEqual(['f3d4']);
  });

  it('merges into a same-depth cache record and leaves a different-depth record alone', async () => {
    const { m, pool } = await setup();
    const analysisEval = await pool.evaluatePosition(P1, ['f3e5'], { depth: 14 });
    await repo.putEval(analysisEval);
    await evaluateTrainingMove(pool, m, 'e1g1', 14);
    const key = `${ENGINE_ID}|${keyOf(P1)}`;
    expect(Object.keys((await repo.getEvals([key])).get(key)!.moves).sort()).toEqual(['e1g1', 'f3d4', 'f3e5']);

    const deeper = await pool.evaluatePosition(P1, ['f3e5'], { depth: 18 });
    await repo.putEval(deeper);
    await evaluateTrainingMove(pool, m, 'b2b4', 14);
    expect((await repo.getEvals([key])).get(key)).toEqual(deeper);
  });

  it('answers the habit and illegal moves without the engine', async () => {
    const { m, pool } = await setup();
    expect(await evaluateTrainingMove(pool, m, 'f3e5', 14)).toEqual({ kind: 'habit' });
    expect(await evaluateTrainingMove(pool, m, 'e7e5', 14)).toEqual({ kind: 'unknown' });
    expect(pool.calls).toEqual([]);
  });
});

describe('recordGrade', () => {
  beforeEach(() => {
    useTestDb();
  });

  it('grades a new card from a fresh review state and persists the review and the attempt', async () => {
    const m = testMistake('p1', P1, 'f3e5');
    const r1 = await recordGrade({ mistake: m, isNew: true }, 'good', NOW);
    expect(r1).toMatchObject({ mistakeId: m.id, profileId: 'p1', reps: 1, interval: 1, due: NOW + DAY, lastGrade: 'good', lastReviewedAt: NOW });
    const r2 = await recordGrade({ mistake: m, review: r1, isNew: false }, 'again', NOW + DAY);
    expect(r2).toMatchObject({ interval: 0, reps: 0, lapses: 1, due: NOW + DAY + 10 * 60_000 });
    expect(await repo.getReviews('p1')).toEqual([r2]);
    expect((await repo.getAttempts('p1')).map(a => [a.at, a.grade])).toEqual([
      [NOW, 'good'],
      [NOW + DAY, 'again'],
    ]);
  });
});

describe('judgeRefutationMove', () => {
  it('accepts the punishing reply and evaluates anything else', async () => {
    const after = playUci(P1, 'f3e5')!;
    const m = testMistake('op', P1, 'f3e5', {
      refutation: { fen: after, posKey: keyOf(after), bestMove: 'd8g5', bestLine: ['d8g5'], score: { cp: 300 }, acceptable: ['d8g5'], depth: 14 },
    });
    const pool = new FakePool(1, { [keyOf(after)]: { d8g5: 300, d4e6: 260, a7a6: -100 } });
    expect(await judgeRefutationMove(pool, m, 'd8g5', 14)).toEqual({ kind: 'correct', best: true });
    expect(await judgeRefutationMove(pool, m, 'd4e6', 14)).toMatchObject({ kind: 'correct', best: false });
    expect(await judgeRefutationMove(pool, m, 'a7a6', 14)).toMatchObject({ kind: 'wrong' });
    expect(pool.calls.every(c => c.priority === 'interactive' && c.posKey === keyOf(after))).toBe(true);
    expect(await judgeRefutationMove(pool, testMistake('op', P1, 'f3e5'), 'd8g5', 14)).toEqual({ kind: 'unknown' });
  });
});

describe('new cards: parents are introduced before their children', () => {
  it('a child with a higher impact waits until its never-seen parent has been introduced', () => {
    const parent = leak('a7a6', 1);
    const child = leak('b7b6', 30, { dependsOn: parent.id, ply: 5 });
    const other = leak('h7h6', 10);
    expect(buildSession([child, other, parent], [], NOW, { size: 10, newToday: 0, newPerDay: 1 }).map(c => c.mistake.move)).toEqual(['a7a6']);
    expect(buildSession([child, other, parent], [], NOW, { size: 10, newToday: 0, newPerDay: 2 }).map(c => c.mistake.move)).toEqual(['a7a6', 'b7b6']);
    expect(buildSession([child, other, parent], [], NOW, { size: 10, newToday: 0, newPerDay: 3 }).map(c => c.mistake.move)).toEqual(['a7a6', 'b7b6', 'h7h6']);
  });

  it('a child is introduced on its own once the parent has a review (or is not listed)', () => {
    const parent = leak('a7a6', 1);
    const child = leak('b7b6', 30, { dependsOn: parent.id, ply: 5 });
    const seen: ReviewState = { mistakeId: parent.id, profileId: 'p', due: NOW + DAY, interval: 1, ease: 2.5, reps: 1, lapses: 0 };
    expect(buildSession([child, parent], [seen], NOW, { size: 10, newToday: 0, newPerDay: 1 }).map(c => c.mistake.move)).toEqual(['b7b6']);
    const mastered = { ...parent, status: 'mastered' as const };
    expect(buildSession([child, mastered], [], NOW, { size: 10, newToday: 0, newPerDay: 1 }).map(c => c.mistake.move)).toEqual(['b7b6']);
  });
});

describe('live verdicts are remembered', () => {
  beforeEach(() => {
    useTestDb();
  });

  it('a wrong move evaluated live gets the same verdict from the cache next time, without the engine', async () => {
    const m = testMistake('p', P1, 'f3e5', { bestMove: 'f3d4', acceptable: ['f3d4'] });
    const pool = new FakePool(1, { [keyOf(P1)]: { f3d4: 40, f3e5: -250, h2h3: -120 } });
    // The analysis left a confirm-depth record for the position.
    await repo.putEval(await pool.evaluatePosition(P1, ['f3e5'], { depth: 14 }));
    const first = await evaluateTrainingMove(pool, m, 'h2h3', 14);
    expect(first).toMatchObject({ kind: 'wrong' });
    const cached = (await repo.getEvals([`${ENGINE_ID}|${keyOf(P1)}`])).get(`${ENGINE_ID}|${keyOf(P1)}`);
    expect(judgeMove(m, 'h2h3', cached)).toEqual(first);
  });

  it('grading twice builds on the stored review (no lost interval)', async () => {
    const m = leak('a7a6', 1);
    const r1 = await recordGrade({ mistake: m, isNew: true }, 'good', NOW);
    const r2 = await recordGrade({ mistake: m, review: r1, isNew: false }, 'good', NOW + DAY);
    expect([r1.interval, r2.interval]).toEqual([1, 3]);
    expect((await repo.getReviews('p'))[0]).toEqual(r2);
    expect(await repo.getAttempts('p')).toHaveLength(2);
  });
});
