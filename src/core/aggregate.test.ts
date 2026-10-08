import { describe, expect, it } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import type { NormalMove } from 'chessops/types';
import { Aggregator, aggregate, type Candidate } from './aggregate';
import { START_FEN, playUci, posFromFen, posKey, replay, sansToUci, toStandardUci } from './chess';
import type { Color, StoredGame } from './types';

let seq = 0;
/** A stored game from SAN moves (or raw UCI with `uci: true`). Each call gets a newer playedAt. */
function game(moves: string, opts: Partial<StoredGame> & { uci?: boolean } = {}): StoredGame {
  seq++;
  const { uci, ...rest } = opts;
  const stored = uci ? moves : sansToUci(moves.split(' '), 40).join(' ');
  return {
    key: `p|lichess:g${String(seq).padStart(5, '0')}`,
    profileId: 'p',
    platform: 'lichess',
    sourceId: `g${seq}`,
    contentKey: `c${seq}`,
    playedAt: 1_700_000_000_000 + seq * 1000,
    color: 'white',
    opponent: 'opp',
    speed: 'blitz',
    rated: true,
    outcome: 'win',
    moves: stored,
    ...rest,
  };
}

const keyAfter = (sans: string): string => posKey(posFromFen(fenAfter(sans))!);
const fenAfter = (sans: string): string =>
  sans ? sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN) : START_FEN;
const START_KEY = keyAfter('');
const byKey = (cs: Candidate[], key: string): Candidate | undefined => cs.find(c => c.key === key);

describe('aggregate: distinct-game counting', () => {
  it('counts a repetition inside one game once, keeping only the first visit as an occurrence', () => {
    const rep = game('Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 Ng1 Ng8 e4');
    const other = game('Nf3 d5');
    const start = byKey(aggregate([rep, other], { openingPlies: 20 }), START_KEY)!;
    expect(start.weight).toBe(2);
    expect(start.stat.games).toBe(2);
    expect(start.stat.moveGames.get('g1f3')).toBe(2);
    // The repeated game also played e4 on its third visit: a distinct (position, move) pair in that game.
    expect(start.stat.moveGames.get('e2e4')).toBe(1);
    expect(start.stat.occurrences.map(o => [o.g, o.m])).toEqual([
      [other.key, 'g1f3'],
      [rep.key, 'g1f3'],
    ]);
    expect(start.moves).toEqual(['g1f3', 'e2e4']);
    expect(start.recurring).toEqual(['g1f3']);
  });

  it('does not make a candidate out of a move repeated only within a single game', () => {
    const cs = aggregate([game('Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 Ng1 Ng8')], { openingPlies: 20 });
    expect(cs).toEqual([]);
  });

  it('merges transpositions into one position', () => {
    const a = game('e4 e5 Nf3 Nc6 Bb5');
    const b = game('Nf3 Nc6 e4 e5 Bb5');
    const key = keyAfter('e4 e5 Nf3 Nc6');
    const c = byKey(aggregate([a, b], { openingPlies: 20 }), key)!;
    expect(c.weight).toBe(2);
    expect(c.stat.moveGames.get('f1b5')).toBe(2);
    expect(c.ply).toBe(4);
    // Path of the most recent visit (b is newer).
    expect(c.stat.path).toEqual(['g1f3', 'b8c6', 'e2e4', 'e7e5']);
  });

  it('merges positions that differ only by an en-passant square with no legal capture', () => {
    const direct = game('e4 c5', { color: 'black' });
    const knightTrip = game('e4 Nf6 Nf3 Ng8 Ng1 c5', { color: 'black' });
    const c = byKey(aggregate([direct, knightTrip], { openingPlies: 20 }), keyAfter('e4'))!;
    expect(c.weight).toBe(2);
    expect(Object.fromEntries(c.stat.moveGames)).toEqual({ c7c5: 2, g8f6: 1 });
    expect(c.stat.occurrences.map(o => o.m)).toEqual(['g8f6', 'c7c5']);
  });

  it('keeps positions apart when only one of them allows an en-passant capture', () => {
    const withEp = [game('e4 a6 e5 f5 d4'), game('e4 a6 e5 f5 d4')];
    const withoutEp = [game('e3 a6 e4 f6 e5 f5 d4'), game('e3 a6 e4 f6 e5 f5 d4')];
    const epKey = keyAfter('e4 a6 e5 f5');
    const quietKey = keyAfter('e3 a6 e4 f6 e5 f5');
    expect(epKey).not.toBe(quietKey);
    const cs = aggregate([...withEp, ...withoutEp], { openingPlies: 20 });
    expect(byKey(cs, epKey)?.weight).toBe(2);
    expect(byKey(cs, quietKey)?.weight).toBe(2);
  });
});

describe('aggregate: colour, limits and bad data', () => {
  it('analyses only the profile’s own turns', () => {
    const games = [game('e4 c5 Nf3 d6', { color: 'black' }), game('e4 c5 Nf3 d6 d4', { color: 'black' })];
    const cs = aggregate(games, { openingPlies: 20 });
    expect(cs.map(c => c.key).sort()).toEqual([keyAfter('e4'), keyAfter('e4 c5 Nf3')].sort());
    for (const c of cs) {
      expect(c.color).toBe('black');
      expect(c.ply % 2).toBe(1);
      expect(c.fen.split(' ')[1]).toBe('b');
    }
    expect(byKey(cs, START_KEY)).toBeUndefined();
  });

  it('never mixes a white game and a black game with the same moves', () => {
    expect(aggregate([game('e4 e5 Nf3'), game('e4 e5 Nf3', { color: 'black' })], { openingPlies: 20 })).toEqual([]);
  });

  it('respects openingPlies', () => {
    const games = [game('e4 e5 Nf3 Nc6'), game('e4 e5 Nf3 Nc6')];
    expect(aggregate(games, { openingPlies: 2 }).map(c => c.key)).toEqual([START_KEY]);
    expect(aggregate(games, { openingPlies: 3 }).map(c => c.key).sort()).toEqual([START_KEY, keyAfter('e4 e5')].sort());
    expect(aggregate(games, { openingPlies: 0 })).toEqual([]);
  });

  it('stops replaying a game at an illegal stored move', () => {
    const bad = game('e2e4 e7e5 e2e4 b8c6 g1f3', { uci: true });
    const good = game('e2e4 e7e5 g1f3 b8c6 f1c4', { uci: true });
    const cs = aggregate([bad, good, game('e2e4 e7e5 e2e4', { uci: true })], { openingPlies: 20 });
    expect(cs.map(c => c.key)).toEqual([START_KEY]);
    expect(byKey(cs, START_KEY)!.weight).toBe(3);
  });

  it('rejects phantom castling and normalises king-takes-rook castling', () => {
    // e2 still holds a pawn, so chessops would read e1e2 as castling.
    const prefix = 'g1f3 g8f6 g2g3 g7g6 f1g2 f8g7';
    const phantom = [game(`${prefix} e1e2`, { uci: true }), game(`${prefix} e1e2`, { uci: true })];
    const castleKey = keyAfter('Nf3 Nf6 g3 g6 Bg2 Bg7');
    expect(byKey(aggregate(phantom, { openingPlies: 20 }), castleKey)).toBeUndefined();
    const rookStyle = [game(`${prefix} e1h1`, { uci: true }), game(`${prefix} e1g1`, { uci: true })];
    const c = byKey(aggregate(rookStyle, { openingPlies: 20 }), castleKey)!;
    expect([...c.stat.moveGames]).toEqual([['e1g1', 2]]);
    expect(c.stat.occurrences.map(o => o.m)).toEqual(['e1g1', 'e1g1']);
  });

  it('ignores games without moves', () => {
    expect(aggregate([game('', { uci: true }), game('', { uci: true })], { openingPlies: 20 })).toEqual([]);
  });
});

describe('aggregate: candidates', () => {
  it('lists every move played but only recurring ones as recurring, by games desc', () => {
    const games = [game('e4 e5'), game('e4 c5'), game('e4 e6'), game('d4 d5'), game('c4 e5'), game('c4 c5')];
    const start = byKey(aggregate(games, { openingPlies: 20 }), START_KEY)!;
    expect(start.moves).toEqual(['e2e4', 'c2c4', 'd2d4']);
    expect(start.recurring).toEqual(['e2e4', 'c2c4']);
    expect(aggregate(games, { openingPlies: 20, minGames: 3 })[0]!.recurring).toEqual(['e2e4']);
  });

  it('sorts by weight desc, then key', () => {
    const games = [
      game('e4 e5 Nf3 Nc6'),
      game('e4 e5 Nf3 Nc6'),
      game('e4 c5 Nf3 d6'),
      game('e4 c5 Nf3 d6'),
      game('e4 c5 Nc3'),
    ];
    const cs = aggregate(games, { openingPlies: 20 });
    expect(cs.map(c => c.weight)).toEqual([5, 3, 2]);
    expect(cs[0]!.key).toBe(START_KEY);
    expect(cs[1]!.key).toBe(keyAfter('e4 c5'));
    expect(cs[1]!.moves).toEqual(['g1f3', 'b1c3']);
    expect(cs[2]!.key).toBe(keyAfter('e4 e5'));

    const tie = aggregate([game('e4 e5 Nf3'), game('e4 e5 Nf3'), game('d4 d5 c4'), game('d4 d5 c4')], { openingPlies: 20 });
    const twos = tie.filter(c => c.weight === 2).map(c => c.key);
    expect(twos).toEqual([...twos].sort());
    expect(twos).toHaveLength(2);
  });

  it('records the most recent visit’s path, keys and FEN; occurrences newest first', () => {
    const old = game('e4 e5 Nf3 Nc6 Bc4', { playedAt: 1000, outcome: 'loss', speed: 'rapid', rated: false });
    const recent = game('Nf3 Nc6 e4 e5 Bb5', { playedAt: 5000 });
    const middle = game('e4 e5 Nf3 Nc6 Bc4', { playedAt: 3000, outcome: 'draw' });
    const c = byKey(aggregate([old, recent, middle], { openingPlies: 20 }), keyAfter('e4 e5 Nf3 Nc6'))!;
    expect(c.stat.occurrences).toEqual([
      { g: recent.key, t: 5000, s: 'blitz', r: true, o: 'win', m: 'f1b5' },
      { g: middle.key, t: 3000, s: 'blitz', r: true, o: 'draw', m: 'f1c4' },
      { g: old.key, t: 1000, s: 'rapid', r: false, o: 'loss', m: 'f1c4' },
    ]);
    expect(c.stat.path).toEqual(['g1f3', 'b8c6', 'e2e4', 'e7e5']);
    expect(c.stat.pathKeys).toEqual(['', 'Nf3', 'Nf3 Nc6', 'Nf3 Nc6 e4'].map(keyAfter));
    expect(c.fen).toBe(fenAfter('Nf3 Nc6 e4 e5'));
    expect(c.stat.fen).toBe(c.fen);
    expect(c.ply).toBe(c.stat.path.length);
    expect(c.recurring).toEqual(['f1c4']);
    expect(c.moves).toEqual(['f1c4', 'f1b5']);
  });

  it('breaks playedAt ties by game key, so the result does not depend on input order', () => {
    const a = game('e4 e5 Nf3', { playedAt: 7, key: 'p|x:a' });
    const b = game('e4 e5 Nf3', { playedAt: 7, key: 'p|x:b' });
    const forward = aggregate([a, b], { openingPlies: 20 });
    const backward = aggregate([b, a], { openingPlies: 20 });
    expect(backward).toEqual(forward);
    expect(forward[0]!.stat.occurrences.map(o => o.g)).toEqual(['p|x:b', 'p|x:a']);
  });

  it('gives the same result for chunked passes and reports games counted', () => {
    const games = [game('e4 e5 Nf3 Nc6'), game('e4 e5 Nf3 d6'), game('d4 d5'), game('e4 e5 Bc4'), game('d4 Nf6')];
    const agg = new Aggregator({ openingPlies: 20 });
    agg.count(games.slice(0, 2));
    agg.count(games.slice(2));
    agg.detail(games.slice(0, 3));
    agg.detail(games.slice(3));
    expect(agg.gamesCounted).toBe(5);
    expect(agg.candidates()).toEqual(aggregate(games, { openingPlies: 20 }));
    expect(() => agg.count(games)).toThrow(/after detail/);
  });
});

/** Deterministic pseudo-random games: a few fixed openings, then random legal moves. */
function syntheticGames(count: number, plies: number): StoredGame[] {
  let state = 12345;
  const rand = (n: number): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
  const openings = ['e4 e5 Nf3 Nc6 Bc4', 'e4 c5 Nf3 d6 d4', 'd4 d5 c4 e6 Nc3', 'e4 e6 d4 d5 e5', 'd4 Nf6 c4 g6'];
  const out: StoredGame[] = [];
  for (let i = 0; i < count; i++) {
    const pos = Chess.default();
    const ucis: string[] = [];
    const play = (move: NormalMove): void => {
      ucis.push(toStandardUci(pos, move));
      pos.play(move);
    };
    for (const san of openings[rand(openings.length)]!.split(' ')) play(parseSan(pos, san) as NormalMove);
    while (ucis.length < plies && !pos.isEnd()) {
      // Few distinct choices early on, so positions recur like in a real repertoire.
      const moves = [...pos.allDests()].flatMap(([from, tos]) => [...tos].map(to => ({ from, to })));
      play(moves[rand(Math.min(moves.length, 2 + (ucis.length >> 1)))]!);
    }
    out.push(game(ucis.join(' '), { uci: true, color: (i % 2 ? 'black' : 'white') as Color }));
  }
  return out;
}

/** Straightforward reference: posKey at every ply, string maps. */
function naiveAggregate(games: readonly StoredGame[], plies: number, minGames: number) {
  const byKey = new Map<string, { games: Set<string>; moves: Map<string, Set<string>>; first: Map<string, string> }>();
  for (const g of games) {
    for (const step of replay(g.moves.split(' '), plies)) {
      if (step.turn !== g.color) continue;
      const e = byKey.get(step.key) ?? { games: new Set(), moves: new Map(), first: new Map() };
      byKey.set(step.key, e);
      e.games.add(g.key);
      if (!e.first.has(g.key)) e.first.set(g.key, step.uci);
      const set = e.moves.get(step.uci) ?? new Set();
      e.moves.set(step.uci, set.add(g.key));
    }
  }
  return [...byKey]
    .filter(([, e]) => [...e.moves.values()].some(s => s.size >= minGames))
    .map(([key, e]) => ({
      key,
      weight: e.games.size,
      moveGames: Object.fromEntries([...e.moves].map(([m, s]) => [m, s.size])),
      firstMoves: Object.fromEntries(e.first),
    }))
    .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1));
}

describe('aggregate vs a naive reference', () => {
  it('agrees on random games with castling, captures and en passant', () => {
    const games = syntheticGames(400, 30);
    const fast = aggregate(games, { openingPlies: 30 }).map(c => ({
      key: c.key,
      weight: c.weight,
      moveGames: Object.fromEntries(c.stat.moveGames),
      firstMoves: Object.fromEntries(c.stat.occurrences.map(o => [o.g, o.m])),
    }));
    expect(fast.length).toBeGreaterThan(50);
    expect(fast).toEqual(naiveAggregate(games, 30, 2));
  });
});

/**
 * Lichess NDJSON (`moves` = SAN) → StoredGames for `hero`, repeated with new keys and older dates
 * until `count` games exist (the synthetic generator's games.ndjson has 3,000).
 */
function storedFromNdjson(text: string, hero: string, count: number): StoredGame[] {
  interface Json { id: string; createdAt: number; speed: StoredGame['speed']; rated: boolean; winner?: Color; moves: string;
    players: Record<Color, { user?: { id: string } }> }
  const base = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
  const out: StoredGame[] = [];
  for (let copy = 0; out.length < count; copy++) {
    for (const j of base) {
      if (out.length >= count) break;
      const color: Color = j.players.white.user?.id === hero ? 'white' : 'black';
      out.push(game(sansToUci(j.moves.split(' '), 40).join(' '), {
        uci: true,
        key: `p|lichess:${j.id}-${copy}`,
        playedAt: j.createdAt - copy * 365 * 86_400_000,
        color,
        speed: j.speed,
        rated: j.rated,
        outcome: !j.winner ? 'draw' : j.winner === color ? 'win' : 'loss',
      }));
    }
  }
  return out;
}

function timePasses(games: readonly StoredGame[], chunk: number): { count: number; detail: number; build: number; candidates: Candidate[] } {
  const t0 = performance.now();
  const agg = new Aggregator({ openingPlies: 20 });
  for (let i = 0; i < games.length; i += chunk) agg.count(games.slice(i, i + chunk));
  const t1 = performance.now();
  for (let i = 0; i < games.length; i += chunk) agg.detail(games.slice(i, i + chunk));
  const t2 = performance.now();
  const candidates = agg.candidates();
  const t3 = performance.now();
  return { count: t1 - t0, detail: t2 - t1, build: t3 - t2, candidates };
}

// AGGREGATE_BENCH_NDJSON=/path/to/games.ndjson npx vitest run src/core/aggregate.test.ts
describe.skipIf(!process.env.AGGREGATE_BENCH_NDJSON)('aggregate benchmark on synthetic Lichess games (AGGREGATE_BENCH_NDJSON)', () => {
  it('aggregates 10k realistic games × 20 plies quickly and agrees with the naive reference', async () => {
    const { readFileSync: read } = await import('node:fs');
    const games = storedFromNdjson(read(process.env.AGGREGATE_BENCH_NDJSON!, 'utf8'), process.env.AGGREGATE_BENCH_HERO ?? 'hero', 10_000);
    expect(games).toHaveLength(10_000);
    const runs = [timePasses(games, 500), timePasses(games, 500), timePasses(games, 500)];
    const best = runs.reduce((a, b) => (a.count + a.detail + a.build <= b.count + b.detail + b.build ? a : b));
    const total = best.count + best.detail + best.build;
    console.log(
      `aggregate 10k realistic × 20: count ${best.count.toFixed(0)} ms, detail ${best.detail.toFixed(0)} ms, ` +
        `candidates ${best.build.toFixed(0)} ms, total ${total.toFixed(0)} ms, ${best.candidates.length} candidates, ` +
        `${best.candidates.reduce((n, c) => n + c.stat.occurrences.length, 0)} occurrences`,
    );
    const fast = best.candidates.map(c => ({
      key: c.key,
      weight: c.weight,
      moveGames: Object.fromEntries(c.stat.moveGames),
      firstMoves: Object.fromEntries(c.stat.occurrences.map(o => [o.g, o.m])),
    }));
    expect(fast).toEqual(naiveAggregate(games, 20, 2));
    expect(total).toBeLessThan(3000);
  });
});

describe.skipIf(!process.env.AGGREGATE_BENCH)('aggregate benchmark (AGGREGATE_BENCH=1)', () => {
  it('handles 10k games × 20 plies quickly', () => {
    const games = syntheticGames(10_000, 20);
    const t0 = performance.now();
    const agg = new Aggregator({ openingPlies: 20 });
    for (let i = 0; i < games.length; i += 500) agg.count(games.slice(i, i + 500));
    const t1 = performance.now();
    for (let i = 0; i < games.length; i += 500) agg.detail(games.slice(i, i + 500));
    const t2 = performance.now();
    const cs = agg.candidates();
    const t3 = performance.now();
    console.log(
      `aggregate 10k×20: count ${(t1 - t0).toFixed(0)} ms, detail ${(t2 - t1).toFixed(0)} ms, ` +
        `candidates ${(t3 - t2).toFixed(0)} ms, total ${(t3 - t0).toFixed(0)} ms, ${cs.length} candidates`,
    );
    expect(cs.length).toBeGreaterThan(0);
    expect(t3 - t0).toBeLessThan(3000);
  });
});
