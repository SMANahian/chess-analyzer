import { describe, expect, it } from 'vitest';
import { stepCursor, sameCursor, type Cursor, type CursorShape } from './LineView';

// A path of 4 moves to the root, a best line of 3 and a played line of 2 from the root.
const SHAPE: CursorShape = { pathLen: 4, lines: { best: 3, played: 2 }, main: 'best' };
const walk = (c: Cursor, ...deltas: (1 | -1)[]): Cursor => deltas.reduce<Cursor>((cur, d) => stepCursor(cur, d, SHAPE), c);

describe('stepCursor', () => {
  it('steps from the root into the main line and back', () => {
    expect(walk(null, 1)).toEqual({ line: 'best', index: 0 });
    expect(walk(null, 1, 1, 1, 1)).toEqual({ line: 'best', index: 2 }); // stops at the end
    expect(walk({ line: 'best', index: 0 }, -1)).toBeNull();
  });
  it('walks back along the path to the starting position and no further', () => {
    expect(walk(null, -1)).toEqual({ line: 'path', index: 2 });
    expect(walk(null, -1, -1, -1, -1)).toEqual({ line: 'path', index: -1 });
    expect(walk(null, -1, -1, -1, -1, -1)).toEqual({ line: 'path', index: -1 });
    // Forward along the path reaches the root (the last path move is the root itself).
    expect(walk({ line: 'path', index: 1 }, 1)).toEqual({ line: 'path', index: 2 });
    expect(walk({ line: 'path', index: 2 }, 1)).toBeNull();
  });
  it('stays inside a side line and returns to the root from its first move', () => {
    expect(walk({ line: 'played', index: 0 }, 1, 1)).toEqual({ line: 'played', index: 1 });
    expect(walk({ line: 'played', index: 0 }, -1)).toBeNull();
  });
  it('handles an empty path and an empty main line', () => {
    const shape: CursorShape = { pathLen: 0, lines: { best: 0 }, main: 'best' };
    expect(stepCursor(null, 1, shape)).toBeNull();
    expect(stepCursor(null, -1, shape)).toBeNull();
  });
  it('compares cursors by value', () => {
    expect(sameCursor(null, null)).toBe(true);
    expect(sameCursor({ line: 'best', index: 1 }, { line: 'best', index: 1 })).toBe(true);
    expect(sameCursor({ line: 'best', index: 1 }, null)).toBe(false);
  });
});
