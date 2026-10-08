// A line of moves as a chess player reads it ("6…Nxe4 7.Qe2 d5"), each move a button that shows its
// position on the board. useLineCursor steps through "how you got here" → the position → a line from it.
import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { START_FEN } from '../../core/chess';
import { lineMoves, type LineMove } from './leakView';

export interface LineViewProps {
  startFen: string;
  ucis: readonly string[];
  /** Index of the move whose position the board shows (none when undefined). */
  current?: number;
  onSelect?(index: number): void;
  /** Colour of the first move: the best move (blue) or the habit (orange). */
  lead?: 'best' | 'habit';
  /** Accessible name of the list, e.g. "Best line". */
  label: string;
  maxPlies?: number;
}

export function LineView({ startFen, ucis, current, onSelect, lead, label, maxPlies = 12 }: LineViewProps): JSX.Element {
  const moves = useMemo(() => lineMoves(startFen, ucis.slice(0, maxPlies)), [startFen, ucis, maxPlies]);
  if (moves.length === 0) return <p class="line line-empty muted small">No moves to show.</p>;
  return (
    <ol class="line" aria-label={label}>
      {moves.map(m => (
        <li key={m.index} class="line-ply">
          {m.prefix ? <span class="line-no">{m.prefix}</span> : null}
          <button
            type="button"
            class={`line-move${m.index === 0 && lead ? ` move-${lead}` : ''}`}
            aria-current={m.index === current ? 'step' : undefined}
            aria-label={`${m.prefix}${m.san}: show this position`}
            onClick={() => onSelect?.(m.index)}
            disabled={!onSelect}
          >
            {m.san}
          </button>
        </li>
      ))}
    </ol>
  );
}

// ── Cursor ──────────────────────────────────────────────────────────────

/**
 * null = the root position (the end of the path). `path` index i = the position after path move i
 * (−1 = the starting position); any other line's index i = after that line's move i (from the root).
 */
export type Cursor = { line: string; index: number } | null;

export interface CursorShape {
  pathLen: number;
  /** Length of each line that starts at the root. */
  lines: Readonly<Record<string, number>>;
  /** The line → steps into from the root. */
  main: string;
}

/** One step forward/back along path → root → main line (or within the line the cursor is in). */
export function stepCursor(c: Cursor, delta: 1 | -1, shape: CursorShape): Cursor {
  const { pathLen, lines, main } = shape;
  if (c === null) {
    if (delta === 1) return (lines[main] ?? 0) > 0 ? { line: main, index: 0 } : null;
    return pathLen > 0 ? { line: 'path', index: pathLen - 2 } : null;
  }
  const index = c.index + delta;
  if (c.line === 'path') {
    if (index < -1) return c;
    return index >= pathLen - 1 ? null : { line: 'path', index };
  }
  if (index < 0) return null;
  return index < (lines[c.line] ?? 0) ? { line: c.line, index } : c;
}

export const sameCursor = (a: Cursor, b: Cursor): boolean => a === b || (a !== null && b !== null && a.line === b.line && a.index === b.index);

export interface LineSource {
  startFen: string;
  ucis: readonly string[];
}

export interface LineCursor {
  cursor: Cursor;
  /** Position to show instead of the root, with the move that led to it; null at the root. */
  view: { fen: string; lastMove?: string } | null;
  select(line: string, index: number): void;
  step(delta: 1 | -1): void;
  toStart(): void;
  toEnd(): void;
  toRoot(): void;
  canBack: boolean;
  canForward: boolean;
}

/**
 * Board cursor over `path` (start → root) and `lines` (from the root). `contentKey` must change when
 * the path or lines change (e.g. the mistake id): it resets the cursor and the memoised frames.
 */
export function useLineCursor(path: readonly string[], lines: Readonly<Record<string, LineSource>>, main: string, contentKey: string): LineCursor {
  const [cursor, setCursor] = useState<Cursor>(null);
  useEffect(() => setCursor(null), [contentKey]);

  const frames = useMemo(() => {
    const out: Record<string, LineMove[]> = { path: lineMoves(START_FEN, path) };
    for (const [id, l] of Object.entries(lines)) out[id] = lineMoves(l.startFen, l.ucis);
    return out;
  }, [contentKey]);

  const shape: CursorShape = {
    pathLen: frames.path!.length,
    lines: Object.fromEntries(Object.entries(frames).map(([id, f]) => [id, f.length])),
    main,
  };
  let view: LineCursor['view'] = null;
  if (cursor?.line === 'path' && cursor.index < 0) view = { fen: START_FEN };
  else if (cursor) {
    const frame = frames[cursor.line]?.[cursor.index];
    if (frame) view = { fen: frame.fenAfter, lastMove: frame.uci };
  }
  return {
    cursor,
    view,
    select: (line, index) => setCursor(line === 'path' && index >= shape.pathLen - 1 ? null : { line, index }),
    step: delta => setCursor(c => stepCursor(c, delta, shape)),
    toStart: () => setCursor(shape.pathLen > 0 ? { line: 'path', index: -1 } : null),
    toEnd: () => setCursor((shape.lines[main] ?? 0) > 0 ? { line: main, index: shape.lines[main]! - 1 } : null),
    toRoot: () => setCursor(null),
    canBack: !sameCursor(stepCursor(cursor, -1, shape), cursor),
    canForward: !sameCursor(stepCursor(cursor, 1, shape), cursor),
  };
}
