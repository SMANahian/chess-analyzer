// Pure helpers for the live smoke summary: what counts as a failure, mistake counts, the top leaks
// (the app's own default Leaks view) and the Markdown written to the GitHub job summary.
import { formatLine, sanOf } from '../../src/core/chess';
import { applyFilters } from '../../src/core/filters';
import { DEFAULT_FILTERS, type Color, type Mistake, type Severity, type SyncState } from '../../src/core/types';
import type { GameCounts } from './pageHooks';

export interface ProbeResult {
  name: string;
  url: string;
  /** From the page, or from the network when CORS kept the page from reading it. */
  status: number | null;
  ok: boolean;
  /** The page could read the response, i.e. the browser's CORS check passed. */
  readable: boolean;
  allowOrigin: string | null;
  contentType: string | null;
  etagReadable: boolean;
  lastModifiedReadable: boolean;
  json: 'ok' | 'invalid' | 'skipped';
  /** Lichess user: count.all; games: NDJSON lines; Chess.com: archives / games in the month. */
  items: number | null;
  ms: number;
  error?: string;
}

export interface Problems {
  failures: string[];
  warnings: string[];
}

export interface SyncRow {
  platform: string;
  username: string;
  stored: number;
  reachedStart: boolean;
  lastError: string | null;
}

export interface MistakeCounts {
  /** Rows stored for the profile (every status). */
  stored: number;
  /** Active, non-dormant rows of kind 'mistake', by severity (low-confidence ones included). */
  bySeverity: Record<Severity, number>;
  book: number;
  lowConfidence: number;
  /** Rows in the app's default Leaks view. */
  shownByDefault: number;
}

export interface LeakRow {
  rank: number;
  /** "5... Nc6" */
  move: string;
  best: string;
  color: Color;
  opening: string;
  /** k of n: games with the habit move / games reaching the position. */
  played: number;
  reached: number;
  /** Win-% points lost. */
  loss: number;
  severity: Severity;
  confidence: 'normal' | 'low';
  impact: number;
}

export interface AnalysisStats {
  /** The last analysis evaluated every position (the store's completion marker). */
  complete: boolean;
  evalsCached: number;
  engineSearches: number;
  engineBusyMs: number;
  /** Most engine workers alive at once. */
  enginePoolSize: number;
  engineWorkersCreated: number;
  hardwareConcurrency: number | null;
  /** Onboarding submit → first sync finished (account check + download of the first pass). */
  syncMs: number | null;
  /** First sync finished → first analysis finished. */
  firstAnalysisMs: number | null;
  /** Onboarding submit → first analysis finished: the wait before the first results. */
  firstResultsMs: number | null;
  /** Onboarding submit → whole refresh job finished (incl. backfill and re-analysis above 300 games). */
  totalMs: number | null;
}

export interface LiveSummary {
  result: 'passed' | 'failed';
  mode: 'live' | 'mock';
  generatedAt: string;
  commit: string | null;
  accounts: { lichess: string | null; chesscom: string | null };
  gamesPerAccount: number;
  /** gamesPerAccount was written to the app's settings before onboarding. */
  settingsApplied: boolean;
  onboarding: 'form' | 'deep-link' | 'not-reached';
  failures: string[];
  warnings: string[];
  probes: ProbeResult[];
  games: GameCounts | null;
  sync: SyncRow[];
  mistakes: MistakeCounts | null;
  topLeaks: LeakRow[];
  analysis: AnalysisStats | null;
  pageErrors: string[];
  consoleErrors: string[];
  /** Error toasts and alerts visible in the app at the end. */
  notices: string[];
}

const RATE_LIMITED = /\b429\b|rate.?limit|slow down|too many/i;

/** CORS or network failures, unknown accounts and unparseable bodies fail; rate limits and 5xx only warn. */
export function probeProblems(probes: readonly ProbeResult[]): Problems {
  const out: Problems = { failures: [], warnings: [] };
  for (const p of probes) {
    if (!p.readable) {
      const why = p.status === null ? 'network error' : `HTTP ${p.status}, Access-Control-Allow-Origin ${p.allowOrigin ?? 'missing'}`;
      out.failures.push(`${p.name}: the browser could not read ${p.url} (${why})${p.error ? `: ${p.error}` : ''}`);
    } else if (p.status === 429 || (p.status !== null && p.status >= 500)) {
      out.warnings.push(`${p.name}: HTTP ${p.status} (site busy or rate limit, not an app error)`);
    } else if (p.status === 404) {
      out.failures.push(`${p.name}: HTTP 404, no such account`);
    } else if (!p.ok) {
      out.failures.push(`${p.name}: HTTP ${p.status}`);
    } else if (p.json === 'invalid') {
      out.failures.push(`${p.name}: the response is not valid JSON`);
    }
  }
  return out;
}

export function syncRows(states: readonly SyncState[]): SyncRow[] {
  return states.map(s => ({
    platform: s.platform,
    username: s.username,
    stored: s.stored,
    reachedStart: s.reachedStart === true,
    lastError: s.lastError ?? null,
  }));
}

/** A sync error left on an account fails the run, except a rate limit (Lichess asks to wait). */
export function syncProblems(rows: readonly SyncRow[]): Problems {
  const out: Problems = { failures: [], warnings: [] };
  for (const r of rows) {
    if (!r.lastError) continue;
    const text = `Sync ${r.platform} “${r.username}”: ${r.lastError}`;
    (RATE_LIMITED.test(r.lastError) ? out.warnings : out.failures).push(text);
  }
  return out;
}

export function countMistakes(ms: readonly Mistake[], now: number): MistakeCounts {
  const active = ms.filter(m => m.status === 'active' && !m.dormant);
  const real = active.filter(m => m.kind === 'mistake');
  const bySeverity: Record<Severity, number> = { blunder: 0, mistake: 0, inaccuracy: 0 };
  for (const m of real) bySeverity[m.severity]++;
  return {
    stored: ms.length,
    bySeverity,
    book: active.length - real.length,
    lowConfidence: real.filter(m => m.confidence === 'low').length,
    shownByDefault: applyFilters(ms, DEFAULT_FILTERS, now).length,
  };
}

/** "5... Nc6" (falls back to the UCI string if the move is not legal in the FEN). */
export function moveLabel(fen: string, uci: string): string {
  const san = sanOf(fen, uci);
  return san ? formatLine([san], fen) : uci;
}

const round = (x: number, digits: number): number => Math.round(x * 10 ** digits) / 10 ** digits;

/** The first `limit` rows of the app's default Leaks view (same filters and order). */
export function topLeaks(ms: readonly Mistake[], now: number, limit = 10): LeakRow[] {
  return applyFilters(ms, DEFAULT_FILTERS, now)
    .slice(0, limit)
    .map((m, i) => ({
      rank: i + 1,
      move: moveLabel(m.fen, m.move),
      best: moveLabel(m.fen, m.bestMove),
      color: m.color,
      opening: [m.openingEco, m.openingName].filter(Boolean).join(' '),
      played: m.viewCount,
      reached: m.viewPositionCount,
      loss: round(m.winLoss, 1),
      severity: m.severity,
      confidence: m.confidence,
      impact: round(m.viewImpact, 2),
    }));
}

// ── Markdown ──────────────────────────────────────────────────────────────

const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const row = (cells: readonly unknown[]): string => `| ${cells.map(cell).join(' | ')} |`;
const table = (head: readonly string[], align: readonly ('l' | 'r')[], rows: readonly (readonly unknown[])[]): string[] => [
  row(head),
  `|${align.map(a => (a === 'r' ? ' ---: ' : ' --- ')).join('|')}|`,
  ...rows.map(row),
];
const seconds = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`);
const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

function headerLines(s: LiveSummary): string[] {
  const who = [s.accounts.lichess && `Lichess \`${s.accounts.lichess}\``, s.accounts.chesscom && `Chess.com \`${s.accounts.chesscom}\``]
    .filter(Boolean)
    .join(' · ');
  const mode = s.mode === 'mock' ? ' (MOCK: recorded fixtures, not the real sites)' : '';
  const out = [
    `## Live smoke: ${who}${mode}`,
    '',
    `**${s.result.toUpperCase()}** · ${s.gamesPerAccount} games per account${s.settingsApplied ? '' : ' (setting not applied: first pass only)'} · onboarding: ${s.onboarding} · ${s.generatedAt}${s.commit ? ` · ${s.commit.slice(0, 7)}` : ''}`,
  ];
  if (s.failures.length > 0) out.push('', '**Failures**', ...s.failures.map(f => `- ${f}`));
  if (s.warnings.length > 0) out.push('', '**Warnings**', ...s.warnings.map(w => `- ${w}`));
  return out;
}

function probeLines(probes: readonly ProbeResult[]): string[] {
  if (probes.length === 0) return [];
  return [
    '',
    "### API requests from the app's origin",
    '',
    ...table(
      ['Endpoint', 'HTTP', 'Readable (CORS)', 'Allow-Origin', 'JSON', 'Items', 'ETag readable', 'ms'],
      ['l', 'r', 'l', 'l', 'l', 'r', 'l', 'r'],
      probes.map(p => [p.name, p.status ?? '–', yesNo(p.readable), p.allowOrigin ?? '–', p.json, p.items ?? '–', yesNo(p.etagReadable), p.ms]),
    ),
  ];
}

function dataLines(s: LiveSummary): string[] {
  const out: string[] = [];
  if (s.games) {
    const by = (counts: Record<string, number>): string => Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || '–';
    out.push('', '### Games', '', ...table(['Total', 'By platform', 'By colour', 'By speed'], ['r', 'l', 'l', 'l'], [[s.games.total, by(s.games.byPlatform), by(s.games.byColor), by(s.games.bySpeed)]]));
  }
  if (s.sync.length > 0) {
    out.push('', ...table(['Account', 'Stored', 'Whole history', 'Last error'], ['l', 'r', 'l', 'l'], s.sync.map(r => [`${r.platform} ${r.username}`, r.stored, yesNo(r.reachedStart), r.lastError ?? '–'])));
  }
  if (s.mistakes) {
    const m = s.mistakes;
    out.push(
      '',
      '### Mistakes',
      '',
      ...table(
        ['Blunders', 'Mistakes', 'Inaccuracies', 'Low confidence', 'Dubious book', 'Shown by default', 'Stored'],
        ['r', 'r', 'r', 'r', 'r', 'r', 'r'],
        [[m.bySeverity.blunder, m.bySeverity.mistake, m.bySeverity.inaccuracy, m.lowConfidence, m.book, m.shownByDefault, m.stored]],
      ),
    );
  }
  if (s.analysis) {
    const a = s.analysis;
    out.push(
      '',
      '### Analysis',
      '',
      ...table(
        ['Complete', 'Engine pool', 'Cores', 'Searches', 'Positions cached', 'Engine busy', 'First sync', 'First analysis', 'First results', 'Total'],
        ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
        [
          [
            yesNo(a.complete),
            a.enginePoolSize,
            a.hardwareConcurrency ?? '–',
            a.engineSearches,
            a.evalsCached,
            seconds(a.engineBusyMs),
            seconds(a.syncMs),
            seconds(a.firstAnalysisMs),
            seconds(a.firstResultsMs),
            seconds(a.totalMs),
          ],
        ],
      ),
    );
  }
  return out;
}

function leakLines(leaks: readonly LeakRow[]): string[] {
  if (leaks.length === 0) return ['', '### Top leaks', '', 'None in the default view.'];
  return [
    '',
    `### Top ${leaks.length} leaks (default view, by impact)`,
    '',
    ...table(
      ['#', 'Move', 'Better', 'Opening', 'Played', 'Loss (win %)', 'Severity'],
      ['r', 'l', 'l', 'l', 'r', 'r', 'l'],
      leaks.map(l => [l.rank, l.move, l.best, l.opening || '–', `${l.played} of ${l.reached}`, l.loss.toFixed(1), l.severity]),
    ),
  ];
}

export function toMarkdown(s: LiveSummary): string {
  const errors = [...s.pageErrors.map(e => `- page error: ${e}`), ...s.notices.map(n => `- notice: ${n}`)];
  return [
    ...headerLines(s),
    ...probeLines(s.probes),
    ...dataLines(s),
    ...leakLines(s.topLeaks),
    ...(errors.length > 0 ? ['', '### Errors seen in the page', '', ...errors] : []),
    '',
  ].join('\n');
}
