// Cross-tab coordination and browser capabilities around long jobs: a Web Lock so only one tab syncs
// or analyses, a BroadcastChannel to tell the other tabs, a Screen Wake Lock, persistent storage.
// Everything degrades to a no-op (or "run directly") where the API is missing.

export const JOB_LOCK = 'chess-analyzer:jobs';
export const CHANNEL = 'chess-analyzer';

export interface JobMessage {
  type: 'job-done' | 'job-started';
  profileId: string;
}

interface LockManagerLike {
  request<T>(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<T>): Promise<T>;
  query?(): Promise<{ held?: { name?: string }[] }>;
}

function lockManager(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { locks?: LockManagerLike }).locks;
}

const HELD_ELSEWHERE: unique symbol = Symbol('held-elsewhere');

/**
 * Runs `fn` while holding the cross-tab job lock; returns null (without running it) if another tab
 * holds the lock. Not re-entrant: a nested call from inside `fn` also gets null. Without Web Locks
 * (old browsers, Node) `fn` simply runs.
 */
export async function withJobLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const locks = lockManager();
  if (!locks) return fn();
  const result = await locks.request<T | typeof HELD_ELSEWHERE>(JOB_LOCK, { ifAvailable: true }, async lock =>
    lock === null ? HELD_ELSEWHERE : fn(),
  );
  return result === HELD_ELSEWHERE ? null : result;
}

/**
 * Whether some tab (this one included) holds the job lock right now; null when that cannot be known
 * (no Web Locks, or no `query`). A tab that is closed, crashes or is discarded releases its locks, so
 * "not held" is reliable even when the tab never said its job was done.
 */
export async function queryJobLock(): Promise<boolean | null> {
  const locks = lockManager();
  if (!locks?.query) return null;
  try {
    const state = await locks.query();
    return state?.held?.some(l => l.name === JOB_LOCK) ?? false;
  } catch {
    return null;
  }
}

/** Whether some tab (this one included) holds the job lock right now; false when unknown. */
export async function isJobLockHeld(): Promise<boolean> {
  return (await queryJobLock()) ?? false;
}

// ── BroadcastChannel ──────────────────────────────────────────────────────

type Listener = (msg: JobMessage) => void;

let channel: BroadcastChannel | null | undefined;
const listeners = new Set<Listener>();

function isJobMessage(v: unknown): v is JobMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<JobMessage>;
  return (m.type === 'job-done' || m.type === 'job-started') && typeof m.profileId === 'string';
}

/** One channel per tab for both directions: a tab never hears its own messages. */
function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === 'undefined') return (channel = null);
  channel = new BroadcastChannel(CHANNEL);
  // Node (tests) would otherwise keep the process alive for an open channel.
  (channel as BroadcastChannel & { unref?(): void }).unref?.();
  channel.onmessage = (e: MessageEvent) => {
    if (!isJobMessage(e.data)) return;
    for (const cb of listeners) cb(e.data);
  };
  return channel;
}

/** Subscribes to job messages from other tabs; returns the unsubscribe function. */
export function onJobBroadcast(cb: Listener): () => void {
  getChannel();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function broadcastJob(msg: JobMessage): void {
  try {
    getChannel()?.postMessage(msg);
  } catch {
    // A closed channel (page unloading) is not worth an error.
  }
}

// ── Screen Wake Lock ──────────────────────────────────────────────────────

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

function wakeLockApi(): { request(type: 'screen'): Promise<WakeLockSentinelLike> } | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
}

/**
 * Keeps the screen on until the returned function is called. The browser drops the lock whenever the
 * page is hidden, so it is re-acquired when the page becomes visible again. No-op when unsupported or denied.
 */
export async function holdWakeLock(): Promise<() => void> {
  const api = wakeLockApi();
  if (!api || typeof document === 'undefined') return () => undefined;
  let sentinel: WakeLockSentinelLike | null = null;
  let released = false;
  const acquire = async (): Promise<void> => {
    try {
      const s = await api.request('screen');
      if (released) void s.release().catch(() => undefined);
      else sentinel = s;
    } catch {
      // denied (battery saver, hidden page): run without it
    }
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && !released) void acquire();
  };
  document.addEventListener('visibilitychange', onVisible);
  await acquire();
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisible);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}

// ── Persistent storage ────────────────────────────────────────────────────

/** Asks the browser not to evict our data; true when storage is (now) persistent. */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage?.persist) return false;
  try {
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
