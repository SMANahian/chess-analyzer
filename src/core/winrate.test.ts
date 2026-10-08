import { describe, expect, it } from 'vitest';
import {
  LOW_CONFIDENCE_BELOW,
  THRESHOLDS,
  compareScores,
  describeLoss,
  formatScore,
  negateScore,
  pawnsForLoss,
  scoreForColor,
  severityOf,
  winLoss,
  winPercent,
} from './winrate';
import type { Score } from './types';

describe('winPercent', () => {
  it('is 50 at 0 cp and follows the Lichess curve', () => {
    expect(winPercent({ cp: 0 })).toBe(50);
    expect(winPercent({ cp: 100 })).toBeCloseTo(59.1, 1);
    expect(winPercent({ cp: -100 })).toBeCloseTo(40.9, 1);
    expect(winPercent({ cp: 300 }) + winPercent({ cp: -300 })).toBeCloseTo(100, 10);
  });

  it('clamps cp to ±1000', () => {
    expect(winPercent({ cp: 1000 })).toBeCloseTo(97.545, 3);
    expect(winPercent({ cp: 5000 })).toBe(winPercent({ cp: 1000 }));
    expect(winPercent({ cp: -5000 })).toBe(winPercent({ cp: -1000 }));
    expect(winPercent({ cp: 999 })).toBeLessThan(winPercent({ cp: 1000 }));
  });

  it('maps mates to 100 / 0', () => {
    expect(winPercent({ mate: 3 })).toBe(100);
    expect(winPercent({ mate: -3 })).toBe(0);
    expect(winPercent({ mate: 0 })).toBe(0);
  });

  it('treats a malformed empty score as 0 cp instead of NaN', () => {
    expect(winPercent({})).toBe(50);
  });
});

describe('winLoss and severity thresholds', () => {
  it('never goes negative', () => {
    expect(winLoss({ cp: 0 }, { cp: 50 })).toBe(0);
    expect(winLoss({ cp: 50 }, { cp: -60 })).toBeCloseTo(winPercent({ cp: 50 }) - winPercent({ cp: -60 }), 10);
  });

  it('grades by win-% loss', () => {
    expect(THRESHOLDS).toEqual({ inaccuracy: 5, mistake: 10, blunder: 15 });
    expect(LOW_CONFIDENCE_BELOW).toBe(7.5);
    expect(severityOf(4.99)).toBeNull();
    expect(severityOf(5)).toBe('inaccuracy');
    expect(severityOf(9.99)).toBe('inaccuracy');
    expect(severityOf(14.99)).toBe('mistake');
    expect(severityOf(10)).toBe('mistake');
    expect(severityOf(15)).toBe('blunder');
    expect(severityOf(80)).toBe('blunder');
  });

  it('uses the thresholds when no mate changes hands', () => {
    const best: Score = { cp: 40 };
    const played: Score = { cp: -80 };
    const loss = winLoss(best, played);
    expect(severityOf(loss, best, played)).toBe(severityOf(loss));
    expect(severityOf(0, { mate: -5 }, { mate: -2 })).toBeNull();
    expect(severityOf(0, { cp: 20 }, { mate: 4 })).toBeNull();
  });
});

describe('mate rule (Lichess Advice.scala)', () => {
  const graded = (best: Score, played: Score) => severityOf(winLoss(best, played), best, played);

  it('grades a lost forced mate by the cp that remains', () => {
    expect(graded({ mate: 3 }, { cp: 1200 })).toBe('inaccuracy');
    expect(graded({ mate: 3 }, { cp: 1000 })).toBe('inaccuracy');
    expect(graded({ mate: 3 }, { cp: 999 })).toBe('mistake');
    expect(graded({ mate: 3 }, { cp: 701 })).toBe('mistake');
    expect(graded({ mate: 3 }, { cp: 700 })).toBe('blunder');
    expect(graded({ mate: 3 }, { cp: 500 })).toBe('blunder');
    expect(graded({ mate: 1 }, { cp: -50 })).toBe('blunder');
  });

  it('grades a mate against the mover as a blunder (unless the game was already lost)', () => {
    expect(graded({ mate: 2 }, { mate: -2 })).toBe('blunder');
    expect(graded({ cp: 30 }, { mate: -1 })).toBe('blunder');
    expect(graded({ cp: -650 }, { mate: -4 })).toBe('blunder');
    expect(graded({ cp: -800 }, { mate: -4 })).toBe('mistake');
    expect(graded({ cp: -1200 }, { mate: -4 })).toBe('inaccuracy');
  });

  it('does not grade a merely delayed mate', () => {
    expect(graded({ mate: 2 }, { mate: 6 })).toBeNull();
  });
});

describe('compareScores', () => {
  it('orders mates, cp and being mated for the side to move', () => {
    const bestFirst: Score[] = [{ mate: 1 }, { mate: 4 }, { cp: 1500 }, { cp: 900 }, { cp: 0 }, { cp: -300 }, { mate: -6 }, { mate: -1 }, { mate: 0 }];
    const shuffled = [bestFirst[4]!, bestFirst[7]!, bestFirst[0]!, bestFirst[8]!, bestFirst[2]!, bestFirst[5]!, bestFirst[1]!, bestFirst[6]!, bestFirst[3]!];
    expect([...shuffled].sort((a, b) => compareScores(b, a))).toEqual(bestFirst);
  });

  it('returns the sign of a − b', () => {
    expect(compareScores({ cp: 10 }, { cp: 10 })).toBe(0);
    expect(compareScores({ mate: 2 }, { mate: 2 })).toBe(0);
    expect(compareScores({ mate: 9 }, { cp: 5000 })).toBeGreaterThan(0);
    expect(compareScores({ mate: -9 }, { cp: -5000 })).toBeLessThan(0);
    expect(compareScores({ cp: 1500 }, { cp: 1200 })).toBeGreaterThan(0);
  });
});

describe('display helpers', () => {
  it('negates scores', () => {
    expect(negateScore({ cp: 35 })).toEqual({ cp: -35 });
    expect(negateScore({ cp: 0 })).toEqual({ cp: 0 });
    expect(Object.is(negateScore({ cp: 0 }).cp, 0)).toBe(true);
    expect(negateScore({ mate: -2 })).toEqual({ mate: 2 });
  });

  it('formats with a real minus sign', () => {
    expect(formatScore({ cp: 35 })).toBe('+0.35');
    expect(formatScore({ cp: -120 })).toBe('−1.20');
    expect(formatScore({ cp: 0 })).toBe('0.00');
    expect(formatScore({ cp: 5 })).toBe('+0.05');
    expect(formatScore({ mate: 3 })).toBe('#3');
    expect(formatScore({ mate: -2 })).toBe('#−2');
  });

  it('re-expresses scores from the viewer’s side', () => {
    expect(scoreForColor({ cp: 80 }, 'white', 'white')).toEqual({ cp: 80 });
    expect(scoreForColor({ cp: 80 }, 'black', 'white')).toEqual({ cp: -80 });
    expect(scoreForColor({ mate: 2 }, 'white', 'black')).toEqual({ mate: -2 });
  });

  it('describes losses in pawns at an equal position', () => {
    expect(pawnsForLoss(5)).toBeCloseTo(0.545, 2);
    expect(pawnsForLoss(10)).toBeCloseTo(1.101, 2);
    expect(pawnsForLoss(50 - winPercent({ cp: -250 }))).toBeCloseTo(2.5, 6);
    expect(pawnsForLoss(-3)).toBe(0);
    expect(pawnsForLoss(49.9)).toBe(10);
    expect(pawnsForLoss(80)).toBe(10);
    expect(describeLoss(10)).toBe('≈1.1 pawns');
    expect(describeLoss(5)).toBe('≈0.5 pawns');
    expect(describeLoss(winPercent({ cp: 0 }) - winPercent({ cp: -100 }))).toBe('≈1.0 pawn');
    expect(describeLoss(60)).toBe('≥10 pawns');
  });
});
