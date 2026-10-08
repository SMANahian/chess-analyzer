import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { START_FEN, playUci, posFromFen, posKey, sansToUci } from './chess';
import { impactOf } from './classify';
import { applyFilters, filterOccurrences, meanScore, openingsSummary } from './filters';
import { OpeningBook, type OpeningsJson } from './openings';
import { DEFAULT_FILTERS, type Color, type Mistake, type Occurrence, type StoredGame, type ViewFilters } from './types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);
const book = OpeningBook.fromJson(
  JSON.parse(readFileSync(new URL('../../public/data/openings.json', import.meta.url), 'utf8')) as OpeningsJson,
);
const fenAfter = (sans: string): string =>
  sans ? sansToUci(sans.split(' '), 40).reduce((fen, uci) => playUci(fen, uci)!, START_FEN) : START_FEN;

let seq = 0;
const occ = (m: string, daysAgo: number, extra: Partial<Occurrence> = {}): Occurrence => ({
  g: `g${++seq}`,
  t: NOW - daysAgo * DAY,
  s: 'blitz',
  r: true,
  o: 'loss',
  m,
  ...extra,
});

// The Two Knights: the habit is 4.Ng5 (f3g5), the best move 4.d3 (d2d3).
const TWO_KNIGHTS = fenAfter('e4 e5 Nf3 Nc6 Bc4 Nf6');
function mistake(overrides: Partial<Mistake> = {}): Mistake {
  const key = posKey(posFromFen(TWO_KNIGHTS)!);
  const id = overrides.id ?? `p1|${key}|f3g5`;
  return {
    id,
    shortId: id.slice(-10),
    profileId: 'p1',
    color: 'white',
    posKey: key,
    fen: TWO_KNIGHTS,
    ply: 6,
    path: sansToUci('e4 e5 Nf3 Nc6 Bc4 Nf6'.split(' '), 40),
    move: 'f3g5',
    kind: 'mistake',
    count: 3,
    positionCount: 4,
    occurrences: [occ('f3g5', 1), occ('d2d3', 2, { o: 'win' }), occ('f3g5', 3, { o: 'draw' }), occ('f3g5', 4)],
    bestMove: 'd2d3',
    acceptable: ['d2d3'],
    bestLine: ['d2d3'],
    playedLine: ['f3g5', 'd7d5'],
    scoreBest: { cp: 20 },
    scorePlayed: { cp: -120 },
    winLoss: 12.7,
    severity: 'mistake',
    confidence: 'normal',
    impact: 30,
    lastPlayedAt: NOW - DAY,
    lastOutcome: 'habit',
    fixedStreak: 0,
    openingEco: 'C57',
    openingName: 'Italian Game: Two Knights Defense, Knight Attack',
    evalDepth: 14,
    engine: 'sf19-lite@1',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const filters = (patch: Partial<ViewFilters> = {}): ViewFilters => ({ ...DEFAULT_FILTERS, showLowConfidence: true, showBook: true, ...patch });
const ids = (ms: readonly Mistake[]): string[] => ms.map(m => m.id);

describe('filterOccurrences', () => {
  const list = [
    occ('a', 1, { s: 'bullet' }),
    occ('a', 10, { s: 'blitz', r: false }),
    occ('a', 100, { s: 'rapid' }),
    occ('a', 1, { s: 'unknown', t: 0 }),
  ];
  it('filters by speed, rated and date', () => {
    expect(filterOccurrences(list, filters())).toEqual(list);
    expect(filterOccurrences(list, filters({ speeds: ['blitz', 'rapid'] }))).toEqual([list[1], list[2]]);
    expect(filterOccurrences(list, filters({ ratedOnly: true }))).toEqual([list[0], list[2], list[3]]);
    expect(filterOccurrences(list, filters({ since: NOW - 30 * DAY }))).toEqual([list[0], list[1]]);
  });
  it('treats an empty speed list as no speed filter', () => {
    expect(filterOccurrences(list, filters({ speeds: [] }))).toEqual(list);
  });
});

describe('meanScore', () => {
  it('averages known outcomes only', () => {
    expect(meanScore(['win', 'draw', 'loss', 'unknown'])).toBeCloseTo(0.5, 10);
    expect(meanScore(['win', 'win', 'draw'])).toBeCloseTo(5 / 6, 10);
    expect(meanScore(['unknown'])).toBeNull();
    expect(meanScore([])).toBeNull();
  });
});

describe('applyFilters: listing rules', () => {
  it('shows only active, non-dormant, non-snoozed mistakes', () => {
    const ms = [
      mistake({ id: 'active' }),
      mistake({ id: 'mastered', status: 'mastered' }),
      mistake({ id: 'ignored', status: 'ignored', ignoreReason: 'repertoire' }),
      mistake({ id: 'dormant', dormant: true }),
      mistake({ id: 'snoozed', snoozedUntil: NOW + 1 }),
      mistake({ id: 'snooze-over', snoozedUntil: NOW }),
    ];
    expect(ids(applyFilters(ms, filters(), NOW)).sort()).toEqual(['active', 'snooze-over']);
  });

  it('filters by colour, severity, confidence and book kind', () => {
    const ms = [
      mistake({ id: 'w-mistake' }),
      mistake({ id: 'b-blunder', color: 'black', severity: 'blunder' }),
      mistake({ id: 'w-inacc-low', severity: 'inaccuracy', confidence: 'low' }),
      mistake({ id: 'w-book', severity: 'inaccuracy', kind: 'book' }),
    ];
    expect(ids(applyFilters(ms, filters({ color: 'black' }), NOW))).toEqual(['b-blunder']);
    expect(ids(applyFilters(ms, filters({ minSeverity: 'mistake' }), NOW)).sort()).toEqual(['b-blunder', 'w-mistake']);
    expect(ids(applyFilters(ms, filters({ minSeverity: 'blunder' }), NOW))).toEqual(['b-blunder']);
    expect(ids(applyFilters(ms, filters({ showLowConfidence: false }), NOW))).not.toContain('w-inacc-low');
    expect(ids(applyFilters(ms, filters({ showBook: false }), NOW))).not.toContain('w-book');
    expect(ids(applyFilters(ms, { ...DEFAULT_FILTERS }, NOW)).sort()).toEqual(['b-blunder', 'w-mistake']);
  });

  it('matches an opening family by name prefix or an exact ECO code', () => {
    const ms = [
      mistake({ id: 'italian' }),
      mistake({ id: 'sicilian', openingName: 'Sicilian Defense: Najdorf Variation', openingEco: 'B90' }),
      mistake({ id: 'unnamed', openingName: undefined, openingEco: undefined }),
    ];
    expect(ids(applyFilters(ms, filters({ opening: 'Italian Game' }), NOW))).toEqual(['italian']);
    expect(ids(applyFilters(ms, filters({ opening: 'sicilian defense' }), NOW))).toEqual(['sicilian']);
    expect(ids(applyFilters(ms, filters({ opening: 'b90' }), NOW))).toEqual(['sicilian']);
    expect(ids(applyFilters(ms, filters({ opening: 'B9' }), NOW))).toEqual([]);
    expect(applyFilters(ms, filters({ opening: '' }), NOW)).toHaveLength(3);
  });

  it('searches SAN of the habit and best moves, UCI, opening name and ECO', () => {
    const other = { openingName: 'Ruy Lopez', openingEco: 'C60', move: 'a2a3', bestMove: 'b1c3' };
    const ms = [mistake({ id: 'italian' }), mistake({ id: 'other', ...other, occurrences: [occ('a2a3', 1), occ('a2a3', 2)] })];
    const q = (query: string): string[] => ids(applyFilters(ms, filters({ query }), NOW));
    expect(q('Ng5')).toEqual(['italian']);
    expect(q('ng5')).toEqual(['italian']);
    expect(q('4. Ng5')).toEqual(['italian']);
    expect(q('d3')).toEqual(['italian']);
    expect(q('Nc3')).toEqual(['other']);
    expect(q('f3g5')).toEqual(['italian']);
    expect(q('knight attack')).toEqual(['italian']);
    expect(q('C60')).toEqual(['other']);
    expect(q('Qh5')).toEqual([]);
    expect(q('  ')).toHaveLength(2);
  });
});

describe('applyFilters: live counts', () => {
  it('recomputes counts, impact and scores from the filtered occurrences', () => {
    const m = mistake({
      occurrences: [
        occ('f3g5', 1, { s: 'bullet', o: 'win' }),
        occ('d2d3', 2, { s: 'blitz', o: 'win' }),
        occ('f3g5', 3, { s: 'blitz', o: 'draw' }),
        occ('f3g5', 200, { s: 'blitz', o: 'loss' }),
        occ('f3g5', 5, { s: 'blitz', o: 'unknown' }),
      ],
    });
    const [all] = applyFilters([m], filters(), NOW);
    expect(all).toMatchObject({ viewCount: 4, viewPositionCount: 5, habitScore: 0.5, positionScore: 0.625 });
    expect(all!.viewImpact).toBeCloseTo(impactOf(m.occurrences, 'f3g5', 12.7, NOW), 10);

    const [blitz] = applyFilters([m], filters({ speeds: ['blitz'] }), NOW);
    expect(blitz).toMatchObject({ viewCount: 3, viewPositionCount: 4, habitScore: 0.25, positionScore: 0.5 });
    expect(blitz!.viewImpact).toBeLessThan(all!.viewImpact);
    // The stored record is untouched.
    expect(blitz!.count).toBe(3);
    expect(blitz!.occurrences).toBe(m.occurrences);
  });

  it('drops mistakes played in fewer than minGames filtered games', () => {
    const m = mistake({ occurrences: [occ('f3g5', 1, { s: 'bullet' }), occ('f3g5', 2), occ('f3g5', 3)] });
    expect(applyFilters([m], filters(), NOW)).toHaveLength(1);
    expect(applyFilters([m], filters({ minGames: 4 }), NOW)).toHaveLength(0);
    expect(applyFilters([m], filters({ speeds: ['bullet'] }), NOW)).toHaveLength(0);
    expect(applyFilters([m], filters({ speeds: ['bullet'], minGames: 1 }), NOW)).toHaveLength(1);
    expect(applyFilters([m], filters({ speeds: ['rapid'], minGames: 0 }), NOW)).toHaveLength(0);
  });

  it('treats invalid numeric filter values (a cleared input) as defaults instead of hiding everything', () => {
    const m = mistake();
    const all = applyFilters([m], filters(), NOW);
    expect(all).toHaveLength(1);
    expect(applyFilters([m], filters({ minGames: Number.NaN }), NOW)).toEqual(all);
    expect(applyFilters([m], filters({ since: Number.NaN }), NOW)).toEqual(all);
    expect(filterOccurrences(m.occurrences, filters({ since: Number.NaN }))).toEqual(m.occurrences);
    expect(applyFilters([m], filters({ minGames: Number.POSITIVE_INFINITY }), NOW)).toEqual([]);
  });

  it('gives null scores when no outcome is known', () => {
    const m = mistake({ occurrences: [occ('f3g5', 1, { o: 'unknown' }), occ('f3g5', 2, { o: 'unknown' })] });
    expect(applyFilters([m], filters(), NOW)[0]).toMatchObject({ habitScore: null, positionScore: null });
  });
});

describe('applyFilters: sorting', () => {
  // a: frequent but old; b: recent and big; c: small loss, played often recently; d/e: exact ties.
  const old = (n: number) => Array.from({ length: n }, () => occ('f3g5', 700));
  const recent = (n: number) => Array.from({ length: n }, () => occ('f3g5', 1));
  const ms = [
    mistake({ id: 'a', occurrences: old(6), winLoss: 20, lastPlayedAt: NOW - 700 * DAY }),
    mistake({ id: 'b', occurrences: recent(2), winLoss: 30, lastPlayedAt: NOW - DAY }),
    mistake({ id: 'c', occurrences: recent(4), winLoss: 8, lastPlayedAt: NOW - 2 * DAY }),
    mistake({ id: 'e', occurrences: recent(2), winLoss: 10, lastPlayedAt: NOW - 3 * DAY }),
    mistake({ id: 'd', occurrences: recent(2), winLoss: 10, lastPlayedAt: NOW - 3 * DAY }),
  ];
  const order = (sort: ViewFilters['sort']): string[] => ids(applyFilters(ms, filters({ sort }), NOW));

  it('sorts by impact (recency-weighted), frequency, loss or recency, with deterministic ties', () => {
    expect(order('impact')).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(order('frequency')).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(order('loss')).toEqual(['b', 'a', 'd', 'e', 'c']);
    expect(order('recent')).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(order('due')).toEqual(order('impact'));
    expect(ids(applyFilters([...ms].reverse(), filters({ sort: 'impact' }), NOW))).toEqual(order('impact'));
  });
});

describe('openingsSummary', () => {
  let n = 0;
  const g = (sans: string, color: Color, outcome: StoredGame['outcome'], moves?: string): StoredGame => ({
    key: `p|x:${++n}`,
    profileId: 'p',
    platform: 'pgn',
    sourceId: String(n),
    contentKey: String(n),
    playedAt: n,
    color,
    opponent: 'o',
    speed: 'blitz',
    rated: true,
    outcome,
    moves: moves ?? sansToUci(sans.split(' '), 40).join(' '),
  });

  it('groups games per colour by their deepest named position, most played first', () => {
    const games = [
      g('e4 e5 Nf3 Nc6 Bb5 a6 Ba4', 'white', 'win'), // C70 Ruy Lopez: Morphy Defense (Ba4 is not named)
      g('e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O', 'white', 'draw'), // C78, same name
      g('e4 e5 Nf3 Nc6 Bb5 a6 Ba4 h6', 'white', 'loss'), // leaves the book: still C70
      g('e4 e5 Nf3 Nc6 Bb5 a6 Ba4', 'black', 'loss'),
      g('d4 d5', 'white', 'unknown'),
      g('', 'white', 'win', ''),
      g('', 'white', 'win', 'e2e5 e7e5'),
    ];
    expect(openingsSummary(games, book, 20)).toEqual([
      { color: 'white', eco: 'C70', name: 'Ruy Lopez: Morphy Defense', games: 3, score: 0.5 },
      { color: 'white', eco: 'D00', name: "Queen's Pawn Game", games: 1, score: 0.5 },
      { color: 'black', eco: 'C70', name: 'Ruy Lopez: Morphy Defense', games: 1, score: 0 },
    ]);
  });

  it('finds positions re-entering the book by transposition', () => {
    // 1.Nf3 d5 2.d4 transposes to 1.d4 d5 2.Nf3: both games end in the same named position.
    const rows = openingsSummary([g('Nf3 d5 d4', 'white', 'win'), g('d4 d5 Nf3', 'white', 'win')], book, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.games).toBe(2);
  });

  it('only looks at the first openingPlies plies', () => {
    const games = [g('e4 e5 Nf3 Nc6 Bb5 a6 Ba4', 'white', 'win')];
    expect(openingsSummary(games, book, 1)[0]).toMatchObject({ name: "King's Pawn Game", eco: 'B00' });
    expect(openingsSummary(games, book, 0)).toEqual([]);
  });
});
