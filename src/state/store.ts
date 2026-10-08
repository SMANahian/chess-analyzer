// App state (signals) + actions. The UI imports only this module and pure helpers from core/.
// Long jobs (sync, analysis, PGN import) run one at a time per tab through a queue, and one tab at a
// time across tabs (Web Lock); progress and results flow into the signals as they happen.
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { version as APP_VERSION } from '../../package.json';
import { normalizeUci } from '../core/chess';
import { applyFilters } from '../core/filters';
import type { OpeningBook } from '../core/openings';
import { mistakesToPgn } from '../core/pgnExport';
import {
  DEFAULT_FILTERS,
  DEFAULT_SETTINGS,
  type Account,
  type AnalysisProgress,
  type Color,
  type Grade,
  type Mistake,
  type MistakeStatus,
  type MoveVerdict,
  type Profile,
  type ReviewState,
  type SessionCard,
  type Settings,
  type SourceErrorKind,
  type StoredGame,
  type SyncProgress,
  type ViewFilters,
  type ViewMistake,
} from '../core/types';
import { exportBackup, importBackup, clearAllData } from '../db/backup';
import * as repo from '../db/repo';
import { getDb } from '../db/schema';
import { ENGINE_ID, createStockfishWorker } from '../engine/engine';
import { EnginePool, defaultPoolSize } from '../engine/pool';
import { chesscomUser } from '../sources/chesscom';
import { SourceError, abortError, isAbortError } from '../sources/http';
import { lichessUser } from '../sources/lichess';
import { scanPgnFileNames } from '../sources/pgnFile';
import { analyzeProfile, presetDepths } from '../services/analysis';
import { broadcastJob, holdWakeLock, isJobLockHeld, onJobBroadcast, requestPersistentStorage, withJobLock } from '../services/jobs';
import type { PoolLike } from '../services/scheduler';
import { FIRST_RUN_GAMES, importPgnIntoProfile, syncProfile, syncStateKey, type SyncError } from '../services/sync';
import { buildSession, evaluateTrainingMove, judgeMove, judgeRefutationMove, recordGrade } from '../services/training';

export type Notice = {
  kind: 'info' | 'error' | 'success';
  text: string;
  action?: { label: string; run(): void };
};

/** Scouted players: games fetched per account (their recent repertoire is what matters). */
export const SCOUT_GAMES = 500;
/** Auto-sync on open when the last sync is older than this. */
export const AUTO_SYNC_AFTER_MS = 6 * 3_600_000;
const FILTERS_KEY = 'ca:filters';
const CLOCK_TICK_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_LOGGED_ERRORS = 10;

// ── Signals ───────────────────────────────────────────────────────────────

export const ready: Signal<boolean> = signal(false);
export const settings: Signal<Settings> = signal(DEFAULT_SETTINGS);
export const filters: Signal<ViewFilters> = signal(DEFAULT_FILTERS);
export const profiles: Signal<Profile[]> = signal([]);
export const selfProfile: ReadonlySignal<Profile | null> = computed(
  () => profiles.value.find(p => p.kind === 'self') ?? null,
);
export const scoutProfiles: ReadonlySignal<Profile[]> = computed(() => profiles.value.filter(p => p.kind === 'opponent'));
/** Self profile's mistakes, all statuses. */
export const mistakes: Signal<Mistake[]> = signal([]);
export const reviews: Signal<Map<string, ReviewState>> = signal(new Map());
/** Self profile's games (for stats and the Openings page). */
export const games: Signal<StoredGame[]> = signal([]);
export const syncProgress: Signal<SyncProgress | null> = signal(null);
export const analysisProgress: Signal<AnalysisProgress | null> = signal(null);
export const busy: ReadonlySignal<boolean> = computed(
  () => syncProgress.value?.phase === 'running' || ['preparing', 'evaluating'].includes(analysisProgress.value?.phase ?? ''),
);
/** Another tab holds the job lock. */
export const otherTabBusy: Signal<boolean> = signal(false);
export const notice: Signal<Notice | null> = signal(null);
/** Non-null when a new app version is waiting; call it to reload into the update. */
export const updateAvailable: Signal<null | (() => void)> = signal(null);

/** Current time for time-dependent views (snoozes, due cards); ticks every minute. */
const clock = signal(Date.now());
/** New cards started today (for the daily new-card limit). */
const newToday = signal(0);

/** Self profile's active mistakes under the current view filters, sorted. */
export const visibleMistakes: ReadonlySignal<ViewMistake[]> = computed(() => {
  const list = applyFilters(mistakes.value, filters.value, clock.value);
  if (filters.value.sort !== 'due') return list;
  // Reviewed cards by due time, then never-reviewed ones (applyFilters already ordered those by impact).
  const due = (m: ViewMistake): number => reviews.value.get(m.id)?.due ?? Infinity;
  return [...list].sort((a, b) => due(a) - due(b));
});

/** Cards due now (self profile, default filters): due reviews plus today's remaining new cards. */
export const dueCount: ReadonlySignal<number> = computed(
  () =>
    buildSession(mistakes.value, [...reviews.value.values()], clock.value, {
      size: Number.MAX_SAFE_INTEGER,
      newToday: newToday.value,
      newPerDay: settings.value.newPerDay,
    }).length,
);

// ── Dependencies (injectable for tests) ───────────────────────────────────

export interface StoreTestDeps {
  fetchImpl?: typeof fetch;
  pool?: PoolLike;
  book?: OpeningBook;
  now?: () => number;
}

let deps: StoreTestDeps = {};
let enginePool: EnginePool | null = null;

const now = (): number => deps.now?.() ?? Date.now();

/** settings.engineWorkers (never more than the cores), or the automatic size. */
function poolSize(): number {
  const wanted = settings.value.engineWorkers;
  if (!(wanted > 0)) return defaultPoolSize();
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  return Math.min(Math.floor(wanted), cores);
}

/** The engine pool: a lazy singleton, re-created (when idle) after the worker count setting changed. */
function getPool(): PoolLike {
  if (deps.pool) return deps.pool;
  if (enginePool && enginePool.size !== poolSize() && enginePool.busyCount === 0) {
    enginePool.terminate();
    enginePool = null;
  }
  enginePool ??= new EnginePool({ size: poolSize(), createWorker: () => createStockfishWorker() });
  return enginePool;
}

// ── Errors and notices ────────────────────────────────────────────────────

/**
 * An account that does not exist, is closed, or whose site cannot be reached at all; `kind` and
 * `account` are read by the UI's error copy.
 */
export class AccountError extends Error {
  override readonly name = 'AccountError';
  constructor(
    readonly kind: Extract<SourceErrorKind, 'not-found' | 'closed' | 'network'>,
    readonly account: Account,
    message: string,
  ) {
    super(message);
  }
}

const recentErrors: { at: number; context: string; message: string }[] = [];

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function logError(context: string, err: unknown): void {
  recentErrors.push({ at: now(), context, message: messageOf(err) });
  if (recentErrors.length > MAX_LOGGED_ERRORS) recentErrors.shift();
}

/** For fire-and-forget jobs: errors become a notice (cancellations stay silent). */
function reportError(context: string): (err: unknown) => void {
  return err => {
    if (isAbortError(err)) return;
    logError(context, err);
    notice.value = { kind: 'error', text: messageOf(err) };
  };
}

const platformName = (p: Account['platform']): string => (p === 'lichess' ? 'Lichess' : 'Chess.com');

function syncErrorText(e: SyncError): string {
  const site = platformName(e.account.platform);
  const who = `“${e.account.username}”`;
  switch (e.kind) {
    case 'not-found':
      return `No ${site} account ${who}.`;
    case 'closed':
      return `The ${site} account ${who} is closed.`;
    case 'rate-limited':
      return `${site} asked us to slow down; the rest of ${who}'s games will follow on the next sync.`;
    case 'network':
      return `Couldn't reach ${site} for ${who}. Check your connection (or an ad-blocker), or upload a PGN file instead.`;
    default:
      return `${site} ${who}: ${e.message}`;
  }
}

// ── Loading ───────────────────────────────────────────────────────────────

function tick(): void {
  clock.value = now();
}

/** Local calendar day, 'YYYY-MM-DD'. */
function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * New cards started today (local day) = own mistakes whose first attempt was today. Derived from the
 * attempts, so it survives a backup restore; prep drills on scouted players do not count.
 */
async function loadNewToday(): Promise<void> {
  const self = selfProfile.value;
  if (!self) {
    newToday.value = 0;
    return;
  }
  const firstAttempt = new Map<string, number>();
  for (const a of await repo.getAttempts(self.id)) if (!firstAttempt.has(a.mistakeId)) firstAttempt.set(a.mistakeId, a.at);
  const today = localDay(now());
  newToday.value = [...firstAttempt.values()].filter(at => localDay(at) === today).length;
}

async function reloadSelfData(): Promise<void> {
  const self = selfProfile.value;
  if (!self) {
    mistakes.value = [];
    reviews.value = new Map();
    games.value = [];
    return;
  }
  const [ms, rs, gs] = await Promise.all([repo.getMistakes(self.id), repo.getReviews(self.id), repo.getGames(self.id)]);
  mistakes.value = ms;
  reviews.value = new Map(rs.map(r => [r.mistakeId, r]));
  games.value = gs;
}

async function reloadAll(): Promise<void> {
  settings.value = await repo.getSettings();
  profiles.value = await repo.listProfiles();
  await Promise.all([reloadSelfData(), loadNewToday()]);
}

async function reloadProfiles(): Promise<void> {
  profiles.value = await repo.listProfiles();
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Persisted filters merged over the defaults; fields of the wrong type are ignored. */
function loadFilters(): ViewFilters {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage()?.getItem(FILTERS_KEY) ?? 'null');
  } catch {
    return DEFAULT_FILTERS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_FILTERS;
  const out: Record<string, unknown> = { ...DEFAULT_FILTERS };
  for (const [key, def] of Object.entries(DEFAULT_FILTERS)) {
    const value = (parsed as Record<string, unknown>)[key];
    const ok = Array.isArray(def) ? Array.isArray(value) : key === 'opening' ? value === null || typeof value === 'string' : typeof value === typeof def;
    if (ok) out[key] = value;
  }
  return out as unknown as ViewFilters;
}

function saveFilters(f: ViewFilters): void {
  try {
    storage()?.setItem(FILTERS_KEY, JSON.stringify(f));
  } catch {
    // Storage full or blocked: filters still work for this session.
  }
}

// ── Job queue ─────────────────────────────────────────────────────────────

interface QueuedJob {
  key: string;
  profileId: string;
  controller: AbortController;
  promise: Promise<void>;
}

let jobTail: Promise<void> = Promise.resolve();
let importCounter = 0;
const jobs = new Map<string, QueuedJob>();
let currentJob: QueuedJob | null = null;
/** An analysis that failed while the page was hidden (a frozen tab can lose its workers) resumes on return. */
let resumeOnVisible: string | null = null;

/**
 * Runs `work` after the jobs queued before it, holding the cross-tab job lock (another tab running a
 * job → `otherTabBusy` and nothing runs: a sync or analysis is then left to that tab, while a `mustRun`
 * job such as a file import rejects, so the user's request is never dropped silently), a wake lock and
 * a persisted job record (an interrupted analysis resumes on the next start). A job requested again
 * while queued or running shares that run.
 */
function enqueue(kind: string, profileId: string, work: (signal: AbortSignal) => Promise<void>, opts: { mustRun?: boolean } = {}): Promise<void> {
  const key = `${kind}:${profileId}`;
  const existing = jobs.get(key);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const job: QueuedJob = { key, profileId, controller, promise: Promise.resolve() };
  job.promise = jobTail.then(async () => {
    try {
      if (controller.signal.aborted) throw abortError();
      currentJob = job;
      const ran = await withJobLock(async () => {
        await runLocked(profileId, () => work(controller.signal));
        return true;
      });
      if (ran === null) {
        otherTabBusy.value = true;
        if (opts.mustRun) throw new Error('Another tab is downloading or analysing right now; try again when it has finished.');
        notice.value = { kind: 'info', text: 'Another tab is already analysing; this page will update when it finishes.' };
      }
    } finally {
      if (currentJob === job) currentJob = null;
      if (jobs.get(key) === job) jobs.delete(key);
    }
  });
  jobs.set(key, job);
  jobTail = job.promise.catch(() => undefined);
  return job.promise;
}

async function runLocked(profileId: string, work: () => Promise<void>): Promise<void> {
  otherTabBusy.value = false;
  broadcastJob({ type: 'job-started', profileId });
  const releaseWakeLock = await holdWakeLock();
  await repo.setMeta('job', { profileId, startedAt: now() });
  try {
    await work();
  } finally {
    releaseWakeLock();
    await repo.deleteMeta('job').catch(() => undefined);
    broadcastJob({ type: 'job-done', profileId });
  }
}

export function cancelJobs(): void {
  for (const job of jobs.values()) job.controller.abort();
  jobs.clear();
  currentJob?.controller.abort();
  resumeOnVisible = null;
}

/**
 * Cancels the profile's jobs and waits until the running one has settled, so none of its last writes
 * (a stored chunk, buffered mistakes) can land after the caller deletes the profile's rows. Queued jobs
 * only need the abort: they stop before writing anything.
 */
async function stopJobsOf(profileId: string): Promise<void> {
  for (const [key, job] of jobs) {
    if (job.profileId !== profileId) continue;
    job.controller.abort();
    // Forgotten, so the same job requested again (e.g. a refresh for new accounts) really runs.
    jobs.delete(key);
  }
  const running = currentJob?.profileId === profileId ? currentJob : null;
  running?.controller.abort();
  if (resumeOnVisible === profileId) resumeOnVisible = null;
  await running?.promise.catch(() => undefined);
}

// ── Jobs ──────────────────────────────────────────────────────────────────

/** Settings that change analysis results; a re-analysis without new games is needed when they change. */
function analysisKey(): string {
  const { triage, confirm } = presetDepths(settings.value);
  return `${ENGINE_ID}|${settings.value.openingPlies}|${triage}|${confirm}`;
}

/**
 * Meta row saying "the last analysis covered every stored game with these settings and completed".
 * It is removed whenever games change or an analysis starts, so an analysis that was cancelled, cut
 * short by closing the tab, or left positions unevaluated runs again at the next refresh.
 */
const analysisKeyMeta = (profileId: string): string => `analysisKey:${profileId}`;

function markAnalysisStale(profileId: string): Promise<void> {
  return repo.deleteMeta(analysisKeyMeta(profileId));
}

/** Syncs the profile's accounts; returns the games added and whether every account failed. */
async function runSync(profileId: string, limit: number, signal: AbortSignal, perAccount?: number): Promise<{ added: number; allFailed: boolean }> {
  let result: Awaited<ReturnType<typeof syncProfile>>;
  try {
    result = await syncProfile(profileId, {
      signal,
      limit,
      ...(perAccount === undefined ? {} : { perAccount }),
      fetchImpl: deps.fetchImpl,
      now,
      onProgress: p => (syncProgress.value = p),
    });
  } catch (err) {
    // An aborted sync may still have stored games before it stopped.
    await markAnalysisStale(profileId).catch(() => undefined);
    throw err;
  }
  if (result.added > 0) await markAnalysisStale(profileId);
  if (result.errors.length > 0) {
    for (const e of result.errors) logError(`sync ${e.account.platform}`, new Error(e.message));
    notice.value = { kind: 'error', text: result.errors.map(syncErrorText).join(' ') };
  }
  if (profileId === selfProfile.value?.id && result.added > 0) games.value = await repo.getGames(profileId);
  await reloadProfiles();
  const accounts = (await repo.getProfile(profileId))?.accounts.length ?? 0;
  return { added: result.added, allFailed: accounts > 0 && result.errors.length >= accounts };
}

function mergeIntoMistakes(ms: readonly Mistake[]): void {
  const byId = new Map(mistakes.value.map(m => [m.id, m]));
  for (const m of ms) byId.set(m.id, m);
  mistakes.value = [...byId.values()];
}

async function runAnalysis(profileId: string, signal: AbortSignal): Promise<void> {
  const isSelf = (): boolean => profileId === selfProfile.value?.id;
  await markAnalysisStale(profileId);
  let complete = false;
  try {
    ({ complete } = await analyzeProfile(profileId, {
      pool: getPool(),
      book: deps.book,
      signal,
      now,
      onProgress: p => (analysisProgress.value = p),
      onMistakes: ms => {
        if (isSelf()) mergeIntoMistakes(ms);
      },
      onPositionError: (fen, err) => logError(`analysis ${fen}`, err),
    }));
  } catch (err) {
    if (!isAbortError(err) && typeof document !== 'undefined' && document.hidden) resumeOnVisible = profileId;
    throw err;
  } finally {
    if (isSelf()) mistakes.value = await repo.getMistakes(profileId);
  }
  if (complete) await repo.setMeta(analysisKeyMeta(profileId), analysisKey());
  else {
    // The run finished without some positions; say so (the progress card only shows failed runs).
    const detail = analysisProgress.value?.profileId === profileId ? analysisProgress.value.error : undefined;
    notice.value = { kind: 'error', text: `${detail ?? 'Some positions could not be evaluated.'} The next refresh tries them again.` };
  }
  await reloadProfiles();
  // Asked once, after the first analysis (some browsers show a prompt); Settings shows the result.
  if (settings.value.storagePersisted === undefined) {
    settings.value = await repo.saveSettings({ storagePersisted: await requestPersistentStorage() });
  }
}

async function needsAnalysis(profileId: string, added: number): Promise<boolean> {
  if (added > 0) return true;
  // Nothing to analyse (e.g. the first sync failed): leave the profile "never analysed", so the next
  // refresh is still a quick first pass and the UI says there are no games rather than no mistakes.
  if ((await repo.countGames(profileId)) === 0) return false;
  const profile = await repo.getProfile(profileId);
  if (!profile?.lastAnalysisAt) return true;
  return (await repo.getMeta<string>(analysisKeyMeta(profileId))) !== analysisKey();
}

/** Sync then analyse. A profile's first run fetches the newest 300 games, analyses, backfills, analyses again. */
async function refreshJob(profileId: string, signal: AbortSignal): Promise<void> {
  const profile = await repo.getProfile(profileId);
  if (!profile) return;
  const perAccount = settings.value.gamesPerAccount;
  if (profile.kind === 'opponent') {
    const scoutGames = Math.min(perAccount, SCOUT_GAMES);
    const { added } = await runSync(profileId, scoutGames, signal, scoutGames);
    if (await needsAnalysis(profileId, added)) await runAnalysis(profileId, signal);
    return;
  }
  // Never analysed (rather than "no games"): a first sync interrupted after some games keeps the quick
  // first pass when it resumes.
  const firstRun = profile.lastAnalysisAt === undefined;
  const firstLimit = firstRun ? Math.min(FIRST_RUN_GAMES, perAccount) : perAccount;
  const first = await runSync(profileId, firstLimit, signal);
  if (await needsAnalysis(profileId, first.added)) await runAnalysis(profileId, signal);
  // The backfill would only repeat a failure that hit every account (already reported).
  if (firstRun && perAccount > FIRST_RUN_GAMES && !first.allFailed) {
    const { added: more } = await runSync(profileId, perAccount, signal);
    if (await needsAnalysis(profileId, more)) await runAnalysis(profileId, signal);
  }
}

async function targetProfile(profileId?: string): Promise<Profile | null> {
  if (profileId === undefined) return selfProfile.value;
  return profiles.value.find(p => p.id === profileId) ?? (await repo.getProfile(profileId)) ?? null;
}

function enqueueRefresh(profileId: string): Promise<void> {
  return enqueue('refresh', profileId, signal => refreshJob(profileId, signal));
}

/** Starts a refresh in the background; failures become a notice. */
function startRefresh(profileId: string, context: string): void {
  enqueueRefresh(profileId).catch(reportError(context));
}

/** Sync then analyse (self profile by default). First run: newest 300 → analyse → backfill → analyse. */
export async function refresh(profileId?: string): Promise<void> {
  const profile = await targetProfile(profileId);
  if (!profile) return;
  await enqueueRefresh(profile.id);
}

export async function analyze(profileId?: string): Promise<void> {
  const profile = await targetProfile(profileId);
  if (!profile) return;
  await enqueue('analyze', profile.id, signal => runAnalysis(profile.id, signal));
}

// ── Accounts and profiles ─────────────────────────────────────────────────

const sameAccount = (a: Account, b: Account): boolean =>
  a.platform === b.platform && a.username.trim().toLowerCase() === b.username.trim().toLowerCase();

function cleanAccounts(accounts: readonly Account[]): Account[] {
  const out: Account[] = [];
  for (const a of accounts) {
    const username = a.username.trim();
    if (username && !out.some(b => sameAccount(a, b))) out.push({ platform: a.platform, username });
  }
  return out;
}

/**
 * Checks that the account exists and is open, and returns it with the site's spelling. A site that
 * cannot be reached at all (offline, CORS, an ad-blocker: fetch itself fails, after its retries) is an
 * AccountError of kind 'network', since its games could not be downloaded either. Other failures (rate
 * limit, server error, unexpected answer) accept the account as typed, with a notice.
 */
async function validateAccount(a: Account): Promise<Account> {
  const site = platformName(a.platform);
  try {
    const user =
      a.platform === 'lichess'
        ? await lichessUser(a.username, { fetchImpl: deps.fetchImpl })
        : await chesscomUser(a.username, { fetchImpl: deps.fetchImpl });
    if (!user) throw new AccountError('not-found', a, `No ${site} account “${a.username}”. Check the spelling (it's the name in your profile URL).`);
    if (user.closed) throw new AccountError('closed', a, `The ${site} account “${a.username}” is closed, so its games can't be downloaded.`);
    return { platform: a.platform, username: user.username };
  } catch (err) {
    if (err instanceof AccountError || isAbortError(err)) throw err;
    if (err instanceof SourceError && err.kind === 'network') {
      logError(`validate ${a.platform}`, err);
      throw new AccountError('network', a, `Couldn't reach ${site} to look up “${a.username}” (${err.message}).`);
    }
    logError(`validate ${a.platform}`, err);
    notice.value = { kind: 'info', text: `Couldn't check the ${site} account “${a.username}” right now (${messageOf(err)}); continuing anyway.` };
    return a;
  }
}

async function validateAccounts(accounts: readonly Account[]): Promise<Account[]> {
  const cleaned = cleanAccounts(accounts);
  if (cleaned.length === 0) throw new Error('Enter a Lichess or Chess.com username.');
  return Promise.all(cleaned.map(validateAccount));
}

/**
 * New accounts for an existing profile: a removed account's sync state and games go (e.g. a mistyped
 * username that belonged to someone else), and so do all games of a platform that has no account left.
 */
async function replaceAccounts(profile: Profile, accounts: Account[]): Promise<void> {
  const removed = profile.accounts.filter(a => !accounts.some(b => sameAccount(a, b)));
  // A sync still running for a removed account would store its games again after the delete.
  if (removed.length > 0) await stopJobsOf(profile.id);
  for (const old of removed) {
    await repo.deleteSyncState(syncStateKey(profile.id, old));
    let deleted = await repo.deleteGamesOfAccount(profile.id, old);
    if (!accounts.some(b => b.platform === old.platform)) deleted += await repo.deleteGamesOfPlatform(profile.id, old.platform);
    if (deleted > 0) await markAnalysisStale(profile.id);
  }
  const defaultName = profile.accounts[0]?.username;
  const name = !defaultName || profile.name === defaultName ? accounts[0]!.username : profile.name;
  await repo.updateProfile(profile.id, { accounts, name });
}

/** Validates the accounts exist, creates/updates the self profile and starts refresh(). */
export async function setupSelf(accounts: Account[]): Promise<Profile> {
  const validated = await validateAccounts(accounts);
  let self = selfProfile.value;
  if (self?.demo) {
    // The example data must not mix with the user's own games.
    await stopJobsOf(self.id);
    await repo.deleteProfile(self.id);
    self = null;
  }
  let profileId: string;
  if (self) {
    await replaceAccounts(self, validated);
    profileId = self.id;
  } else {
    profileId = (await repo.ensureSelfProfile({ name: validated[0]!.username, accounts: validated, aliases: [] }, now())).id;
  }
  await reloadAll();
  startRefresh(profileId, 'refresh');
  return selfProfile.value!;
}

export async function updateSelfAccounts(accounts: Account[]): Promise<void> {
  const self = selfProfile.value;
  if (!self) {
    await setupSelf(accounts);
    return;
  }
  const validated = await validateAccounts(accounts);
  await replaceAccounts(self, validated);
  await reloadAll();
  startRefresh(self.id, 'refresh');
}

export async function addScout(input: { name?: string; accounts: Account[] }): Promise<Profile> {
  const validated = await validateAccounts(input.accounts);
  const name = input.name?.trim() || validated[0]!.username;
  const profile = await repo.createProfile({ name, kind: 'opponent', accounts: validated, aliases: [] }, now());
  await reloadProfiles();
  startRefresh(profile.id, 'scout');
  return profile;
}

export async function removeProfile(id: string): Promise<void> {
  await stopJobsOf(id);
  await repo.deleteProfile(id);
  await repo.deleteMeta(analysisKeyMeta(id));
  await reloadAll();
}

// ── PGN import ────────────────────────────────────────────────────────────

/** Scan a PGN file's player names (for "Which of these is you?"). */
export function scanPgn(file: Blob): Promise<{ name: string; games: number }[]> {
  return scanPgnFileNames(file, 10);
}

/**
 * Imports a PGN file into the self profile (created when there is none) or `profileId`. Resolves once
 * the games are stored; the analysis then runs as a background job (progress in analysisProgress).
 */
export async function importPgn(file: Blob, opts: { aliases?: string[]; asColor?: Color; profileId?: string }): Promise<void> {
  let profile = await targetProfile(opts.profileId);
  if (!profile && opts.profileId !== undefined) throw new Error('That profile no longer exists.');
  profile ??= await repo.ensureSelfProfile({ name: opts.aliases?.[0]?.trim() || 'Me', accounts: [], aliases: [] }, now());
  await repo.addAliases(profile.id, opts.aliases ?? []);
  await reloadAll();
  const profileId = profile.id;
  let analyse = false;
  // Every file is its own job (only identical sync/analysis requests share a run).
  await enqueue(`import#${++importCounter}`, profileId, async signal => {
    let r: Awaited<ReturnType<typeof importPgnIntoProfile>>;
    try {
      r = await importPgnIntoProfile(profileId, file, { signal, asColor: opts.asColor, onProgress: p => (syncProgress.value = p) });
    } catch (err) {
      // Games read before a cancellation or a read error are kept.
      await markAnalysisStale(profileId).catch(() => undefined);
      throw err;
    }
    if (r.added > 0) await markAnalysisStale(profileId);
    const parts = [`Imported ${r.added} game${r.added === 1 ? '' : 's'}`];
    if (r.duplicates > 0) parts.push(`${r.duplicates} already stored`);
    if (r.skipped > 0) parts.push(`${r.skipped} skipped (variants or no moves)`);
    if (r.unmatched > 0) parts.push(`${r.unmatched} not yours (pick your name in the file to include them)`);
    notice.value = { kind: r.added > 0 ? 'success' : 'info', text: `${parts.join(' · ')}.` };
    if (profileId === selfProfile.value?.id) games.value = await repo.getGames(profileId);
    analyse = await needsAnalysis(profileId, r.added);
  }, { mustRun: true });
  if (analyse) enqueue('analyze', profileId, signal => runAnalysis(profileId, signal)).catch(reportError('analysis'));
}

// ── Mistakes, settings, filters ───────────────────────────────────────────

function applyPatch(m: Mistake, patch: repo.MistakePatch, at: number): Mistake {
  const next: Mistake = { ...m, ...patch, updatedAt: at };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
  return next;
}

export async function setMistakeStatus(
  id: string,
  status: MistakeStatus,
  opts?: { reason?: 'repertoire' | 'other'; snoozeDays?: number },
): Promise<void> {
  const at = now();
  const snooze = opts?.snoozeDays !== undefined && opts.snoozeDays > 0;
  const patch: repo.MistakePatch = {
    status,
    ignoreReason: status === 'ignored' ? opts?.reason ?? 'other' : undefined,
    // Snoozing keeps the status; any other change (restore, master, ignore) ends a snooze.
    snoozedUntil: snooze ? at + opts.snoozeDays! * DAY_MS : undefined,
  };
  await repo.patchMistake(id, patch, at);
  mistakes.value = mistakes.value.map(m => (m.id === id ? applyPatch(m, patch, at) : m));
  tick();
}

/** Saves settings; a new worker count applies from the next engine use while the pool is idle. */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings.value = await repo.saveSettings(patch);
}

export function setFilters(patch: Partial<ViewFilters>): void {
  filters.value = { ...filters.value, ...patch };
  saveFilters(filters.value);
}

export function getMistakeByShortId(shortId: string): Mistake | undefined {
  return mistakes.value.find(m => m.shortId === shortId);
}

// ── Training ──────────────────────────────────────────────────────────────

/** Builds a session for the self profile (or a scout prep drill when profileId is an opponent). */
export async function startSession(opts: { profileId?: string; filters?: Partial<ViewFilters> } = {}): Promise<SessionCard[]> {
  tick();
  const profile = await targetProfile(opts.profileId);
  if (!profile) return [];
  const { sessionSize, newPerDay } = settings.value;
  if (profile.kind === 'opponent') {
    // Prep drill: their leaks with a known punishment, by impact; no daily new-card limit.
    const [ms, rs] = await Promise.all([repo.getMistakes(profile.id), repo.getReviews(profile.id)]);
    const drill = ms.filter(m => m.refutation !== undefined);
    return buildSession(drill.length > 0 ? drill : ms, rs, now(), { size: sessionSize, newToday: 0, newPerDay: sessionSize, filters: opts.filters });
  }
  await loadNewToday();
  return buildSession(mistakes.value, [...reviews.value.values()], now(), {
    size: sessionSize,
    newToday: newToday.value,
    newPerDay,
    filters: opts.filters,
  });
}

/** Judges a move (standard UCI) for a card; evaluates unknown moves with the engine (interactive priority). */
export async function submitMove(card: SessionCard, uci: string, signal?: AbortSignal): Promise<MoveVerdict> {
  const m = card.mistake;
  const depth = presetDepths(settings.value).confirm;
  const owner = profiles.value.find(p => p.id === m.profileId);
  if (owner?.kind === 'opponent' && m.refutation) return judgeRefutationMove(getPool(), m, uci, depth, signal);
  const key = `${ENGINE_ID}|${m.posKey}`;
  const cached = (await repo.getEvals([key])).get(key);
  const known = judgeMove(m, uci, cached);
  if (known.kind !== 'unknown') return known;
  const verdict = await evaluateTrainingMove(getPool(), m, uci, depth, signal);
  const move = normalizeUci(m.fen, uci);
  if (verdict.kind === 'correct' && move && move !== m.bestMove && !m.acceptable.includes(move)) {
    const acceptable = [...m.acceptable, move];
    mistakes.value = mistakes.value.map(x => (x.id === m.id ? { ...x, acceptable } : x));
  }
  return verdict;
}

export async function gradeCard(card: SessionCard, grade: Grade): Promise<ReviewState> {
  const at = now();
  const isSelf = card.mistake.profileId === selfProfile.value?.id;
  // The card may be graded again within a session (a retry): build on the latest review state.
  const previous = (isSelf ? reviews.value.get(card.mistake.id) : undefined) ?? card.review;
  const review = await recordGrade({ ...card, review: previous }, grade, at);
  if (isSelf) {
    reviews.value = new Map(reviews.value).set(review.mistakeId, review);
    // The attempt just stored may have started a new card.
    if (previous === undefined) await loadNewToday();
  }
  tick();
  return review;
}

/** Attempts per day for the last `days` days (heatmap) and the current daily streak. */
export async function practiceStats(days = 91): Promise<{ byDay: { day: string; total: number; correct: number }[]; streak: number }> {
  const self = selfProfile.value;
  if (!self) return { byDay: [], streak: 0 };
  const perDay = new Map<string, { total: number; correct: number }>();
  for (const a of await repo.getAttempts(self.id)) {
    const day = localDay(a.at);
    const entry = perDay.get(day) ?? { total: 0, correct: 0 };
    entry.total++;
    if (a.grade !== 'again') entry.correct++;
    perDay.set(day, entry);
  }
  const today = new Date(now());
  const dayBack = (n: number): string => localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n, 12).getTime());
  const byDay = Array.from({ length: Math.max(0, days) }, (_, i) => {
    const day = dayBack(days - 1 - i);
    return { day, ...(perDay.get(day) ?? { total: 0, correct: 0 }) };
  });
  // The streak counts back from today, or from yesterday while today has no attempt yet.
  const start = perDay.has(dayBack(0)) ? 0 : 1;
  let streak = 0;
  while (perDay.has(dayBack(start + streak))) streak++;
  return { byDay, streak };
}

// ── Scout ─────────────────────────────────────────────────────────────────

export async function loadScout(profileId: string): Promise<{ profile: Profile; mistakes: Mistake[]; games: StoredGame[] }> {
  const profile = await repo.getProfile(profileId);
  if (!profile) throw new Error('This scouted player no longer exists.');
  const [ms, gs] = await Promise.all([repo.getMistakes(profileId), repo.getGames(profileId)]);
  return { profile, mistakes: ms, games: gs };
}

// ── Data ──────────────────────────────────────────────────────────────────

export async function exportData(): Promise<Blob> {
  const file = await exportBackup({ now: now() });
  settings.value = await repo.saveSettings({ lastBackupAt: now() });
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

/** PGN of the visible mistakes (Lichess study / Chessable importable). */
export async function exportMistakesPgn(): Promise<Blob> {
  const pgn = mistakesToPgn(visibleMistakes.value, { profileName: selfProfile.value?.name ?? 'Me', now: now() });
  return new Blob([pgn], { type: 'application/x-chess-pgn' });
}

/** Replaces all data with a backup (v3, or merges a legacy v2 backup into the own profile). */
export async function importData(file: Blob): Promise<void> {
  if (currentJob || jobs.size > 0) throw new Error('Wait for the current download or analysis to finish (or cancel it) before restoring a backup.');
  // This tab runs no job, so a held lock means another tab's job, which would keep writing into the restored data.
  if (await isJobLockHeld()) throw new Error('Another tab is downloading or analysing; wait for it to finish (or close it) before restoring a backup.');
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error('This file is not a Chess Analyzer backup (it is not valid JSON).');
  }
  const result = await importBackup(json, { now: now() });
  await reloadAll();
  notice.value = { kind: 'success', text: `Backup restored: ${result.mistakes} mistakes, ${result.games} games.` };
}

export async function clearData(): Promise<void> {
  cancelJobs();
  await jobTail;
  await clearAllData();
  try {
    storage()?.removeItem(FILTERS_KEY);
  } catch {
    // ignore
  }
  filters.value = DEFAULT_FILTERS;
  syncProgress.value = null;
  analysisProgress.value = null;
  await reloadAll();
}

/**
 * Loads `${BASE_URL}demo/demo.json` (a v3 backup). Without an own profile it becomes the (demo) own
 * profile, which setupSelf later replaces; next to a real own profile it is added as a scouted player,
 * so the user's data is never touched. Loading it again replaces the earlier copy.
 */
export async function loadDemo(): Promise<void> {
  const base = import.meta.env?.BASE_URL ?? '/';
  const url = `${base.endsWith('/') ? base : `${base}/`}demo/demo.json`;
  const res = await (deps.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`The example report could not be loaded (HTTP ${res.status}).`);
  const json: unknown = await res.json();
  const self = selfProfile.value;
  const fileIds = new Set(
    typeof json === 'object' && json !== null && Array.isArray((json as { profiles?: unknown }).profiles)
      ? ((json as { profiles: { id?: unknown }[] }).profiles).map(p => p.id)
      : [],
  );
  const keepKind = !self || fileIds.has(self.id);
  await importBackup(json, { mode: 'merge', demo: true, ...(keepKind ? {} : { asKind: 'opponent' as const }) });
  await reloadAll();
}

export async function diagnostics(): Promise<Record<string, unknown>> {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number });
  let persisted: boolean | undefined;
  let estimate: { usage?: number; quota?: number } | undefined;
  try {
    persisted = await nav?.storage?.persisted?.();
    const e = await nav?.storage?.estimate?.();
    if (e) estimate = { usage: e.usage, quota: e.quota };
  } catch {
    // storage API unavailable
  }
  let counts: Record<string, number> | string;
  try {
    counts = await repo.tableCounts();
  } catch (err) {
    counts = `unavailable: ${messageOf(err)}`;
  }
  return {
    version: APP_VERSION,
    userAgent: nav?.userAgent,
    hardwareConcurrency: nav?.hardwareConcurrency,
    deviceMemory: nav?.deviceMemory,
    webAssembly: typeof WebAssembly !== 'undefined',
    engine: ENGINE_ID,
    enginePoolSize: deps.pool?.size ?? enginePool?.size ?? poolSize(),
    analysisDepths: presetDepths(settings.value),
    storagePersisted: persisted,
    storageEstimate: estimate,
    counts,
    profiles: profiles.value.map(p => ({ kind: p.kind, accounts: p.accounts.length, lastSyncAt: p.lastSyncAt, lastAnalysisAt: p.lastAnalysisAt, demo: p.demo === true })),
    settings: settings.value,
    lastErrors: [...recentErrors],
  };
}

// ── init ──────────────────────────────────────────────────────────────────

/** Accounts from a deep link: `#/?lichess=NAME&chesscom=NAME` (or the same in the query string). */
export function deepLinkAccounts(hash: string, search = ''): Account[] {
  const fromHash = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const out: Account[] = [];
  for (const query of [fromHash, search.replace(/^\?/, '')]) {
    const params = new URLSearchParams(query);
    for (const platform of ['lichess', 'chesscom'] as const) {
      const username = params.get(platform)?.trim();
      if (username) out.push({ platform, username });
    }
  }
  return cleanAccounts(out);
}

async function handleDeepLink(): Promise<void> {
  if (typeof location === 'undefined') return;
  const accounts = deepLinkAccounts(location.hash, location.search);
  if (accounts.length === 0) return;
  try {
    history.replaceState(null, '', `${location.pathname}#/`);
  } catch {
    // ignore: the link is handled either way
  }
  const self = selfProfile.value;
  if (!self || self.demo) {
    await setupSelf(accounts);
    return;
  }
  const same = self.accounts.length === accounts.length && accounts.every(a => self.accounts.some(b => sameAccount(a, b)));
  if (same) return;
  const names = accounts.map(a => a.username).join(' / ');
  notice.value = {
    kind: 'info',
    text: `This link analyses ${names}. Your own profile is ${self.name}.`,
    action: { label: `Analyse ${names} instead`, run: () => void setupSelf(accounts).catch(reportError('deep link')) },
  };
}

/** On open: resume an interrupted job, or sync when the last sync is old enough. */
async function autoStart(): Promise<void> {
  const self = selfProfile.value;
  const interrupted = await repo.getMeta<{ profileId: string }>('job');
  const syncDue = self && settings.value.autoSync && self.accounts.length > 0 && (!self.lastSyncAt || now() - self.lastSyncAt > AUTO_SYNC_AFTER_MS);
  if (self && syncDue) await refresh(self.id);
  else if (interrupted && profiles.value.some(p => p.id === interrupted.profileId)) await analyze(interrupted.profileId);
}

let initPromise: Promise<void> | null = null;
/** Deep link and auto-sync, started by init without blocking it. */
let startup: Promise<void> = Promise.resolve();
const teardown: (() => void)[] = [];

function listenToEnvironment(): void {
  teardown.push(
    onJobBroadcast(msg => {
      otherTabBusy.value = msg.type === 'job-started';
      if (msg.type === 'job-done') void reloadAll().catch(reportError('reload'));
    }),
  );
  if (typeof window !== 'undefined') {
    const timer = setInterval(tick, CLOCK_TICK_MS);
    teardown.push(() => clearInterval(timer));
  }
  if (typeof document !== 'undefined') {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      tick();
      const id = resumeOnVisible;
      resumeOnVisible = null;
      if (id) void analyze(id).catch(reportError('resume'));
    };
    document.addEventListener('visibilitychange', onVisible);
    teardown.push(() => document.removeEventListener('visibilitychange', onVisible));
  }
}

async function doInit(): Promise<void> {
  try {
    const db = getDb();
    db.on('versionchange', () => {
      // Dexie closes this connection so the other tab can upgrade the database.
      notice.value = {
        kind: 'info',
        text: 'A newer version of the app was opened in another tab. Reload this tab to keep working.',
        action: { label: 'Reload', run: () => location.reload() },
      };
    });
    await db.open();
    await reloadAll();
  } catch (err) {
    logError('init', err);
    notice.value = { kind: 'error', text: `This browser is not letting the app store data (${messageOf(err)}). Private windows often block it.` };
    ready.value = true;
    return;
  }
  filters.value = loadFilters();
  tick();
  listenToEnvironment();
  otherTabBusy.value = await isJobLockHeld();
  ready.value = true;
  startup = handleDeepLink()
    .catch(reportError('deep link'))
    .then(() => autoStart())
    .catch(reportError('auto sync'));
}

/** Loads db, settings and the self profile's data; handles deep links; auto-syncs when due. Idempotent. */
export function init(): Promise<void> {
  initPromise ??= doInit();
  return initPromise;
}

// ── Test hooks ────────────────────────────────────────────────────────────

/** Tests: inject fakes (fetch, engine pool, opening book, clock). */
export function __setTestDeps(d: StoreTestDeps): void {
  deps = { ...d };
  tick();
}

/** Tests: cancel jobs, forget init and reset every signal. */
export async function __resetForTests(): Promise<void> {
  await startup;
  cancelJobs();
  await __jobsIdle();
  for (const off of teardown.splice(0)) off();
  initPromise = null;
  startup = Promise.resolve();
  enginePool?.terminate();
  enginePool = null;
  recentErrors.length = 0;
  ready.value = false;
  settings.value = DEFAULT_SETTINGS;
  filters.value = DEFAULT_FILTERS;
  profiles.value = [];
  mistakes.value = [];
  reviews.value = new Map();
  games.value = [];
  syncProgress.value = null;
  analysisProgress.value = null;
  otherTabBusy.value = false;
  notice.value = null;
  newToday.value = 0;
  deps = {};
  tick();
}

/** Tests: wait until init's background start and every queued job (including jobs queued by jobs) have settled. */
export async function __jobsIdle(): Promise<void> {
  await startup;
  for (let tail = jobTail; ; tail = jobTail) {
    await tail;
    if (tail === jobTail) return;
  }
}
