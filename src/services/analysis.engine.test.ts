// Real-engine integration: the analysis service with the vendored Stockfish (Node child process) on a
// small planted habit, quick preset. Checks the services against the real pool, not only the fake.
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import * as repo from '../db/repo';
import { useTestDb } from '../db/schema';
import { createNodeEngineWorker } from '../engine/nodeWorker';
import { EnginePool } from '../engine/pool';
import { LINES, storedGame } from './__fixtures__/fakes';
import { analyzeProfile } from './analysis';
import { judgeMove } from './training';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
const pool = new EnginePool({ size: 1, createWorker: () => createNodeEngineWorker(), idleMs: Infinity });

afterAll(() => pool.terminate());

describe('analysis with the real engine', () => {
  it('flags 4.Nxe5? and 5.Nxf7?? in the Blackburne-Shilling trap, nothing in the Giuoco Piano', async () => {
    useTestDb();
    await repo.saveSettings({ preset: 'quick' });
    const id = (await repo.createProfile({ name: 'Hero', kind: 'self', accounts: [], aliases: [] })).id;
    const games = [
      ...[1, 2, 3].map(i => storedGame(id, `t${i}`, LINES.trap!, 'white', NOW - i * DAY)),
      ...[4, 5].map(i => storedGame(id, `i${i}`, LINES.italian!, 'white', NOW - i * DAY)),
    ];
    await repo.addGames(games.map((g, i) => ({ ...g, contentKey: `${g.contentKey}#${i}` })));

    const result = await analyzeProfile(id, { pool, now: () => NOW });
    expect(result.complete).toBe(true);
    const ms = await repo.getMistakes(id);
    const moves = ms.map(m => m.move).sort();
    expect(moves).toContain('f3e5');
    expect(moves).toContain('e5f7');
    expect(ms.every(m => m.color === 'white' && m.evalDepth === 10)).toBe(true);
    const nxe5 = ms.find(m => m.move === 'f3e5')!;
    // Objectively 4.Nxe5 only costs a few points (5.Bxf7+ keeps White in the game); 5.Nxf7 loses.
    expect(nxe5.winLoss).toBeGreaterThanOrEqual(5);
    expect(ms.find(m => m.move === 'e5f7')!.severity).toBe('blunder');
    expect(nxe5.acceptable.length).toBeGreaterThan(0);
    expect(ms.find(m => m.move === 'e5f7')!.dependsOn).toBe(nxe5.id);
    // The Italian moves were never flagged.
    expect(moves.some(m => ['c2c3', 'd2d3', 'e1g1'].includes(m))).toBe(false);
    expect(judgeMove(nxe5, nxe5.bestMove)).toEqual({ kind: 'correct', best: true });
  }, 60_000);
});
