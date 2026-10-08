// Sync + analysis progress from the store signals: what is happening, counts, a progress bar by
// importance (weight), ETA, cancel, "keep this tab open", and "running in another tab".
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../../state/store';
import type { AnalysisProgress, SyncProgress } from '../../core/types';
import { formatCountdown, formatCount, formatEta, plural, platformName } from './format';
import { useNow } from './hooks';
import { Icon } from './Icon';
import { Banner } from './Notice';
import { Spinner } from './Spinner';
import { href } from '../router';

/** Lichess streams anonymous exports at about 20 games per second. */
const LICHESS_GAMES_PER_SEC = 20;

export interface JobView {
  title: string;
  detail: string;
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
  eta?: string;
  cancellable: boolean;
}

/** Pure: what to show for the current sync/analysis state (null when idle). */
export function jobView(sync: SyncProgress | null, analysis: AnalysisProgress | null, now: number): JobView | null {
  if (sync?.phase === 'cooldown') {
    const left = (sync.cooldownUntil ?? now) - now;
    return {
      title: `${sync.account ? platformName(sync.account.platform) : 'The site'} asked us to pause`,
      detail: `Resuming automatically in ${formatCountdown(left)}. Games downloaded so far are saved.`,
      fraction: null,
      cancellable: true,
    };
  }
  if (sync?.phase === 'running') {
    const site = sync.account ? platformName(sync.account.platform) : 'Lichess and Chess.com';
    const who = sync.account ? ` (${sync.account.username})` : '';
    const expected = sync.expected && sync.expected > 0 ? sync.expected : undefined;
    const fraction = expected ? Math.min(1, sync.fetched / expected) : null;
    const etaMs =
      expected && sync.account?.platform === 'lichess' ? ((expected - sync.fetched) / LICHESS_GAMES_PER_SEC) * 1000 : undefined;
    const counts = [
      expected ? `${formatCount(sync.fetched)} of ${formatCount(expected)} games` : `${plural(sync.fetched, 'game')} received`,
      sync.added > 0 ? `${formatCount(sync.added)} new` : '',
    ].filter(Boolean);
    return {
      title: `Downloading your games from ${site}${who}`,
      detail: sync.message ?? counts.join(' · '),
      fraction,
      eta: formatEta(etaMs),
      cancellable: true,
    };
  }
  if (analysis?.phase === 'preparing') {
    return {
      title: 'Finding the positions you reach again and again',
      detail: analysis.gamesUsed > 0 ? `Replaying the openings of ${plural(analysis.gamesUsed, 'game')}` : 'Reading your games…',
      fraction: null,
      cancellable: true,
    };
  }
  if (analysis?.phase === 'evaluating') {
    const fraction = analysis.weightTotal > 0 ? Math.min(1, analysis.weightDone / analysis.weightTotal) : null;
    const parts = [
      `${formatCount(analysis.donePositions)} of ${plural(analysis.totalPositions, 'position')} checked`,
      `${plural(analysis.mistakesFound, 'leak')} found so far`,
    ];
    return {
      title: 'Checking your positions with Stockfish',
      detail: parts.join(' · '),
      fraction,
      eta: formatEta(analysis.etaMs),
      cancellable: true,
    };
  }
  return null;
}

function ProgressBar({ fraction, label }: { fraction: number | null; label: string }): JSX.Element {
  if (fraction === null) {
    return <div class="progress progress-indeterminate" role="progressbar" aria-label={label} />;
  }
  const pct = Math.round(fraction * 100);
  return (
    <div class="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div class="progress-fill" style={{ width: `${Math.max(2, pct)}%` }} />
    </div>
  );
}

interface Finished {
  tone: 'danger' | 'info';
  text: string;
  key: string;
  /** The site can't be reached or the account is closed: a PGN upload is the way around it. */
  suggestPgn?: boolean;
}

function finishedState(sync: SyncProgress | null, analysis: AnalysisProgress | null): Finished | null {
  if (sync?.phase === 'error') {
    return { tone: 'danger', text: sync.error ?? 'Downloading games failed.', key: `s${sync.error}`, suggestPgn: sync.errorKind === 'network' || sync.errorKind === 'closed' };
  }
  if (analysis?.phase === 'error') return { tone: 'danger', text: analysis.error ?? 'Analysis failed.', key: `a${analysis.startedAt}` };
  if (analysis?.phase === 'cancelled' || sync?.phase === 'cancelled') {
    return { tone: 'info', text: 'Stopped. Everything found so far is saved — resume any time.', key: `c${analysis?.startedAt ?? 0}` };
  }
  return null;
}

export interface ProgressCardProps {
  /** Also show the "stopped" / "failed" states after a job ends (Dashboard), default true. */
  showFinished?: boolean;
}

/** Renders nothing when no job is running (and nothing finished with an error or cancellation). */
export function ProgressCard({ showFinished = true }: ProgressCardProps): JSX.Element | null {
  const sync = store.syncProgress.value;
  const analysis = store.analysisProgress.value;
  const busy = store.busy.value;
  const now = useNow(1000, busy);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const view = jobView(sync, analysis, now);

  if (!busy && store.otherTabBusy.value) {
    return (
      <section class="card progress-card" aria-live="polite">
        <div class="progress-head">
          <Spinner label="" />
          <div>
            <h2 class="progress-title">Analysis is running in another tab</h2>
            <p class="muted small">This page will update when it finishes. Only one tab works at a time so they don’t compete for your CPU.</p>
          </div>
        </div>
      </section>
    );
  }

  if (!view) {
    const done = showFinished ? finishedState(sync, analysis) : null;
    if (!done || done.key === dismissed) return null;
    const retry = (): void => {
      setDismissed(done.key);
      void runRefresh();
    };
    return (
      <Banner
        tone={done.tone}
        title={done.tone === 'danger' ? 'Something went wrong' : undefined}
        actions={
          <>
            <button type="button" class="btn btn-sm" onClick={retry}>
              <Icon name="refresh" size={18} />
              {done.tone === 'danger' ? 'Try again' : 'Resume'}
            </button>
            {done.suggestPgn ? (
              <a class="btn btn-sm btn-ghost" href={href('settings')}>
                <Icon name="upload" size={18} /> Upload a PGN file instead
              </a>
            ) : null}
          </>
        }
        onDismiss={() => setDismissed(done.key)}
      >
        {done.text}
      </Banner>
    );
  }

  return (
    <section class="card progress-card" aria-labelledby="progress-title">
      <div class="progress-head">
        <Spinner label="" />
        <div class="progress-text" aria-live="polite">
          <h2 class="progress-title" id="progress-title">
            {view.title}
          </h2>
          <p class="muted small num">
            {view.detail}
            {view.eta ? <span class="progress-eta"> · {view.eta} left</span> : null}
          </p>
        </div>
        {view.cancellable ? (
          <button type="button" class="btn btn-sm btn-ghost progress-cancel" onClick={() => cancel()}>
            Cancel
          </button>
        ) : null}
      </div>
      <ProgressBar fraction={view.fraction} label={view.title} />
      <p class="progress-hint faint small">
        <Icon name="about" size={16} /> Keep this tab open — switching to other tabs is fine. Results are saved as they are found.
      </p>
    </section>
  );
}

function cancel(): void {
  try {
    store.cancelJobs();
  } catch {
    // Nothing to cancel.
  }
}

async function runRefresh(): Promise<void> {
  try {
    await store.refresh();
  } catch {
    // Errors surface through syncProgress / analysisProgress.
  }
}

/** Compact header indicator while a job runs: "Analyzing · 41%", linking home. */
export function JobStatusPill({ href }: { href: string }): JSX.Element | null {
  const busy = store.busy.value;
  const view = jobView(store.syncProgress.value, store.analysisProgress.value, Date.now());
  if (!busy && !store.otherTabBusy.value) return null;
  const sync = store.syncProgress.value?.phase === 'running' || store.syncProgress.value?.phase === 'cooldown';
  const label = !busy ? 'Busy in another tab' : sync ? 'Downloading' : 'Analyzing';
  const pct = view?.fraction != null ? ` · ${Math.round(view.fraction * 100)}%` : '';
  return (
    <a class="job-pill" href={href} title={view?.title}>
      <Spinner label="" size={14} />
      <span>
        {label}
        <span class="num">{pct}</span>
      </span>
    </a>
  );
}
