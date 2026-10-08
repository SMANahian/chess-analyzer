// Data access for the app. Every multi-row write that must be all-or-nothing runs in one rw
// transaction (Dexie bulk operations are not atomic on their own).
import {
  DEFAULT_SETTINGS,
  type Account,
  type Attempt,
  type Mistake,
  type PositionEval,
  type Profile,
  type ReviewState,
  type Settings,
  type StoredGame,
  type SyncState,
} from '../core/types';
import { getDb } from './schema';

const SETTINGS_KEY = 'settings';

// ── Meta and settings ─────────────────────────────────────────────────────

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await getDb().meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await getDb().meta.put({ key, value });
}

export async function deleteMeta(key: string): Promise<void> {
  await getDb().meta.delete(key);
}

/** Stored settings merged over DEFAULT_SETTINGS (new settings get their defaults). */
export async function getSettings(): Promise<Settings> {
  const stored = await getMeta<Partial<Settings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = getDb();
  return db.transaction('rw', db.meta, async () => {
    const next = { ...(await getSettings()), ...patch };
    await db.meta.put({ key: SETTINGS_KEY, value: next });
    return next;
  });
}

// ── Profiles ──────────────────────────────────────────────────────────────

/** 12 random base-36 characters (crypto.getRandomValues works in insecure contexts too, unlike randomUUID). */
export function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => (b % 36).toString(36)).join('');
}

export async function listProfiles(): Promise<Profile[]> {
  const all = await getDb().profiles.toArray();
  return all.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export function getProfile(id: string): Promise<Profile | undefined> {
  return getDb().profiles.get(id);
}

export async function createProfile(p: Omit<Profile, 'id' | 'createdAt'>, now: number = Date.now()): Promise<Profile> {
  const profile: Profile = { ...p, id: `${p.kind === 'self' ? 'me' : 'op'}-${randomId()}`, createdAt: now };
  await getDb().profiles.add(profile);
  return profile;
}

export async function updateProfile(id: string, patch: Partial<Profile>): Promise<void> {
  const { id: _ignored, ...changes } = patch;
  await getDb().profiles.update(id, changes);
}

/** Adds lower-cased PGN aliases to a profile (read-modify-write in one transaction). */
export async function addAliases(id: string, aliases: readonly string[]): Promise<void> {
  const db = getDb();
  await db.transaction('rw', db.profiles, async () => {
    const profile = await db.profiles.get(id);
    if (!profile) return;
    const merged = [...new Set([...profile.aliases, ...aliases.map(a => a.trim().toLowerCase()).filter(a => a !== '')])];
    if (merged.length !== profile.aliases.length) await db.profiles.update(id, { aliases: merged });
  });
}

/** The own profile, created (once, even under concurrent calls) when there is none. */
export async function ensureSelfProfile(p: Omit<Profile, 'id' | 'createdAt' | 'kind'>, now: number = Date.now()): Promise<Profile> {
  const db = getDb();
  return db.transaction('rw', db.profiles, async () => {
    const existing = await db.profiles.where('kind').equals('self').first();
    if (existing) return existing;
    const profile: Profile = { ...p, kind: 'self', id: `me-${randomId()}`, createdAt: now };
    await db.profiles.add(profile);
    return profile;
  });
}

/** Deletes the profile and everything that belongs to it. Cached evals are global and stay. */
export async function deleteProfile(id: string): Promise<void> {
  const db = getDb();
  await db.transaction('rw', [db.profiles, db.games, db.syncState, db.mistakes, db.reviews, db.attempts], async () => {
    await db.profiles.delete(id);
    await Promise.all([db.games, db.syncState, db.mistakes, db.reviews, db.attempts].map(t => t.where('profileId').equals(id).delete()));
  });
}

// ── Games ─────────────────────────────────────────────────────────────────

/** The SyncState to write with a batch of games, or a function of the number of games actually added. */
export type SyncStateUpdate = SyncState | ((added: number) => SyncState);

const contentPair = (g: StoredGame): [string, string] => [g.profileId, g.contentKey];
const contentId = (g: StoredGame): string => `${g.profileId}\u0000${g.contentKey}`;

/**
 * Same content (players, day, first moves) means the same game only across sources: two games of one
 * site have different ids, so they are different games (e.g. the same quick trap twice in a rematch).
 */
const sameGameIfSameContent = (a: StoredGame['platform'], b: StoredGame['platform']): boolean => a === 'pgn' || b === 'pgn';

/**
 * Insert-only: skips games whose key exists and games whose contentKey already exists for the profile
 * from another source, i.e. when one of the two came from a PGN file without a site link (also within
 * the batch). Optionally writes a SyncState in the same transaction, so a sync cursor never gets ahead
 * of (or behind) the games it describes. Returns the number added.
 */
export async function addGames(games: readonly StoredGame[], sync?: SyncStateUpdate): Promise<number> {
  const db = getDb();
  return db.transaction('rw', db.games, db.syncState, async () => {
    const fresh = games.length > 0 ? await newGames(games) : [];
    if (fresh.length > 0) await db.games.bulkAdd(fresh);
    if (sync) await db.syncState.put(typeof sync === 'function' ? sync(fresh.length) : sync);
    return fresh.length;
  });
}

/** Games of the batch that are neither stored nor duplicates of an earlier game in the batch. */
async function newGames(games: readonly StoredGame[]): Promise<StoredGame[]> {
  const db = getDb();
  const existing = await db.games.bulkGet(games.map(g => g.key));
  const seenKeys = new Set(existing.flatMap(g => (g ? [g.key] : [])));
  // One point lookup per game: an anyOf() over the compound index walks a cursor between the keys,
  // which fake-indexeddb (and possibly some engines) does in linear time — 100× slower here.
  const matches = await Promise.all(games.map(g => db.games.where('[profileId+contentKey]').equals(contentPair(g)).toArray()));
  /** contentId → platforms of the stored (or already accepted) games with that content. */
  const seenContent = new Map<string, StoredGame['platform'][]>();
  matches.flat().forEach(m => seenContent.set(contentId(m), [...(seenContent.get(contentId(m)) ?? []), m.platform]));
  const fresh: StoredGame[] = [];
  for (const g of games) {
    const platforms = seenContent.get(contentId(g)) ?? [];
    if (seenKeys.has(g.key) || platforms.some(p => sameGameIfSameContent(p, g.platform))) continue;
    seenKeys.add(g.key);
    seenContent.set(contentId(g), [...platforms, g.platform]);
    fresh.push(g);
  }
  return fresh;
}

/** The profile's games, oldest first. */
export function getGames(profileId: string): Promise<StoredGame[]> {
  return getDb().games.where('[profileId+playedAt]').between([profileId, -Infinity], [profileId, Infinity], true, true).toArray();
}

export function countGames(profileId: string): Promise<number> {
  return getDb().games.where('profileId').equals(profileId).count();
}

export async function getGamesByKeys(keys: readonly string[]): Promise<StoredGame[]> {
  const rows = await getDb().games.bulkGet([...keys]);
  return rows.filter((g): g is StoredGame => g !== undefined);
}

/** Deletes the profile's games of one platform (used when an account is removed from a profile). */
export function deleteGamesOfPlatform(profileId: string, platform: StoredGame['platform']): Promise<number> {
  return getDb().games.where('profileId').equals(profileId).filter(g => g.platform === platform).delete();
}

/** The profile's own name in a game, from the contentKey (`white|black|day|moves`, lower-cased). */
const ownName = (g: StoredGame): string => g.contentKey.split('|')[g.color === 'white' ? 0 : 1] ?? '';

/** Deletes the profile's games that one account played on its site (the account is removed from the profile). */
export function deleteGamesOfAccount(profileId: string, account: Account): Promise<number> {
  const name = account.username.trim().toLowerCase();
  return getDb()
    .games.where('profileId')
    .equals(profileId)
    .filter(g => g.platform === account.platform && ownName(g) === name)
    .delete();
}

// ── Sync state ────────────────────────────────────────────────────────────

export function getSyncStates(profileId: string): Promise<SyncState[]> {
  return getDb().syncState.where('profileId').equals(profileId).toArray();
}

export async function putSyncState(s: SyncState): Promise<void> {
  await getDb().syncState.put(s);
}

export async function deleteSyncState(key: string): Promise<void> {
  await getDb().syncState.delete(key);
}

// ── Evaluations (global cache) ────────────────────────────────────────────

/** keys = `${engine}|${posKey}`; missing keys are absent from the map. */
export async function getEvals(keys: readonly string[]): Promise<Map<string, PositionEval>> {
  const rows = await getDb().evals.bulkGet([...keys]);
  const out = new Map<string, PositionEval>();
  for (const ev of rows) if (ev) out.set(ev.key, ev);
  return out;
}

export async function putEval(ev: PositionEval): Promise<void> {
  await getDb().evals.put(ev);
}

// ── Mistakes ──────────────────────────────────────────────────────────────

export function getMistakes(profileId: string): Promise<Mistake[]> {
  return getDb().mistakes.where('profileId').equals(profileId).toArray();
}

/** Short ids are unique per (position, move); with `profileId` the lookup is limited to that profile. */
export async function getMistakeByShortId(shortId: string, profileId?: string): Promise<Mistake | undefined> {
  const rows = await getDb().mistakes.where('shortId').equals(shortId).toArray();
  return profileId === undefined ? rows[0] : rows.find(m => m.profileId === profileId);
}

/** A fresh analysis row merged onto the stored one: user decisions and history survive re-analysis. */
function mergeMistake(fresh: Mistake, old: Mistake | undefined): Mistake {
  if (!old) return fresh;
  const merged: Mistake = { ...fresh, status: old.status, createdAt: old.createdAt };
  delete merged.dormant;
  if (old.ignoreReason !== undefined) merged.ignoreReason = old.ignoreReason;
  else delete merged.ignoreReason;
  if (old.snoozedUntil !== undefined) merged.snoozedUntil = old.snoozedUntil;
  else delete merged.snoozedUntil;
  // The after-move position is the same for the same id: keep a refutation computed earlier.
  if (fresh.refutation === undefined && old.refutation !== undefined) merged.refutation = old.refutation;
  return merged;
}

/**
 * Merges analysis output: preserves status, ignoreReason, snoozedUntil, createdAt (and an earlier
 * refutation) of existing rows and clears `dormant`. Returns the rows as stored.
 */
export async function upsertMistakes(ms: readonly Mistake[]): Promise<Mistake[]> {
  if (ms.length === 0) return [];
  const db = getDb();
  return db.transaction('rw', db.mistakes, async () => {
    const old = await db.mistakes.bulkGet(ms.map(m => m.id));
    const merged = ms.map((m, i) => mergeMistake(m, old[i]));
    await db.mistakes.bulkPut(merged);
    return merged;
  });
}

/** A row the user has acted on: kept (dormant) rather than deleted when analysis stops producing it. */
const hasHistory = (m: Mistake, reviewed: ReadonlySet<string>): boolean =>
  reviewed.has(m.id) || m.status !== 'active' || m.snoozedUntil !== undefined;

/**
 * After a COMPLETE analysis: rows not in `keepIds` are deleted when they have no history, else marked
 * dormant. History = a review, or a user decision (mastered, ignored, snoozed), so a re-appearing
 * mistake keeps that decision. Keeping reviewed rows alive while their loss stays ≥ 3 (hysteresis) is
 * the caller's job: it puts them in `keepIds`.
 */
export async function reconcileMistakes(profileId: string, keepIds: ReadonlySet<string>): Promise<{ deleted: number; dormant: number }> {
  const db = getDb();
  return db.transaction('rw', db.mistakes, db.reviews, async () => {
    const [rows, reviews] = await Promise.all([
      db.mistakes.where('profileId').equals(profileId).toArray(),
      db.reviews.where('profileId').equals(profileId).primaryKeys(),
    ]);
    const reviewed = new Set<string>(reviews);
    const toDelete: string[] = [];
    const toDormant: Mistake[] = [];
    for (const m of rows) {
      if (keepIds.has(m.id)) continue;
      if (!hasHistory(m, reviewed)) toDelete.push(m.id);
      else if (!m.dormant) toDormant.push({ ...m, dormant: true });
    }
    await db.mistakes.bulkDelete(toDelete);
    await db.mistakes.bulkPut(toDormant);
    return { deleted: toDelete.length, dormant: toDormant.length };
  });
}

export type MistakePatch = Partial<Pick<Mistake, 'status' | 'ignoreReason' | 'snoozedUntil' | 'acceptable'>>;

/** Applies a user decision; `undefined` values remove the field (e.g. un-snooze). */
export async function patchMistake(id: string, patch: MistakePatch, now: number = Date.now()): Promise<void> {
  await getDb().mistakes.update(id, { ...patch, updatedAt: now });
}

// ── Reviews and attempts ──────────────────────────────────────────────────

export function getReviews(profileId: string): Promise<ReviewState[]> {
  return getDb().reviews.where('profileId').equals(profileId).toArray();
}

export async function putReview(r: ReviewState): Promise<void> {
  await getDb().reviews.put(r);
}

export async function addAttempt(a: Attempt): Promise<void> {
  const { id: _auto, ...row } = a;
  await getDb().attempts.add(row);
}

/** A graded card: the new review state and the attempt, written together. */
export async function saveGrade(r: ReviewState, a: Attempt): Promise<void> {
  const db = getDb();
  await db.transaction('rw', db.reviews, db.attempts, async () => {
    await putReview(r);
    await addAttempt(a);
  });
}

/** The profile's attempts (oldest first), optionally only those at or after `sinceMs`. */
export async function getAttempts(profileId: string, sinceMs?: number): Promise<Attempt[]> {
  const rows = await getDb().attempts.where('profileId').equals(profileId).toArray();
  const kept = sinceMs === undefined ? rows : rows.filter(a => a.at >= sinceMs);
  return kept.sort((a, b) => a.at - b.at);
}

/** Row counts per table (diagnostics). */
export async function tableCounts(): Promise<Record<string, number>> {
  const db = getDb();
  const entries = await Promise.all(db.allTables().map(async t => [t.name, await t.count()] as const));
  return Object.fromEntries(entries);
}
