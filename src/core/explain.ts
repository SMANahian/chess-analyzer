// One-line, plain-English consequences of a line (normally a habit move and its refutation):
// "loses a pawn", "loses the exchange", "allows mate"… Deliberately modest: only material and mate.
import type { Position } from 'chessops/chess';
import type { NormalMove, Role } from 'chessops/types';
import { opposite } from 'chessops/util';
import { materialBalance, parseStandardUci, posFromFen } from './chess';
import type { Color, Score } from './types';

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

/**
 * "allows mate", "loses the queen", "loses a rook", "loses a piece", "loses the exchange",
 * "loses two pawns", "loses a pawn", "loses material", or '' when nothing simple can be said.
 * Material is judged like materialSwing (6 plies plus a trailing capture sequence).
 * `score` (optional) is the line's score from the mover's point of view.
 */
export function explainLine(fen: string, line: readonly string[], score?: Score): string {
  const start = posFromFen(fen);
  if (!start || line.length === 0) return '';
  if (allowsMate(start, line, score)) return 'allows mate';
  const end = start.clone();
  playOut(end, line, DEFAULT_PLIES);
  const sign = start.turn === 'white' ? 1 : -1;
  const lost = sign * (materialBalance(start) - materialBalance(end));
  return lost >= 1 ? describeLoss(lost, role => netLoss(start, end, role)) : '';
}
