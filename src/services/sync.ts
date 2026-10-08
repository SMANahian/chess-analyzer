// Game sync: Lichess (NDJSON export, covered-interval cursors), Chess.com (monthly archives) and PGN
// files. Games are stored in chunks; a sync cursor is only ever written in the same transaction as
// the games it describes, so an interrupted run resumes without gaps or duplicates.
import { attribute, toStoredGame } from '../core/games';
import type {
  Account,
  Color,
  Profile,
  RawGame,
  SourceErrorKind,
  StoredGame,
  SyncProgress,
  SyncState,
} from '../core/types';
import { addGames, getProfile, getSettings, getSyncStates, putSyncState, updateProfile } from '../db/repo';
import { archiveMonth, chesscomArchives, fetchChesscomArchive, type ChesscomArchive } from '../sources/chesscom';
import { MIN_RATE_LIMIT_MS, SourceError, isAbortError, throwIfAborted } from '../sources/http';
import { fetchLichessGames, type LichessPage } from '../sources/lichess';
import { readPgnFile } from '../sources/pgnFile';

/** The first sync of a profile fetches this many games per account, analyses them, then backfills. */
export const FIRST_RUN_GAMES = 300;
/** Games per stored chunk (one transaction with its cursor). */
export const CHUNK_SIZE = 100;
/** The Lichess forward pass re-reads this much before the newest stored game (duplicates are skipped). */
export const LICHESS_OVERLAP_MS = 3 * 86_400_000;
/** Anonymous Lichess exports stream about this many games per second (for the ETA). */
const LICHESS_GAMES_PER_SECOND = 20;
/** Safety bound on export requests per pass. */
const MAX_PAGES = 50;
/** Progress is reported at least every this many received games. */
const PROGRESS_EVERY = 10;

export interface SyncOptions {
  signal?: AbortSignal;
  onProgress?(p: SyncProgress): void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Cap this run per account (first-run fast pass = 300); defaults to settings.gamesPerAccount. */
  limit?: number;
  /** Games kept per account (the backfill stops there); defaults to settings.gamesPerAccount. Scouted players use fewer. */
  perAccount?: number;
}

export interface SyncError {
  account: Account;
  kind: SourceErrorKind;
  message: string;
}

export interface SyncResult {
  added: number;
  /** Games of the queried accounts that could not be attributed to one side. */
  unmatched: number;
  errors: SyncError[];
}

export function syncStateKey(profileId: string, account: Account): string {
  return `${profileId}|${account.platform}|${account.username.trim().toLowerCase()}`;
}

/** Shared state of one sync run. */
interface Run {
  profile: Profile;
  opts: SyncOptions;
  now: () => number;
  /** settings.gamesPerAccount: backfill stops once an account has this many games stored. */
  perAccount: number;
  /** Games per account this run may fetch (Lichess) or add (Chess.com). */
  limit: number;
  added: number;
  unmatched: number;
  progress: SyncProgress;
}

/** Per-account state within a run. */
interface AccountRun {
  account: Account;
  state: SyncState;
  /** Games received from this account in this run. */
  fetched: number;
  /** New games stored for this account in this run. */
  added: number;
}

function emit(run: Run, patch: Partial<SyncProgress>): void {
  run.progress = { ...run.progress, ...patch };
  run.opts.onProgress?.(run.progress);
}

/** The game as stored for the profile, or null (counted as unmatched) when no single side is the account. */
function attributed(run: Run, raw: RawGame, account?: Account, asColor?: Color): StoredGame | null {
  const color = asColor ?? attribute(raw, run.profile, account).color;
  if (color === null) {
    run.unmatched++;
    return null;
  }
  return toStoredGame(raw, run.profile.id, color);
}

/** Widens the covered interval by [lo, hi] (no-op when lo > hi, i.e. nothing was received). */
function cursorAfter(state: SyncState, lo: number, hi: number): SyncState {
  if (lo > hi) return state;
  return {
    ...state,
    newestCreatedAt: Math.max(state.newestCreatedAt ?? hi, hi),
    oldestCreatedAt: Math.min(state.oldestCreatedAt ?? lo, lo),
  };
}

/** Stores a chunk and the account's next SyncState in one transaction. */
async function storeChunk(run: Run, acc: AccountRun, games: StoredGame[], next: SyncState): Promise<void> {
  const before = acc.state.stored;
  let written = next;
  const added = await addGames(games, n => (written = { ...next, stored: before + n }));
  acc.state = written;
  acc.added += added;
  run.added += added;
  emit(run, { added: run.added, fetched: acc.fetched });
}

// ── Lichess ───────────────────────────────────────────────────────────────

interface PageResult {
  received: number;
  /** Received games created after the newest game stored before this page. */
  newLines: number;
  maxCreatedAt: number;
}

function etaMessage(platform: string, pageFetched: number, expected: number | undefined): string {
  if (expected === undefined || expected <= pageFetched) return `${platform}: downloading games`;
  const seconds = Math.ceil((expected - pageFetched) / LICHESS_GAMES_PER_SECOND);
  return `${platform}: downloading games (about ${seconds} s left)`;
}

/**
 * Streams one export request into the store in chunks. The cursor covers every received line,
 * skipped games included. On an error the lines received so far (a contiguous run) are still stored.
 */
async function lichessPage(run: Run, acc: AccountRun, page: LichessPage): Promise<PageResult> {
  const prevNewest = acc.state.newestCreatedAt ?? -Infinity;
  const expected = page.sort === 'dateDesc' ? page.max : undefined;
  const result: PageResult = { received: 0, newLines: 0, maxCreatedAt: -Infinity };
  let games: StoredGame[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  const flush = async (): Promise<void> => {
    if (lo > hi) return;
    const chunk = games;
    const next = cursorAfter(acc.state, lo, hi);
    games = [];
    lo = Infinity;
    hi = -Infinity;
    await storeChunk(run, acc, chunk, next);
  };
  emit(run, { account: acc.account, fetched: acc.fetched, expected, message: etaMessage('Lichess', 0, expected) });
  const stream = fetchLichessGames(acc.account.username, page, { signal: run.opts.signal, fetchImpl: run.opts.fetchImpl, now: run.now });
  try {
    for await (const { raw, createdAt } of stream) {
      result.received++;
      acc.fetched++;
      if (createdAt > prevNewest) result.newLines++;
      result.maxCreatedAt = Math.max(result.maxCreatedAt, createdAt);
      lo = Math.min(lo, createdAt);
      hi = Math.max(hi, createdAt);
      const game = raw && attributed(run, raw, acc.account);
      if (game) games.push(game);
      if (result.received % CHUNK_SIZE === 0) await flush();
      if (result.received % PROGRESS_EVERY === 0) {
        emit(run, { fetched: acc.fetched, message: etaMessage('Lichess', result.received, expected) });
      }
    }
  } catch (err) {
    await flush().catch(() => undefined);
    throw err;
  }
  await flush();
  return result;
}

async function markReachedStart(acc: AccountRun): Promise<void> {
  acc.state = { ...acc.state, reachedStart: true };
  await putSyncState(acc.state);
}

/**
 * First sync: newest games first (`dateDesc`, max = limit). Later syncs: a forward pass from the newest
 * stored game minus an overlap (`dateAsc`, so a capped or interrupted pass never leaves a gap), then a
 * backfill below the oldest stored game until gamesPerAccount is reached or the history ends.
 */
async function syncLichess(run: Run, acc: AccountRun): Promise<void> {
  let used = 0;
  const newest = acc.state.newestCreatedAt;
  if (newest === undefined) {
    // Nothing is covered yet, so a "history starts here" from an account that had no games then is stale.
    const { reachedStart: _stale, ...uncovered } = acc.state;
    acc.state = uncovered;
    const max = Math.min(run.limit, run.perAccount);
    const r = await lichessPage(run, acc, { sort: 'dateDesc', max });
    used += r.received;
    if (r.received > 0 && r.received < max) await markReachedStart(acc);
  } else {
    let since = newest - LICHESS_OVERLAP_MS;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await lichessPage(run, acc, { sort: 'dateAsc', since, max: run.limit });
      used += r.newLines;
      // A full page of overlap duplicates must not stall the pass: continue after its last game.
      if (r.received < run.limit || used >= run.limit || r.maxCreatedAt <= since) break;
      since = r.maxCreatedAt;
    }
  }
  for (let i = 0; i < MAX_PAGES; i++) {
    const oldest = acc.state.oldestCreatedAt;
    if (acc.state.reachedStart || oldest === undefined || acc.state.stored >= run.perAccount || used >= run.limit) break;
    const max = Math.min(run.perAccount - acc.state.stored, run.limit - used);
    const r = await lichessPage(run, acc, { sort: 'dateDesc', until: oldest - 1, max });
    used += r.received;
    if (r.received < max) await markReachedStart(acc);
    if (r.received === 0) break;
  }
}

// ── Chess.com ─────────────────────────────────────────────────────────────

/** Months as a single number (year × 12 + month − 1). */
const monthIndex = (year: number, month: number): number => year * 12 + month - 1;

function previousUtcMonthIndex(now: number): number {
  const d = new Date(now);
  return monthIndex(d.getUTCFullYear(), d.getUTCMonth() + 1) - 1;
}

/** Newest first, so a run that hits its limit keeps the newest games of the month. */
function newestFirst(archive: ChesscomArchive): RawGame[] {
  return [...archive.games].sort((a, b) => b.playedAt - a.playedAt || (a.sourceId < b.sourceId ? 1 : a.sourceId > b.sourceId ? -1 : 0));
}

/**
 * Stores one monthly archive in chunks; the last chunk also marks the month done when `markDone`.
 * Returns false when the run limit stopped it before the whole month was consumed.
 */
async function storeArchive(run: Run, acc: AccountRun, url: string, archive: ChesscomArchive, markDone: boolean): Promise<boolean> {
  const raws = newestFirst(archive);
  emit(run, { account: acc.account, fetched: acc.fetched, expected: raws.length, message: `Chess.com: ${url.split('/games/')[1] ?? url}` });
  const doneWith = (s: SyncState): SyncState => ({ ...s, doneArchives: [...new Set([...(s.doneArchives ?? []), url])] });
  if (raws.length === 0) {
    if (markDone) {
      acc.state = doneWith(acc.state);
      await putSyncState(acc.state);
    }
    return true;
  }
  for (let start = 0; start < raws.length; start += CHUNK_SIZE) {
    const chunk = raws.slice(start, start + CHUNK_SIZE);
    const last = start + CHUNK_SIZE >= raws.length;
    acc.fetched += chunk.length;
    const games = chunk.flatMap(raw => attributed(run, raw, acc.account) ?? []);
    const times = chunk.map(r => r.playedAt).filter(t => t > 0);
    let next = cursorAfter(acc.state, Math.min(...times), Math.max(...times));
    if (last && markDone) next = doneWith(next);
    await storeChunk(run, acc, games, next);
    if (!last && acc.added >= run.limit) return false;
  }
  return true;
}

/**
 * Monthly archives newest first, one request at a time. Months already done are skipped; months
 * strictly before the previous UTC month are marked done once fully consumed. Stops when this run
 * added `limit` games, or (for older months) when the account has gamesPerAccount games stored.
 */
async function syncChesscom(run: Run, acc: AccountRun): Promise<void> {
  const signal = run.opts.signal;
  const archives = await chesscomArchives(acc.account.username, { signal, fetchImpl: run.opts.fetchImpl });
  const done = new Set(acc.state.doneArchives ?? []);
  const cutoff = previousUtcMonthIndex(run.now());
  let walkedAll = true;
  for (const url of [...archives].reverse()) {
    if (done.has(url)) continue;
    const month = archiveMonth(url);
    const recent = month === null || monthIndex(month.year, month.month) >= cutoff;
    if (acc.added >= run.limit || (!recent && acc.state.stored >= run.perAccount)) {
      walkedAll = false;
      break;
    }
    const archive = await fetchChesscomArchive(url, { signal, fetchImpl: run.opts.fetchImpl });
    if (!(await storeArchive(run, acc, url, archive, !recent))) {
      walkedAll = false;
      break;
    }
  }
  if (walkedAll && !acc.state.reachedStart) await markReachedStart(acc);
}

// ── Runs ──────────────────────────────────────────────────────────────────

function errorOf(account: Account, err: unknown): SyncError {
  if (err instanceof SourceError) return { account, kind: err.kind, message: err.message };
  return { account, kind: 'unknown', message: err instanceof Error ? err.message : String(err) };
}

/** One account; errors other than an abort are returned (and saved as lastError) instead of thrown. */
async function syncAccount(run: Run, acc: AccountRun): Promise<SyncError | null> {
  try {
    if (acc.account.platform === 'lichess') await syncLichess(run, acc);
    else await syncChesscom(run, acc);
    acc.state = { ...acc.state, lastSyncAt: run.now() };
    delete acc.state.lastError;
    await putSyncState(acc.state);
    return null;
  } catch (err) {
    if (isAbortError(err) || run.opts.signal?.aborted) throw err;
    const error = errorOf(acc.account, err);
    acc.state = { ...acc.state, lastError: error.message };
    await putSyncState(acc.state).catch(() => undefined);
    if (error.kind === 'rate-limited') {
      const wait = err instanceof SourceError ? err.retryAfterMs ?? MIN_RATE_LIMIT_MS : MIN_RATE_LIMIT_MS;
      emit(run, { phase: 'cooldown', cooldownUntil: run.now() + wait, error: error.message, errorKind: error.kind });
    }
    return error;
  }
}

function newState(profileId: string, account: Account): SyncState {
  return { key: syncStateKey(profileId, account), profileId, platform: account.platform, username: account.username, stored: 0 };
}

/**
 * Syncs every account of the profile, one after the other. Account errors (not found, closed, rate
 * limited, network) are collected and the run continues with the next account; an abort rejects with
 * an AbortError after storing what was already received.
 */
export async function syncProfile(profileId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error(`No profile ${profileId}`);
  const settings = await getSettings();
  const now = opts.now ?? Date.now;
  const run: Run = {
    profile,
    opts,
    now,
    perAccount: Math.max(1, opts.perAccount ?? settings.gamesPerAccount),
    limit: Math.max(1, opts.limit ?? opts.perAccount ?? settings.gamesPerAccount),
    added: 0,
    unmatched: 0,
    progress: { profileId, phase: 'running', fetched: 0, added: 0 },
  };
  const states = new Map((await getSyncStates(profileId)).map(s => [s.key, s]));
  const errors: SyncError[] = [];
  emit(run, {});
  try {
    for (const account of profile.accounts) {
      throwIfAborted(opts.signal);
      const key = syncStateKey(profileId, account);
      const acc: AccountRun = { account, state: states.get(key) ?? newState(profileId, account), fetched: 0, added: 0 };
      emit(run, { phase: 'running', account, fetched: 0, expected: undefined, message: undefined });
      const error = await syncAccount(run, acc);
      if (error) errors.push(error);
    }
  } catch (err) {
    emit(run, { phase: 'cancelled', message: undefined });
    throw err;
  }
  const anyOk = errors.length < profile.accounts.length;
  if (anyOk) await updateProfile(profileId, { lastSyncAt: now() });
  const first = errors[0];
  emit(run, {
    phase: anyOk || !first ? 'done' : first.kind === 'rate-limited' ? 'cooldown' : 'error',
    expected: undefined,
    message: undefined,
    ...(first ? { error: first.message, errorKind: first.kind } : {}),
  });
  return { added: run.added, unmatched: run.unmatched, errors };
}

// ── PGN files ─────────────────────────────────────────────────────────────

export interface PgnImportResult {
  added: number;
  /** Games that are not standard chess from the standard start, or have no legal moves. */
  skipped: number;
  /** Games where neither (or both) players match the profile's aliases or usernames. */
  unmatched: number;
  /** Games already stored (same game id, or the same game from another source). */
  duplicates: number;
}

/**
 * Streams a PGN file into the profile in chunks. Games are attributed by the profile's aliases and
 * usernames, or all to `asColor` ("all games in this file are mine as White").
 */
export async function importPgnIntoProfile(
  profileId: string,
  input: Blob | string,
  opts: { signal?: AbortSignal; onProgress?(p: SyncProgress): void; asColor?: Color } = {},
): Promise<PgnImportResult> {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error(`No profile ${profileId}`);
  const run: Run = {
    profile,
    opts,
    now: Date.now,
    perAccount: Infinity,
    limit: Infinity,
    added: 0,
    unmatched: 0,
    progress: { profileId, phase: 'running', fetched: 0, added: 0, message: 'Reading the PGN file' },
  };
  let read = 0;
  let duplicates = 0;
  let games: StoredGame[] = [];
  const flush = async (): Promise<void> => {
    const chunk = games;
    games = [];
    const added = await addGames(chunk);
    duplicates += chunk.length - added;
    run.added += added;
    emit(run, { fetched: read, added: run.added });
  };
  const onBytes = (done: number, total: number): void => {
    emit(run, { fetched: read, message: `Reading the PGN file (${total > 0 ? Math.floor((done / total) * 100) : 100}%)` });
  };
  emit(run, {});
  const reader = readPgnFile(input, { signal: opts.signal, onProgress: onBytes });
  try {
    for (let item = await reader.next(); ; item = await reader.next()) {
      if (item.done) {
        await flush();
        emit(run, { phase: 'done', message: undefined });
        return { added: run.added, skipped: item.value.skipped, unmatched: run.unmatched, duplicates };
      }
      read++;
      const game = attributed(run, item.value, undefined, opts.asColor);
      if (game) games.push(game);
      if (games.length >= CHUNK_SIZE) await flush();
    }
  } catch (err) {
    // The games read so far are complete games: keep them.
    await flush().catch(() => undefined);
    emit(run, { phase: isAbortError(err) ? 'cancelled' : 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
