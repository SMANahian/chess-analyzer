import { describe, expect, it } from 'vitest';
import { START_FEN, playUci } from '../../core/chess';
import type { Mistake, ReviewState } from '../../core/types';
import { NEW_ATTEMPT, afterVerdict, cardSpec, cleanSolve, gradeAttempt, hint, isGraded, practiceCards, replayPlan, reveal, type Attempt } from './trainFlow';

const NOW = 1_800_000_000_000;
const PATH = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5'];
const FEN = PATH.reduce((fen, uci) => playUci(fen, uci)!, START_FEN);

function mistake(p: Partial<Mistake> = {}): Mistake {
  return {
    id: 'p|k|f6d5',
    shortId: 's1',
    profileId: 'p',
    color: 'black',
    posKey: 'k',
    fen: FEN,
    ply: 9,
    path: PATH,
    move: 'f6d5',
    kind: 'mistake',
    count: 3,
    positionCount: 4,
    occurrences: [],
    bestMove: 'c6a5',
    acceptable: ['c6a5'],
    bestLine: ['c6a5', 'c4b5'],
    playedLine: ['f6d5', 'g5f7'],
    scoreBest: { cp: -20 },
    scorePlayed: { cp: -130 },
    winLoss: 10,
    severity: 'mistake',
    confidence: 'normal',
    impact: 1,
    lastPlayedAt: NOW,
    lastOutcome: 'habit',
    fixedStreak: 0,
    evalDepth: 14,
    engine: 'sf19-lite@1',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...p,
  };
}

const review = (p: Partial<ReviewState> = {}): ReviewState => ({ mistakeId: 'p|k|f6d5', profileId: 'p', due: NOW, interval: 3, ease: 2.5, reps: 2, lapses: 0, ...p });

describe('cardSpec', () => {
  it('asks for the best move in the mistake position, from the player side', () => {
    const spec = cardSpec(mistake());
    expect(spec).toMatchObject({ fen: FEN, userColor: 'black', lastMove: 'e4d5', best: 'c6a5', habit: 'f6d5', prep: false });
  });
  it('turns a scouted mistake into a prep drill after their habit move', () => {
    const after = playUci(FEN, 'f6d5')!;
    const spec = cardSpec(
      mistake({ refutation: { fen: after, posKey: 'x', bestMove: 'g5f7', bestLine: ['g5f7', 'e8f7'], score: { cp: 150 }, acceptable: [], depth: 14 } }),
    );
    expect(spec).toMatchObject({ fen: after, userColor: 'white', lastMove: 'f6d5', best: 'g5f7', prep: true });
    expect(spec.path).toEqual([...PATH, 'f6d5']);
    expect(spec.habit).toBeUndefined();
  });
});

describe('replayPlan', () => {
  it('replays the last plies from the position before them', () => {
    const plan = replayPlan(PATH, 4);
    expect(plan?.ucis).toEqual(['g8f6', 'f3g5', 'd7d5', 'e4d5']);
    expect(plan && plan.ucis.reduce((fen, uci) => playUci(fen, uci)!, plan.fromFen)).toBe(FEN);
  });
  it('clamps to the path and turns off for 0 plies or an illegal path', () => {
    expect(replayPlan(PATH, 50)?.fromFen).toBe(START_FEN);
    expect(replayPlan(PATH, 0)).toBeNull();
    expect(replayPlan([], 6)).toBeNull();
    expect(replayPlan(['e2e4', 'e2e4'], 2)).toBeNull();
  });
});

describe('attempt flow', () => {
  const play = (a: Attempt, ...kinds: ('correct' | 'best' | 'low' | 'habit' | 'wrong' | 'unknown')[]): { attempt: Attempt; next: string } => {
    let state = { attempt: a, next: 'start' };
    for (const k of kinds) {
      const v =
        k === 'best' ? { kind: 'correct' as const, best: true }
        : k === 'correct' ? { kind: 'correct' as const, best: false }
        : k === 'low' ? { kind: 'low-confidence' as const, loss: 6 }
        : k === 'wrong' ? { kind: 'wrong' as const, loss: 20 }
        : k === 'habit' ? { kind: 'habit' as const }
        : { kind: 'unknown' as const };
      state = afterVerdict(state.attempt, v);
    }
    return state;
  };

  it('first-try best move: done, good, a clean solve', () => {
    const { attempt, next } = play(NEW_ATTEMPT, 'best');
    expect(next).toBe('done');
    expect(gradeAttempt(attempt)).toBe('good');
    expect(cleanSolve(attempt)).toBe(true);
  });
  it('first-try correct after a good review with a long interval is easy', () => {
    expect(gradeAttempt(play(NEW_ATTEMPT, 'correct').attempt, review({ lastGrade: 'good', interval: 4 }))).toBe('easy');
  });
  it('a playable but imprecise move finishes the card as hard', () => {
    const { attempt, next } = play(NEW_ATTEMPT, 'low');
    expect(next).toBe('done');
    expect(gradeAttempt(attempt)).toBe('hard');
  });
  it('wrong then right is hard; a hint makes even a first try hard', () => {
    const { attempt, next } = play(NEW_ATTEMPT, 'wrong', 'best');
    expect(next).toBe('done');
    expect(gradeAttempt(attempt)).toBe('hard');
    expect(cleanSolve(attempt)).toBe(false);
    expect(gradeAttempt(play(hint(NEW_ATTEMPT), 'best').attempt)).toBe('hard');
  });
  it('the habit allows a retry but always grades again', () => {
    const first = play(NEW_ATTEMPT, 'habit');
    expect(first.next).toBe('retry');
    const { attempt, next } = play(first.attempt, 'best');
    expect(next).toBe('done');
    expect(gradeAttempt(attempt)).toBe('again');
  });
  it('two failures reveal the answer and grade again', () => {
    const { attempt, next } = play(NEW_ATTEMPT, 'wrong', 'wrong');
    expect(next).toBe('reveal');
    expect(gradeAttempt(reveal(attempt))).toBe('again');
  });
  it('an unknown verdict does not count as a try', () => {
    const { attempt, next } = play(NEW_ATTEMPT, 'unknown');
    expect(next).toBe('ignore');
    expect(attempt).toEqual(NEW_ATTEMPT);
  });
  it('giving up without a move grades again', () => {
    expect(gradeAttempt(reveal(NEW_ATTEMPT))).toBe('again');
  });
  it('hints stop at two', () => {
    expect(hint(hint(hint(NEW_ATTEMPT))).hints).toBe(2);
  });
});

describe('sessions', () => {
  it('grades new and due cards, not early practice', () => {
    expect(isGraded({ mistake: mistake(), isNew: true }, NOW)).toBe(true);
    expect(isGraded({ mistake: mistake(), review: review({ due: NOW - 1 }), isNew: false }, NOW)).toBe(true);
    expect(isGraded({ mistake: mistake(), review: review({ due: NOW + 1000 }), isNew: false }, NOW)).toBe(false);
  });
  it('practises the soonest-due cards first, then unseen ones in list order', () => {
    const a = mistake({ id: 'a' });
    const b = mistake({ id: 'b' });
    const c = mistake({ id: 'c' });
    const reviews = new Map([
      ['b', review({ mistakeId: 'b', due: NOW + 5000 })],
      ['c', review({ mistakeId: 'c', due: NOW + 1000 })],
    ]);
    const cards = practiceCards([a, b, c], reviews, 10);
    expect(cards.map(x => [x.mistake.id, x.isNew])).toEqual([
      ['c', false],
      ['b', false],
      ['a', true],
    ]);
    expect(practiceCards([a, b, c], reviews, 1)).toHaveLength(1);
  });
});
