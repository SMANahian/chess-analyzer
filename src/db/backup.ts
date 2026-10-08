// Backups: JSON export/import of the whole database (v3), import of the legacy v2 app's backup, and
// clearing all data. Imports validate first and then write in one rw transaction, so a bad file can
// never leave a half-replaced database.
import { START_FEN, normalizeUci, parseStandardUci, posFromFen, posKey, toStandardUci } from '../core/chess';
import { impactOf } from '../core/classify';
import { toStoredGame } from '../core/games';
import { shortId } from '../core/hash';
import { parsePgnText, pgnGameToRaw } from '../core/pgn';
import {
  ANALYSIS_PRESETS,
  DEFAULT_SETTINGS,
  DEPTH_OVERRIDE_OPTIONS,
  GAMES_PER_ACCOUNT_OPTIONS,
  MAX_STORED_PLIES,
  SETTING_RANGES,
  THEMES,
  type Account,
  type Attempt,
  type Color,
  type Grade,
  type LastOutcome,
  type Mistake,
  type MistakeKind,
  type MistakeStatus,
  type Occurrence,
  type Outcome,
  type Profile,
  type RawGame,
  type ReviewState,
  type Score,
  type Settings,
  type Severity,
  type Speed,
  type StoredGame,
  type SyncState,
} from '../core/types';
import { LOW_CONFIDENCE_BELOW, severityOf, winLoss } from '../core/winrate';
import { addGames, randomId } from './repo';
import { getDb } from './schema';

export interface BackupFile {
  app: 'chess-analyzer';
  version: 3;
  exportedAt: number;
  profiles: Profile[];
  games: StoredGame[];
  syncState: SyncState[];
  mistakes: Mistake[];
  reviews: ReviewState[];
  attempts: Attempt[];
  /** Without `storagePersisted`: that describes the browser that wrote it, not the data. */
  settings: Settings;
  /**
   * Never written, and ignored on import: the eval cache is trusted by the analysis, so a backup must
   * not be able to plant evaluations in it. (Kept in the type so readers can assert its absence.)
   */
  evals?: never;
}

export interface ImportResult {
  profiles: number;
  games: number;
  mistakes: number;
}

export interface ImportOptions {
  /**
   * 'replace' (default): the backup replaces all profiles, games, progress and settings (the eval cache
   * is left alone, and so is this browser's `storagePersisted`). 'merge': only the backup's profiles are
   * replaced (by id); other profiles and the settings are untouched. Legacy v2 backups always merge
   * into the self profile.
   */
  mode?: 'replace' | 'merge';
  /** Merge only: import every profile of the backup with this kind (e.g. a demo next to a real self profile). */
  asKind?: Profile['kind'];
  /** Merge only: flag the imported profiles as the bundled example (`Profile.demo`). */
  demo?: boolean;
  /** Clock for legacy imports (snooze end, timestamps). */
  now?: number;
}

const DAY_MS = 86_400_000;
const LEGACY_SNOOZE_DAYS = 30;
/** Synthesised occurrences per legacy mistake (its pair count, capped). */
const LEGACY_MAX_OCCURRENCES = 200;
export const LEGACY_ENGINE = 'legacy-v2';

// ── Export ────────────────────────────────────────────────────────────────

/** Everything except the eval cache (a pure cache, and never imported) and this browser's storagePersisted. */
export async function exportBackup(opts: { now?: number } = {}): Promise<BackupFile> {
  const db = getDb();
  return db.transaction('r', db.allTables(), async () => {
    const [profiles, games, syncState, mistakes, reviews, attempts, settingsRow] = await Promise.all([
      db.profiles.toArray(),
      db.games.toArray(),
      db.syncState.toArray(),
      db.mistakes.toArray(),
      db.reviews.toArray(),
      db.attempts.toArray(),
      db.meta.get('settings'),
    ]);
    // Rows of a deleted profile (left by an older version) would make the file fail its own validation.
    const ids = new Set(profiles.map(p => p.id));
    const owned = <T extends { profileId: string }>(rows: T[]): T[] => rows.filter(r => ids.has(r.profileId));
    const { storagePersisted: _thisBrowser, ...settings } = { ...DEFAULT_SETTINGS, ...(settingsRow?.value as Partial<Settings> | undefined) };
    return {
      app: 'chess-analyzer',
      version: 3,
      exportedAt: opts.now ?? Date.now(),
      profiles,
      games: owned(games),
      syncState: owned(syncState),
      mistakes: owned(mistakes),
      reviews: owned(reviews),
      attempts: owned(attempts),
      settings,
    };
  });
}

// ── Validation ────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A non-empty string (ids, names). */
const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isText = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isColor = (v: unknown): v is Color => v === 'white' || v === 'black';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const oneOf =
  <T>(values: readonly T[]) =>
  (v: unknown): v is T =>
    values.includes(v as T);
/** An optional field: absent, or valid. (JSON has no undefined; null is not "absent".) */
const optional =
  (check: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === undefined || check(v);

const isSpeed = oneOf<Speed>(['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown']);
const isOutcome = oneOf<Outcome>(['win', 'loss', 'draw', 'unknown']);
const isGrade = oneOf<Grade>(['again', 'hard', 'good', 'easy']);
const isOnlinePlatform = oneOf(['lichess', 'chesscom'] as const);

function isAccount(v: unknown): v is Account {
  return isRecord(v) && isOnlinePlatform(v.platform) && isString(v.username);
}

/** Exactly what the analysis writes: a finite cp or a finite mate count. */
const isScore = (v: unknown): v is Score => isRecord(v) && (isNumber(v.cp) || isNumber(v.mate));

const isOccurrence = (v: unknown): v is Occurrence =>
  isRecord(v) && isText(v.g) && isNumber(v.t) && isSpeed(v.s) && isOutcome(v.o) && isText(v.m) && isBoolean(v.r);

const isFen = (v: unknown): v is string => isString(v) && posFromFen(v) !== undefined;

const isRefutation = (v: unknown): boolean =>
  isRecord(v) &&
  isFen(v.fen) &&
  isString(v.posKey) &&
  isText(v.bestMove) &&
  isStringArray(v.bestLine) &&
  isScore(v.score) &&
  isStringArray(v.acceptable) &&
  isNumber(v.depth);

/** Every field the views, the filters and training read (a bad nested value would throw on every render). */
const isMistake = (r: Json): boolean =>
  isString(r.id) &&
  isString(r.profileId) &&
  isString(r.shortId) &&
  isString(r.posKey) &&
  isFen(r.fen) &&
  isString(r.move) &&
  isText(r.bestMove) &&
  isColor(r.color) &&
  oneOf<MistakeKind>(['mistake', 'book'])(r.kind) &&
  oneOf<Severity>(['inaccuracy', 'mistake', 'blunder'])(r.severity) &&
  oneOf<Mistake['confidence']>(['normal', 'low'])(r.confidence) &&
  oneOf<LastOutcome>(['habit', 'fixed', 'other-bad', 'unknown'])(r.lastOutcome) &&
  oneOf<MistakeStatus>(['active', 'mastered', 'ignored'])(r.status) &&
  Array.isArray(r.occurrences) &&
  r.occurrences.every(isOccurrence) &&
  isStringArray(r.acceptable) &&
  isStringArray(r.path) &&
  isStringArray(r.playedLine) &&
  isStringArray(r.bestLine) &&
  isScore(r.scoreBest) &&
  isScore(r.scorePlayed) &&
  [r.ply, r.count, r.positionCount, r.winLoss, r.impact, r.lastPlayedAt, r.fixedStreak, r.evalDepth, r.createdAt, r.updatedAt].every(isNumber) &&
  isText(r.engine) &&
  optional(isText)(r.openingName) &&
  optional(isText)(r.openingEco) &&
  optional(isString)(r.dependsOn) &&
  optional(isNumber)(r.snoozedUntil) &&
  optional(oneOf(['repertoire', 'other']))(r.ignoreReason) &&
  optional(isBoolean)(r.dormant) &&
  optional(isRefutation)(r.refutation);

const VALIDATORS = {
  profiles: (r: Json): boolean =>
    isString(r.id) &&
    isString(r.name) &&
    (r.kind === 'self' || r.kind === 'opponent') &&
    Array.isArray(r.accounts) &&
    r.accounts.every(isAccount) &&
    optional(isNumber)(r.lastSyncAt) &&
    optional(isNumber)(r.lastAnalysisAt) &&
    optional(isBoolean)(r.demo),
  // The next analysis copies speed, rated and outcome into occurrences; the Openings page scores outcomes.
  games: (r: Json): boolean =>
    isString(r.key) &&
    isString(r.profileId) &&
    oneOf(['lichess', 'chesscom', 'pgn'])(r.platform) &&
    isText(r.sourceId) &&
    isText(r.contentKey) &&
    isText(r.moves) &&
    isColor(r.color) &&
    isNumber(r.playedAt) &&
    isText(r.opponent) &&
    isSpeed(r.speed) &&
    isBoolean(r.rated) &&
    isOutcome(r.outcome),
  syncState: (r: Json): boolean =>
    isString(r.key) &&
    isString(r.profileId) &&
    isOnlinePlatform(r.platform) &&
    isString(r.username) &&
    isNumber(r.stored) &&
    optional(isNumber)(r.newestCreatedAt) &&
    optional(isNumber)(r.oldestCreatedAt) &&
    optional(isBoolean)(r.reachedStart) &&
    optional(isStringArray)(r.doneArchives) &&
    optional(isNumber)(r.lastSyncAt),
  mistakes: isMistake,
  reviews: (r: Json): boolean =>
    isString(r.mistakeId) &&
    isString(r.profileId) &&
    [r.due, r.interval, r.ease, r.reps, r.lapses].every(isNumber) &&
    optional(isNumber)(r.lastReviewedAt) &&
    optional(isGrade)(r.lastGrade),
  attempts: (r: Json): boolean => isString(r.mistakeId) && isString(r.profileId) && isNumber(r.at) && isGrade(r.grade),
} as const;

type TableName = keyof typeof VALIDATORS;

function rowsOf(data: Json, table: TableName): Json[] {
  const rows = data[table];
  if (!Array.isArray(rows)) throw new Error(`This backup has no valid "${table}" list.`);
  rows.forEach((row: unknown, i) => {
    if (!isRecord(row) || !VALIDATORS[table](row)) throw new Error(`This backup is damaged: ${table}[${i}] is not a valid record.`);
  });
  return rows as Json[];
}

/** An integer in the range, on its step (from the range's minimum). */
function inRange(v: unknown, range: { min: number; max: number; step: number }, fallback: number): number {
  if (!isNumber(v)) return fallback;
  const clamped = Math.min(range.max, Math.max(range.min, v));
  return Math.min(range.max, range.min + Math.round((clamped - range.min) / range.step) * range.step);
}

/** The option closest to `v` (the first on a tie). */
function nearestOption(v: unknown, options: readonly number[], fallback: number): number {
  if (!isNumber(v)) return fallback;
  return options.reduce((best, o) => (Math.abs(o - v) < Math.abs(best - v) ? o : best));
}

/**
 * Settings from outside (a backup), field by field: values the Settings page cannot produce are
 * clamped to its ranges or replaced by the default, unknown fields are dropped, and so is
 * `storagePersisted` (it describes the browser that wrote the file, not this one).
 */
export function sanitizeSettings(raw: unknown): Settings {
  const s = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  const out: Settings = {
    openingPlies: inRange(s.openingPlies, SETTING_RANGES.openingPlies, d.openingPlies),
    preset: oneOf(ANALYSIS_PRESETS)(s.preset) ? s.preset : d.preset,
    depthOverride: oneOf(DEPTH_OVERRIDE_OPTIONS)(s.depthOverride) ? s.depthOverride : d.depthOverride,
    engineWorkers: inRange(s.engineWorkers, SETTING_RANGES.engineWorkers, d.engineWorkers),
    gamesPerAccount: nearestOption(s.gamesPerAccount, GAMES_PER_ACCOUNT_OPTIONS, d.gamesPerAccount),
    sessionSize: inRange(s.sessionSize, SETTING_RANGES.sessionSize, d.sessionSize),
    newPerDay: inRange(s.newPerDay, SETTING_RANGES.newPerDay, d.newPerDay),
    replayPlies: inRange(s.replayPlies, SETTING_RANGES.replayPlies, d.replayPlies),
    autoSync: isBoolean(s.autoSync) ? s.autoSync : d.autoSync,
    theme: oneOf(THEMES)(s.theme) ? s.theme : d.theme,
  };
  if (isNumber(s.lastBackupAt)) out.lastBackupAt = s.lastBackupAt;
  return out;
}

/**
 * A v3 backup with every row (nested fields included) checked and every row belonging to one of its
 * profiles; the settings sanitised. An `evals` list is ignored: imported evaluations would be trusted
 * by every later analysis.
 */
function parseV3(data: Json): BackupFile {
  const profiles = rowsOf(data, 'profiles') as unknown as Profile[];
  const ids = new Set(profiles.map(p => p.id));
  if (ids.size !== profiles.length) throw new Error('This backup is damaged: duplicate profile ids.');
  if (profiles.filter(p => p.kind === 'self').length > 1) throw new Error('This backup is damaged: more than one own profile.');
  const owned = <T extends { profileId: string }>(table: TableName): T[] => {
    const rows = rowsOf(data, table) as unknown as T[];
    const orphan = rows.findIndex(r => !ids.has(r.profileId));
    if (orphan >= 0) throw new Error(`This backup is damaged: ${table}[${orphan}] belongs to no profile.`);
    return rows;
  };
  return {
    app: 'chess-analyzer',
    version: 3,
    exportedAt: isNumber(data.exportedAt) ? data.exportedAt : 0,
    profiles: profiles.map(p => ({ ...p, aliases: isStringArray(p.aliases) ? p.aliases : [], createdAt: isNumber(p.createdAt) ? p.createdAt : 0 })),
    games: owned<StoredGame>('games'),
    syncState: owned<SyncState>('syncState'),
    mistakes: owned<Mistake>('mistakes'),
    reviews: owned<ReviewState>('reviews'),
    attempts: owned<Attempt>('attempts'),
    settings: sanitizeSettings(data.settings),
  };
}

// ── Import ────────────────────────────────────────────────────────────────

/** Validates `data` (v3 or legacy v2) and writes it in one rw transaction over the affected tables. */
export async function importBackup(data: unknown, opts: ImportOptions = {}): Promise<ImportResult> {
  if (!isRecord(data)) throw new Error('This file is not a Chess Analyzer backup.');
  if (data.backup_version === 1 || data.backup_version === 2) return importLegacy(data, opts.now ?? Date.now());
  if (data.app !== 'chess-analyzer') throw new Error('This file is not a Chess Analyzer backup.');
  if (data.version !== 3) throw new Error(`This backup has version ${String(data.version)}; this app reads version 3.`);
  const file = parseV3(data);
  if (opts.mode === 'merge') {
    const profiles = file.profiles.map(p => ({ ...p, ...(opts.asKind ? { kind: opts.asKind } : {}), ...(opts.demo ? { demo: true } : {}) }));
    return mergeV3({ ...file, profiles });
  }
  return replaceV3(file);
}

const resultOf = (file: Pick<BackupFile, 'profiles' | 'games' | 'mistakes'>): ImportResult => ({
  profiles: file.profiles.length,
  games: file.games.length,
  mistakes: file.mistakes.length,
});

/** Attempts get fresh auto-increment ids (a merged file's ids could collide). */
const withoutIds = (attempts: readonly Attempt[]): Attempt[] => attempts.map(({ id: _id, ...a }) => a);

async function replaceV3(file: BackupFile): Promise<ImportResult> {
  const db = getDb();
  await db.transaction('rw', db.allTables(), async () => {
    // Whether this browser's storage is persistent stays what it is (it is not part of the data).
    const current = (await db.meta.get('settings'))?.value as Partial<Settings> | undefined;
    const settings: Settings = { ...file.settings };
    delete settings.storagePersisted;
    if (current?.storagePersisted !== undefined) settings.storagePersisted = current.storagePersisted;
    await Promise.all([db.profiles, db.games, db.syncState, db.mistakes, db.reviews, db.attempts, db.meta].map(t => t.clear()));
    await db.profiles.bulkAdd(file.profiles);
    await db.games.bulkAdd(file.games);
    await db.syncState.bulkAdd(file.syncState);
    await db.mistakes.bulkAdd(file.mistakes);
    await db.reviews.bulkAdd(file.reviews);
    await db.attempts.bulkAdd(withoutIds(file.attempts));
    // The eval cache is left alone: it is keyed by engine and position, so it stays valid for any data.
    await db.meta.put({ key: 'settings', value: settings });
  });
  return resultOf(file);
}

/** Replaces only the backup's own profiles (by id); everything else stays. */
async function mergeV3(file: BackupFile): Promise<ImportResult> {
  const db = getDb();
  const { profiles } = file;
  const ids = profiles.map(p => p.id);
  await db.transaction('rw', db.allTables(), async () => {
    const others = (await db.profiles.toArray()).filter(p => !ids.includes(p.id));
    if (others.some(p => p.kind === 'self') && profiles.some(p => p.kind === 'self')) {
      throw new Error('There is already an own profile; import this backup as a separate profile instead.');
    }
    for (const table of [db.games, db.syncState, db.mistakes, db.reviews, db.attempts]) {
      await table.where('profileId').anyOf(ids).delete();
    }
    await db.profiles.bulkPut(profiles);
    await db.games.bulkPut(file.games);
    await db.syncState.bulkPut(file.syncState);
    await db.mistakes.bulkPut(file.mistakes);
    await db.reviews.bulkPut(file.reviews);
    await db.attempts.bulkAdd(withoutIds(file.attempts));
  });
  return resultOf(file);
}

// ── Legacy v2 (Python app) ────────────────────────────────────────────────

function isoMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/** v2 stored the centipawn loss; in v3 losses are win-% points at (roughly) an equal position. */
const legacyLoss = (cpLoss: number): number => winLoss({ cp: 0 }, { cp: -Math.abs(cpLoss) });

/** The stored path when it really leads to the position, else none (the board still shows the FEN). */
function legacyPath(moveList: unknown, key: string): string[] {
  if (typeof moveList !== 'string' || moveList.trim() === '') return [];
  const pos = posFromFen(START_FEN)!;
  const path: string[] = [];
  for (const uci of moveList.trim().split(/\s+/)) {
    const move = parseStandardUci(pos, uci);
    if (!move) return [];
    path.push(toStandardUci(pos, move));
    pos.play(move);
  }
  return posKey(pos) === key ? path : [];
}

function plyOfFen(fen: string, turn: Color): number {
  const fullmove = Number(fen.trim().split(/\s+/)[5]) || 1;
  return (fullmove - 1) * 2 + (turn === 'black' ? 1 : 0);
}

/** One v2 mistake row → a v3 Mistake, or null when it cannot be mapped (bad FEN, illegal move, no best move). */
export function legacyMistake(row: unknown, profileId: string, now: number): Mistake | null {
  if (!isRecord(row) || typeof row.fen !== 'string' || typeof row.user_move !== 'string') return null;
  const pos = posFromFen(row.fen.trim());
  if (!pos) return null;
  const fen = row.fen.trim();
  const move = normalizeUci(fen, row.user_move.trim());
  if (!move) return null;
  const tops = isStringArray(row.top_moves) ? row.top_moves : [];
  const best = [...new Set(tops.map(u => normalizeUci(fen, u.trim())).filter((u): u is string => u !== undefined))];
  const bestMove = best.find(u => u !== move);
  if (!bestMove) return null;
  const key = posKey(pos);
  const cpLoss = isNumber(row.avg_cp_loss) ? row.avg_cp_loss : 0;
  const loss = legacyLoss(cpLoss);
  const count = Math.max(1, Math.floor(isNumber(row.pair_count) ? row.pair_count : 1));
  const seenAt = isoMs(row.analyzed_at) ?? now;
  const sid = shortId(key, move);
  // v2 kept no per-game data: synthesise one occurrence per counted game so the view filters can count them.
  const occurrences = Array.from({ length: Math.min(count, LEGACY_MAX_OCCURRENCES) }, (_, i) => ({
    g: `legacy:${sid}:${i}`,
    t: seenAt,
    s: 'unknown' as const,
    r: false,
    o: 'unknown' as const,
    m: move,
  }));
  const path = legacyPath(row.move_list, key);
  const m: Mistake = {
    id: `${profileId}|${key}|${move}`,
    shortId: sid,
    profileId,
    color: pos.turn,
    posKey: key,
    fen,
    ply: path.length > 0 ? path.length : plyOfFen(fen, pos.turn),
    path,
    move,
    kind: 'mistake',
    count,
    positionCount: count,
    occurrences,
    bestMove,
    acceptable: best.filter(u => u !== move),
    bestLine: [bestMove],
    playedLine: [move],
    scoreBest: { cp: 0 },
    scorePlayed: { cp: -Math.abs(cpLoss) },
    winLoss: loss,
    severity: severityOf(loss) ?? 'inaccuracy',
    confidence: loss < LOW_CONFIDENCE_BELOW ? 'low' : 'normal',
    impact: impactOf(occurrences, move, loss, now),
    lastPlayedAt: seenAt,
    lastOutcome: 'unknown',
    fixedStreak: 0,
    evalDepth: 0,
    engine: LEGACY_ENGINE,
    status: row.mastered === true || row.mastered === 1 ? 'mastered' : 'active',
    createdAt: seenAt,
    updatedAt: now,
  };
  if (m.status === 'active' && (row.snoozed === true || row.snoozed === 1)) m.snoozedUntil = now + LEGACY_SNOOZE_DAYS * DAY_MS;
  if (isString(row.opening_eco)) m.openingEco = row.opening_eco;
  if (isString(row.opening_name)) m.openingName = row.opening_name;
  return m;
}

function legacyAccounts(configs: unknown): Account[] {
  const out: Account[] = [];
  for (const c of Array.isArray(configs) ? configs : []) {
    if (!isRecord(c) || !isString(c.username)) continue;
    const platform = c.platform === 'lichess' ? 'lichess' : c.platform === 'chesscom' || c.platform === 'chess.com' ? 'chesscom' : null;
    const username = c.username.trim();
    if (!platform || !username) continue;
    if (!out.some(a => a.platform === platform && a.username.toLowerCase() === username.toLowerCase())) out.push({ platform, username });
  }
  return out;
}

/**
 * The old app kept all of the user's games of one colour as one PGN text per colour (`pgn_files`:
 * synced and uploaded games alike), so each game's colour is the file's.
 */
function legacyGames(files: unknown): { raw: RawGame; color: Color }[] {
  const out: { raw: RawGame; color: Color }[] = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!isRecord(file) || !isColor(file.color) || typeof file.content !== 'string') continue;
    for (const game of parsePgnText(file.content, MAX_STORED_PLIES)) {
      const raw = pgnGameToRaw(game);
      if (raw) out.push({ raw, color: file.color });
    }
  }
  return out;
}

/**
 * v2 backups hold mistakes (FEN, UCI move, top moves, centipawn loss, mastered/snoozed), the synced
 * accounts and the user's games (one PGN text per colour). They merge into the existing own profile,
 * or a new one named 'Imported': accounts are added, games stored like a PGN import (duplicates
 * skipped), mistakes that already exist are left alone. Practice sessions and logs are not imported.
 */
async function importLegacy(data: Json, now: number): Promise<ImportResult> {
  const db = getDb();
  const accounts = legacyAccounts(data.sync_configs);
  // Parsed before the transaction: IndexedDB transactions must not wait on anything else.
  const games = legacyGames(data.pgn_files);
  return db.transaction('rw', [db.profiles, db.games, db.syncState, db.mistakes, db.reviews, db.attempts], async () => {
    let self = await db.profiles.where('kind').equals('self').first();
    if (self?.demo) {
      // The bundled example is not the user's: the old app's data replaces it instead of mixing with it
      // (and being deleted with it once real accounts are set up).
      await deleteProfileRows(self.id);
      self = undefined;
    }
    let created = 0;
    if (!self) {
      self = { id: `me-${randomId()}`, name: 'Imported', kind: 'self', accounts, aliases: [], createdAt: now };
      await db.profiles.add(self);
      created = 1;
    } else {
      const merged = [...self.accounts];
      for (const a of accounts) {
        if (!merged.some(b => b.platform === a.platform && b.username.toLowerCase() === a.username.toLowerCase())) merged.push(a);
      }
      if (merged.length !== self.accounts.length) await db.profiles.update(self.id, { accounts: merged });
    }
    const profileId = self.id;
    const byId = new Map<string, Mistake>();
    for (const row of Array.isArray(data.mistakes) ? data.mistakes : []) {
      const m = legacyMistake(row, profileId, now);
      if (m && !byId.has(m.id)) byId.set(m.id, m);
    }
    const existing = new Set((await db.mistakes.bulkGet([...byId.keys()])).flatMap(m => (m ? [m.id] : [])));
    const fresh = [...byId.values()].filter(m => !existing.has(m.id));
    await db.mistakes.bulkAdd(fresh);
    const added = await addGames(games.map(({ raw, color }) => toStoredGame(raw, profileId, color)));
    return { profiles: created, games: added, mistakes: fresh.length };
  });
}

/** Inside a rw transaction over the profile tables: the profile and every row that belongs to it. */
async function deleteProfileRows(profileId: string): Promise<void> {
  const db = getDb();
  await db.profiles.delete(profileId);
  for (const table of [db.games, db.syncState, db.mistakes, db.reviews, db.attempts]) {
    await table.where('profileId').equals(profileId).delete();
  }
}

// ── Clear ─────────────────────────────────────────────────────────────────

/** Deletes everything, including settings and cached evaluations. */
export async function clearAllData(): Promise<void> {
  const db = getDb();
  await db.transaction('rw', db.allTables(), async () => {
    await Promise.all(db.allTables().map(t => t.clear()));
  });
}
