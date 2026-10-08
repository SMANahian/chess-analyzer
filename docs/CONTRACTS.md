# Module contracts

Implementation agents code against these signatures; `src/core/types.ts` holds the shared types and
`docs/ARCHITECTURE.md` the algorithms. If you must change a signature, update this file and every
consumer. Library facts were verified in `CHEATSHEET.md` (path given in your task) — read it.

Conventions
- **Standard UCI** everywhere (`e1g1`, `e7e8q`). chessops encodes castling as king→rook (`e1h1`)
  internally and `castlingSide()` treats *any* king move onto an own piece as castling (so
  `pos.isLegal(parseUci('e1e2'))` is true whenever O-O is legal). Always go through
  `parseStandardUci` / `toStandardUci` in `core/chess.ts`; never trust raw `isLegal` for external input.
- Scores are **side-to-move POV at the analysed root**. The UI presents them from the *user's* side.
- Position key = `makeFen(pos.toSetup(), { epd: true })` (ep square only when a legal capture exists).
- Long operations accept an `AbortSignal` and reject with a `DOMException` named `AbortError`.
- Network functions accept `fetchImpl?: typeof fetch` for tests. Never set conditional request headers
  (If-None-Match etc.) on cross-origin requests — they trigger CORS preflights that fail.
- Use deep chessops imports (`chessops/chess`, `/fen`, `/san`, `/util`, `/compat`, `/types`).
- Board UI package is **`@lichess-org/chessground` 10.x** (the unscoped `chessground` package is
  deprecated). Check its bundled `.d.ts` for API differences from the 9.x notes in the cheat sheet.
- Pure modules (`src/core/**`) must not touch DOM, IndexedDB, fetch, timers or `Date.now()` — pass `now`.

## core

### core/chess.ts
```ts
export const START_FEN: string;
export function posFromFen(fen: string): Chess | undefined;          // never throws
export function posKey(pos: Position): string;
export function fenOf(pos: Position): string;
export function turnColor(pos: Position): Color;
export function parseStandardUci(pos: Position, uci: string): NormalMove | undefined; // accepts e1g1 / e1h1, guarded, legal only
export function toStandardUci(pos: Position, move: Move): string;     // call BEFORE pos.play(move)
export function normalizeUci(fen: string, uci: string): string | undefined;
export function sanOf(fen: string, uci: string): string;             // '' if illegal
export function lineToSan(fen: string, ucis: readonly string[]): string[];   // stops at first illegal move
export function sansToUci(sans: readonly string[], maxPlies: number): string[]; // from start, tolerant (0-0, !?), truncates at first illegal
export function formatLine(sans: readonly string[], startFen?: string): string; // "1. e4 e5 2. Nf3", "5... Nc6 6. O-O"
export function playUci(fen: string, uci: string): string | undefined;          // FEN after the move
export interface ReplayStep { ply: number; key: string; fen: string; uci: string; turn: Color; }
/** Steps BEFORE each move, from the standard start. Stops at the first illegal move. */
export function replay(ucis: readonly string[], maxPlies: number, wantFen?: boolean): ReplayStep[];
export function groundDests(pos: Position): Map<SquareName, SquareName[]>;    // for chessground (both castling encodings)
export function moveFromGround(pos: Position, orig: SquareName, dest: SquareName, promotion?: Role): string | undefined; // → standard UCI
export function needsPromotion(pos: Position, orig: SquareName, dest: SquareName): boolean;
export function sanToUciAt(fen: string, san: string): string | undefined;     // typed SAN input in training
export function materialBalance(pos: Position): number;                       // white − black, pawns=1 N/B=3 R=5 Q=9
```

### core/hash.ts
```ts
export function fnv1a64(s: string): string;    // 16 hex chars
export function shortId(posKey: string, move: string): string; // first 10 hex of fnv1a64(posKey + '|' + move)
```

### core/pgn.ts  (fast extractor — 7× faster than chessops PgnParser, verified identical output)
```ts
export interface PgnGame { headers: Record<string, string>; sans: string[]; plyCount: number; }
export function parsePgnText(text: string, maxPlies: number): Generator<PgnGame>; // tolerant: comments, variations, NAGs, BOM, CRLF, '0-0'
export class PgnStreamSplitter { push(chunk: string): string[]; flush(): string[]; } // whole-game texts, for huge files
export function scanPgnNames(text: string, limit?: number): { name: string; games: number }[]; // most frequent White/Black names (header-only scan)
export function speedFromTimeControl(tc: string | undefined): Speed;   // est = base + 40·inc: <30 ultraBullet, <180 bullet, <480 blitz, <1500 rapid, else classical; '1/n' or '-'(daily) → correspondence
export function resultFromHeader(r: string | undefined): GameResult;
export function pgnDate(headers: Record<string, string>): number;      // UTCDate+UTCTime, else Date; 0 if unknown
export function pgnGameToRaw(g: PgnGame): RawGame | null;
// null for: Variant header other than Standard/'From Position' with standard FEN, a FEN header whose EPD
// != standard start EPD, no legal moves. Platform detection from Site/Link:
//   lichess.org/<8 chars>[...]           → platform 'lichess', sourceId = id
//   chess.com/game/(live|daily)/<digits> → platform 'chesscom', sourceId = 'live/123' | 'daily/123'
//   otherwise 'pgn', sourceId = fnv1a64(White|Black|Date|UTCTime|first 40 SAN)
```

### core/games.ts
```ts
export function contentKey(raw: Pick<RawGame, 'white' | 'black' | 'playedAt' | 'moves'>): string;
// `${white.toLowerCase()}|${black.toLowerCase()}|${YYYY-MM-DD (UTC) or '?'}|${moves.join(' ')}`
export function outcomeFor(result: GameResult, color: Color): Outcome;
/** Attribute a raw game to a profile. `account` = the account that was queried (API games), or undefined for PGN.
 *  API games: match account username against whiteId/blackId (or names), case-insensitive — nothing else.
 *  PGN games (or no account): match profile aliases and all account usernames against White/Black names.
 *  Returns null with a reason when neither or both sides match. */
export function attribute(raw: RawGame, profile: Profile, account?: Account):
  { color: Color } | { color: null; reason: 'no-match' | 'both-match' };
export function toStoredGame(raw: RawGame, profileId: string, color: Color): StoredGame;
```

### core/winrate.ts
```ts
export const THRESHOLDS: { readonly inaccuracy: 5; readonly mistake: 10; readonly blunder: 15 };
export const LOW_CONFIDENCE_BELOW = 7.5;
export function winPercent(s: Score): number;        // cp clamped ±1000; mate>0 → 100, mate<0 → 0, mate 0 → 0
export function compareScores(a: Score, b: Score): number;   // >0 if a better for side to move
export function winLoss(best: Score, played: Score): number; // max(0, …)
export function severityOf(loss: number, best?: Score, played?: Score): Severity | null; // implements the mate rule
export function negateScore(s: Score): Score;
export function formatScore(s: Score): string;       // side-to-move POV "+0.35", "−1.20", "#3", "#−2"
export function scoreForColor(s: Score, sideToMove: Color, viewer: Color): Score; // re-POV for display
export function describeLoss(loss: number): string;  // "≈1.1 pawns" style helper for UI copy
```

### core/openings.ts
```ts
export interface OpeningName { eco: string; name: string; }
export class OpeningBook {
  static fromJson(json: { entries: [string, string, string][] }): OpeningBook;
  lookup(key: string): OpeningName | undefined;
  has(key: string): boolean;
  nameForKeys(keys: readonly string[]): OpeningName | undefined;   // deepest (last) match
  readonly size: number;
}
export function loadOpeningBook(url?: string, fetchImpl?: typeof fetch): Promise<OpeningBook>; // default `${BASE}data/openings.json`, memoised
```

### core/aggregate.ts
```ts
export interface PositionStat {
  key: string; fen: string; ply: number; color: Color;
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
export interface Candidate { key: string; fen: string; ply: number; color: Color;
  /** Every move ever played here (count ≥ 1) — all are evaluated. */
  moves: string[];
  /** Moves with ≥ minGames games — the only ones that can become mistakes. */
  recurring: string[];
  weight: number; stat: PositionStat; }
export class Aggregator {
  constructor(opts: { openingPlies: number; minGames?: number /* default ANALYSIS_MIN_GAMES */ });
  /** Pass 1 — call for every game (in chunks; caller yields to the event loop between chunks). */
  count(games: readonly StoredGame[]): void;
  /** Pass 2 — call again for every game, after all count() calls. */
  detail(games: readonly StoredGame[]): void;
  candidates(): Candidate[];               // weight desc, then key
  readonly gamesCounted: number;
}
/** Convenience for tests / small inputs. */
export function aggregate(games: readonly StoredGame[], opts: { openingPlies: number; minGames?: number }): Candidate[];
```

### core/classify.ts
```ts
export function moveEval(ev: PositionEval, uci: string): LineEval | undefined;
export function bestOf(ev: PositionEval): LineEval;            // highest-scoring among best + moves
export function acceptableMoves(ev: PositionEval, exclude?: string): string[];  // loss < 5
export function impactOf(occ: readonly Occurrence[], move: string, loss: number, now: number): number;
// Σ_{o ∈ occ, o.m === move} 0.5^((now − o.t) / (180 days)) × max(0, loss − 2.5)
export function lastOutcomeOf(occ: readonly Occurrence[], move: string, acceptable: readonly string[]): { lastOutcome: LastOutcome; fixedStreak: number };
export function classifyCandidate(c: Candidate, ev: PositionEval, opts: {
  profileId: string; book?: OpeningBook; now: number; minLoss?: number /* ANALYSIS_MIN_LOSS */;
}): Mistake[];   // status 'active', createdAt = updatedAt = now; one per recurring move with loss ≥ minLoss
export function linkDependencies(ms: Mistake[]): void;       // sets dependsOn (mutates)
```

### core/filters.ts
```ts
export interface ViewMistake extends Mistake { viewCount: number; viewPositionCount: number; viewImpact: number; }
export function applyFilters(ms: readonly Mistake[], f: ViewFilters, now: number): ViewMistake[]; // sorted per f.sort; drops status ≠ active and snoozed (snoozedUntil > now) and dormant
export function filterOccurrences(occ: readonly Occurrence[], f: ViewFilters): Occurrence[];
export function openingsSummary(games: readonly StoredGame[], book: OpeningBook, openingPlies: number):
  { color: Color; eco: string; name: string; games: number; score: number /* 0..1 */; }[];
```

### core/srs.ts
```ts
export function newReview(mistakeId: string, profileId: string, now: number): ReviewState; // due = now
export function gradeReview(r: ReviewState, grade: Grade, now: number): ReviewState;
// again: interval 0, due now+10min, lapses+1, ease−0.2 (min 1.3) | hard: interval max(1, interval·1.2) days, ease−0.15
// good: reps 0 → 1 d, reps 1 → 3 d, else interval·ease | easy: (good interval)·1.3, ease+0.15
export function isDue(r: ReviewState | undefined, now: number): boolean;
export type AttemptOutcome = 'correct' | 'low-confidence' | 'habit' | 'wrong';
export function autoGrade(a: { outcome: AttemptOutcome; tries: number; hinted: boolean; previous?: ReviewState }): Grade;
```

### core/explain.ts
```ts
/** Material change for the side that played line[0] after playing out `line` (≤ 6 plies) from fen. */
export function materialSwing(fen: string, line: readonly string[], plies?: number): number;
export function explainLine(fen: string, line: readonly string[]): string;  // "loses a pawn", "drops the knight", "allows mate", ""
```

### core/pgnExport.ts
```ts
/** One PGN game per mistake: best move as mainline, habit move as a variation with refutation, comments with stats. */
export function mistakesToPgn(ms: readonly Mistake[], opts: { profileName: string; now: number }): string;
```

## sources

### sources/http.ts
```ts
export class SourceError extends Error { kind: SourceErrorKind; status?: number; retryAfterMs?: number; }
export function fetchWithRetry(url: string, init?: RequestInit & { retries?: number; fetchImpl?: typeof fetch }): Promise<Response>;
// 5xx / network → retry with backoff 1 s, 2 s, 4 s; 404 → SourceError('not-found'); 429 → SourceError('rate-limited', retryAfterMs ≥ 60 s); abort → AbortError
export function readNdjson(res: Response, opts?: { signal?: AbortSignal; idleTimeoutMs?: number /* 45 s */ }): AsyncGenerator<unknown>;
export function lichessCooldownUntil(): number;        // from localStorage (0 when unavailable)
export function setLichessCooldown(untilMs: number): void;
```

### sources/lichess.ts
```ts
export interface LichessPage { since?: number; until?: number; max?: number; sort: 'dateAsc' | 'dateDesc'; }
export function fetchLichessGames(username: string, page: LichessPage, opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch }): AsyncGenerator<{ raw: RawGame | null; createdAt: number }>;
// yields every received game (raw null if skipped: variant, thematic initialFen, aborted/noStart, no moves) so the caller can advance cursors
export function lichessJsonToRaw(json: unknown): RawGame | null;
export function lichessUser(username: string, opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<{ id: string; username: string; games?: number; closed?: boolean } | null>;
```

### sources/chesscom.ts
```ts
export function chesscomArchives(username: string, opts?): Promise<string[]>;    // oldest → newest URLs
export function fetchChesscomArchive(url: string, opts?): Promise<{ games: RawGame[]; skipped: number; endTimes: number[] }>;
export function chesscomJsonToRaw(game: unknown): RawGame | null;               // rules === 'chess', standard start only
export function chesscomUser(username: string, opts?): Promise<{ username: string; closed?: boolean } | null>;
export function archiveMonth(url: string): { year: number; month: number } | null;
// Requests: one at a time, `cache: 'no-cache'`, lower-cased username in URLs.
```

### sources/pgnFile.ts
```ts
export function readPgnFile(input: Blob | string, opts?: { signal?: AbortSignal; onProgress?(doneBytes: number, totalBytes: number): void; maxPlies?: number }): AsyncGenerator<RawGame>;
export function scanPgnFileNames(input: Blob | string, limit?: number): Promise<{ name: string; games: number }[]>;
```

## engine

### engine/uci.ts
```ts
export interface InfoLine { depth?: number; seldepth?: number; multipv?: number; score?: Score; bound?: 'upper' | 'lower'; nodes?: number; nps?: number; timeMs?: number; pv?: string[]; }
export function parseInfo(line: string): InfoLine | null;
export function parseBestMove(line: string): { best: string | null; ponder?: string } | null;  // 'bestmove (none)' → best null
```

### engine/engine.ts
```ts
export const ENGINE_FILE = 'stockfish-19-lite-single.js';
export const ENGINE_ID = 'sf19-lite@1';           // bump the suffix to invalidate cached evals
export interface EngineWorkerLike { postMessage(msg: string): void; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null; terminate(): void; }
export interface SearchParams { fen: string; depth: number; searchMoves?: string[]; signal?: AbortSignal; }
export interface SearchResult { line: LineEval; nodes: number; timeMs: number; }
export class UciEngine {
  constructor(worker: EngineWorkerLike, opts?: { hashMb?: number; initTimeoutMs?: number });
  init(): Promise<void>;                             // uci → uciok, Hash, isready → readyok; rejects on timeout with a diagnostic
  newGame(): Promise<void>;                          // ucinewgame + isready
  search(p: SearchParams): Promise<SearchResult>;    // MultiPV 1; serialised; watchdog; asserts pv[0] ∈ searchMoves when given
  terminate(): void;
  readonly alive: boolean;
}
export function createStockfishWorker(baseUrl?: string): Worker;  // new Worker(`${baseUrl ?? import.meta.env.BASE_URL}engine/${ENGINE_FILE}`)
```

### engine/pool.ts
```ts
export function defaultPoolSize(env?: { hardwareConcurrency?: number; deviceMemory?: number; coarsePointer?: boolean }): number;
export type Priority = 'background' | 'interactive';
export class EnginePool {
  constructor(opts: { size: number; createWorker: () => EngineWorkerLike; hashMb?: number; idleMs?: number /* 60 s */ });
  readonly size: number;
  /** newGame, best-move search, then one searchmoves search per move in `moves` that is not the best move. */
  evaluatePosition(fen: string, moves: readonly string[], opts: { depth: number; signal?: AbortSignal; priority?: Priority }): Promise<PositionEval>;
  readonly busyCount: number;
  terminate(): void;
}
```

### engine/nodeWorker.ts  (tests and scripts only; never imported by the app bundle)
```ts
/** Runs public/engine/stockfish-19-lite-single.js as a Node child process speaking UCI over stdio. */
export function createNodeEngineWorker(): EngineWorkerLike;
```

## db

### db/schema.ts
```ts
export class AppDB extends Dexie { profiles; games; syncState; evals; mistakes; reviews; attempts; meta; }
export function getDb(): AppDB;                 // singleton 'chess-analyzer'
export function useTestDb(name?: string): AppDB; // fresh db for tests (fake-indexeddb)
```

### db/repo.ts
```ts
export function getSettings(): Promise<Settings>;                       // merged with DEFAULT_SETTINGS
export function saveSettings(patch: Partial<Settings>): Promise<Settings>;
export function getMeta<T>(key: string): Promise<T | undefined>;
export function setMeta<T>(key: string, value: T): Promise<void>;
export function listProfiles(): Promise<Profile[]>;
export function getProfile(id: string): Promise<Profile | undefined>;
export function createProfile(p: Omit<Profile, 'id' | 'createdAt'>): Promise<Profile>;
export function updateProfile(id: string, patch: Partial<Profile>): Promise<void>;
export function deleteProfile(id: string): Promise<void>;               // cascades games, syncState, mistakes, reviews, attempts
/** Insert-only: skips keys that exist and games whose contentKey already exists for the profile.
 *  Optionally writes a SyncState in the same transaction. Returns the number added. */
export function addGames(games: readonly StoredGame[], sync?: SyncState): Promise<number>;
export function getGames(profileId: string): Promise<StoredGame[]>;
export function countGames(profileId: string): Promise<number>;
export function getGamesByKeys(keys: readonly string[]): Promise<StoredGame[]>;
export function getSyncStates(profileId: string): Promise<SyncState[]>;
export function putSyncState(s: SyncState): Promise<void>;
export function getEvals(keys: readonly string[]): Promise<Map<string, PositionEval>>;  // keys = `${engine}|${posKey}`
export function putEval(ev: PositionEval): Promise<void>;
export function getMistakes(profileId: string): Promise<Mistake[]>;
export function getMistakeByShortId(shortId: string): Promise<Mistake | undefined>;
/** Merge analysis output: preserves status, ignoreReason, snoozedUntil, createdAt of existing rows. */
export function upsertMistakes(ms: readonly Mistake[]): Promise<void>;
/** After a COMPLETE analysis: rows not in `keepIds` → deleted if they have no review, else dormant
 *  (reviewed rows are kept active only while loss ≥ 3 — hysteresis handled by the caller). */
export function reconcileMistakes(profileId: string, keepIds: ReadonlySet<string>): Promise<{ deleted: number; dormant: number }>;
export function patchMistake(id: string, patch: Partial<Pick<Mistake, 'status' | 'ignoreReason' | 'snoozedUntil' | 'acceptable'>>): Promise<void>;
export function getReviews(profileId: string): Promise<ReviewState[]>;
export function putReview(r: ReviewState): Promise<void>;
export function addAttempt(a: Attempt): Promise<void>;
export function getAttempts(profileId: string, sinceMs?: number): Promise<Attempt[]>;
```

### db/backup.ts
```ts
export interface BackupFile { app: 'chess-analyzer'; version: 3; exportedAt: number; profiles: Profile[]; games: StoredGame[]; syncState: SyncState[]; mistakes: Mistake[]; reviews: ReviewState[]; attempts: Attempt[]; settings: Settings; evals?: PositionEval[]; }
export function exportBackup(opts?: { includeEvals?: boolean }): Promise<BackupFile>;
export function importBackup(data: unknown): Promise<{ profiles: number; games: number; mistakes: number }>; // validates; one rw transaction over all tables; v3 or legacy v2 (backup_version 2)
export function clearAllData(): Promise<void>;
```

## services

### services/sync.ts
```ts
export interface SyncOptions { signal?: AbortSignal; onProgress?(p: SyncProgress): void; fetchImpl?: typeof fetch; now?: () => number;
  /** Cap this run per account (first-run fast pass = 300); defaults to settings.gamesPerAccount. */ limit?: number; }
export function syncProfile(profileId: string, opts?: SyncOptions): Promise<{ added: number; unmatched: number; errors: { account: Account; kind: SourceErrorKind; message: string }[] }>;
export function importPgnIntoProfile(profileId: string, input: Blob | string, opts?: { signal?: AbortSignal; onProgress?(p: SyncProgress): void; asColor?: Color }): Promise<{ added: number; skipped: number; unmatched: number }>;
```

### services/scheduler.ts
```ts
export interface EvalTask { key: string; fen: string; moves: string[]; weight: number; }
export type EvalOrigin = 'cache' | 'engine';
export function evaluateAll(tasks: readonly EvalTask[], deps: {
  pool: Pick<EnginePool, 'evaluatePosition' | 'size'>;
  getCached(keys: readonly string[]): Promise<Map<string, PositionEval>>;  // by `${engine}|${posKey}`
  putCached(ev: PositionEval): Promise<void>;
  engine: string; triageDepth: number; confirmDepth: number; signal?: AbortSignal;
  onResult(task: EvalTask, ev: PositionEval, origin: EvalOrigin): void | Promise<void>;
}): Promise<void>;
// Highest weight first, pool.size tasks in flight. Cache hit = covers all task.moves and
// (depth ≥ confirmDepth or (depth ≥ triageDepth and every move's loss vs best < 2.5)).
// Otherwise evaluate at triageDepth; if some move loses ≥ 2.5, re-evaluate at confirmDepth. Each eval is cached as it completes.
```

### services/analysis.ts
```ts
export interface AnalysisDeps { pool: EnginePool; book?: OpeningBook; signal?: AbortSignal; now?: () => number;
  onProgress?(p: AnalysisProgress): void; onMistakes?(ms: Mistake[]): void; }
export function analyzeProfile(profileId: string, deps: AnalysisDeps): Promise<{ mistakes: number; positions: number; complete: boolean }>;
// aggregate in chunks with yields → candidates → evaluateAll → classify per result (batched upserts ~300 ms)
// → on completion linkDependencies + reconcileMistakes; opponent profiles: then evaluate each mistake's after-move position for `refutation`.
export function presetDepths(s: Settings): { triage: number; confirm: number };  // quick 8/10, standard 10/14, thorough 12/18; depthOverride sets confirm
```

### services/training.ts
```ts
export interface SessionCard { mistake: Mistake; review?: ReviewState; isNew: boolean; }
export function buildSession(ms: readonly Mistake[], reviews: readonly ReviewState[], now: number, opts: { size: number; newToday: number; newPerDay: number; filters?: Partial<ViewFilters> }): SessionCard[];
export type MoveVerdict = { kind: 'correct'; best: boolean } | { kind: 'low-confidence'; loss: number } | { kind: 'habit' } | { kind: 'wrong'; loss: number } | { kind: 'unknown' };
export function judgeMove(m: Mistake, uci: string, ev?: PositionEval): MoveVerdict;
export function evaluateTrainingMove(pool: EnginePool, m: Mistake, uci: string, depth: number, signal?: AbortSignal): Promise<MoveVerdict>; // interactive priority; caches + updates acceptable
export function recordGrade(card: SessionCard, grade: Grade, now: number): Promise<ReviewState>;   // persists review + attempt
```

### services/jobs.ts
```ts
/** Runs fn while holding the cross-tab job lock; returns null (without running) if another tab holds it. */
export function withJobLock<T>(fn: () => Promise<T>): Promise<T | null>;
export function onJobBroadcast(cb: (msg: { type: 'job-done' | 'job-started'; profileId: string }) => void): () => void;
export function broadcastJob(msg: { type: 'job-done' | 'job-started'; profileId: string }): void;
export function holdWakeLock(): Promise<() => void>;          // no-op when unsupported
export function requestPersistentStorage(): Promise<boolean>;
```

## state (signals; the only API the UI uses besides pure core helpers)

### state/store.ts
**The stub file `src/state/store.ts` in the repo is the authoritative contract** (it typechecks and
the UI is written against it); it supersedes the sketch below where they differ. Training goes through
`startSession` / `submitMove` / `gradeCard`; the UI never touches the engine pool directly.
```ts
export const ready: Signal<boolean>;
export const settings: Signal<Settings>;
export const filters: Signal<ViewFilters>;               // persisted to localStorage
export const selfProfile: ReadonlySignal<Profile | null>;
export const scoutProfiles: ReadonlySignal<Profile[]>;
export const profiles: Signal<Profile[]>;
export const mistakes: Signal<Mistake[]>;                 // self profile, all statuses
export const visibleMistakes: ReadonlySignal<ViewMistake[]>; // applyFilters(mistakes, filters)
export const reviews: Signal<Map<string, ReviewState>>;
export const games: Signal<StoredGame[]>;                 // self profile (for stats/openings)
export const syncProgress: Signal<SyncProgress | null>;
export const analysisProgress: Signal<AnalysisProgress | null>;
export const busy: ReadonlySignal<boolean>;
export const otherTabBusy: Signal<boolean>;
export const notice: Signal<{ kind: 'info' | 'error' | 'success'; text: string; action?: { label: string; run(): void } } | null>;
export const updateAvailable: Signal<null | (() => void)>;  // call to apply a PWA update

export function init(): Promise<void>;                     // loads db, settings; auto-sync when due; deep links (#/?lichess=..&chesscom=..)
export function setupSelf(accounts: Account[]): Promise<Profile>;   // validates accounts exist, creates/updates the self profile, starts refresh()
export function addScout(input: { name?: string; accounts: Account[] }): Promise<Profile>;
export function removeProfile(id: string): Promise<void>;
export function refresh(profileId?: string): Promise<void>;  // sync then analyse; first run: 300 newest → analyse → backfill → analyse
export function analyze(profileId?: string): Promise<void>;
export function importPgn(file: Blob, opts: { aliases?: string[]; asColor?: Color; profileId?: string }): Promise<void>;
export function cancelJobs(): void;
export function setMistakeStatus(id: string, status: MistakeStatus, opts?: { reason?: 'repertoire' | 'other'; snoozeDays?: number }): Promise<void>;
export function updateSettings(patch: Partial<Settings>): Promise<void>;
export function setFilters(patch: Partial<ViewFilters>): void;
export function loadScout(profileId: string): Promise<{ profile: Profile; mistakes: Mistake[]; games: StoredGame[] }>;
export function getEnginePool(): EnginePool;
export function exportData(): Promise<Blob>;
export function importData(file: Blob): Promise<void>;
export function clearData(): Promise<void>;
export function loadDemo(): Promise<void>;                 // imports public/demo/demo.json as a demo self profile
export function diagnostics(): Promise<Record<string, unknown>>;
```

## ui
`index.html`, `src/main.tsx`, `src/ui/**`, styles. Hash routes: `#/` (onboarding or dashboard),
`#/leaks`, `#/leaks/<shortId>`, `#/train`, `#/openings`, `#/scout`, `#/scout/<profileId>`,
`#/settings`, `#/about`. Consumes `state/store.ts` and pure helpers from `core/*` only.
