// Win-percentage model and move severities, following Lichess (WinPercent.scala, Advice.scala).
// Scores are from the point of view of the side to move at the analysed root.
import type { Color, Score, Severity } from './types';

export const THRESHOLDS = { inaccuracy: 5, mistake: 10, blunder: 15 } as const;
/** Losses below this (but ≥ the inaccuracy threshold) are within engine noise at lite depth 14. */
export const LOW_CONFIDENCE_BELOW = 7.5;

const CP_CLAMP = 1000;
const K = 0.00368208;
const MINUS = '−';

const isMate = (s: Score): s is Score & { mate: number } => s.mate !== undefined;
/** A missing score counts as 0 cp, so a malformed eval never produces NaN. */
const cpOf = (s: Score): number => s.cp ?? 0;
const mates = (s: Score): boolean => isMate(s) && s.mate > 0;
const isMated = (s: Score): boolean => isMate(s) && s.mate <= 0;

/** 0..100 for the side to move. cp is clamped to ±1000; mate for the side to move = 100, mated (or mate 0) = 0. */
export function winPercent(s: Score): number {
  if (isMate(s)) return s.mate > 0 ? 100 : 0;
  const cp = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, cpOf(s)));
  return 50 + 50 * (2 / (1 + Math.exp(-K * cp)) - 1);
}

/** Total order for the side to move: mates > any cp > being mated; shorter wins and longer losses are better. */
function rank(s: Score): [tier: number, within: number] {
  if (!isMate(s)) return [1, cpOf(s)];
  return s.mate > 0 ? [2, -s.mate] : [0, -s.mate];
}

/** > 0 if `a` is better than `b` for the side to move, < 0 if worse, 0 if equal. */
export function compareScores(a: Score, b: Score): number {
  const [ta, wa] = rank(a);
  const [tb, wb] = rank(b);
  return ta !== tb ? ta - tb : wa - wb;
}

/** Win-% points lost by playing `played` instead of `best` (never negative). */
export function winLoss(best: Score, played: Score): number {
  return Math.max(0, winPercent(best) - winPercent(played));
}

function bySize(loss: number): Severity | null {
  if (loss >= THRESHOLDS.blunder) return 'blunder';
  if (loss >= THRESHOLDS.mistake) return 'mistake';
  if (loss >= THRESHOLDS.inaccuracy) return 'inaccuracy';
  return null;
}

/**
 * Lichess's mate rule (Advice.scala), or undefined when no mate changes hands:
 * - a forced mate is lost: graded by the cp that remains (> 999 inaccuracy, > 700 mistake, else blunder);
 * - a mate against the mover is allowed: graded by the cp the best move kept (< −999 inaccuracy,
 *   < −700 mistake, else blunder), i.e. a blunder unless the game was already lost;
 * - a mate is merely delayed: no severity.
 */
function mateSeverity(best: Score, played: Score): Severity | null | undefined {
  if (mates(best)) {
    if (mates(played)) return null;
    const left = isMate(played) ? 0 : cpOf(played);
    return left > 999 ? 'inaccuracy' : left > 700 ? 'mistake' : 'blunder';
  }
  if (!isMate(best) && isMated(played)) {
    const kept = cpOf(best);
    return kept < -999 ? 'inaccuracy' : kept < -700 ? 'mistake' : 'blunder';
  }
  return undefined;
}

/**
 * Severity of a move losing `loss` win-% points: blunder ≥ 15, mistake ≥ 10, inaccuracy ≥ 5.
 * With both scores given, mate transitions follow Lichess's mate rule instead (which can grade a
 * move whose win-% loss is below 5, e.g. #3 → +12.00 is an inaccuracy). Callers decide what to store.
 */
export function severityOf(loss: number, best?: Score, played?: Score): Severity | null {
  if (best && played) {
    const bymate = mateSeverity(best, played);
    if (bymate !== undefined) return bymate;
  }
  return bySize(loss);
}

export function negateScore(s: Score): Score {
  if (isMate(s)) return { mate: s.mate === 0 ? 0 : -s.mate };
  const cp = cpOf(s);
  return { cp: cp === 0 ? 0 : -cp };
}

/** "+0.35", "−1.20", "0.00", "#3", "#−2" (side-to-move POV; real minus sign). */
export function formatScore(s: Score): string {
  if (isMate(s)) return s.mate < 0 ? `#${MINUS}${-s.mate}` : `#${s.mate}`;
  const cp = Math.round(cpOf(s));
  const abs = (Math.abs(cp) / 100).toFixed(2);
  return cp > 0 ? `+${abs}` : cp < 0 ? `${MINUS}${abs}` : abs;
}

/** Re-expresses a side-to-move score from `viewer`'s side (for display). */
export function scoreForColor(s: Score, sideToMove: Color, viewer: Color): Score {
  return sideToMove === viewer ? s : negateScore(s);
}

/**
 * Pawns that cost `loss` win-% points from an equal position (inverse of the win-% curve at 0 cp):
 * 5 → ≈0.55, 10 → ≈1.1. Capped at 10 pawns, where the curve is clamped.
 */
export function pawnsForLoss(loss: number): number {
  const l = Math.max(0, loss);
  if (l >= 50) return CP_CLAMP / 100;
  return Math.min(CP_CLAMP, Math.log((50 + l) / (50 - l)) / K) / 100;
}

/** "≈1.1 pawns" style copy for a win-% loss. */
export function describeLoss(loss: number): string {
  const pawns = pawnsForLoss(loss);
  if (pawns >= CP_CLAMP / 100) return '≥10 pawns';
  const shown = (Math.round(pawns * 10) / 10).toFixed(1);
  return `≈${shown} ${shown === '1.0' ? 'pawn' : 'pawns'}`;
}
