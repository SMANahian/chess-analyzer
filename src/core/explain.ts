// One-line, plain-English consequences of a line (normally a habit move and its refutation):
// "loses a pawn", "loses the exchange", "allows mate"… Deliberately modest: only material and mate.
import type { Position } from 'chessops/chess';
import type { NormalMove, Role } from 'chessops/types';
import { opposite } from 'chessops/util';
import { materialBalance, parseStandardUci, posFromFen } from './chess';
import type { Color, Mistake, Score } from './types';

const DEFAULT_PLIES = 6;
/** Plies a line may run past the horizon while it keeps capturing, so an exchange is not cut in half. */
const RECAPTURE_PLIES = 2;

function isCapture(pos: Position, move: NormalMove): boolean {
  const target = pos.board.get(move.to);
  if (target) return target.color !== pos.turn;
  // En passant: a pawn moving diagonally onto an empty square.
  return pos.board.getRole(move.from) === 'pawn' && (move.from & 7) !== (move.to & 7);
}

/** Plays up to `plies` plies of `line` (plus a trailing capture sequence); stops at an illegal move. */
function playOut(pos: Position, line: readonly string[], plies: number): void {
  let played = 0;
  for (const uci of line) {
    const move = parseStandardUci(pos, uci);
    if (!move) return;
    if (played >= plies && (played >= plies + RECAPTURE_PLIES || !isCapture(pos, move))) return;
    pos.play(move);
    played++;
  }
}

/**
 * Material change (pawn units) for the side that plays line[0], after up to `plies` plies of the line
 * from `fen` — extended by up to two plies while the line keeps capturing, so a recapture is counted.
 * Negative = the mover lost material. 0 for an invalid FEN.
 */
export function materialSwing(fen: string, line: readonly string[], plies: number = DEFAULT_PLIES): number {
  const pos = posFromFen(fen);
  if (!pos) return 0;
  const sign = pos.turn === 'white' ? 1 : -1;
  const before = materialBalance(pos);
  playOut(pos, line, plies);
  return sign * (materialBalance(pos) - before) || 0; // no −0 for Black
}

/** True when the line ends with the mover checkmated, or the score says the mover gets mated. */
function allowsMate(start: Position, line: readonly string[], score?: Score): boolean {
  if (score?.mate !== undefined && score.mate < 0) return true;
  const pos = start.clone();
  playOut(pos, line, line.length);
  return pos.isCheckmate() && pos.turn === start.turn;
}

/**
 * Pieces of `role` the side to move at `start` lost by `end`, minus those its opponent lost. A side
 * gaining pieces of the role (a promotion) does not count as the other side losing one.
 */
function netLoss(start: Position, end: Position, role: Role): number {
  const lost = (color: Color): number =>
    Math.max(0, start.board.pieces(color, role).size() - end.board.pieces(color, role).size());
  return lost(start.turn) - lost(opposite(start.turn));
}

/** `n` = material lost (pawn units, ≥ 1); `net` = net pieces of a role lost. */
function describeLoss(n: number, net: (role: Role) => number): string {
  if (n >= 8 && net('queen') > 0) return 'loses the queen';
  if (n >= 5 && net('rook') > 0) return 'loses a rook';
  if (n >= 3 && net('knight') + net('bishop') > 0) return 'loses a piece';
  if (n === 2 && net('rook') > 0) return 'loses the exchange';
  // Only when pawns are what was lost: two minor pieces for a rook is also −1.
  if (n === 1 && net('pawn') >= 1) return 'loses a pawn';
  if (n === 2 && net('pawn') >= 2) return 'loses two pawns';
  return 'loses material';
}

/** The position after the line's window (DEFAULT_PLIES plus a trailing capture sequence) and the material the mover lost. */
function outcomeOf(start: Position, line: readonly string[]): { end: Position; lost: number } {
  const end = start.clone();
  playOut(end, line, DEFAULT_PLIES);
  const sign = start.turn === 'white' ? 1 : -1;
  return { end, lost: sign * (materialBalance(start) - materialBalance(end)) || 0 };
}

/**
 * "allows mate", "loses the queen", "loses a rook", "loses a piece", "loses the exchange",
 * "loses two pawns", "loses a pawn", "loses material", or '' when nothing simple can be said.
 * Material is judged like materialSwing (6 plies plus a trailing capture sequence).
 * `score` (optional) is the line's score from the mover's point of view.
 *
 * With `bestLine` (the engine's best line from the same position, `bestScore` its score), the line is
 * judged against it, over the same window: material that the best line gives up as well (a pawn that
 * was already en prise, a gambit both lines accept) is not blamed on the line's first move, and
 * neither is a mate that the best line allows too. Only what the line loses beyond the best line is
 * described ('' when that is nothing, so callers fall back to describing the resulting position).
 */
export function explainLine(fen: string, line: readonly string[], score?: Score, bestLine?: readonly string[], bestScore?: Score): string {
  const start = posFromFen(fen);
  if (!start || line.length === 0) return '';
  const best = bestLine && bestLine.length > 0 ? bestLine : undefined;
  if (allowsMate(start, line, score) && !(best && allowsMate(start, best, bestScore))) return 'allows mate';
  const played = outcomeOf(start, line);
  if (!best) return played.lost >= 1 ? describeLoss(played.lost, role => netLoss(start, played.end, role)) : '';
  // What the best line loses is the baseline; a gain in the best line is no loss of the played line.
  const baseline = outcomeOf(start, best);
  const lost = played.lost - Math.max(0, baseline.lost);
  if (lost < 1) return '';
  return describeLoss(lost, role => netLoss(start, played.end, role) - Math.max(0, netLoss(start, baseline.end, role)));
}

/** The pieces of a mistake the explanation needs. */
export type ExplainableMistake = Pick<Mistake, 'fen' | 'move' | 'bestMove' | 'playedLine' | 'bestLine' | 'scorePlayed' | 'scoreBest'>;

/**
 * Why the habit move fails, judged against the best move (see explainLine): its refutation line
 * (playedLine, or just the move) against bestLine. Shared by the UI and the PGN export.
 */
export function explainMistake(m: ExplainableMistake): string {
  const line = m.playedLine[0] === m.move ? m.playedLine : [m.move];
  const best = m.bestLine[0] === m.bestMove ? m.bestLine : [m.bestMove];
  return explainLine(m.fen, line, m.scorePlayed, best, m.scoreBest);
}
