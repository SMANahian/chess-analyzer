import { describe, expect, it } from 'vitest';
import { START_FEN } from '../../core/chess';
import {
  describePawnDrop,
  evalWords,
  formatCountdown,
  formatEta,
  formatPercent,
  gameUrl,
  moveLabel,
  parseGameKey,
  plural,
  relativeTime,
  scoreFor,
  sideToMove,
} from './format';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 8, 12);

describe('plural / percent', () => {
  it('pluralises and groups thousands', () => {
    expect(plural(1, 'game')).toBe('1 game');
    expect(plural(0, 'game')).toBe('0 games');
    expect(plural(1234, 'leak')).toBe('1,234 leaks');
    expect(plural(2, 'match', 'matches')).toBe('2 matches');
  });
  it('rounds percentages', () => {
    expect(formatPercent(0.456)).toBe('46%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('relativeTime', () => {
  it('describes past and future times', () => {
    expect(relativeTime(undefined, NOW)).toBe('never');
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5 min ago');
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW)).toBe('3 h ago');
    expect(relativeTime(NOW - DAY - MIN, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 5 * DAY, NOW)).toBe('5 days ago');
    expect(relativeTime(NOW - 21 * DAY, NOW)).toBe('3 weeks ago');
    expect(relativeTime(NOW - 100 * DAY, NOW)).toBe('3 months ago');
    expect(relativeTime(NOW - 800 * DAY, NOW)).toBe('2 years ago');
    expect(relativeTime(NOW + 2 * DAY, NOW)).toBe('in 2 days');
  });
});

describe('formatEta / formatCountdown', () => {
  it('rounds to friendly units', () => {
    expect(formatEta(undefined)).toBeUndefined();
    expect(formatEta(Number.NaN)).toBeUndefined();
    expect(formatEta(10_000)).toBe('less than a minute');
    expect(formatEta(4 * MIN)).toBe('about 4 min');
    expect(formatEta(60 * MIN)).toBe('about 1 h');
    expect(formatEta(80 * MIN)).toBe('about 1 h 20 min');
  });
  it('counts down seconds', () => {
    expect(formatCountdown(44_100)).toBe('45 s');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(-5)).toBe('0 s');
  });
});

describe('moveLabel / sideToMove', () => {
  it('numbers White and Black moves like a chess player', () => {
    expect(moveLabel(START_FEN, 'e2e4')).toBe('1.e4');
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(moveLabel(afterE4, 'g8f6')).toBe('1…Nf6');
    expect(sideToMove(afterE4)).toBe('black');
  });
  it('falls back to the UCI string for an illegal move', () => {
    expect(moveLabel(START_FEN, 'e2e5')).toBe('e2e5');
  });
});

describe('evalWords / scoreFor', () => {
  it('turns scores into words', () => {
    expect(evalWords({ cp: 12 })).toBe('about equal');
    expect(evalWords({ cp: -60 })).toBe('slightly worse');
    expect(evalWords({ cp: 150 })).toBe('better');
    expect(evalWords({ cp: -300 })).toBe('clearly worse');
    expect(evalWords({ cp: 900 })).toBe('winning');
    expect(evalWords({ mate: 3 })).toBe('mate in 3');
    expect(evalWords({ mate: -2 })).toBe('gets mated in 2');
  });
  it('re-expresses side-to-move scores from the viewer side', () => {
    expect(scoreFor({ cp: 30 }, 'white', 'white')).toBe('+0.30');
    expect(scoreFor({ cp: 30 }, 'white', 'black')).toBe('−0.30');
  });
});

describe('game links', () => {
  it('parses game keys', () => {
    expect(parseGameKey('self-1|lichess:abcdEFGH')).toEqual({ platform: 'lichess', sourceId: 'abcdEFGH' });
    expect(parseGameKey('p|chesscom:live/123')).toEqual({ platform: 'chesscom', sourceId: 'live/123' });
    expect(parseGameKey('garbage')).toBeUndefined();
    expect(parseGameKey('p|elsewhere:1')).toBeUndefined();
  });
  it('links Lichess games at a ply, from the player side', () => {
    expect(gameUrl({ platform: 'lichess', sourceId: 'abcdEFGH' }, { ply: 12, color: 'black' })).toBe(
      'https://lichess.org/abcdEFGH/black#12',
    );
    expect(gameUrl({ platform: 'lichess', sourceId: 'abcdEFGH' })).toBe('https://lichess.org/abcdEFGH');
  });
  it('links Chess.com games and nothing for PGN imports', () => {
    expect(gameUrl({ platform: 'chesscom', sourceId: 'live/123' })).toBe('https://www.chess.com/game/live/123');
    expect(gameUrl({ platform: 'chesscom', sourceId: 'daily/9', url: 'https://www.chess.com/game/daily/9' })).toBe(
      'https://www.chess.com/game/daily/9',
    );
    expect(gameUrl({ platform: 'pgn', sourceId: '0123456789abcdef' })).toBeUndefined();
  });
});

describe('describePawnDrop', () => {
  it('is the engine’s drop between the best move and the move played', () => {
    expect(describePawnDrop({ cp: -225 }, { cp: -723 })).toBe('≈5.0 pawns');
    expect(describePawnDrop({ cp: 40 }, { cp: -60 })).toBe('≈1.0 pawn');
    expect(describePawnDrop({ cp: 455 }, { cp: -270 })).toBe('≈7.3 pawns');
  });
  it('reads ≥10 pawns for a mate in either score or a drop of ten pawns or more', () => {
    expect(describePawnDrop({ mate: 3 }, { cp: 200 })).toBe('≥10 pawns');
    expect(describePawnDrop({ cp: 100 }, { mate: -2 })).toBe('≥10 pawns');
    expect(describePawnDrop({ cp: 900 }, { cp: -1500 })).toBe('≥10 pawns');
  });
  it('clamps scores beyond ±10 pawns and never goes negative', () => {
    expect(describePawnDrop({ cp: 2500 }, { cp: 950 })).toBe('≈0.5 pawns');
    expect(describePawnDrop({ cp: -50 }, { cp: -30 })).toBe('≈0.0 pawns');
  });
});
