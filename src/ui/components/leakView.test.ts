import { describe, expect, it } from 'vitest';
import { START_FEN, playUci } from '../../core/chess';
import { DEFAULT_FILTERS, type Mistake, type Occurrence, type ViewFilters } from '../../core/types';
import {
  clearedFilters,
  filterChips,
  frequencyText,
  groupByParent,
  groupFamilies,
  lastMoveLabel,
  punishmentOf,
  punishmentText,
  standingText,
  habitLabel,
  headlineOf,
  headlineText,
  inOpening,
  lichessAnalysisUrl,
  lineMoves,
  lineText,
  monthsOfSince,
  openingFamily,
  openingOptions,
  outcomeBadge,
  parseLeakTab,
  scoreSplit,
  sinceForMonths,
  sinceNeedsReanchor,
  tabList,
  tabOf,
  toggleSpeed,
  viewOfMistake,
} from './leakView';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;

/** Two Knights: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.Ng5 d5 5.exd5 — Black to move; habit 5…Nxd5?, best 5…Na5. */
const PATH = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5'];
const FEN = PATH.reduce((fen, uci) => playUci(fen, uci)!, START_FEN);

const occ = (g: string, daysAgo: number, m: string, o: Occurrence['o'] = 'loss', s: Occurrence['s'] = 'blitz'): Occurrence => ({
  g,
  t: NOW - daysAgo * DAY,
  s,
  r: true,
  o,
  m,
});

function mistake(p: Partial<Mistake> = {}): Mistake {
  return {
    id: 'p|key|f6d5',
    shortId: 'abc0000001',
    profileId: 'p',
    color: 'black',
    posKey: 'key',
    fen: FEN,
    ply: 9,
    path: PATH,
    move: 'f6d5',
    kind: 'mistake',
    count: 3,
    positionCount: 4,
    occurrences: [occ('g1', 1, 'f6d5'), occ('g2', 20, 'c6a5', 'win'), occ('g3', 100, 'f6d5', 'draw', 'rapid'), occ('g4', 300, 'f6d5')],
    bestMove: 'c6a5',
    acceptable: ['c6a5'],
    bestLine: ['c6a5', 'c4b5', 'c7c6'],
    playedLine: ['f6d5', 'g5f7', 'e8f7', 'd1f3'],
    scoreBest: { cp: -20 },
    scorePlayed: { cp: -130 },
    winLoss: 10.4,
    severity: 'mistake',
    confidence: 'normal',
    impact: 5,
    lastPlayedAt: NOW - DAY,
    lastOutcome: 'habit',
    fixedStreak: 0,
    evalDepth: 14,
    engine: 'sf19-lite@1',
    status: 'active',
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
    openingEco: 'C57',
    openingName: 'Italian Game: Two Knights Defense, Fried Liver Attack',
    ...p,
  };
}

describe('tabs', () => {
  it('sorts mistakes into tabs; mastered and ignored win over a snooze; dormant active ones are hidden', () => {
    expect(tabOf(mistake(), NOW)).toBe('active');
    expect(tabOf(mistake({ snoozedUntil: NOW + DAY }), NOW)).toBe('snoozed');
    expect(tabOf(mistake({ snoozedUntil: NOW - 1 }), NOW)).toBe('active');
    expect(tabOf(mistake({ status: 'mastered', snoozedUntil: NOW + DAY }), NOW)).toBe('mastered');
    expect(tabOf(mistake({ status: 'ignored', dormant: true }), NOW)).toBe('ignored');
    expect(tabOf(mistake({ dormant: true }), NOW)).toBeNull();
  });
  it('orders snoozed by wake-up time and the others by last change', () => {
    const a = mistake({ id: 'a', snoozedUntil: NOW + 5 * DAY });
    const b = mistake({ id: 'b', snoozedUntil: NOW + 2 * DAY });
    expect(tabList([a, b], 'snoozed', NOW).map(m => m.id)).toEqual(['b', 'a']);
    const c = mistake({ id: 'c', status: 'mastered', updatedAt: NOW - 2 * DAY });
    const d = mistake({ id: 'd', status: 'mastered', updatedAt: NOW - DAY });
    expect(tabList([c, d, a], 'mastered', NOW).map(m => m.id)).toEqual(['d', 'c']);
  });
  it('parses the tab query, defaulting to active', () => {
    expect(parseLeakTab('snoozed')).toBe('snoozed');
    expect(parseLeakTab('nope')).toBe('active');
    expect(parseLeakTab(undefined)).toBe('active');
  });
});

describe('copy', () => {
  it('writes the habit with move number and glyph', () => {
    expect(habitLabel(mistake())).toBe('5…Nxd5?');
    expect(habitLabel(mistake({ severity: 'blunder' }))).toBe('5…Nxd5??');
  });
  it('builds the plain-words headline', () => {
    const h = headlineOf(mistake(), 7, 9);
    expect(headlineText(h)).toBe('You play 5…Nxd5 here 7 of 9 times. It costs about 10% winning chances (≈1.1 pawns). Better: 5…Na5.');
  });
  it('says "every time" when the habit is all you play, and "<1%" for tiny losses', () => {
    expect(frequencyText({ k: 3, n: 3 })).toBe('every time you get here (3 games)');
    expect(headlineOf(mistake({ winLoss: 0.3 }), 1, 2).lossPct).toBe('<1');
  });
  it('badges the last real-game outcome', () => {
    expect(outcomeBadge(mistake())).toEqual({ tone: 'warn', text: 'Still playing it' });
    expect(outcomeBadge(mistake({ lastOutcome: 'fixed', fixedStreak: 1 }))?.text).toBe('Fixed in your last game');
    expect(outcomeBadge(mistake({ lastOutcome: 'fixed', fixedStreak: 3 }))?.text).toBe('Fixed in your last 3 games');
    expect(outcomeBadge(mistake({ lastOutcome: 'unknown' }))).toBeNull();
  });
  it('links to the Lichess analysis board with underscores, from Black when asked', () => {
    expect(lichessAnalysisUrl('8/8/8/8/8/8/8/K6k w - - 0 1')).toBe('https://lichess.org/analysis/8/8/8/8/8/8/8/K6k_w_-_-_0_1');
    expect(lichessAnalysisUrl('8/8/8/8/8/8/8/K6k b - - 0 1', 'black')).toBe('https://lichess.org/analysis/8/8/8/8/8/8/8/K6k_b_-_-_0_1?color=black');
  });
});

describe('groupByParent', () => {
  const parent = mistake({ id: 'P', dependsOn: undefined });
  const child = mistake({ id: 'C', dependsOn: 'P' });
  const grandchild = mistake({ id: 'G', dependsOn: 'C' });
  const other = mistake({ id: 'O' });

  it('lists children right after their parent, indented', () => {
    const out = groupByParent([child, other, grandchild, parent], [parent, child, grandchild, other]);
    expect(out.map(e => [e.m.id, e.depth, e.parent?.id])).toEqual([
      ['O', 0, undefined],
      ['P', 0, undefined],
      ['C', 1, 'P'],
      ['G', 2, 'C'],
    ]);
  });
  it('keeps a row whose parent is filtered out at the top level, still naming the parent', () => {
    const out = groupByParent([child], [parent, child]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ depth: 0, parent: { id: 'P' } });
  });
  it('survives a dependency cycle', () => {
    const a = mistake({ id: 'A', dependsOn: 'B' });
    const b = mistake({ id: 'B', dependsOn: 'A' });
    expect(groupByParent([a, b], [a, b]).map(e => e.m.id).sort()).toEqual(['A', 'B']);
  });
});

describe('view numbers under filters', () => {
  const f = (p: Partial<ViewFilters>): ViewFilters => ({ ...DEFAULT_FILTERS, ...p });

  it('recomputes k of n and scores for any status', () => {
    const v = viewOfMistake(mistake({ status: 'mastered' }), f({}), NOW);
    expect([v.viewCount, v.viewPositionCount]).toEqual([3, 4]);
    expect(v.habitScore).toBeCloseTo(0.5 / 3);
    const rapid = viewOfMistake(mistake(), f({ speeds: ['rapid'] }), NOW);
    expect([rapid.viewCount, rapid.viewPositionCount]).toEqual([1, 1]);
  });
  it('splits your score between the habit and other moves', () => {
    const s = scoreSplit(mistake(), f({}));
    expect(s.habit).toEqual({ score: 0.5 / 3, games: 3 });
    expect(s.other).toEqual({ score: 1, games: 1 });
    expect(scoreSplit(mistake(), f({ since: NOW - 10 * DAY })).other).toEqual({ score: null, games: 0 });
  });
});

describe('date range', () => {
  it('maps months to a since timestamp and back', () => {
    expect(sinceForMonths(0, NOW)).toBe(0);
    expect(sinceForMonths(3, NOW)).toBe(Date.UTC(2026, 6, 8, 12));
    expect(monthsOfSince(0, NOW)).toBe(0);
    expect(monthsOfSince(sinceForMonths(6, NOW), NOW)).toBe(6);
    // A "last 3 months" chosen 20 days ago still reads as 3 months, and needs re-anchoring.
    const old = sinceForMonths(3, NOW - 20 * DAY);
    expect(monthsOfSince(old, NOW)).toBe(3);
    expect(sinceNeedsReanchor(old, NOW)).toBe(true);
    expect(sinceNeedsReanchor(sinceForMonths(12, NOW), NOW)).toBe(false);
  });
});

describe('filter summary', () => {
  const present = ['bullet', 'blitz', 'rapid'] as const;
  it('lists only non-default filters', () => {
    expect(filterChips(DEFAULT_FILTERS, present, NOW)).toEqual([]);
    const chips = filterChips(
      { ...DEFAULT_FILTERS, color: 'black', speeds: ['blitz', 'rapid'], ratedOnly: true, minGames: 3, minSeverity: 'blunder', showBook: true, opening: 'Sicilian Defense', since: sinceForMonths(6, NOW) },
      present,
      NOW,
    );
    expect(chips).toEqual(['Black only', 'Blitz, Rapid', 'Rated only', 'Last 6 months', 'In ≥ 3 games', 'Blunders only', 'Incl. book choices', 'Sicilian Defense']);
  });
  it('ignores excluded speeds that never occur', () => {
    expect(filterChips({ ...DEFAULT_FILTERS, speeds: ['bullet', 'blitz', 'rapid'] }, present, NOW)).toEqual([]);
  });
  it('clears everything except search and sort', () => {
    const cleared = clearedFilters({ ...DEFAULT_FILTERS, color: 'white', query: 'nxe4', sort: 'recent', speeds: ['blitz'] });
    expect(cleared).toEqual({ ...DEFAULT_FILTERS, query: 'nxe4', sort: 'recent' });
  });
  it('toggles speeds without ever emptying the list', () => {
    expect(toggleSpeed(DEFAULT_FILTERS.speeds, 'bullet', present)).not.toContain('bullet');
    expect(toggleSpeed(['blitz'], 'rapid', present)).toEqual(['blitz', 'rapid']);
    // Removing the last present speed brings all back.
    expect(toggleSpeed(['blitz', 'classical'], 'blitz', present)).toEqual(DEFAULT_FILTERS.speeds);
  });
});

describe('openings', () => {
  it('groups opening names into families, most leaks first', () => {
    expect(openingFamily('Sicilian Defense: Najdorf Variation')).toBe('Sicilian Defense');
    expect(openingFamily('Benko Gambit')).toBe('Benko Gambit');
    const ms = [
      mistake({ openingName: 'Sicilian Defense: Najdorf Variation' }),
      mistake({ openingName: 'Sicilian Defense' }),
      mistake({ openingName: 'Benko Gambit' }),
      mistake({ openingName: undefined }),
    ];
    expect(openingOptions(ms)).toEqual([
      { value: 'Sicilian Defense', count: 2 },
      { value: 'Benko Gambit', count: 1 },
    ]);
    expect(inOpening(ms[0]!, 'sicilian defense')).toBe(true);
    expect(inOpening(ms[3]!, 'Sicilian')).toBe(false);
  });
});

describe('lines', () => {
  it('numbers moves like a chess book, starting mid-move for Black', () => {
    const moves = lineMoves(FEN, ['f6d5', 'g5f7', 'e8f7']);
    expect(moves.map(m => `${m.prefix}${m.san}`)).toEqual(['5…Nxd5', '6.Nxf7', 'Kxf7']);
    expect(lineText(START_FEN, ['e2e4', 'e7e5', 'g1f3'])).toBe('1.e4 e5 2.Nf3');
  });
  it('stops at the first illegal move and honours maxPlies', () => {
    expect(lineMoves(FEN, ['f6d5', 'a1a8', 'e8f7'])).toHaveLength(1);
    expect(lineText(FEN, ['f6d5', 'g5f7', 'e8f7'], 2)).toBe('5…Nxd5 6.Nxf7');
  });
});

describe('punishment copy', () => {
  it('names the refutation and the material it wins', () => {
    const p = punishmentOf(mistake());
    expect(p.reply).toBe('6.Nxf7');
    expect(punishmentText('5…Nxd5', { reply: '6.Nxf7', why: 'loses a piece', standing: '' })).toBe('5…Nxd5 loses a piece after 6.Nxf7.');
  });
  it('falls back to the resulting standing when no material changes hands', () => {
    expect(punishmentText('5…Nxd5', { reply: '6.Nxf7', why: '', standing: 'you are clearly worse' })).toBe('After 6.Nxf7, you are clearly worse.');
    expect(punishmentText('5…Nxd5', { why: '', standing: 'the game is about equal' })).toBe('The game is about equal.');
  });
  it('words the standing from the player side', () => {
    expect(standingText({ cp: -250 })).toBe('you are clearly worse');
    expect(standingText({ cp: 10 })).toBe('the game is about equal');
    expect(standingText({ mate: -2 })).toBe('you get mated in 2');
    expect(standingText({ mate: 3 })).toBe('you can force mate in 3');
  });
  it('says when the player is still better, and what the best move keeps', () => {
    const p = { reply: '9.Nxe4', why: '', standing: 'you are clearly better', instead: { best: '8…Rb7', standing: 'you are winning' } };
    expect(punishmentText('8…Nxe4+', p)).toBe('After 9.Nxe4, you are still clearly better, but with 8…Rb7 you would be winning.');
    expect(punishmentText('8…Nxe4+', { ...p, standing: 'you are winning' })).toBe('After 9.Nxe4, you are still winning, but less clearly than with 8…Rb7.');
    // Black to move, so +300 (side to move) is good for Black: still better.
    expect(punishmentOf(mistake({ scorePlayed: { cp: 300 }, scoreBest: { cp: 700 } })).instead).toEqual({ best: '5…Na5', standing: 'you are winning' });
    expect(punishmentOf(mistake()).instead).toBeUndefined();
  });
  it('reads the standing from the mistake owner side (scores are side-to-move POV)', () => {
    expect(punishmentOf(mistake({ scorePlayed: { cp: -300 } })).standing).toBe('you are clearly worse');
    expect(punishmentOf(mistake({ playedLine: [] })).reply).toBeUndefined();
  });
  it('labels the last move of a path', () => {
    expect(lastMoveLabel(PATH)).toBe('5.exd5');
    expect(lastMoveLabel([])).toBeUndefined();
    expect(lastMoveLabel(['e2e4', 'e2e4'])).toBeUndefined();
  });
});

describe('groupFamilies', () => {
  it('groups variations under their family with summed games, weighted score and an ECO range', () => {
    const rows = [
      { color: 'white' as const, eco: 'C54', name: 'Italian Game: Giuoco Pianissimo', games: 30, score: 0.6 },
      { color: 'white' as const, eco: 'C50', name: 'Italian Game', games: 10, score: 0.2 },
      { color: 'white' as const, eco: 'B22', name: 'Sicilian Defense: Alapin Variation', games: 20, score: 0.5 },
    ];
    const fams = groupFamilies(rows);
    expect(fams.map(f => [f.name, f.games, f.eco])).toEqual([
      ['Italian Game', 40, 'C50–C54'],
      ['Sicilian Defense', 20, 'B22'],
    ]);
    expect(fams[0]!.score).toBeCloseTo(0.5);
    expect(fams[0]!.variations.map(v => v.games)).toEqual([30, 10]);
  });
});
