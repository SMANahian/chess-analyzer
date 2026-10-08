// Sync + analysis progress from the store signals: what is happening, counts, a progress bar by
// importance (weight), ETA, cancel, "keep this tab open", and "running in another tab".
// Screen readers get a separate, throttled announcer (JobAnnouncer, mounted once by the app): the
// visible counters change every second and would otherwise be read out continuously.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import type { AnalysisProgress, SyncProgress } from '../../core/types';
import { formatCountdown, formatCount, formatEta, plural, platformName } from './format';
import { toast, useNow } from './hooks';
import { Icon } from './Icon';
import { Banner } from './Notice';
import { safeRead } from './safe';
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

export interface JobViewOptions {
  /** The own profile's id: its analysis counts the leaks the Leaks list shows. */
  selfId?: string;
  /** Leaks listed under the current filters (store.visibleMistakes), for the own profile's analysis. */
  leaksShown?: number;
}

/** A PGN import reports progress without an account, with a "Reading the PGN file" message. */
const isPgnImport = (sync: SyncProgress): boolean => !sync.account && !!sync.message;

/**
 * The part of a sync message worth showing next to the counts: sync.ts appends its own estimate
 * ("(about 6 s left)") and says "Lichess: downloading games", which the title and ETA already say.
 */
export function syncMessageDetail(message: string | undefined): string {
  const text = (message ?? '').replace(/\s*\(about [^)]*left\)/, '').trim();
  return /^[\w.]+: downloading games$/.test(text) ? '' : text;
}

/** Pure: what to show for the current sync/analysis state (null when idle). */
export function jobView(sync: SyncProgress | null, analysis: AnalysisProgress | null, now: number, opts: JobViewOptions = {}): JobView | null {
  if (sync?.phase === 'cooldown') {
    const left = (sync.cooldownUntil ?? now) - now;
    return {
      title: `${sync.account ? platformName(sync.account.platform) : 'The site'} asked us to pause`,
      detail: `Resuming automatically in ${formatCountdown(left)}. Games downloaded so far are saved.`,
      fraction: null,
      cancellable: true,
    };
  }
  if (sync?.phase === 'running' && isPgnImport(sync)) {
    const pct = /\((\d+)%\)/.exec(sync.message ?? '');
    return {
      title: 'Reading your PGN file',
      detail: [`${plural(sync.fetched, 'game')} read`, sync.added > 0 ? `${formatCount(sync.added)} new` : ''].filter(Boolean).join(' · '),
      fraction: pct ? Math.min(1, Number(pct[1]) / 100) : null,
      cancellable: true,
    };
  }
  if (sync?.phase === 'running') {
    const site = sync.account ? ` from ${platformName(sync.account.platform)}` : '';
    const who = sync.account ? ` (${sync.account.username})` : '';
    const expected = sync.expected && sync.expected > 0 ? sync.expected : undefined;
    const fraction = expected ? Math.min(1, sync.fetched / expected) : null;
    const etaMs =
      expected && sync.account?.platform === 'lichess' ? ((expected - sync.fetched) / LICHESS_GAMES_PER_SEC) * 1000 : undefined;
    const detail = [
      expected ? `${formatCount(sync.fetched)} of ${formatCount(expected)} games` : `${plural(sync.fetched, 'game')} received`,
      sync.added > 0 ? `${formatCount(sync.added)} new` : '',
      syncMessageDetail(sync.message),
    ].filter(Boolean);
    return {
      title: `Downloading your games${site}${who}`,
      detail: detail.join(' · '),
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
    // The own profile: the leaks its list shows (borderline and book findings are hidden by default).
    const found =
      opts.selfId !== undefined && analysis.profileId === opts.selfId && opts.leaksShown !== undefined
        ? `${plural(opts.leaksShown, 'leak')} found so far`
        : `${plural(analysis.mistakesFound, 'finding')} so far`;
    return {
      title: 'Checking your positions with Stockfish',
      detail: [`${formatCount(analysis.donePositions)} of ${plural(analysis.totalPositions, 'position')} checked`, found].join(' · '),
      fraction,
      eta: formatEta(analysis.etaMs),
      cancellable: true,
    };
  }
  return null;
}

/** jobView with the store's own-profile context. */
function currentJobView(now: number): JobView | null {
  const self = store.selfProfile.value;
  return jobView(store.syncProgress.value, store.analysisProgress.value, now, {
    ...(self ? { selfId: self.id } : {}),
    leaksShown: safeRead(() => store.visibleMistakes.value.length, 0),
  });
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

/** What "Try again" / "Resume" restarts: the whole refresh, or only the analysis, of that profile. */
export interface RetryTarget {
  kind: 'refresh' | 'analyze';
  profileId: string;
}

export interface Finished {
  tone: 'danger' | 'info';
  text: string;
  key: string;
  /** The site can't be reached or the account is closed: a PGN upload is the way around it. */
  suggestPgn?: boolean;
  retry: RetryTarget;
  /** Label of the retry button. */
  retryLabel: string;
}

/** Pure: the banner after a job ended badly (failed, cancelled, or finished with positions it could not check). */
export function finishedState(sync: SyncProgress | null, analysis: AnalysisProgress | null): Finished | null {
  if (sync?.phase === 'error') {
    return {
      tone: 'danger',
      text: sync.error ?? 'Downloading games failed.',
      key: `s${sync.error}`,
      suggestPgn: sync.errorKind === 'network' || sync.errorKind === 'closed',
      retry: { kind: 'refresh', profileId: sync.profileId },
      retryLabel: 'Try again',
    };
  }
  if (analysis?.phase === 'error') {
    return {
      tone: 'danger',
      text: analysis.error ?? 'Analysis failed.',
      key: `a${analysis.startedAt}`,
      retry: { kind: 'analyze', profileId: analysis.profileId },
      retryLabel: 'Try again',
    };
  }
  if (sync?.phase === 'cancelled') {
    return {
      tone: 'info',
      text: 'Stopped. Everything found so far is saved — resume any time.',
      key: `c${analysis?.startedAt ?? 0}`,
      retry: { kind: 'refresh', profileId: sync.profileId },
      retryLabel: 'Resume',
    };
  }
  if (analysis?.phase === 'cancelled') {
    return {
      tone: 'info',
      text: 'Stopped. Everything found so far is saved — resume any time.',
      key: `c${analysis.startedAt}`,
      retry: { kind: 'analyze', profileId: analysis.profileId },
      retryLabel: 'Resume',
    };
  }
  if (analysis?.phase === 'done' && analysis.error) {
    return {
      tone: 'info',
      text: `${analysis.error} The next refresh tries them again.`,
      key: `d${analysis.startedAt}`,
      retry: { kind: 'analyze', profileId: analysis.profileId },
      retryLabel: 'Retry now',
    };
  }
  return null;
}

async function runRetry(target: RetryTarget): Promise<void> {
  try {
    await (target.kind === 'refresh' ? store.refresh(target.profileId) : store.analyze(target.profileId));
  } catch {
    // Errors surface through syncProgress / analysisProgress.
  }
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
  const view = currentJobView(now);

  if (!busy && store.otherTabBusy.value) {
    return (
      <section class="card progress-card" aria-labelledby="progress-other-title">
        <div class="progress-head">
          <Spinner label="" />
          <div>
            <h2 class="progress-title" id="progress-other-title">
              Analysis is running in another tab
            </h2>
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
      void runRetry(done.retry);
    };
    return (
      <Banner
        tone={done.tone}
        title={done.tone === 'danger' ? 'Something went wrong' : undefined}
        actions={
          <>
            <button type="button" class="btn btn-sm" onClick={retry}>
              <Icon name="refresh" size={18} />
              {done.retryLabel}
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
        <div class="progress-text">
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

// ── Screen-reader announcements ─────────────────────────────────────────

/** Coarse progress milestones are announced at most this often. */
export const ANNOUNCE_MIN_MS = 15_000;
/** A job counts as finished when nothing new started for this long (the steps of one run follow closely). */
const JOB_END_SETTLE_MS = 2_000;

export interface Announcement {
  text: string;
  /** When it was announced. */
  at: number;
  /** The phase it belongs to (the view's title). */
  phase: string;
  /** Quarter reached: 0..4 (−1 when the progress is indeterminate). */
  milestone: number;
}

/**
 * Pure: the next thing to announce, or null to stay quiet. A new phase (downloading from an account,
 * finding positions, checking them) is announced at once; inside a phase only each further 25 %,
 * and never sooner than ANNOUNCE_MIN_MS after the previous announcement.
 */
export function nextAnnouncement(prev: Announcement | null, view: JobView | null, now: number): Announcement | null {
  if (!view) return null;
  const milestone = view.fraction === null ? -1 : Math.floor(view.fraction * 4 + 1e-9);
  if (!prev || prev.phase !== view.title) return { text: `${view.title}.`, at: now, phase: view.title, milestone };
  if (milestone > prev.milestone && milestone > 0 && now - prev.at >= ANNOUNCE_MIN_MS) {
    return { text: `${view.title}: ${milestone * 25}% done.`, at: now, phase: view.title, milestone };
  }
  return null;
}

/**
 * The only live region for jobs (mounted once, by the app shell): phase changes and coarse progress,
 * then a toast when an analysis finishes ("Analysis finished — 12 leaks found").
 */
export function JobAnnouncer(): JSX.Element {
  const busy = store.busy.value;
  const now = useNow(1000, busy);
  const last = useRef<Announcement | null>(null);
  const next = busy ? nextAnnouncement(last.current, currentJobView(now), now) : null;
  if (next) last.current = next;
  // The analysis this busy period ran (a finished one from earlier must not be announced again).
  const running = useRef<number | null>(null);
  const progress = store.analysisProgress.value;
  if (busy && (progress?.phase === 'preparing' || progress?.phase === 'evaluating')) running.current = progress.startedAt;

  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    // A first sync runs in steps (newest games, analysis, older games, analysis again): only the end
    // of the whole run is announced, not each pause between its steps.
    const id = setTimeout(() => {
      if (store.busy.peek()) return;
      last.current = null;
      const a = store.analysisProgress.peek();
      const self = store.selfProfile.peek();
      const ran = running.current;
      running.current = null;
      if (a?.phase !== 'done' || a.error || a.startedAt !== ran) return;
      if (self && a.profileId === self.id) {
        const n = safeRead(() => store.visibleMistakes.peek().length, 0);
        toast('success', `Analysis finished — ${n === 0 ? 'no leaks' : plural(n, 'leak')} found.`);
      } else {
        const name = store.profiles.peek().find(p => p.id === a.profileId)?.name;
        if (name) toast('success', `Analysis of ${name} finished.`);
      }
    }, JOB_END_SETTLE_MS);
    return () => clearTimeout(id);
  }, [busy]);

  return (
    <p class="sr-only" role="status">
      {busy ? (last.current?.text ?? '') : ''}
    </p>
  );
}

/** Compact header indicator while a job runs: "Analyzing · 41%", linking home. */
export function JobStatusPill({ href }: { href: string }): JSX.Element | null {
  const busy = store.busy.value;
  const view = jobView(store.syncProgress.value, store.analysisProgress.value, Date.now());
  if (!busy && !store.otherTabBusy.value) return null;
  const sync = store.syncProgress.value;
  const syncing = sync?.phase === 'running' || sync?.phase === 'cooldown';
  const label = !busy ? 'Busy in another tab' : syncing ? (sync && isPgnImport(sync) ? 'Importing' : 'Downloading') : 'Analyzing';
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
