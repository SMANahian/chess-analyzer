// First visit (no self profile): pitch, usernames → store.setupSelf, example report, PGN upload with
// "Which of these is you?", restore a backup, and the privacy promise.
import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { winLoss, severityOf } from '../../core/winrate';
import type { Account, Color, OnlinePlatform } from '../../core/types';
import { Board, arrowFromUci, type BoardArrow } from '../components/Board';
import { EvalText } from '../components/EvalText';
import { friendlyError, type FriendlyError } from '../components/errors';
import { DropZone, Field, FileButton } from '../components/forms';
import { plural } from '../components/format';
import { runAction, useAction, useMediaQuery } from '../components/hooks';
import { Icon } from '../components/Icon';
import { Banner } from '../components/Notice';
import { SeverityPill } from '../components/SeverityPill';
import { Spinner } from '../components/Spinner';
import type { PageProps } from '../router';

export const PRIVACY_TEXT =
  'Your games, mistakes and progress are stored only in this browser. The app downloads your public games from Lichess/Chess.com. No accounts, no analytics.';

const SITE_LABEL: Readonly<Record<OnlinePlatform, string>> = { lichess: 'Lichess', chesscom: 'Chess.com' };
const PGN_ACCEPT = '.pgn,application/x-chess-pgn,application/vnd.chess-pgn,text/plain';

export default function Onboarding({ route }: PageProps): JSX.Element {
  // DOM order = phone order (pitch, form, how it works); on wide screens the form moves to a right column.
  return (
    <div class="onboarding">
      <div class="ob-top">
        <p class="ob-eyebrow">Opening trainer from your own games</p>
        <h1>Find the opening mistakes you keep repeating — and fix them.</h1>
        <p class="ob-lede">Free, private, runs in your browser.</p>
      </div>

      <div class="ob-side">
        <AccountsForm initial={{ lichess: route.query.lichess ?? '', chesscom: route.query.chesscom ?? '' }} />
        <PgnImport id="ob-pgn" title="Or upload a PGN file" class="card ob-card ob-pgn" />
        <p class="ob-restore small muted">
          Used Chess Analyzer before?{' '}
          <FileButton class="link-button" accept=".json,application/json" onFile={file => void runAction(() => store.importData(file))}>
            Restore a backup
          </FileButton>
        </p>
      </div>

      <div class="ob-rest">
        <h2 class="sr-only">How it works</h2>
        <ol class="ob-steps">
          <li>
            <span class="ob-step-n">1</span>
            <span>
              <strong>Enter your username.</strong> We fetch your recent Lichess and Chess.com games.
            </span>
          </li>
          <li>
            <span class="ob-step-n">2</span>
            <span>
              <strong>Stockfish checks the positions you reach again and again</strong> — right here on your device.
            </span>
          </li>
          <li>
            <span class="ob-step-n">3</span>
            <span>
              <strong>Drill your leaks</strong> with spaced repetition until the right move is automatic.
            </span>
          </li>
        </ol>
        <p class="ob-privacy">
          <Icon name="lock" size={18} />
          <span>{PRIVACY_TEXT}</span>
        </p>
        <ExampleLeak />
      </div>
    </div>
  );
}

// ── Usernames ───────────────────────────────────────────────────────────
function AccountsForm({ initial }: { initial: { lichess: string; chesscom: string } }): JSX.Element {
  const [lichess, setLichess] = useState(initial.lichess);
  const [chesscom, setChesscom] = useState(initial.chesscom);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [pending, setPending] = useState(false);
  const [missing, setMissing] = useState(false);
  const [runDemo, demoPending] = useAction();

  const accounts: Account[] = [
    ...(lichess.trim() ? [{ platform: 'lichess' as const, username: lichess.trim() }] : []),
    ...(chesscom.trim() ? [{ platform: 'chesscom' as const, username: chesscom.trim() }] : []),
  ];

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    if (accounts.length === 0) {
      setMissing(true);
      document.getElementById('ob-lichess')?.focus();
      return;
    }
    setError(null);
    setPending(true);
    try {
      await store.setupSelf(accounts);
      // The self profile now exists: the app switches to the dashboard by itself.
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setPending(false);
    }
  };

  // "Same username on the other site?" — offered when exactly one field is filled.
  const same: { to: OnlinePlatform; name: string } | null =
    lichess.trim() && !chesscom.trim() ? { to: 'chesscom', name: lichess.trim() }
    : chesscom.trim() && !lichess.trim() ? { to: 'lichess', name: chesscom.trim() }
    : null;
  const copySame = (): void => {
    if (!same) return;
    if (same.to === 'chesscom') setChesscom(same.name);
    else setLichess(same.name);
  };

  return (
    <section class="card ob-card" aria-labelledby="ob-form-title">
      <h2 id="ob-form-title">Analyze your games</h2>
      <p class="muted small">Either account is enough — add both to combine them.</p>
      <form class="stack" onSubmit={submit} noValidate>
        <Field label="Lichess username" htmlFor="ob-lichess" error={missing && accounts.length === 0 ? 'Enter a Lichess or a Chess.com username.' : undefined}>
          <input
            id="ob-lichess"
            class="input"
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            placeholder="e.g. DrNykterstein"
            value={lichess}
            disabled={pending}
            aria-invalid={error?.platform === 'lichess' || (missing && accounts.length === 0) ? true : undefined}
            aria-describedby={missing && accounts.length === 0 ? 'ob-lichess-error' : undefined}
            onInput={e => setLichess(e.currentTarget.value)}
          />
        </Field>
        <Field label="Chess.com username" htmlFor="ob-chesscom">
          <input
            id="ob-chesscom"
            class="input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            placeholder="e.g. MagnusCarlsen"
            value={chesscom}
            disabled={pending}
            aria-invalid={error?.platform === 'chesscom' ? true : undefined}
            onInput={e => setChesscom(e.currentTarget.value)}
          />
        </Field>
        {same ? (
          <p class="small muted ob-same">
            Same username on {SITE_LABEL[same.to]}?{' '}
            <button type="button" class="link-button" onClick={copySame}>
              Use “{same.name}” there too
            </button>
          </p>
        ) : null}

        {error ? <SetupError error={error} /> : null}

        <button type="submit" class="btn btn-primary btn-lg btn-block" disabled={pending}>
          {pending ? (
            <>
              <Spinner label="" size={18} /> Checking account…
            </>
          ) : (
            <>Analyze my games</>
          )}
        </button>
      </form>
      <div class="ob-or" aria-hidden="true">
        <span>or</span>
      </div>
      <button type="button" class="btn btn-block" disabled={demoPending} onClick={() => void runDemo(() => store.loadDemo())}>
        {demoPending ? <Spinner label="" size={18} /> : <Icon name="sparkle" size={18} />}
        See an example report
      </button>
    </section>
  );
}

function SetupError({ error }: { error: FriendlyError }): JSX.Element {
  return (
    <Banner tone="danger" title={error.title}>
      <p>{error.text}</p>
      {error.suggestPgn ? (
        <p>
          <a href="#ob-pgn" onClick={scrollToPgn}>
            Upload a PGN file instead
          </a>
        </p>
      ) : null}
    </Banner>
  );
}

function scrollToPgn(e: Event): void {
  // A plain #anchor would be read as a route by the hash router.
  e.preventDefault();
  const el = document.getElementById('ob-pgn');
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
}

// ── PGN ─────────────────────────────────────────────────────────────────
type PgnStep =
  | { step: 'idle' }
  | { step: 'scanning'; file: File }
  | { step: 'pick'; file: File; names: { name: string; games: number }[] }
  | { step: 'importing'; file: File };

const MAX_NAMES = 8;

/**
 * PGN upload with "Which of these is you?" (also used by Settings for an existing profile). The games
 * go into the own profile, created when there is none; the analysis then runs in the background.
 */
export function PgnImport({ id, title, class: cls }: { id: string; title: string; class: string }): JSX.Element {
  const [state, setState] = useState<PgnStep>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File): Promise<void> => {
    setError(null);
    setState({ step: 'scanning', file });
    try {
      const names = await store.scanPgn(file);
      if (names.length === 0) {
        setError(`No games found in “${file.name}”. Is it a PGN file?`);
        setState({ step: 'idle' });
        return;
      }
      setState({ step: 'pick', file, names: names.slice(0, MAX_NAMES) });
    } catch (err) {
      const e = friendlyError(err);
      setError(`${e.title}. ${e.text}`);
      setState({ step: 'idle' });
    }
  };

  const startImport = async (file: File, opts: { aliases?: string[]; asColor?: Color }): Promise<void> => {
    setState({ step: 'importing', file });
    // The store reports the result (or the error) as a notice; then another file can be chosen.
    await runAction(() => store.importPgn(file, opts));
    setState({ step: 'idle' });
  };

  return (
    <section class={cls} id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} class="ob-pgn-title">
        {title}
      </h2>
      {state.step === 'pick' ? (
        <NamePicker
          file={state.file}
          names={state.names}
          onCancel={() => setState({ step: 'idle' })}
          onImport={opts => void startImport(state.file, opts)}
        />
      ) : state.step === 'idle' ? (
        <DropZone
          accept={PGN_ACCEPT}
          onFile={file => void onFile(file)}
          title="Drop a .pgn file here, or choose one"
          hint="Over-the-board games, other sites, or an export — any size."
        />
      ) : (
        <p class="row muted" role="status">
          <Spinner label="" size={18} />
          {state.step === 'scanning' ? `Reading “${state.file.name}”…` : `Importing “${state.file.name}”…`}
        </p>
      )}
      {error ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function NamePicker({
  file,
  names,
  onImport,
  onCancel,
}: {
  file: File;
  names: { name: string; games: number }[];
  onImport(opts: { aliases?: string[]; asColor?: Color }): void;
  onCancel(): void;
}): JSX.Element {
  // Pre-select the most frequent name: in a personal export it is almost always the owner.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(names[0] ? [names[0].name] : []));
  const [asColor, setAsColor] = useState<Color | null>(null);
  const toggle = (name: string): void => {
    setAsColor(null);
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setPicked(next);
  };
  const chooseColor = (c: Color): void => {
    setPicked(new Set());
    setAsColor(c);
  };
  const canImport = picked.size > 0 || asColor !== null;
  const submit = (e: Event): void => {
    e.preventDefault();
    // As shown (the store lower-cases aliases): the first one also names a new profile.
    if (asColor) onImport({ asColor });
    else if (picked.size > 0) onImport({ aliases: [...picked] });
  };
  return (
    <form class="stack" onSubmit={submit}>
      <fieldset class="ob-names">
        <legend class="field-label">
          Which of these is you? <span class="muted">({file.name})</span>
        </legend>
        {names.map(n => (
          <label key={n.name} class="ob-name">
            <input type="checkbox" checked={picked.has(n.name)} onChange={() => toggle(n.name)} />
            <span class="ob-name-text">{n.name}</span>
            <span class="muted small num">{plural(n.games, 'game')}</span>
          </label>
        ))}
      </fieldset>
      <fieldset class="ob-names">
        <legend class="field-label">Or: every game in this file is mine, playing…</legend>
        <div class="row">
          {(['white', 'black'] as const).map(c => (
            <label key={c} class="ob-name ob-color">
              <input type="radio" name="ob-ascolor" checked={asColor === c} onChange={() => chooseColor(c)} />
              <span>{c === 'white' ? 'White' : 'Black'}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div class="row">
        <button type="submit" class="btn btn-primary" disabled={!canImport}>
          Import games
        </button>
        <button type="button" class="btn btn-ghost" onClick={onCancel}>
          Choose another file
        </button>
      </div>
    </form>
  );
}

// ── Example (illustration) ──────────────────────────────────────────────
// 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4: 4.Nxe5? Qg5! vs 4.Nxd4 (Stockfish 19 lite, depth 16: +1.07 vs −0.58).
const EXAMPLE = {
  fen: 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  habit: 'f3e5',
  best: 'f3d4',
  scoreBest: { cp: 107 },
  scorePlayed: { cp: -58 },
} as const;

/** The illustration is left out on narrow phones, where it would push the form down. */
const EXAMPLE_MEDIA = '(min-width: 600px)';

function ExampleLeak(): JSX.Element | null {
  const wide = useMediaQuery(EXAMPLE_MEDIA);
  const arrows = useMemo(
    () => [arrowFromUci(EXAMPLE.habit, 'orange'), arrowFromUci(EXAMPLE.best, 'blue')].filter((a): a is BoardArrow => !!a),
    [],
  );
  const loss = winLoss(EXAMPLE.scoreBest, EXAMPLE.scorePlayed);
  const severity = severityOf(loss, EXAMPLE.scoreBest, EXAMPLE.scorePlayed) ?? 'inaccuracy';
  if (!wide) return null;
  return (
    <figure class="ob-example" aria-label="Example of a repeated mistake">
      <div class="ob-example-board">
        <Board fen={EXAMPLE.fen} arrows={arrows} coordinates={false} label="Example position after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4, White to move" />
      </div>
      <figcaption class="ob-example-text">
        <span class="ob-example-tag">Example leak</span>
        <p class="ob-example-head">
          <SeverityPill severity={severity} />
          <span>
            You played <span class="move move-habit">4.Nxe5</span> in <strong>7 of 9</strong> games
          </span>
        </p>
        <p class="small muted">
          After 4…Qg5! Black wins material. Better is <span class="move move-best">4.Nxd4</span>.
        </p>
        <p class="small">
          <EvalText from={EXAMPLE.scoreBest} to={EXAMPLE.scorePlayed} sideToMove="white" user="white" />
        </p>
      </figcaption>
    </figure>
  );
}
