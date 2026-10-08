// One leak in full: the position (your habit in orange, the best move in blue), the headline in plain
// words, why it fails, the lines (step through them on the board), your results with the habit vs other
// moves, the games where it happened, engine details, and the actions (train, master, repertoire,
// snooze, copy FEN, open on Lichess) with undo.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { START_FEN } from '../../core/chess';
import { filterOccurrences } from '../../core/filters';
import type { Color, Mistake, MistakeStatus, Occurrence, ViewMistake } from '../../core/types';
import { Board, arrowFromUci, type BoardArrow } from '../components/Board';
import { CopyButton } from '../components/buttons';
import { EvalText } from '../components/EvalText';
import { colorName, moveLabel, plural, relativeTime, shortDate, sideToMove, speedName } from '../components/format';
import { GameLink } from '../components/GameLink';
import { isShortcut } from '../components/gestures';
import { runAction, toast } from '../components/hooks';
import { Icon } from '../components/Icon';
import { OutcomeBadge } from '../components/LeakListItem';
import {
  habitLabel,
  headlineOf,
  lastMoveLabel,
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
  /** After master / ignore / snooze / restore, so the page can move to the next leak. */
  onStatusChange?(m: Mistake): void;
  /** After an Undo of such a change, so the page can come back to this leak. */
  onUndo?(m: Mistake): void;
}

export function LeakDetail({ m, view, tab, orientation, onFlip, now, nav, onStatusChange, onUndo }: LeakDetailProps): JSX.Element {
  const lines: Record<string, LineSource> = {
    best: { startFen: m.fen, ucis: m.bestLine },
    played: { startFen: m.fen, ucis: m.playedLine },
  };
  const cursor = useLineCursor(m.path, lines, 'best', m.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isShortcut(e)) return;
      if (e.key === 'ArrowLeft') cursor.step(-1);
      else if (e.key === 'ArrowRight') cursor.step(1);
      else if (e.key === 'Home') cursor.toStart();
      else if (e.key === 'End') cursor.toEnd();
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

  return (
    <article class="leak-detail" aria-labelledby="ld-title">
      {nav ? <DetailNav nav={nav} /> : null}
      <header class="ld-head">
        <div class="ld-title-row">
          <h2 id="ld-title" class="ld-title">
            <span class="move move-habit">{habitLabel(m)}</span>
          </h2>
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
            label={`Position after ${lastMoveLabel(m.path) ?? 'the start'}. ${colorName(m.color)} to move. Orange arrow: your usual ${habit}. Blue arrow: the best move, ${best}.`}
          />
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
            <div class="stepper" role="group" aria-label="Step through the moves">
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={cursor.toStart} disabled={!cursor.canBack} aria-label="Starting position">
                <Icon name="first" size={18} />
              </button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={() => cursor.step(-1)} disabled={!cursor.canBack} aria-label="Previous move">
                <Icon name="back" size={18} />
              </button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={cursor.toRoot} disabled={atRoot} aria-label="Back to the leak position">
                <Icon name="leaks" size={18} />
              </button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={() => cursor.step(1)} disabled={!cursor.canForward} aria-label="Next move">
                <Icon name="chevron" size={18} />
              </button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={cursor.toEnd} aria-label="End of the best line">
                <Icon name="last" size={18} />
              </button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={onFlip} aria-label="Flip the board" title="Flip (f)">
                <Icon name="flip" size={18} />
              </button>
            </div>
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
        <h3 id="ld-lines-title" class="ld-section-title">
          Lines <span class="small faint">· tap a move to see it on the board</span>
        </h3>
        <LineBlock title="How you get here">
          <LineView
            startFen={START_FEN}
            ucis={m.path}
            label="Moves that lead to this position"
            current={cursor.cursor?.line === 'path' ? cursor.cursor.index : atRoot ? m.path.length - 1 : undefined}
            onSelect={i => cursor.select('path', i)}
            maxPlies={40}
          />
        </LineBlock>
        <LineBlock title={<>Better: <span class="move move-best">{best}</span></>}>
          <LineView
            startFen={m.fen}
            ucis={m.bestLine}
            lead="best"
            label="Best line"
            current={cursor.cursor?.line === 'best' ? cursor.cursor.index : undefined}
            onSelect={i => cursor.select('best', i)}
          />
        </LineBlock>
        <LineBlock title={<>What happens after <span class="move move-habit">{habit}</span></>}>
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
        <Results m={m} habit={habit} />
        <EngineInfo m={m} now={now} />
      </div>
      <Games m={m} habit={habit} orientation={m.color} />
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

function NavArrow({ to, label, icon }: { to?: string; label: string; icon: 'back' | 'chevron' }): JSX.Element {
  if (!to) {
    return (
      <span class="btn btn-ghost btn-icon btn-sm" aria-disabled="true" aria-label={label}>
        <Icon name={icon} size={18} />
      </span>
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

function LineBlock({ title, children }: { title: ComponentChildren; children: ComponentChildren }): JSX.Element {
  return (
    <div class="ld-line">
      <h4 class="ld-line-title">{title}</h4>
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

/** Changes a leak's status with an Undo toast; `after` runs on success, `undone` after an undo. */
export async function changeStatus(m: Mistake, action: StatusAction, after?: (m: Mistake) => void, undone?: (m: Mistake) => void): Promise<void> {
  const before = snapshot(m);
  const ok = await runAction(() =>
    action === 'mastered' ? store.setMistakeStatus(m.id, 'mastered')
    : action === 'repertoire' ? store.setMistakeStatus(m.id, 'ignored', { reason: 'repertoire' })
    : action === 'snooze' ? store.setMistakeStatus(m.id, 'active', { snoozeDays: SNOOZE_DAYS })
    : store.setMistakeStatus(m.id, 'active'),
  );
  if (!ok) return;
  after?.(m);
  toast('success', DONE_TEXT[action], {
    label: 'Undo',
    run: () => void runAction(() => restoreSnapshot(m.id, before)).then(ok => ok && undone?.(m)),
  });
}

function StatusBanner({ m, tab, now, onStatusChange, onUndo }: { m: Mistake; tab: LeakTab | null; now: number; onStatusChange?(m: Mistake): void; onUndo?(m: Mistake): void }): JSX.Element | null {
  const restore = (
    <button type="button" class="btn btn-sm" onClick={() => void changeStatus(m, 'restore', onStatusChange, onUndo)}>
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

function Actions({ m, tab, orientation, onStatusChange, onUndo }: { m: Mistake; tab: LeakTab | null; orientation: Color; onStatusChange?(m: Mistake): void; onUndo?(m: Mistake): void }): JSX.Element {
  const listed = tab === 'active';
  return (
    <div class="ld-actions">
      <a class="btn btn-primary ld-train" href={href('train', undefined, { leak: m.shortId })}>
        <Icon name="play" size={18} /> Train this now
      </a>
      {listed ? (
        <div class="ld-action-grid">
          <button type="button" class="btn" onClick={() => void changeStatus(m, 'mastered', onStatusChange, onUndo)}>
            <Icon name="check" size={18} /> Mark mastered
          </button>
          <button type="button" class="btn" onClick={() => void changeStatus(m, 'repertoire', onStatusChange, onUndo)}>
            <Icon name="openings" size={18} /> This is my repertoire
          </button>
          <button type="button" class="btn" onClick={() => void changeStatus(m, 'snooze', onStatusChange, onUndo)}>
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

function Results({ m, habit }: { m: Mistake; habit: string }): JSX.Element {
  const split = scoreSplit(m, store.filters.value);
  return (
    <section class="card ld-section" aria-labelledby="ld-results-title">
      <h3 id="ld-results-title" class="ld-section-title">
        Your results from here
      </h3>
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

function EngineInfo({ m, now }: { m: Mistake; now: number }): JSX.Element {
  return (
    <section class="card ld-section" aria-labelledby="ld-engine-title">
      <h3 id="ld-engine-title" class="ld-section-title">
        How sure is this?
      </h3>
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

function Games({ m, habit, orientation }: { m: Mistake; habit: string; orientation: Color }): JSX.Element {
  const [all, setAll] = useState(false);
  const f = store.filters.value;
  const occ = useMemo(() => filterOccurrences(m.occurrences, f), [m.occurrences, f]);
  const shown = all ? occ : occ.slice(0, GAMES_SHOWN);
  return (
    <section class="card ld-section" aria-labelledby="ld-games-title">
      <h3 id="ld-games-title" class="ld-section-title">
        Your games from this position <span class="small faint num">· {occ.length}</span>
      </h3>
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
