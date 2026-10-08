// Lichess: the user game export (NDJSON stream) and the user lookup.
// https://lichess.org/api#tag/Games/operation/apiGamesUser
import { isStandardStartFen, sansToUci } from '../core/chess';
import { MAX_STORED_PLIES, type GameResult, type RawGame, type Speed } from '../core/types';
import {
  MIN_RATE_LIMIT_MS,
  SourceError,
  fetchWithRetry,
  lichessCooldownUntil,
  readJson,
  readNdjson,
  setLichessCooldown,
} from './http';

export const LICHESS_ORIGIN = 'https://lichess.org';
/** Every standard speed (the export would otherwise include variants). */
export const LICHESS_PERF_TYPES = 'ultraBullet,bullet,blitz,rapid,classical,correspondence';

export interface LichessPage {
  since?: number;
  until?: number;
  max?: number;
  sort: 'dateAsc' | 'dateDesc';
}

export interface LichessOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Clock for the shared 429 cooldown (default Date.now). */
  now?: () => number;
  /** No-data watchdog for the export stream (default 45 s). */
  idleTimeoutMs?: number;
  /** Called for each export line that is not a game (invalid JSON, or no createdAt). */
  onBadLine?(line: string): void;
}

export interface LichessGameItem {
  /** null when the game is skipped (variant, thematic start, aborted/not started, no legal moves). */
  raw: RawGame | null;
  createdAt: number;
}

/** A closed account answers 403/410 on user endpoints. */
const USER_STATUS_KINDS = { 403: 'closed', 410: 'closed' } as const;

export function lichessGamesUrl(username: string, page: LichessPage): string {
  const params = new URLSearchParams();
  if (page.max !== undefined) params.set('max', String(Math.floor(page.max)));
  if (page.since !== undefined) params.set('since', String(Math.floor(page.since)));
  if (page.until !== undefined) params.set('until', String(Math.floor(page.until)));
  params.set('sort', page.sort);
  params.set('moves', 'true');
  params.set('tags', 'true');
  params.set('clocks', 'false');
  params.set('evals', 'false');
  params.set('opening', 'false');
  params.set('perfType', LICHESS_PERF_TYPES);
  return `${LICHESS_ORIGIN}/api/games/user/${encodeURIComponent(username)}?${params.toString()}`;
}

/** Every Lichess request honours the shared cooldown and starts it on a 429. */
async function lichessFetch(url: string, accept: string, opts: LichessOptions): Promise<Response> {
  const now = opts.now ?? Date.now;
  const until = lichessCooldownUntil();
  if (until > now()) {
    throw new SourceError('rate-limited', 'Lichess asked us to slow down; waiting before the next request', { retryAfterMs: until - now() });
  }
  try {
    return await fetchWithRetry(url, { headers: { Accept: accept }, signal: opts.signal, fetchImpl: opts.fetchImpl, statusKinds: USER_STATUS_KINDS });
  } catch (err) {
    if (err instanceof SourceError && err.kind === 'rate-limited') setLichessCooldown(now() + (err.retryAfterMs ?? MIN_RATE_LIMIT_MS));
    throw err;
  }
}

/**
 * Streams a user's games. Yields every game line received, `raw: null` for skipped games, so the
 * caller can advance its createdAt cursors past them. Rejects with SourceError (rate-limited,
 * not-found, closed, network, http) or an AbortError.
 */
export async function* fetchLichessGames(username: string, page: LichessPage, opts: LichessOptions = {}): AsyncGenerator<LichessGameItem> {
  const res = await lichessFetch(lichessGamesUrl(username, page), 'application/x-ndjson', opts);
  const lines = readNdjson(res, { signal: opts.signal, idleTimeoutMs: opts.idleTimeoutMs, onBadLine: opts.onBadLine });
  for await (const json of lines) {
    const createdAt = isRecord(json) ? finiteNumber(json.createdAt) : undefined;
    if (createdAt === undefined) {
      opts.onBadLine?.(JSON.stringify(json));
      continue;
    }
    yield { raw: lichessJsonToRaw(json), createdAt };
  }
}

// ── Game JSON → RawGame ───────────────────────────────────────────────────

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const finiteNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const nonEmptyString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const SKIPPED_STATUSES = new Set(['aborted', 'noStart', 'created']);
/** Finished without a winner: a draw (outoftime/timeout without a winner = opponent could not win). */
const DRAW_STATUSES = new Set(['draw', 'stalemate', 'outoftime', 'timeout', 'insufficientMaterialClaim']);
const SPEEDS: ReadonlySet<string> = new Set<Speed>(['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence']);

interface Player {
  name: string;
  id?: string;
  rating?: number;
}

/** Registered user, Lichess AI (`aiLevel`, no user) or anonymous. */
function playerOf(p: unknown): Player {
  if (!isRecord(p)) return { name: 'Anonymous' };
  const rating = finiteNumber(p.rating);
  const withRating = (player: Player): Player => (rating !== undefined && rating > 0 ? { ...player, rating } : player);
  const user = isRecord(p.user) ? p.user : undefined;
  const name = nonEmptyString(user?.name);
  if (name !== undefined) return withRating({ name, id: (nonEmptyString(user?.id) ?? name).toLowerCase() });
  const aiLevel = finiteNumber(p.aiLevel);
  if (aiLevel !== undefined) return { name: `Stockfish level ${aiLevel}` };
  return withRating({ name: nonEmptyString(p.name) ?? 'Anonymous' });
}

function resultOf(winner: unknown, status: unknown): GameResult {
  if (winner === 'white') return '1-0';
  if (winner === 'black') return '0-1';
  return typeof status === 'string' && DRAW_STATUSES.has(status) ? '1/2-1/2' : '*';
}

/** One export line → RawGame, or null for variants, thematic starts, aborted/unstarted games and games without moves. */
export function lichessJsonToRaw(json: unknown): RawGame | null {
  if (!isRecord(json)) return null;
  const id = nonEmptyString(json.id);
  if (id === undefined) return null;
  if (json.variant !== undefined && json.variant !== 'standard' && json.variant !== 'fromPosition') return null;
  if (typeof json.status === 'string' && SKIPPED_STATUSES.has(json.status)) return null;
  // Thematic tournaments and "from position" games start from initialFen; the standard start is harmless
  // (as for a PGN with Variant "From Position"). A fromPosition game must name its start.
  const initialFen = json.initialFen ?? (json.variant === 'fromPosition' ? null : undefined);
  if (initialFen !== undefined && !(typeof initialFen === 'string' && isStandardStartFen(initialFen))) return null;
  const sans = typeof json.moves === 'string' ? json.moves.split(' ').filter(s => s !== '') : [];
  const moves = sansToUci(sans, MAX_STORED_PLIES);
  if (moves.length === 0) return null;
  const players = isRecord(json.players) ? json.players : {};
  const white = playerOf(players.white);
  const black = playerOf(players.black);
  const raw: RawGame = {
    platform: 'lichess',
    sourceId: id,
    url: `${LICHESS_ORIGIN}/${id}`,
    playedAt: finiteNumber(json.createdAt) ?? 0,
    white: white.name,
    black: black.name,
    speed: typeof json.speed === 'string' && SPEEDS.has(json.speed) ? (json.speed as Speed) : 'unknown',
    rated: json.rated === true,
    result: resultOf(json.winner, json.status),
    moves,
    plyCount: sans.length,
  };
  if (white.id !== undefined) raw.whiteId = white.id;
  if (black.id !== undefined) raw.blackId = black.id;
  if (white.rating !== undefined) raw.whiteRating = white.rating;
  if (black.rating !== undefined) raw.blackRating = black.rating;
  return raw;
}

// ── User lookup ───────────────────────────────────────────────────────────

export interface LichessUser {
  id: string;
  username: string;
  /** All games (count.all), when Lichess reports it. */
  games?: number;
  /** Closed (`disabled`) or marked for a terms-of-service violation. */
  closed?: boolean;
}

/** GET /api/user/{username}; null when no such account exists. */
export async function lichessUser(username: string, opts: LichessOptions = {}): Promise<LichessUser | null> {
  try {
    const res = await lichessFetch(`${LICHESS_ORIGIN}/api/user/${encodeURIComponent(username)}`, 'application/json', opts);
    return lichessUserFromJson(await readJson(res, { signal: opts.signal }), username);
  } catch (err) {
    if (err instanceof SourceError && err.kind === 'not-found') return null;
    if (err instanceof SourceError && err.kind === 'closed') return { id: username.toLowerCase(), username, closed: true };
    throw err;
  }
}

function lichessUserFromJson(json: unknown, requested: string): LichessUser {
  if (!isRecord(json)) throw new SourceError('unknown', 'Unexpected response from lichess.org');
  const username = nonEmptyString(json.username) ?? requested;
  const user: LichessUser = {
    id: (nonEmptyString(json.id) ?? username).toLowerCase(),
    username,
    closed: json.disabled === true || json.tosViolation === true,
  };
  const games = isRecord(json.count) ? finiteNumber(json.count.all) : undefined;
  if (games !== undefined) user.games = games;
  return user;
}
