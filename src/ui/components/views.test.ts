import { describe, expect, it } from 'vitest';
import { START_FEN } from '../../core/chess';
import type { AnalysisProgress, Mistake, Occurrence, ReviewState, StoredGame, SyncProgress } from '../../core/types';
import { gameBreakdown, nextDue, sinceVisit } from '../pages/Dashboard';
import { arrowFromUci, replayFrames } from './Board';
import { evalParts, evalSpoken } from './EvalText';
import { jobView } from './ProgressCard';

const NOW = 1_800_000_000_000;

const sync = (p: Partial<SyncProgress>): SyncProgress => ({ profileId: 'p', phase: 'running', fetched: 0, added: 0, ...p });
const analysis = (p: Partial<AnalysisProgress>): AnalysisProgress => ({
  profileId: 'p',
  phase: 'evaluating',
  gamesUsed: 300,
  totalPositions: 310,
  donePositions: 41,
  weightDone: 600,
  weightTotal: 1000,
  cacheHits: 0,
  engineEvals: 41,
  mistakesFound: 3,
  startedAt: NOW - 10_000,
  ...p,
});

describe('jobView', () => {
  it('is null when idle or finished', () => {
    expect(jobView(null, null, NOW)).toBeNull();
    expect(jobView(sync({ phase: 'done' }), analysis({ phase: 'done' }), NOW)).toBeNull();
  });

  it('shows download progress with a Lichess ETA', () => {
    const v = jobView(sync({ account: { platform: 'lichess', username: 'hero' }, fetched: 100, expected: 300, added: 90 }), null, NOW);
    expect(v?.title).toBe('Downloading your games from Lichess (hero)');
    expect(v?.detail).toBe('100 of 300 games · 90 new');
    expect(v?.fraction).toBeCloseTo(1 / 3);
    expect(v?.eta).toBe('less than a minute'); // 200 games at 20/s
  });

  it('counts down a rate-limit pause', () => {
    const v = jobView(sync({ phase: 'cooldown', cooldownUntil: NOW + 45_000, account: { platform: 'lichess', username: 'x' } }), null, NOW);
    expect(v?.title).toBe('Lichess asked us to pause');
    expect(v?.detail).toContain('45 s');
    expect(v?.fraction).toBeNull();
  });

  it('shows analysis progress by weight, with counts and ETA', () => {
    const v = jobView(null, analysis({ etaMs: 4 * 60_000 }), NOW, { selfId: 'p', leaksShown: 3 });
    expect(v?.detail).toBe('41 of 310 positions checked · 3 leaks found so far');
    expect(v?.fraction).toBeCloseTo(0.6);
    expect(v?.eta).toBe('about 4 min');
  });

  it('has an indeterminate preparing phase', () => {
    expect(jobView(null, analysis({ phase: 'preparing' }), NOW)?.fraction).toBeNull();
  });
});

const occ = (t: number, m: string): Occurrence => ({ g: `p|lichess:${t}`, t, s: 'blitz', r: true, o: 'win', m });
const mistake = (id: string, p: Partial<Mistake>): Mistake =>
  ({ id, shortId: id, kind: 'mistake', status: 'active', occurrences: [], lastPlayedAt: 0, lastOutcome: 'habit', ...p }) as Mistake;

describe('sinceVisit', () => {
  const since = NOW - 10 * 86_400_000;
  it('splits recently reached leaks into fixed and repeated, newest first', () => {
    const ms = [
      mistake('a', { lastOutcome: 'fixed', occurrences: [occ(NOW - 1000, 'good')], lastPlayedAt: since - 5 }),
      mistake('b', { lastOutcome: 'habit', occurrences: [occ(NOW - 5000, 'bad')], lastPlayedAt: NOW - 5000 }),
      mistake('c', { lastOutcome: 'habit', occurrences: [occ(NOW - 100, 'bad')], lastPlayedAt: NOW - 100 }),
      mistake('old', { lastOutcome: 'habit', occurrences: [occ(since - 1, 'bad')], lastPlayedAt: since - 1 }),
      mistake('book', { kind: 'book', lastOutcome: 'habit', occurrences: [occ(NOW, 'bad')], lastPlayedAt: NOW }),
      mistake('ignored', { status: 'ignored', lastOutcome: 'fixed', occurrences: [occ(NOW, 'x')] }),
    ];
    const r = sinceVisit(ms, since);
    expect(r.fixed.map(m => m.id)).toEqual(['a']);
    expect(r.repeated.map(m => m.id)).toEqual(['c', 'b']);
  });
  it('is empty on the first visit', () => {
    expect(sinceVisit([mistake('a', { occurrences: [occ(NOW, 'x')] })], 0)).toEqual({ fixed: [], repeated: [] });
  });
});

describe('nextDue / gameBreakdown', () => {
  it('finds the earliest future review', () => {
    const r = (due: number): ReviewState => ({ mistakeId: String(due), profileId: 'p', due, interval: 1, ease: 2.5, reps: 1, lapses: 0 });
    expect(nextDue([r(NOW - 5), r(NOW + 50), r(NOW + 10)], NOW)).toBe(NOW + 10);
    expect(nextDue([r(NOW - 5)], NOW)).toBeUndefined();
  });
  it('counts games per colour and speed', () => {
    const g = (color: 'white' | 'black', speed: StoredGame['speed']): StoredGame => ({ color, speed }) as StoredGame;
    const b = gameBreakdown([g('white', 'blitz'), g('black', 'blitz'), g('black', 'rapid')]);
    expect(b).toEqual({ white: 1, black: 2, speeds: [['blitz', 2], ['rapid', 1]] });
  });
});

describe('board helpers', () => {
  it('builds arrows from standard UCI', () => {
    expect(arrowFromUci('e1g1', 'blue')).toEqual({ from: 'e1', to: 'g1', color: 'blue' });
    expect(arrowFromUci('e7e8q', 'orange')).toEqual({ from: 'e7', to: 'e8', color: 'orange' });
    expect(arrowFromUci('junk', 'red')).toBeUndefined();
    expect(arrowFromUci(undefined, 'red')).toBeUndefined();
  });
  it('computes replay frames and stops at an illegal move', () => {
    const frames = replayFrames(START_FEN, ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7', 'e8e7']);
    expect(frames).toHaveLength(8); // start + 7 legal moves; e8e7 after mate is illegal
    expect(frames[0]).toMatchObject({ fen: START_FEN, turn: 'white', check: false });
    expect(frames[7]).toMatchObject({ lastMove: 'h5f7', turn: 'black', check: true });
    expect(replayFrames('bad fen', ['e2e4'])).toEqual([]);
  });
});

describe('EvalText', () => {
  it('spells out what each number means for screen readers, without the arrow', () => {
    const parts = evalParts({ from: { cp: 37 }, to: { cp: 310 }, sideToMove: 'white', user: 'black' });
    expect(evalSpoken(parts)).toBe('You: −0.37 with the best move, −3.10 after this move (clearly worse)');
    // What is seen: the two numbers and an arrow.
    expect(parts.filter(p => p.only !== 'sr').map(p => p.text).join('')).toBe('You: −0.37 → −3.10 (clearly worse)');
  });
  it('reads a single score as it is shown', () => {
    expect(evalSpoken(evalParts({ from: { cp: 30 }, sideToMove: 'white', user: 'white', who: 'Them' }))).toBe('Them: +0.30 (about equal)');
  });
});
