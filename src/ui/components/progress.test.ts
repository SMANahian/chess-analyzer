import { describe, expect, it } from 'vitest';
import type { AnalysisProgress, SyncProgress } from '../../core/types';
import { ANNOUNCE_MIN_MS, finishedState, jobView, nextAnnouncement, syncMessageDetail, type Announcement, type JobView } from './ProgressCard';

const NOW = 1_800_000_000_000;
const sync = (p: Partial<SyncProgress>): SyncProgress => ({ profileId: 'self', phase: 'running', fetched: 0, added: 0, ...p });
const analysis = (p: Partial<AnalysisProgress>): AnalysisProgress => ({
  profileId: 'self',
  phase: 'evaluating',
  gamesUsed: 300,
  totalPositions: 310,
  donePositions: 41,
  weightDone: 600,
  weightTotal: 1000,
  cacheHits: 0,
  engineEvals: 41,
  mistakesFound: 41,
  startedAt: NOW - 10_000,
  ...p,
});

describe('finishedState: what Retry / Resume restarts', () => {
  it('a scouted player’s failed download retries that player, not the own profile', () => {
    const f = finishedState(sync({ profileId: 'scout-1', phase: 'error', error: 'Couldn’t reach Lichess.', errorKind: 'network' }), null);
    expect(f?.retry).toEqual({ kind: 'refresh', profileId: 'scout-1' });
    expect(f?.tone).toBe('danger');
    expect(f?.suggestPgn).toBe(true);
  });

  it('a failed analysis only re-runs the analysis of its profile', () => {
    const f = finishedState(sync({ profileId: 'scout-2', phase: 'done' }), analysis({ profileId: 'scout-2', phase: 'error', error: 'Engine crashed' }));
    expect(f?.retry).toEqual({ kind: 'analyze', profileId: 'scout-2' });
    expect(f?.text).toBe('Engine crashed');
  });

  it('resumes a cancelled download with a refresh and a cancelled analysis with an analysis', () => {
    expect(finishedState(sync({ profileId: 'scout-3', phase: 'cancelled' }), null)?.retry).toEqual({ kind: 'refresh', profileId: 'scout-3' });
    const f = finishedState(sync({ phase: 'done' }), analysis({ profileId: 'self', phase: 'cancelled' }));
    expect(f?.retry).toEqual({ kind: 'analyze', profileId: 'self' });
    expect(f?.retryLabel).toBe('Resume');
  });

  it('an analysis that finished with positions it could not check says so, with its own dismiss key', () => {
    const a = analysis({ profileId: 'scout-4', phase: 'done', error: '3 positions could not be evaluated.' });
    const f = finishedState(null, a);
    expect(f).toMatchObject({ tone: 'info', key: `d${a.startedAt}`, retry: { kind: 'analyze', profileId: 'scout-4' } });
    expect(f?.text).toBe('3 positions could not be evaluated. The next refresh tries them again.');
  });

  it('is null after a clean finish', () => {
    expect(finishedState(sync({ phase: 'done' }), analysis({ phase: 'done' }))).toBeNull();
  });
});

describe('jobView copy', () => {
  it('titles a PGN import as such, with its progress from the file', () => {
    const v = jobView(sync({ fetched: 120, added: 100, message: 'Reading the PGN file (45%)' }), null, NOW);
    expect(v?.title).toBe('Reading your PGN file');
    expect(v?.detail).toBe('120 games read · 100 new');
    expect(v?.fraction).toBeCloseTo(0.45);
  });

  it('does not call the first moment of a regular sync a PGN import', () => {
    expect(jobView(sync({}), null, NOW)?.title).toBe('Downloading your games');
  });

  it('shows one download estimate: the message’s own “(about N s left)” is dropped', () => {
    const v = jobView(
      sync({ account: { platform: 'lichess', username: 'hero' }, fetched: 100, expected: 220, added: 90, message: 'Lichess: downloading games (about 6 s left)' }),
      null,
      NOW,
    );
    expect(v?.detail).toBe('100 of 220 games · 90 new');
    expect(v?.detail).not.toContain('left');
    expect(v?.eta).toBe('less than a minute');
  });

  it('keeps an informative message (the Chess.com month)', () => {
    expect(syncMessageDetail('Chess.com: 2024/05')).toBe('Chess.com: 2024/05');
    expect(syncMessageDetail('Lichess: downloading games (about 12 s left)')).toBe('');
    expect(syncMessageDetail(undefined)).toBe('');
  });

  it('counts the leaks the list shows for the own profile, and findings for anyone else', () => {
    expect(jobView(null, analysis({}), NOW, { selfId: 'self', leaksShown: 36 })?.detail).toBe('41 of 310 positions checked · 36 leaks found so far');
    expect(jobView(null, analysis({ profileId: 'scout' }), NOW, { selfId: 'self', leaksShown: 36 })?.detail).toBe(
      '41 of 310 positions checked · 41 findings so far',
    );
  });
});

describe('nextAnnouncement (the only live region for jobs)', () => {
  const view = (title: string, fraction: number | null): JobView => ({ title, detail: '', fraction, cancellable: true });

  it('announces a new phase at once', () => {
    const a = nextAnnouncement(null, view('Checking your positions with Stockfish', 0.01), NOW);
    expect(a?.text).toBe('Checking your positions with Stockfish.');
    const b = nextAnnouncement(a, view('Finding the positions you reach again and again', null), NOW + 1000);
    expect(b?.text).toBe('Finding the positions you reach again and again.');
  });

  it('stays quiet for counter and ETA changes inside a phase', () => {
    const a = nextAnnouncement(null, view('T', 0.01), NOW)!;
    expect(nextAnnouncement(a, view('T', 0.2), NOW + 30_000)).toBeNull();
  });

  it('announces each further quarter, never sooner than ANNOUNCE_MIN_MS after the previous one', () => {
    const a = nextAnnouncement(null, view('T', 0.1), NOW)!;
    expect(nextAnnouncement(a, view('T', 0.3), NOW + ANNOUNCE_MIN_MS - 1)).toBeNull();
    expect(nextAnnouncement(a, view('T', 0.3), NOW + ANNOUNCE_MIN_MS)?.text).toBe('T: 25% done.');
  });

  it('a whole mocked onboarding (a tick per second, a result per position) gives a handful of announcements', () => {
    let last: Announcement | null = null;
    let count = 0;
    const phases: [string, number][] = [
      ['Downloading your games from Lichess (hero)', 10],
      ['Finding the positions you reach again and again', 3],
      ['Checking your positions with Stockfish', 90],
    ];
    let t = NOW;
    for (const [title, seconds] of phases) {
      for (let i = 0; i <= seconds * 3; i++) {
        t += 333;
        const next = nextAnnouncement(last, view(title, title.startsWith('Finding') ? null : i / (seconds * 3)), t);
        if (next) {
          last = next;
          count++;
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThan(10);
  });
});
