// One leak in full: the position (your habit in orange, the best move in blue), the headline in plain
// words, why it fails, the lines (step through them on the board), your results with the habit vs other
// moves, the games where it happened, engine details, and the actions (train, master, repertoire,
// snooze, copy FEN, open on Lichess) with undo.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { START_FEN } from '../../core/chess';
import { filterOccurrences } from '../../core/filters';
import type { Color, Mistake, MistakeStatus, Occurrence, ViewMistake } from '../../core/types';
import { Board, arrowFromUci, type BoardArrow } from '../components/Board';
import { CopyButton } from '../components/buttons';
import { EvalText } from '../components/EvalText';
import { colorName, moveLabel, plural, relativeTime, shortDate, sideToMove, speedName } from '../components/format';
import { GameLink } from '../components/GameLink';
import { isKeyShortcut, isPageTarget } from '../components/gestures';
import { runAction, toast } from '../components/hooks';
import { shortcutsOn } from '../components/keyboard';
import { Icon } from '../components/Icon';
import { OutcomeBadge } from '../components/LeakListItem';
import {
  habitLabel,
  headlineOf,
  leakBoardLabel,
  frequencyText,
  lichessAnalysisUrl,
  outcomeBadge,
  punishmentOf,
  punishmentText,
  scoreSplit,
  type LeakTab,
} from '../components/leakView';
import { LineView, useLineCursor, type LineSource } from '../components/LineView';
import { Banner } from '../components/Notice';
import { ScoreBar } from '../components/ScoreBar';
import { SeverityPill } from '../components/SeverityPill';
import { href } from '../router';

const DAY_MS = 86_400_000;
const SNOOZE_DAYS = 30;
const GAMES_SHOWN = 6;

export interface LeakNav {
  back: string;
  prev?: string;
  next?: string;
  /** "3 of 23" */
  position?: string;
}

export interface LeakDetailProps {
  m: Mistake;
  /** Counts and scores under the current view filters. */
  view: ViewMistake;
  tab: LeakTab | null;
  orientation: Color;
  onFlip(): void;
  now: number;
  /** Phones: back to the list and previous/next. */
  nav?: LeakNav;
  /** The leak's title is the page's h1 (phones: the detail is a screen of its own), default 2. */
  headingLevel?: 1 | 2;
  /**
   * After master / ignore / snooze / restore, so the page can move to the next leak; returns the leak
   * shown next (named in the toast). `viaKeyboard`: the button was pressed with the keyboard.
   */
  onStatusChange?(m: Mistake, viaKeyboard: boolean): Mistake | undefined | void;
  /** After an Undo of such a change, so the page can come back to this leak. */
  onUndo?(m: Mistake): void;
}

/**
 * Keys that step through the moves: ←/→ when the board has focus or nothing does (they never scroll
 * a page that does not scroll sideways), Home/End only on the board (elsewhere they scroll the page).
 */
export function stepKey(key: string, onBoard: boolean, onPage: boolean): 'back' | 'forward' | 'start' | 'end' | null {
  if (!onBoard && !onPage) return null;
  if (key === 'ArrowLeft') return 'back';
  if (key === 'ArrowRight') return 'forward';
  if (!onBoard) return null;
  return key === 'Home' ? 'start' : key === 'End' ? 'end' : null;
}

export function LeakDetail({ m, view, tab, orientation, onFlip, now, nav, headingLevel = 2, onStatusChange, onUndo }: LeakDetailProps): JSX.Element {
  const lines: Record<string, LineSource> = {
    best: { startFen: m.fen, ucis: m.bestLine },
    played: { startFen: m.fen, ucis: m.playedLine },
  };
  const cursor = useLineCursor(m.path, lines, 'best', m.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isKeyShortcut(e, shortcutsOn.value) || e.shiftKey) return;
      const onBoard = e.target instanceof Element && !!e.target.closest('.ld-board-col .board');
      const step = stepKey(e.key, onBoard, isPageTarget(e.target));
      if (step === 'back') cursor.step(-1);
      else if (step === 'forward') cursor.step(1);
      else if (step === 'start') cursor.toStart();
      else if (step === 'end') cursor.toEnd();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cursor]);

  const arrows = useMemo(
    () => [arrowFromUci(m.move, 'orange'), arrowFromUci(m.bestMove, 'blue')].filter((a): a is BoardArrow => !!a),
    [m.move, m.bestMove],
  );
  const atRoot = cursor.view === null;
  const habit = moveLabel(m.fen, m.move);
  const best = moveLabel(m.fen, m.bestMove);
  const boardLabel = leakBoardLabel(m, cursor.cursor);
  const Title = headingLevel === 1 ? 'h1' : 'h2';
  const Section = headingLevel === 1 ? 'h2' : 'h3';
  const Sub = headingLevel === 1 ? 'h3' : 'h4';

  return (
    <article class="leak-detail" aria-labelledby="ld-title">
      {nav ? <DetailNav nav={nav} /> : null}
      <header class="ld-head">
        <div class="ld-title-row">
          <Title id="ld-title" class="ld-title" tabIndex={-1}>
            <span class="move move-habit">{habitLabel(m)}</span>
          </Title>
          <SeverityPill severity={m.severity} kind={m.kind} confidence={m.confidence} />
        </div>
        <p class="ld-opening">
          {m.openingName ?? 'Unnamed line'}
          {m.openingEco ? <span class="ld-eco"> · {m.openingEco}</span> : null} · as {colorName(m.color)}
        </p>
      </header>
      <StatusBanner m={m} tab={tab} now={now} onStatusChange={onStatusChange} onUndo={onUndo} />

      <div class="ld-grid">
        <div class="ld-board-col">
          <Board
            fen={cursor.view?.fen ?? m.fen}
            orientation={orientation}
            lastMove={atRoot ? m.path[m.path.length - 1] : cursor.view?.lastMove}
            arrows={atRoot ? arrows : []}
            label={boardLabel}
            describedBy="ld-board-keys"
            focusable
          />
          <p id="ld-board-keys" class="sr-only">
            Left and right arrow keys step through the moves; Home and End go to the start of the game and the end of the best line.
          </p>
          <p class="sr-only" aria-live="polite">
            {atRoot ? '' : boardLabel}
          </p>
          <div class="ld-board-bar">
            <div class="board-legend" aria-hidden={!atRoot}>
              <span class={`legend-item legend-habit${atRoot ? '' : ' is-dim'}`}>
                <span class="legend-swatch" />
                <span>Your move</span>
              </span>
              <span class={`legend-item legend-best${atRoot ? '' : ' is-dim'}`}>
                <span class="legend-swatch" />
                <span>Best move</span>
              </span>
            </div>
            <Stepper
              items={[
                { label: 'Starting position', icon: 'first', run: cursor.toStart, enabled: cursor.canBack },
                { label: 'Previous move', icon: 'back', run: () => cursor.step(-1), enabled: cursor.canBack },
                { label: 'Back to the leak position', icon: 'leaks', run: cursor.toRoot, enabled: !atRoot },
                { label: 'Next move', icon: 'chevron', run: () => cursor.step(1), enabled: cursor.canForward },
                { label: 'End of the best line', icon: 'last', run: cursor.toEnd, enabled: true },
                { label: 'Flip the board', icon: 'flip', run: onFlip, enabled: true, title: 'Flip (f)' },
              ]}
            />
          </div>
        </div>

        <div class="ld-info">
          <Headline m={m} view={view} />
          <p class="ld-eval">
            <EvalText from={m.scoreBest} to={m.scorePlayed} sideToMove={sideToMove(m.fen)} user={m.color} />
          </p>
          <p class="ld-why">
            <Icon name="alert" size={18} />
            <span>{punishmentText(habit, punishmentOf(m))}</span>
          </p>
          {m.kind === 'book' ? (
            <p class="ld-note ld-note-book">
              <strong>Book choice.</strong> Objectively dubious, but a valid club repertoire choice: it’s a named opening line,
              so you may well be playing it on purpose.
            </p>
          ) : null}
          {m.confidence === 'low' ? (
            <p class="ld-note">
              <strong>Borderline.</strong> A loss of 5–7.5% is close to the engine’s margin of error; treat this one as a hint
              rather than a verdict.
            </p>
          ) : null}
          <div class="ld-badges">
            <OutcomeBadge badge={outcomeBadge(m)} />
            <span class="small muted">Last played {relativeTime(m.lastPlayedAt, now)}</span>
          </div>
          <Actions m={m} tab={tab} orientation={orientation} onStatusChange={onStatusChange} onUndo={onUndo} />
        </div>
      </div>

      <section class="card ld-section" aria-labelledby="ld-lines-title">
        <Section id="ld-lines-title" class="ld-section-title">
          Lines <span class="small faint">· tap a move to see it on the board</span>
        </Section>
        <LineBlock heading={Sub} title="How you get here">
          <LineView
            startFen={START_FEN}
            ucis={m.path}
            label="Moves that lead to this position"
            current={cursor.cursor?.line === 'path' ? cursor.cursor.index : atRoot ? m.path.length - 1 : undefined}
            onSelect={i => cursor.select('path', i)}
            maxPlies={40}
          />
        </LineBlock>
        <LineBlock heading={Sub} title={<>Better: <span class="move move-best">{best}</span></>}>
          <LineView
            startFen={m.fen}
            ucis={m.bestLine}
            lead="best"
            label="Best line"
            current={cursor.cursor?.line === 'best' ? cursor.cursor.index : undefined}
            onSelect={i => cursor.select('best', i)}
          />
        </LineBlock>
        <LineBlock heading={Sub} title={<>What happens after <span class="move move-habit">{habit}</span></>}>
          <LineView
            startFen={m.fen}
            ucis={m.playedLine}
            lead="habit"
            label={`Engine line after ${habit}`}
            current={cursor.cursor?.line === 'played' ? cursor.cursor.index : undefined}
            onSelect={i => cursor.select('played', i)}
          />
        </LineBlock>
      </section>

      <div class="ld-two">
        <Results m={m} habit={habit} heading={Section} />
        <EngineInfo m={m} now={now} heading={Section} />
      </div>
      <Games key={m.id} m={m} habit={habit} orientation={m.color} heading={Section} />
    </article>
  );
}

function DetailNav({ nav }: { nav: LeakNav }): JSX.Element {
  return (
    <nav class="ld-nav" aria-label="Leak navigation">
      <a class="btn btn-ghost btn-sm ld-back" href={nav.back}>
        <Icon name="back" size={18} /> All leaks
      </a>
      {nav.position ? <span class="small muted num">{nav.position}</span> : null}
      <span class="ld-nav-arrows">
        <NavArrow to={nav.prev} label="Previous leak" icon="back" />
        <NavArrow to={nav.next} label="Next leak" icon="chevron" />
      </span>
    </nav>
  );
}

interface StepperItem {
  label: string;
  icon: 'first' | 'back' | 'leaks' | 'chevron' | 'last' | 'flip';
  run(): void;
  enabled: boolean;
  title?: string;
}

/**
 * The move stepper as a toolbar: one Tab stop, ←/→ (and Home/End) move between its buttons, Enter or
 * Space presses one. Unavailable buttons stay focusable (aria-disabled), so focus is never lost when
 * the end of a line is reached.
 */
function Stepper({ items }: { items: readonly StepperItem[] }): JSX.Element {
  const [active, setActive] = useState(3); // "Next move"
  const bar = useRef<HTMLDivElement>(null);
  const focusAt = (i: number): void => {
    const n = items.length;
    const next = ((i % n) + n) % n;
    setActive(next);
    bar.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const i = active;
    if (e.key === 'ArrowRight') focusAt(i + 1);
    else if (e.key === 'ArrowLeft') focusAt(i - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(items.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div class="stepper" role="toolbar" aria-label="Step through the moves" ref={bar} onKeyDown={onKeyDown}>
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          tabIndex={i === active ? 0 : -1}
          aria-disabled={item.enabled ? undefined : 'true'}
          aria-label={item.label}
          title={item.title}
          onFocus={() => setActive(i)}
          onClick={() => {
            if (item.enabled) item.run();
          }}
        >
          <Icon name={item.icon} size={18} />
        </button>
      ))}
    </div>
  );
}

function NavArrow({ to, label, icon }: { to?: string; label: string; icon: 'back' | 'chevron' }): JSX.Element {
  if (!to) {
    return (
      <button type="button" class="btn btn-ghost btn-icon btn-sm" disabled aria-label={label}>
        <Icon name={icon} size={18} />
      </button>
    );
  }
  return (
    <a class="btn btn-ghost btn-icon btn-sm" href={to} aria-label={label}>
      <Icon name={icon} size={18} />
    </a>
  );
}

function Headline({ m, view }: { m: Mistake; view: ViewMistake }): JSX.Element {
  const h = headlineOf(m, view.viewCount, view.viewPositionCount);
  return (
    <p class="ld-headline">
      You play <span class="move move-habit">{h.habit}</span> {frequencyText(h)}. It costs about{' '}
      <strong class="num">{h.lossPct}%</strong> winning chances <span class="muted">({h.pawns})</span>. Better:{' '}
      <span class="move move-best">{h.best}</span>.
    </p>
  );
}

type HeadingTag = 'h2' | 'h3' | 'h4';

function LineBlock({ heading: Heading, title, children }: { heading: HeadingTag; title: ComponentChildren; children: ComponentChildren }): JSX.Element {
  return (
    <div class="ld-line">
      <Heading class="ld-line-title">{title}</Heading>
      {children}
    </div>
  );
}

// ── Status and actions ──────────────────────────────────────────────────

interface Snapshot {
  status: MistakeStatus;
  ignoreReason?: Mistake['ignoreReason'];
  snoozedUntil?: number;
}

const snapshot = (m: Mistake): Snapshot => ({ status: m.status, ignoreReason: m.ignoreReason, snoozedUntil: m.snoozedUntil });

/** Puts a mistake back the way it was (status, reason, and the remaining snooze). */
function restoreSnapshot(id: string, s: Snapshot): Promise<void> {
  const left = s.snoozedUntil !== undefined ? (s.snoozedUntil - Date.now()) / DAY_MS : 0;
  return store.setMistakeStatus(id, s.status, {
    ...(s.status === 'ignored' ? { reason: s.ignoreReason ?? 'other' } : {}),
    ...(left > 0 ? { snoozeDays: left } : {}),
  });
}

type StatusAction = 'mastered' | 'repertoire' | 'snooze' | 'restore';

const DONE_TEXT: Readonly<Record<StatusAction, string>> = {
  mastered: 'Marked as mastered.',
  repertoire: 'Marked as your repertoire — it won’t be listed or trained.',
  snooze: `Snoozed for ${SNOOZE_DAYS} days.`,
  restore: 'Back in your active leaks.',
};
const MOVED_TO: Readonly<Record<StatusAction, string>> = { mastered: 'Mastered', repertoire: 'Ignored', snooze: 'Snoozed', restore: 'Active' };

/**
 * The toast after a status change, naming the leak that moved and the one now shown:
 * "Marked as mastered. 2…c4?? moved to Mastered. Now showing 3…Qa5?."
 */
export function statusToastText(action: StatusAction, moved: string, next?: string): string {
  return `${DONE_TEXT[action]} ${moved} moved to ${MOVED_TO[action]}.${next ? ` Now showing ${next}.` : ''}`;
}

/**
 * Changes a leak's status with an Undo toast; `after` runs on success (and returns the leak shown
 * next), `undone` after an undo. With `viaKeyboard`, focus moves to the toast's Undo button and back
 * to the leak's title when the toast closes.
 */
export async function changeStatus(
  m: Mistake,
  action: StatusAction,
  after?: (m: Mistake, viaKeyboard: boolean) => Mistake | undefined | void,
  undone?: (m: Mistake) => void,
  opts: { viaKeyboard?: boolean } = {},
): Promise<void> {
  const before = snapshot(m);
  const viaKeyboard = opts.viaKeyboard ?? false;
  const ok = await runAction(() =>
    action === 'mastered' ? store.setMistakeStatus(m.id, 'mastered')
    : action === 'repertoire' ? store.setMistakeStatus(m.id, 'ignored', { reason: 'repertoire' })
    : action === 'snooze' ? store.setMistakeStatus(m.id, 'active', { snoozeDays: SNOOZE_DAYS })
    : store.setMistakeStatus(m.id, 'active'),
  );
  if (!ok) return;
  const next = after?.(m, viaKeyboard) ?? undefined;
  toast(
    'success',
    statusToastText(action, habitLabel(m), next ? habitLabel(next) : undefined),
    {
      label: 'Undo',
      run: () => void runAction(() => restoreSnapshot(m.id, before)).then(ok => ok && undone?.(m)),
    },
    { focusAction: viaKeyboard, returnFocus: () => document.getElementById('ld-title') },
  );
}

/** A button press from the keyboard (Enter / Space) has no pointer position and detail 0. */
const fromKeyboard = (e: MouseEvent): boolean => e.detail === 0;

type OnStatusChange = LeakDetailProps['onStatusChange'];

function StatusBanner({ m, tab, now, onStatusChange, onUndo }: { m: Mistake; tab: LeakTab | null; now: number; onStatusChange?: OnStatusChange; onUndo?(m: Mistake): void }): JSX.Element | null {
  const restore = (
    <button type="button" class="btn btn-sm" onClick={e => void changeStatus(m, 'restore', onStatusChange, onUndo, { viaKeyboard: fromKeyboard(e) })}>
      <Icon name="repeat" size={16} /> Restore
    </button>
  );
  if (tab === 'mastered') {
    return (
      <Banner tone="good" title="You marked this as mastered" actions={restore}>
        {relativeTime(m.updatedAt, now)} · it no longer appears in your list or training.
      </Banner>
    );
  }
  if (tab === 'ignored') {
    return (
      <Banner tone="info" icon="openings" title={m.ignoreReason === 'repertoire' ? 'Marked as your repertoire' : 'Ignored'} actions={restore}>
        Hidden from your leaks and training.
      </Banner>
    );
  }
  if (tab === 'snoozed') {
    return (
      <Banner tone="info" icon="clock" title={`Snoozed until ${shortDate(m.snoozedUntil ?? now)}`} actions={restore}>
        It comes back to your list and training then.
      </Banner>
    );
  }
  if (tab === null) {
    return (
      <Banner tone="info" title="No longer flagged">
        Your latest analysis doesn’t count this move as a leak any more; it is kept for its training history.
      </Banner>
    );
  }
  return null;
}

function Actions({ m, tab, orientation, onStatusChange, onUndo }: { m: Mistake; tab: LeakTab | null; orientation: Color; onStatusChange?: OnStatusChange; onUndo?(m: Mistake): void }): JSX.Element {
  const listed = tab === 'active';
  const act = (action: StatusAction) => (e: MouseEvent) => void changeStatus(m, action, onStatusChange, onUndo, { viaKeyboard: fromKeyboard(e) });
  return (
    <div class="ld-actions">
      <a class="btn btn-primary ld-train" href={href('train', undefined, { leak: m.shortId })}>
        <Icon name="play" size={18} /> Train this now
      </a>
      {listed ? (
        <div class="ld-action-grid">
          <button type="button" class="btn" onClick={act('mastered')}>
            <Icon name="check" size={18} /> Mark mastered
          </button>
          <button type="button" class="btn" onClick={act('repertoire')}>
            <Icon name="openings" size={18} /> This is my repertoire
          </button>
          <button type="button" class="btn" onClick={act('snooze')}>
            <Icon name="clock" size={18} /> Snooze {SNOOZE_DAYS} days
          </button>
        </div>
      ) : null}
      <div class="ld-action-links">
        <CopyButton text={m.fen} label="Copy FEN" class="btn btn-ghost btn-sm" />
        <a class="btn btn-ghost btn-sm" href={lichessAnalysisUrl(m.fen, orientation)} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={16} /> Open on Lichess
          <span class="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </div>
  );
}

// ── Results, engine, games ──────────────────────────────────────────────

function Results({ m, habit, heading: Heading }: { m: Mistake; habit: string; heading: HeadingTag }): JSX.Element {
  const split = scoreSplit(m, store.filters.value);
  return (
    <section class="card ld-section" aria-labelledby="ld-results-title">
      <Heading id="ld-results-title" class="ld-section-title">
        Your results from here
      </Heading>
      <dl class="ld-results">
        <div>
          <dt>
            With <span class="move move-habit">{habit}</span>
          </dt>
          <dd>
            <ScoreBar score={split.habit.score} label={`Score with ${habit}`} />
            <span class="small muted">{plural(split.habit.games, 'game')}</span>
          </dd>
        </div>
        <div>
          <dt>With other moves</dt>
          <dd>
            <ScoreBar score={split.other.score} label="Score with other moves" />
            <span class="small muted">{plural(split.other.games, 'game')}</span>
          </dd>
        </div>
      </dl>
      <p class="tiny faint">Score = wins + ½ draws, in the games that match your filters.</p>
    </section>
  );
}

function EngineInfo({ m, now, heading: Heading }: { m: Mistake; now: number; heading: HeadingTag }): JSX.Element {
  return (
    <section class="card ld-section" aria-labelledby="ld-engine-title">
      <Heading id="ld-engine-title" class="ld-section-title">
        How sure is this?
      </Heading>
      <p class="small">
        Stockfish 19 (in your browser) checked this position to depth <strong class="num">{m.evalDepth}</strong>{' '}
        <span class="muted">· {relativeTime(m.updatedAt, now)}</span>.
      </p>
      <p class="small muted">
        {m.confidence === 'low'
          ? 'The loss is small enough (under 7.5%) that a deeper search could disagree. Worth a look, not a verdict.'
          : m.winLoss >= 10
            ? 'A loss this size is reliable: deeper searches agree with it.'
            : 'A clear loss; deeper searches rarely change a verdict of this size.'}
      </p>
      <p class="tiny faint">Engine build {m.engine}</p>
    </section>
  );
}

const RESULT_LETTER: Readonly<Record<Occurrence['o'], string>> = { win: 'Won', loss: 'Lost', draw: 'Draw', unknown: '—' };

function Games({ m, habit, orientation, heading: Heading }: { m: Mistake; habit: string; orientation: Color; heading: HeadingTag }): JSX.Element {
  const [all, setAll] = useState(false);
  const f = store.filters.value;
  const occ = useMemo(() => filterOccurrences(m.occurrences, f), [m.occurrences, f]);
  const shown = all ? occ : occ.slice(0, GAMES_SHOWN);
  return (
    <section class="card ld-section" aria-labelledby="ld-games-title">
      <Heading id="ld-games-title" class="ld-section-title">
        Your games from this position <span class="small faint num">· {occ.length}</span>
      </Heading>
      {occ.length === 0 ? (
        <p class="small muted">No games match your filters.</p>
      ) : (
        <ul class="ld-games">
          {shown.map(o => {
            const isHabit = o.m === m.move;
            return (
              <li key={o.g} class="ld-game">
                <span class="ld-game-date num">{shortDate(o.t)}</span>
                <span class="ld-game-speed">{speedName(o.s)}</span>
                <span class={`move ${isHabit ? 'move-habit' : 'ld-game-other'}`}>{isHabit ? habit : moveLabel(m.fen, o.m)}</span>
                <span class={`ld-game-result result-${o.o}`}>{RESULT_LETTER[o.o]}</span>
                <GameLink game={o.g} ply={m.ply} color={orientation}>
                  View
                </GameLink>
              </li>
            );
          })}
        </ul>
      )}
      {occ.length > GAMES_SHOWN ? (
        <button type="button" class="link-button small" onClick={() => setAll(a => !a)}>
          {all ? 'Show fewer' : `Show all ${occ.length} games`}
        </button>
      ) : null}
    </section>
  );
}
