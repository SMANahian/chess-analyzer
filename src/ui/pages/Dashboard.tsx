// Home for a connected player: progress while busy, top leaks, training CTA, what changed since the
// last visit, stats, and a backup reminder when the browser may clear storage.
import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import * as store from '../../state/store';
import type { Mistake, Profile, ReviewState, Severity, Speed, StoredGame, ViewMistake } from '../../core/types';
import { EmptyState } from '../components/EmptyState';
import { formatCount, isoDate, moveLabel, platformName, plural, relativeTime, speedName } from '../components/format';
import { downloadBlob, useAction, useNow } from '../components/hooks';
import { Icon } from '../components/Icon';
import { LeakRow } from '../components/LeakRow';
import { Banner } from '../components/Notice';
import { ProgressCard } from '../components/ProgressCard';
import { SEVERITY_GLYPH } from '../components/SeverityPill';
import { Spinner } from '../components/Spinner';
import { Stat, StatGrid } from '../components/Stat';
import { recordVisit } from '../components/visits';
import { href, type PageProps } from '../router';

const DAY = 24 * 60 * 60 * 1000;
const BACKUP_REMINDER_DAYS = 14;
const TOP_LEAKS = 5;

export default function Dashboard(_props: PageProps): JSX.Element {
  const self = store.selfProfile.value;
  const now = useNow(60_000);
  if (!self) return <></>;
  const busy = store.busy.value;
  const visible = store.visibleMistakes.value;
  const firstRun = !self.lastAnalysisAt;
  return (
    <div class="page dashboard">
      <DashHead self={self} busy={busy} now={now} />
      {self.demo ? <DemoBanner self={self} /> : null}
      <ProgressCard />
      {busy && firstRun ? <FirstRunExplainer online={self.accounts.length > 0} /> : null}
      <BackupReminder now={now} />
      <div class="dash-grid">
        <TopLeaks visible={visible} busy={busy} analysed={!firstRun} />
        <div class="dash-side">
          <TrainCard visibleCount={visible.length} now={now} />
          <SinceLastVisit now={now} />
        </div>
      </div>
      <DashStats visible={visible} />
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────
function DashHead({ self, busy, now }: { self: Profile; busy: boolean; now: number }): JSX.Element {
  const [run, pending] = useAction();
  const blocked = busy || pending || store.otherTabBusy.value;
  const sources = self.accounts.map(a => `${a.username} on ${platformName(a.platform)}`);
  const parts = [
    sources.length > 0 ? sources.join(' · ') : self.name,
    store.games.value.length > 0 ? plural(store.games.value.length, 'game') : '',
    self.lastSyncAt ? `synced ${relativeTime(self.lastSyncAt, now)}` : '',
  ].filter(Boolean);
  return (
    <div class="page-head">
      <div>
        <h1>Your openings</h1>
        <p class="page-sub">{parts.join(' · ')}</p>
      </div>
      {self.accounts.length > 0 && !self.demo ? (
        <button type="button" class="btn" disabled={blocked} onClick={() => void run(() => store.refresh())}>
          {pending ? <Spinner label="" size={18} /> : <Icon name="refresh" size={18} />}
          Sync new games
        </button>
      ) : null}
    </div>
  );
}

function DemoBanner({ self }: { self: Profile }): JSX.Element {
  const [run, pending] = useAction();
  return (
    <Banner
      tone="info"
      icon="sparkle"
      title="You’re looking at an example report"
      actions={
        <button type="button" class="btn btn-primary btn-sm" disabled={pending} onClick={() => void run(() => store.removeProfile(self.id))}>
          Analyze my own games
        </button>
      }
    >
      These are the games of a made-up player with a few habitual mistakes. Explore freely — nothing here is yours.
    </Banner>
  );
}

// ── First run ───────────────────────────────────────────────────────────
function FirstRunExplainer({ online }: { online: boolean }): JSX.Element {
  const sync = store.syncProgress.value;
  const analysis = store.analysisProgress.value;
  const step = sync?.phase === 'running' || sync?.phase === 'cooldown' ? 0 : analysis?.phase === 'preparing' ? 1 : 2;
  const steps = [
    online
      ? { title: 'Downloading your newest games', text: 'Lichess sends about 20 games a second; Chess.com one month at a time.' }
      : { title: 'Reading your games', text: 'Each game is stored in this browser, up to its first 20 moves.' },
    { title: 'Finding positions you reach again and again', text: 'Only moves you played in 2 or more games can become leaks.' },
    {
      title: 'Checking each one with Stockfish',
      text: 'Stockfish 19 runs in your browser — a quick look first, a deeper one wherever a move looks bad.',
    },
  ];
  return (
    <section class="card first-run" aria-labelledby="first-run-title">
      <h2 id="first-run-title">What’s happening</h2>
      <ol class="first-run-steps">
        {steps.map((s, i) => (
          <li key={s.title} class={i < step ? 'is-done' : i === step ? 'is-current' : undefined} aria-current={i === step ? 'step' : undefined}>
            <span class="first-run-mark" aria-hidden="true">
              {i < step ? <Icon name="check" size={16} strokeWidth={2.4} /> : i + 1}
            </span>
            <span>
              <strong>{s.title}</strong>
              <span class="small muted"> — {s.text}</span>
            </span>
          </li>
        ))}
      </ol>
      <p class="small muted">
        {online ? 'The first pass uses your 300 newest games so results come quickly; older games are added afterwards. ' : ''}
        Leaks appear below as they are found, and you can start training on them straight away.
      </p>
    </section>
  );
}

// ── Backup reminder ─────────────────────────────────────────────────────
function BackupReminder({ now }: { now: number }): JSX.Element | null {
  const s = store.settings.value;
  const [hidden, setHidden] = useState(false);
  const [run, pending] = useAction();
  const stale = !s.lastBackupAt || now - s.lastBackupAt > BACKUP_REMINDER_DAYS * DAY;
  if (hidden || s.storagePersisted !== false || !stale || store.mistakes.value.length === 0) return null;
  const backup = (): Promise<boolean> =>
    run(async () => {
      // exportData also records settings.lastBackupAt, which hides this reminder.
      const blob = await store.exportData();
      downloadBlob(blob, `chess-analyzer-backup-${isoDate(Date.now())}.json`);
    });
  return (
    <Banner
      tone="warn"
      title="Your browser may delete this data"
      onDismiss={() => setHidden(true)}
      actions={
        <button type="button" class="btn btn-sm" disabled={pending} onClick={() => void backup()}>
          <Icon name="download" size={18} /> Download a backup
        </button>
      }
    >
      Storage here isn’t marked as persistent, and some browsers (Safari especially) clear site data after a week without a
      visit. Keep a backup of your training progress, or install the app to your home screen.
      {s.lastBackupAt ? ` Last backup: ${relativeTime(s.lastBackupAt, now)}.` : ''}
    </Banner>
  );
}

// ── Top leaks ───────────────────────────────────────────────────────────
function TopLeaks({ visible, busy, analysed }: { visible: readonly ViewMistake[]; busy: boolean; analysed: boolean }): JSX.Element {
  const top = visible.slice(0, TOP_LEAKS);
  return (
    <section class="card dash-leaks" aria-labelledby="top-leaks-title">
      <div class="card-head">
        <h2 id="top-leaks-title">Top leaks</h2>
        {visible.length > 0 ? (
          <a class="card-link" href={href('leaks')}>
            All {formatCount(visible.length)} leaks <Icon name="chevron" size={16} />
          </a>
        ) : null}
      </div>
      {top.length > 0 ? (
        <ol class="leak-list">
          {top.map(m => (
            <LeakRow key={m.id} m={m} />
          ))}
        </ol>
      ) : (
        <LeaksEmpty busy={busy} analysed={analysed} />
      )}
      {busy && top.length > 0 ? (
        <p class="small faint dash-live">
          <Spinner label="" size={14} /> Still analyzing — the list updates as more leaks are found.
        </p>
      ) : null}
    </section>
  );
}

function LeaksEmpty({ busy, analysed }: { busy: boolean; analysed: boolean }): JSX.Element {
  const [run, pending] = useAction();
  if (busy) {
    return (
      <p class="row muted dash-waiting">
        <Spinner label="" size={18} /> Leaks will appear here as they are found.
      </p>
    );
  }
  if (store.mistakes.value.some(m => m.status === 'active' && !m.dormant)) {
    return (
      <EmptyState
        icon="leaks"
        title="Your filters hide every leak"
        actions={
          <a class="btn" href={href('leaks')}>
            Review filters
          </a>
        }
      >
        Leaks exist, but none match the current colour, time-control or severity filters.
      </EmptyState>
    );
  }
  if (store.games.value.length === 0) return <NoGames />;
  if (!analysed) {
    return (
      <EmptyState
        icon="leaks"
        title="Not analyzed yet"
        actions={
          <button type="button" class="btn btn-primary" disabled={pending} onClick={() => void run(() => store.refresh())}>
            Analyze now
          </button>
        }
      >
        Download your games and let Stockfish look for repeated mistakes.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon="check"
      tone="success"
      title="No repeated mistakes found"
      actions={
        <a class="btn" href={href('settings')}>
          Analysis settings
        </a>
      }
    >
      None of the moves you played in two or more games costs 5% or more winning chances. Add more games or analyze more
      moves per game to dig deeper.
    </EmptyState>
  );
}

/** Nothing to analyse: no game was downloaded (or uploaded) yet. Never says "no mistakes found". */
export function NoGames(): JSX.Element {
  const self = store.selfProfile.value;
  const online = (self?.accounts.length ?? 0) > 0;
  return (
    <EmptyState
      icon="leaks"
      title="No games yet"
      actions={
        <a class="btn" href={href('settings')}>
          Upload a PGN file
        </a>
      }
    >
      {online
        ? 'No standard games have been downloaded for your account yet. Sync again after playing, or upload a PGN file of your games in Settings.'
        : 'Upload a PGN file of your games in Settings to find the mistakes you repeat.'}
    </EmptyState>
  );
}

// ── Training CTA ────────────────────────────────────────────────────────
/** Earliest future due date among reviews (undefined when none). */
export function nextDue(reviews: Iterable<ReviewState>, now: number): number | undefined {
  let next: number | undefined;
  for (const r of reviews) if (r.due > now && (next === undefined || r.due < next)) next = r.due;
  return next;
}

function TrainCard({ visibleCount, now }: { visibleCount: number; now: number }): JSX.Element | null {
  const due = store.dueCount.value;
  const reviews = store.reviews.value;
  if (visibleCount === 0 && due === 0) return null;
  const upcoming = due === 0 ? nextDue(reviews.values(), now) : undefined;
  return (
    <section class="card train-card" aria-labelledby="train-title">
      <h2 id="train-title">Training</h2>
      {due > 0 ? (
        <p class="muted">
          <strong class="train-due num">{plural(due, 'position')}</strong>{' '}
          {reviews.size === 0 ? 'ready to learn.' : 'due for review.'}
        </p>
      ) : (
        <p class="muted">
          Nothing due right now{upcoming ? ` — next review ${relativeTime(upcoming, now)}` : ''}. Learn new positions any time.
        </p>
      )}
      <a class={`btn btn-block ${due > 0 ? 'btn-primary btn-lg' : ''}`} href={href('train')}>
        <Icon name="play" size={18} />
        {due > 0 ? `Train now (${formatCount(due)} due)` : 'Train new positions'}
      </a>
    </section>
  );
}

// ── Since your last visit ───────────────────────────────────────────────
/** Most recent time the position was reached (any move). */
const lastSeen = (m: Mistake): number => Math.max(m.occurrences[0]?.t ?? 0, m.lastPlayedAt);

export function sinceVisit(ms: readonly Mistake[], since: number): { fixed: Mistake[]; repeated: Mistake[] } {
  const fixed: Mistake[] = [];
  const repeated: Mistake[] = [];
  if (since <= 0) return { fixed, repeated };
  for (const m of ms) {
    if (m.kind !== 'mistake' || m.status === 'ignored' || lastSeen(m) <= since) continue;
    if (m.lastOutcome === 'fixed') fixed.push(m);
    else if (m.lastOutcome === 'habit') repeated.push(m);
  }
  const recent = (a: Mistake, b: Mistake): number => lastSeen(b) - lastSeen(a);
  return { fixed: fixed.sort(recent), repeated: repeated.sort(recent) };
}

function SinceLastVisit({ now }: { now: number }): JSX.Element | null {
  const previous = recordVisit(now).previous;
  const all = store.mistakes.value;
  const { fixed, repeated } = useMemo(() => sinceVisit(all, previous), [all, previous]);
  if (previous <= 0 || all.length === 0) return null;
  return (
    <section class="card since-card" aria-labelledby="since-title">
      <h2 id="since-title">Since your last visit</h2>
      <p class="small faint">{relativeTime(previous, now)}</p>
      {fixed.length === 0 && repeated.length === 0 ? (
        <p class="muted small">None of your new games reached a leak position.</p>
      ) : (
        <ul class="since-list">
          {fixed.length > 0 ? (
            <li class="since-good">
              <Icon name="check" size={18} />
              <span>
                <strong class="num">{fixed.length}</strong> fixed in real games: {listMoves(fixed)}
              </span>
            </li>
          ) : null}
          {repeated.length > 0 ? (
            <li class="since-bad">
              <Icon name="repeat" size={18} />
              <span>
                <strong class="num">{repeated.length}</strong> repeated: {listMoves(repeated)}
              </span>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function listMoves(ms: readonly Mistake[]): JSX.Element {
  const shown = ms.slice(0, 3);
  return (
    <>
      {shown.map((m, i) => (
        <span key={m.id}>
          {i > 0 ? ', ' : ''}
          <a href={href('leaks', m.shortId)} class="move">
            {moveLabel(m.fen, m.move)}
          </a>
        </span>
      ))}
      {ms.length > shown.length ? ` and ${ms.length - shown.length} more` : ''}
    </>
  );
}

// ── Stats ───────────────────────────────────────────────────────────────
export function gameBreakdown(games: readonly StoredGame[]): { white: number; black: number; speeds: [Speed, number][] } {
  let white = 0;
  const speeds = new Map<Speed, number>();
  for (const g of games) {
    if (g.color === 'white') white++;
    speeds.set(g.speed, (speeds.get(g.speed) ?? 0) + 1);
  }
  return { white, black: games.length - white, speeds: [...speeds].sort((a, b) => b[1] - a[1]) };
}

const SEVERITIES: readonly Severity[] = ['blunder', 'mistake', 'inaccuracy'];
const SEVERITY_PLURAL: Readonly<Record<Severity, string>> = { blunder: 'blunders', mistake: 'mistakes', inaccuracy: 'inaccuracies' };

function DashStats({ visible }: { visible: readonly ViewMistake[] }): JSX.Element | null {
  const games = store.games.value;
  const all = store.mistakes.value;
  const breakdown = useMemo(() => gameBreakdown(games), [games]);
  if (games.length === 0) return null;
  const bySeverity = SEVERITIES.map(s => [s, visible.filter(m => m.severity === s).length] as const);
  const fixed = all.filter(m => m.kind === 'mistake' && m.status !== 'ignored' && m.lastOutcome === 'fixed').length;
  return (
    <section aria-labelledby="stats-title" class="stack-sm">
      <h2 id="stats-title" class="sr-only">
        Statistics
      </h2>
      <StatGrid>
        <Stat
          label="Games analyzed"
          value={formatCount(games.length)}
          detail={
            <>
              {formatCount(breakdown.white)} as White · {formatCount(breakdown.black)} as Black
              <br />
              {breakdown.speeds
                .slice(0, 3)
                .map(([s, n]) => `${speedName(s)} ${formatCount(n)}`)
                .join(' · ')}
            </>
          }
        />
        <Stat
          label="Leaks"
          value={formatCount(visible.length)}
          href={href('leaks')}
          detail={
            bySeverity
              .filter(([, n]) => n > 0)
              .map(([s, n]) => `${n} ${SEVERITY_GLYPH[s]} ${n === 1 ? s : SEVERITY_PLURAL[s]}`)
              .join(' · ') || 'None under the current filters'
          }
        />
        <Stat label="Fixed in real games" value={formatCount(fixed)} tone={fixed > 0 ? 'good' : 'neutral'} detail="Last time, you found a good move" />
        <Stat
          label="Due for review"
          value={formatCount(store.dueCount.value)}
          href={href('train')}
          detail={store.reviews.value.size > 0 ? `${plural(store.reviews.value.size, 'position')} in training` : 'New positions, ready to learn'}
        />
      </StatGrid>
    </section>
  );
}
