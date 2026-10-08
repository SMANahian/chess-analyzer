// Pure checks of the live smoke summary logic (no browser, no network).
import { expect, test } from '@playwright/test';
import type { Mistake, Occurrence, Severity } from '../../src/core/types';
import { countMistakes, moveLabel, probeProblems, syncProblems, toMarkdown, topLeaks, type LiveSummary, type ProbeResult } from './report';

const NOW = Date.UTC(2026, 9, 8);
const DAY = 86_400_000;
// 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4, White to move: 4.Nxe5? (f3e5) vs 4.Nxd4 (f3d4).
const WHITE_FEN = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
// 1.e4, Black to move: 1...f6? (f7f6) vs 1...e5 (e7e5).
const BLACK_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function occurrences(habit: string, best: string, played: number, reached: number): Occurrence[] {
  return Array.from({ length: reached }, (_, i) => ({ g: `p|lichess:g${i}`, t: NOW - i * DAY, s: 'blitz', r: true, o: 'loss', m: i < played ? habit : best }));
}

function mistake(over: Partial<Mistake> & { move: string; bestMove: string; fen: string }, played = 3, reached = 4): Mistake {
  const severity: Severity = over.severity ?? 'blunder';
  return {
    id: `p|${over.fen}|${over.move}`,
    shortId: over.move,
    profileId: 'p',
    color: over.fen.split(' ')[1] === 'b' ? 'black' : 'white',
    posKey: over.fen,
    ply: 6,
    path: [],
    kind: 'mistake',
    count: played,
    positionCount: reached,
    occurrences: occurrences(over.move, over.bestMove, played, reached),
    acceptable: [over.bestMove],
    bestLine: [over.bestMove],
    playedLine: [over.move],
    scoreBest: { cp: 100 },
    scorePlayed: { cp: -60 },
    winLoss: 20,
    severity,
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
    openingEco: 'C50',
    openingName: 'Italian Game: Blackburne-Kostić Gambit',
    ...over,
  };
}

function probe(over: Partial<ProbeResult>): ProbeResult {
  return {
    name: 'Lichess user',
    url: 'https://lichess.org/api/user/x',
    status: 200,
    ok: true,
    readable: true,
    allowOrigin: '*',
    contentType: 'application/json',
    etagReadable: false,
    lastModifiedReadable: false,
    json: 'ok',
    items: 10,
    ms: 120,
    ...over,
  };
}

test.describe('probeProblems', () => {
  test('a readable 200 with JSON is fine', () => {
    expect(probeProblems([probe({})])).toEqual({ failures: [], warnings: [] });
  });

  test('a response the browser could not read is a CORS failure, with the allow-origin header', () => {
    const { failures } = probeProblems([probe({ readable: false, ok: false, status: 200, allowOrigin: null, error: 'TypeError: Failed to fetch' })]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Access-Control-Allow-Origin missing');
    expect(failures[0]).toContain('Failed to fetch');
  });

  test('no response at all is a network failure', () => {
    expect(probeProblems([probe({ readable: false, ok: false, status: null })]).failures[0]).toContain('network error');
  });

  test('rate limits and server errors only warn; unknown accounts and bad JSON fail', () => {
    const result = probeProblems([
      probe({ name: 'a', status: 429, ok: false }),
      probe({ name: 'b', status: 503, ok: false }),
      probe({ name: 'c', status: 404, ok: false }),
      probe({ name: 'd', json: 'invalid' }),
      probe({ name: 'e', status: 410, ok: false }),
    ]);
    expect(result.warnings.map(w => w.split(':')[0])).toEqual(['a', 'b']);
    expect(result.failures.map(f => f.split(':')[0])).toEqual(['c', 'd', 'e']);
  });
});

test('syncProblems: a rate limit warns, any other sync error fails', () => {
  const rows = [
    { platform: 'lichess', username: 'A', stored: 10, reachedStart: false, lastError: 'Lichess rate limit (HTTP 429); retry in 60 s' },
    { platform: 'chesscom', username: 'B', stored: 0, reachedStart: false, lastError: 'Failed to fetch' },
    { platform: 'chesscom', username: 'C', stored: 5, reachedStart: true, lastError: null },
  ];
  const { failures, warnings } = syncProblems(rows);
  expect(warnings).toHaveLength(1);
  expect(failures).toEqual(['Sync chesscom “B”: Failed to fetch']);
});

test('moveLabel numbers the move from the FEN and falls back to UCI', () => {
  expect(moveLabel(WHITE_FEN, 'f3e5')).toBe('4. Nxe5');
  expect(moveLabel(BLACK_FEN, 'f7f6')).toBe('1... f6');
  expect(moveLabel(WHITE_FEN, 'a1a8')).toBe('a1a8');
});

test.describe('topLeaks and countMistakes', () => {
  const big = mistake({ fen: WHITE_FEN, move: 'f3e5', bestMove: 'f3d4', winLoss: 25 }, 5, 6);
  const small = mistake({ fen: BLACK_FEN, move: 'f7f6', bestMove: 'e7e5', winLoss: 12, severity: 'mistake', openingEco: undefined, openingName: undefined }, 2, 9);
  const book = mistake({ fen: BLACK_FEN, move: 'g7g5', bestMove: 'e7e5', kind: 'book', severity: 'inaccuracy', winLoss: 8 });
  const low = mistake({ fen: BLACK_FEN, move: 'a7a5', bestMove: 'e7e5', confidence: 'low', severity: 'inaccuracy', winLoss: 6 });
  const once = mistake({ fen: BLACK_FEN, move: 'h7h5', bestMove: 'e7e5' }, 1, 3);
  const mastered = mistake({ fen: BLACK_FEN, move: 'b7b5', bestMove: 'e7e5', status: 'mastered' });
  const dormant = mistake({ fen: BLACK_FEN, move: 'g8h6', bestMove: 'e7e5', dormant: true });
  const all = [small, book, low, once, mastered, dormant, big];

  test('follow the default Leaks view: by impact, without book, low-confidence, rare or inactive rows', () => {
    const leaks = topLeaks(all, NOW);
    expect(leaks.map(l => l.move)).toEqual(['4. Nxe5', '1... f6']);
    expect(leaks[0]).toMatchObject({ rank: 1, best: '4. Nxd4', played: 5, reached: 6, loss: 25, severity: 'blunder', opening: 'C50 Italian Game: Blackburne-Kostić Gambit' });
    expect(leaks[1]).toMatchObject({ rank: 2, color: 'black', played: 2, reached: 9, opening: '' });
    expect(topLeaks(all, NOW, 1)).toHaveLength(1);
  });

  test('count active mistakes by severity, book and low confidence separately', () => {
    expect(countMistakes(all, NOW)).toEqual({
      stored: 7,
      bySeverity: { blunder: 2, mistake: 1, inaccuracy: 1 },
      book: 1,
      lowConfidence: 1,
      shownByDefault: 2,
    });
  });
});

test('toMarkdown renders the result, failures, probe table and leaks, escaping pipes', () => {
  const summary: LiveSummary = {
    result: 'failed',
    mode: 'live',
    generatedAt: '2026-10-08T00:00:00.000Z',
    commit: '0123456789abcdef',
    accounts: { lichess: 'SMA-Nahian', chesscom: null },
    gamesPerAccount: 300,
    settingsApplied: true,
    onboarding: 'form',
    failures: ['Chess.com archives: HTTP 404, no such account'],
    warnings: [],
    probes: [probe({ name: 'Lichess | user' })],
    games: { total: 3, byPlatform: { lichess: 3 }, byColor: { white: 2, black: 1 }, bySpeed: { blitz: 3 } },
    sync: [],
    mistakes: { stored: 1, bySeverity: { blunder: 1, mistake: 0, inaccuracy: 0 }, book: 0, lowConfidence: 0, shownByDefault: 1 },
    topLeaks: [{ rank: 1, move: '4. Nxe5', best: '4. Nxd4', color: 'white', opening: 'C50 Italian', played: 5, reached: 6, loss: 25, severity: 'blunder', confidence: 'normal', impact: 9.5 }],
    analysis: {
      complete: true,
      evalsCached: 40,
      engineSearches: 90,
      engineBusyMs: 12_345,
      enginePoolSize: 3,
      engineWorkersCreated: 3,
      hardwareConcurrency: 4,
      syncMs: 20_000,
      firstAnalysisMs: 15_000,
      firstResultsMs: 35_000,
      totalMs: 40_000,
    },
    pageErrors: [],
    consoleErrors: [],
    notices: [],
  };
  const md = toMarkdown(summary);
  expect(md).toContain('## Live smoke: Lichess `SMA-Nahian`');
  expect(md).not.toContain('Chess.com `');
  expect(md).toContain('**FAILED** · 300 games per account · onboarding: form');
  expect(md).toContain('- Chess.com archives: HTTP 404, no such account');
  expect(md).toContain('| Lichess \\| user | 200 | yes | * | ok | 10 | no | 120 |');
  expect(md).toContain('| 1 | 4. Nxe5 | 4. Nxd4 | C50 Italian | 5 of 6 | 25.0 | blunder |');
  expect(md).toContain('| yes | 3 | 4 | 90 | 40 | 12.3 s | 20.0 s | 15.0 s | 35.0 s | 40.0 s |');
  expect(toMarkdown({ ...summary, analysis: { ...summary.analysis!, firstAnalysisMs: null } })).toContain('| 20.0 s | – | 35.0 s |');
  expect(toMarkdown({ ...summary, mode: 'mock', topLeaks: [] })).toContain('MOCK');
});
