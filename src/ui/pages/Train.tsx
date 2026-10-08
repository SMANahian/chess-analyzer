// Training: a session of cards (due reviews, then new leaks), one leak (#/train?leak=<shortId>) or a
// prep drill against a scouted player (#/train?scout=<profileId>). Each card replays the last moves,
// asks for your move (board or typed SAN), judges it (the engine checks unknown moves), explains the
// habit's refutation, allows a retry, then grades the card automatically (spaced repetition).
import '../styles/features.css';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { playUci } from '../../core/chess';
import type { Mistake, MoveVerdict, ReviewState, SessionCard } from '../../core/types';
import { describeLoss } from '../../core/winrate';
import { Board, arrowFromUci, type BoardArrow, type BoardController, type Replay } from '../components/Board';
import { EmptyState } from '../components/EmptyState';
import { colorName, moveLabel, plural, relativeTime } from '../components/format';
import { isShortcut } from '../components/gestures';
import { prefersReducedMotion, toast, useNow } from '../components/hooks';
import { Icon } from '../components/Icon';
import { habitLabel, lastMoveLabel, lineMoves, punishmentOf, punishmentText } from '../components/leakView';
import { LineView } from '../components/LineView';
import { MoveInput } from '../components/MoveInput';
import { ProgressCard } from '../components/ProgressCard';
import { SkeletonBoard } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import {
  NEW_ATTEMPT,
  afterVerdict,
  cardSpec,
  cleanSolve,
  gradeAttempt,
  hint,
  isGraded,
  practiceCards,
  replayPlan,
  reveal,
  type Attempt,
  type CardSpec,
} from '../components/trainFlow';
import { messageOf } from '../components/errors';
import { href, type PageProps } from '../router';
import { nextDue } from './Dashboard';

const REPLAY_MS = 550;
const REFUTE_MS = 800;
const REFUTE_PLIES = 4;

type Mode = { kind: 'due' } | { kind: 'leak'; shortId: string } | { kind: 'scout'; profileId: string };

interface Session {
  /** Unique per built session (a new session restarts the card flow). */
  id: number;
  cards: SessionCard[];
  /** Extra practice: nothing is graded. */
  practice: boolean;
  title: string;
  /** The leak or scouted player asked for does not exist. */
  empty?: 'not-found';
}

let sessionSeq = 0;
const newSession = (s: Omit<Session, 'id'>): Session => ({ id: ++sessionSeq, ...s });

interface CardResult {
  card: SessionCard;
  attempt: Attempt;
  review?: ReviewState;
}

function modeOf(query: Readonly<Record<string, string>>): Mode {
  if (query.leak) return { kind: 'leak', shortId: query.leak };
  if (query.scout) return { kind: 'scout', profileId: query.scout };
  return { kind: 'due' };
}

async function buildSession(mode: Mode): Promise<Session> {
  if (mode.kind === 'leak') {
    const m = store.getMistakeByShortId(mode.shortId);
    if (!m) return newSession({ cards: [], practice: false, title: 'Train one leak', empty: 'not-found' });
    const review = store.reviews.value.get(m.id);
    const card: SessionCard = review ? { mistake: m, review, isNew: false } : { mistake: m, isNew: true };
    return newSession({ cards: [card], practice: !isGraded(card, Date.now()), title: `Train ${habitLabel(m)}` });
  }
  if (mode.kind === 'scout') {
    const profile = store.profiles.value.find(p => p.id === mode.profileId);
    if (!profile) return newSession({ cards: [], practice: false, title: 'Prep drill', empty: 'not-found' });
    const cards = await store.startSession({ profileId: mode.profileId });
    return newSession({ cards, practice: false, title: `Prep drill vs ${profile.name}` });
  }
  const cards = await store.startSession();
  return newSession({ cards, practice: false, title: 'Training' });
}

/** Extra practice when nothing is due: the listed leaks you'd review soonest (book and borderline left out). */
function practiceSession(): Session {
  const listed = store.visibleMistakes.value.filter(m => m.kind === 'mistake' && m.confidence === 'normal');
  const cards = practiceCards(listed, store.reviews.value, store.settings.value.sessionSize);
  return newSession({ cards, practice: true, title: 'Extra practice' });
}

export default function Train({ route }: PageProps): JSX.Element {
  const mode = modeOf(route.query);
  const modeKey = JSON.stringify(mode);
  const [current, setCurrent] = useState<Session | null>(null);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCurrent(null);
    setError(null);
    buildSession(mode)
      .then(s => live && setCurrent(s))
      .catch(err => live && setError(messageOf(err)));
    return () => {
      live = false;
    };
  }, [modeKey, round]);

  if (error) {
    return (
      <div class="page train-page">
        <EmptyState icon="alert" title="Couldn’t start training" actions={<button type="button" class="btn" onClick={() => setRound(r => r + 1)}>Try again</button>}>
          {error}
        </EmptyState>
      </div>
    );
  }
  if (!current) return <TrainSkeleton />;
  const practise = (): void => setCurrent(practiceSession());
  if (current.cards.length === 0) {
    return (
      <div class="page train-page">
        <TrainEmpty mode={mode} session={current} onPractice={practise} />
      </div>
    );
  }
  return <SessionView key={current.id} session={current} mode={mode} onAgain={() => setRound(r => r + 1)} onPractice={practise} />;
}

function TrainSkeleton(): JSX.Element {
  return (
    <div class="page train-page" aria-busy="true">
      <div class="train-head">
        <span class="skeleton" style={{ width: '40%', height: '22px' }} />
      </div>
      <div class="train-layout">
        <div class="train-board">
          <SkeletonBoard />
        </div>
        <div class="train-panel">
          <span class="skeleton" style={{ width: '70%', height: '20px' }} />
          <span class="skeleton" style={{ width: '50%', height: '16px' }} />
        </div>
      </div>
    </div>
  );
}

// ── Empty states ────────────────────────────────────────────────────────

function TrainEmpty({ mode, session, onPractice }: { mode: Mode; session: Session; onPractice(): void }): JSX.Element {
  const now = useNow(60_000);
  if (mode.kind === 'leak') {
    return (
      <EmptyState icon="leaks" title="That position isn’t in your leaks" actions={<a class="btn" href={href('leaks')}>Go to your leaks</a>}>
        It may have been removed by a newer analysis, or the link comes from another browser.
      </EmptyState>
    );
  }
  if (mode.kind === 'scout') {
    return (
      <EmptyState
        icon="scout"
        title={session.empty === 'not-found' ? 'This scouted player no longer exists' : 'Nothing to drill yet'}
        actions={<a class="btn" href={session.empty === 'not-found' ? href('scout') : href('scout', mode.profileId)}>Back to Scout</a>}
      >
        {session.empty === 'not-found'
          ? 'They may have been removed.'
          : 'Once their games are analyzed, each of their repeated mistakes becomes a drill: find the move that punishes it.'}
      </EmptyState>
    );
  }
  const listed = store.visibleMistakes.value.filter(m => m.kind === 'mistake').length;
  if (store.mistakes.value.length === 0) {
    if (store.busy.value) {
      return (
        <div class="stack">
          <ProgressCard showFinished={false} />
          <EmptyState icon="train" title="Your training cards are on the way">
            Every leak the analysis finds becomes a card. You can start as soon as the first ones appear.
          </EmptyState>
        </div>
      );
    }
    return (
      <EmptyState icon="train" title="No leaks to train yet" actions={<a class="btn btn-primary" href={href('home')}>Go to Home</a>}>
        Once your games are analyzed, every repeated mistake becomes a training card.
      </EmptyState>
    );
  }
  const upcoming = nextDue(store.reviews.value.values(), now);
  return (
    <EmptyState
      icon="check"
      tone="success"
      title="All caught up"
      actions={
        <>
          {listed > 0 ? (
            <button type="button" class="btn btn-primary" onClick={onPractice}>
              <Icon name="play" size={18} /> Practise anyway
            </button>
          ) : null}
          <a class="btn" href={href('leaks')}>
            Back to leaks
          </a>
        </>
      }
    >
      Nothing is due right now{upcoming ? ` — your next review is ${relativeTime(upcoming, now)}` : ''}, and today’s new cards are done.
      Practice doesn’t change your schedule.
    </EmptyState>
  );
}

// ── Session ─────────────────────────────────────────────────────────────

function SessionView({ session, mode, onAgain, onPractice }: { session: Session; mode: Mode; onAgain(): void; onPractice(): void }): JSX.Element {
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<CardResult[]>([]);
  const [ended, setEnded] = useState(false);
  const cards = session.cards;
  let streak = 0;
  for (let i = results.length - 1; i >= 0 && cleanSolve(results[i]!.attempt); i--) streak++;

  if (ended || index >= cards.length) {
    return <Summary session={session} mode={mode} results={results} onAgain={onAgain} onPractice={onPractice} />;
  }
  const card = cards[index]!;
  return (
    <div class="page train-page">
      <header class="train-head">
        <div class="train-head-row">
          <h1 class="train-title">{session.title}</h1>
          <span class="train-count num">
            {cards.length > 1 ? `Card ${index + 1} of ${cards.length}` : session.practice ? 'Practice' : 'One card'}
          </span>
          {streak >= 2 ? (
            <span class="train-streak" title="Solved first try in a row">
              <Icon name="flame" size={16} /> {streak} in a row
            </span>
          ) : null}
          <button type="button" class="btn btn-ghost btn-sm train-end" onClick={() => setEnded(true)}>
            {results.length > 0 ? 'End session' : 'Exit'}
          </button>
        </div>
        {cards.length > 1 ? (
          <div class="train-progress" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={cards.length} aria-valuenow={results.length}>
            <span class="train-progress-fill" style={{ width: `${(results.length / cards.length) * 100}%` }} />
          </div>
        ) : null}
      </header>
      <CardView
        key={card.mistake.id + index}
        card={card}
        graded={!session.practice && isGraded(card, Date.now())}
        last={index === cards.length - 1}
        onFinished={r => setResults(rs => [...rs, r])}
        onNext={() => setIndex(i => i + 1)}
      />
    </div>
  );
}

// ── One card ────────────────────────────────────────────────────────────

type Phase = 'replay' | 'move' | 'checking' | 'refuting' | 'retry' | 'finished';

interface Shown {
  fen: string;
  lastMove?: string;
}

interface Feedback {
  verdict: MoveVerdict;
  move: string;
}

function CardView({ card, graded, last, onFinished, onNext }: { card: SessionCard; graded: boolean; last: boolean; onFinished(r: CardResult): void; onNext(): void }): JSX.Element {
  const m = card.mistake;
  const spec = useMemo(() => cardSpec(m), [m]);
  const ctl = useRef<BoardController | null>(null);
  const replay = useRef<Replay | null>(null);
  const abort = useRef<AbortController | null>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>('replay');
  const [attempt, setAttempt] = useState<Attempt>(NEW_ATTEMPT);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [refute, setRefute] = useState<string[] | null>(null);
  const [review, setReview] = useState<ReviewState | undefined>();
  /** The user is stepping through a line after the card: hide the verdict arrows. */
  const [stepped, setStepped] = useState(false);
  const replayPlies = store.settings.value.replayPlies;

  // 1. Replay the last moves (from a layout effect: no flash of the final position).
  useLayoutEffect(() => {
    const plan = replayPlan(spec.path, replayPlies);
    if (!plan || prefersReducedMotion() || !ctl.current) {
      setPhase('move');
      return;
    }
    const r = ctl.current.replayLine(plan.fromFen, plan.ucis, REPLAY_MS);
    replay.current = r;
    void r.done.then(() => {
      replay.current = null;
      setPhase(p => (p === 'replay' ? 'move' : p));
    });
    return () => r.skip();
  }, []);

  // The habit's refutation, played out on the board.
  useLayoutEffect(() => {
    if (!refute || !ctl.current) return;
    const r = ctl.current.replayLine(spec.fen, refute, REFUTE_MS);
    replay.current = r;
    void r.done.then(() => {
      replay.current = null;
      setPhase(p => (p === 'refuting' ? 'retry' : p));
    });
  }, [refute]);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (phase === 'finished') nextButton.current?.focus({ preventScroll: true });
  }, [phase]);

  const finish = (a: Attempt): void => {
    setAttempt(a);
    setPhase('finished');
    if (!graded) {
      onFinished({ card, attempt: a });
      return;
    }
    store
      .gradeCard(card, gradeAttempt(a, card.review))
      .then(r => {
        setReview(r);
        onFinished({ card, attempt: a, review: r });
      })
      .catch(err => {
        toast('error', `Couldn’t save this result: ${messageOf(err)}`);
        onFinished({ card, attempt: a });
      });
  };

  const showAnswer = (a: Attempt): void => {
    setShown(null);
    setRefute(null);
    finish(reveal(a));
  };

  const submit = async (uci: string): Promise<void> => {
    if (phase !== 'move') return;
    const after = playUci(spec.fen, uci);
    setShown(after ? { fen: after, lastMove: uci } : null);
    setPhase('checking');
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    let verdict: MoveVerdict;
    try {
      verdict = await store.submitMove(card, uci, ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      toast('error', `Couldn’t check that move: ${messageOf(err)}`);
      verdict = { kind: 'unknown' };
    }
    if (ctrl.signal.aborted) return;
    const { attempt: next, next: step } = afterVerdict(attempt, verdict);
    setFeedback({ verdict, move: uci });
    setAttempt(next);
    if (step === 'done') return finish(next);
    if (step === 'ignore') {
      setShown(null);
      setPhase('move');
      return;
    }
    if (verdict.kind === 'habit' && spec.habitLine && spec.habitLine.length > 1) {
      const line = spec.habitLine.slice(0, REFUTE_PLIES);
      const frames = lineMoves(spec.fen, line);
      const end = frames[frames.length - 1];
      setShown(end ? { fen: end.fenAfter, lastMove: end.uci } : null);
      setRefute(line);
      setPhase('refuting');
      return;
    }
    if (step === 'reveal') return showAnswer(next);
    setPhase('retry');
  };

  const retry = (): void => {
    replay.current?.skip();
    if (attempt.failures >= 2) return showAnswer(attempt);
    setShown(null);
    setRefute(null);
    setFeedback(null);
    setPhase('move');
  };

  const takeHint = (): void => setAttempt(a => hint(a));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isShortcut(e)) return;
      const onButton = e.target instanceof Element && e.target.closest('button, a');
      if (e.key === ' ' && phase === 'replay' && !onButton) replay.current?.skip();
      else if (e.key === 'h' && phase === 'move') takeHint();
      else if (e.key === 'Enter' && phase === 'retry' && !onButton) retry();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const arrows = stepped ? [] : arrowsFor(phase, attempt, feedback, spec);
  return (
    <div class="train-layout">
      <div class="train-board">
        <Board
          fen={shown?.fen ?? spec.fen}
          orientation={spec.userColor}
          interactive={phase === 'move'}
          lastMove={shown ? shown.lastMove : spec.lastMove}
          arrows={arrows}
          controller={ctl}
          onMove={uci => void submit(uci)}
          label={`Training position. You are ${colorName(spec.userColor)}${spec.lastMove ? `; your opponent just played ${lastMoveLabel(spec.path) ?? ''}` : ''}.`}
        />
      </div>
      <div class="train-panel">
        <CardMeta card={card} spec={spec} graded={graded} />
        <div class="train-feedback" aria-live="polite">
          <PanelBody
            phase={phase}
            spec={spec}
            m={m}
            attempt={attempt}
            feedback={feedback}
            review={review}
            graded={graded}
            onSkip={() => replay.current?.skip()}
            onRetry={retry}
            onShowAnswer={() => showAnswer(attempt)}
            onStep={s => {
              setStepped(true);
              setShown(s);
            }}
          />
        </div>
        {phase === 'finished' ? (
          <button type="button" class="btn btn-primary btn-lg btn-block train-next" ref={nextButton} onClick={onNext}>
            {last ? 'See results' : 'Next card'} <Icon name="chevron" size={18} />
          </button>
        ) : (
          <div class="train-controls">
            <MoveInput fen={spec.fen} onSubmit={uci => void submit(uci)} disabled={phase !== 'move'} label="Or type your move" placeholder="e.g. Nf6, O-O" />
            <div class="train-help" hidden={phase !== 'move' && phase !== 'replay'}>
              <button type="button" class="btn btn-ghost btn-sm" onClick={takeHint} disabled={phase !== 'move' || attempt.hints >= 2}>
                <Icon name="bulb" size={18} /> {attempt.hints === 0 ? 'Hint' : attempt.hints === 1 ? 'Show the move' : 'Hint shown'}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => showAnswer(attempt)} disabled={phase !== 'move'}>
                Show answer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function arrowsFor(phase: Phase, a: Attempt, f: Feedback | null, spec: CardSpec): BoardArrow[] {
  const list: (BoardArrow | undefined)[] = [];
  const bestFrom = spec.best.slice(0, 2);
  if (phase === 'move' && a.hints === 1) list.push(arrowFromUci(`${bestFrom}${bestFrom}`, 'blue'));
  if (phase === 'move' && a.hints >= 2) list.push(arrowFromUci(spec.best, 'blue'));
  if (phase === 'retry' && f?.verdict.kind === 'wrong') list.push(arrowFromUci(f.move, 'red'));
  if (phase === 'finished' && a.revealed) list.push(arrowFromUci(spec.best, 'blue'));
  if (phase === 'finished' && !a.revealed && f) list.push(arrowFromUci(f.move, 'green'));
  return list.filter((x): x is BoardArrow => !!x);
}

function CardMeta({ card, spec, graded }: { card: SessionCard; spec: CardSpec; graded: boolean }): JSX.Element {
  const m = card.mistake;
  return (
    <div class="train-meta">
      <span class="train-opening">{m.openingName ?? 'Unnamed line'}</span>
      <span class="train-tags">
        {spec.prep ? <span class="badge badge-accent">Prep drill</span> : card.isNew ? <span class="badge badge-accent">New</span> : <span class="badge">Review</span>}
        {!graded ? <span class="badge">Practice</span> : null}
      </span>
    </div>
  );
}

interface PanelProps {
  phase: Phase;
  spec: CardSpec;
  m: Mistake;
  attempt: Attempt;
  feedback: Feedback | null;
  review?: ReviewState;
  graded: boolean;
  onSkip(): void;
  onRetry(): void;
  onShowAnswer(): void;
  onStep(s: Shown | null): void;
}

function PanelBody(p: PanelProps): JSX.Element {
  const { phase, spec, m } = p;
  const opponent = lastMoveLabel(spec.path);
  if (phase === 'replay') {
    return (
      <Prompt tone="neutral" icon="play" title="Here’s how you got here…">
        <p class="small">
          <button type="button" class="link-button" onClick={p.onSkip}>
            Skip to the position
          </button>{' '}
          <span class="faint">(or press Space, or tap the board)</span>
        </p>
      </Prompt>
    );
  }
  if (phase === 'move') {
    return (
      <Prompt tone="accent" title={`Your move — you are ${colorName(spec.userColor)}`}>
        {spec.prep ? (
          <p>
            {opponent ? (
              <>
                They just played <span class="move move-habit">{habitLabel(m)}</span>, as they do in {m.count} of {plural(m.positionCount, 'game')}.{' '}
              </>
            ) : null}
            Find the move that punishes it.
          </p>
        ) : opponent ? (
          <p>
            Your opponent just played <span class="move">{opponent}</span>.
          </p>
        ) : null}
        {p.feedback?.verdict.kind === 'unknown' ? <p class="small muted">The engine couldn’t check that move. Try it again, or another one.</p> : null}
        {p.attempt.failures > 0 ? <p class="small muted">Second try — take your time.</p> : null}
        {p.attempt.hints === 1 ? <p class="small train-hint">Hint: move the piece on the highlighted square.</p> : null}
        {p.attempt.hints >= 2 ? (
          <p class="small train-hint">
            Hint: play <span class="move move-best">{moveLabel(spec.fen, spec.best)}</span>.
          </p>
        ) : null}
      </Prompt>
    );
  }
  if (phase === 'checking') {
    return (
      <Prompt tone="neutral" title="Checking with the engine…" spinner>
        <p class="small muted">A move you haven’t played here before gets a fresh look from Stockfish. This takes a second.</p>
      </Prompt>
    );
  }
  const f = p.feedback;
  if ((phase === 'refuting' || phase === 'retry') && f?.verdict.kind === 'habit') {
    return (
      <Prompt tone="habit" icon="repeat" title={<>That’s your usual <span class="move">{moveLabel(spec.fen, f.move)}</span> — here’s why it fails</>}>
        <p>{punishmentText(moveLabel(spec.fen, f.move), punishmentOf(m))}</p>
        {phase === 'retry' ? <RetryButtons attempt={p.attempt} onRetry={p.onRetry} onShowAnswer={p.onShowAnswer} /> : <p class="small muted">Watch the board…</p>}
      </Prompt>
    );
  }
  if (phase === 'retry' && f?.verdict.kind === 'wrong') {
    const loss = f.verdict.loss;
    return (
      <Prompt tone="bad" icon="close" title="Not quite">
        <p>
          <span class="move">{moveLabel(spec.fen, f.move)}</span> costs about {Math.round(loss)}% winning chances ({describeLoss(loss)}).
        </p>
        <RetryButtons attempt={p.attempt} onRetry={p.onRetry} onShowAnswer={p.onShowAnswer} />
      </Prompt>
    );
  }
  return <Finished {...p} />;
}

function RetryButtons({ attempt, onRetry, onShowAnswer }: { attempt: Attempt; onRetry(): void; onShowAnswer(): void }): JSX.Element {
  const lastTry = attempt.failures >= 2;
  return (
    <div class="train-actions">
      <button type="button" class="btn btn-primary" onClick={onRetry}>
        {lastTry ? 'Show the answer' : 'Try again'}
      </button>
      {lastTry ? null : (
        <button type="button" class="btn btn-ghost" onClick={onShowAnswer}>
          Show answer
        </button>
      )}
    </div>
  );
}

function Finished({ spec, m, attempt, feedback, review, graded, onStep }: PanelProps): JSX.Element {
  const best = moveLabel(spec.fen, spec.best);
  const v = feedback?.verdict;
  const schedule = <Schedule review={review} graded={graded} habit={attempt.habit} />;
  const stepper = (line: readonly string[], label: string, lead: 'best' | 'habit' | undefined): JSX.Element => (
    <LineView
      startFen={spec.fen}
      ucis={line}
      lead={lead}
      label={label}
      maxPlies={8}
      onSelect={i => {
        const frame = lineMoves(spec.fen, line)[i];
        if (frame) onStep({ fen: frame.fenAfter, lastMove: frame.uci });
      }}
    />
  );
  if (attempt.revealed) {
    return (
      <Prompt tone="reveal" icon="bulb" title={<>The move is <span class="move move-best">{best}</span></>}>
        {spec.habit && !spec.prep ? <p>{punishmentText(moveLabel(spec.fen, spec.habit), punishmentOf(m))}</p> : null}
        <div class="train-line">
          <span class="small muted">Best line</span>
          {stepper(spec.bestLine, 'Best line', 'best')}
        </div>
        {schedule}
      </Prompt>
    );
  }
  if (v?.kind === 'low-confidence') {
    return (
      <Prompt tone="ok" icon="check" title="Playable">
        <p>
          <span class="move">{moveLabel(spec.fen, feedback!.move)}</span> works, but <span class="move move-best">{best}</span> is more precise.
        </p>
        <div class="train-line">
          <span class="small muted">Best line</span>
          {stepper(spec.bestLine, 'Best line', 'best')}
        </div>
        {schedule}
      </Prompt>
    );
  }
  const isBest = v?.kind === 'correct' && v.best;
  const own = v?.kind === 'correct' && v.line && !v.best ? v.line.pv : null;
  return (
    <Prompt tone="good" icon="check" title={attempt.habit ? 'That’s the one' : attempt.tries > 1 || attempt.hints > 0 ? 'Correct' : 'Correct!'}>
      <p>
        {isBest || !feedback ? (
          <>
            <span class="move move-best">{best}</span> is the engine’s top move.
          </>
        ) : (
          <>
            <span class="move">{moveLabel(spec.fen, feedback.move)}</span> is good too; the engine’s top choice was{' '}
            <span class="move move-best">{best}</span>.
          </>
        )}
      </p>
      {own ? (
        <div class="train-line">
          <span class="small muted">Your line</span>
          {stepper(own, 'Your line', undefined)}
        </div>
      ) : null}
      <div class="train-line">
        <span class="small muted">{isBest ? 'How it continues' : 'Best line'}</span>
        {stepper(spec.bestLine, 'Best line', 'best')}
      </div>
      {schedule}
    </Prompt>
  );
}

function Schedule({ review, graded, habit }: { review?: ReviewState; graded: boolean; habit: boolean }): JSX.Element | null {
  const now = useNow(30_000);
  if (!graded) return <p class="tiny faint train-schedule">Practice — your review schedule is unchanged.</p>;
  if (!review) return null;
  const when = relativeTime(review.due, now);
  return (
    <p class="tiny faint train-schedule">
      <Icon name="clock" size={14} /> {habit || review.lastGrade === 'again' ? `You’ll see this again ${when}.` : `Next review ${when}.`}
    </p>
  );
}

function Prompt({ tone, icon, title, spinner, children }: { tone: 'neutral' | 'accent' | 'good' | 'ok' | 'bad' | 'habit' | 'reveal'; icon?: 'play' | 'check' | 'close' | 'repeat' | 'bulb'; title: ComponentChildren; spinner?: boolean; children?: ComponentChildren }): JSX.Element {
  return (
    <div class={`prompt prompt-${tone}`}>
      <p class="prompt-title">
        {spinner ? <Spinner label="" size={18} /> : icon ? <Icon name={icon} size={20} strokeWidth={2.2} class="prompt-icon" /> : null}
        <span>{title}</span>
      </p>
      {children ? <div class="prompt-body">{children}</div> : null}
    </div>
  );
}

// ── Summary ─────────────────────────────────────────────────────────────

function Summary({ session, mode, results, onAgain, onPractice }: { session: Session; mode: Mode; results: CardResult[]; onAgain(): void; onPractice(): void }): JSX.Element {
  const now = useNow(60_000);
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    if (mode.kind !== 'due') return;
    store
      .practiceStats(7)
      .then(s => setDays(s.streak))
      .catch(() => undefined);
  }, []);
  const solved = results.filter(r => cleanSolve(r.attempt)).length;
  const due = store.dueCount.value;
  const upcoming = nextDue(store.reviews.value.values(), now);
  const back = mode.kind === 'scout' ? href('scout', mode.profileId) : href('leaks');
  return (
    <div class="page page-narrow train-page">
      <section class="card train-summary" aria-labelledby="summary-title">
        <span class="summary-icon">
          <Icon name={results.length > 0 && solved === results.length ? 'sparkle' : 'check'} size={28} />
        </span>
        <h1 id="summary-title">{results.length === 0 ? 'Session ended' : 'Session complete'}</h1>
        {results.length > 0 ? (
          <p class="summary-score">
            <span>
              <strong class="num">{solved}</strong> of <strong class="num">{results.length}</strong> solved on the first try
            </span>
            {days !== null && days > 1 ? (
              <span class="train-streak">
                <Icon name="flame" size={16} /> {days}-day streak
              </span>
            ) : null}
          </p>
        ) : null}
        {results.length > 0 ? (
          <ol class="summary-list">
            {results.map(r => (
              <li key={r.card.mistake.id}>
                <span class="move move-habit">{habitLabel(r.card.mistake)}</span>
                <span class="summary-opening small muted">{r.card.mistake.openingName ?? ''}</span>
                <ResultChip attempt={r.attempt} />
                <span class="tiny faint num">{r.review ? `next ${relativeTime(r.review.due, now)}` : session.practice ? 'practice' : ''}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <p class="small muted">
          {session.practice ? 'Practice doesn’t change your review schedule. ' : ''}
          {mode.kind === 'due' && due > 0
            ? `${plural(due, 'more card')} ${due === 1 ? 'is' : 'are'} due now.`
            : upcoming !== undefined && upcoming - now < 60_000
              ? 'Another card is due in a moment.'
              : upcoming
                ? `Your next review is ${relativeTime(upcoming, now)}.`
                : 'Come back tomorrow for new cards.'}
        </p>
        <div class="summary-actions">
          {mode.kind === 'due' && due > 0 ? (
            <button type="button" class="btn btn-primary" onClick={onAgain}>
              <Icon name="play" size={18} /> Train more
            </button>
          ) : mode.kind === 'due' && store.visibleMistakes.value.length > 0 ? (
            <button type="button" class="btn btn-primary" onClick={onPractice}>
              <Icon name="play" size={18} /> Practise more
            </button>
          ) : mode.kind === 'scout' ? (
            <button type="button" class="btn btn-primary" onClick={onAgain}>
              <Icon name="repeat" size={18} /> Drill again
            </button>
          ) : null}
          <a class="btn" href={back}>
            {mode.kind === 'scout' ? 'Back to the report' : 'Back to leaks'}
          </a>
          <a class="btn btn-ghost" href={href('home')}>
            Home
          </a>
        </div>
      </section>
    </div>
  );
}

function ResultChip({ attempt }: { attempt: Attempt }): JSX.Element {
  if (cleanSolve(attempt)) return <span class="badge badge-good">Solved</span>;
  if (attempt.habit) return <span class="badge badge-warn">Habit</span>;
  if (attempt.revealed) return <span class="badge">Missed</span>;
  return <span class="badge badge-accent">With help</span>;
}
