// Real-engine integration: the vendored Stockfish 19 lite WASM, run as Node child processes.
import { describe, expect, it } from 'vitest';
import { START_FEN } from '../core/chess';
import type { PositionEval } from '../core/types';
import { UciEngine } from './engine';
import { createNodeEngineWorker } from './nodeWorker';
import { EnginePool } from './pool';

const ITALIAN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'; // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5
const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'; // 1.e4 e5 2.Nf3, Black to move
const DEPTH = 8;

const TASKS: { fen: string; moves: string[] }[] = [
  { fen: START_FEN, moves: ['e2e4', 'g2g4', 'f2f3'] },
  { fen: ITALIAN, moves: ['e1h1', 'c2c3', 'd2d3', 'a1a5'] }, // O-O as king-takes-rook; a1a5 is illegal
  { fen: AFTER_NF3, moves: ['b8c6', 'f7f6', 'd7d6'] },
];

function cp(ev: PositionEval, move: string): number {
  const line = ev.moves[move];
  if (!line) throw new Error(`${move} was not evaluated`);
  if (line.score.cp === undefined) throw new Error(`${move}: expected a centipawn score`);
  return line.score.cp;
}

function withoutTimestamp(ev: PositionEval): Omit<PositionEval, 'updatedAt'> {
  const { updatedAt: _ignored, ...rest } = ev;
  return rest;
}

describe('createNodeEngineWorker', () => {
  it('runs the vendored engine over stdio', async () => {
    const engine = new UciEngine(createNodeEngineWorker());
    try {
      await engine.init();
      const r = await engine.search({ fen: START_FEN, depth: 6 });
      expect(r.line.depth).toBe(6);
      expect(r.line.pv[0]).toBe(r.line.move);
      expect(r.nodes).toBeGreaterThan(0);
    } finally {
      engine.terminate();
    }
  });

  it('confirms the searchmoves trap: an e1h1 entry is ignored, and the engine layer rejects the result', async () => {
    const engine = new UciEngine(createNodeEngineWorker());
    try {
      await expect(engine.search({ fen: ITALIAN, depth: 6, searchMoves: ['e1h1'] })).rejects.toThrow(/ignored searchmoves/);
      const r = await engine.search({ fen: ITALIAN, depth: 6, searchMoves: ['e1g1'] });
      expect(r.line.move).toBe('e1g1');
    } finally {
      engine.terminate();
    }
  });

  it('aborts a long search with stop and keeps the engine usable', async () => {
    const engine = new UciEngine(createNodeEngineWorker());
    try {
      await engine.init();
      const ac = new AbortController();
      const long = engine.search({ fen: ITALIAN, depth: 40, signal: ac.signal });
      setTimeout(() => ac.abort(), 150);
      await expect(long).rejects.toMatchObject({ name: 'AbortError' });
      const r = await engine.search({ fen: START_FEN, depth: 5, searchMoves: ['d2d4'] });
      expect(r.line).toMatchObject({ move: 'd2d4', depth: 5 });
      expect(engine.alive).toBe(true);
    } finally {
      engine.terminate();
    }
  });

  it('aborts that race the end of a search never leak a stale bestmove or info line into the next search', async () => {
    const reference = new UciEngine(createNodeEngineWorker());
    const engine = new UciEngine(createNodeEngineWorker());
    try {
      await reference.newGame();
      const expected = (await reference.search({ fen: ITALIAN, depth: 9, searchMoves: ['d2d3'] })).line;
      // Depth 7 takes a few ms: the aborts land before, during and just after the engine's bestmove.
      for (let i = 0; i < 16; i++) {
        const ac = new AbortController();
        const racing = engine.search({ fen: START_FEN, depth: i % 2 ? 7 : 30, signal: ac.signal });
        setTimeout(() => ac.abort(), i % 8);
        const outcome = await racing.then(
          r => r.line.move,
          (e: unknown) => (e as Error).name,
        );
        expect(outcome).toMatch(/^AbortError$|^[a-h][1-8][a-h][1-8]$/);
        await engine.newGame();
        expect((await engine.search({ fen: ITALIAN, depth: 9, searchMoves: ['d2d3'] })).line).toEqual(expected);
      }
      expect(engine.alive).toBe(true);
    } finally {
      reference.terminate();
      engine.terminate();
    }
  });

  it('scores a searchmoves move that walks into mate as mate against the side to move', async () => {
    // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? — Black to move must stop Qxf7#; 4...a6 does not.
    const scholar = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 4 4';
    const engine = new UciEngine(createNodeEngineWorker());
    try {
      const blunder = await engine.search({ fen: scholar, depth: 8, searchMoves: ['a7a6'] });
      expect(blunder.line).toMatchObject({ move: 'a7a6', score: { mate: -1 }, pv: ['a7a6', 'h5f7'] });
      const best = await engine.search({ fen: scholar, depth: 8 });
      expect(best.line.score.cp).toBeDefined();
    } finally {
      engine.terminate();
    }
  });

  it('reports the death of the process through onerror', async () => {
    const worker = createNodeEngineWorker({ enginePath: '/nonexistent/stockfish.js' });
    const error = await new Promise<unknown>(resolve => {
      worker.onerror = resolve;
    });
    expect(String(error)).toMatch(/Engine process exited/);
    worker.terminate();
  });
});

describe('EnginePool with the real engine', () => {
  it('evaluates opening positions sensibly and identically for pool sizes 1 and 3', async () => {
    const single = new EnginePool({ size: 1, createWorker: () => createNodeEngineWorker() });
    const triple = new EnginePool({ size: 3, createWorker: () => createNodeEngineWorker() });
    try {
      // Pool 1 runs the positions one after another on one engine, in reverse order; pool 3 runs each
      // on its own fresh engine. ucinewgame before every position makes the results identical.
      const reversed = [...TASKS].reverse();
      const fromSingle = (await Promise.all(reversed.map(t => single.evaluatePosition(t.fen, t.moves, { depth: DEPTH })))).reverse();
      const fromTriple = await Promise.all(TASKS.map(t => triple.evaluatePosition(t.fen, t.moves, { depth: DEPTH })));
      expect(fromTriple.map(withoutTimestamp)).toEqual(fromSingle.map(withoutTimestamp));

      const [start, italian, nf3] = fromTriple as [PositionEval, PositionEval, PositionEval];
      // Start position: the flank pawn moves are clearly worse than 1.e4.
      expect(cp(start, 'g2g4')).toBeLessThan(cp(start, 'e2e4') - 50);
      expect(cp(start, 'f2f3')).toBeLessThan(cp(start, 'e2e4') - 30);
      for (const line of Object.values(start.moves)) expect(line.depth).toBe(DEPTH);

      // Italian: e1h1 was searched as e1g1 (standard UCI), the illegal a1a5 was dropped.
      expect(Object.keys(italian.moves).sort()).toEqual([...new Set([italian.best.move, 'c2c3', 'd2d3', 'e1g1'])].sort());
      expect(italian.moves.e1g1?.pv[0]).toBe('e1g1');
      if (italian.best.move !== 'e1g1') expect(italian.moves.e1g1?.score).not.toEqual(italian.best.score);

      // Black to move: 2...f6 (Damiano) is worse than 2...Nc6, scores are from Black's point of view.
      expect(cp(nf3, 'f7f6')).toBeLessThan(cp(nf3, 'b8c6') - 50);
      expect(nf3.posKey).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -');
    } finally {
      single.terminate();
      triple.terminate();
    }
  });
});
