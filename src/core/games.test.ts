import { describe, expect, it } from 'vitest';
import { attribute, contentKey, gameKey, outcomeFor, toStoredGame } from './games';
import type { Account, Profile, RawGame } from './types';

const raw = (patch: Partial<RawGame> = {}): RawGame => ({
  platform: 'lichess',
  sourceId: 'AbCd1234',
  url: 'https://lichess.org/AbCd1234',
  playedAt: Date.UTC(2026, 8, 30, 19, 31, 2),
  white: 'SMA-Nahian',
  black: 'Opponent',
  whiteId: 'sma-nahian',
  blackId: 'opponent',
  whiteRating: 1500,
  blackRating: 1600,
  speed: 'blitz',
  rated: true,
  result: '1-0',
  moves: ['e2e4', 'e7e5', 'g1f3'],
  plyCount: 61,
  ...patch,
});

const profile = (patch: Partial<Profile> = {}): Profile => ({
  id: 'p1',
  name: 'me',
  kind: 'self',
  accounts: [],
  aliases: [],
  createdAt: 0,
  ...patch,
});

const lichess = (username: string): Account => ({ platform: 'lichess', username });
const chesscom = (username: string): Account => ({ platform: 'chesscom', username });

describe('contentKey', () => {
  it('lower-cases names and uses the UTC day', () => {
    expect(contentKey(raw())).toBe('sma-nahian|opponent|2026-09-30|e2e4 e7e5 g1f3');
    expect(contentKey(raw({ playedAt: Date.UTC(2026, 8, 30, 23, 59, 59) }))).toContain('|2026-09-30|');
    expect(contentKey(raw({ playedAt: Date.UTC(2026, 9, 1, 0, 0, 0) }))).toContain('|2026-10-01|');
  });

  it("uses '?' for an unknown date", () => {
    expect(contentKey(raw({ playedAt: 0 }))).toBe('sma-nahian|opponent|?|e2e4 e7e5 g1f3');
    expect(contentKey(raw({ playedAt: Number.NaN }))).toContain('|?|');
  });

  it('is equal for the same game from different sources', () => {
    const api = raw();
    const pgn = raw({ platform: 'pgn', sourceId: 'ffff', white: 'sma-NAHIAN', black: 'OPPONENT', whiteId: undefined, playedAt: api.playedAt + 3_600_000 });
    expect(contentKey(pgn)).toBe(contentKey(api));
  });
});

describe('outcomeFor', () => {
  it.each([
    ['1-0', 'white', 'win'],
    ['1-0', 'black', 'loss'],
    ['0-1', 'white', 'loss'],
    ['0-1', 'black', 'win'],
    ['1/2-1/2', 'white', 'draw'],
    ['1/2-1/2', 'black', 'draw'],
    ['*', 'white', 'unknown'],
  ] as const)('%s as %s → %s', (result, color, outcome) => {
    expect(outcomeFor(result, color)).toBe(outcome);
  });
});

describe('attribute: API games (queried account only)', () => {
  it('matches the account against user ids case-insensitively', () => {
    expect(attribute(raw(), profile(), lichess('SMA-Nahian'))).toEqual({ color: 'white' });
    expect(attribute(raw(), profile(), lichess('sma-nahian'))).toEqual({ color: 'white' });
    const asBlack = raw({ white: 'Opponent', whiteId: 'opponent', black: 'SMA-Nahian', blackId: 'sma-nahian' });
    expect(attribute(asBlack, profile(), lichess('SMA-NAHIAN'))).toEqual({ color: 'black' });
  });

  it('falls back to display names when ids are missing', () => {
    const noIds = raw({ whiteId: undefined, blackId: undefined, platform: 'chesscom' });
    expect(attribute(noIds, profile(), chesscom('sma-nahian'))).toEqual({ color: 'white' });
  });

  it('prefers ids over names', () => {
    // The black player's display name happens to equal the account, but the id says white.
    const odd = raw({ black: 'sma-nahian', blackId: 'someone-else' });
    expect(attribute(odd, profile(), lichess('SMA-Nahian'))).toEqual({ color: 'white' });
  });

  it('ignores aliases and the profile’s other accounts', () => {
    const p = profile({ aliases: ['opponent'], accounts: [lichess('SMA-Nahian'), chesscom('Opponent')] });
    expect(attribute(raw(), p, lichess('SMA-Nahian'))).toEqual({ color: 'white' });
    expect(attribute(raw({ white: 'x', whiteId: 'x' }), p, lichess('SMA-Nahian'))).toEqual({ color: null, reason: 'no-match' });
  });

  it('reports both-match and no-match', () => {
    const self = raw({ black: 'SMA-Nahian', blackId: 'sma-nahian' });
    expect(attribute(self, profile(), lichess('sma-nahian'))).toEqual({ color: null, reason: 'both-match' });
    expect(attribute(raw(), profile(), lichess('nobody'))).toEqual({ color: null, reason: 'no-match' });
    expect(attribute(raw(), profile(), lichess('  '))).toEqual({ color: null, reason: 'no-match' });
  });
});

describe('attribute: PGN games (aliases and all usernames)', () => {
  const pgnGame = (white: string, black: string): RawGame =>
    raw({ platform: 'pgn', sourceId: 'h', white, black, whiteId: undefined, blackId: undefined });

  it('matches aliases and every account username, case-insensitively', () => {
    const p = profile({ aliases: ['sma-nahian'], accounts: [chesscom('OtherName')] });
    expect(attribute(pgnGame('SMA-Nahian', 'x'), p)).toEqual({ color: 'white' });
    expect(attribute(pgnGame('x', 'SMA-NAHIAN'), p)).toEqual({ color: 'black' });
    expect(attribute(pgnGame('x', 'othername'), p)).toEqual({ color: 'black' });
    expect(attribute(pgnGame(' OtherName ', 'y'), p)).toEqual({ color: 'white' });
  });

  it('reports both-match and no-match', () => {
    const p = profile({ aliases: ['sma-nahian'], accounts: [lichess('Second')] });
    expect(attribute(pgnGame('SMA-Nahian', 'second'), p)).toEqual({ color: null, reason: 'both-match' });
    expect(attribute(pgnGame('a', 'b'), p)).toEqual({ color: null, reason: 'no-match' });
    expect(attribute(pgnGame('', '?'), profile({ aliases: [''] }))).toEqual({ color: null, reason: 'no-match' });
  });
});

describe('toStoredGame', () => {
  it('builds the stored record from the profile’s side', () => {
    expect(toStoredGame(raw(), 'p1', 'white')).toEqual({
      key: 'p1|lichess:AbCd1234',
      profileId: 'p1',
      platform: 'lichess',
      sourceId: 'AbCd1234',
      contentKey: 'sma-nahian|opponent|2026-09-30|e2e4 e7e5 g1f3',
      url: 'https://lichess.org/AbCd1234',
      playedAt: Date.UTC(2026, 8, 30, 19, 31, 2),
      color: 'white',
      opponent: 'Opponent',
      playerRating: 1500,
      opponentRating: 1600,
      speed: 'blitz',
      rated: true,
      outcome: 'win',
      moves: 'e2e4 e7e5 g1f3',
      plyCount: 61,
    });
    expect(toStoredGame(raw(), 'p1', 'black')).toMatchObject({ opponent: 'SMA-Nahian', playerRating: 1600, opponentRating: 1500, outcome: 'loss' });
  });

  it('omits unknown optional fields', () => {
    const g = toStoredGame(raw({ url: undefined, whiteRating: undefined, plyCount: undefined }), 'p1', 'white');
    expect(Object.keys(g)).not.toContain('url');
    expect(Object.keys(g)).not.toContain('playerRating');
    expect(Object.keys(g)).not.toContain('plyCount');
    expect(g.opponentRating).toBe(1600);
  });

  it('uses the same key as gameKey', () => {
    expect(gameKey('p9', { platform: 'chesscom', sourceId: 'live/1' })).toBe('p9|chesscom:live/1');
  });
});
