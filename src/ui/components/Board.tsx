// Chessboard: a thin Preact wrapper around @lichess-org/chessground, driven by props.
// Moves leave as standard UCI (castling e1g1, promotions e7e8n) via core/chess. Under-promotions go
// through a picker. A controller (via `controller` ref) replays lines with animation and resets the board.
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import type { DrawBrush, DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';
import type { Role, SquareName } from 'chessops/types';
import type { JSX, Ref } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { groundDests, moveFromGround, needsPromotion, playUci, posFromFen } from '../../core/chess';
import type { Color } from '../../core/types';
import { prefersReducedMotion } from './hooks';
import { Icon } from './Icon';
import { PromotionPicker } from './PromotionPicker';

export type ArrowColor = 'blue' | 'orange' | 'green' | 'red';

/** blue = best move, orange = the user's (habit) move; green/red for right/wrong feedback. */
export interface BoardArrow {
  from: SquareName;
  to: SquareName;
  color: ArrowColor;
}

/** Arrow for a standard UCI move ('e1g1' points the king at g1), or undefined for junk. */
export function arrowFromUci(uci: string | undefined, color: ArrowColor): BoardArrow | undefined {
  if (!uci || !/^[a-h][1-8][a-h][1-8]/.test(uci)) return undefined;
  return { from: uci.slice(0, 2) as SquareName, to: uci.slice(2, 4) as SquareName, color };
}

export interface Replay {
  /** true when the line played to the end, false when skipped or interrupted. */
  done: Promise<boolean>;
  skip(): void;
}

export interface BoardController {
  /**
   * Animates `ucis` from `fromFen` (`msPerPly` default 450). With prefers-reduced-motion the final
   * position is shown at once. Tapping the board or the Skip button jumps to the end. The board stays
   * on the final position, view-only, until a prop changes or reset() is called. To avoid a flash of
   * the props' position, call it from a useLayoutEffect. Props that change during a replay are applied
   * when it ends.
   */
  replayLine(fromFen: string, ucis: readonly string[], msPerPly?: number): Replay;
  /** Re-applies the props (after a rejected move, or to leave a replay's final position). */
  reset(): void;
}

export interface BoardProps {
  fen: string;
  orientation?: Color;
  /** Lets the side to move play (legal moves only). Default false. */
  interactive?: boolean;
  /** Called with standard UCI after a legal user move. The board then shows the move, view-only, until props change. */
  onMove?(uci: string): void;
  arrows?: readonly BoardArrow[];
  /** Standard UCI of the move that led to `fen` (highlighted). */
  lastMove?: string;
  /** Highlight the king of the side to move; default: whether the FEN is check. */
  check?: boolean;
  /** Show a–h / 1–8 (fixed at mount). Default true. */
  coordinates?: boolean;
  /** Accessible description, e.g. "Position after 5…Nc6. You are White, to move." */
  label?: string;
  controller?: Ref<BoardController | null>;
  class?: string;
}

const brush = (key: string, color: string): DrawBrush => ({ key, color, opacity: 0.9, lineWidth: 11 });
/** Colour-blind-safe pair: blue (best) vs orange (habit). Literal colours: SVG attributes cannot read CSS variables. */
const BRUSHES: DrawBrushes = {
  blue: brush('cb', '#1f6fe5'),
  orange: brush('co', '#f08000'),
  green: brush('cg', '#1f8a3b'),
  red: brush('cr', '#c8302a'),
  yellow: brush('cy', '#e6b800'),
};
const ANIMATION_MS = 200;
const DEFAULT_PLY_MS = 450;

const squares = (uci: string | undefined): Key[] | undefined =>
  uci && uci.length >= 4 ? [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key] : undefined;

function shapesOf(arrows: readonly BoardArrow[] | undefined): DrawShape[] {
  return (arrows ?? []).map(a => ({ orig: a.from, dest: a.to, brush: a.color }));
}

interface PendingPromotion {
  orig: SquareName;
  dest: SquareName;
  color: Color;
}

export function Board(props: BoardProps): JSX.Element {
  const { fen, orientation = 'white', interactive = false, lastMove, check, arrows, coordinates = true, label } = props;
  const groundRef = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const replay = useRef<{ skip(): void } | null>(null);
  const syncAfterReplay = useRef(false);
  const [replaying, setReplaying] = useState(false);
  const [promotion, setPromotion] = useState<PendingPromotion | null>(null);
  const shownOrientation = useRef<Color>(orientation);

  /** Applies the current props to chessground. */
  const sync = (): void => {
    const ground = api.current;
    if (!ground) return;
    const p = propsRef.current;
    const pos = posFromFen(p.fen);
    const canMove = (p.interactive ?? false) && pos !== undefined && !pos.isEnd();
    const orient = p.orientation ?? 'white';
    ground.set({
      fen: p.fen,
      orientation: orient,
      turnColor: pos?.turn ?? 'white',
      check: p.check ?? pos?.isCheck() ?? false,
      lastMove: squares(p.lastMove),
      movable: { color: canMove ? pos.turn : undefined, dests: canMove ? groundDests(pos) : new Map() },
      drawable: { autoShapes: shapesOf(p.arrows) },
    });
    if (orient !== shownOrientation.current) {
      shownOrientation.current = orient;
      ground.redrawAll(); // coordinates are laid out per orientation
    }
  };

  const onUserMove = (orig: Key, dest: Key): void => {
    const p = propsRef.current;
    const pos = posFromFen(p.fen);
    if (!pos) return sync();
    if (needsPromotion(pos, orig as SquareName, dest as SquareName)) {
      setPromotion({ orig: orig as SquareName, dest: dest as SquareName, color: pos.turn });
      return;
    }
    finishMove(orig as SquareName, dest as SquareName);
  };

  const finishMove = (orig: SquareName, dest: SquareName, role?: Role): void => {
    const p = propsRef.current;
    const pos = posFromFen(p.fen);
    const uci = pos ? moveFromGround(pos, orig, dest, role) : undefined;
    const after = uci ? playUci(p.fen, uci) : undefined;
    if (!uci || !after) return sync();
    const next = posFromFen(after);
    // Show the position after the move (also replaces the pawn chessground leaves on the last rank).
    api.current?.set({
      fen: after,
      turnColor: next?.turn,
      check: next?.isCheck() ?? false,
      lastMove: squares(uci),
      movable: { color: undefined, dests: new Map() },
      drawable: { autoShapes: [] },
    });
    p.onMove?.(uci);
  };

  // Mount chessground once (layout effect: before paint, and before a parent's layout effect replays).
  useLayoutEffect(() => {
    const el = groundRef.current;
    if (!el) return;
    const config: Config = {
      coordinates,
      animation: { enabled: !prefersReducedMotion(), duration: ANIMATION_MS },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, rookCastle: false, events: { after: (o, d) => onUserMove(o, d) } },
      premovable: { enabled: false },
      draggable: { enabled: true, showGhost: true },
      selectable: { enabled: true },
      drawable: { enabled: true, visible: true, brushes: BRUSHES },
      disableContextMenu: true,
    };
    api.current = Chessground(el, config);
    sync();
    return () => {
      replay.current?.skip();
      api.current?.destroy();
      api.current = null;
      el.innerHTML = ''; // destroy() leaves the DOM
    };
    // Mounted once: handlers read the latest props through propsRef.
  }, []);

  const arrowsKey = (arrows ?? []).map(a => `${a.from}${a.to}${a.color}`).join(',');
  useEffect(() => {
    // During a replay the new props are applied when it ends.
    if (replay.current) {
      syncAfterReplay.current = true;
      return;
    }
    setPromotion(null);
    sync();
  }, [fen, orientation, interactive, lastMove, check, arrowsKey]);

  const controller: BoardController = {
    replayLine(fromFen, ucis, msPerPly = DEFAULT_PLY_MS) {
      replay.current?.skip();
      syncAfterReplay.current = false;
      return startReplay(fromFen, ucis, msPerPly);
    },
    reset() {
      replay.current?.skip();
      setPromotion(null);
      sync();
    },
  };
  useLayoutEffect(() => assignRef(props.controller, controller));
  useLayoutEffect(() => () => assignRef(props.controller, null), [props.controller]);

  function startReplay(fromFen: string, ucis: readonly string[], msPerPly: number): Replay {
    const frames = replayFrames(fromFen, ucis);
    const ground = api.current;
    const show = (f: Frame): void =>
      ground?.set({ fen: f.fen, turnColor: f.turn, check: f.check, lastMove: squares(f.lastMove), movable: { color: undefined, dests: new Map() } });
    const last = frames[frames.length - 1];
    if (!ground || !last) return { done: Promise.resolve(true), skip: () => undefined };
    ground.set({ drawable: { autoShapes: [] } });
    if (prefersReducedMotion() || frames.length === 1) {
      show(last);
      return { done: Promise.resolve(true), skip: () => undefined };
    }
    show(frames[0]!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolve: (complete: boolean) => void = () => undefined;
    const done = new Promise<boolean>(r => (resolve = r));
    const finish = (complete: boolean): void => {
      clearTimeout(timer);
      if (replay.current === handle) replay.current = null;
      setReplaying(false);
      if (syncAfterReplay.current) {
        syncAfterReplay.current = false;
        sync();
      }
      resolve(complete);
    };
    const handle = {
      skip: (): void => {
        if (replay.current !== handle) return;
        show(last);
        finish(false);
      },
    };
    const step = (i: number): void => {
      const frame = frames[i];
      if (!frame) return finish(true);
      show(frame);
      timer = setTimeout(() => step(i + 1), msPerPly);
    };
    replay.current = handle;
    setReplaying(true);
    timer = setTimeout(() => step(1), msPerPly);
    return { done, skip: handle.skip };
  }

  const pickPromotion = (role: Role | null): void => {
    const pending = promotion;
    setPromotion(null);
    if (!pending || !role) return sync();
    finishMove(pending.orig, pending.dest, role);
  };

  return (
    <div
      class={`board${replaying ? ' is-replaying' : ''}${props.class ? ` ${props.class}` : ''}`}
      role="group"
      aria-label={label ?? 'Chess board'}
    >
      <div class="board-ground" ref={groundRef} />
      {promotion ? <PromotionPicker {...promotion} orientation={orientation} onPick={pickPromotion} /> : null}
      {replaying ? (
        <button type="button" class="board-skip" onClick={() => replay.current?.skip()} aria-label="Skip the replay">
          <span class="board-skip-hit" aria-hidden="true" />
          <span class="board-skip-chip">
            Skip <Icon name="skip" size={16} />
          </span>
        </button>
      ) : null}
    </div>
  );
}

export interface Frame {
  fen: string;
  turn: Color;
  check: boolean;
  lastMove?: string;
}

/** Positions of a replay: the start, then after each move. Stops at the first illegal move. */
export function replayFrames(fromFen: string, ucis: readonly string[]): Frame[] {
  const start = posFromFen(fromFen);
  if (!start) return [];
  const frames: Frame[] = [{ fen: fromFen, turn: start.turn, check: start.isCheck() }];
  let fen = fromFen;
  for (const uci of ucis) {
    const next = playUci(fen, uci);
    const pos = next ? posFromFen(next) : undefined;
    if (!next || !pos) break;
    frames.push({ fen: next, turn: pos.turn, check: pos.isCheck(), lastMove: uci });
    fen = next;
  }
  return frames;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}
