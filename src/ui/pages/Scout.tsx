// Scout: prepare for an opponent. #/scout lists the scouted players (add / remove);
// #/scout/<profileId> is their report (ScoutReport.tsx). Scouted players never enter your training.
import '../styles/features.css';
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import * as store from '../../state/store';
import type { Account, Profile } from '../../core/types';
import { EmptyState } from '../components/EmptyState';
import { friendlyError, type FriendlyError } from '../components/errors';
import { Field } from '../components/forms';
import { formatCount, platformName, plural, relativeTime } from '../components/format';
import { runAction, useNow } from '../components/hooks';
import { ConfirmButton } from '../components/buttons';
import { Icon } from '../components/Icon';
import { Banner } from '../components/Notice';
import { Skeleton } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import { href, navigate, type PageProps } from '../router';
import ScoutReport, { jobFor, theirLeaks } from './ScoutReport';

export default function Scout({ route }: PageProps): JSX.Element {
  return route.id ? <ScoutReport key={route.id} profileId={route.id} /> : <ScoutList />;
}

function ScoutList(): JSX.Element {
  const scouts = store.scoutProfiles.value;
  return (
    <div class="page scout-page">
      <div class="page-head">
        <div>
          <h1>Scout</h1>
          <p class="page-sub">Prepare for an opponent: their repertoire, the mistakes they repeat, and the moves that punish them.</p>
        </div>
      </div>
      <div class="scout-layout">
        <section class="scout-players" aria-labelledby="scout-players-title">
          <h2 id="scout-players-title" class="sr-only">
            Scouted players
          </h2>
          {scouts.length === 0 ? (
            <EmptyState icon="scout" title="No players scouted yet">
              Add your next opponent’s Lichess or Chess.com username. Their games are analyzed the same way as yours — and they
              never enter your own training.
            </EmptyState>
          ) : (
            <ul class="scout-list">
              {scouts.map(p => (
                <ScoutCard key={p.id} p={p} />
              ))}
            </ul>
          )}
        </section>
        <AddScout />
      </div>
    </div>
  );
}

interface ScoutSummary {
  games: number;
  leaks: number;
  punishable: number;
}

function useScoutSummary(p: Profile): ScoutSummary | null {
  const [summary, setSummary] = useState<ScoutSummary | null>(null);
  const job = jobFor(p.id);
  useEffect(() => {
    let live = true;
    store
      .loadScout(p.id)
      .then(({ games, mistakes }) => {
        const listed = theirLeaks(mistakes, Date.now());
        if (live) setSummary({ games: games.length, leaks: listed.length, punishable: listed.filter(m => m.refutation).length });
      })
      .catch(() => live && setSummary({ games: 0, leaks: 0, punishable: 0 }));
    return () => {
      live = false;
    };
  }, [p.id, p.lastSyncAt, p.lastAnalysisAt, job === null]);
  return summary;
}

const initials = (name: string): string =>
  name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('') || '?';

const accountsText = (accounts: readonly Account[]): string => accounts.map(a => `${a.username} on ${platformName(a.platform)}`).join(' · ');

function ScoutCard({ p }: { p: Profile }): JSX.Element {
  const now = useNow(60_000);
  const summary = useScoutSummary(p);
  const job = jobFor(p.id);
  return (
    <li class="scout-card">
      <a class="scout-card-link" href={href('scout', p.id)}>
        <span class="scout-avatar" aria-hidden="true">
          {initials(p.name)}
        </span>
        <span class="scout-card-main">
          <span class="scout-name">{p.name}</span>
          <span class="small muted scout-accounts">
            {accountsText(p.accounts) || 'Uploaded games'}
            {p.lastSyncAt && !job ? ` · synced ${relativeTime(p.lastSyncAt, now)}` : ''}
          </span>
          {job ? (
            <span class="small scout-status scout-busy">
              <Spinner label="" size={14} /> {job.label}
              {job.fraction !== null ? <span class="num"> · {Math.round(job.fraction * 100)}%</span> : null}
            </span>
          ) : !p.lastAnalysisAt ? (
            <span class="small scout-status">{store.busy.value ? 'Queued — waiting for the current job' : 'Not analyzed yet'}</span>
          ) : summary ? (
            <span class="small scout-status">
              <span class="num">{plural(summary.games, 'game')}</span>
              <span class="faint"> · </span>
              <span class={summary.leaks > 0 ? 'scout-leakcount num' : 'num'}>{plural(summary.leaks, 'leak')}</span>
              {summary.punishable > 0 ? <span class="faint"> · {summary.punishable} to drill</span> : null}
            </span>
          ) : (
            <Skeleton width="60%" height={14} />
          )}
        </span>
        <Icon name="chevron" size={18} class="scout-chevron" />
      </a>
      <ConfirmButton
        class="btn btn-ghost btn-icon scout-remove"
        confirmLabel="Remove?"
        onConfirm={() => runAction(() => store.removeProfile(p.id), { success: `${p.name} removed.` }).then(() => undefined)}
      >
        <Icon name="trash" size={18} />
        <span class="sr-only">Remove {p.name}</span>
      </ConfirmButton>
    </li>
  );
}

function AddScout(): JSX.Element {
  const [name, setName] = useState('');
  const [lichess, setLichess] = useState('');
  const [chesscom, setChesscom] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FriendlyError | string | null>(null);
  const accounts: Account[] = [
    ...(lichess.trim() ? [{ platform: 'lichess' as const, username: lichess.trim() }] : []),
    ...(chesscom.trim() ? [{ platform: 'chesscom' as const, username: chesscom.trim() }] : []),
  ];
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    if (accounts.length === 0) {
      setError('Enter their Lichess or Chess.com username.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const profile = await store.addScout({ name: name.trim() || undefined, accounts });
      navigate(href('scout', profile.id));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <section class="card scout-add" aria-labelledby="scout-add-title">
      <h2 id="scout-add-title">Scout a player</h2>
      <p class="small muted">
        Their {formatCount(Math.min(store.SCOUT_GAMES, store.settings.value.gamesPerAccount))} most recent games are downloaded and analyzed in
        this browser.
      </p>
      <form class="stack" onSubmit={submit} noValidate>
        <Field label="Name (optional)" htmlFor="scout-name">
          <input id="scout-name" class="input" value={name} placeholder="e.g. Club championship, round 3" disabled={pending} onInput={e => setName(e.currentTarget.value)} />
        </Field>
        <Field label="Lichess username" htmlFor="scout-lichess">
          <input
            id="scout-lichess"
            class="input"
            value={lichess}
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            disabled={pending}
            aria-invalid={typeof error === 'object' && error?.platform === 'lichess' ? true : undefined}
            onInput={e => setLichess(e.currentTarget.value)}
          />
        </Field>
        <Field label="Chess.com username" htmlFor="scout-chesscom">
          <input
            id="scout-chesscom"
            class="input"
            value={chesscom}
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            disabled={pending}
            aria-invalid={typeof error === 'object' && error?.platform === 'chesscom' ? true : undefined}
            onInput={e => setChesscom(e.currentTarget.value)}
          />
        </Field>
        {error ? (
          typeof error === 'string' ? (
            <p class="field-error" role="alert">
              {error}
            </p>
          ) : (
            <Banner tone="danger" title={error.title}>
              {error.text}
            </Banner>
          )
        ) : null}
        <button type="submit" class="btn btn-primary btn-block" disabled={pending}>
          {pending ? (
            <>
              <Spinner label="" size={18} /> Checking account…
            </>
          ) : (
            <>
              <Icon name="plus" size={18} /> Scout player
            </>
          )}
        </button>
      </form>
    </section>
  );
}
