import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import { posKey } from './chess';
import { OpeningBook, loadOpeningBook, type OpeningsJson } from './openings';

const json = JSON.parse(readFileSync(new URL('../../public/data/openings.json', import.meta.url), 'utf8')) as OpeningsJson & { count: number };
const book = OpeningBook.fromJson(json);

/** Position keys after each move of a line from the start. */
const keysAlong = (sans: string[]): string[] => {
  const pos = Chess.default();
  return sans.map(san => {
    pos.play(parseSan(pos, san)!);
    return posKey(pos);
  });
};

const RUY_LOPEZ = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -';

describe('OpeningBook', () => {
  it('loads every position of the bundled dataset', () => {
    expect(book.size).toBe(json.count);
    expect(book.size).toBeGreaterThan(3000);
  });

  it('looks up position keys (and full FENs)', () => {
    expect(book.lookup(RUY_LOPEZ)).toEqual({ eco: 'C60', name: 'Ruy Lopez' });
    expect(book.lookup(`${RUY_LOPEZ} 3 3`)).toEqual({ eco: 'C60', name: 'Ruy Lopez' });
    expect(book.has(RUY_LOPEZ)).toBe(true);
    expect(book.has('8/8/8/8/8/8/8/K6k w - -')).toBe(false);
    expect(book.lookup('')).toBeUndefined();
  });

  it('names a path by its deepest book position', () => {
    const keys = keysAlong(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'h6']);
    expect(book.nameForKeys(keys)?.name).toBe('Ruy Lopez: Morphy Defense');
    expect(book.nameForKeys(keys.slice(0, 5))).toEqual({ eco: 'C60', name: 'Ruy Lopez' });
    expect(book.nameForKeys(keysAlong(['e4']))).toEqual({ eco: 'B00', name: "King's Pawn Game" });
    expect(book.nameForKeys([])).toBeUndefined();
  });

  it('skips malformed entries and keeps the first of duplicate keys', () => {
    const small = OpeningBook.fromJson({
      entries: [['k1', 'A00', 'First'], ['k1', 'A01', 'Second'], ['k2', 'B00'], 'junk', ['k3', 1, 'x']] as unknown as [string, string, string][],
    });
    expect(small.size).toBe(1);
    expect(small.lookup('k1')).toEqual({ eco: 'A00', name: 'First' });
  });
});

describe('loadOpeningBook', () => {
  const ok = () => new Response(JSON.stringify({ entries: [[RUY_LOPEZ, 'C60', 'Ruy Lopez']] }), { status: 200 });

  it('fetches the default URL under the app base and memoises the book', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const first = await loadOpeningBook(undefined, fetchImpl);
    const second = await loadOpeningBook(undefined, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual(['/data/openings.json']);
    expect(second).toBe(first);
    expect(first.lookup(RUY_LOPEZ)?.eco).toBe('C60');
  });

  it('rejects on HTTP errors and malformed data, and retries afterwards', async () => {
    const url = 'https://example.test/openings-retry.json';
    const failing = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(loadOpeningBook(url, failing)).rejects.toThrow(/HTTP 404/);
    const malformed = vi.fn(async () => new Response('{"rows": []}', { status: 200 }));
    await expect(loadOpeningBook(url, malformed)).rejects.toThrow(/malformed/);
    const working = vi.fn(async () => ok());
    expect((await loadOpeningBook(url, working)).size).toBe(1);
    expect(working).toHaveBeenCalledTimes(1);
  });
});
