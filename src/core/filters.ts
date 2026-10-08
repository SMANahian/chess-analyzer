// Live view filters over stored mistakes: counts, "k of n", impact and scores are recomputed from the
// filtered occurrences, so a filter change never touches the engine or the training data.
import { Chess } from 'chessops/chess';
import { parseStandardUci, posKey, sanOf } from './chess';
import { impactOf } from './classify';
import type { OpeningBook, OpeningName } from './openings';
import {
  DEFAULT_FILTERS,
  type Color,
  type Mistake,
  type Occurrence,
  type Outcome,
  type Severity,
  type StoredGame,
  type ViewFilters,
  type ViewMistake,
} from './types';

export type { ViewMistake } from './types';

const SEVERITY_RANK: Record<Severity, number> = { inaccuracy: 0, mistake: 1, blunder: 2 };
const POINTS: Record<Outcome, number | null> = { win: 1, draw: 0.5, loss: 0, unknown: null };

/** Mean score (win 1, draw ½, loss 0) over known outcomes; null when there are none. */
export function meanScore(outcomes: Iterable<Outcome>): number | null {
  let sum = 0;
  let n = 0;
  for (const o of outcomes) {
    const p = POINTS[o];
    if (p === null) continue;
    sum += p;
    n++;
  }
  return n > 0 ? sum / n : null;
}

function occurrenceFilter(f: ViewFilters): (o: Occurrence) => boolean {
  const speeds = f.speeds.length > 0 ? new Set(f.speeds) : null;
  // NaN (e.g. a cleared date input) means "no date filter", not "nothing matches".
  const since = Number.isNaN(f.since) ? 0 : f.since;
  return o => (!speeds || speeds.has(o.s)) && (!f.ratedOnly || o.r) && (since <= 0 || o.t >= since);
}

/** Occurrences matching the speed, rated and date filters (an empty speed list means all speeds). */
export function filterOccurrences(occ: readonly Occurrence[], f: ViewFilters): Occurrence[] {
  return occ.filter(occurrenceFilter(f));
}

const isListed = (m: Mistake, now: number): boolean =>
  m.status === 'active' && !m.dormant && !(m.snoozedUntil !== undefined && m.snoozedUntil > now);

/** Opening family (name prefix, e.g. "Sicilian Defense") or exact ECO code, case-insensitive. */
function matchesOpening(m: Mistake, opening: string | null): boolean {
  const want = opening?.trim().toLowerCase();
  if (!want) return true;
  return (m.openingName?.toLowerCase().startsWith(want) ?? false) || m.openingEco?.toLowerCase() === want;
}

const bareSan = (san: string): string => san.replace(/[+#!?]+$/, '').toLowerCase();

/** SAN (prefix, e.g. "Bc5", "nxe4", "6...Nxe4") or UCI of the habit or best move, opening name or ECO. */
function matchesQuery(m: Mistake, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (m.openingName?.toLowerCase().includes(q) || m.openingEco?.toLowerCase() === q) return true;
  if (q === m.move || q === m.bestMove) return true;
  const sanQuery = bareSan(q.replace(/^\d+\s*\.+\s*/, ''));
  if (!sanQuery) return false;
  return [m.move, m.bestMove].some(uci => bareSan(sanOf(m.fen, uci)).startsWith(sanQuery));
}

/** Filters that do not depend on occurrences (cheap ones first; the SAN query last). */
function passesStatic(m: Mistake, f: ViewFilters, now: number): boolean {
  return (
    isListed(m, now) &&
    (f.color === 'both' || m.color === f.color) &&
    (f.showBook || m.kind !== 'book') &&
    (f.showLowConfidence || m.confidence !== 'low') &&
    SEVERITY_RANK[m.severity] >= SEVERITY_RANK[f.minSeverity] &&
    matchesOpening(m, f.opening) &&
    matchesQuery(m, f.query)
  );
}

const distinctGames = (occ: readonly Occurrence[]): number => new Set(occ.map(o => o.g)).size;

function viewOf(m: Mistake, keep: (o: Occurrence) => boolean, now: number): ViewMistake {
  const occ = m.occurrences.filter(keep);
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

type Compare = (a: ViewMistake, b: ViewMistake) => number;

const PRIMARY: Record<ViewFilters['sort'], Compare> = {
  impact: (a, b) => b.viewImpact - a.viewImpact,
  frequency: (a, b) => b.viewCount - a.viewCount,
  loss: (a, b) => b.winLoss - a.winLoss,
  recent: (a, b) => b.lastPlayedAt - a.lastPlayedAt,
  // Due order needs review state, which the store owns; it re-sorts this impact order.
  due: (a, b) => b.viewImpact - a.viewImpact,
};

const tieBreak: Compare = (a, b) =>
  b.viewImpact - a.viewImpact ||
  b.viewCount - a.viewCount ||
  b.winLoss - a.winLoss ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The listed mistakes under the view filters, sorted per `f.sort`: active, not dormant, not snoozed,
 * and still played in at least `minGames` of the filtered games.
 */
export function applyFilters(ms: readonly Mistake[], f: ViewFilters, now: number): ViewMistake[] {
  const minGames = Math.max(1, Number.isNaN(f.minGames) ? DEFAULT_FILTERS.minGames : f.minGames);
  const keep = occurrenceFilter(f);
  const out: ViewMistake[] = [];
  for (const m of ms) {
    if (!passesStatic(m, f, now)) continue;
    const view = viewOf(m, keep, now);
    if (view.viewCount >= minGames) out.push(view);
  }
  const primary = PRIMARY[f.sort];
  return out.sort((a, b) => primary(a, b) || tieBreak(a, b));
}

export interface OpeningSummaryRow {
  color: Color;
  eco: string;
  name: string;
  games: number;
  /** Mean score 0..1 over games with a known result (0.5 when none is known). */
  score: number;
}

/** Plies whose book lookups are memoised by move prefix: a repertoire shares them across most games. */
const SHARED_PLIES = 10;

/**
 * The deepest named book position within the first `plies` plies (stops at an illegal move).
 * `byPrefix` caches the lookup after each early ply, keyed by the moves so far (posKey costs ≈3 µs).
 */
function deepestOpening(
  moves: string,
  book: OpeningBook,
  plies: number,
  byPrefix: Map<string, OpeningName | null>,
): OpeningName | undefined {
  const pos = Chess.default();
  const ucis = moves ? moves.split(' ') : [];
  let found: OpeningName | undefined;
  let prefixEnd = 0;
  for (let i = 0; i < Math.min(plies, ucis.length); i++) {
    const move = parseStandardUci(pos, ucis[i]!);
    if (!move) break;
    pos.play(move);
    prefixEnd += (i > 0 ? 1 : 0) + ucis[i]!.length;
    let hit: OpeningName | null | undefined;
    if (i < SHARED_PLIES) {
      const prefix = moves.slice(0, prefixEnd);
      hit = byPrefix.get(prefix);
      if (hit === undefined) byPrefix.set(prefix, (hit = book.lookup(posKey(pos)) ?? null));
    } else {
      hit = book.lookup(posKey(pos));
    }
    if (hit) found = hit;
  }
  return found;
}

/** The most frequent ECO code (ties: alphabetical). */
function commonestEco(ecos: ReadonlyMap<string, number>): string {
  let best = '';
  let bestN = 0;
  for (const [eco, n] of ecos) {
    if (n > bestN || (n === bestN && eco < best)) [best, bestN] = [eco, n];
  }
  return best;
}

/**
 * Repertoire per colour: games grouped by the name of the deepest named book position along their
 * first `openingPlies` plies, with the profile's score. The dataset reuses some names under several
 * ECO codes (e.g. C70 and C78 "Ruy Lopez: Morphy Defense"): those form one row with the commonest
 * code. Games that never reach a named position are left out. Most played first.
 */
export function openingsSummary(games: readonly StoredGame[], book: OpeningBook, openingPlies: number): OpeningSummaryRow[] {
  interface Group {
    color: Color;
    name: string;
    ecos: Map<string, number>;
    outcomes: Outcome[];
  }
  const groups = new Map<string, Group>();
  const byPrefix = new Map<string, OpeningName | null>();
  for (const g of games) {
    const opening = deepestOpening(g.moves, book, openingPlies, byPrefix);
    if (!opening) continue;
    const id = `${g.color}|${opening.name}`;
    const group: Group = groups.get(id) ?? { color: g.color, name: opening.name, ecos: new Map(), outcomes: [] };
    group.ecos.set(opening.eco, (group.ecos.get(opening.eco) ?? 0) + 1);
    group.outcomes.push(g.outcome);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map(({ color, name, ecos, outcomes }) => ({
      color,
      eco: commonestEco(ecos),
      name,
      games: outcomes.length,
      score: meanScore(outcomes) ?? 0.5,
    }))
    .sort(
      (a, b) =>
        b.games - a.games ||
        (a.color === b.color ? 0 : a.color === 'white' ? -1 : 1) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}
