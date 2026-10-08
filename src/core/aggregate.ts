// Two-pass aggregation of the profile's opening moves, counted by distinct games.
// Pass 1 (count) only keeps game counts per (position, move); pass 2 (detail) builds full statistics
// for the candidate positions: those where some move was played in at least `minGames` games.
import { Chess } from 'chessops/chess';
import { fenOf, parseStandardUci, posKey, toStandardUci } from './chess';
import { ANALYSIS_MIN_GAMES, type Color, type Occurrence, type StoredGame } from './types';

export interface PositionStat {
  key: string;
  fen: string;
  ply: number;
  color: Color;
  /** Distinct games that reached this position with the profile to move. */
  games: number;
  /** Distinct-game count per move played here. */
  moveGames: Map<string, number>;
  /** All visits (one per game: the first visit in that game), newest first. */
  occurrences: Occurrence[];
  /** UCI path of the most recent visit, and the position keys along it (path.length === pathKeys.length). */
  path: string[];
  pathKeys: string[];
}

export interface Candidate {
  key: string;
  fen: string;
  ply: number;
  color: Color;
  /** Every move ever played here (count ≥ 1) — all are evaluated. */
  moves: string[];
  /** Moves with ≥ minGames games — the only ones that can become mistakes. */
  recurring: string[];
  weight: number;
  stat: PositionStat;
}

export interface AggregateOptions {
  openingPlies: number;
  minGames?: number;
}

// ── Position signatures ───────────────────────────────────────────────────
// posKey costs ≈3 µs per call (it builds a FEN string). A signature holds the same information as
// numbers: the bitboards, castling rights, turn and the en-passant square only when a legal capture
// exists. For positions reached by legal play from the start, equal signatures ⇔ equal posKeys.
// Pass 1 counts by a 53-bit hash of it (a collision can only merge counts, i.e. add a spurious
// candidate that pass 2 discards; it can never hide a real one). Pass 2 compares signatures exactly
// and computes posKey once per distinct position.

type Signature = number[];

function signatureOf(pos: Chess): Signature {
  const b = pos.board;
  const c = pos.castles.castlingRights;
  // pos.epSquare is set after every double push; toSetup() keeps it only when a capture is legal.
  const ep = pos.epSquare === undefined ? -1 : pos.toSetup().epSquare ?? -1;
  return [
    b.white.lo, b.white.hi, b.pawn.lo, b.pawn.hi, b.knight.lo, b.knight.hi, b.bishop.lo, b.bishop.hi,
    b.rook.lo, b.rook.hi, b.queen.lo, b.queen.hi, b.king.lo, b.king.hi, c.lo, c.hi,
    pos.turn === 'white' ? 1 : 0, ep,
  ];
}

function sameSignature(a: Signature, b: Signature): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const mix = (h: number, x: number, m: number): number => {
  const v = Math.imul(h ^ x, m);
  return v ^ (v >>> 15);
};

/** Two 32-bit lanes folded into a 53-bit integer (exact as a Map key). */
function hashOf(sig: Signature, move = ''): number {
  let a = 0x243f6a88;
  let b = 0x13198a2e;
  for (const x of sig) {
    a = mix(a, x, 0x9e3779b1);
    b = mix(b, x, 0x85ebca77);
  }
  for (let i = 0; i < move.length; i++) {
    a = mix(a, move.charCodeAt(i), 0xc2b2ae3d);
    b = mix(b, move.charCodeAt(i), 0x27d4eb2f);
  }
  return (a >>> 0) * 0x200000 + (b >>> 11);
}

/**
 * Calls `visit` with the position's signature, the position (do not mutate it) and the standard-UCI
 * move for every ply below `maxPlies` where `color` is to move. Stops at the first illegal move.
 */
function forEachTurn(
  ucis: readonly string[],
  color: Color,
  maxPlies: number,
  visit: (sig: Signature, pos: Chess, move: string, ply: number) => void,
): void {
  const pos = Chess.default();
  const limit = Math.min(maxPlies, ucis.length);
  for (let ply = 0; ply < limit; ply++) {
    const move = parseStandardUci(pos, ucis[ply]!);
    if (!move) return;
    if (pos.turn === color) visit(signatureOf(pos), pos, toStandardUci(pos, move), ply);
    pos.play(move);
  }
}

const splitMoves = (moves: string): string[] => (moves ? moves.split(' ') : []);

// ── Pass 2 ────────────────────────────────────────────────────────────────

/** Pass-2 accumulator for one candidate position. */
interface Detail {
  sig: Signature;
  key: string;
  color: Color;
  games: number;
  moveGames: Map<string, number>;
  occurrences: Occurrence[];
  /** The most recent visit: game time, game key (tie-break) and the stored moves leading to it. */
  latestT: number;
  latestG: string;
  rawPath: readonly string[];
}

/** Newest first; equal times by game key, descending (so the "most recent" visit is unambiguous). */
function newestFirst(a: Occurrence, b: Occurrence): number {
  if (a.t !== b.t) return b.t - a.t;
  return a.g < b.g ? 1 : a.g > b.g ? -1 : 0;
}

function isNewer(t: number, g: string, d: Detail): boolean {
  return t > d.latestT || (t === d.latestT && g > d.latestG);
}

/** Moves played here, most games first (ties by UCI for determinism). */
function movesByGames(moveGames: ReadonlyMap<string, number>): string[] {
  return [...moveGames.entries()]
    .sort(([ma, a], [mb, b]) => b - a || (ma < mb ? -1 : ma > mb ? 1 : 0))
    .map(([move]) => move);
}

/** One replay of a game prefix: standard UCI moves, the key before each move, and FENs at requested plies. */
interface Walk {
  path: string[];
  keys: string[];
  fens: Map<number, string>;
}

function walkPath(raw: readonly string[], fenPlies: ReadonlySet<number>): Walk {
  const pos = Chess.default();
  const walk: Walk = { path: [], keys: [], fens: new Map() };
  for (let ply = 0; ; ply++) {
    if (fenPlies.has(ply)) walk.fens.set(ply, fenOf(pos));
    const move = ply < raw.length ? parseStandardUci(pos, raw[ply]!) : undefined;
    // Recorded paths are legal prefixes (forEachTurn stops at the first illegal move).
    if (!move) return walk;
    walk.keys.push(posKey(pos));
    walk.path.push(toStandardUci(pos, move));
    pos.play(move);
  }
}

export class Aggregator {
  private readonly openingPlies: number;
  private readonly minGames: number;
  /** Pass 1: distinct games per (position, move) hash. Released once pass 2 starts. */
  private pairGames = new Map<number, number>();
  /** Hashes of positions with some move in ≥ minGames games. */
  private readonly candidateHashes = new Set<number>();
  private detailStarted = false;
  /** Pass 2: accumulators by position hash (a list, in case two positions share a hash). */
  private readonly details = new Map<number, Detail[]>();
  private result: Candidate[] | null = null;
  private counted = 0;

  constructor(opts: AggregateOptions) {
    this.openingPlies = Math.max(0, opts.openingPlies);
    this.minGames = Math.max(1, opts.minGames ?? ANALYSIS_MIN_GAMES);
  }

  get gamesCounted(): number {
    return this.counted;
  }

  /** Pass 1 — call for every game (in chunks; the caller yields to the event loop between chunks). */
  count(games: readonly StoredGame[]): void {
    if (this.detailStarted) throw new Error('Aggregator: count() called after detail()');
    for (const game of games) {
      this.counted++;
      // A repetition inside one game counts once, with the move of the first visit (as in pass 2, whose
      // occurrences keep only that visit): a different move on a later visit is not counted at all.
      const seen = new Set<number>();
      forEachTurn(splitMoves(game.moves), game.color, this.openingPlies, (sig, _pos, move) => {
        const position = hashOf(sig);
        if (seen.has(position)) return;
        seen.add(position);
        const pair = hashOf(sig, move);
        const n = (this.pairGames.get(pair) ?? 0) + 1;
        this.pairGames.set(pair, n);
        if (n === this.minGames) this.candidateHashes.add(position);
      });
    }
  }

  /** Pass 2 — call again for every game, after all count() calls. */
  detail(games: readonly StoredGame[]): void {
    if (!this.detailStarted) {
      this.detailStarted = true;
      this.pairGames = new Map();
    }
    this.result = null;
    for (const game of games) this.detailGame(game);
  }

  /** Candidate positions, weight (games reaching the position) desc, then key. */
  candidates(): Candidate[] {
    this.result ??= this.buildCandidates();
    return this.result;
  }

  private detailGame(game: StoredGame): void {
    const ucis = splitMoves(game.moves);
    // At most openingPlies / 2 visits per game: linear scans beat sets here.
    const visited: Detail[] = [];
    forEachTurn(ucis, game.color, this.openingPlies, (sig, pos, move, ply) => {
      const h = hashOf(sig);
      if (!this.candidateHashes.has(h)) return;
      const d = this.detailFor(h, sig, pos, game.color);
      // A repetition inside one game counts once: only the first visit is an occurrence, and only its
      // move is counted, so every move count equals the occurrences with that move.
      if (visited.includes(d)) return;
      visited.push(d);
      d.moveGames.set(move, (d.moveGames.get(move) ?? 0) + 1);
      d.games++;
      d.occurrences.push({ g: game.key, t: game.playedAt, s: game.speed, r: game.rated, o: game.outcome, m: move });
      if (isNewer(game.playedAt, game.key, d)) {
        d.latestT = game.playedAt;
        d.latestG = game.key;
        d.rawPath = ucis.slice(0, ply);
      }
    });
  }

  private detailFor(h: number, sig: Signature, pos: Chess, color: Color): Detail {
    const list = this.details.get(h);
    const found = list?.find(d => sameSignature(d.sig, sig));
    if (found) return found;
    const d: Detail = {
      sig,
      key: posKey(pos),
      color,
      games: 0,
      moveGames: new Map(),
      occurrences: [],
      latestT: -Infinity,
      latestG: '',
      rawPath: [],
    };
    if (list) list.push(d);
    else this.details.set(h, [d]);
    return d;
  }

  /** Replays each most-recent game once, for all the candidates whose path it provides. */
  private walkLatestGames(details: readonly Detail[]): Map<string, Walk> {
    const byGame = new Map<string, { raw: readonly string[]; plies: Set<number> }>();
    for (const d of details) {
      const group = byGame.get(d.latestG);
      if (!group) byGame.set(d.latestG, { raw: d.rawPath, plies: new Set([d.rawPath.length]) });
      else {
        group.plies.add(d.rawPath.length);
        if (d.rawPath.length > group.raw.length) group.raw = d.rawPath;
      }
    }
    const walks = new Map<string, Walk>();
    for (const [g, { raw, plies }] of byGame) walks.set(g, walkPath(raw, plies));
    return walks;
  }

  private buildCandidates(): Candidate[] {
    const kept: { d: Detail; moves: string[]; recurring: string[] }[] = [];
    for (const list of this.details.values()) {
      for (const d of list) {
        const moves = movesByGames(d.moveGames);
        const recurring = moves.filter(m => (d.moveGames.get(m) ?? 0) >= this.minGames);
        if (recurring.length > 0) kept.push({ d, moves, recurring });
      }
    }
    const walks = this.walkLatestGames(kept.map(k => k.d));
    const out = kept.map(({ d, moves, recurring }): Candidate => {
      const walk = walks.get(d.latestG)!;
      const ply = d.rawPath.length;
      const stat: PositionStat = {
        key: d.key,
        fen: walk.fens.get(ply)!,
        ply,
        color: d.color,
        games: d.games,
        moveGames: new Map(d.moveGames),
        occurrences: [...d.occurrences].sort(newestFirst),
        path: walk.path.slice(0, ply),
        pathKeys: walk.keys.slice(0, ply),
      };
      return { key: d.key, fen: stat.fen, ply, color: d.color, moves, recurring, weight: d.games, stat };
    });
    return out.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

/** Convenience for tests and small inputs: both passes over the same games. */
export function aggregate(games: readonly StoredGame[], opts: AggregateOptions): Candidate[] {
  const agg = new Aggregator(opts);
  agg.count(games);
  agg.detail(games);
  return agg.candidates();
}
