// Settings: accounts, analysis (presets + advanced), games per account, training, appearance, data.
// Every control saves immediately through store.updateSettings.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import * as store from '../../state/store';
import type { Account, AnalysisPreset, Settings as AppSettings } from '../../core/types';
import { ConfirmButton, CopyButton } from '../components/buttons';
import { collectDiagnostics } from '../components/diagnostics';
import { friendlyError } from '../components/errors';
import { Field, FileButton, RangeField, Segmented, Toggle } from '../components/forms';
import { formatCount, isoDate, relativeTime } from '../components/format';
import { downloadBlob, runAction, toast, useAction, useNow } from '../components/hooks';
import { Icon } from '../components/Icon';
import { Banner } from '../components/Notice';
import { Spinner } from '../components/Spinner';
import { navigate, href, type PageProps } from '../router';
import { PgnImport } from './Onboarding';
import { applyTheme } from '../theme';

const PRESETS: readonly { value: AnalysisPreset; label: string; hint: string }[] = [
  { value: 'quick', label: 'Quick', hint: 'Fastest. Fine on phones; may miss subtle slips.' },
  { value: 'standard', label: 'Standard', hint: 'Recommended. Reliable verdicts in a few minutes.' },
  { value: 'thorough', label: 'Thorough', hint: 'Deeper checks. Best on a laptop; takes longer.' },
];
const GAMES_PER_ACCOUNT = [300, 1000, 3000, 10000] as const;

function save(patch: Partial<AppSettings>): void {
  void runAction(() => store.updateSettings(patch));
}

export default function Settings(_props: PageProps): JSX.Element {
  const s = store.settings.value;
  const self = store.selfProfile.value;
  return (
    <div class="page page-narrow settings">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p class="page-sub">Changes are saved automatically.</p>
        </div>
      </div>
      {self && !self.demo ? <AccountsSection accounts={self.accounts} /> : null}
      {self && !self.demo ? <PgnImport id="set-pgn" title="Upload games (PGN)" class="card settings-section" /> : null}
      <AnalysisSection s={s} />
      <GamesSection s={s} />
      <TrainingSection s={s} />
      <AppearanceSection s={s} />
      <DataSection s={s} />
    </div>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <section class="card settings-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {intro ? <p class="muted small settings-intro">{intro}</p> : null}
      <div class="stack">{children}</div>
    </section>
  );
}

// ── Accounts ────────────────────────────────────────────────────────────
function AccountsSection({ accounts }: { accounts: readonly Account[] }): JSX.Element {
  const initial = {
    lichess: accounts.find(a => a.platform === 'lichess')?.username ?? '',
    chesscom: accounts.find(a => a.platform === 'chesscom')?.username ?? '',
  };
  const [lichess, setLichess] = useState(initial.lichess);
  const [chesscom, setChesscom] = useState(initial.chesscom);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setLichess(initial.lichess);
    setChesscom(initial.chesscom);
  }, [initial.lichess, initial.chesscom]);

  const next: Account[] = [
    ...(lichess.trim() ? [{ platform: 'lichess' as const, username: lichess.trim() }] : []),
    ...(chesscom.trim() ? [{ platform: 'chesscom' as const, username: chesscom.trim() }] : []),
  ];
  const changed = lichess.trim() !== initial.lichess || chesscom.trim() !== initial.chesscom;

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!changed || next.length === 0) return;
    setPending(true);
    setError(null);
    try {
      await store.updateSelfAccounts(next);
      toast('success', 'Accounts saved. New games will be downloaded and analyzed.');
    } catch (err) {
      const f = friendlyError(err);
      setError(`${f.title}. ${f.text}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Section
      id="accounts"
      title="Your accounts"
      intro={
        accounts.length === 0
          ? 'Add your Lichess or Chess.com username to download new games automatically, alongside the games you uploaded.'
          : 'Games from both accounts are combined. Removing an account removes its games.'
      }
    >
      <form class="stack" onSubmit={submit}>
        <div class="settings-two">
          <Field label="Lichess username" htmlFor="set-lichess">
            <input id="set-lichess" class="input" value={lichess} autoCapitalize="off" spellcheck={false} onInput={e => setLichess(e.currentTarget.value)} />
          </Field>
          <Field label="Chess.com username" htmlFor="set-chesscom">
            <input id="set-chesscom" class="input" value={chesscom} autoCapitalize="off" spellcheck={false} onInput={e => setChesscom(e.currentTarget.value)} />
          </Field>
        </div>
        {error ? (
          <p class="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {next.length === 0 && accounts.length > 0 ? <p class="field-hint">Keep at least one account.</p> : null}
        <div class="row">
          <button type="submit" class="btn btn-primary" disabled={!changed || next.length === 0 || pending}>
            {pending ? <Spinner label="" size={18} /> : null}
            Save accounts
          </button>
        </div>
      </form>
    </Section>
  );
}

// ── Analysis ────────────────────────────────────────────────────────────
const maxWorkers = (): number => Math.max(1, navigator.hardwareConcurrency || 4);
const CONFIRM_DEPTHS = [0, 8, 10, 12, 14, 16, 18, 20, 22] as const;

function AnalysisSection({ s }: { s: AppSettings }): JSX.Element {
  const [run, pending] = useAction();
  const busy = store.busy.value || store.otherTabBusy.value;
  return (
    <Section
      id="analysis"
      title="Analysis"
      intro="Stockfish 19 checks every position you reached in at least two games. Results are cached, so re-analyzing only checks what is new."
    >
      <Segmented<AnalysisPreset> label="Depth" options={PRESETS} value={s.preset} onChange={preset => save({ preset })} />
      <details class="settings-advanced">
        <summary>Advanced</summary>
        <div class="stack">
          <RangeField
            label="Moves analyzed per game"
            min={10}
            max={40}
            step={2}
            value={s.openingPlies}
            format={v => `first ${Math.round(v / 2)} moves`}
            hint="Each side’s first moves. More moves find later mistakes but take longer."
            onChange={openingPlies => save({ openingPlies })}
          />
          <Field
            label="Confirm depth"
            htmlFor="set-depth"
            hint="Overrides the depth used to confirm a suspected mistake (Standard uses 14). Each extra level costs roughly 1.5× the time."
          >
            <select
              id="set-depth"
              class="select"
              value={String(s.depthOverride)}
              aria-describedby="set-depth-hint"
              onChange={e => save({ depthOverride: Number(e.currentTarget.value) })}
            >
              {CONFIRM_DEPTHS.map(d => (
                <option key={d} value={d}>
                  {d === 0 ? 'From preset' : `Depth ${d}`}
                </option>
              ))}
            </select>
          </Field>
          <RangeField
            label="Engine workers"
            min={0}
            max={maxWorkers()}
            value={Math.min(s.engineWorkers, maxWorkers())}
            format={v => (v === 0 ? 'Automatic' : `${v} ${v === 1 ? 'worker' : 'workers'}`)}
            hint="Parallel Stockfish copies (about 70 MB of memory each). Automatic uses fewer on phones."
            onChange={engineWorkers => save({ engineWorkers })}
          />
        </div>
      </details>
      <div class="row">
        <button type="button" class="btn" disabled={busy || pending} onClick={() => void run(() => store.analyze(), { success: 'Re-analysis started.' })}>
          <Icon name="refresh" size={18} /> Re-analyze now
        </button>
        <span class="small muted">Applies new settings to the games you already have.</span>
      </div>
    </Section>
  );
}

// ── Games ───────────────────────────────────────────────────────────────
function GamesSection({ s }: { s: AppSettings }): JSX.Element {
  return (
    <Section id="games" title="Games">
      <Field
        label="Games kept per account"
        htmlFor="set-games"
        hint="Most recent standard games. The first sync starts with the newest 300 so results arrive quickly."
      >
        <select
          id="set-games"
          class="select"
          value={String(s.gamesPerAccount)}
          aria-describedby="set-games-hint"
          onChange={e => save({ gamesPerAccount: Number(e.currentTarget.value) })}
        >
          {GAMES_PER_ACCOUNT.map(n => (
            <option key={n} value={n}>
              {formatCount(n)} games
            </option>
          ))}
        </select>
      </Field>
      <Toggle
        label="Sync automatically"
        hint="Fetch new games when you open the app and the last sync is more than 6 hours old."
        checked={s.autoSync}
        onChange={autoSync => save({ autoSync })}
      />
    </Section>
  );
}

// ── Training ────────────────────────────────────────────────────────────
function TrainingSection({ s }: { s: AppSettings }): JSX.Element {
  return (
    <Section id="training" title="Training">
      <RangeField label="Positions per session" min={5} max={30} value={s.sessionSize} format={v => `${v}`} onChange={sessionSize => save({ sessionSize })} />
      <RangeField
        label="New positions per day"
        min={0}
        max={20}
        value={s.newPerDay}
        format={v => (v === 0 ? 'Reviews only' : `${v}`)}
        hint="Reviews of positions you have already met always come first."
        onChange={newPerDay => save({ newPerDay })}
      />
      <RangeField
        label="Replay before each position"
        min={0}
        max={12}
        value={s.replayPlies}
        format={v => (v === 0 ? 'Off' : v === 1 ? 'last half-move' : `last ${v} half-moves`)}
        hint="Shows how the position arises. Skipped automatically if your device asks for reduced motion."
        onChange={replayPlies => save({ replayPlies })}
      />
    </Section>
  );
}

// ── Appearance ──────────────────────────────────────────────────────────
function AppearanceSection({ s }: { s: AppSettings }): JSX.Element {
  return (
    <Section id="appearance" title="Appearance">
      <Segmented<AppSettings['theme']>
        label="Theme"
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        value={s.theme}
        onChange={theme => {
          applyTheme(theme); // instant, even if saving fails
          save({ theme });
        }}
      />
    </Section>
  );
}

// ── Data ────────────────────────────────────────────────────────────────
function DataSection({ s }: { s: AppSettings }): JSX.Element {
  const now = useNow(60_000);
  const [run, pending] = useAction();
  const exportBackup = (): Promise<boolean> =>
    run(async () => {
      // exportData also records settings.lastBackupAt.
      const blob = await store.exportData();
      downloadBlob(blob, `chess-analyzer-backup-${isoDate(Date.now())}.json`);
    }, { success: 'Backup downloaded.' });
  const exportPgn = (): Promise<boolean> =>
    run(async () => {
      const blob = await store.exportMistakesPgn();
      downloadBlob(blob, `chess-analyzer-leaks-${isoDate(Date.now())}.pgn`);
    });
  const clearAll = async (): Promise<void> => {
    const ok = await runAction(() => store.clearData(), { success: 'All data deleted from this browser.' });
    if (ok) navigate(href('home'));
  };
  return (
    <Section id="data" title="Your data" intro="Everything lives in this browser only. Back it up to move to another device or browser.">
      <StorageStatus persisted={s.storagePersisted} />
      <p class="small muted">Last backup: {s.lastBackupAt ? relativeTime(s.lastBackupAt, now) : 'never'}</p>
      <div class="settings-actions">
        <button type="button" class="btn" disabled={pending} onClick={() => void exportBackup()}>
          <Icon name="download" size={18} /> Download backup
        </button>
        <FileButton accept=".json,application/json" onFile={file => void run(() => store.importData(file))}>
          <Icon name="upload" size={18} /> Restore backup
        </FileButton>
        <button type="button" class="btn" disabled={pending} onClick={() => void exportPgn()}>
          <Icon name="file" size={18} /> Export leaks as PGN
        </button>
      </div>
      <p class="small muted">The PGN opens in a Lichess study or Chessable: one chapter per leak, with the best move and your usual move.</p>
      <hr />
      <div class="settings-actions">
        <CopyButton text={() => collectDiagnostics()} label="Copy diagnostics" class="btn" />
        <ConfirmButton onConfirm={clearAll} confirmLabel="Click again to delete everything">
          <Icon name="trash" size={18} /> Delete all data
        </ConfirmButton>
      </div>
      <p class="small muted">Diagnostics contain your settings and app state but no games — paste them into a bug report.</p>
    </Section>
  );
}

function StorageStatus({ persisted }: { persisted: boolean | undefined }): JSX.Element {
  const [usage, setUsage] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    navigator.storage
      ?.estimate?.()
      .then(est => {
        if (live && est.usage !== undefined) setUsage(`${(est.usage / 1024 / 1024).toFixed(1)} MB used`);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (persisted === true) {
    return (
      <Banner tone="good" icon="shield" title="Storage is persistent">
        The browser won’t clear your data on its own.{usage ? ` ${usage}.` : ''}
      </Banner>
    );
  }
  return (
    <Banner tone="warn" title={persisted === false ? 'Storage may be cleared by the browser' : 'Storage not yet made persistent'}>
      {persisted === false
        ? 'Your browser didn’t grant persistent storage. Download a backup from time to time, or install the app to your home screen.'
        : 'Chess Analyzer asks for persistent storage after your first analysis.'}
      {usage ? ` ${usage}.` : ''}
    </Banner>
  );
}
