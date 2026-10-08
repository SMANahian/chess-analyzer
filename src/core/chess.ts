// Chess helpers on top of chessops. Everything here speaks *standard* UCI (e1g1 for castling,
// e7e8q for promotions); chessops' internal king-takes-rook castling encoding never leaks out.
import { Chess, castlingSide, type Position } from 'chessops/chess';
import { INITIAL_FEN, makeFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import { kingCastlesTo, makeSquare, makeUci, parseSquare, parseUci } from 'chessops/util';
import { chessgroundDests } from 'chessops/compat';
import { isNormal, type Move, type NormalMove, type Role, type SquareName } from 'chessops/types';
import type { Color } from './types';

export const START_FEN = INITIAL_FEN;

/** FEN → position, or undefined for invalid input. Never throws. */
export function posFromFen(fen: string): Chess | undefined {
  return parseFen(fen)
    .chain(setup => Chess.fromSetup(setup))
    .unwrap(
      pos => pos,
      () => undefined,
    );
}

/** Position key: board, turn, castling and an en-passant square only when a legal capture exists. */
export function posKey(pos: Position): string {
  return makeFen(pos.toSetup(), { epd: true });
}

const START_KEY = posKey(Chess.default());

/** True when `fen` (full FEN or EPD; Shredder castling allowed) is the standard starting position. */
export function isStandardStartFen(fen: string): boolean {
  const pos = posFromFen(fen.trim().split(/\s+/).join(' '));
  return pos !== undefined && posKey(pos) === START_KEY;
}

export function fenOf(pos: Position): string {
  return makeFen(pos.toSetup());
}

export function turnColor(pos: Position): Color {
  return pos.turn;
}

/** Standard UCI for a legal move. Call before `pos.play(move)`. */
export function toStandardUci(pos: Position, move: Move): string {
  if (isNormal(move)) {
    const side = castlingSide(pos, move);
    if (side) return makeSquare(move.from) + makeSquare(kingCastlesTo(pos.turn, side));
  }
  return makeUci(move);
}

/**
 * Parses standard (e1g1) or king-takes-rook (e1h1) UCI into a legal move.
 * Guards the chessops quirk where any king move onto an own piece counts as castling.
 */
export function parseStandardUci(pos: Position, uci: string): NormalMove | undefined {
  const move = parseUci(uci);
  if (!move || !isNormal(move)) return undefined;
  const side = castlingSide(pos, move);
  if (side && move.to !== pos.castles.rook[pos.turn][side] && move.to !== kingCastlesTo(pos.turn, side)) {
    return undefined;
  }
  return pos.isLegal(move) ? move : undefined;
}

export function normalizeUci(fen: string, uci: string): string | undefined {
  const pos = posFromFen(fen);
  if (!pos) return undefined;
  const move = parseStandardUci(pos, uci);
  return move ? toStandardUci(pos, move) : undefined;
}

/** SAN for a legal move in `fen`, '' if the move is illegal. */
export function sanOf(fen: string, uci: string): string {
  const pos = posFromFen(fen);
  if (!pos) return '';
  const move = parseStandardUci(pos, uci);
  return move ? makeSan(pos, move) : '';
}

/** Entries kept by sanOfCached; the memo is cleared when it is full. */
const SAN_CACHE_MAX = 5_000;
const sanCache = new Map<string, string>();

/**
 * sanOf, memoised by FEN and move (each call otherwise parses the FEN): for hot paths that ask for the
 * same moves again and again, such as the live text search over every mistake on each keystroke.
 */
export function sanOfCached(fen: string, uci: string): string {
  const key = `${fen}|${uci}`;
  let san = sanCache.get(key);
  if (san === undefined) {
    if (sanCache.size >= SAN_CACHE_MAX) sanCache.clear();
    san = sanOf(fen, uci);
    sanCache.set(key, san);
  }
  return san;
}

/** SAN of a line starting at `fen`; stops at the first illegal move. */
export function lineToSan(fen: string, ucis: readonly string[]): string[] {
  const pos = posFromFen(fen);
  if (!pos) return [];
  const out: string[] = [];
  for (const uci of ucis) {
    const move = parseStandardUci(pos, uci);
    if (!move) break;
    out.push(makeSan(pos, move));
    pos.play(move);
  }
  return out;
}

function parseLooseSan(pos: Position, san: string): Move | undefined {
  const clean = san
    .trim()
    .replace(/[!?]+$/, '')
    .replace(/^0-0-0(?=[+#]?$)/, 'O-O-O')
    .replace(/^0-0(?=[+#]?$)/, 'O-O');
  return parseSan(pos, clean);
}

/** SAN tokens from the standard start → standard UCI. Tolerates 0-0 and !? suffixes; truncates at the first illegal token. */
export function sansToUci(sans: readonly string[], maxPlies: number): string[] {
  const pos = Chess.default();
  const out: string[] = [];
  for (const san of sans) {
    if (out.length >= maxPlies) break;
    const move = parseLooseSan(pos, san);
    if (!move) break;
    out.push(toStandardUci(pos, move));
    pos.play(move);
  }
  return out;
}

/** Typed SAN (training input) → standard UCI, or undefined if not a legal move here. */
export function sanToUciAt(fen: string, san: string): string | undefined {
  const pos = posFromFen(fen);
  if (!pos) return undefined;
  const move = parseLooseSan(pos, san);
  return move ? toStandardUci(pos, move) : undefined;
}

/** "1. e4 e5 2. Nf3" — or "5... Nc6 6. O-O" when the line starts with Black to move. */
export function formatLine(sans: readonly string[], startFen: string = START_FEN): string {
  const parts = startFen.split(' ');
  let moveNo = Number(parts[5]) || 1;
  let white = parts[1] !== 'b';
  const out: string[] = [];
  sans.forEach((san, i) => {
    if (white) out.push(`${moveNo}. ${san}`);
    else out.push(i === 0 ? `${moveNo}... ${san}` : san);
    if (!white) moveNo++;
    white = !white;
  });
  return out.join(' ');
}

/** FEN after playing `uci` in `fen`, or undefined if illegal. */
export function playUci(fen: string, uci: string): string | undefined {
  const pos = posFromFen(fen);
  if (!pos) return undefined;
  const move = parseStandardUci(pos, uci);
  if (!move) return undefined;
  pos.play(move);
  return fenOf(pos);
}

export interface ReplayStep {
  ply: number;
  /** Position key BEFORE the move. */
  key: string;
  /** FEN BEFORE the move ('' unless requested). */
  fen: string;
  uci: string;
  turn: Color;
}

/** Steps before each move from the standard start, up to `maxPlies`. Stops at the first illegal move. */
export function replay(ucis: readonly string[], maxPlies: number, wantFen = false): ReplayStep[] {
  const pos = Chess.default();
  const steps: ReplayStep[] = [];
  const limit = Math.min(maxPlies, ucis.length);
  for (let ply = 0; ply < limit; ply++) {
    const uci = ucis[ply]!;
    const move = parseStandardUci(pos, uci);
    if (!move) break;
    steps.push({ ply, key: posKey(pos), fen: wantFen ? fenOf(pos) : '', uci, turn: pos.turn });
    pos.play(move);
  }
  return steps;
}

/** Destinations for chessground. Includes both castling encodings (king to g1 and onto the rook). */
export function groundDests(pos: Position): Map<SquareName, SquareName[]> {
  return chessgroundDests(pos);
}

export function needsPromotion(pos: Position, orig: SquareName, dest: SquareName): boolean {
  const from = parseSquare(orig);
  const to = parseSquare(dest);
  if (from === undefined || to === undefined) return false;
  return pos.board.getRole(from) === 'pawn' && (to >> 3 === 0 || to >> 3 === 7);
}

/** A chessground move (orig → dest, optional promotion role) → standard UCI, or undefined if illegal. */
export function moveFromGround(pos: Position, orig: SquareName, dest: SquareName, promotion?: Role): string | undefined {
  const promo = needsPromotion(pos, orig, dest) ? promotion ?? 'queen' : undefined;
  const uci = `${orig}${dest}${promo ? promoChar(promo) : ''}`;
  const move = parseStandardUci(pos, uci);
  return move ? toStandardUci(pos, move) : undefined;
}

function promoChar(role: Role): string {
  return role === 'knight' ? 'n' : role[0]!;
}

const VALUES: Partial<Record<Role, number>> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };

/** Material balance, White minus Black (pawn = 1, minor = 3, rook = 5, queen = 9). */
export function materialBalance(pos: Position): number {
  let total = 0;
  for (const [role, value] of Object.entries(VALUES) as [Role, number][]) {
    total += value * (pos.board.pieces('white', role).size() - pos.board.pieces('black', role).size());
  }
  return total;
}
