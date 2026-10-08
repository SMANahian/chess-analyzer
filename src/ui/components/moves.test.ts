import { describe, expect, it } from 'vitest';
import { START_FEN } from '../../core/chess';
import { legalMoves, parseTypedMove } from './moves';

const CASTLE_FEN = 'r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 8';
const PROMO_FEN = '8/4P1k1/8/8/8/8/6K1/8 w - - 0 1';

describe('legalMoves', () => {
  it('lists the 20 opening moves', () => {
    const moves = legalMoves(START_FEN);
    expect(moves).toHaveLength(20);
    expect(moves).toContainEqual({ san: 'Nf3', uci: 'g1f3' });
  });

  it('lists castling once, in standard UCI', () => {
    const castles = legalMoves(CASTLE_FEN).filter(m => m.san.startsWith('O-O'));
    expect(castles).toEqual([
      { san: 'O-O', uci: 'e1g1' },
      { san: 'O-O-O', uci: 'e1c1' },
    ]);
    expect(legalMoves(CASTLE_FEN).some(m => m.uci === 'e1h1' || m.uci === 'e1a1')).toBe(false);
  });

  it('offers every promotion piece', () => {
    const promos = legalMoves(PROMO_FEN).filter(m => m.uci.startsWith('e7e8'));
    expect(promos.map(m => m.uci).sort()).toEqual(['e7e8b', 'e7e8n', 'e7e8q', 'e7e8r']);
    expect(promos.map(m => m.san)).toContain('e8=N+');
  });

  it('returns [] for an invalid FEN', () => {
    expect(legalMoves('not a fen')).toEqual([]);
  });
});

describe('parseTypedMove', () => {
  it('accepts SAN, sloppy SAN and UCI', () => {
    expect(parseTypedMove(START_FEN, 'Nf3')).toBe('g1f3');
    expect(parseTypedMove(START_FEN, ' nf3 ')).toBe('g1f3');
    expect(parseTypedMove(START_FEN, 'e4!?')).toBe('e2e4');
    expect(parseTypedMove(START_FEN, '1. e4')).toBe('e2e4');
    expect(parseTypedMove(START_FEN, 'g1f3')).toBe('g1f3');
    expect(parseTypedMove(CASTLE_FEN, '0-0')).toBe('e1g1');
    expect(parseTypedMove(CASTLE_FEN, 'O-O-O')).toBe('e1c1');
    expect(parseTypedMove(PROMO_FEN, 'e8=N')).toBe('e7e8n');
  });

  it('rejects illegal and nonsense input, including the chessops king-onto-own-piece quirk', () => {
    expect(parseTypedMove(START_FEN, 'Nf6')).toBeUndefined();
    expect(parseTypedMove(START_FEN, '')).toBeUndefined();
    expect(parseTypedMove(START_FEN, 'hello')).toBeUndefined();
    // King onto its own queen: chessops alone would read this as castling.
    expect(parseTypedMove(CASTLE_FEN, 'e1d2')).toBeUndefined();
    expect(parseTypedMove(CASTLE_FEN, 'Kd2')).toBeUndefined();
  });

  it('reads king-takes-rook UCI as castling', () => {
    expect(parseTypedMove(CASTLE_FEN, 'e1h1')).toBe('e1g1');
  });

  it('does not read a lower-case b as a bishop', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/2P5/8/PP1PPPPP/RNBQKBNR w KQkq - 0 2';
    expect(parseTypedMove(fen, 'cxd5')).toBe('c4d5');
    expect(parseTypedMove('rnbqkbnr/pppp1ppp/8/4p3/1P6/8/P1PPPPPP/RNBQKBNR w KQkq - 0 2', 'b5')).toBe('b4b5');
  });
});
