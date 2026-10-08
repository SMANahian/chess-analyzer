// Legal moves of a position as SAN + standard UCI (MoveInput's suggestions; keyboard move entry).
import { makeSan } from 'chessops/san';
import type { NormalMove, Role } from 'chessops/types';
import { normalizeUci, posFromFen, sanToUciAt, toStandardUci } from '../../core/chess';

export interface LegalMove {
  san: string;
  uci: string;
}

const PROMOTIONS: readonly Role[] = ['queen', 'knight', 'rook', 'bishop'];

/** Every legal move in `fen`, sorted by SAN; [] for an invalid FEN. Castling appears once (O-O / e1g1). */
export function legalMoves(fen: string): LegalMove[] {
  const pos = posFromFen(fen);
  if (!pos) return [];
  const byUci = new Map<string, LegalMove>();
  for (const [from, dests] of pos.allDests()) {
    const isPawn = pos.board.getRole(from) === 'pawn';
    for (const to of dests) {
      const lastRank = to >> 3 === 0 || to >> 3 === 7;
      const moves: NormalMove[] = isPawn && lastRank ? PROMOTIONS.map(promotion => ({ from, to, promotion })) : [{ from, to }];
      for (const move of moves) {
        const uci = toStandardUci(pos, move);
        if (!byUci.has(uci)) byUci.set(uci, { san: makeSan(pos, move), uci });
      }
    }
  }
  return [...byUci.values()].sort((a, b) => a.san.localeCompare(b.san));
}

/** Typed text → standard UCI: SAN ('Nf3', 'exd5', 'O-O', '0-0', 'e8=N'), with or without check marks, or UCI ('g1f3'). */
export function parseTypedMove(fen: string, text: string): string | undefined {
  const t = text.trim().replace(/^\d+\s*\.+\s*/, '').replace(/^…\s*/, '');
  if (!t) return undefined;
  const legal = new Set(legalMoves(fen).map(m => m.uci));
  // UCI, including king-takes-rook castling (e1h1 → e1g1).
  const uci = normalizeUci(fen, t.toLowerCase());
  if (uci && legal.has(uci)) return uci;
  // Lower-case piece letters ('nf3') are a common typo on phones; not 'b' (bishop vs b-file pawn).
  const fixed = /^[nrqk][a-h1-8x]/.test(t) ? t[0]!.toUpperCase() + t.slice(1) : t;
  for (const candidate of [t, fixed]) {
    // Re-checked against the legal list: chessops' SAN parser also accepts UCI-like input.
    const bySan = sanToUciAt(fen, candidate);
    if (bySan && legal.has(bySan)) return bySan;
  }
  return undefined;
}
