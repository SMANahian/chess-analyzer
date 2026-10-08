import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePgn } from 'chessops/pgn';
import {
  PgnNameCounter,
  PgnStreamSplitter,
  parsePgnGame,
  parsePgnText,
  pgnDate,
  pgnGameToRaw,
  resultFromHeader,
  scanPgnNames,
  speedFromTimeControl,
  splitPgnGames,
  type PgnGame,
} from './pgn';

// BOM, CRLF and LF mixed, escaped quotes, clock comments, glued move numbers, NAGs, !? suffixes,
// nested variations, a ;comment containing '(', a {comment} containing parens and fake moves, 0-0.
const TRICKY =
  '﻿[Event "Live Chess"]\r\n[Site "Chess.com"]\r\n[White "A \\"quoted\\" name"]\r\n[Black "B"]\r\n[Result "1-0"]\r\n\r\n' +
  '1. e4 {[%clk 0:02:59.9]} 1... e5 {[%clk 0:02:58]} 2.Nf3 2...Nc6 3. Bc4!? $1 ( 3. Bb5 a6 ( 3... Nf6 4. O-O ) 4. Ba4 ) Bc5?! ; line comment ( not a var\r\n' +
  '4. c3 {A comment (with parens) and 5. fake} 4... Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Bd2 Bxd2+ 8. Nbxd2 d5 9. exd5 Nxd5 10. 0-0 O-O 1-0\r\n\r\n' +
  '[Event "Second"]\r\n[Result "*"]\r\n\r\n1. d4 d5 *\r\n\r\n\r\n' +
  '[Event "Third"]\n[Result "0-1"]\n[FEN "8/4P1k1/8/8/8/8/8/4K3 w - - 0 1"]\n[SetUp "1"]\n\n1. e8=Q+ Kf6 0-1\n';

const TRICKY_MAINLINE = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+', 'Bd2', 'Bxd2+', 'Nbxd2', 'd5', 'exd5', 'Nxd5', 'O-O', 'O-O'];

const SMALL = '[Event "a"]\n\n1. e4 e5 1-0\n\n[Event "b"]\r\n\r\n1. d4 *\r\n\r\n[Event "c"]\n[White "x"]\n\n1. c4 {x} c5 0-1';

const LICHESS_GAME = `[Event "Rated Rapid game"]
[Site "https://lichess.org/y55rRync"]
[Date "2026.09.30"]
[White "hero"]
[Black "jzvwg6712"]
[Result "1-0"]
[UTCDate "2026.09.30"]
[UTCTime "19:31:02"]
[WhiteElo "1446"]
[BlackElo "1666"]
[Variant "Standard"]
[TimeControl "900+10"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Nxc3 9. bxc3 Bxc3 10. Qb3 d5 11. Qxb7 Bxb7 12. Bxd5 Bxd4 13. Bxf7+ Kxf7 14. Nxd4 Nxd4 15. Bb2 Bxg2 16. Rae1 Bh3 17. Kh1 Qd7 18. Rd1 Nf3 19. Bd4 Qe6 20. a4 Rhf8 21. Bxa7 Kg8 22. Ra1 Qf6 23. Rab1 Bxf1 1-0
`;

const chessopsMainline = (text: string): string[][] => parsePgn(text).map(g => [...g.moves.mainline()].map(n => n.san));

function game(headers: Record<string, string>, movetext = '1. e4 e5 2. Nf3 Nc6 *'): PgnGame {
  const head = Object.entries(headers)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n');
  return parsePgnGame(`${head}\n\n${movetext}`, 40);
}

describe('parsePgnText', () => {
  it('extracts headers and the mainline like chessops (BOM, CRLF, comments, variations, NAGs)', () => {
    const games = [...parsePgnText(TRICKY, 40)];
    expect(games).toHaveLength(3);
    expect(games[0]!.headers.White).toBe('A "quoted" name');
    expect(games[0]!.headers.Event).toBe('Live Chess');
    expect(games[0]!.sans).toEqual(TRICKY_MAINLINE);
    expect(games.map(g => g.sans)).toEqual(chessopsMainline(TRICKY));
    expect(games[1]!.sans).toEqual(['d4', 'd5']);
    expect(games[2]!.headers.FEN).toBe('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
    expect(games[2]!.sans).toEqual(['e8=Q+', 'Kf6']);
  });

  it('caps the SAN list at maxPlies but counts the whole mainline', () => {
    const [g] = [...parsePgnText(TRICKY, 4)];
    expect(g!.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(g!.plyCount).toBe(20);
    expect(parsePgnGame(LICHESS_GAME, 40).plyCount).toBe(46);
  });

  it('skips %-escape lines, multi-line comments and annotation glyphs; stops at the result', () => {
    const text = '[Event "x"]\n%escaped line 1. h4\n\n1. e4 d5 2. e5 f5 3. exf6 e.p. Nxf6 +- 4 Nf3 {multi\n\nline 9. Qh5} = 1/2-1/2 5. Nc3';
    const [g] = [...parsePgnText(text, 40)];
    expect(g!.sans).toEqual(['e4', 'd5', 'e5', 'f5', 'exf6', 'Nxf6', 'Nf3']);
    expect(g!.plyCount).toBe(7);
  });

  it('normalises castling spellings and keeps null moves as "--"', () => {
    const g = parsePgnGame('1. e4 e5 2. o-o 0-0-0+ 3. O-O-O# -- 4. Z0 Nf6!!', 40);
    expect(g.sans).toEqual(['e4', 'e5', 'O-O', 'O-O-O+', 'O-O-O#', '--', '--', 'Nf6']);
  });

  it('reads several tags on one line and tolerates odd spacing', () => {
    const g = parsePgnGame('  [White "W"] [Black "B"]\n[Event   "E"  ]\n[Bad tag line\n\n1.e4 1...e5 2.Nf3', 40);
    expect(g.headers).toEqual({ White: 'W', Black: 'B', Event: 'E' });
    expect(g.sans).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('ignores empty chunks and returns nothing for empty input', () => {
    expect([...parsePgnText('', 40)]).toEqual([]);
    expect([...parsePgnText('﻿\r\n \n\t\n', 40)]).toEqual([]);
  });

  it('treats a blank line not followed by a tag as part of the same game', () => {
    const games = [...parsePgnText('[Event "x"]\n\n1. e4 e5\n\n2. Nf3 Nc6 *\n', 40)];
    expect(games).toHaveLength(1);
    expect(games[0]!.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('splits games without headers at the blank line after their result', () => {
    const text = '1. e4 e5 2. Nf3 1-0\n\n1. d4 d5 0-1\r\n\r\n\r\n\r\n1. c4 *\n\n[Event "x"]\n\n1. g3 1/2-1/2\n\n1. b3 *';
    const games = [...parsePgnText(text, 40)];
    expect(games.map(g => g.sans)).toEqual([['e4', 'e5', 'Nf3'], ['d4', 'd5'], ['c4'], ['g3'], ['b3']]);
    expect(games.map(g => g.sans)).toEqual(chessopsMainline(text));
    expect(games[3]!.headers).toEqual({ Event: 'x' });
  });

  it('starts a new game at a tag line directly after a result, without a blank line', () => {
    const games = [...parsePgnText('[Event "a"]\n\n1. e4 e5 1-0\n[Event "b"]\n\n1. d4 d5 0-1\n', 40)];
    expect(games.map(g => [g.headers.Event, g.sans])).toEqual([
      ['a', ['e4', 'e5']],
      ['b', ['d4', 'd5']],
    ]);
  });

  it('reads movetext that follows the tags on the same line', () => {
    const g = parsePgnGame('[Event "a"] [Result "1-0"] 1. e4 e5 2. Nf3 1-0', 40);
    expect(g.headers).toEqual({ Event: 'a', Result: '1-0' });
    expect(g.sans).toEqual(['e4', 'e5', 'Nf3']);
    const commented = parsePgnGame('[Event "a"] ; note\n[Site "b"] {x}\n\n1. d4 *', 40);
    expect(commented.headers).toEqual({ Event: 'a', Site: 'b' });
    expect(commented.sans).toEqual(['d4']);
  });

  it('accepts a Unicode ellipsis after a move number', () => {
    expect(parsePgnGame('1. e4 1…e5 2. Nf3 2… Nc6 *', 40).sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });
});

describe('PgnStreamSplitter', () => {
  const run = (chunks: string[]): string[] => {
    const splitter = new PgnStreamSplitter();
    const out: string[] = [];
    for (const chunk of chunks) out.push(...splitter.push(chunk));
    out.push(...splitter.flush());
    return out;
  };

  it('returns trimmed whole-game texts', () => {
    const games = splitPgnGames(TRICKY);
    expect(games).toHaveLength(3);
    expect(games[0]!.startsWith('[Event "Live Chess"]')).toBe(true);
    expect(games[0]!.endsWith('O-O 1-0')).toBe(true);
    expect(games[1]).toBe('[Event "Second"]\r\n[Result "*"]\r\n\r\n1. d4 d5 *');
    expect(games[2]!.endsWith('Kf6 0-1')).toBe(true);
  });

  it('gives identical games for every possible split position', () => {
    const expected = splitPgnGames(TRICKY);
    for (let p = 0; p <= TRICKY.length; p++) {
      expect(run([TRICKY.slice(0, p), TRICKY.slice(p)]), `split at ${p}`).toEqual(expected);
    }
  });

  it('gives identical games for every pair of split positions', () => {
    const expected = splitPgnGames(SMALL);
    expect(expected).toHaveLength(3);
    for (let p = 0; p <= SMALL.length; p++) {
      for (let q = p; q <= SMALL.length; q++) {
        const got = run([SMALL.slice(0, p), SMALL.slice(p, q), SMALL.slice(q)]);
        if (JSON.stringify(got) !== JSON.stringify(expected)) expect(got, `split at ${p}, ${q}`).toEqual(expected);
      }
    }
  });

  it('gives identical games for every chunk size', () => {
    const expected = splitPgnGames(TRICKY);
    for (let size = 1; size <= 64; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < TRICKY.length; i += size) chunks.push(TRICKY.slice(i, i + size));
      expect(run(chunks), `chunk size ${size}`).toEqual(expected);
    }
  });

  it('gives identical games for every split position of headerless and run-together games', () => {
    const text = '1. e4 e5 1-0\n\n1. d4 *\r\n[Event "b"]\r\n\r\n1. c4 0-1\n\n\n1. g3';
    const expected = splitPgnGames(text);
    expect(expected).toEqual(['1. e4 e5 1-0', '1. d4 *', '[Event "b"]\r\n\r\n1. c4 0-1', '1. g3']);
    for (let p = 0; p <= text.length; p++) {
      for (let q = p; q <= text.length; q++) {
        const got = run([text.slice(0, p), text.slice(p, q), text.slice(q)]);
        if (JSON.stringify(got) !== JSON.stringify(expected)) expect(got, `split at ${p}, ${q}`).toEqual(expected);
      }
    }
  });

  it('stays linear when a very long line arrives in small chunks', () => {
    // 2 MB of movetext without a line break, then a second game.
    const text = `[Event "long"]\n\n${'e4 '.repeat(700_000)}*\n\n[Event "next"]\n\n1. d4 *\n`;
    const t0 = performance.now();
    const games = run(Array.from({ length: Math.ceil(text.length / 256) }, (_, i) => text.slice(i * 256, (i + 1) * 256)));
    const ms = performance.now() - t0;
    expect(games).toHaveLength(2);
    expect(games[0]!.length).toBe(text.indexOf('*') + 1);
    expect(games[1]).toBe('[Event "next"]\n\n1. d4 *');
    // Quadratic re-scanning took several seconds here; the linear splitter takes a few ms.
    expect(ms).toBeLessThan(1000);
  });

  describe('line endings: LF, CRLF and lone CR (old Mac files) give the same games', () => {
    const UPLOAD = readFileSync(new URL('../../e2e/fixtures/upload.pgn', import.meta.url), 'utf8');
    const lf = UPLOAD.replace(/\r\n?/g, '\n');
    const variants = { lf, crlf: lf.replace(/\n/g, '\r\n'), cr: lf.replace(/\n/g, '\r') };
    const chunked = (text: string, size: number): string[] => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
    const parsed = (games: string[]) => games.map(g => pgnGameToRaw(parsePgnGame(g, 40)));
    const expected = parsed(splitPgnGames(lf));

    it('upload.pgn has its 121 games (one of them not standard chess)', () => {
      expect(expected).toHaveLength(121);
      expect(expected.filter(g => g !== null)).toHaveLength(120);
    });

    for (const [name, text] of Object.entries(variants)) {
      it(`${name}: chunk sizes 1, 7 and 4096`, () => {
        for (const size of [1, 7, 4096]) expect(parsed(run(chunked(text, size))), `${name}, chunks of ${size}`).toEqual(expected);
      });
    }

    it('a CRLF split exactly between its CR and its LF is one line break; a lone CR at a chunk end is one too', () => {
      const crlf = variants.crlf;
      const at = crlf.indexOf('\r\n') + 1;
      expect(parsed(run([crlf.slice(0, at), crlf.slice(at)]))).toEqual(expected);
      // A blank line split as CR | LF CR | LF must still separate the games.
      const blank = crlf.indexOf('\r\n\r\n');
      expect(parsed(run([crlf.slice(0, blank + 1), crlf.slice(blank + 1, blank + 3), crlf.slice(blank + 3)]))).toEqual(expected);
      const cr = variants.cr;
      const lone = cr.indexOf('\r') + 1;
      expect(parsed(run([cr.slice(0, lone), '', cr.slice(lone)]))).toEqual(expected);
      // The file ends in a lone CR: flushed as a line break.
      expect(run(['[Event "x"]\r\r1. e4 *\r'])).toEqual(['[Event "x"]\n\n1. e4 *']);
      expect(splitPgnGames('1. e4 e5 1-0\r\r1. d4 *')).toEqual(['1. e4 e5 1-0', '1. d4 *']);
    });
  });

  it('can be reused after flush and ignores empty chunks', () => {
    const splitter = new PgnStreamSplitter();
    expect(splitter.push('')).toEqual([]);
    splitter.push(SMALL);
    splitter.flush();
    expect(run(['', '', SMALL, ''])).toEqual(splitPgnGames(SMALL));
    expect([...splitter.push('﻿[Event "z"]\n\n1. e4 *'), ...splitter.flush()]).toEqual(['[Event "z"]\n\n1. e4 *']);
  });
});

describe('scanPgnNames', () => {
  const text = [
    '[White "hero"]\n[Black "Alice"]\n\n1. e4 *',
    '[White "bob"]\n[Black "HERO"]\n\n1. e4 *',
    '[White "Hero"]\n[Black "alice"]\n\n1. e4 *',
    '[White "?"]\n[Black "hero"]\n\n1. e4 *',
    '[White "carol"]\n[Black "carol"]\n\n1. e4 *',
  ].join('\n\n');

  it('counts games per name case-insensitively, most frequent first', () => {
    expect(scanPgnNames(text)).toEqual([
      { name: 'hero', games: 4 },
      { name: 'Alice', games: 2 },
      { name: 'bob', games: 1 },
      { name: 'carol', games: 1 },
    ]);
    expect(scanPgnNames(text, 2).map(n => n.name)).toEqual(['hero', 'Alice']);
  });

  it('accumulates across game texts with PgnNameCounter', () => {
    const counter = new PgnNameCounter();
    for (const g of splitPgnGames(text)) counter.add(g);
    expect(counter.top(1)).toEqual([{ name: 'hero', games: 4 }]);
  });
});

describe('header helpers', () => {
  it.each([
    ['15+0', 'ultraBullet'],
    ['30+0', 'bullet'],
    ['0+1', 'bullet'],
    ['120+1', 'bullet'],
    ['180+0', 'blitz'],
    ['300+3', 'blitz'],
    ['480+0', 'rapid'],
    ['900+10', 'rapid'],
    ['1500+0', 'classical'],
    ['1800+20', 'classical'],
    ['40/7200:3600', 'classical'],
    ['40/5400+30:1800+30', 'classical'],
    ['40/1500+30', 'classical'],
    ['40/600+5', 'rapid'],
    ['29+0', 'ultraBullet'],
    ['0+1', 'bullet'],
    ['179', 'bullet'],
    ['1499+0', 'rapid'],
    ['*60', 'bullet'],
    ['1/259200', 'correspondence'],
    ['1/86400', 'correspondence'],
    ['-', 'correspondence'],
    ['?', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['blitz', 'unknown'],
  ] as const)('speedFromTimeControl(%j) = %s', (tc, speed) => {
    expect(speedFromTimeControl(tc)).toBe(speed);
  });

  it('reads results', () => {
    expect(resultFromHeader('1-0')).toBe('1-0');
    expect(resultFromHeader(' 0-1 ')).toBe('0-1');
    expect(resultFromHeader('1/2-1/2')).toBe('1/2-1/2');
    expect(resultFromHeader('½-½')).toBe('1/2-1/2');
    expect(resultFromHeader('*')).toBe('*');
    expect(resultFromHeader(undefined)).toBe('*');
    expect(resultFromHeader('won')).toBe('*');
  });

  it('dates games from UTCDate/UTCTime, else Date; 0 when unknown', () => {
    expect(pgnDate({ UTCDate: '2026.09.30', UTCTime: '19:31:02', Date: '2026.10.01' })).toBe(Date.UTC(2026, 8, 30, 19, 31, 2));
    expect(pgnDate({ Date: '2026.09.30' })).toBe(Date.UTC(2026, 8, 30));
    expect(pgnDate({ Date: '2026.09.30', Time: '08:05:00' })).toBe(Date.UTC(2026, 8, 30, 8, 5));
    expect(pgnDate({ UTCDate: '2026.02.30', Date: '2026.02.28' })).toBe(Date.UTC(2026, 1, 28));
    expect(pgnDate({ Date: '2026.??.??' })).toBe(0);
    expect(pgnDate({ Date: '????.??.??' })).toBe(0);
    expect(pgnDate({})).toBe(0);
  });
});

describe('pgnGameToRaw', () => {
  it('converts a Lichess export', () => {
    const raw = pgnGameToRaw(parsePgnGame(LICHESS_GAME, 40))!;
    expect(raw).toMatchObject({
      platform: 'lichess',
      sourceId: 'y55rRync',
      url: 'https://lichess.org/y55rRync',
      playedAt: Date.UTC(2026, 8, 30, 19, 31, 2),
      white: 'hero',
      black: 'jzvwg6712',
      whiteRating: 1446,
      blackRating: 1666,
      speed: 'rapid',
      rated: true,
      result: '1-0',
      plyCount: 46,
    });
    expect(raw.moves).toHaveLength(40);
    expect(raw.moves.slice(0, 4)).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    expect(raw.moves[14]).toBe('e1g1');
  });

  it('detects Lichess ids from long ids and colour suffixes, but not site routes', () => {
    expect(pgnGameToRaw(game({ Site: 'https://lichess.org/AbCd1234WxYz/black' }))).toMatchObject({ platform: 'lichess', sourceId: 'AbCd1234' });
    expect(pgnGameToRaw(game({ Site: 'lichess.org/AbCd1234#12' }))).toMatchObject({ platform: 'lichess', sourceId: 'AbCd1234' });
    expect(pgnGameToRaw(game({ Site: 'https://lichess.org/analysis' }))!.platform).toBe('pgn');
    expect(pgnGameToRaw(game({ Site: 'https://lichess.org/study/AbCd1234' }))!.platform).toBe('pgn');
    expect(pgnGameToRaw(game({ Site: 'https://lichess.org/AbCd12345' }))!.platform).toBe('pgn');
  });

  it('detects Chess.com games from the Link header', () => {
    const live = pgnGameToRaw(game({ Event: 'Live Chess', Site: 'Chess.com', Link: 'https://www.chess.com/game/live/123456789', WhiteElo: '1500', BlackElo: '1490', TimeControl: '180' }))!;
    expect(live).toMatchObject({ platform: 'chesscom', sourceId: 'live/123456789', url: 'https://www.chess.com/game/live/123456789', speed: 'blitz', rated: true });
    expect(pgnGameToRaw(game({ Site: 'Chess.com', Link: 'https://www.chess.com/game/daily/987' }))).toMatchObject({ platform: 'chesscom', sourceId: 'daily/987' });
    expect(pgnGameToRaw(game({ Link: 'https://www.chess.com/live/game/42' }))).toMatchObject({ platform: 'chesscom', sourceId: 'live/42' });
  });

  it('hashes other games deterministically', () => {
    const headers = { Event: 'Club', Site: 'Berlin', White: 'Anna', Black: 'Ben', Date: '2025.05.01' };
    const a = pgnGameToRaw(game(headers))!;
    expect(a.platform).toBe('pgn');
    expect(a.sourceId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.url).toBeUndefined();
    expect(pgnGameToRaw(game(headers))!.sourceId).toBe(a.sourceId);
    expect(pgnGameToRaw(game(headers, '1. d4 d5 *'))!.sourceId).not.toBe(a.sourceId);
    expect(pgnGameToRaw(game({ ...headers, Site: 'https://example.com/g/1' }))!.url).toBe('https://example.com/g/1');
  });

  it('accepts a [FEN] that is the standard start, rejects any other start', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(pgnGameToRaw(game({ Variant: 'From Position', SetUp: '1', FEN: start }))!.moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    expect(pgnGameToRaw(game({ SetUp: '1', FEN: start.replace(' 0 1', '') }))).not.toBeNull();
    expect(pgnGameToRaw(game({ Variant: 'Standard' }))).not.toBeNull();
    expect(pgnGameToRaw(game({ SetUp: '1', FEN: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' }, '1... e5 *'))).toBeNull();
    expect(pgnGameToRaw(game({ Variant: 'From Position', FEN: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' }, '1. O-O *'))).toBeNull();
  });

  it('rejects variants', () => {
    expect(pgnGameToRaw(game({ Variant: 'Chess960' }))).toBeNull();
    expect(pgnGameToRaw(game({ Variant: 'Chess960', SetUp: '1', FEN: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }))).toBeNull();
    expect(pgnGameToRaw(game({ Variant: 'Crazyhouse' }))).toBeNull();
    expect(pgnGameToRaw(game({ Variant: 'Atomic' }))).toBeNull();
  });

  it('rejects games without a legal first move and truncates at the first illegal one', () => {
    expect(pgnGameToRaw(game({}, '*'))).toBeNull();
    expect(pgnGameToRaw(game({}, '1. e5 e4 *'))).toBeNull();
    const raw = pgnGameToRaw(game({}, '1. e4 e5 2. Ke3 Nc6 3. Nf3 *'))!;
    expect(raw.moves).toEqual(['e2e4', 'e7e5']);
    expect(raw.plyCount).toBe(5);
  });

  it('reads rated/casual, missing names, ratings and speed from the event name', () => {
    expect(pgnGameToRaw(game({ Event: 'Casual Blitz game', TimeControl: '300+0', WhiteElo: '1500' }))!.rated).toBe(false);
    expect(pgnGameToRaw(game({ Event: 'Rated Bullet game' }))).toMatchObject({ rated: true, speed: 'bullet' });
    const bare = pgnGameToRaw(game({ WhiteElo: '?', BlackElo: '0' }))!;
    expect(bare).toMatchObject({ white: '?', black: '?', rated: false, speed: 'unknown', result: '*', playedAt: 0 });
    expect(bare.whiteRating).toBeUndefined();
    expect(bare.blackRating).toBeUndefined();
  });
});
