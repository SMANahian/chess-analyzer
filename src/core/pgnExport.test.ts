import { describe, expect, it } from 'vitest';
import { parsePgn, startingPosition, type ChildNode, type PgnNodeData } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from './chess';
import { mistakesToPgn } from './pgnExport';
import type { Mistake } from './types';

const NOW = Date.UTC(2026, 9, 8, 12);
const fenAfter = (sans: string): string => sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN);

function mistake(path: string, overrides: Partial<Mistake>): Mistake {
  const fen = fenAfter(path);
  const pos = posFromFen(fen)!;
  return {
    id: `p1|${posKey(pos)}|${overrides.move}`,
    shortId: 'abcdef0123',
    profileId: 'p1',
    color: pos.turn,
    posKey: posKey(pos),
    fen,
    ply: path.split(' ').length,
    path: sansToUci(path.split(' '), 40),
    move: '',
    kind: 'mistake',
    count: 7,
    positionCount: 9,
    occurrences: [],
    bestMove: '',
    acceptable: [],
    bestLine: [],
    playedLine: [],
    scoreBest: { cp: 30 },
    scorePlayed: { cp: -80 },
    winLoss: 12.4,
    severity: 'mistake',
    confidence: 'normal',
    impact: 10,
    lastPlayedAt: NOW,
    lastOutcome: 'habit',
    fixedStreak: 0,
    evalDepth: 14,
    engine: 'sf19-lite@1',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// Black keeps playing 2...Bc5?? 3.Nxe5 instead of 2...Nc6.
const blackHabit = mistake('e4 e5 Nf3', {
  move: 'f8c5',
  bestMove: 'b8c6',
  bestLine: ['b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3'],
  playedLine: ['f8c5', 'f3e5', 'b8c6', 'e5c6', 'd7c6'],
  openingEco: 'C40',
  openingName: "King's Knight Opening",
});
// White keeps playing 4.Ng5 in the Two Knights instead of 4.d3 (an inaccuracy here).
const whiteHabit = mistake('e4 e5 Nf3 Nc6 Bc4 Nf6', {
  move: 'f3g5',
  bestMove: 'd2d3',
  bestLine: ['d2d3', 'f8c5', 'c2c3'],
  playedLine: ['f3g5', 'd7d5', 'e4d5', 'c6a5'],
  severity: 'inaccuracy',
  winLoss: 6.2,
  count: 3,
  positionCount: 4,
});

/** SANs along a node's first-child chain. */
function chain(node: ChildNode<PgnNodeData> | undefined): string[] {
  const out: string[] = [];
  for (let n = node; n; n = n.children[0]) out.push(n.data.san);
  return out;
}

describe('mistakesToPgn', () => {
  const pgn = mistakesToPgn([blackHabit, whiteHabit], { profileName: 'Magnus "DrNykterstein" C.', now: NOW });
  const games = parsePgn(pgn);

  it('writes one game per mistake with the expected headers', () => {
    expect(games).toHaveLength(2);
    const h = games[0]!.headers;
    expect(h.get('Event')).toBe('Chess Analyzer: Magnus "DrNykterstein" C.');
    expect(h.get('Site')).toBe('');
    expect(h.get('Date')).toBe('2026.10.08');
    expect([h.get('White'), h.get('Black'), h.get('Result')]).toEqual(['?', '?', '*']);
    expect(h.get('SetUp')).toBe('1');
    expect(h.get('FEN')).toBe(blackHabit.fen);
    expect(h.get('Annotator')).toBe('Chess Analyzer');
    expect(h.get('ECO')).toBe('C40');
    expect(h.get('Opening')).toBe("King's Knight Opening");
    expect(games[1]!.headers.has('Opening')).toBe(false);
  });

  it('plays the best line (≤ 8 plies) as the mainline and the habit as a variation', () => {
    const [black, white] = games;
    expect(chain(black!.moves.children[0])).toEqual(['Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1']);
    const variation = black!.moves.children[1]!;
    expect(chain(variation)).toEqual(['Bc5', 'Nxe5', 'Nc6', 'Nxc6', 'dxc6']);
    expect(variation.data.nags).toEqual([2]);
    expect(variation.data.comments).toEqual(['Loses a pawn.']);
    expect(black!.comments).toEqual(['You played Bc5 in 7 of 9 games (−12% winning chances).']);

    expect(chain(white!.moves.children[0])).toEqual(['d3', 'Bc5', 'c3']);
    expect(white!.moves.children[1]!.data.nags).toEqual([6]);
    expect(white!.comments).toEqual(['You played Ng5 in 3 of 4 games (−6% winning chances).']);
  });

  it('round-trips through chessops: every move is legal from the FEN header', () => {
    for (const game of games) {
      const lines = [game.moves.children[0], game.moves.children[1]];
      for (const first of lines) {
        const pos = startingPosition(game.headers).unwrap();
        for (const san of chain(first)) {
          const move = parseSan(pos, san);
          expect(move, san).toBeDefined();
          pos.play(move!);
        }
      }
    }
  });

  it('numbers moves correctly for Black, including after the variation', () => {
    const flat = pgn.replace(/\s+/g, ' ');
    expect(flat).toContain('2... Nc6 (2... Bc5 $2 {Loses a pawn.} 3. Nxe5 Nc6 4. Nxc6 dxc6) 3. Bb5 a6');
    expect(flat).toContain('4. d3 (4. Ng5 $6 4... d5 5. exd5 Na5) 4... Bc5 5. c3 *');
  });

  it('marks book choices, strips braces from comments and wraps long movetext', () => {
    const book = mistake('e4 e5', {
      move: 'f2f4',
      bestMove: 'g1f3',
      bestLine: ['g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7'],
      playedLine: ['f2f4', 'e5f4', 'g1f3', 'g7g5', 'h2h4', 'g5g4', 'f3e5', 'g8f6'],
      kind: 'book',
      severity: 'inaccuracy',
      winLoss: 5.6,
      openingName: 'King}s {Pawn Game',
    });
    const text = mistakesToPgn([book], { profileName: 'me', now: NOW });
    expect(text).toContain('A dubious book line.');
    expect(text.split('\n').every(line => line.length <= 80)).toBe(true);
    const [game] = parsePgn(text);
    expect(game!.comments).toEqual(['You played f4 in 7 of 9 games (−6% winning chances). A dubious book line.']);
    expect(chain(game!.moves.children[1])).toEqual(['f4', 'exf4', 'Nf3', 'g5', 'h4', 'g4', 'Ne5', 'Nf6']);
  });

  it('survives lines that are not legal from the position', () => {
    const broken = { ...blackHabit, bestLine: ['a1a8'], playedLine: ['a1a8'] };
    const [game] = parsePgn(mistakesToPgn([broken], { profileName: 'me', now: NOW }));
    expect(game!.moves.children).toEqual([]);
    expect(game!.headers.get('Result')).toBe('*');
  });

  it('handles one-move lines and line breaks in the profile name', () => {
    const short = { ...whiteHabit, bestLine: ['d2d3'], playedLine: ['f3g5'] };
    const text = mistakesToPgn([short], { profileName: 'two\nlines', now: NOW });
    expect(text.replace(/\s+/g, ' ')).toContain('4. d3 (4. Ng5 $6) *');
    const [game] = parsePgn(text);
    expect(game!.headers.get('Event')).toBe('Chess Analyzer: two lines');
    expect(chain(game!.moves.children[0])).toEqual(['d3']);
    expect(chain(game!.moves.children[1])).toEqual(['Ng5']);
    expect(game!.moves.children[1]!.data.nags).toEqual([6]);
  });

  it('marks inaccuracies ?!, mistakes ? and blunders ??', () => {
    const nagOf = (severity: Mistake['severity']): number[] | undefined => {
      const [game] = parsePgn(mistakesToPgn([{ ...whiteHabit, severity }], { profileName: 'me', now: NOW }));
      return game!.moves.children[1]!.data.nags;
    };
    expect(nagOf('inaccuracy')).toEqual([6]);
    expect(nagOf('mistake')).toEqual([2]);
    expect(nagOf('blunder')).toEqual([4]);
  });

  it('returns an empty string for no mistakes', () => {
    expect(mistakesToPgn([], { profileName: 'me', now: NOW })).toBe('');
  });
});
