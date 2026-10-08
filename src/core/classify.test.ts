import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregate, type Candidate } from './aggregate';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from './chess';
import {
  acceptableMoves,
  bestOf,
  classifyCandidate,
  impactOf,
  lastOutcomeOf,
  linkDependencies,
  moveEval,
} from './classify';
import { shortId } from './hash';
import { OpeningBook, type OpeningsJson } from './openings';
import type { Color, LineEval, Mistake, Occurrence, PositionEval, Score, StoredGame } from './types';
import { winLoss } from './winrate';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);
const book = OpeningBook.fromJson(
  JSON.parse(readFileSync(new URL('../../public/data/openings.json', import.meta.url), 'utf8')) as OpeningsJson,
);

const fenAfter = (sans: string): string =>
  sans ? sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN) : START_FEN;
const keyOf = (fen: string): string => posKey(posFromFen(fen)!);

type LineSpec = Score | { score: Score; pv: string[] };
/** An eval whose MultiPV line is `bestMove`; every other entry is a searchmoves result. */
function evalOf(fen: string, bestMove: string, lines: Record<string, LineSpec>, depth = 14): PositionEval {
  const moves: Record<string, LineEval> = {};
  for (const [move, spec] of Object.entries(lines)) {
    const { score, pv } = 'score' in spec ? spec : { score: spec, pv: [move] };
    moves[move] = { move, score, pv, depth };
  }
  const key = keyOf(fen);
  return { key: `sf19-lite@1|${key}`, posKey: key, fen, engine: 'sf19-lite@1', depth, best: moves[bestMove]!, moves, updatedAt: NOW };
}

let seq = 0;
function game(sans: string, color: Color, daysAgo: number, extra: Partial<StoredGame> = {}): StoredGame {
  seq++;
  return {
    key: `p1|lichess:g${String(seq).padStart(4, '0')}`,
    profileId: 'p1',
    platform: 'lichess',
    sourceId: `g${seq}`,
    contentKey: `c${seq}`,
    playedAt: NOW - daysAgo * DAY,
    color,
    opponent: 'opp',
    speed: 'blitz',
    rated: true,
    outcome: 'loss',
    moves: sansToUci(sans.split(' '), 40).join(' '),
    ...extra,
  };
}

const candidateAt = (games: StoredGame[], sansBefore: string): Candidate =>
  aggregate(games, { openingPlies: 20 }).find(c => c.key === keyOf(fenAfter(sansBefore)))!;

const occ = (m: string, daysAgo: number, extra: Partial<Occurrence> = {}): Occurrence => ({
  g: `g-${m}-${daysAgo}`,
  t: NOW - daysAgo * DAY,
  s: 'blitz',
  r: true,
  o: 'loss',
  m,
  ...extra,
});

describe('moveEval / bestOf / acceptableMoves', () => {
  const fen = fenAfter('e4 e5 Nf3 Nc6');
  const ev = evalOf(fen, 'f1b5', {
    f1b5: { cp: 30 },
    f1c4: { cp: 45 }, // a searchmoves result beating the MultiPV line
    d2d4: { cp: 10 },
    b1c3: { cp: -20 },
    h2h4: { cp: -150 },
  });

  it('looks moves up, including the best line', () => {
    expect(moveEval(ev, 'd2d4')?.score).toEqual({ cp: 10 });
    expect(moveEval(ev, 'a2a3')).toBeUndefined();
    const { f1b5: _omit, ...withoutBest } = ev.moves;
    expect(moveEval({ ...ev, moves: withoutBest }, 'f1b5')).toBe(ev.best);
  });

  it('picks the highest-scoring evaluated move, mates first', () => {
    expect(bestOf(ev).move).toBe('f1c4');
    expect(bestOf({ ...ev, moves: { ...ev.moves, d2d4: { move: 'd2d4', score: { mate: 5 }, pv: ['d2d4'], depth: 14 } } }).move).toBe('d2d4');
    expect(bestOf({ ...ev, moves: {} })).toBe(ev.best);
  });

  it('accepts moves losing < 5 win-%, best first, never the excluded move', () => {
    expect(acceptableMoves(ev)).toEqual(['f1c4', 'f1b5', 'd2d4']);
    expect(acceptableMoves(ev, 'f1c4')).toEqual(['f1b5', 'd2d4']);
    // b1c3 loses ≈ 6 win-% against f1c4: not acceptable.
    expect(winLoss({ cp: 45 }, { cp: -20 })).toBeGreaterThan(5);
  });
});

describe('impactOf', () => {
  it('weights recent games more (half-life 180 days) and subtracts the 2.5 noise offset', () => {
    const recent = [occ('a', 0), occ('a', 0)];
    const old = [occ('a', 180), occ('a', 180)];
    expect(impactOf(recent, 'a', 12.5, NOW)).toBeCloseTo(20, 10);
    expect(impactOf(old, 'a', 12.5, NOW)).toBeCloseTo(10, 10);
    expect(impactOf([occ('a', 360)], 'a', 12.5, NOW)).toBeCloseTo(2.5, 10);
    expect(impactOf(recent, 'a', 2.5, NOW)).toBe(0);
  });

  it('counts only the given move, clamps future dates and treats undated games as one half-life old', () => {
    const mixed = [occ('a', 0), occ('b', 0), occ('a', -30), occ('a', 0, { t: 0 })];
    expect(impactOf(mixed, 'a', 12.5, NOW)).toBeCloseTo(10 + 10 + 5, 10);
    expect(impactOf([], 'a', 50, NOW)).toBe(0);
  });
});

describe('lastOutcomeOf', () => {
  const acceptable = ['g1f3', 'b1c3'];
  it('reports the most recent visit and the run of acceptable moves', () => {
    expect(lastOutcomeOf([occ('h2h4', 1), occ('g1f3', 2)], 'h2h4', acceptable)).toEqual({ lastOutcome: 'habit', fixedStreak: 0 });
    expect(lastOutcomeOf([occ('g1f3', 1), occ('b1c3', 2), occ('h2h4', 3), occ('g1f3', 4)], 'h2h4', acceptable)).toEqual({
      lastOutcome: 'fixed',
      fixedStreak: 2,
    });
    expect(lastOutcomeOf([], 'h2h4', acceptable)).toEqual({ lastOutcome: 'unknown', fixedStreak: 0 });
  });

  it('separates other evaluated bad moves from never-evaluated ones', () => {
    const evaluated = ['g1f3', 'b1c3', 'h2h4', 'a2a4'];
    expect(lastOutcomeOf([occ('a2a4', 1)], 'h2h4', acceptable, evaluated).lastOutcome).toBe('other-bad');
    expect(lastOutcomeOf([occ('g2g4', 1)], 'h2h4', acceptable, evaluated).lastOutcome).toBe('unknown');
    expect(lastOutcomeOf([occ('g2g4', 1)], 'h2h4', acceptable).lastOutcome).toBe('other-bad');
  });
});

describe('classifyCandidate', () => {
  // White keeps playing 4.Ng5 in the Two Knights; once 4.d3 (fixed), once 4.Bxf7+.
  const games = [
    game('e4 e5 Nf3 Nc6 Bc4 Nf6 d3', 'white', 1, { outcome: 'win' }),
    game('e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5', 'white', 10),
    game('e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5', 'white', 20, { outcome: 'draw' }),
    game('e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5', 'white', 200),
    game('e4 e5 Nf3 Nc6 Bc4 Nf6 Bxf7+', 'white', 30),
  ];
  const before = 'e4 e5 Nf3 Nc6 Bc4 Nf6';
  const fen = fenAfter(before);
  const c = candidateAt(games, before);
  const ev = evalOf(fen, 'd2d3', {
    d2d3: { score: { cp: 20 }, pv: ['d2d3', 'f8c5', 'e1g1'] },
    b1c3: { cp: 0 },
    f3g5: { score: { cp: -120 }, pv: ['f3g5', 'd7d5', 'e4d5', 'c6a5'] },
    c4f7: { cp: -350 },
  });

  it('builds a complete mistake record for a recurring losing move', () => {
    expect(c.recurring).toEqual(['f3g5']);
    const [m, ...rest] = classifyCandidate(c, ev, { profileId: 'p1', book, now: NOW });
    expect(rest).toEqual([]);
    const loss = winLoss({ cp: 20 }, { cp: -120 });
    expect(m).toMatchObject({
      id: `p1|${c.key}|f3g5`,
      shortId: shortId(c.key, 'f3g5'),
      profileId: 'p1',
      color: 'white',
      posKey: c.key,
      fen,
      ply: 6,
      path: sansToUci(before.split(' '), 40),
      move: 'f3g5',
      kind: 'mistake',
      count: 3,
      positionCount: 5,
      bestMove: 'd2d3',
      acceptable: ['d2d3', 'b1c3'],
      bestLine: ['d2d3', 'f8c5', 'e1g1'],
      playedLine: ['f3g5', 'd7d5', 'e4d5', 'c6a5'],
      scoreBest: { cp: 20 },
      scorePlayed: { cp: -120 },
      severity: 'mistake',
      confidence: 'normal',
      lastPlayedAt: NOW - 10 * DAY,
      lastOutcome: 'fixed',
      fixedStreak: 1,
      evalDepth: 14,
      engine: 'sf19-lite@1',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      openingEco: 'C55',
    });
    expect(m!.winLoss).toBeCloseTo(loss, 10);
    expect(m!.openingName).toMatch(/^Italian Game: Two Knights Defense/);
    expect(m!.occurrences).toBe(c.stat.occurrences);
    expect(m!.impact).toBeCloseTo(impactOf(c.stat.occurrences, 'f3g5', loss, NOW), 10);
    expect(m!.dependsOn).toBeUndefined();
  });

  it('skips moves that were not evaluated, lose too little, or are below minLoss', () => {
    const noMove = evalOf(fen, 'd2d3', { d2d3: { cp: 20 }, b1c3: { cp: 0 } });
    expect(classifyCandidate(c, noMove, { profileId: 'p1', now: NOW })).toEqual([]);
    const fine = evalOf(fen, 'd2d3', { d2d3: { cp: 20 }, f3g5: { cp: 0 } });
    expect(classifyCandidate(c, fine, { profileId: 'p1', now: NOW })).toEqual([]);
    expect(classifyCandidate(c, ev, { profileId: 'p1', now: NOW, minLoss: 40 })).toEqual([]);
  });

  it('honours a minLoss below the inaccuracy threshold (re-analysis hysteresis keeps losses ≥ 3)', () => {
    const small = evalOf(fen, 'd2d3', { d2d3: { cp: 20 }, f3g5: { cp: -10 } }); // ≈ 2.8
    const smallish = evalOf(fen, 'd2d3', { d2d3: { cp: 20 }, f3g5: { cp: -15 } }); // ≈ 3.2
    expect(winLoss({ cp: 20 }, { cp: -15 })).toBeGreaterThan(3);
    expect(winLoss({ cp: 20 }, { cp: -15 })).toBeLessThan(5);
    expect(classifyCandidate(c, smallish, { profileId: 'p1', now: NOW })).toEqual([]);
    expect(classifyCandidate(c, small, { profileId: 'p1', now: NOW, minLoss: 3 })).toEqual([]);
    const [kept] = classifyCandidate(c, smallish, { profileId: 'p1', now: NOW, minLoss: 3 });
    expect(kept).toMatchObject({ move: 'f3g5', severity: 'inaccuracy', confidence: 'low' });
  });

  it('marks 5–7.5 win-% losses as low confidence', () => {
    const at = (cp: number) => classifyCandidate(c, evalOf(fen, 'd2d3', { d2d3: { cp: 20 }, f3g5: { cp } }), { profileId: 'p1', now: NOW });
    const [low] = at(-40); // ≈ 5.5
    expect(low!.winLoss).toBeGreaterThanOrEqual(5);
    expect(low!.winLoss).toBeLessThan(7.5);
    expect(low).toMatchObject({ severity: 'inaccuracy', confidence: 'low' });
    const [normal] = at(-70); // ≈ 8.3
    expect(normal!.winLoss).toBeGreaterThanOrEqual(7.5);
    expect(normal).toMatchObject({ severity: 'inaccuracy', confidence: 'normal' });
  });

  it('applies the mate rule to severity', () => {
    const lostMate = evalOf(fen, 'd2d3', { d2d3: { mate: 3 }, f3g5: { cp: 750 } }); // loss ≈ 5.9
    const [m] = classifyCandidate(c, lostMate, { profileId: 'p1', now: NOW });
    expect(m).toMatchObject({ severity: 'mistake', scoreBest: { mate: 3 } });
    const allowsMate = evalOf(fen, 'd2d3', { d2d3: { cp: 50 }, f3g5: { mate: -2 } });
    expect(classifyCandidate(c, allowsMate, { profileId: 'p1', now: NOW })[0]?.severity).toBe('blunder');
  });

  it('uses a searchmoves result that beats the MultiPV line as the best move', () => {
    const better = evalOf(fen, 'd2d3', { d2d3: { cp: 20 }, b1c3: { score: { cp: 60 }, pv: ['b1c3', 'f8b4'] }, f3g5: { cp: -120 } });
    const [m] = classifyCandidate(c, better, { profileId: 'p1', now: NOW });
    expect(m).toMatchObject({ bestMove: 'b1c3', bestLine: ['b1c3', 'f8b4'], scoreBest: { cp: 60 } });
    expect(m!.winLoss).toBeCloseTo(winLoss({ cp: 60 }, { cp: -120 }), 10);
  });

  it('never trusts a PV that does not start with its move', () => {
    const broken = evalOf(fen, 'd2d3', { d2d3: { cp: 20 }, f3g5: { score: { cp: -120 }, pv: ['d7d5'] } });
    expect(classifyCandidate(c, broken, { profileId: 'p1', now: NOW })[0]!.playedLine).toEqual(['f3g5']);
  });
});

describe('book awareness', () => {
  // 1.e4 e5 2.f4 (King's Gambit) twice, against 2.Nf3 as best.
  const games = [game('e4 e5 f4 exf4', 'white', 5), game('e4 e5 f4 d5', 'white', 6)];
  const fen = fenAfter('e4 e5');
  const c = candidateAt(games, 'e4 e5');
  const evalWith = (cp: number) => evalOf(fen, 'g1f3', { g1f3: { cp: 30 }, f2f4: { cp } });

  it("treats a dubious named gambit losing < 10 as a book choice, named by the position before it", () => {
    const [m] = classifyCandidate(c, evalWith(-35), { profileId: 'p1', book, now: NOW });
    expect(m!.winLoss).toBeGreaterThan(5.5);
    expect(m!.winLoss).toBeLessThan(6.5);
    expect(m).toMatchObject({ kind: 'book', confidence: 'low', openingEco: 'C20', openingName: "King's Pawn Game" });
  });

  it('keeps it a mistake when it loses ≥ 10, or without a book', () => {
    expect(classifyCandidate(c, evalWith(-120), { profileId: 'p1', book, now: NOW })[0]!.kind).toBe('mistake');
    const [noBook] = classifyCandidate(c, evalWith(-35), { profileId: 'p1', now: NOW });
    expect(noBook!.kind).toBe('mistake');
    expect(noBook!.openingName).toBeUndefined();
  });
});

describe('linkDependencies', () => {
  /** A minimal mistake: `path` and `move` in SAN from the start. */
  function mk(profileId: string, pathSans: string, moveSan: string): Mistake {
    const path = pathSans ? sansToUci(pathSans.split(' '), 40) : [];
    const fen = fenAfter(pathSans);
    const key = keyOf(fen);
    const move = sansToUci([...(pathSans ? pathSans.split(' ') : []), moveSan], 40).at(-1)!;
    const color: Color = path.length % 2 === 0 ? 'white' : 'black';
    return { id: `${profileId}|${key}|${move}`, profileId, color, posKey: key, fen, path, ply: path.length, move } as Mistake;
  }

  it('never links to a mistake of the other colour (an opponent move on the path)', () => {
    // As Black the profile habitually plays 1.e4 f6?; as White it keeps playing 2.Qh5? after 1.e4 f6.
    const blackHabit = mk('p1', 'e4', 'f6');
    const whiteHabit = mk('p1', 'e4 f6', 'Qh5');
    const whiteParent = mk('p1', '', 'e4'); // not a real mistake, but on the path with the same colour
    linkDependencies([blackHabit, whiteHabit]);
    expect(whiteHabit.dependsOn).toBeUndefined();
    linkDependencies([blackHabit, whiteHabit, whiteParent]);
    expect(whiteHabit.dependsOn).toBe(whiteParent.id);
  });

  it('links a mistake to the nearest earlier mistake on its path', () => {
    const first = mk('p1', '', 'f3');
    const second = mk('p1', 'f3 e5', 'Kf2');
    const child = mk('p1', 'f3 e5 Kf2 d5', 'Ke3');
    const unrelated = mk('p1', 'e4 e5', 'Qh5');
    const ms = [child, unrelated, second, first];
    linkDependencies(ms);
    expect(first.dependsOn).toBeUndefined();
    expect(second.dependsOn).toBe(first.id);
    expect(child.dependsOn).toBe(second.id);
    expect(unrelated.dependsOn).toBeUndefined();
  });

  it('follows transpositions, ignores other profiles and never links to itself', () => {
    const parent = mk('p1', 'e4 e5 Nf3 Nc6', 'Ba6');
    const viaOtherOrder = mk('p1', 'Nf3 Nc6 e4 e5 Ba6 bxa6', 'd4');
    const otherProfile = mk('p2', 'e4 e5 Nf3 Nc6 Ba6 bxa6', 'd4');
    // Its own (position, move) appears earlier on its path: the start position, 1.Nf3.
    const repeating = mk('p1', 'Nf3 Nf6 Ng1 Ng8', 'Nf3');
    const ms = [parent, viaOtherOrder, otherProfile, repeating];
    linkDependencies(ms);
    expect(viaOtherOrder.dependsOn).toBe(parent.id);
    expect(otherProfile.dependsOn).toBeUndefined();
    expect(repeating.id).toBe(`p1|${keyOf(START_FEN)}|g1f3`);
    expect(repeating.dependsOn).toBeUndefined();
  });

  it('clears stale links when the parent is gone', () => {
    const parent = mk('p1', '', 'f3');
    const child = mk('p1', 'f3 e5', 'g4');
    linkDependencies([parent, child]);
    expect(child.dependsOn).toBe(parent.id);
    linkDependencies([child]);
    expect(child.dependsOn).toBeUndefined();
  });
});
