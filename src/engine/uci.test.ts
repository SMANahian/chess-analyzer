import { describe, expect, it } from 'vitest';
import { parseBestMove, parseInfo } from './uci';

// Lines captured from the vendored Stockfish 19 lite build (public/engine) running in Node.
describe('parseInfo', () => {
  it('parses a full search line', () => {
    const line =
      'info depth 14 seldepth 26 multipv 1 score cp 21 nodes 175269 nps 515497 hashfull 58 time 340 pv e1g1 g8f6 d2d3 e8g8 b1c3 h7h6 a2a3 d7d6 c3a4 c8g4 h2h3';
    expect(parseInfo(line)).toEqual({
      depth: 14,
      seldepth: 26,
      multipv: 1,
      score: { cp: 21 },
      nodes: 175269,
      nps: 515497,
      timeMs: 340,
      pv: ['e1g1', 'g8f6', 'd2d3', 'e8g8', 'b1c3', 'h7h6', 'a2a3', 'd7d6', 'c3a4', 'c8g4', 'h2h3'],
    });
  });

  it('parses negative scores and single-move PVs', () => {
    expect(parseInfo('info depth 1 seldepth 2 multipv 1 score cp -12 nodes 1 nps 1000 hashfull 0 time 1 pv a1b2')).toMatchObject({
      score: { cp: -12 },
      pv: ['a1b2'],
    });
  });

  it('marks bound lines (seen as the final line after stop / go movetime)', () => {
    const upper = parseInfo('info depth 15 seldepth 19 multipv 1 score cp 16 upperbound nodes 207640 nps 508921 hashfull 69 time 408 pv e1g1 g8f6');
    expect(upper).toMatchObject({ depth: 15, score: { cp: 16 }, bound: 'upper', nodes: 207640, timeMs: 408, pv: ['e1g1', 'g8f6'] });
    const lower = parseInfo('info depth 17 seldepth 24 multipv 1 score cp -27 lowerbound nodes 142599 nps 475330 hashfull 44 time 300 pv e7e5 g1f3');
    expect(lower).toMatchObject({ score: { cp: -27 }, bound: 'lower' });
    expect(parseInfo('info depth 13 seldepth 13 multipv 1 score cp 28 nodes 30017 nps 435028 hashfull 8 time 69 pv g1f3')!.bound).toBeUndefined();
  });

  it('parses mate scores for both sides', () => {
    expect(parseInfo('info depth 5 seldepth 2 multipv 1 score mate 1 nodes 100 nps 10000 hashfull 0 time 10 pv d1d8')).toMatchObject({
      score: { mate: 1 },
      pv: ['d1d8'],
    });
    expect(parseInfo('info depth 2 seldepth 3 multipv 1 score mate -1 nodes 5 nps 625 hashfull 0 time 8 pv a8b8 h1h8')).toMatchObject({
      score: { mate: -1 },
      pv: ['a8b8', 'h1h8'],
    });
  });

  it('parses the line sent when the side to move is already mated', () => {
    expect(parseInfo('info depth 0 score mate 0')).toEqual({ depth: 0, score: { mate: 0 } });
  });

  it('reads multipv and wdl lines', () => {
    const line = 'info depth 20 seldepth 30 multipv 2 score cp 25 wdl 60 900 40 nodes 1 nps 1 time 1 pv e2e4';
    expect(parseInfo(line)).toEqual({ depth: 20, seldepth: 30, multipv: 2, score: { cp: 25 }, nodes: 1, nps: 1, timeMs: 1, pv: ['e2e4'] });
  });

  it('ignores info string, currmove and non-info lines', () => {
    expect(parseInfo('info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))')).toBeNull();
    expect(parseInfo('info string Network replica 1: Local memory. Shared memory not supported by the OS.')).toBeNull();
    expect(parseInfo('info depth 10 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseInfo('info WillOutputEngineDownloadProgress')).toBeNull();
    expect(parseInfo('bestmove e2e4 ponder e7e5')).toBeNull();
    expect(parseInfo('Stockfish 19 Lite WASM by the Stockfish developers (see AUTHORS file)')).toBeNull();
    expect(parseInfo('No such option: Foo')).toBeNull();
    expect(parseInfo('')).toBeNull();
  });

  it('tolerates extra whitespace and a trailing CR', () => {
    expect(parseInfo('info  depth 3 score cp 15  pv e2e4 e7e5\r')).toEqual({ depth: 3, score: { cp: 15 }, pv: ['e2e4', 'e7e5'] });
  });

  it('skips malformed numbers instead of producing NaN', () => {
    const info = parseInfo('info depth x seldepth 4 score cp abc nodes 10 pv e2e4');
    expect(info).toEqual({ seldepth: 4, nodes: 10, pv: ['e2e4'] });
  });
});

describe('parseBestMove', () => {
  it('parses a move with ponder', () => {
    expect(parseBestMove('bestmove e1g1 ponder g8f6')).toEqual({ best: 'e1g1', ponder: 'g8f6' });
  });

  it('parses a move without ponder', () => {
    expect(parseBestMove('bestmove d1d8')).toEqual({ best: 'd1d8' });
  });

  it("returns best null for 'bestmove (none)'", () => {
    expect(parseBestMove('bestmove (none)')).toEqual({ best: null });
  });

  it('returns null for other lines', () => {
    expect(parseBestMove('info depth 0 score mate 0')).toBeNull();
    expect(parseBestMove('readyok')).toBeNull();
    expect(parseBestMove('bestmoves')).toBeNull();
  });
});
