// Chess.com PubAPI: monthly game archives and the player lookup. https://www.chess.com/news/view/published-data-api
// Requests go out one at a time (Chess.com rate-limits parallel requests), with `cache: 'no-cache'` so
// the browser revalidates from its HTTP cache. No headers are set: conditional headers would trigger a
// CORS preflight, and User-Agent is a forbidden header in browsers.
import { isStandardStartFen, sansToUci } from '../core/chess';
import { parsePgnText, pgnDate, resultFromHeader, speedFromTimeControl, type PgnGame } from '../core/pgn';
import { MAX_STORED_PLIES, type GameResult, type RawGame, type Speed } from '../core/types';
import { SourceError, fetchWithRetry, raceAbort, readJson, throwIfAborted, yieldToEventLoop } from './http';

export const CHESSCOM_API = 'https://api.chess.com/pub/player';

export interface ChesscomOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** A closed account answers 403/410 on user endpoints. */
const USER_STATUS_KINDS = { 403: 'closed', 410: 'closed' } as const;

/** Tail of the request queue; never rejects. */
let queueTail: Promise<unknown> = Promise.resolve();

/** Runs `task` after every earlier Chess.com request settled. An abort rejects at once, even while queued. */
function enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = queueTail.then(() => {
    throwIfAborted(signal);
    return task();
  });
  queueTail = run.catch(() => undefined);
  return raceAbort(run, signal);
}

function getJson(url: string, opts: ChesscomOptions, statusKinds?: typeof USER_STATUS_KINDS): Promise<unknown> {
  return enqueue(async () => {
    const res = await fetchWithRetry(url, { cache: 'no-cache', signal: opts.signal, fetchImpl: opts.fetchImpl, statusKinds });
    return readJson(res, { signal: opts.signal });
  }, opts.signal);
}

const playerUrl = (username: string): string => `${CHESSCOM_API}/${encodeURIComponent(username.trim().toLowerCase())}`;

/** Monthly archive URLs, oldest → newest (as Chess.com lists them). */
export async function chesscomArchives(username: string, opts: ChesscomOptions = {}): Promise<string[]> {
  const json = await getJson(`${playerUrl(username)}/games/archives`, opts, USER_STATUS_KINDS);
  if (!isRecord(json) || !Array.isArray(json.archives)) throw unexpected();
  return json.archives.filter((a): a is string => typeof a === 'string');
}

export interface ChesscomArchive {
  /** Standard games (rules 'chess', standard start), in archive order. */
  games: RawGame[];
  /** Games in the archive that are not standard chess (variants, custom starts) or have no moves. */
  skipped: number;
  /** end_time of each game in `games` (ms; 0 if missing), parallel to `games`. */
  endTimes: number[];
}

/** Games converted between two yields to the event loop (a busy month holds thousands). */
const GAMES_PER_SLICE = 200;

export async function fetchChesscomArchive(url: string, opts: ChesscomOptions = {}): Promise<ChesscomArchive> {
  const json = await getJson(url, opts);
  if (!isRecord(json) || !Array.isArray(json.games)) throw unexpected();
  const archive: ChesscomArchive = { games: [], skipped: 0, endTimes: [] };
  for (const [i, game] of json.games.entries()) {
    if (i > 0 && i % GAMES_PER_SLICE === 0) {
      await yieldToEventLoop();
      throwIfAborted(opts.signal);
    }
    const raw = chesscomJsonToRaw(game);
    if (!raw) {
      archive.skipped++;
      continue;
    }
    archive.games.push(raw);
    archive.endTimes.push(isRecord(game) ? secondsToMs(game.end_time) ?? 0 : 0);
  }
  return archive;
}

/** `.../games/2024/05` → { year: 2024, month: 5 }. */
export function archiveMonth(url: string): { year: number; month: number } | null {
  const m = /\/games\/(\d{4})\/(\d{1,2})\/?$/.exec(url.trim());
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year: Number(m[1]), month } : null;
}

// ── Game JSON → RawGame ───────────────────────────────────────────────────

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const secondsToMs = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : undefined);
const unexpected = (): SourceError => new SourceError('unknown', 'Unexpected response from api.chess.com');

// Current links (/game/live/123) and the older /live/game/123 form name the same game (as in core/pgn.ts).
const GAME_URL = /chess\.com\/(?:analysis\/)?(?:game\/(live|daily)|(live|daily)\/game)\/(\d+)/i;
const SPEEDS: Readonly<Record<string, Speed>> = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', daily: 'correspondence' };
/** Player result codes that mean the game was drawn. */
const DRAW_RESULTS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

interface Side {
  name?: string;
  id?: string;
  rating?: number;
  result?: string;
}

function sideOf(p: unknown): Side {
  if (!isRecord(p)) return {};
  const side: Side = {};
  const name = nonEmptyString(p.username);
  if (name !== undefined) {
    side.name = name;
    side.id = name.toLowerCase();
  }
  if (typeof p.rating === 'number' && p.rating > 0) side.rating = p.rating;
  if (typeof p.result === 'string') side.result = p.result;
  return side;
}

function resultOf(pgnResult: string | undefined, white: Side, black: Side): GameResult {
  const fromPgn = resultFromHeader(pgnResult);
  if (fromPgn !== '*') return fromPgn;
  if (white.result === 'win') return '1-0';
  if (black.result === 'win') return '0-1';
  return DRAW_RESULTS.has(white.result ?? '') || DRAW_RESULTS.has(black.result ?? '') ? '1/2-1/2' : '*';
}

/** Start time: PGN UTCDate+UTCTime, else start_time (daily games), else end_time, else the PGN Date. */
function playedAtOf(game: Json, headers: Record<string, string>): number {
  if (headers.UTCDate && headers.UTCTime) {
    const utc = pgnDate(headers);
    if (utc > 0) return utc;
  }
  return secondsToMs(game.start_time) ?? secondsToMs(game.end_time) ?? pgnDate(headers);
}

function sourceOf(game: Json, headers: Record<string, string>): { sourceId: string; url: string } | undefined {
  for (const link of [game.url, headers.Link]) {
    const m = typeof link === 'string' ? GAME_URL.exec(link) : null;
    if (m) {
      const kind = (m[1] ?? m[2])!.toLowerCase();
      return { sourceId: `${kind}/${m[3]}`, url: `https://www.chess.com/game/${kind}/${m[3]}` };
    }
  }
  return undefined;
}

function firstPgnGame(pgn: unknown): PgnGame | undefined {
  if (typeof pgn !== 'string') return undefined;
  for (const game of parsePgnText(pgn, MAX_STORED_PLIES)) return game;
  return undefined;
}

/** One archive game → RawGame, or null unless it is standard chess from the standard start with moves. */
export function chesscomJsonToRaw(game: unknown): RawGame | null {
  if (!isRecord(game) || game.rules !== 'chess') return null;
  const pgn = firstPgnGame(game.pgn);
  if (!pgn) return null;
  const h = pgn.headers;
  // The moves are replayed from the standard start, so neither description of the start may differ from it.
  for (const setup of [nonEmptyString(game.initial_setup), nonEmptyString(h.FEN)]) {
    if (setup !== undefined && !isStandardStartFen(setup)) return null;
  }
  const source = sourceOf(game, h);
  const moves = sansToUci(pgn.sans, MAX_STORED_PLIES);
  if (!source || moves.length === 0) return null;
  const white = sideOf(game.white);
  const black = sideOf(game.black);
  const raw: RawGame = {
    platform: 'chesscom',
    sourceId: source.sourceId,
    url: source.url,
    playedAt: playedAtOf(game, h),
    white: white.name ?? nonEmptyString(h.White) ?? '?',
    black: black.name ?? nonEmptyString(h.Black) ?? '?',
    speed: (typeof game.time_class === 'string' ? SPEEDS[game.time_class] : undefined) ?? speedFromTimeControl(nonEmptyString(game.time_control) ?? h.TimeControl),
    rated: game.rated === true,
    result: resultOf(h.Result, white, black),
    moves,
    plyCount: Math.max(pgn.plyCount, moves.length),
  };
  if (white.id !== undefined) raw.whiteId = white.id;
  if (black.id !== undefined) raw.blackId = black.id;
  if (white.rating !== undefined) raw.whiteRating = white.rating;
  if (black.rating !== undefined) raw.blackRating = black.rating;
  return raw;
}

// ── Player lookup ─────────────────────────────────────────────────────────

export interface ChesscomUser {
  /** Display spelling when known (the API's `username` field is lower-case; the profile URL keeps the case). */
  username: string;
  /** status 'closed', 'closed:fair_play_violations', … */
  closed?: boolean;
}

/** GET /pub/player/{username}; null when no such account exists. */
export async function chesscomUser(username: string, opts: ChesscomOptions = {}): Promise<ChesscomUser | null> {
  try {
    const json = await getJson(playerUrl(username), opts, USER_STATUS_KINDS);
    if (!isRecord(json)) throw unexpected();
    const status = typeof json.status === 'string' ? json.status : '';
    return { username: displayName(json, username), closed: status.startsWith('closed') };
  } catch (err) {
    if (err instanceof SourceError && err.kind === 'not-found') return null;
    if (err instanceof SourceError && err.kind === 'closed') return { username, closed: true };
    throw err;
  }
}

function displayName(json: Json, requested: string): string {
  const apiName = nonEmptyString(json.username) ?? requested;
  const fromUrl = typeof json.url === 'string' ? /\/member\/([^/?#]+)\/?$/.exec(json.url)?.[1] : undefined;
  return fromUrl !== undefined && fromUrl.toLowerCase() === apiName.toLowerCase() ? fromUrl : apiName;
}
