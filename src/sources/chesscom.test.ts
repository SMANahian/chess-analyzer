import { describe, expect, it, vi } from 'vitest';
import type { RawGame } from '../core/types';
import { archiveMonth, chesscomArchives, chesscomJsonToRaw, chesscomUser, fetchChesscomArchive } from './chesscom';
import { deferred, fixture, fixtureJson, flush, hangUntilAborted, jsonResponse, scriptedFetch, streamResponse } from './__fixtures__/testing';

const ARCHIVES = fixtureJson('chesscom-archives.json') as { archives: string[] };
const APRIL = fixtureJson('chesscom-2024-04.json') as { games: Record<string, unknown>[] };
const MAY = fixtureJson('chesscom-2024-05.json') as { games: Record<string, unknown>[] };
const PLAYER = fixtureJson('chesscom-player.json') as Record<string, unknown>;
const APRIL_URL = 'https://api.chess.com/pub/player/sma-nahian/games/2024/04';

const TWO_KNIGHTS = 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 c6a5 c4b5 c7c6 d5c6 b7c6 b5e2 h7h6 g5f3 e5e4 f3e5 f8d6 d2d4 e4d3 e5d3 d8c7 b2b3 e8g8 c1b2 f6e4 e1g1 f8e8 b1c3 e4c3 b2c3 c8f5 g2g3 a8d8 c3b2 c7b6 d3c1 d6c5'.split(' ');
const SCANDINAVIAN = 'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c8f5 f1c4 e7e6 c1d2 c7c6 d1e2 f8b4 e1c1 b8d7 a2a3 b4c3 d2c3 a5a3'.split(' ');

/** The request options apart from the signal (fetchWithRetry passes its own, which follows the caller's). */
const withoutSignal = ({ signal: _signal, ...rest }: RequestInit): RequestInit => rest;
const game = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...APRIL.games[0], ...patch });
const pgnWith = (pgn: string, edit: (headers: string) => string): string => {
  const split = pgn.indexOf('\n\n');
  return edit(pgn.slice(0, split)) + pgn.slice(split);
};

describe('chesscomJsonToRaw', () => {
  it('converts a live game from its JSON fields and PGN', () => {
    expect(chesscomJsonToRaw(APRIL.games[0])).toEqual<RawGame>({
      platform: 'chesscom',
      sourceId: 'live/105523344101',
      url: 'https://www.chess.com/game/live/105523344101',
      playedAt: Date.UTC(2024, 3, 3, 18, 2, 31),
      white: 'SMA-Nahian',
      black: 'Tal_Disciple',
      whiteId: 'sma-nahian',
      blackId: 'tal_disciple',
      whiteRating: 1523,
      blackRating: 1498,
      speed: 'blitz',
      rated: true,
      result: '1-0',
      moves: TWO_KNIGHTS,
      plyCount: 41,
    });
  });

  it('converts a daily game: correspondence, start_time when the PGN has no UTC tags, O-O-O', () => {
    expect(chesscomJsonToRaw(APRIL.games[1])).toEqual<RawGame>({
      platform: 'chesscom',
      sourceId: 'daily/612345678',
      url: 'https://www.chess.com/game/daily/612345678',
      playedAt: Date.UTC(2024, 3, 5, 7, 15, 0),
      white: 'CorrespondenceKing',
      black: 'SMA-Nahian',
      whiteId: 'correspondenceking',
      blackId: 'sma-nahian',
      whiteRating: 1402,
      blackRating: 1450,
      speed: 'correspondence',
      rated: true,
      result: '0-1',
      moves: SCANDINAVIAN,
      plyCount: 22,
    });
  });

  it('uses end_time when the PGN has no UTCDate/UTCTime and there is no start_time', () => {
    const draw = chesscomJsonToRaw(MAY.games[2])!;
    expect(draw).toMatchObject({ sourceId: 'live/108455500077', result: '1/2-1/2', rated: false, speed: 'blitz', black: 'SMA-Nahian', blackId: 'sma-nahian' });
    expect(draw.playedAt).toBe(Date.UTC(2024, 4, 12, 8, 6, 20));
    expect(draw.playedAt).toBe((MAY.games[2]!.end_time as number) * 1000);
  });

  it('reads results for both colours and draws', () => {
    expect(chesscomJsonToRaw(APRIL.games[3])).toMatchObject({ result: '1/2-1/2', speed: 'rapid', plyCount: 41 });
    expect(chesscomJsonToRaw(MAY.games[0])).toMatchObject({ result: '0-1', speed: 'bullet', playedAt: Date.UTC(2024, 4, 2, 23, 59, 40) });
  });

  it('falls back to the player results when the PGN has no result', () => {
    const noResult = (white: string, black: string): RawGame | null =>
      chesscomJsonToRaw(
        game({
          pgn: pgnWith(APRIL.games[0]!.pgn as string, h => h.replace('[Result "1-0"]', '[Result "*"]')).replace(/ 1-0\n$/, ' *\n'),
          white: { username: 'A', rating: 1500, result: white },
          black: { username: 'B', rating: 1500, result: black },
        }),
      );
    expect(noResult('win', 'resigned')!.result).toBe('1-0');
    expect(noResult('checkmated', 'win')!.result).toBe('0-1');
    for (const code of ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']) {
      expect(noResult(code, code)!.result, code).toBe('1/2-1/2');
    }
    expect(noResult('abandoned', 'abandoned')!.result).toBe('*');
  });

  it('skips variants, custom starts and games without moves', () => {
    expect(chesscomJsonToRaw(APRIL.games[2])).toBeNull(); // chess960
    expect(chesscomJsonToRaw(MAY.games[1])).toBeNull(); // bughouse
    expect(chesscomJsonToRaw(MAY.games[3])).toBeNull(); // rules 'chess' but knight odds
    expect(chesscomJsonToRaw(game({ rules: 'kingofthehill' }))).toBeNull();
    expect(chesscomJsonToRaw(game({ rules: undefined }))).toBeNull();
    expect(chesscomJsonToRaw(game({ pgn: undefined }))).toBeNull();
    expect(chesscomJsonToRaw(game({ pgn: '[Event "Live Chess"]\n\n1-0' }))).toBeNull();
    const fenStart = pgnWith(APRIL.games[0]!.pgn as string, h => `${h}\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]`);
    expect(chesscomJsonToRaw(game({ initial_setup: '', pgn: fenStart }))).toBeNull();
    expect(chesscomJsonToRaw(null)).toBeNull();
    expect(chesscomJsonToRaw([APRIL.games[0]])).toBeNull();
  });

  it('accepts a standard start without the move counters and finds the id in the PGN Link', () => {
    expect(chesscomJsonToRaw(game({ initial_setup: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -' }))).not.toBeNull();
    expect(chesscomJsonToRaw(game({ url: undefined }))).toMatchObject({ sourceId: 'live/105523344101' });
    const noLink = pgnWith(APRIL.games[0]!.pgn as string, h => h.replace(/\n\[Link "[^"]*"\]/, ''));
    expect(chesscomJsonToRaw(game({ url: 'https://www.chess.com/analysis', pgn: noLink }))).toBeNull();
  });

  it('reads the older /live/game/<id> link form like the PGN importer, so such games are not dropped', () => {
    const oldUrls = { url: 'https://www.chess.com/live/game/105523344101', pgn: pgnWith(APRIL.games[0]!.pgn as string, h => h.replace('/game/live/', '/live/game/')) };
    expect(chesscomJsonToRaw(game(oldUrls))).toMatchObject({ sourceId: 'live/105523344101', url: 'https://www.chess.com/game/live/105523344101' });
    expect(chesscomJsonToRaw(game({ url: 'https://www.chess.com/daily/game/612345678' }))).toMatchObject({ sourceId: 'daily/612345678' });
  });

  it('rejects a custom start named by either initial_setup or the PGN FEN header', () => {
    const odds = 'rnbqkbn1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQq - 0 1';
    const withFen = pgnWith(APRIL.games[0]!.pgn as string, h => `${h}\n[SetUp "1"]\n[FEN "${odds}"]`);
    expect(chesscomJsonToRaw(game({ pgn: withFen }))).toBeNull(); // initial_setup says standard, the PGN disagrees
  });

  it('derives the speed from the time control when time_class is unknown', () => {
    expect(chesscomJsonToRaw(game({ time_class: 'hyper', time_control: '600+5' }))!.speed).toBe('rapid');
    expect(chesscomJsonToRaw(game({ time_class: undefined, time_control: '1/86400' }))!.speed).toBe('correspondence');
  });
});

describe('fetchChesscomArchive', () => {
  it('returns standard games with their end times and counts the rest', async () => {
    const { fetchImpl, calls } = scriptedFetch([streamResponse(fixture('chesscom-2024-04.json')), streamResponse(fixture('chesscom-2024-05.json'))]);
    const april = await fetchChesscomArchive(APRIL_URL, { fetchImpl });
    expect(april.games.map(g => g.sourceId)).toEqual(['live/105523344101', 'daily/612345678', 'live/105700012345']);
    expect(april.skipped).toBe(1);
    expect(april.endTimes).toEqual([APRIL.games[0], APRIL.games[1], APRIL.games[3]].map(g => (g!.end_time as number) * 1000));
    expect(april.games[0]).toEqual(chesscomJsonToRaw(APRIL.games[0]));

    const may = await fetchChesscomArchive(ARCHIVES.archives[1]!, { fetchImpl });
    expect(may.games.map(g => g.sourceId)).toEqual(['live/108385012345', 'live/108455500077']);
    expect(may.skipped).toBe(2);
    expect(may.endTimes).toEqual([Date.UTC(2024, 4, 2, 23, 59, 40) + 116_000, Date.UTC(2024, 4, 12, 8, 6, 20)]);

    expect(calls.map(c => c.url)).toEqual([APRIL_URL, ARCHIVES.archives[1]]);
    for (const call of calls) expect(withoutSignal(call.init)).toEqual({ cache: 'no-cache' });
  });

  it('yields to the event loop while converting a busy month', async () => {
    const games = Array.from({ length: 450 }, (_, i) => ({ ...APRIL.games[0], url: `https://www.chess.com/game/live/${1000 + i}` }));
    const { fetchImpl } = scriptedFetch([jsonResponse({ games })]);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const month = await fetchChesscomArchive(APRIL_URL, { fetchImpl });
      expect(month.games).toHaveLength(450);
      expect(month.games[449]!.sourceId).toBe('live/1449');
      expect(spy.mock.calls.filter(([, ms]) => ms === 0).length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects malformed archives', async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse({ games: 'nope' }), new Response('<html>', { status: 200 })]);
    await expect(fetchChesscomArchive(APRIL_URL, { fetchImpl })).rejects.toMatchObject({ kind: 'unknown' });
    await expect(fetchChesscomArchive(APRIL_URL, { fetchImpl })).rejects.toMatchObject({ kind: 'unknown' });
  });
});

describe('chesscomArchives', () => {
  it('lists archive URLs oldest first, lower-casing the username', async () => {
    const { fetchImpl, calls } = scriptedFetch([streamResponse(fixture('chesscom-archives.json'))]);
    expect(await chesscomArchives('SMA-Nahian', { fetchImpl })).toEqual([APRIL_URL, 'https://api.chess.com/pub/player/sma-nahian/games/2024/05']);
    expect(calls[0]!.url).toBe('https://api.chess.com/pub/player/sma-nahian/games/archives');
    expect(calls[0]!.init.headers).toBeUndefined();
    expect(calls[0]!.init.cache).toBe('no-cache');
  });

  it('reports a missing or closed account and malformed answers', async () => {
    await expect(chesscomArchives('nobody', { fetchImpl: scriptedFetch([new Response('', { status: 404 })]).fetchImpl })).rejects.toMatchObject({ kind: 'not-found' });
    await expect(chesscomArchives('gone', { fetchImpl: scriptedFetch([new Response('', { status: 410 })]).fetchImpl })).rejects.toMatchObject({ kind: 'closed' });
    await expect(chesscomArchives('x', { fetchImpl: scriptedFetch([jsonResponse({})]).fetchImpl })).rejects.toMatchObject({ kind: 'unknown' });
    expect(await chesscomArchives('x', { fetchImpl: scriptedFetch([jsonResponse({ archives: ['a', 3, null, 'b'] })]).fetchImpl })).toEqual(['a', 'b']);
  });
});

describe('chesscomUser', () => {
  it('returns the display spelling from the profile URL', async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(PLAYER)]);
    expect(await chesscomUser('SMA-NAHIAN', { fetchImpl })).toEqual({ username: 'SMA-Nahian', closed: false });
    expect(calls[0]!.url).toBe('https://api.chess.com/pub/player/sma-nahian');
    expect(withoutSignal(calls[0]!.init)).toEqual({ cache: 'no-cache' }); // no headers: they could trigger a CORS preflight
    const noUrl = scriptedFetch([jsonResponse({ ...PLAYER, url: undefined })]);
    expect(await chesscomUser('SMA-Nahian', { fetchImpl: noUrl.fetchImpl })).toEqual({ username: 'sma-nahian', closed: false });
  });

  it('detects closed accounts and unknown users', async () => {
    const closed = scriptedFetch([jsonResponse({ ...PLAYER, status: 'closed:fair_play_violations' }), jsonResponse({ ...PLAYER, status: 'closed' })]);
    expect(await chesscomUser('SMA-Nahian', { fetchImpl: closed.fetchImpl })).toMatchObject({ closed: true });
    expect(await chesscomUser('SMA-Nahian', { fetchImpl: closed.fetchImpl })).toMatchObject({ closed: true });
    expect(await chesscomUser('nobody', { fetchImpl: scriptedFetch([new Response('', { status: 404 })]).fetchImpl })).toBeNull();
    expect(await chesscomUser('Gone', { fetchImpl: scriptedFetch([new Response('', { status: 410 })]).fetchImpl })).toEqual({ username: 'Gone', closed: true });
  });
});

describe('request serialisation', () => {
  it('runs concurrent requests one after the other, including reading the body', async () => {
    const firstAnswer = deferred<Response>();
    const bodyGate = deferred<void>();
    const slowBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await bodyGate.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(PLAYER)));
        controller.close();
      },
    });
    const secondAnswer = deferred<Response>();
    const { fetchImpl, calls } = scriptedFetch([() => firstAnswer.promise, () => secondAnswer.promise, streamResponse(fixture('chesscom-2024-04.json'))]);
    const user = chesscomUser('SMA-Nahian', { fetchImpl });
    const archives = chesscomArchives('SMA-Nahian', { fetchImpl });
    const month = fetchChesscomArchive(APRIL_URL, { fetchImpl });
    await flush();
    expect(calls).toHaveLength(1);
    firstAnswer.resolve(new Response(slowBody));
    await flush();
    expect(calls).toHaveLength(1); // headers arrived, body still downloading
    bodyGate.resolve();
    expect(await user).toEqual({ username: 'SMA-Nahian', closed: false });
    await flush();
    expect(calls).toHaveLength(2);
    secondAnswer.resolve(jsonResponse(ARCHIVES));
    expect(await archives).toEqual(ARCHIVES.archives);
    expect((await month).games).toHaveLength(3);
    expect(calls.map(c => c.url)).toEqual([
      'https://api.chess.com/pub/player/sma-nahian',
      'https://api.chess.com/pub/player/sma-nahian/games/archives',
      APRIL_URL,
    ]);
  });

  it('a failed request does not block the queue', async () => {
    const { fetchImpl } = scriptedFetch([new Response('', { status: 404 }), jsonResponse(ARCHIVES)]);
    const [missing, list] = await Promise.all([chesscomUser('nobody', { fetchImpl }), chesscomArchives('SMA-Nahian', { fetchImpl })]);
    expect(missing).toBeNull();
    expect(list).toEqual(ARCHIVES.archives);
  });

  it('an abort rejects at once, even while queued, and the aborted request is never sent', async () => {
    const running = new AbortController();
    const queued = new AbortController();
    const { fetchImpl, calls } = scriptedFetch([hangUntilAborted, jsonResponse(ARCHIVES)]);
    const first = chesscomUser('slow', { fetchImpl, signal: running.signal });
    const second = chesscomArchives('SMA-Nahian', { fetchImpl, signal: queued.signal });
    const third = chesscomArchives('SMA-Nahian', { fetchImpl });
    await flush();
    queued.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
    running.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(await third).toEqual(ARCHIVES.archives);
    expect(calls.map(c => c.url)).toEqual(['https://api.chess.com/pub/player/slow', 'https://api.chess.com/pub/player/sma-nahian/games/archives']);
  });
});

describe('archiveMonth', () => {
  it('parses archive URLs', () => {
    expect(archiveMonth(APRIL_URL)).toEqual({ year: 2024, month: 4 });
    expect(archiveMonth('https://api.chess.com/pub/player/x/games/2023/12/')).toEqual({ year: 2023, month: 12 });
    expect(archiveMonth('https://api.chess.com/pub/player/x/games/2023/13')).toBeNull();
    expect(archiveMonth('https://api.chess.com/pub/player/x/games/2023/00')).toBeNull();
    expect(archiveMonth('https://api.chess.com/pub/player/x/games/archives')).toBeNull();
    expect(archiveMonth('')).toBeNull();
  });
});
