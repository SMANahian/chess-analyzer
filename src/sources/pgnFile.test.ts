import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentKey } from '../core/games';
import type { RawGame } from '../core/types';
import { chesscomJsonToRaw } from './chesscom';
import { lichessJsonToRaw } from './lichess';
import { readPgnFile, scanPgnFileNames, type PgnReadCounts } from './pgnFile';
import { chunkBytes, fixture, fixtureJson, testBody } from './__fixtures__/testing';

const PGN = fixture('games.pgn');

const ITALIAN = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6 e1g1 e8g8 f1e1 a7a6 c4b3 c5a7 h2h3 h7h6 b1d2 f8e8 d2f1 c8e6 b3c2 d6d5 e4d5 e6d5 f1g3 d8d6 c1e3 a7e3 e1e3 a8d8 d1e2 f6d7 a1d1 f7f6 a2a3 d7f8 g3f5 d6e6'.split(' ');
const SICILIAN = 'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5 d4b5 d7d6 c1g5 a7a6 b5a3 b7b5 g5f6 g7f6 c3d5 f6f5 f1d3 c8e6 e1g1 e6d5 e4d5 c6e7 c2c3 f8g7 d1h5 e5e4 d3c2 e8g8 a1e1 e7g6'.split(' ');
const KINGS_INDIAN = 'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8 f1e2 e7e5 e1g1 b8c6 d4d5 c6e7 f3e1 f6d7 e1d3 f7f5 c1d2 d7f6 f2f3 f5f4 c4c5 g6g5'.split(' ');

/** A Blob whose stream() delivers the bytes in chunks of the given sizes (Node's own chunking is fixed). */
class ChunkedBlob extends Blob {
  constructor(
    private readonly content: string,
    private readonly sizes: readonly number[],
  ) {
    super([content]);
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return testBody(chunkBytes(this.content, this.sizes)).stream as ReadableStream<Uint8Array<ArrayBuffer>>;
  }
}

async function readAll(input: Blob | string, opts: Parameters<typeof readPgnFile>[1] = {}): Promise<{ games: RawGame[]; counts: PgnReadCounts }> {
  const games: RawGame[] = [];
  const it = readPgnFile(input, opts);
  for (let next = await it.next(); ; next = await it.next()) {
    if (next.done) return { games, counts: next.value };
    games.push(next.value);
  }
}

describe('readPgnFile', () => {
  it('reads the standard games of a mixed LF/CRLF file with comments and variations', async () => {
    expect(PGN).toContain('\r\n');
    const { games, counts } = await readAll(new Blob([PGN]));
    expect(counts).toEqual({ games: 4, skipped: 3 }); // Chess960, a [FEN] start, a forfeit without moves
    expect(games.map(g => `${g.platform}:${g.sourceId.length === 16 ? 'hash' : g.sourceId}`)).toEqual([
      'lichess:Xk3jP9qa',
      'chesscom:live/105523344101',
      'pgn:hash',
      'pgn:hash',
    ]);
    expect(games[0]).toEqual<RawGame>({
      platform: 'lichess',
      sourceId: 'Xk3jP9qa',
      url: 'https://lichess.org/Xk3jP9qa',
      playedAt: Date.UTC(2024, 9, 1, 18, 31, 12),
      white: 'SMA-Nahian',
      black: 'KnightRider77',
      whiteRating: 1612,
      blackRating: 1588,
      speed: 'blitz',
      rated: true,
      result: '1-0',
      moves: ITALIAN,
      plyCount: 52,
    });
    expect(games[2]).toEqual<RawGame>({
      platform: 'pgn',
      sourceId: games[2]!.sourceId,
      playedAt: Date.UTC(2023, 10, 18),
      white: 'SMA-Nahian',
      black: 'Rahman, Karim',
      whiteRating: 1702,
      blackRating: 1810,
      speed: 'classical',
      rated: true,
      result: '0-1',
      moves: SICILIAN,
      plyCount: 34,
    });
    expect(games[3]).toMatchObject({ white: 'Chowdhury, Arif', black: 'SMA-Nahian', result: '1/2-1/2', speed: 'rapid', moves: KINGS_INDIAN, playedAt: Date.UTC(2024, 0, 13) });
  });

  it('stores exported games under the same keys as the API copies', async () => {
    const { games } = await readAll(PGN);
    const lichess = lichessJsonToRaw(JSON.parse(fixture('lichess-games.ndjson').split('\n')[0]!))!;
    const chesscom = chesscomJsonToRaw((fixtureJson('chesscom-2024-04.json') as { games: unknown[] }).games[0])!;
    for (const [fromPgn, fromApi] of [
      [games[0]!, lichess],
      [games[1]!, chesscom],
    ] as const) {
      expect(`${fromPgn.platform}:${fromPgn.sourceId}`).toBe(`${fromApi.platform}:${fromApi.sourceId}`);
      expect(fromPgn.url).toBe(fromApi.url);
      expect(fromPgn.moves).toEqual(fromApi.moves);
      expect(contentKey(fromPgn)).toBe(contentKey(fromApi));
    }
    const { whiteId: _w, blackId: _b, ...chesscomWithoutIds } = chesscom;
    expect(games[1]).toEqual(chesscomWithoutIds);
  });

  it('gives the same games for a string, a Blob and any chunking (multi-byte characters split)', async () => {
    const text = PGN + '\n[White "Müller, Jürgen"]\n[Black "Ærøskøbing ♞"]\n[Result "*"]\n\n1. c4 e5 *\n';
    const reference = (await readAll(text)).games;
    expect(reference.at(-1)).toMatchObject({ white: 'Müller, Jürgen', black: 'Ærøskøbing ♞', moves: ['c2c4', 'e7e5'] });
    expect((await readAll(new Blob([text]))).games).toEqual(reference);
    for (const sizes of [[1], [3], [7, 1, 64], [500]]) {
      expect((await readAll(new ChunkedBlob(text, sizes))).games, `chunk sizes ${sizes.join(',')}`).toEqual(reference);
    }
  });

  it('reports progress in bytes with running counts', async () => {
    const blob = new ChunkedBlob(PGN, [1000]);
    const progress: [number, number, PgnReadCounts][] = [];
    await readAll(blob, { onProgress: (done, total, counts) => progress.push([done, total, counts]) });
    expect(progress.length).toBeGreaterThan(4);
    expect(progress.every(([, total]) => total === blob.size)).toBe(true);
    expect(progress.map(([done]) => done)).toEqual([...progress.map(([done]) => done)].sort((a, b) => a - b));
    expect(progress.at(-1)).toEqual([blob.size, blob.size, { games: 4, skipped: 3 }]);

    const sizes: number[] = [];
    await readAll('[White "é"]\n\n1. e4 *', { onProgress: (_, total) => sizes.push(total) });
    expect(sizes.at(-1)).toBe(new TextEncoder().encode('[White "é"]\n\n1. e4 *').length);
  });

  it('keeps maxPlies moves per game but counts all plies', async () => {
    const { games } = await readAll(PGN, { maxPlies: 6 });
    expect(games.map(g => g.moves.length)).toEqual([6, 6, 6, 6]);
    expect(games[0]!.moves).toEqual(ITALIAN.slice(0, 6));
    expect(games[0]!.plyCount).toBe(52);
  });

  it('yields to the event loop while converting large files', async () => {
    const many = Array.from({ length: 450 }, (_, i) => `[White "w${i}"]\n[Black "b"]\n\n1. e4 e5 2. Nf3 *\n`).join('\n');
    let macrotaskRan = false;
    setTimeout(() => (macrotaskRan = true), 0);
    let ranAtGame = -1;
    let n = 0;
    // One chunk, delivered without macrotasks: only the reader's own yields can let the timer run.
    for await (const _ of readPgnFile(new ChunkedBlob(many, [many.length * 2]))) {
      n++;
      if (macrotaskRan && ranAtGame < 0) ranAtGame = n;
    }
    expect(n).toBe(450);
    expect(ranAtGame).toBeGreaterThan(0);
    expect(ranAtGame).toBeLessThanOrEqual(201);
  });

  it('rejects with an AbortError when aborted, before or during the read', async () => {
    await expect(readPgnFile(PGN, { signal: AbortSignal.abort() }).next()).rejects.toMatchObject({ name: 'AbortError' });
    const ac = new AbortController();
    const it = readPgnFile(new ChunkedBlob(PGN, [200]), { signal: ac.signal });
    expect((await it.next()).value).toMatchObject({ sourceId: 'Xk3jP9qa' });
    ac.abort();
    const err: unknown = await it.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect(err).toMatchObject({ name: 'AbortError' });
  });

  it('handles empty and non-PGN input', async () => {
    expect(await readAll('')).toEqual({ games: [], counts: { games: 0, skipped: 0 } });
    expect(await readAll('just some text\nnot a game')).toEqual({ games: [], counts: { games: 0, skipped: 1 } });
  });
});

describe('PGN files with classic Mac (CR-only) line endings', () => {
  const UPLOAD = readFileSync(new URL('../../e2e/fixtures/upload.pgn', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
  const CR_ONLY = UPLOAD.replace(/\n/g, '\r');

  async function readAll(input: Blob | string): Promise<{ games: RawGame[]; counts: PgnReadCounts }> {
    const games: RawGame[] = [];
    const it = readPgnFile(input);
    for (let r = await it.next(); ; r = await it.next()) {
      if (r.done) return { games, counts: r.value };
      games.push(r.value);
    }
  }

  it('imports every game, as from the LF file', async () => {
    const lf = await readAll(new Blob([UPLOAD]));
    expect(lf.counts).toEqual({ games: 120, skipped: 1 });
    const cr = await readAll(new Blob([CR_ONLY]));
    expect(cr.counts).toEqual(lf.counts);
    expect(cr.games).toEqual(lf.games);
  });

  it('lists the same player names, reading line by line', async () => {
    const names = await scanPgnFileNames(new Blob([UPLOAD]), 5);
    expect(names[0]!.games).toBeGreaterThan(100);
    expect(await scanPgnFileNames(new Blob([CR_ONLY]), 5)).toEqual(names);
    expect(await scanPgnFileNames(CR_ONLY.replace(/\r/g, '\r\n'), 5)).toEqual(names);
  });
});

describe('scanPgnFileNames', () => {
  const EXPECTED = [
    { name: 'SMA-Nahian', games: 7 },
    { name: 'Chowdhury, Arif', games: 1 },
    { name: 'Fischer_Random', games: 1 },
    { name: 'KnightRider77', games: 1 },
    { name: 'No Show', games: 1 },
    { name: 'Rahman, Karim', games: 1 },
    { name: 'Tal_Disciple', games: 1 },
    { name: 'Trainer', games: 1 },
  ];

  it('lists the most frequent names', async () => {
    expect(await scanPgnFileNames(new Blob([PGN]))).toEqual(EXPECTED);
    expect(await scanPgnFileNames(PGN, 2)).toEqual(EXPECTED.slice(0, 2));
  });

  it('is independent of chunk boundaries', async () => {
    for (const sizes of [[1], [2], [5, 11], [4096]]) {
      expect(await scanPgnFileNames(new ChunkedBlob(PGN, sizes)), `chunk sizes ${sizes.join(',')}`).toEqual(EXPECTED);
    }
    expect(await scanPgnFileNames(new ChunkedBlob('[White "Müller"]\n[Black "x"]', [1]))).toEqual([
      { name: 'Müller', games: 1 },
      { name: 'x', games: 1 },
    ]);
  });

  it('honours abort', async () => {
    await expect(scanPgnFileNames(PGN, 10, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
