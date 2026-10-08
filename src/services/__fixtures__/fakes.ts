// Test doubles for the services and store tests (Node only: never import from app code): a scripted
// engine pool, fake Lichess and Chess.com servers, and game builders.
import { posFromFen, posKey, sansToUci, toStandardUci } from '../../core/chess';
import { toStoredGame } from '../../core/games';
import { shortId } from '../../core/hash';
import type { Color, GameResult, LineEval, Mistake, PositionEval, RawGame, StoredGame } from '../../core/types';
import { ENGINE_ID } from '../../engine/engine';
import type { Priority } from '../../engine/pool';
import { chunkBytes, testBody } from '../../sources/__fixtures__/testing';
import type { PoolLike } from '../scheduler';

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

// ── Engine pool ───────────────────────────────────────────────────────────

/** cp (side-to-move POV) for a move at a depth, or a function of the depth. */
export type ScriptedScore = number | ((depth: number) => number);
/** posKey (or FEN) → standard UCI → score. Unlisted moves score DEFAULT_CP. */
export type ScoreTable = Record<string, Record<string, ScriptedScore>>;
export const DEFAULT_CP = 20;

export interface PoolCall {
  fen: string;
  posKey: string;
  moves: string[];
  depth: number;
  priority: Priority;
}

function firstLegalMove(fen: string): string | undefined {
  const pos = posFromFen(fen)!;
  for (const [from, dests] of pos.allDests()) {
    for (const to of dests) return toStandardUci(pos, { from, to });
  }
  return undefined;
}

/**
 * A deterministic engine pool: the best move is the highest-scoring of the listed and requested moves
 * (ties by UCI), every requested move gets its scripted score. `delayMs` holds each evaluation open
 * (aborts reject at once); positions in `failOn` reject with an engine error.
 */
export class FakePool implements PoolLike {
  readonly calls: PoolCall[] = [];
  inFlight = 0;
  maxInFlight = 0;
  delayMs = 0;
  readonly failOn = new Set<string>();
  /** Called with each request as it starts (e.g. to abort a run at a precise point). */
  onCall: ((call: PoolCall) => void) | null = null;

  constructor(
    public size: number,
    private readonly table: ScoreTable = {},
  ) {}

  private scoreOf(key: string, fen: string, move: string, depth: number): number {
    const entry = (this.table[key] ?? this.table[fen])?.[move];
    if (entry === undefined) return DEFAULT_CP;
    return typeof entry === 'function' ? entry(depth) : entry;
  }

  async evaluatePosition(fen: string, moves: readonly string[], opts: { depth: number; signal?: AbortSignal; priority?: Priority }): Promise<PositionEval> {
    if (opts.signal?.aborted) throw abortError();
    const pos = posFromFen(fen);
    if (!pos) throw new Error(`Invalid FEN: ${fen}`);
    const key = posKey(pos);
    const call: PoolCall = { fen, posKey: key, moves: [...moves], depth: opts.depth, priority: opts.priority ?? 'background' };
    this.calls.push(call);
    this.onCall?.(call);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await wait(this.delayMs, opts.signal);
      if (opts.signal?.aborted) throw abortError();
      if (this.failOn.has(key)) throw new Error(`engine crashed on ${key}`);
      const listed = Object.keys(this.table[key] ?? this.table[fen] ?? {});
      const candidates = [...new Set([...listed, ...moves])];
      if (candidates.length === 0) {
        const first = firstLegalMove(fen);
        if (first) candidates.push(first);
      }
      const line = (move: string): LineEval => ({ move, score: { cp: this.scoreOf(key, fen, move, opts.depth) }, pv: [move], depth: opts.depth });
      const lines = candidates.map(line).sort((a, b) => b.score.cp! - a.score.cp! || (a.move < b.move ? -1 : 1));
      const best = lines[0] ?? { move: '', score: { cp: 0 }, pv: [], depth: opts.depth };
      const evaluated: Record<string, LineEval> = { [best.move]: best };
      for (const m of moves) evaluated[m] = line(m);
      return { key: `${ENGINE_ID}|${key}`, posKey: key, fen, engine: ENGINE_ID, depth: opts.depth, best, moves: evaluated, updatedAt: 0 };
    } finally {
      this.inFlight--;
    }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Games ─────────────────────────────────────────────────────────────────

export const LINES: Record<string, string> = {
  italian: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O',
  trap: 'e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5 Nxf7 Qxg2 Rf1 Qxe4+',
  sicilian: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6',
  french: 'e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6',
  london: 'd4 d5 Bf4 Nf6 e3 c5 c3 Nc6 Nd2 e6',
};

/** A RawGame from SAN moves (as a source would produce it). */
export function rawGame(opts: {
  id: string;
  sans: string;
  white: string;
  black: string;
  playedAt: number;
  platform?: RawGame['platform'];
  result?: GameResult;
}): RawGame {
  return {
    platform: opts.platform ?? 'lichess',
    sourceId: opts.id,
    playedAt: opts.playedAt,
    white: opts.white,
    black: opts.black,
    whiteId: opts.white.toLowerCase(),
    blackId: opts.black.toLowerCase(),
    speed: 'blitz',
    rated: true,
    result: opts.result ?? '1-0',
    moves: sansToUci(opts.sans.split(' '), 40),
  };
}

/** A stored game of `profileId` playing `color` with the given SAN line. */
export function storedGame(profileId: string, id: string, sans: string, color: Color, playedAt: number): StoredGame {
  const raw = rawGame({ id, sans, white: color === 'white' ? 'hero' : `opp${id}`, black: color === 'black' ? 'hero' : `opp${id}`, playedAt });
  return toStoredGame(raw, profileId, color);
}

// ── Lichess ───────────────────────────────────────────────────────────────

export interface LichessSpec {
  id: string;
  createdAt: number;
  white: string;
  black: string;
  /** SAN, space separated. */
  moves: string;
  status?: string;
  winner?: Color;
  variant?: string;
}

export function lichessLine(s: LichessSpec): Record<string, unknown> {
  const player = (name: string): Record<string, unknown> => ({ user: { name, id: name.toLowerCase() }, rating: 1500 });
  const line: Record<string, unknown> = {
    id: s.id,
    rated: true,
    variant: s.variant ?? 'standard',
    speed: 'blitz',
    perf: 'blitz',
    createdAt: s.createdAt,
    lastMoveAt: s.createdAt + 300_000,
    status: s.status ?? 'resign',
    players: { white: player(s.white), black: player(s.black) },
    moves: s.moves,
  };
  if (s.winner) line.winner = s.winner;
  return line;
}

/** `count` games of `user`, `spacingMs` apart ending at `newest`, alternating colours and lines; every 7th is aborted. */
export function lichessHistory(user: string, count: number, newest: number, opts: { idPrefix?: string; spacingMs?: number } = {}): Record<string, unknown>[] {
  const { idPrefix = 'g', spacingMs = 86_400_000 } = opts;
  const lines = Object.values(LINES);
  return Array.from({ length: count }, (_, i) => {
    const asWhite = i % 2 === 0;
    return lichessLine({
      id: `${idPrefix}${String(i).padStart(7, '0')}`.slice(-8),
      createdAt: newest - i * spacingMs,
      white: asWhite ? user : `rival${i % 13}`,
      black: asWhite ? `rival${i % 13}` : user,
      moves: lines[i % lines.length]!,
      status: i % 7 === 6 ? 'aborted' : 'resign',
      winner: i % 3 === 0 ? 'black' : 'white',
    });
  });
}

const players = (g: Record<string, unknown>): string[] => {
  const ps = g.players as Record<string, { user?: { id?: string } }>;
  return [ps.white?.user?.id ?? '', ps.black?.user?.id ?? ''];
};

/**
 * Serves GET /api/games/user/{u} (since/until inclusive, sort, max) and /api/user/{u} from memory.
 * `breakAfter` makes the next export stream fail with a network error after that many lines.
 */
export class FakeLichess {
  readonly requests: URL[] = [];
  breakAfter: number | null = null;
  /** Users that answer 404 (user lookup and game export). */
  readonly missing = new Set<string>();
  /** Answers instead of the server when it returns a response (e.g. a 429). */
  override: ((url: URL) => Response | undefined) | null = null;

  constructor(public games: Record<string, unknown>[]) {}

  fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input));
    this.requests.push(url);
    const user = decodeURIComponent(url.pathname.split('/').pop() ?? '').toLowerCase();
    const forced = this.override?.(url);
    if (forced) return forced;
    if (this.missing.has(user)) return new Response('{"error":"Not found"}', { status: 404 });
    if (url.pathname.startsWith('/api/user/')) {
      return Response.json({ id: user, username: user === 'hero' ? 'Hero' : user, count: { all: this.games.length } });
    }
    if (!url.pathname.startsWith('/api/games/user/')) return new Response('', { status: 404 });
    return this.exportResponse(user, url.searchParams);
  };

  private exportResponse(user: string, q: URLSearchParams): Response {
    const since = q.has('since') ? Number(q.get('since')) : -Infinity;
    const until = q.has('until') ? Number(q.get('until')) : Infinity;
    const max = q.has('max') ? Number(q.get('max')) : Infinity;
    const asc = q.get('sort') === 'dateAsc';
    const selected = this.games
      .filter(g => players(g).includes(user))
      .filter(g => (g.createdAt as number) >= since && (g.createdAt as number) <= until)
      .sort((a, b) => (asc ? 1 : -1) * ((a.createdAt as number) - (b.createdAt as number)))
      .slice(0, max);
    const cut = this.breakAfter;
    this.breakAfter = null;
    const shown = cut === null ? selected : selected.slice(0, cut);
    const text = shown.map(g => `${JSON.stringify(g)}\n`).join('');
    const body = testBody(text ? chunkBytes(text, [512]) : [], { end: cut === null ? 'close' : new TypeError('network connection was lost') });
    return new Response(body.stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  }
}

// ── Chess.com ─────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** One archive game (rules 'chess', standard start) with a PGN carrying UTC date and time. */
export function chesscomGame(s: { id: number; white: string; black: string; sans: string; playedAt: number; result?: GameResult }): Record<string, unknown> {
  const d = new Date(s.playedAt);
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const result = s.result ?? '1-0';
  const link = `https://www.chess.com/game/live/${s.id}`;
  const sans = s.sans.split(' ');
  const movetext = sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
  const pgn = [
    `[Event "Live Chess"]`,
    `[Site "Chess.com"]`,
    `[Date "${date}"]`,
    `[White "${s.white}"]`,
    `[Black "${s.black}"]`,
    `[Result "${result}"]`,
    `[UTCDate "${date}"]`,
    `[UTCTime "${time}"]`,
    `[TimeControl "180+2"]`,
    `[Link "${link}"]`,
    '',
    `${movetext} ${result}`,
    '',
  ].join('\n');
  return {
    url: link,
    pgn,
    time_control: '180+2',
    end_time: Math.floor(s.playedAt / 1000) + 600,
    rated: true,
    time_class: 'blitz',
    rules: 'chess',
    white: { username: s.white, rating: 1500, result: result === '1-0' ? 'win' : 'resigned' },
    black: { username: s.black, rating: 1500, result: result === '0-1' ? 'win' : 'resigned' },
  };
}

/** Serves the archive list and monthly archives of one player from memory. */
export class FakeChesscom {
  readonly requests: string[] = [];
  /** 'YYYY/MM' → games. */
  readonly months = new Map<string, Record<string, unknown>[]>();

  constructor(public readonly username: string) {}

  archiveUrl(month: string): string {
    return `https://api.chess.com/pub/player/${this.username.toLowerCase()}/games/${month}`;
  }

  /** Adds `count` games of the player in the month (UTC), every other one as Black. */
  addMonth(year: number, month: number, count: number, firstId: number): void {
    const key = `${year}/${pad(month)}`;
    const lines = Object.values(LINES);
    const games = Array.from({ length: count }, (_, i) =>
      chesscomGame({
        id: firstId + i,
        white: i % 2 === 0 ? this.username : `rival${firstId + i}`,
        black: i % 2 === 0 ? `rival${firstId + i}` : this.username,
        sans: lines[i % lines.length]!,
        playedAt: Date.UTC(year, month - 1, 1 + (i % 27), 10, i % 60),
      }),
    );
    this.months.set(key, [...(this.months.get(key) ?? []), ...games]);
  }

  fetchImpl: typeof fetch = async input => {
    const url = String(input);
    this.requests.push(url);
    const base = `https://api.chess.com/pub/player/${this.username.toLowerCase()}`;
    if (url === base) return Response.json({ username: this.username.toLowerCase(), url: `https://www.chess.com/member/${this.username}`, status: 'basic' });
    if (url === `${base}/games/archives`) {
      const keys = [...this.months.keys()].sort();
      return Response.json({ archives: keys.map(k => this.archiveUrl(k)) });
    }
    const month = url.startsWith(`${base}/games/`) ? url.slice(`${base}/games/`.length) : '';
    const games = this.months.get(month);
    if (!games) return new Response('{"message":"not found"}', { status: 404 });
    return Response.json({ games });
  };
}

/** Routes requests by host to the fake servers. */
export function combinedFetch(fakes: { lichess?: FakeLichess; chesscom?: FakeChesscom; other?: typeof fetch }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = URL.canParse(String(input)) ? new URL(String(input)).host : '';
    if (host === 'lichess.org' && fakes.lichess) return fakes.lichess.fetchImpl(input, init);
    if (host === 'api.chess.com' && fakes.chesscom) return fakes.chesscom.fetchImpl(input, init);
    if (fakes.other) return fakes.other(input, init);
    throw new TypeError(`unexpected request ${String(input)}`);
  }) as typeof fetch;
}

// ── Rows ──────────────────────────────────────────────────────────────────

/** A plausible mistake row for repo/backup/training tests. */
export function testMistake(profileId: string, fen: string, move: string, over: Partial<Mistake> = {}): Mistake {
  const pos = posFromFen(fen)!;
  const key = posKey(pos);
  return {
    id: `${profileId}|${key}|${move}`,
    shortId: shortId(key, move),
    profileId,
    color: pos.turn,
    posKey: key,
    fen,
    ply: 0,
    path: [],
    move,
    kind: 'mistake',
    count: 3,
    positionCount: 4,
    occurrences: [1, 2, 3].map(i => ({ g: `${profileId}|lichess:g${i}`, t: 1_700_000_000_000 + i, s: 'blitz' as const, r: true, o: 'loss' as const, m: move })),
    bestMove: 'd2d4',
    acceptable: ['d2d4'],
    bestLine: ['d2d4'],
    playedLine: [move],
    scoreBest: { cp: 30 },
    scorePlayed: { cp: -200 },
    winLoss: 20,
    severity: 'blunder',
    confidence: 'normal',
    impact: 10,
    lastPlayedAt: 1_700_000_000_003,
    lastOutcome: 'habit',
    fixedStreak: 0,
    evalDepth: 14,
    engine: ENGINE_ID,
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}
