// Turns a candidate position plus its engine evaluation into Mistake records: win-% loss, severity,
// confidence, book awareness, recency-weighted impact, latest outcome and dependencies.
import type { Candidate } from './aggregate';
import { parseStandardUci, posFromFen, posKey, replay } from './chess';
import { shortId } from './hash';
import type { OpeningBook } from './openings';
import {
  ANALYSIS_MIN_LOSS,
  type LastOutcome,
  type LineEval,
  type Mistake,
  type Occurrence,
  type PositionEval,
} from './types';
import { LOW_CONFIDENCE_BELOW, THRESHOLDS, compareScores, severityOf, winLoss } from './winrate';

const DAY_MS = 86_400_000;
const IMPACT_HALF_LIFE_DAYS = 180;
/** ≈ 2× the measured mean eval error: losses below this add nothing to impact. */
const IMPACT_LOSS_OFFSET = 2.5;

/** The evaluation of `uci` in this position (the best line counts too), if it was evaluated. */
export function moveEval(ev: PositionEval, uci: string): LineEval | undefined {
  return ev.moves[uci] ?? (ev.best.move === uci ? ev.best : undefined);
}

/** The highest-scoring evaluated move: a `searchmoves` result occasionally beats the MultiPV line. */
export function bestOf(ev: PositionEval): LineEval {
  let best = ev.best;
  for (const line of Object.values(ev.moves)) {
    if (compareScores(line.score, best.score) > 0) best = line;
  }
  return best;
}

function evaluatedLines(ev: PositionEval): LineEval[] {
  const lines = new Map(Object.entries(ev.moves));
  if (!lines.has(ev.best.move)) lines.set(ev.best.move, ev.best);
  return [...lines.values()];
}

/** Evaluated moves losing less than the inaccuracy threshold, best first; never includes `exclude`. */
export function acceptableMoves(ev: PositionEval, exclude?: string): string[] {
  const best = bestOf(ev);
  return evaluatedLines(ev)
    .filter(line => line.move !== exclude && winLoss(best.score, line.score) < THRESHOLDS.inaccuracy)
    .sort((a, b) => compareScores(b.score, a.score) || (a.move < b.move ? -1 : a.move > b.move ? 1 : 0))
    .map(line => line.move);
}

/**
 * Σ over visits where `move` was played of 0.5^(ageDays / 180) × max(0, loss − 2.5).
 * Visits dated in the future count as new; undated visits (t ≤ 0) count as one half-life old.
 */
export function impactOf(occ: readonly Occurrence[], move: string, loss: number, now: number): number {
  const perGame = Math.max(0, loss - IMPACT_LOSS_OFFSET);
  if (perGame === 0) return 0;
  let weight = 0;
  for (const o of occ) {
    if (o.m !== move) continue;
    const ageDays = o.t > 0 ? Math.max(0, now - o.t) / DAY_MS : IMPACT_HALF_LIFE_DAYS;
    weight += 0.5 ** (ageDays / IMPACT_HALF_LIFE_DAYS);
  }
  return weight * perGame;
}

/**
 * What the profile played on its most recent visit (`occ` is newest first): the habit move, an
 * acceptable move ('fixed'), another evaluated move ('other-bad') or something never evaluated.
 * `evaluated` lists the evaluated moves; without it every non-acceptable move counts as evaluated.
 * fixedStreak = consecutive most-recent visits with an acceptable move.
 */
export function lastOutcomeOf(
  occ: readonly Occurrence[],
  move: string,
  acceptable: readonly string[],
  evaluated?: readonly string[],
): { lastOutcome: LastOutcome; fixedStreak: number } {
  let fixedStreak = 0;
  while (fixedStreak < occ.length && acceptable.includes(occ[fixedStreak]!.m)) fixedStreak++;
  const last = occ[0];
  let lastOutcome: LastOutcome;
  if (!last) lastOutcome = 'unknown';
  else if (last.m === move) lastOutcome = 'habit';
  else if (acceptable.includes(last.m)) lastOutcome = 'fixed';
  else lastOutcome = !evaluated || evaluated.includes(last.m) ? 'other-bad' : 'unknown';
  return { lastOutcome, fixedStreak };
}

/** Whether the position after `uci` is a named book position. */
function leadsToBook(book: OpeningBook | undefined, fen: string, uci: string): boolean {
  const pos = book && posFromFen(fen);
  const move = pos && parseStandardUci(pos, uci);
  if (!book || !pos || !move) return false;
  pos.play(move);
  return book.has(posKey(pos));
}

/** A PV that starts with `move`; engines always return one, but never trust a cache blindly. */
const lineFrom = (line: LineEval): string[] => (line.pv[0] === line.move ? [...line.pv] : [line.move]);

export interface ClassifyOptions {
  profileId: string;
  book?: OpeningBook;
  now: number;
  minLoss?: number;
}

/**
 * One Mistake per recurring move losing ≥ minLoss win-% points (moves missing from the eval are
 * skipped). status 'active', createdAt = updatedAt = now; dependsOn is set by linkDependencies.
 * A minLoss below the inaccuracy threshold (hysteresis for reviewed mistakes) yields 'inaccuracy'
 * with low confidence for those smaller losses.
 */
export function classifyCandidate(c: Candidate, ev: PositionEval, opts: ClassifyOptions): Mistake[] {
  const minLoss = opts.minLoss ?? ANALYSIS_MIN_LOSS;
  const best = bestOf(ev);
  const evaluated = evaluatedLines(ev).map(line => line.move);
  const opening = opts.book?.nameForKeys([...c.stat.pathKeys, c.key]);
  const out: Mistake[] = [];
  for (const move of c.recurring) {
    const line = moveEval(ev, move);
    if (!line) continue;
    const loss = winLoss(best.score, line.score);
    if (loss < minLoss || loss <= 0) continue;
    // Null only below the inaccuracy threshold, i.e. when the caller lowered minLoss to keep a
    // reviewed mistake alive (hysteresis): it keeps the mildest severity.
    const severity = severityOf(loss, best.score, line.score) ?? 'inaccuracy';
    const acceptable = acceptableMoves(ev, move);
    const lastPlayed = c.stat.occurrences.find(o => o.m === move);
    const mistake: Mistake = {
      id: `${opts.profileId}|${c.key}|${move}`,
      shortId: shortId(c.key, move),
      profileId: opts.profileId,
      color: c.color,
      posKey: c.key,
      fen: c.fen,
      ply: c.ply,
      path: [...c.stat.path],
      move,
      kind: loss < THRESHOLDS.mistake && leadsToBook(opts.book, c.fen, move) ? 'book' : 'mistake',
      count: c.stat.moveGames.get(move) ?? 0,
      positionCount: c.stat.games,
      occurrences: c.stat.occurrences,
      bestMove: best.move,
      acceptable,
      bestLine: lineFrom(best),
      playedLine: lineFrom(line),
      scoreBest: best.score,
      scorePlayed: line.score,
      winLoss: loss,
      severity,
      confidence: loss < LOW_CONFIDENCE_BELOW ? 'low' : 'normal',
      impact: impactOf(c.stat.occurrences, move, loss, opts.now),
      lastPlayedAt: lastPlayed?.t ?? 0,
      ...lastOutcomeOf(c.stat.occurrences, move, acceptable, evaluated),
      evalDepth: ev.depth,
      engine: ev.engine,
      status: 'active',
      createdAt: opts.now,
      updatedAt: opts.now,
    };
    if (opening) {
      mistake.openingEco = opening.eco;
      mistake.openingName = opening.name;
    }
    out.push(mistake);
  }
  return out;
}

/**
 * Sets `dependsOn` (mutates): the nearest earlier mistake of the same profile and colour whose
 * (position, move) lies on this mistake's path — this position usually only arises after that error.
 * The colour check matters for a profile with games of both colours: the opponent's move on a White
 * path can coincide with the profile's own habit from its Black games. Positions are compared by key,
 * so a parent reached by transposition counts. A parent must have a lower ply than its child, which
 * also rules out cycles.
 */
export function linkDependencies(ms: Mistake[]): void {
  const byId = new Map(ms.map(m => [m.id, m]));
  for (const m of ms) {
    delete m.dependsOn;
    const steps = replay(m.path, m.path.length);
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]!;
      if (step.turn !== m.color) continue;
      const parent = byId.get(`${m.profileId}|${step.key}|${step.uci}`);
      if (parent && parent !== m && parent.ply < m.ply) {
        m.dependsOn = parent.id;
        break;
      }
    }
  }
}
