import { describe, expect, it } from 'vitest';
import { Chess, castlingSide } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import { kingCastlesTo, makeSquare, makeUci } from 'chessops/util';
import type { SquareName } from 'chessops/types';
import {
  START_FEN,
  formatLine,
  groundDests,
  isStandardStartFen,
  lineToSan,
  materialBalance,
  moveFromGround,
  needsPromotion,
  normalizeUci,
  parseStandardUci,
  playUci,
  posFromFen,
  posKey,
  replay,
  sanOf,
  sanToUciAt,
  sansToUci,
  toStandardUci,
} from './chess';
import { fnv1a64, shortId } from './hash';

const CASTLE = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
const after = (sans: string[]) => {
  const p = Chess.default();
  for (const s of sans) p.play(parseSan(p, s)!);
  return p;
};

describe('posFromFen', () => {
  it('parses valid FEN and rejects garbage', () => {
    expect(posFromFen(START_FEN)).toBeDefined();
    expect(posFromFen('nonsense')).toBeUndefined();
    expect(posFromFen('8/8/8/8/8/8/8/8 w - - 0 1')).toBeUndefined();
  });
});

describe('castling normalisation', () => {
  it('accepts both encodings and emits standard UCI', () => {
    expect(normalizeUci(CASTLE, 'e1h1')).toBe('e1g1');
    expect(normalizeUci(CASTLE, 'e1a1')).toBe('e1c1');
    expect(normalizeUci(CASTLE, 'e1g1')).toBe('e1g1');
    expect(normalizeUci(CASTLE.replace(' w ', ' b '), 'e8h8')).toBe('e8g8');
    expect(sanOf(CASTLE, 'e1g1')).toBe('O-O');
    expect(sanOf(CASTLE, 'e1h1')).toBe('O-O');
  });
  it('rejects the chessops phantom-castling quirk', () => {
    const pos = posFromFen(CASTLE)!;
    expect(parseStandardUci(pos, 'e1e2')).toBeUndefined();
    expect(parseStandardUci(pos, 'e1d2')).toBeUndefined();
    expect(normalizeUci('4k3/8/8/8/8/8/8/4K2R w - - 0 1', 'e1g1')).toBeUndefined();
  });
  it('maps chessground drops onto the rook to standard castling', () => {
    const pos = posFromFen(CASTLE)!;
    expect(moveFromGround(pos, 'e1', 'h1')).toBe('e1g1');
    expect(moveFromGround(pos, 'e1', 'g1')).toBe('e1g1');
    expect(groundDests(pos).get('e1')).toEqual(expect.arrayContaining(['g1', 'h1', 'c1', 'a1']));
  });
});

describe('UCI parsing (property test on random games)', () => {
  /** Every legal move in both accepted spellings → its standard UCI (chessops' king→rook castling included). */
  function legalUcis(pos: Chess): Map<string, string> {
    const out = new Map<string, string>();
    for (const [from, tos] of pos.allDests()) {
      for (const to of tos) {
        const side = castlingSide(pos, { from, to });
        const promotes = pos.board.getRole(from) === 'pawn' && (to >> 3 === 0 || to >> 3 === 7);
        if (side) {
          const standard = makeSquare(from) + makeSquare(kingCastlesTo(pos.turn, side));
          out.set(makeUci({ from, to }), standard).set(standard, standard);
        } else if (promotes) {
          for (const r of 'qrbn') out.set(makeUci({ from, to }) + r, makeUci({ from, to }) + r);
        } else {
          out.set(makeUci({ from, to }), makeUci({ from, to }));
        }
      }
    }
    return out;
  }

  it('accepts exactly the legal moves, from every own piece to every square', () => {
    let seed = 4242;
    const rand = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const wrong: string[] = [];
    for (let game = 0; game < 6; game++) {
      const pos = Chess.default();
      for (let ply = 0; ply < 50 && !pos.isEnd(); ply++) {
        const legal = legalUcis(pos);
        for (const from of pos.board[pos.turn]) {
          for (let to = 0; to < 64; to++) {
            for (const suffix of ['', 'q', 'n', 'k']) {
              const uci = makeSquare(from) + makeSquare(to) + suffix;
              const move = parseStandardUci(pos, uci);
              if ((move && toStandardUci(pos, move)) !== legal.get(uci)) wrong.push(`${posKey(pos)} ${uci}`);
            }
          }
        }
        for (const [orig, dests] of groundDests(pos)) {
          for (const dest of dests) {
            if (!legal.has(moveFromGround(pos, orig, dest as SquareName, 'knight') ?? '')) wrong.push(`${posKey(pos)} ground ${orig}${dest}`);
          }
        }
        // Castle whenever possible half of the time, so positions with castling rights get covered.
        const ucis = [...legal.values()];
        const castle = ucis.find(u => /^e[18][gc][18]$/.test(u) && pos.board.getRole(parseStandardUci(pos, u)!.from) === 'king');
        pos.play(parseStandardUci(pos, castle && rand(2) ? castle : ucis[rand(ucis.length)]!)!);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('promotion', () => {
  it('requires a promotion piece and honours the picker', () => {
    const fen = '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1';
    const pos = posFromFen(fen)!;
    expect(normalizeUci(fen, 'e7e8')).toBeUndefined();
    expect(normalizeUci(fen, 'e7e8q')).toBe('e7e8q');
    expect(needsPromotion(pos, 'e7', 'e8')).toBe(true);
    expect(moveFromGround(pos, 'e7', 'e8')).toBe('e7e8q');
    expect(moveFromGround(pos, 'e7', 'e8', 'knight')).toBe('e7e8n');
  });
});

describe('position keys', () => {
  it('only writes legal en-passant squares and merges transpositions', () => {
    expect(posKey(after(['e4']))).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    expect(posKey(after(['e4', 'a6', 'e5', 'f5']))).toBe('rnbqkbnr/1pppp1pp/p7/4Pp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6');
    expect(posKey(after(['e4', 'e5', 'Nf3', 'Nc6']))).toBe(posKey(after(['Nf3', 'Nc6', 'e4', 'e5'])));
    expect(posKey(posFromFen('8/8/8/8/k2Pp2Q/8/8/3K4 b - d3 0 1')!)).toBe('8/8/8/8/k2Pp2Q/8/8/3K4 b - -');
  });
});

describe('SAN helpers', () => {
  it('converts SAN lines to standard UCI tolerantly', () => {
    expect(sansToUci(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', '0-0'], 40)).toEqual([
      'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1',
    ]);
    expect(sansToUci(['e4', 'e5', 'Nf3!?', 'Qxx9', 'Nc6'], 40)).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(sansToUci(['e4', 'e5', 'Nf3'], 2)).toEqual(['e2e4', 'e7e5']);
  });
  it('renders lines', () => {
    expect(lineToSan(START_FEN, ['e2e4', 'e7e5', 'g1f3'])).toEqual(['e4', 'e5', 'Nf3']);
    expect(formatLine(['e4', 'e5', 'Nf3'])).toBe('1. e4 e5 2. Nf3');
    const fen = playUci(START_FEN, 'e2e4')!;
    expect(formatLine(['e5', 'Nf3', 'Nc6'], fen)).toBe('1... e5 2. Nf3 Nc6');
    expect(sanToUciAt(START_FEN, 'Nf3')).toBe('g1f3');
    expect(sanToUciAt(START_FEN, 'Nf6')).toBeUndefined();
  });
});

describe('replay', () => {
  it('returns the position before each move and stops at illegal moves', () => {
    const steps = replay(['e2e4', 'e7e5', 'g1f3', 'e2e4'], 40, true);
    expect(steps).toHaveLength(3);
    expect(steps[0]!.fen).toBe(START_FEN);
    expect(steps[1]!.turn).toBe('black');
    expect(replay(['e2e4', 'e7e5', 'g1f3'], 2)).toHaveLength(2);
  });
});

describe('isStandardStartFen', () => {
  it('accepts the start position in any spelling and rejects everything else', () => {
    expect(isStandardStartFen(START_FEN)).toBe(true);
    expect(isStandardStartFen(' rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR  w KQkq - 0 1 ')).toBe(true);
    expect(isStandardStartFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -')).toBe(true);
    expect(isStandardStartFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 0 1')).toBe(true);
    expect(isStandardStartFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1')).toBe(false);
    expect(isStandardStartFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1')).toBe(false);
    expect(isStandardStartFen('bqnbrkrn/pppppppp/8/8/8/8/PPPPPPPP/BQNBRKRN w KQkq - 0 1')).toBe(false);
    expect(isStandardStartFen('garbage')).toBe(false);
  });
});

describe('materialBalance', () => {
  it('counts White minus Black', () => {
    expect(materialBalance(Chess.default())).toBe(0);
    expect(materialBalance(posFromFen('4k3/8/8/8/8/8/8/3QK3 w - - 0 1')!)).toBe(9);
  });
});

describe('fnv1a64', () => {
  it('matches the reference vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
    expect(shortId('k', 'e2e4')).toHaveLength(10);
  });
});
