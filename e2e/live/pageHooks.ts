// Code that runs inside the app's page (installed with page.addInitScript before the app starts).
// It must be self-contained: Playwright serialises the function, so nothing outside it is in scope.
// - window.__liveEngine counts Stockfish workers and searches (real pool size and engine busy time).
// - window.__liveDb reads the app's IndexedDB ('chess-analyzer') without Dexie.
import type { Mistake, Profile, Settings, SyncState } from '../../src/core/types';

export interface EngineStats {
  /** Engine workers constructed / alive now / most alive at once (= the pool size actually used). */
  created: number;
  alive: number;
  maxAlive: number;
  /** `go` commands sent. */
  searches: number;
  /** Searches running right now (across workers). */
  active: number;
  /** Total wall time with at least one search running (closed intervals only). */
  busyMs: number;
  busySince: number;
  firstGoAt: number;
  lastBestmoveAt: number;
}

export interface PipelineStatus {
  profileId: string | null;
  profileCreatedAt?: number;
  lastSyncAt?: number;
  lastAnalysisAt?: number;
  /** A job record exists (sync/analysis running, or interrupted). */
  jobRunning: boolean;
  /** The store's "last analysis completed with these settings" marker. */
  analysisComplete: boolean;
  games: number;
  mistakes: number;
}

export interface GameCounts {
  total: number;
  byPlatform: Record<string, number>;
  byColor: Record<string, number>;
  bySpeed: Record<string, number>;
}

export interface PipelineResults {
  profile: Profile;
  games: GameCounts;
  syncStates: SyncState[];
  mistakes: Mistake[];
  evals: number;
  settings: Partial<Settings> | null;
}

export interface LiveDb {
  ready(): Promise<boolean>;
  setGamesPerAccount(n: number): Promise<boolean>;
  status(): Promise<PipelineStatus>;
  results(profileId: string): Promise<PipelineResults | null>;
}

export interface LiveWindow {
  __liveEngine: EngineStats;
  __liveDb: LiveDb;
}

export function installPageHooks(): void {
  const DB_NAME = 'chess-analyzer';
  const w = window as unknown as LiveWindow;

  // ── Engine workers ──
  const stats: EngineStats = { created: 0, alive: 0, maxAlive: 0, searches: 0, active: 0, busyMs: 0, busySince: 0, firstGoAt: 0, lastBestmoveAt: 0 };
  w.__liveEngine = stats;
  const searchStarted = (): void => {
    stats.searches++;
    if (stats.firstGoAt === 0) stats.firstGoAt = Date.now();
    if (stats.active++ === 0) stats.busySince = Date.now();
  };
  const searchEnded = (): void => {
    stats.lastBestmoveAt = Date.now();
    if (--stats.active === 0) stats.busyMs += Date.now() - stats.busySince;
  };
  const track = (worker: Worker): void => {
    stats.created++;
    stats.maxAlive = Math.max(stats.maxAlive, ++stats.alive);
    let searching = false;
    let alive = true;
    const post = worker.postMessage.bind(worker) as (message: unknown, ...rest: unknown[]) => void;
    worker.postMessage = ((message: unknown, ...rest: unknown[]) => {
      if (typeof message === 'string' && message.startsWith('go') && !searching) {
        searching = true;
        searchStarted();
      }
      post(message, ...rest);
    }) as Worker['postMessage'];
    worker.addEventListener('message', (e: MessageEvent) => {
      if (searching && typeof e.data === 'string' && e.data.startsWith('bestmove')) {
        searching = false;
        searchEnded();
      }
    });
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      if (searching) searchEnded();
      searching = false;
      if (alive) stats.alive--;
      alive = false;
      terminate();
    };
  };
  window.Worker = new Proxy(window.Worker, {
    construct(target, args: [string | URL, WorkerOptions?]) {
      const worker = Reflect.construct(target, args) as Worker;
      if (String(args[0]).includes('stockfish')) track(worker);
      return worker;
    },
  });

  // ── IndexedDB ──
  const request = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  /** The app's database, or null while the app has not created it (never creates it itself). */
  const openDb = async (): Promise<IDBDatabase | null> => {
    const known = await indexedDB.databases().catch(() => [] as IDBDatabaseInfo[]);
    if (!known.some(d => d.name === DB_NAME)) return null;
    return new Promise(resolve => {
      const req = indexedDB.open(DB_NAME);
      req.onupgradeneeded = () => req.transaction?.abort();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e: Event) => {
        e.preventDefault();
        resolve(null);
      };
      req.onblocked = () => resolve(null);
    });
  };

  const withDb = async <T>(fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    const db = await openDb();
    if (!db) return fallback;
    try {
      if (!['meta', 'profiles', 'games', 'mistakes'].every(s => db.objectStoreNames.contains(s))) return fallback;
      return await fn(db);
    } finally {
      db.close();
    }
  };

  const store = (db: IDBDatabase, name: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore => db.transaction(name, mode).objectStore(name);
  const metaValue = async (db: IDBDatabase, key: string): Promise<unknown> =>
    ((await request(store(db, 'meta').get(key))) as { value?: unknown } | undefined)?.value;
  const selfProfile = async (db: IDBDatabase): Promise<Profile | undefined> =>
    ((await request(store(db, 'profiles').getAll())) as Profile[]).find(p => p.kind === 'self');

  const tally = (counts: Record<string, number>, key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  w.__liveDb = {
    ready: () => withDb(false, async () => true),

    setGamesPerAccount: n =>
      withDb(false, async db => {
        const settings = ((await metaValue(db, 'settings')) ?? {}) as Partial<Settings>;
        await request(store(db, 'meta', 'readwrite').put({ key: 'settings', value: { ...settings, gamesPerAccount: n } }));
        return true;
      }),

    status: () =>
      withDb<PipelineStatus>({ profileId: null, jobRunning: false, analysisComplete: false, games: 0, mistakes: 0 }, async db => {
        const self = await selfProfile(db);
        const jobRunning = (await metaValue(db, 'job')) !== undefined;
        if (!self) return { profileId: null, jobRunning, analysisComplete: false, games: 0, mistakes: 0 };
        return {
          profileId: self.id,
          profileCreatedAt: self.createdAt,
          lastSyncAt: self.lastSyncAt,
          lastAnalysisAt: self.lastAnalysisAt,
          jobRunning,
          analysisComplete: (await metaValue(db, `analysisKey:${self.id}`)) !== undefined,
          games: await request(store(db, 'games').index('profileId').count(self.id)),
          mistakes: await request(store(db, 'mistakes').index('profileId').count(self.id)),
        };
      }),

    results: profileId =>
      withDb<PipelineResults | null>(null, async db => {
        const profile = (await request(store(db, 'profiles').get(profileId))) as Profile | undefined;
        if (!profile) return null;
        const games = { total: 0, byPlatform: {}, byColor: {}, bySpeed: {} } as GameCounts;
        const rows = (await request(store(db, 'games').index('profileId').getAll(profileId))) as { platform: string; color: string; speed: string }[];
        for (const g of rows) {
          games.total++;
          tally(games.byPlatform, g.platform);
          tally(games.byColor, g.color);
          tally(games.bySpeed, g.speed);
        }
        return {
          profile,
          games,
          syncStates: (await request(store(db, 'syncState').index('profileId').getAll(profileId))) as SyncState[],
          mistakes: (await request(store(db, 'mistakes').index('profileId').getAll(profileId))) as Mistake[],
          evals: await request(store(db, 'evals').count()),
          settings: ((await metaValue(db, 'settings')) ?? null) as Partial<Settings> | null,
        };
      }),
  };
}
