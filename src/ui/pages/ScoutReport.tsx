// A scouted player's report: their recurring mistakes shown from YOUR side (the board at the position
// after their habit move, oriented to your colour, with the punishing reply), their repertoire per
// colour (engine-free), and the prep drill.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { applyFilters, openingsSummary } from '../../core/filters';
import { loadOpeningBook, type OpeningBook } from '../../core/openings';
import { DEFAULT_FILTERS, type Color, type Mistake, type Profile, type StoredGame, type ViewMistake } from '../../core/types';
import { Board, arrowFromUci, type BoardArrow } from '../components/Board';
import { ConfirmButton } from '../components/buttons';
import { EmptyState } from '../components/EmptyState';
import { EvalText } from '../components/EvalText';
import { messageOf } from '../components/errors';
import { colorName, formatCount, formatPercent, moveLabel, platformName, plural, relativeTime } from '../components/format';
import { runAction, useAction, useMediaQuery, useNow } from '../components/hooks';
import { Icon } from '../components/Icon';
import { groupFamilies, habitLabel, inOpening } from '../components/leakView';
import { LineView, useLineCursor } from '../components/LineView';
import { ScoreBar } from '../components/ScoreBar';
import { SeverityPill } from '../components/SeverityPill';
import { SkeletonBoard, SkeletonRows } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import { TabPanel, Tabs } from '../components/Tabs';
import { href, navigate } from '../router';

const WIDE = '(min-width: 960px)';
const REPERTOIRE_ROWS = 8;
const LEAKS_SHOWN = 8;
/** While their analysis runs, reload the report this often so new leaks show up. */
const LIVE_RELOAD_MS = 4000;

interface Data {
  profile: Profile;
  mistakes: Mistake[];
  games: StoredGame[];
}

const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');

/** Their listed leaks with view counts (all their games; book and borderline included), by impact. */
export function theirLeaks(ms: readonly Mistake[], now: number): ViewMistake[] {
  return applyFilters(ms, { ...DEFAULT_FILTERS, showBook: true, showLowConfidence: true }, now);
}

/** Progress (0..1) of the job running for this profile, or null when none is. */
export function jobFor(profileId: string): { label: string; fraction: number | null } | null {
  const sync = store.syncProgress.value;
  const analysis = store.analysisProgress.value;
  if (sync?.profileId === profileId && (sync.phase === 'running' || sync.phase === 'cooldown')) {
    return { label: `Downloading games · ${formatCount(sync.added)}`, fraction: null };
  }
  if (analysis?.profileId === profileId && (analysis.phase === 'preparing' || analysis.phase === 'evaluating')) {
    const fraction = analysis.weightTotal > 0 ? analysis.weightDone / analysis.weightTotal : null;
    return { label: analysis.phase === 'preparing' ? 'Finding repeated positions' : 'Analyzing', fraction };
  }
  return null;
}

function useScoutData(profileId: string): { data: Data | null; error: string | null; reload(): void } {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const profile = store.profiles.value.find(p => p.id === profileId);
  const running = jobFor(profileId) !== null;
  useEffect(() => {
    let live = true;
    store
      .loadScout(profileId)
      .then(d => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch(err => live && setError(messageOf(err)));
    return () => {
      live = false;
    };
  }, [profileId, tick, profile?.lastSyncAt, profile?.lastAnalysisAt, running]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick(t => t + 1), LIVE_RELOAD_MS);
    return () => clearInterval(id);
  }, [running]);
  return { data, error, reload: () => setTick(t => t + 1) };
}

export default function ScoutReport({ profileId }: { profileId: string }): JSX.Element {
  const { data, error, reload } = useScoutData(profileId);
  if (error && !data) {
    return (
      <div class="page scout-page">
        <EmptyState
          icon="scout"
          title="Couldn’t open this report"
          actions={
            <>
              <a class="btn" href={href('scout')}>
                Back to Scout
              </a>
              <button type="button" class="btn btn-ghost" onClick={reload}>
                Try again
              </button>
            </>
          }
        >
          {error}
        </EmptyState>
      </div>
    );
  }
  if (!data) return <ReportSkeleton />;
  return <Report data={data} />;
}

function ReportSkeleton(): JSX.Element {
  return (
    <div class="page scout-page" aria-busy="true">
      <div class="page-head">
        <span class="skeleton" style={{ width: '220px', height: '34px' }} />
      </div>
      <div class="scout-leaks">
        <SkeletonRows rows={5} label="Loading the report" />
        <div class="scout-board-panel">
          <SkeletonBoard />
        </div>
      </div>
    </div>
  );
}

function Report({ data }: { data: Data }): JSX.Element {
  const now = useNow(60_000);
  const { profile, mistakes, games } = data;
  const leaks = useMemo(() => theirLeaks(mistakes, now), [mistakes, now]);
  const job = jobFor(profile.id);
  return (
    <div class="page scout-page">
      <ReportHead profile={profile} games={games.length} leaks={leaks} now={now} />
      {job ? (
        <section class="card scout-progress" aria-live="polite">
          <div class="row">
            <Spinner label="" size={18} />
            <strong>{job.label}</strong>
            {job.fraction !== null ? <span class="muted num">{formatPercent(job.fraction)}</span> : null}
          </div>
          <div class="progress">
            {job.fraction !== null ? <div class="progress-fill" style={{ width: `${Math.round(job.fraction * 100)}%` }} /> : <div class="progress-indeterminate" />}
          </div>
          <p class="small muted">Their leaks appear below as they’re found. You can leave this page; the analysis keeps running in this tab.</p>
        </section>
      ) : null}
      <TheirLeaks profile={profile} leaks={leaks} busy={job !== null} />
      <TheirRepertoire games={games} leaks={leaks} />
    </div>
  );
}

function ReportHead({ profile, games, leaks, now }: { profile: Profile; games: number; leaks: readonly ViewMistake[]; now: number }): JSX.Element {
  const [run, pending] = useAction();
  const drillable = leaks.some(m => m.refutation);
  const sources = profile.accounts.map(a => `${a.username} on ${platformName(a.platform)}`).join(' · ');
  return (
    <div class="scout-head">
      <a class="btn btn-ghost btn-sm scout-back" href={href('scout')}>
        <Icon name="back" size={18} /> Scout
      </a>
      <div class="page-head">
        <div>
          <h1>{profile.name}</h1>
          <p class="page-sub">
            {[sources, plural(games, 'game'), profile.lastSyncAt ? `synced ${relativeTime(profile.lastSyncAt, now)}` : 'not synced yet'].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div class="scout-actions">
          {drillable ? (
            <a class="btn btn-primary" href={href('train', undefined, { scout: profile.id })}>
              <Icon name="play" size={18} /> Prep drill
            </a>
          ) : (
            <span class="btn btn-primary" aria-disabled="true" title="Available once their leaks are analyzed">
              <Icon name="play" size={18} /> Prep drill
            </span>
          )}
          <button
            type="button"
            class="btn btn-icon"
            disabled={pending || store.busy.value}
            onClick={() => void run(() => store.refresh(profile.id))}
            aria-label="Download their new games"
            title="Download their new games"
          >
            {pending ? <Spinner label="" size={18} /> : <Icon name="refresh" size={18} />}
          </button>
          <ConfirmButton
            class="btn btn-icon btn-ghost"
            confirmLabel="Remove?"
            onConfirm={async () => {
              const ok = await runAction(() => store.removeProfile(profile.id), { success: `${profile.name} removed.` });
              if (ok) navigate(href('scout'), { replace: true });
            }}
          >
            <Icon name="trash" size={18} />
            <span class="sr-only">Remove {profile.name}</span>
          </ConfirmButton>
        </div>
      </div>
    </div>
  );
}

// ── Their leaks ─────────────────────────────────────────────────────────

function TheirLeaks({ profile, leaks, busy }: { profile: Profile; leaks: readonly ViewMistake[]; busy: boolean }): JSX.Element {
  const wide = useMediaQuery(WIDE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const selected = leaks.find(m => m.id === selectedId) ?? (wide ? leaks[0] : undefined);
  const shown = all ? leaks : leaks.slice(0, LEAKS_SHOWN);
  // Phones: tapping a leak opens its board under it (tap again to close).
  const select = (id: string): void => setSelectedId(cur => (!wide && cur === id ? null : id));
  return (
    <section class="scout-section" aria-labelledby="their-leaks-title">
      <div class="section-head">
        <h2 id="their-leaks-title">Their leaks</h2>
        {leaks.length > 0 ? <span class="small muted">Mistakes they repeat — and how to punish them</span> : null}
      </div>
      {leaks.length === 0 ? (
        <LeaksEmpty profile={profile} busy={busy} />
      ) : (
        <div class="scout-leaks">
          <div class="scout-leak-col">
            <ol class="scout-leak-list">
              {shown.map(m => (
                <LeakItem key={m.id} m={m} selected={selected?.id === m.id} wide={wide} onSelect={() => select(m.id)} />
              ))}
            </ol>
            {leaks.length > LEAKS_SHOWN ? (
              <button type="button" class="btn btn-ghost btn-sm scout-more" onClick={() => setAll(x => !x)}>
                {all ? `Show the top ${LEAKS_SHOWN}` : `Show all ${leaks.length} leaks`}
              </button>
            ) : null}
          </div>
          {wide && selected ? (
            <div class="scout-board-panel">
              <LeakBoard m={selected} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function LeakItem({ m, selected, wide, onSelect }: { m: ViewMistake; selected: boolean; wide: boolean; onSelect(): void }): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wide && selected) panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected, wide]);
  return (
    <li class={selected ? 'is-selected' : undefined}>
      <button type="button" class="scout-leak" aria-expanded={wide ? undefined : selected} aria-pressed={wide ? selected : undefined} onClick={onSelect}>
        <SeverityPill severity={m.severity} kind={m.kind} confidence={m.confidence} compact />
        <span class="li-main">
          <span class="li-top">
            <span class="move move-habit li-move">{habitLabel(m)}</span>
            <span class="li-count num">
              {m.viewCount} of {m.viewPositionCount} games
            </span>
          </span>
          <span class="li-sub">
            {m.openingName ?? 'Unnamed line'} · as {colorName(m.color)}
          </span>
          {m.refutation ? (
            <span class="scout-punish small">
              Punish with <span class="move move-best">{moveLabel(m.refutation.fen, m.refutation.bestMove)}</span>
            </span>
          ) : (
            <span class="small faint">Punishment not computed yet</span>
          )}
        </span>
      </button>
      {!wide && selected ? (
        <div class="scout-inline" ref={panel}>
          <LeakBoard m={m} />
        </div>
      ) : null}
    </li>
  );
}

function LeaksEmpty({ profile, busy }: { profile: Profile; busy: boolean }): JSX.Element {
  const [run, pending] = useAction();
  if (busy) return <SkeletonRows rows={3} label="Looking for their leaks" />;
  if (!profile.lastAnalysisAt) {
    // Jobs run one at a time: a new scout waits while another download or analysis runs.
    return store.busy.value ? (
      <EmptyState icon="clock" title="Waiting for the current job">
        Their games are downloaded and analyzed as soon as the running download or analysis finishes.
      </EmptyState>
    ) : (
      <EmptyState
        icon="scout"
        title="Not analyzed yet"
        actions={
          <button type="button" class="btn btn-primary" disabled={pending} onClick={() => void run(() => store.refresh(profile.id))}>
            Analyze their games
          </button>
        }
      >
        Download their recent games and let Stockfish find the mistakes they repeat.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon="check" title="No repeated mistakes found">
      None of the moves they played in two or more games loses 5% or more. A solid player — or not enough games yet.
    </EmptyState>
  );
}

/** One of their leaks from your side: the position after their habit, your colour at the bottom. */
function LeakBoard({ m }: { m: ViewMistake }): JSX.Element {
  const r = m.refutation;
  const you = opposite(m.color);
  const path = r ? [...m.path, m.move] : m.path;
  const cursor = useLineCursor(path, r ? { best: { startFen: r.fen, ucis: r.bestLine } } : {}, 'best', m.id);
  const atRoot = cursor.view === null;
  const arrows = useMemo(
    () => (r ? [arrowFromUci(r.bestMove, 'blue')] : [arrowFromUci(m.move, 'orange')]).filter((a): a is BoardArrow => !!a),
    [m.id],
  );
  const theirMove = habitLabel(m);
  return (
    <div class="scout-board">
      <Board
        fen={cursor.view?.fen ?? r?.fen ?? m.fen}
        orientation={you}
        lastMove={atRoot ? (r ? m.move : m.path[m.path.length - 1]) : cursor.view?.lastMove}
        arrows={atRoot ? arrows : []}
        label={r ? `Position after their ${theirMove}. You are ${colorName(you)}, to move. Blue arrow: the punishing reply.` : `Position before their ${theirMove}.`}
      />
      <div class="ld-board-bar">
        <span class="small muted">You play {colorName(you)}</span>
        <div class="stepper" role="group" aria-label="Step through the moves">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={() => cursor.step(-1)} disabled={!cursor.canBack} aria-label="Previous move">
            <Icon name="back" size={18} />
          </button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={cursor.toRoot} disabled={atRoot} aria-label="Back to the position">
            <Icon name="leaks" size={18} />
          </button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick={() => cursor.step(1)} disabled={!cursor.canForward} aria-label="Next move">
            <Icon name="chevron" size={18} />
          </button>
        </div>
      </div>
      {r ? (
        <>
          <p class="scout-headline">
            They play <span class="move move-habit">{theirMove}</span> in {m.viewCount} of {plural(m.viewPositionCount, 'game')} — punish it with{' '}
            <span class="move move-best">{moveLabel(r.fen, r.bestMove)}</span>.
          </p>
          <p class="small">
            <EvalText from={r.score} sideToMove={you} user={you} />
          </p>
          <div class="ld-line">
            <h3 class="ld-line-title">The punishment</h3>
            <LineView
              startFen={r.fen}
              ucis={r.bestLine}
              lead="best"
              label="Punishing line"
              current={cursor.cursor?.line === 'best' ? cursor.cursor.index : undefined}
              onSelect={i => cursor.select('best', i)}
            />
          </div>
          {r.acceptable.length > 1 ? (
            <p class="small muted">
              Also good:{' '}
              {r.acceptable
                .filter(u => u !== r.bestMove)
                .slice(0, 3)
                .map(u => moveLabel(r.fen, u))
                .join(', ')}
            </p>
          ) : null}
        </>
      ) : (
        <p class="scout-headline">
          They play <span class="move move-habit">{theirMove}</span> in {m.viewCount} of {plural(m.viewPositionCount, 'game')}. The punishing reply is
          still being worked out.
        </p>
      )}
    </div>
  );
}

// ── Their repertoire ────────────────────────────────────────────────────

function TheirRepertoire({ games, leaks }: { games: readonly StoredGame[]; leaks: readonly ViewMistake[] }): JSX.Element | null {
  const [book, setBook] = useState<OpeningBook | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [color, setColor] = useState<Color>('white');
  useEffect(() => {
    loadOpeningBook()
      .then(setBook)
      .catch(err => setFailed(messageOf(err)));
  }, []);
  const plies = store.settings.value.openingPlies;
  const rows = useMemo(() => (book ? openingsSummary(games, book, plies) : []), [games, book, plies]);
  if (games.length === 0) return null;
  const counts = { white: games.filter(g => g.color === 'white').length, black: games.filter(g => g.color === 'black').length };
  const families = groupFamilies(rows.filter(r => r.color === color));
  const named = families.reduce((n, f) => n + f.games, 0);
  return (
    <section class="card scout-section scout-rep" aria-labelledby="their-rep-title">
      <div class="section-head">
        <h2 id="their-rep-title">Their repertoire</h2>
        <span class="small muted">What to expect, from their games</span>
      </div>
      <Tabs<Color>
        items={(['white', 'black'] as const).map(c => ({ id: c, label: `As ${colorName(c)}`, count: counts[c] }))}
        value={color}
        onChange={setColor}
        label="Their colour"
        idPrefix="scout-rep"
      />
      <TabPanel id={color} idPrefix="scout-rep">
        {failed ? (
          <p class="small muted">The openings book didn’t load ({failed}).</p>
        ) : !book ? (
          <SkeletonRows rows={4} label="Loading their repertoire" />
        ) : families.length === 0 ? (
          <p class="small muted">No named openings in their games as {colorName(color)}.</p>
        ) : (
          <table class="rep-table">
            <thead>
              <tr>
                <th scope="col">Opening</th>
                <th scope="col" class="rep-num">
                  Games
                </th>
                <th scope="col" class="rep-num">
                  Their score
                </th>
                <th scope="col" class="rep-num">
                  Leaks
                </th>
              </tr>
            </thead>
            <tbody>
              {families.slice(0, REPERTOIRE_ROWS).map(f => {
                const n = leaks.filter(m => m.color === color && inOpening(m, f.name)).length;
                return (
                  <tr key={f.name} class="rep-family">
                    <th scope="row">
                      <span class="rep-label">
                        <span>{f.name}</span>
                        <span class="rep-eco tiny faint num">{f.eco}</span>
                      </span>
                    </th>
                    <td class="rep-num">
                      <span class="num">{formatCount(f.games)}</span>
                      <span class="rep-share tiny faint num">{formatPercent(f.games / Math.max(1, named))}</span>
                    </td>
                    <td class="rep-num">
                      <ScoreBar score={f.score} label={`Their score in ${f.name}`} compact />
                    </td>
                    <td class="rep-num">{n > 0 ? <span class="rep-leaks num">{n}</span> : <span class="faint">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TabPanel>
    </section>
  );
}
