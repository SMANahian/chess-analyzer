// Pure view-model helpers for the Leaks, Openings and Scout pages: tabs, plain-language headline,
// "fixed / still playing it" badges, dependency grouping, per-mistake view counts under the filters,
// date-range options, filter summaries and line formatting. No DOM, no clock (callers pass `now`).
import { START_FEN, playUci, replay, sanOf } from '../../core/chess';
import { impactOf } from '../../core/classify';
import { explainMistake } from '../../core/explain';
import { filterOccurrences, meanScore, type OpeningSummaryRow } from '../../core/filters';
import {
  DEFAULT_FILTERS,
  type Color,
  type Mistake,
  type Occurrence,
  type Score,
  type Speed,
  type ViewFilters,
  type ViewMistake,
} from '../../core/types';
import { scoreForColor } from '../../core/winrate';
import { ELLIPSIS, colorName, describePawnDrop, evalWords, moveLabel, shortDate, sideToMove, speedName } from './format';
import type { Cursor } from './LineView';
import { SEVERITY_GLYPH } from './SeverityPill';

const DAY_MS = 86_400_000;

// ── Tabs ────────────────────────────────────────────────────────────────

export type LeakTab = 'active' | 'mastered' | 'ignored' | 'snoozed';
export const LEAK_TABS: readonly LeakTab[] = ['active', 'mastered', 'ignored', 'snoozed'];

export function parseLeakTab(value: string | undefined): LeakTab {
  return LEAK_TABS.includes(value as LeakTab) ? (value as LeakTab) : 'active';
}

const isSnoozed = (m: Mistake, now: number): boolean => m.snoozedUntil !== undefined && m.snoozedUntil > now;

/**
 * The tab a mistake is listed under; null for a dormant active one (no longer produced by the
 * analysis — it is kept only for its training history). Mastered/ignored win over a snooze.
 */
export function tabOf(m: Mistake, now: number): LeakTab | null {
  if (m.status === 'mastered') return 'mastered';
  if (m.status === 'ignored') return 'ignored';
  if (m.dormant) return null;
  return isSnoozed(m, now) ? 'snoozed' : 'active';
}

/** Mistakes of a non-active tab: snoozed by wake-up time, the others most recently changed first. */
export function tabList(ms: readonly Mistake[], tab: Exclude<LeakTab, 'active'>, now: number): Mistake[] {
  const list = ms.filter(m => tabOf(m, now) === tab);
  if (tab === 'snoozed') return list.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  return list.sort((a, b) => b.updatedAt - a.updatedAt || b.impact - a.impact);
}

// ── Moves and copy ──────────────────────────────────────────────────────

/** '6…Nxe4?' — the habit move as written in a sentence, with its severity glyph. */
export function habitLabel(m: Pick<Mistake, 'fen' | 'move' | 'severity'>): string {
  return `${moveLabel(m.fen, m.move)}${SEVERITY_GLYPH[m.severity]}`;
}

export interface Headline {
  habit: string;
  best: string;
  /** Games with the habit move, games reaching the position (under the filters). */
  k: number;
  n: number;
  /** Rounded win-% points lost, as shown ('12'), or '<1'. */
  lossPct: string;
  /** The engine's drop from the best move to the habit: '≈1.1 pawns' (see describePawnDrop). */
  pawns: string;
}

export function headlineOf(m: Pick<Mistake, 'fen' | 'move' | 'bestMove' | 'winLoss' | 'scoreBest' | 'scorePlayed'>, k: number, n: number): Headline {
  const pct = Math.round(m.winLoss);
  return {
    habit: moveLabel(m.fen, m.move),
    best: moveLabel(m.fen, m.bestMove),
    k,
    n,
    lossPct: pct < 1 ? '<1' : String(pct),
    pawns: describePawnDrop(m.scoreBest, m.scorePlayed),
  };
}

/** "You play 6…Nxe4 here 7 of 9 times." (or "every time (3 games)") — the frequency clause. */
export function frequencyText(h: Pick<Headline, 'k' | 'n'>): string {
  if (h.n > 0 && h.k >= h.n) return `every time you get here (${h.n} ${h.n === 1 ? 'game' : 'games'})`;
  return `here ${h.k} of ${h.n} times`;
}

/** The whole headline as one sentence (for screen readers, copy and tests). */
export function headlineText(h: Headline): string {
  return (
    `You play ${h.habit} ${frequencyText(h)}. ` +
    `It costs about ${h.lossPct}% winning chances (${h.pawns}). Better: ${h.best}.`
  );
}

export interface Badge {
  tone: 'good' | 'warn' | 'neutral';
  text: string;
}

/** What happened the last time the position came up in a real game. */
export function outcomeBadge(m: Pick<Mistake, 'lastOutcome' | 'fixedStreak'>): Badge | null {
  switch (m.lastOutcome) {
    case 'fixed':
      return { tone: 'good', text: m.fixedStreak > 1 ? `Fixed in your last ${m.fixedStreak} games` : 'Fixed in your last game' };
    case 'habit':
      return { tone: 'warn', text: 'Still playing it' };
    case 'other-bad':
      return { tone: 'neutral', text: 'A different slip last time' };
    default:
      return null;
  }
}

/** The status shown on a row of the Mastered / Ignored / Snoozed tab. */
export function statusBadge(m: Pick<Mistake, 'snoozedUntil' | 'ignoreReason' | 'updatedAt'>, tab: Exclude<LeakTab, 'active'>): Badge {
  if (tab === 'snoozed') return { tone: 'neutral', text: `Until ${shortDate(m.snoozedUntil ?? 0)}` };
  if (tab === 'ignored') return { tone: 'neutral', text: m.ignoreReason === 'repertoire' ? 'Your repertoire' : 'Ignored' };
  return { tone: 'good', text: `Mastered ${shortDate(m.updatedAt)}` };
}

/** How the game stands from the user's side, as a clause: "you are clearly worse", "the game is about equal". */
export function standingText(userScore: Score): string {
  if (userScore.mate !== undefined) {
    if (userScore.mate > 0) return `you can force mate in ${userScore.mate}`;
    return userScore.mate === 0 ? 'you are checkmated' : `you get mated in ${-userScore.mate}`;
  }
  const words = evalWords(userScore);
  return words === 'about equal' ? 'the game is about equal' : `you are ${words}`;
}

export interface Punishment {
  /** The engine's reply to the habit ('7.Qe2'), when known. */
  reply?: string;
  /** Material the habit loses beyond what the best move loses too (core/explain: 'loses a piece'), or ''. */
  why: string;
  /** Where the game stands after the habit, from the player's side ('you are clearly worse'). */
  standing: string;
  /** Set when the player is still better after the habit: the best move and where it leaves them. */
  instead?: { best: string; standing: string };
}

const userSide = (s: Score, fen: string, user: Color): Score => scoreForColor(s, fen.split(' ')[1] === 'b' ? 'black' : 'white', user);
const isGoodFor = (s: Score): boolean => (s.mate !== undefined ? s.mate > 0 : (s.cp ?? 0) > 30);

/**
 * Why the habit fails: the refutation, its material consequence judged against the best line (material
 * the best move gives up as well is not blamed on the habit) and the resulting standing.
 */
export function punishmentOf(m: Pick<Mistake, 'fen' | 'move' | 'bestMove' | 'playedLine' | 'bestLine' | 'scorePlayed' | 'scoreBest' | 'color'>): Punishment {
  const line = m.playedLine[0] === m.move ? m.playedLine : [m.move];
  const after = playUci(m.fen, m.move);
  const reply = after && line[1] ? moveLabel(after, line[1]) : '';
  const played = userSide(m.scorePlayed, m.fen, m.color);
  return {
    ...(reply && reply !== line[1] ? { reply } : {}),
    why: explainMistake(m),
    standing: standingText(played),
    ...(isGoodFor(played) ? { instead: { best: moveLabel(m.fen, m.bestMove), standing: standingText(userSide(m.scoreBest, m.fen, m.color)) } } : {}),
  };
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One sentence: "6…Nxe4 loses a piece after 7.Qe2." / "After 7.Qe2, you are clearly worse." /
 * "After 9.Nxe4, you are still better, but with 8…Rb7 you would be winning."
 */
export function punishmentText(habit: string, p: Punishment): string {
  if (p.why) return p.reply ? `${habit} ${p.why} after ${p.reply}.` : `${habit} ${p.why}.`;
  let clause = p.standing;
  if (p.instead) {
    const still = p.standing.replace(/^you are /, 'you are still ');
    const would = p.instead.standing.replace(/^you are /, 'you would be ').replace(/^the game is /, 'the game would be ');
    clause =
      p.instead.standing === p.standing ? `${still}, but less clearly than with ${p.instead.best}` : `${still}, but with ${p.instead.best} ${would}`;
  }
  return p.reply ? `After ${p.reply}, ${clause}.` : `${capitalize(clause)}.`;
}

/** The last move of a path from the start as written in a sentence ('6.Bc5'); undefined for an empty or illegal path. */
export function lastMoveLabel(path: readonly string[]): string | undefined {
  const steps = replay(path, path.length, true);
  const last = steps[steps.length - 1];
  return last && steps.length === path.length ? moveLabel(last.fen, last.uci) : undefined;
}

/**
 * The leak board's accessible name for the position it shows (the cursor of useLineCursor): the move
 * that led to it, who is to move, and — only at the leak position, where they are drawn — the arrows.
 */
export function leakBoardLabel(m: Pick<Mistake, 'fen' | 'path' | 'move' | 'bestMove' | 'bestLine' | 'playedLine'>, cursor: Cursor): string {
  const toMove = (fen: string): string => `${colorName(sideToMove(fen))} to move.`;
  if (cursor?.line === 'path') {
    if (cursor.index < 0) return 'Starting position. White to move.';
    const steps = replay(m.path, cursor.index + 1, true);
    const last = steps[cursor.index];
    const after = last ? playUci(last.fen, last.uci) : undefined;
    if (last && after) return `Position after ${moveLabel(last.fen, last.uci)}, on the way to the leak. ${toMove(after)}`;
  } else if (cursor) {
    const habit = moveLabel(m.fen, m.move);
    const frames = lineMoves(m.fen, (cursor.line === 'best' ? m.bestLine : m.playedLine).slice(0, cursor.index + 1));
    const frame = frames[cursor.index];
    if (frame) {
      const before = cursor.index === 0 ? m.fen : frames[cursor.index - 1]!.fenAfter;
      const where = cursor.line === 'best' ? 'in the best line' : `in the line after your ${habit}`;
      return `Position after ${moveLabel(before, frame.uci)} ${where}. ${toMove(frame.fenAfter)}`;
    }
  }
  return (
    `Position after ${lastMoveLabel(m.path) ?? 'the start'}. ${toMove(m.fen)} ` +
    `Orange arrow: your usual ${moveLabel(m.fen, m.move)}. Blue arrow: the best move, ${moveLabel(m.fen, m.bestMove)}.`
  );
}

/** "Moves so far: 1.e4 c5 2.Nf3" — the moves leading to a training position, as text for screen readers. */
export function movesSoFar(path: readonly string[]): string {
  const text = lineText(START_FEN, path);
  return text ? `Moves so far: ${text}.` : 'The starting position.';
}

/** "Black · Italian Game: Two Knights Defense" style subtitle parts. */
export function openingLine(m: Pick<Mistake, 'openingName' | 'openingEco'>): string {
  if (!m.openingName) return 'Unnamed line';
  return m.openingEco ? `${m.openingName} (${m.openingEco})` : m.openingName;
}

export const asColor = (c: Color): string => `as ${colorName(c)}`;

// ── Dependency grouping ─────────────────────────────────────────────────

export interface ListEntry<M extends Mistake> {
  m: M;
  /** 0 for a top-level row, 1+ when listed under its parent. */
  depth: number;
  /** The earlier mistake this position follows from (shown as "after 6.Bc5?!"), listed or not. */
  parent?: Mistake;
}

/**
 * Keeps the list order but puts each mistake right after its parent (dependsOn) when the parent is in
 * the list too, indented one level deeper. A parent that is filtered out still names the row.
 */
export function groupByParent<M extends Mistake>(list: readonly M[], all: readonly Mistake[]): ListEntry<M>[] {
  const listed = new Map(list.map(m => [m.id, m]));
  const known = new Map(all.map(m => [m.id, m]));
  const children = new Map<string, M[]>();
  const roots: M[] = [];
  for (const m of list) {
    const parentId = m.dependsOn;
    if (parentId !== undefined && parentId !== m.id && listed.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(m);
      children.set(parentId, siblings);
    } else {
      roots.push(m);
    }
  }
  const out: ListEntry<M>[] = [];
  const seen = new Set<string>();
  const visit = (m: M, depth: number): void => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const parent = m.dependsOn === undefined ? undefined : known.get(m.dependsOn) ?? listed.get(m.dependsOn);
    out.push(parent ? { m, depth, parent } : { m, depth });
    for (const child of children.get(m.id) ?? []) visit(child, depth + 1);
  };
  for (const m of roots) visit(m, 0);
  // A dependency cycle (never produced by the analysis) would leave rows unvisited: list them flat.
  for (const m of list) visit(m, 0);
  return out;
}

// ── Counts under the filters (any status) ───────────────────────────────

const distinctGames = (occ: readonly Occurrence[]): number => new Set(occ.map(o => o.g)).size;

/** The ViewMistake numbers for any mistake (mastered, ignored and snoozed ones too). */
export function viewOfMistake(m: Mistake, f: ViewFilters, now: number): ViewMistake {
  const occ = filterOccurrences(m.occurrences, f);
  const habit = occ.filter(o => o.m === m.move);
  return {
    ...m,
    viewCount: distinctGames(habit),
    viewPositionCount: distinctGames(occ),
    viewImpact: impactOf(occ, m.move, m.winLoss, now),
    habitScore: meanScore(habit.map(o => o.o)),
    positionScore: meanScore(occ.map(o => o.o)),
  };
}

export interface ScorePart {
  /** Mean score 0..1 over games with a known result; null when there are none. */
  score: number | null;
  games: number;
}

/** Your results in the filtered games: when you played the habit move vs any other move. */
export function scoreSplit(m: Mistake, f: ViewFilters): { habit: ScorePart; other: ScorePart } {
  const occ = filterOccurrences(m.occurrences, f);
  const part = (list: readonly Occurrence[]): ScorePart => ({ score: meanScore(list.map(o => o.o)), games: distinctGames(list) });
  return { habit: part(occ.filter(o => o.m === m.move)), other: part(occ.filter(o => o.m !== m.move)) };
}

// ── Date range ──────────────────────────────────────────────────────────

export const RANGE_MONTHS = [0, 3, 6, 12] as const;
export type RangeMonths = (typeof RANGE_MONTHS)[number];

/** The `since` timestamp for "last N months" (calendar months back from `now`); 0 for all time. */
export function sinceForMonths(months: RangeMonths, now: number): number {
  if (months === 0) return 0;
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

/** The range option closest to a stored `since` (stored values drift as time passes). */
export function monthsOfSince(since: number, now: number): RangeMonths {
  if (!(since > 0)) return 0;
  let best: RangeMonths = 3;
  for (const months of RANGE_MONTHS) {
    if (months === 0) continue;
    if (Math.abs(sinceForMonths(months, now) - since) < Math.abs(sinceForMonths(best, now) - since)) best = months;
  }
  return best;
}

/** True when a stored `since` is more than a day off its option's rolling window. */
export function sinceNeedsReanchor(since: number, now: number): boolean {
  const months = monthsOfSince(since, now);
  return months !== 0 && Math.abs(sinceForMonths(months, now) - since) > DAY_MS;
}

// ── Filter summary ──────────────────────────────────────────────────────

const ALL_SPEEDS = DEFAULT_FILTERS.speeds;

/** Speeds the filter excludes among those that occur in the data (an empty list means all). */
function speedsShown(f: ViewFilters, present: readonly Speed[]): Speed[] {
  if (f.speeds.length === 0) return [...present];
  return present.filter(s => f.speeds.includes(s));
}

/** Active (non-default) filters as short labels; search and sort are not counted. */
export function filterChips(f: ViewFilters, present: readonly Speed[], now: number): string[] {
  const chips: string[] = [];
  if (f.color !== 'both') chips.push(`${colorName(f.color)} only`);
  const shown = speedsShown(f, present);
  if (shown.length < present.length) chips.push(shown.length === 0 ? 'No time controls' : shown.map(speedName).join(', '));
  if (f.ratedOnly) chips.push('Rated only');
  const months = monthsOfSince(f.since, now);
  if (months > 0) chips.push(`Last ${months} months`);
  if (f.minGames !== DEFAULT_FILTERS.minGames) chips.push(`In ≥ ${f.minGames} games`);
  if (f.minSeverity === 'mistake') chips.push('Mistakes and blunders');
  if (f.minSeverity === 'blunder') chips.push('Blunders only');
  if (f.showLowConfidence) chips.push('Incl. borderline');
  if (f.showBook) chips.push('Incl. book choices');
  if (f.opening) chips.push(f.opening);
  return chips;
}

/** The filters with everything but search and sort back at the defaults. */
export function clearedFilters(f: ViewFilters): ViewFilters {
  return { ...DEFAULT_FILTERS, query: f.query, sort: f.sort, speeds: [...ALL_SPEEDS] };
}

/** Toggles one speed; never leaves the list empty (removing the last shown speed shows all again). */
export function toggleSpeed(current: readonly Speed[], speed: Speed, present: readonly Speed[]): Speed[] {
  const base = current.length === 0 ? [...ALL_SPEEDS] : [...current];
  const next = base.includes(speed) ? base.filter(s => s !== speed) : [...base, speed];
  return present.some(s => next.includes(s)) ? next : [...ALL_SPEEDS];
}

// ── Openings ────────────────────────────────────────────────────────────

/** "Sicilian Defense: Najdorf Variation" → "Sicilian Defense". */
export function openingFamily(name: string): string {
  const colon = name.indexOf(':');
  return (colon >= 0 ? name.slice(0, colon) : name).trim();
}

/** Opening families among the mistakes, most leaks first (for the opening filter). */
export function openingOptions(ms: readonly Mistake[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of ms) {
    if (!m.openingName) continue;
    const family = openingFamily(m.openingName);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Prefix match on the opening name, as core/filters does for the opening filter. */
export function inOpening(m: Pick<Mistake, 'openingName'>, name: string): boolean {
  return m.openingName?.toLowerCase().startsWith(name.trim().toLowerCase()) ?? false;
}

// ── Repertoire ──────────────────────────────────────────────────────────

export interface Family {
  name: string;
  /** "C50" or "C50–C54". */
  eco: string;
  games: number;
  score: number;
  variations: OpeningSummaryRow[];
}

/** Rows grouped by opening family ("Italian Game: …" → "Italian Game"), most played first. */
export function groupFamilies(rows: readonly OpeningSummaryRow[]): Family[] {
  const byName = new Map<string, OpeningSummaryRow[]>();
  for (const r of rows) {
    const family = openingFamily(r.name);
    byName.set(family, [...(byName.get(family) ?? []), r]);
  }
  return [...byName]
    .map(([name, variations]) => {
      const games = variations.reduce((n, v) => n + v.games, 0);
      const ecos = variations.map(v => v.eco).sort();
      const first = ecos[0] ?? '';
      const last = ecos[ecos.length - 1] ?? '';
      return {
        name,
        eco: first === last ? first : `${first}–${last}`,
        games,
        score: games > 0 ? variations.reduce((s, v) => s + v.score * v.games, 0) / games : 0.5,
        variations: [...variations].sort((a, b) => b.games - a.games),
      };
    })
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
}

// ── Links ───────────────────────────────────────────────────────────────

/** Lichess analysis board at `fen` (spaces as underscores), from `color`'s side. */
export function lichessAnalysisUrl(fen: string, color?: Color): string {
  const url = `https://lichess.org/analysis/${fen.trim().replace(/\s+/g, '_')}`;
  return color === 'black' ? `${url}?color=black` : url;
}

// ── Lines ───────────────────────────────────────────────────────────────

export interface LineMove {
  index: number;
  uci: string;
  san: string;
  /** Move-number prefix as printed before this move ('6.', '6…') or '' inside a pair. */
  prefix: string;
  /** Position after the move. */
  fenAfter: string;
}

/** A line from `startFen` with SAN and move numbers ("6… Nxe4 7. Qe2 d5"); stops at the first illegal move. */
export function lineMoves(startFen: string, ucis: readonly string[]): LineMove[] {
  const out: LineMove[] = [];
  let fen = startFen;
  for (const [index, uci] of ucis.entries()) {
    const san = sanOf(fen, uci);
    const after = san ? playUci(fen, uci) : undefined;
    if (!san || !after) break;
    const [, turn, , , , full] = fen.split(' ');
    const moveNo = Number(full) || 1;
    const prefix = turn === 'b' ? (index === 0 ? `${moveNo}${ELLIPSIS}` : '') : `${moveNo}.`;
    out.push({ index, uci, san, prefix, fenAfter: after });
    fen = after;
  }
  return out;
}

/** The whole line as text: "6…Nxe4 7.Qe2 d5". */
export function lineText(startFen: string, ucis: readonly string[], maxPlies = Infinity): string {
  return lineMoves(startFen, ucis.slice(0, maxPlies))
    .map(m => `${m.prefix}${m.san}`)
    .join(' ');
}
