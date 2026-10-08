import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawGame } from '../core/types';
import { lichessCooldownUntil, setLichessCooldown } from './http';
import { fetchLichessGames, lichessGamesUrl, lichessJsonToRaw, lichessUser, type LichessGameItem, type LichessPage } from './lichess';
import { chunkBytes, fixture, fixtureJson, jsonResponse, scriptedFetch, streamResponse, testBody } from './__fixtures__/testing';

const NDJSON = fixture('lichess-games.ndjson');
const LINES = NDJSON.split('\n')
  .filter(line => line !== '')
  .map(line => JSON.parse(line) as Record<string, unknown>);
const byId = (id: string): Record<string, unknown> => LINES.find(g => g.id === id)!;
const SKIPPED_IDS = ['vAr1ant9', 'abRt0001', 'thEm4tic', 'n0St4rt1'];
const PAGE: LichessPage = { sort: 'dateDesc', max: 300 };

const ITALIAN = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6 e1g1 e8g8 f1e1 a7a6 c4b3 c5a7 h2h3 h7h6 b1d2 f8e8 d2f1 c8e6 b3c2 d6d5 e4d5 e6d5 f1g3 d8d6 c1e3 a7e3 e1e3 a8d8 d1e2 f6d7 a1d1 f7f6 a2a3 d7f8 g3f5 d6e6'.split(' ');

async function collect(gen: AsyncIterable<LichessGameItem>): Promise<LichessGameItem[]> {
  const out: LichessGameItem[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

beforeEach(() => setLichessCooldown(0));
afterEach(() => setLichessCooldown(0));

describe('lichessGamesUrl', () => {
  it('requests all standard speeds with moves and tags, nothing else', () => {
    const url = new URL(lichessGamesUrl('SMA-Nahian', { since: 1727000000000.6, max: 300, sort: 'dateAsc' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://lichess.org/api/games/user/SMA-Nahian');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      max: '300',
      since: '1727000000000',
      sort: 'dateAsc',
      moves: 'true',
      tags: 'true',
      clocks: 'false',
      evals: 'false',
      opening: 'false',
      perfType: 'ultraBullet,bullet,blitz,rapid,classical,correspondence',
    });
    const backfill = new URL(lichessGamesUrl('x', { until: 1727000000000, sort: 'dateDesc' }));
    expect(backfill.searchParams.get('until')).toBe('1727000000000');
    expect(backfill.searchParams.has('max')).toBe(false);
    expect(backfill.searchParams.has('since')).toBe(false);
  });

  it('encodes the username', () => {
    expect(lichessGamesUrl('we ird/name?', { sort: 'dateDesc' })).toMatch(/^https:\/\/lichess\.org\/api\/games\/user\/we%20ird%2Fname%3F\?/);
  });
});

describe('lichessJsonToRaw', () => {
  it('converts a game: names, lower-case ids, ratings, first 40 plies as standard UCI, total plies', () => {
    expect(lichessJsonToRaw(byId('Xk3jP9qa'))).toEqual<RawGame>({
      platform: 'lichess',
      sourceId: 'Xk3jP9qa',
      url: 'https://lichess.org/Xk3jP9qa',
      playedAt: Date.UTC(2024, 9, 1, 18, 31, 12, 123),
      white: 'SMA-Nahian',
      black: 'KnightRider77',
      whiteId: 'sma-nahian',
      blackId: 'knightrider77',
      whiteRating: 1612,
      blackRating: 1588,
      speed: 'blitz',
      rated: true,
      result: '1-0',
      moves: ITALIAN,
      plyCount: 52,
    });
  });

  it('reads draws (no winner) and decisive results for Black', () => {
    expect(lichessJsonToRaw(byId('bR7tNw2e'))).toMatchObject({ result: '1/2-1/2', white: 'Magnus_Fan_2001', whiteId: 'magnus_fan_2001', black: 'SMA-Nahian', blackId: 'sma-nahian', speed: 'rapid', plyCount: 36 });
    expect(lichessJsonToRaw(byId('bErL1nDr'))).toMatchObject({ result: '1/2-1/2' });
    expect(lichessJsonToRaw(byId('enP4ss4n'))).toMatchObject({ result: '0-1', speed: 'bullet' });
  });

  it('names Lichess AI and anonymous players, without ids or ratings', () => {
    expect(lichessJsonToRaw(byId('aiG4me0x'))).toEqual<RawGame>({
      platform: 'lichess',
      sourceId: 'aiG4me0x',
      url: 'https://lichess.org/aiG4me0x',
      playedAt: Date.UTC(2024, 8, 28, 9, 12, 3, 4),
      white: 'SMA-Nahian',
      black: 'Stockfish level 4',
      whiteId: 'sma-nahian',
      speed: 'blitz',
      rated: false,
      result: '1-0',
      moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'],
      plyCount: 7,
    });
    const anon = lichessJsonToRaw(byId('an0nym0u'))!;
    expect(anon).toMatchObject({ white: 'Anonymous', black: 'SMA-Nahian', blackId: 'sma-nahian', result: '0-1', rated: false });
    expect(anon.whiteId).toBeUndefined();
  });

  it('converts castling, en passant and promotion to standard UCI', () => {
    expect(lichessJsonToRaw(byId('pR0moT3d'))!.moves).toEqual(['e2e4', 'd7d5', 'e4d5', 'c7c6', 'd5c6', 'g8f6', 'c6b7', 'b8d7', 'b7a8q']);
    expect(lichessJsonToRaw(byId('enP4ss4n'))!.moves.slice(0, 6)).toEqual(['e2e4', 'g8f6', 'e4e5', 'd7d5', 'e5d6', 'e7d6']);
    const corr = lichessJsonToRaw(byId('c0rR3sp0'))!;
    expect(corr).toMatchObject({ speed: 'correspondence', rated: false, result: '0-1', plyCount: 42 });
    expect(corr.moves).toHaveLength(40);
    expect(corr.moves[17]).toBe('e8g8');
    expect(corr.moves[18]).toBe('e1c1');
    expect(lichessJsonToRaw(byId('uLtr4bUl'))).toMatchObject({ speed: 'ultraBullet', result: '1-0' });
    expect(lichessJsonToRaw(byId('cL4ss1cL'))).toMatchObject({ speed: 'classical', white: 'Club_Coach', whiteId: 'club_coach', whiteRating: 2105 });
  });

  it('skips variants, thematic starts, aborted and unstarted games', () => {
    for (const id of SKIPPED_IDS) expect(lichessJsonToRaw(byId(id)), id).toBeNull();
    const kept = LINES.filter(g => !SKIPPED_IDS.includes(g.id as string));
    expect(kept.map(g => lichessJsonToRaw(g)).every(raw => raw !== null)).toBe(true);
  });

  it('maps statuses without a winner', () => {
    const game = (patch: Record<string, unknown>): RawGame | null =>
      lichessJsonToRaw({ id: 'AbCd1234', variant: 'standard', createdAt: 1, moves: 'e4 e5', players: {}, ...patch });
    expect(game({ status: 'outoftime' })!.result).toBe('1/2-1/2');
    expect(game({ status: 'stalemate' })!.result).toBe('1/2-1/2');
    expect(game({ status: 'timeout' })!.result).toBe('1/2-1/2');
    expect(game({ status: 'started' })!.result).toBe('*');
    expect(game({ status: 'unknownFinish' })!.result).toBe('*');
    expect(game({ status: 'mate', winner: 'black' })!.result).toBe('0-1');
    expect(game({ status: 'created' })).toBeNull();
  });

  it('is tolerant of odd input', () => {
    const base = { id: 'AbCd1234', createdAt: 5, moves: 'e4 e5' };
    expect(lichessJsonToRaw(null)).toBeNull();
    expect(lichessJsonToRaw('e4 e5')).toBeNull();
    expect(lichessJsonToRaw({ ...base, id: '' })).toBeNull();
    expect(lichessJsonToRaw({ ...base, moves: '' })).toBeNull();
    expect(lichessJsonToRaw({ ...base, moves: undefined })).toBeNull();
    expect(lichessJsonToRaw({ ...base, moves: 'e5 e4' })).toBeNull();
    expect(lichessJsonToRaw({ ...base, variant: 'fromPosition' })).toBeNull();
    expect(lichessJsonToRaw({ ...base, initialFen: 42 })).toBeNull();
    // Missing optional fields: no players, no speed, no variant.
    expect(lichessJsonToRaw(base)).toEqual<RawGame>({
      platform: 'lichess',
      sourceId: 'AbCd1234',
      url: 'https://lichess.org/AbCd1234',
      playedAt: 5,
      white: 'Anonymous',
      black: 'Anonymous',
      speed: 'unknown',
      rated: false,
      result: '*',
      moves: ['e2e4', 'e7e5'],
      plyCount: 2,
    });
    // "From position" from the standard start is standard chess (as for a PGN with Variant "From Position").
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(lichessJsonToRaw({ ...base, variant: 'fromPosition', initialFen: startFen })).toMatchObject({ moves: ['e2e4', 'e7e5'] });
    expect(lichessJsonToRaw({ ...base, variant: 'fromPosition', initialFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' })).toBeNull();
    expect(lichessJsonToRaw({ ...base, variant: 'chess960', initialFen: startFen })).toBeNull();
    // A standard start written out as initialFen is still a standard game; truncation at an illegal move.
    expect(lichessJsonToRaw({ ...base, initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: 'e4 e5 Ke3 Nc6' })).toMatchObject({ moves: ['e2e4', 'e7e5'], plyCount: 4 });
  });
});

describe('fetchLichessGames', () => {
  it('streams every line with its createdAt, raw null for skipped games', async () => {
    for (const sizes of [[1], [5, 2, 13], [500]]) {
      const { fetchImpl, calls } = scriptedFetch([new Response(testBody(chunkBytes(NDJSON, sizes)).stream)]);
      const items = await collect(fetchLichessGames('SMA-Nahian', PAGE, { fetchImpl }));
      expect(items.map(i => i.createdAt)).toEqual(LINES.map(g => g.createdAt));
      expect(items.map(i => i.raw?.sourceId ?? null)).toEqual(LINES.map(g => (SKIPPED_IDS.includes(g.id as string) ? null : g.id)));
      expect(items[0]!.raw).toEqual(lichessJsonToRaw(LINES[0]));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(lichessGamesUrl('SMA-Nahian', PAGE));
      expect(calls[0]!.init.headers).toEqual({ Accept: 'application/x-ndjson' });
    }
  });

  it('reports lines that are not games and continues', async () => {
    const text = `${NDJSON.split('\n')[0]}\n{"error":"oops"}\nnot json\n${NDJSON.split('\n')[1]}\n`;
    const bad: string[] = [];
    const { fetchImpl } = scriptedFetch([streamResponse(text)]);
    const items = await collect(fetchLichessGames('SMA-Nahian', PAGE, { fetchImpl, onBadLine: line => bad.push(line) }));
    expect(items.map(i => i.raw?.sourceId)).toEqual(['Xk3jP9qa', 'bR7tNw2e']);
    expect(bad).toEqual(['{"error":"oops"}', 'not json']);
  });

  it('sets the shared cooldown on 429 and refuses requests until it ends', async () => {
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const limited = scriptedFetch([new Response('', { status: 429, headers: { 'Retry-After': '90' } })]);
    await expect(collect(fetchLichessGames('SMA-Nahian', PAGE, { fetchImpl: limited.fetchImpl, now: () => now }))).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 90_000,
    });
    expect(lichessCooldownUntil()).toBe(now + 90_000);

    const blocked = scriptedFetch([]);
    await expect(collect(fetchLichessGames('SMA-Nahian', PAGE, { fetchImpl: blocked.fetchImpl, now: () => now + 30_000 }))).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 60_000,
    });
    await expect(lichessUser('SMA-Nahian', { fetchImpl: blocked.fetchImpl, now: () => now + 89_000 })).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 1_000 });
    expect(blocked.calls).toHaveLength(0);

    const after = scriptedFetch([streamResponse(NDJSON)]);
    expect(await collect(fetchLichessGames('SMA-Nahian', PAGE, { fetchImpl: after.fetchImpl, now: () => now + 90_000 }))).toHaveLength(14);
  });

  it('a 429 from the user endpoint also starts the cooldown', async () => {
    const now = 1_000_000;
    const { fetchImpl } = scriptedFetch([new Response('', { status: 429 })]);
    await expect(lichessUser('x', { fetchImpl, now: () => now })).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(lichessCooldownUntil()).toBe(now + 60_000);
  });

  it('rejects with an AbortError when aborted mid-stream, after the games already yielded', async () => {
    const ac = new AbortController();
    const body = testBody(chunkBytes(NDJSON, [100]), { end: 'stall' });
    const { fetchImpl } = scriptedFetch([new Response(body.stream)]);
    const seen: string[] = [];
    const err = await (async () => {
      for await (const item of fetchLichessGames('SMA-Nahian', PAGE, { fetchImpl, signal: ac.signal })) {
        seen.push(item.raw?.sourceId ?? '-');
        if (seen.length === 3) ac.abort();
      }
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['Xk3jP9qa', 'bR7tNw2e', 'aiG4me0x']);
    expect(body.cancelled).toBe(true);
  });

  it('turns a stalled stream into a network error so the caller can resume', async () => {
    const body = testBody(chunkBytes(NDJSON.split('\n').slice(0, 2).join('\n') + '\n', [64]), { end: 'stall' });
    const { fetchImpl } = scriptedFetch([new Response(body.stream)]);
    const seen: number[] = [];
    const err = await (async () => {
      for await (const item of fetchLichessGames('SMA-Nahian', PAGE, { fetchImpl, idleTimeoutMs: 30 })) seen.push(item.createdAt);
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'network', message: 'stream stalled' });
    expect(seen).toEqual([LINES[0]!.createdAt, LINES[1]!.createdAt]);
  });

  it('maps a missing or closed account', async () => {
    await expect(collect(fetchLichessGames('nobody', PAGE, { fetchImpl: scriptedFetch([new Response('', { status: 404 })]).fetchImpl }))).rejects.toMatchObject({ kind: 'not-found' });
    await expect(collect(fetchLichessGames('gone', PAGE, { fetchImpl: scriptedFetch([new Response('', { status: 410 })]).fetchImpl }))).rejects.toMatchObject({ kind: 'closed' });
  });
});

describe('lichessUser', () => {
  it('reads id, display name, game count and closed flags', async () => {
    const { fetchImpl, calls } = scriptedFetch([streamResponse(fixture('lichess-user.json'))]);
    expect(await lichessUser('sma-nahian', { fetchImpl })).toEqual({ id: 'sma-nahian', username: 'SMA-Nahian', games: 2342, closed: false });
    expect(calls[0]!.url).toBe('https://lichess.org/api/user/sma-nahian');
    expect(calls[0]!.init.headers).toEqual({ Accept: 'application/json' });

    const user = fixtureJson('lichess-user.json') as Record<string, unknown>;
    const closed = scriptedFetch([jsonResponse({ id: 'sma-nahian', username: 'SMA-Nahian', disabled: true }), jsonResponse({ ...user, tosViolation: true })]);
    expect(await lichessUser('SMA-Nahian', { fetchImpl: closed.fetchImpl })).toEqual({ id: 'sma-nahian', username: 'SMA-Nahian', closed: true });
    expect(await lichessUser('SMA-Nahian', { fetchImpl: closed.fetchImpl })).toMatchObject({ closed: true, games: 2342 });
  });

  it('returns null for an unknown user and closed for 410', async () => {
    expect(await lichessUser('nobody', { fetchImpl: scriptedFetch([new Response('', { status: 404 })]).fetchImpl })).toBeNull();
    expect(await lichessUser('Gone_User', { fetchImpl: scriptedFetch([new Response('', { status: 410 })]).fetchImpl })).toEqual({ id: 'gone_user', username: 'Gone_User', closed: true });
  });

  it('encodes the username and rejects malformed answers', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse([1, 2])]);
    await expect(lichessUser('a/b', { fetchImpl })).rejects.toMatchObject({ kind: 'unknown' });
    expect(calls[0]!.url).toBe('https://lichess.org/api/user/a%2Fb');
  });
});
