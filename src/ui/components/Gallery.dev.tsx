// Dev-only component gallery at #/dev (`npm run dev`); never part of the production bundle.
// Also the fixture for interaction checks of Board (moves, castling, promotion picker, replay).
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { START_FEN, playUci } from '../../core/chess';
import { Board, arrowFromUci, type BoardArrow, type BoardController } from './Board';
import { ConfirmButton, CopyButton } from './buttons';
import { EmptyState } from './EmptyState';
import { EvalText } from './EvalText';
import { DropZone, RangeField, Segmented, Toggle } from './forms';
import { GameLink } from './GameLink';
import { toast } from './hooks';
import { Modal } from './Modal';
import { MoveInput } from './MoveInput';
import { Banner } from './Notice';
import { SeverityPill } from './SeverityPill';
import { Spinner } from './Spinner';
import { Stat, StatGrid } from './Stat';
import { TabPanel, Tabs } from './Tabs';

const POSITIONS = {
  start: START_FEN,
  castle: 'r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 8',
  promotion: '8/4P1k1/8/8/8/8/6K1/8 w - - 0 1',
  blackPromotion: '8/8/8/8/8/8/4p1k1/K7 b - - 0 1',
} as const;
type PositionName = keyof typeof POSITIONS;

function BoardLab(): JSX.Element {
  const [name, setName] = useState<PositionName>('start');
  const [fen, setFen] = useState<string>(POSITIONS.start);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [lastMove, setLastMove] = useState<string | undefined>();
  const [log, setLog] = useState<string[]>([]);
  const ctl = useRef<BoardController | null>(null);
  const arrows = [arrowFromUci('g1f3', 'blue'), arrowFromUci('f2f4', 'orange')].filter((a): a is BoardArrow => !!a);
  const load = (n: PositionName): void => {
    setName(n);
    setFen(POSITIONS[n]);
    setLastMove(undefined);
    setOrientation(n === 'blackPromotion' ? 'black' : 'white');
  };
  const play = (uci: string): void => {
    setLog(l => [...l, uci]);
    const next = playUci(fen, uci);
    if (next) {
      setFen(next);
      setLastMove(uci);
    }
  };
  const replay = (): void => {
    load('start');
    void ctl.current?.replayLine(START_FEN, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'], 400).done.then(done => setLog(l => [...l, `replay ${done ? 'done' : 'skipped'}`]));
  };
  return (
    <div class="dev-board">
      <div style={{ maxWidth: '480px' }}>
        <Board fen={fen} orientation={orientation} interactive onMove={play} lastMove={lastMove} arrows={name === 'start' && !lastMove ? arrows : []} controller={ctl} label="Test board" />
      </div>
      <div class="stack">
        <Segmented<PositionName>
          label="Position"
          options={[
            { value: 'start', label: 'Start' },
            { value: 'castle', label: 'Castling' },
            { value: 'promotion', label: 'Promote' },
            { value: 'blackPromotion', label: 'Black promotes' },
          ]}
          value={name}
          onChange={load}
        />
        <div class="row">
          <button type="button" class="btn btn-sm" onClick={() => setOrientation(o => (o === 'white' ? 'black' : 'white'))}>
            Flip
          </button>
          <button type="button" class="btn btn-sm" id="dev-replay" onClick={replay}>
            Replay Italian
          </button>
          <button type="button" class="btn btn-sm" onClick={() => ctl.current?.reset()}>
            Reset
          </button>
        </div>
        <MoveInput fen={fen} onSubmit={play} />
        <p class="small muted">
          Moves: <code id="dev-log">{log.join(' ')}</code>
        </p>
      </div>
    </div>
  );
}

export default function Gallery(): JSX.Element {
  const [tab, setTab] = useState<'a' | 'b'>('a');
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<'quick' | 'standard' | 'thorough'>('standard');
  const [on, setOn] = useState(true);
  const [n, setN] = useState(20);
  return (
    <div class="page">
      <div class="page-head">
        <h1>Component gallery</h1>
      </div>
      <section class="card stack">
        <h2>Board</h2>
        <BoardLab />
      </section>
      <section class="card stack">
        <h2>Pills, eval, links</h2>
        <div class="row">
          <SeverityPill severity="inaccuracy" />
          <SeverityPill severity="inaccuracy" confidence="low" />
          <SeverityPill severity="mistake" />
          <SeverityPill severity="blunder" />
          <SeverityPill severity="blunder" compact />
          <SeverityPill severity="inaccuracy" kind="book" />
        </div>
        <p>
          <EvalText from={{ cp: 30 }} to={{ cp: -80 }} sideToMove="black" user="black" />
        </p>
        <p>
          <EvalText from={{ cp: -250 }} sideToMove="white" user="black" />
        </p>
        <p class="row">
          <GameLink game={{ platform: 'lichess', sourceId: 'abcdEFGH' }} ply={12} color="black" />
          <GameLink game="p|chesscom:live/123" />
          <GameLink game={{ platform: 'pgn', sourceId: 'x' }} />
        </p>
      </section>
      <section class="card stack">
        <h2>Controls</h2>
        <Tabs<'a' | 'b'>
          label="Example tabs"
          idPrefix="dev"
          items={[
            { id: 'a', label: 'Active', count: 12 },
            { id: 'b', label: 'Mastered', count: 3 },
          ]}
          value={tab}
          onChange={setTab}
        />
        <TabPanel id={tab} idPrefix="dev">
          <p class="muted">Panel {tab}</p>
        </TabPanel>
        <Segmented<'quick' | 'standard' | 'thorough'>
          label="Preset"
          options={[
            { value: 'quick', label: 'Quick', hint: 'Fastest' },
            { value: 'standard', label: 'Standard', hint: 'Recommended' },
            { value: 'thorough', label: 'Thorough', hint: 'Deepest' },
          ]}
          value={preset}
          onChange={setPreset}
        />
        <Toggle label="A switch" hint="With a hint" checked={on} onChange={setOn} />
        <RangeField label="Range" min={10} max={40} step={2} value={n} onChange={setN} />
        <DropZone title="Drop a file" hint="Any file" onFile={f => toast('info', `Got ${f.name}`)} />
        <div class="row">
          <button type="button" class="btn btn-primary" onClick={() => toast('success', 'Snoozed for 30 days', { label: 'Undo', run: () => toast('info', 'Undone') })}>
            Toast with undo
          </button>
          <button type="button" class="btn" onClick={() => toast('error', 'Something failed')}>
            Error toast
          </button>
          <button type="button" class="btn" onClick={() => setOpen(true)}>
            Open modal
          </button>
          <CopyButton text="copied text" />
          <ConfirmButton onConfirm={() => toast('info', 'Confirmed')}>Delete</ConfirmButton>
          <Spinner />
        </div>
        <Modal open={open} onClose={() => setOpen(false)} title="A modal" actions={<button class="btn" onClick={() => setOpen(false)}>Close</button>}>
          <p>Content</p>
        </Modal>
      </section>
      <StatGrid>
        <Stat label="Games" value="1,204" detail="600 White · 604 Black" />
        <Stat label="Fixed" value="3" tone="good" />
        <Stat label="Due" value="7" href="#/train" />
        <Stat label="Leaks" value="23" tone="warn" />
      </StatGrid>
      <Banner tone="warn" title="A warning banner" onDismiss={() => undefined}>
        Text
      </Banner>
      <EmptyState title="Empty state" actions={<button class="btn">Action</button>}>
        Something helpful.
      </EmptyState>
    </div>
  );
}
