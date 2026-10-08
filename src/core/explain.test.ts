import { describe, expect, it } from 'vitest';
import { START_FEN, playUci, sanToUciAt, sansToUci } from './chess';
import { explainLine, materialSwing } from './explain';

const fenAfter = (sans: string): string => sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN);
/** SAN moves played from `fen` → standard UCI. */
function ucis(fen: string, sans: string): string[] {
  const out: string[] = [];
  let cur = fen;
  for (const san of sans.split(' ')) {
    const uci = sanToUciAt(cur, san)!;
    out.push(uci);
    cur = playUci(cur, uci)!;
  }
  return out;
}

describe('materialSwing', () => {
  // 1.e4 e5 2.Nf3 Bc5?? 3.Nxe5 Nc6 4.Nxc6 dxc6: Black is a pawn down after the knights are traded.
  const fen = fenAfter('e4 e5 Nf3');
  const line = ucis(fen, 'Bc5 Nxe5 Nc6 Nxc6 dxc6');

  it('measures the change for the side that plays the first move', () => {
    expect(materialSwing(fen, line)).toBe(-1);
    expect(materialSwing(fen, line.slice(0, 2))).toBe(-1);
    expect(materialSwing(fen, [])).toBe(0);
  });

  it('extends the horizon through a recapture instead of cutting an exchange in half', () => {
    // At 4 plies the knight on c6 has just been taken; dxc6 is played too.
    expect(materialSwing(fen, line, 4)).toBe(-1);
    // A quiet move past the horizon is not played.
    const quiet = ucis(fen, 'Bc5 Nxe5 Nc6 Nxc6 Qe7');
    expect(materialSwing(fen, quiet, 4)).toBe(-4);
  });

  it('stops at an illegal move and ignores invalid positions', () => {
    expect(materialSwing(fen, [line[0]!, line[1]!, 'a1a8', line[3]!])).toBe(-1);
    expect(materialSwing('not a fen', line)).toBe(0);
  });

  it('works for White to move', () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Ng5?? Qxg5
    const f = fenAfter('e4 e5 Nf3 Nc6');
    expect(materialSwing(f, ucis(f, 'Ng5 Qxg5 Nc3 Nf6'))).toBe(-3);
  });
});

describe('explainLine', () => {
  it('names mates against the mover from the line or from the score', () => {
    // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#
    const fen = fenAfter('e4 e5 Bc4 Nc6 Qh5');
    expect(explainLine(fen, ucis(fen, 'Nf6 Qxf7#'))).toBe('allows mate');
    expect(explainLine(fen, ucis(fen, 'g6'), { mate: -5 })).toBe('allows mate');
    expect(explainLine(fen, ucis(fen, 'g6'), { cp: -30 })).toBe('');
  });

  it('does not call it mate when the mover delivers it', () => {
    const fen = fenAfter('e4 e5 Bc4 Nc6 Qh5 Nf6');
    expect(explainLine(fen, ucis(fen, 'Qxf7#'), { mate: 1 })).toBe('');
  });

  it('describes pawn, piece, exchange, rook and queen losses', () => {
    const e4e5 = fenAfter('e4 e5 Nf3');
    expect(explainLine(e4e5, ucis(e4e5, 'Bc5 Nxe5 Nc6 Nxc6 dxc6'))).toBe('loses a pawn');
    const knights = fenAfter('e4 e5 Nf3 Nc6');
    expect(explainLine(knights, ucis(knights, 'Ng5 Qxg5 Nc3 Nf6'))).toBe('loses a piece');
    // The b4 pawn guards c3.
    expect(explainLine('6k1/8/8/8/1p6/2n5/8/2R3K1 w - - 0 1', ['c1c3', 'b4c3'])).toBe('loses the exchange');
    expect(explainLine('6k1/8/8/8/1p6/8/8/2R3K1 w - - 0 1', ['c1c3', 'b4c3'])).toBe('loses a rook');
    expect(explainLine('6k1/8/8/8/1p6/8/8/2Q3K1 w - - 0 1', ['c1c3', 'b4c3'])).toBe('loses the queen');
    expect(explainLine('4k3/8/8/8/8/8/1P1P3r/4K3 w - - 0 1', ['e1f1', 'h2d2', 'f1g1', 'd2b2'])).toBe('loses two pawns');
    // Queen for a protected rook: −4, no single piece name fits.
    expect(explainLine('6k1/8/2p5/3r4/8/8/8/3Q2K1 w - - 0 1', ['d1d5', 'c6d5'])).toBe('loses material');
  });

  it('does not call an uneven piece trade "loses a pawn"', () => {
    // 1.Nxc5 Bxc5 2.Ka2 Bxe3: White gives knight and bishop (6) for a rook (5).
    const twoForRook = 'k7/4b3/8/2r5/8/1N2B3/8/K7 w - - 0 1';
    const line = ['b3c5', 'e7c5', 'a1a2', 'c5e3'];
    expect(materialSwing(twoForRook, line)).toBe(-1);
    expect(explainLine(twoForRook, line)).toBe('loses material');
    // A plain pawn loss is still named.
    expect(explainLine('4k3/8/8/3p4/8/8/3Q4/4K3 w - - 0 1', ['d2d3', 'd5d4', 'd3d4'])).toBe('');
    expect(explainLine('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', ['e4e5', 'd5d4'])).toBe('');
    expect(explainLine('4k3/8/2b5/8/4P3/8/8/4K3 w - - 0 1', ['e4e5', 'c6e4'])).toBe('');
    expect(explainLine('4k3/8/8/2b5/4P3/8/8/4K3 w - - 0 1', ['e4e5', 'c5d4', 'e1e2', 'd4e5'])).toBe('loses a pawn');
  });

  it('does not say "loses the queen" when the opponent promotes', () => {
    // 1.Ke2?? b1=Q: White loses material (a new black queen) but not its own queen.
    expect(explainLine('4k3/8/8/8/8/8/1p6/4K3 w - - 0 1', ['e1e2', 'b2b1q'])).toBe('loses material');
    // Both: White's queen is taken after Black promotes.
    expect(explainLine('4k3/8/8/8/8/8/1p6/2Q1K3 w - - 0 1', ['c1c2', 'b2b1q', 'e1e2', 'b1c2'])).toBe('loses the queen');
  });

  it('says nothing for equal trades, gains, empty lines or invalid input', () => {
    const fen = fenAfter('e4 e5 Nf3 Nc6');
    expect(explainLine(fen, ucis(fen, 'Bb5 a6 Bxc6 dxc6'))).toBe('');
    expect(explainLine('6k1/8/8/8/8/2n5/8/2R3K1 w - - 0 1', ['c1c3'])).toBe('');
    expect(explainLine(fen, [])).toBe('');
    expect(explainLine('garbage', ['e2e4'])).toBe('');
  });
});
