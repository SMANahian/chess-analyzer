# Module contracts

An overview of each module's exported API: what it takes, what it returns and the rules callers rely
on. **The code is authoritative**; this file is an overview (each export's doc comment has the
details). `src/core/types.ts` holds the shared types and constants (`Profile`, `StoredGame`,
`PositionEval`, `Mistake`, `Settings`, `DEFAULT_SETTINGS`, `ViewFilters`, `DEFAULT_FILTERS`,
`MAX_STORED_PLIES` = 40, `ANALYSIS_MIN_GAMES` = 2, `ANALYSIS_MIN_LOSS` = 5, …), and
`docs/ARCHITECTURE.md` the algorithms. If you change a signature, update this file and every caller.

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
  deprecated).
- Pure modules (`src/core/**`) must not touch DOM, IndexedDB, fetch, timers or `Date.now()` — pass `now`.

## core

### core/chess.ts
```ts
export const START_FEN: string;
export function posFromFen(fen: string): Chess | undefined;          // never throws
export function posKey(pos: Position): string;
export function isStandardStartFen(fen: string): boolean;            // full FEN or EPD; Shredder castling allowed
export function fenOf(pos: Position): string;
export function turnColor(pos: Position): Color;
export function toStandardUci(pos: Position, move: Move): string;     // call BEFORE pos.play(move)
export function parseStandardUci(pos: Position, uci: string): NormalMove | undefined; // accepts e1g1 / e1h1, guarded, legal only
export function normalizeUci(fen: string, uci: string): string | undefined;
export function sanOf(fen: string, uci: string): string;             // '' if illegal
export function sanOfCached(fen: string, uci: string): string;       // sanOf memoised by fen|uci (cleared at 5,000 entries): hot paths such as the leak search
export function lineToSan(fen: string, ucis: readonly string[]): string[];   // stops at first illegal move
export function sansToUci(sans: readonly string[], maxPlies: number): string[]; // from start, tolerant (0-0, !?), truncates at first illegal
export function sanToUciAt(fen: string, san: string): string | undefined;     // typed SAN input in training
export function formatLine(sans: readonly string[], startFen?: string): string; // "1. e4 e5 2. Nf3", "5... Nc6 6. O-O"
export function playUci(fen: string, uci: string): string | undefined;          // FEN after the move
export interface ReplayStep { ply: number; key: string; fen: string; uci: string; turn: Color; }
/** Steps BEFORE each move, from the standard start. Stops at the first illegal move. */
export function replay(ucis: readonly string[], maxPlies: number, wantFen?: boolean): ReplayStep[];
export function groundDests(pos: Position): Map<SquareName, SquareName[]>;    // for chessground (both castling encodings)
export function needsPromotion(pos: Position, orig: SquareName, dest: SquareName): boolean;
export function moveFromGround(pos: Position, orig: SquareName, dest: SquareName, promotion?: Role): string | undefined; // → standard UCI
export function materialBalance(pos: Position): number;                       // white − black, pawns=1 N/B=3 R=5 Q=9
```

### core/hash.ts
```ts
export function fnv1a64(input: string): string;    // 16 hex chars
export function shortId(posKey: string, move: string): string; // first 10 hex of fnv1a64(posKey + '|' + move)
```

### core/pgn.ts  (fast extractor — 7× faster than chessops PgnParser, verified identical output)
```ts
export interface PgnGame { headers: Record<string, string>; sans: string[]; /* mainline, ≤ maxPlies */ plyCount: number; /* whole game */ }
/** Lone CR (classic Mac) → LF across chunks; CRLF untouched; a trailing CR waits for the next chunk. */
export class LoneCrNormalizer { push(chunk: string): string; flush(): string; }
/** Whole-game texts from a stream of chunks (huge files); line endings LF, CRLF or lone CR. */
export class PgnStreamSplitter { push(chunk: string): string[]; flush(): string[]; }
export function parsePgnGame(text: string, maxPlies?: number /* MAX_STORED_PLIES */): PgnGame; // one game's text
export function splitPgnGames(text: string): string[];
export function parsePgnText(text: string, maxPlies: number): Generator<PgnGame>; // tolerant: comments, variations, NAGs, BOM, CRLF, '0-0'
/** Counts White/Black names (case-insensitive, first spelling shown; self-play counts once). */
export class PgnNameCounter { add(text: string): void; top(limit?: number /* 10 */): { name: string; games: number }[]; }
export function scanPgnNames(text: string, limit?: number /* 10 */): { name: string; games: number }[]; // header-only scan
export function speedFromTimeControl(tc: string | undefined): Speed;   // est = base + 40·inc: <30 ultraBullet, <180 bullet, <480 blitz, <1500 rapid, else classical; '1/n' or '-' (daily) → correspondence
export function resultFromHeader(r: string | undefined): GameResult;
export function pgnDate(headers: Record<string, string>): number;      // UTCDate+UTCTime, else Date (+ UTCTime/Time); 0 if unknown or partial
export function pgnGameToRaw(g: PgnGame): RawGame | null;
// null for: a Variant other than Standard/Chess/Normal/'From Position', a FEN header that is not the
// standard start, no legal first move. Platform from Link, then Site:
//   lichess.org/<8 chars>[4 more]              → 'lichess', sourceId = the 8-char id (not routes like /analysis)
//   chess.com/game/(live|daily)/<n> (or /live/game/<n>, /analysis/…) → 'chesscom', sourceId = 'live/123' | 'daily/123'
//   otherwise 'pgn', sourceId = fnv1a64(White|Black|Date|UTCTime|first 40 SAN), url = an http(s) Link/Site if any
```

### core/games.ts
```ts
export type Attribution = { color: Color } | { color: null; reason: 'no-match' | 'both-match' };
export function contentKey(raw: Pick<RawGame, 'white' | 'black' | 'playedAt' | 'moves'>): string;
// `${white.toLowerCase()}|${black.toLowerCase()}|${YYYY-MM-DD (UTC) or '?'}|${moves.join(' ')}`
export function gameKey(profileId: string, raw: Pick<RawGame, 'platform' | 'sourceId'>): string; // `${profileId}|${platform}:${sourceId}` (StoredGame key)
export function outcomeFor(result: GameResult, color: Color): Outcome;
/** Attribute a raw game to a profile. `account` = the account that was queried (API games), or undefined for PGN.
 *  API games: the account username against whiteId/blackId, then against the names, case-insensitive — nothing else.
 *  PGN games (no account): profile aliases and all account usernames against White/Black names (and ids).
 *  Returns null with a reason when neither or both sides match. */
export function attribute(raw: RawGame, profile: Profile, account?: Account): Attribution;
export function toStoredGame(raw: RawGame, profileId: string, color: Color): StoredGame;
```

### core/winrate.ts
```ts
export const THRESHOLDS: { readonly inaccuracy: 5; readonly mistake: 10; readonly blunder: 15 };
export const LOW_CONFIDENCE_BELOW = 7.5;
export function winPercent(s: Score): number;        // cp clamped ±1000; mate>0 → 100, mate ≤ 0 → 0; a missing cp counts as 0
export function compareScores(a: Score, b: Score): number;   // >0 if a better for side to move
export function winLoss(best: Score, played: Score): number; // max(0, …)
export function severityOf(loss: number, best?: Score, played?: Score): Severity | null; // implements the mate rule
export function negateScore(s: Score): Score;
export function formatScore(s: Score): string;       // side-to-move POV "+0.35", "−1.20", "#3", "#−2"
export function scoreForColor(s: Score, sideToMove: Color, viewer: Color): Score; // re-POV for display
export function pawnsForLoss(loss: number): number;  // pawns that cost `loss` win-% from an equal position (5 → ≈0.55, 10 → ≈1.1; ≤ 10)
export function describeLoss(loss: number): string;  // "≈1.1 pawns" style helper for UI copy
```

### core/openings.ts
```ts
export interface OpeningName { eco: string; name: string; }
export interface OpeningsJson { entries: [string, string, string][]; }
export class OpeningBook {
  static fromJson(json: OpeningsJson): OpeningBook;   // malformed entries skipped; first duplicate wins
  lookup(key: string): OpeningName | undefined;       // a full FEN works too
  has(key: string): boolean;
  nameForKeys(keys: readonly string[]): OpeningName | undefined;   // deepest (last) match
  readonly size: number;
}
export function loadOpeningBook(url?: string, fetchImpl?: typeof fetch): Promise<OpeningBook>; // default `${BASE_URL}data/openings.json`, memoised; a failed load is forgotten
```

### core/aggregate.ts
```ts
export interface PositionStat {
  key: string; fen: string; ply: number; color: Color;
  /** Distinct games that reached this position with the profile to move. */
  games: number;
  /** Distinct-game count per move played here (the first visit of each game only, like occurrences). */
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
export interface AggregateOptions { openingPlies: number; minGames?: number /* ANALYSIS_MIN_GAMES */ }
// A position is a candidate when some move was played there in ≥ minGames games (not merely reached).
export class Aggregator {
  constructor(opts: AggregateOptions);
  /** Pass 1 — call for every game (in chunks; caller yields to the event loop between chunks). */
  count(games: readonly StoredGame[]): void;
  /** Pass 2 — call again for every game, after all count() calls. */
  detail(games: readonly StoredGame[]): void;
  candidates(): Candidate[];               // weight desc, then key
  readonly gamesCounted: number;
}
/** Convenience for tests / small inputs: both passes. */
export function aggregate(games: readonly StoredGame[], opts: AggregateOptions): Candidate[];
```

### core/classify.ts
```ts
export function moveEval(ev: PositionEval, uci: string): LineEval | undefined;
export function bestOf(ev: PositionEval): LineEval;            // highest-scoring among best + moves
export function acceptableMoves(ev: PositionEval, exclude?: string): string[];  // loss < 5, best first, never `exclude`
export function impactOf(occ: readonly Occurrence[], move: string, loss: number, now: number): number;
// Σ_{o ∈ occ, o.m === move} 0.5^((now − o.t) / 180 days) × max(0, loss − 2.5); future-dated visits count as new, undated (t ≤ 0) as one half-life old
export function lastOutcomeOf(occ: readonly Occurrence[], move: string, acceptable: readonly string[], evaluated?: readonly string[]):
  { lastOutcome: LastOutcome; fixedStreak: number };
export interface ClassifyOptions { profileId: string; book?: OpeningBook; now: number; minLoss?: number /* ANALYSIS_MIN_LOSS */ }
export function classifyCandidate(c: Candidate, ev: PositionEval, opts: ClassifyOptions): Mistake[];
// status 'active', createdAt = updatedAt = now; one per recurring move with loss ≥ minLoss (moves missing from the eval are skipped)
export function linkDependencies(ms: Mistake[]): void;       // sets dependsOn (mutates): nearest earlier mistake of the same profile and colour on the path
```

### core/filters.ts
```ts
export type { ViewMistake } from './types';   // Mistake + viewCount, viewPositionCount, viewImpact, habitScore, positionScore
export function meanScore(outcomes: Iterable<Outcome>): number | null;      // win 1, draw ½, loss 0; null when none known
export function filterOccurrences(occ: readonly Occurrence[], f: ViewFilters): Occurrence[]; // speed, rated, date filters
export function applyFilters(ms: readonly Mistake[], f: ViewFilters, now: number): ViewMistake[];
// sorted per f.sort; only status 'active', not dormant, not snoozed (snoozedUntil > now), and still
// played in ≥ minGames of the filtered games; the text search uses sanOfCached
export interface OpeningSummaryRow { color: Color; eco: string; name: string; games: number; score: number /* 0..1 */ }
export function openingsSummary(games: readonly StoredGame[], book: OpeningBook, openingPlies: number): OpeningSummaryRow[];
// grouped by the deepest named position (same name under several ECO codes = one row); each game's opening is memoised per book
```

### core/srs.ts
```ts
export const INITIAL_EASE = 2.5;
export const MIN_EASE = 1.3;
export function newReview(mistakeId: string, profileId: string, now: number): ReviewState; // due = now
export function gradeReview(r: ReviewState, grade: Grade, now: number): ReviewState;
// again: interval 0, due now+10min, reps 0, lapses+1, ease−0.2 (min 1.3) | hard: interval max(1, interval·1.2) days, ease−0.15
// good: reps 0 → 1 d, reps 1 → 3 d, else interval·ease | easy: (good interval)·1.3, ease+0.15
export function isDue(r: ReviewState | undefined, now: number): boolean;   // no review state = due (a new card)
export type AttemptOutcome = 'correct' | 'low-confidence' | 'habit' | 'wrong';
export function autoGrade(a: { outcome: AttemptOutcome; tries: number; hinted: boolean; previous?: ReviewState }): Grade;
```

### core/explain.ts
```ts
/** Material change (pawn units) for the side that played line[0] after `plies` (6) plies of `line` from fen,
 *  extended by up to two plies while the line keeps capturing. Negative = the mover lost material. */
export function materialSwing(fen: string, line: readonly string[], plies?: number): number;
/** "allows mate", "loses the queen", "loses a piece", "loses the exchange", "loses a pawn", … or ''.
 *  `score` = the line's score (mover's POV). With `bestLine` (and `bestScore`), only what the line loses
 *  beyond the best line over the same window is described (material the best line gives up too, or a
 *  mate it allows too, is not blamed on the move). */
export function explainLine(fen: string, line: readonly string[], score?: Score, bestLine?: readonly string[], bestScore?: Score): string;
export type ExplainableMistake = Pick<Mistake, 'fen' | 'move' | 'bestMove' | 'playedLine' | 'bestLine' | 'scorePlayed' | 'scoreBest'>;
/** Why the habit move fails: its refutation (playedLine, or the move) judged against bestLine. Used by the UI and the PGN export. */
export function explainMistake(m: ExplainableMistake): string;
```

### core/pgnExport.ts
```ts
/** One PGN game per mistake: best move as mainline, habit move as a variation with refutation (8 plies), comments with stats and explainMistake. */
export function mistakesToPgn(ms: readonly Mistake[], opts: { profileName: string; now: number }): string;
```

## sources

### sources/http.ts
```ts
export class SourceError extends Error { readonly kind: SourceErrorKind; readonly status?: number; readonly retryAfterMs?: number;
  constructor(kind: SourceErrorKind, message: string, opts?: { status?: number; retryAfterMs?: number; cause?: unknown }); }
export function abortError(): DOMException;
export function isAbortError(err: unknown): boolean;
export function throwIfAborted(signal: AbortSignal | null | undefined): void;   // always an AbortError, never a custom reason
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void>;
export function yieldToEventLoop(): Promise<void>;
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T>;
export const DEFAULT_BACKOFF_MS: readonly number[];   // [1000, 2000, 4000]
export const MIN_RATE_LIMIT_MS = 60_000;
export interface FetchRetryInit extends RequestInit {
  retries?: number /* 3 */; fetchImpl?: typeof fetch; backoffMs?: readonly number[];
  statusKinds?: Readonly<Partial<Record<number, SourceErrorKind>>>;   // e.g. { 410: 'closed' } on user endpoints
  responseTimeoutMs?: number /* 45 s: an attempt without response headers is retried like a network error */; }
export function fetchWithRetry(url: string, init?: FetchRetryInit): Promise<Response>;
// network error / 5xx / response timeout → retry after 1 s, 2 s, 4 s; 404/410 → 'not-found'; 429 → 'rate-limited'
// (retryAfterMs ≥ 60 s); other statuses → 'http'; abort → AbortError. No headers are added.
export function retryAfterHeaderMs(value: string | null, now?: number): number | undefined;  // delay-seconds or HTTP date
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
export interface ReadOptions { signal?: AbortSignal | null; idleTimeoutMs?: number /* 45 s */ }
export interface NdjsonOptions extends ReadOptions { onBadLine?(line: string): void; }
export function readNdjson(res: Response, opts?: NdjsonOptions): AsyncGenerator<unknown>;
// lines split anywhere; blank lines ignored; invalid JSON skipped (onBadLine); stall → SourceError('network'); early return cancels the body
export function readJson(res: Response, opts?: ReadOptions): Promise<unknown>;
export const LICHESS_COOLDOWN_KEY = 'ca:lichessCooldownUntil';
export function lichessCooldownUntil(): number;        // shared across tabs via localStorage (in memory when unavailable); 0 when none
export function setLichessCooldown(untilMs: number): void;
```

### sources/lichess.ts
```ts
export const LICHESS_ORIGIN = 'https://lichess.org';
export const LICHESS_PERF_TYPES: string;     // every standard speed
export interface LichessPage { since?: number; until?: number; max?: number; sort: 'dateAsc' | 'dateDesc'; }
export interface LichessOptions { signal?: AbortSignal; fetchImpl?: typeof fetch; now?: () => number /* 429 cooldown clock */;
  idleTimeoutMs?: number /* 45 s */; onBadLine?(line: string): void; }
export interface LichessGameItem { raw: RawGame | null; createdAt: number; }
export function lichessGamesUrl(username: string, page: LichessPage): string;
export function fetchLichessGames(username: string, page: LichessPage, opts?: LichessOptions): AsyncGenerator<LichessGameItem>;
// yields every received game (raw null if skipped: variant, thematic start, aborted/noStart, no moves) so the caller can
// advance cursors; rejects with SourceError (rate-limited → sets the shared cooldown, not-found, closed, network, http) or AbortError
export function lichessJsonToRaw(json: unknown): RawGame | null;
export interface LichessUser { id: string; username: string; games?: number /* count.all */; closed?: boolean; }
export function lichessUser(username: string, opts?: LichessOptions): Promise<LichessUser | null>;   // null = no such account
```

### sources/chesscom.ts
```ts
export const CHESSCOM_API = 'https://api.chess.com/pub/player';
export interface ChesscomOptions { signal?: AbortSignal; fetchImpl?: typeof fetch; }
export function chesscomArchives(username: string, opts?: ChesscomOptions): Promise<string[]>;    // oldest → newest URLs
export interface ChesscomArchive { games: RawGame[]; skipped: number; endTimes: number[] /* parallel to games, ms */ }
export function fetchChesscomArchive(url: string, opts?: ChesscomOptions): Promise<ChesscomArchive>;
export function archiveMonth(url: string): { year: number; month: number } | null;
export function chesscomJsonToRaw(game: unknown): RawGame | null;               // rules === 'chess', standard start, moves
export interface ChesscomUser { username: string; closed?: boolean; }
export function chesscomUser(username: string, opts?: ChesscomOptions): Promise<ChesscomUser | null>;
// Requests: one at a time (a module-wide queue), `cache: 'no-cache'`, lower-cased username in URLs.
```

### sources/pgnFile.ts
```ts
export interface PgnReadCounts { games: number; skipped: number; }
export interface PgnReadOptions { signal?: AbortSignal;
  onProgress?(doneBytes: number, totalBytes: number, counts: PgnReadCounts): void;   // after each chunk; totalBytes = UTF-8 size
  maxPlies?: number /* MAX_STORED_PLIES */; }
export function readPgnFile(input: Blob | string, opts?: PgnReadOptions): AsyncGenerator<RawGame, PgnReadCounts, undefined>; // returns the final counts
export function scanPgnFileNames(input: Blob | string, limit?: number /* 10 */, opts?: { signal?: AbortSignal }): Promise<{ name: string; games: number }[]>;
```

## engine

### engine/uci.ts
```ts
export interface InfoLine { depth?: number; seldepth?: number; multipv?: number; score?: Score; bound?: 'upper' | 'lower'; nodes?: number; nps?: number; timeMs?: number; pv?: string[]; }
export function parseInfo(line: string): InfoLine | null;     // null for non-info, `info string`, currmove lines
export function parseBestMove(line: string): { best: string | null; ponder?: string } | null;  // 'bestmove (none)' → best null
```

### engine/engine.ts
```ts
export const ENGINE_FILE = 'stockfish-19-lite-single.js';
export const ENGINE_ID = 'sf19-lite@1';           // bump the suffix to invalidate cached evals
export interface EngineWorkerLike { postMessage(msg: string): void; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null; terminate(): void; }
export interface SearchParams { fen: string; depth: number; searchMoves?: string[]; signal?: AbortSignal; }
export interface SearchResult { line: LineEval; nodes: number; timeMs: number; }
export function searchTimeoutMs(depth: number): number;   // watchdog: max(30 s, 40·depth² ms)
export function abortError(): DOMException;
export function isAbortError(err: unknown): boolean;
export class UciEngine {
  constructor(worker: EngineWorkerLike, opts?: { hashMb?: number; initTimeoutMs?: number });
  init(): Promise<void>;                             // uci → uciok, Hash + MultiPV 1, isready → readyok; memoised; rejects on timeout
  newGame(): Promise<void>;                          // ucinewgame + isready
  search(p: SearchParams): Promise<SearchResult>;    // MultiPV 1; serialised; watchdog; asserts pv[0] ∈ searchMoves when given
  terminate(): void;
  readonly alive: boolean;
}
export function createStockfishWorker(baseUrl?: string): Worker & EngineWorkerLike;  // new Worker(`${baseUrl ?? BASE_URL}engine/${ENGINE_FILE}`)
```

### engine/pool.ts
```ts
export type Priority = 'background' | 'interactive';
export interface PoolEnv { hardwareConcurrency?: number; deviceMemory?: number; coarsePointer?: boolean; }
export function defaultPoolSize(env?: PoolEnv): number;   // min(cores − 1, 4); ≤ 2 on touch or deviceMemory ≤ 4; 1 on deviceMemory ≤ 2
export class EnginePool {
  constructor(opts: { size: number; createWorker: () => EngineWorkerLike; hashMb?: number; idleMs?: number /* 60 s */ });
  readonly size: number;
  /** newGame, best-move search, then one searchmoves search per move in `moves` that is not the best move. */
  evaluatePosition(fen: string, moves: readonly string[], opts: { depth: number; signal?: AbortSignal; priority?: Priority }): Promise<PositionEval>;
  readonly busyCount: number;
  terminate(): void;                                  // queued and running jobs reject
}
```

### engine/nodeWorker.ts  (tests and scripts only; never imported by the app bundle)
```ts
/** Runs public/engine/stockfish-19-lite-single.js (or `enginePath`) as a Node child process speaking UCI over stdio. */
export function createNodeEngineWorker(opts?: { enginePath?: string }): EngineWorkerLike;
```

## db

### db/schema.ts
```ts
export const DB_NAME = 'chess-analyzer';
export interface MetaRow { key: string; value: unknown; }
export class AppDB extends Dexie { profiles; games; syncState; evals; mistakes; reviews; attempts; meta; allTables(): Table[]; }
export function getDb(): AppDB;                 // singleton 'chess-analyzer'
export function useTestDb(name?: string): AppDB; // fresh db for tests (fake-indexeddb); later getDb() calls return it
```

### db/repo.ts
```ts
export function getMeta<T>(key: string): Promise<T | undefined>;
export function setMeta<T>(key: string, value: T): Promise<void>;
export function deleteMeta(key: string): Promise<void>;
export function getSettings(): Promise<Settings>;                       // merged with DEFAULT_SETTINGS
export function saveSettings(patch: Partial<Settings>): Promise<Settings>;
export function randomId(): string;
export function listProfiles(): Promise<Profile[]>;
export function getProfile(id: string): Promise<Profile | undefined>;
export function createProfile(p: Omit<Profile, 'id' | 'createdAt'>, now?: number): Promise<Profile>;
export function updateProfile(id: string, patch: Partial<Profile>): Promise<void>;
export function addAliases(id: string, aliases: readonly string[]): Promise<void>;          // lower-cased, in one transaction
export function ensureSelfProfile(p: Omit<Profile, 'id' | 'createdAt' | 'kind'>, now?: number): Promise<Profile>; // created once, even under concurrent calls
export function deleteProfile(id: string): Promise<void>;               // cascades games, syncState, mistakes, reviews, attempts (evals stay)
export type SyncStateUpdate = SyncState | ((added: number) => SyncState);
/** Insert-only: skips keys that exist, and games whose contentKey already exists for the profile ACROSS
 *  sources (one of the two is a 'pgn' game; two games of one site with equal content are both kept),
 *  within the batch too. Writes the SyncState (or sync(added)) in the same transaction. Returns the number added. */
export function addGames(games: readonly StoredGame[], sync?: SyncStateUpdate): Promise<number>;
export function getGames(profileId: string): Promise<StoredGame[]>;     // oldest first
export function countGames(profileId: string): Promise<number>;
export function getGamesByKeys(keys: readonly string[]): Promise<StoredGame[]>;
export function deleteGamesOfPlatform(profileId: string, platform: StoredGame['platform']): Promise<number>;
export function deleteGamesOfAccount(profileId: string, account: Account): Promise<number>;
export function getSyncStates(profileId: string): Promise<SyncState[]>;
export function putSyncState(s: SyncState): Promise<void>;
export function deleteSyncState(key: string): Promise<void>;
export function getEvals(keys: readonly string[]): Promise<Map<string, PositionEval>>;  // keys = `${engine}|${posKey}`
export function putEval(ev: PositionEval): Promise<void>;
export function getMistakes(profileId: string): Promise<Mistake[]>;
export function getMistakeByShortId(shortId: string, profileId?: string): Promise<Mistake | undefined>;  // limited to the profile when given
/** Merge analysis output: preserves status, ignoreReason, snoozedUntil, createdAt (and an earlier refutation)
 *  of existing rows, clears `dormant`. keepLinks: a stored dependsOn stays when the fresh row has none
 *  (rows streamed before linking); without it the fresh links are written, so a stale link is removed. */
export function upsertMistakes(ms: readonly Mistake[], opts?: { keepLinks?: boolean }): Promise<Mistake[]>;  // the rows as stored
/** After a COMPLETE analysis: rows not in `keepIds` → deleted if they have no history (a review, or a
 *  user decision: mastered, ignored, snoozed), else dormant. Hysteresis (keep reviewed rows while loss ≥ 3) is the caller's. */
export function reconcileMistakes(profileId: string, keepIds: ReadonlySet<string>): Promise<{ deleted: number; dormant: number }>;
export type MistakePatch = Partial<Pick<Mistake, 'status' | 'ignoreReason' | 'snoozedUntil' | 'acceptable'>>;
export function patchMistake(id: string, patch: MistakePatch, now?: number): Promise<void>;   // undefined values remove the field
export function getReviews(profileId: string): Promise<ReviewState[]>;
export function putReview(r: ReviewState): Promise<void>;
export function addAttempt(a: Attempt): Promise<void>;
export function saveGrade(r: ReviewState, a: Attempt): Promise<void>;   // review + attempt in one transaction
export function getAttempts(profileId: string, sinceMs?: number): Promise<Attempt[]>;   // oldest first
export function tableCounts(): Promise<Record<string, number>>;        // diagnostics
```

### db/backup.ts
```ts
export interface BackupFile { app: 'chess-analyzer'; version: 3; exportedAt: number; profiles: Profile[]; games: StoredGame[];
  syncState: SyncState[]; mistakes: Mistake[]; reviews: ReviewState[]; attempts: Attempt[];
  settings: Settings;  /* without storagePersisted */
  evals?: never;       /* never written, ignored on import: a backup cannot plant evaluations in the trusted cache */ }
export interface ImportResult { profiles: number; games: number; mistakes: number; }
export interface ImportOptions {
  /** 'replace' (default): the backup replaces ALL profiles, games, progress (mistakes, reviews, attempts,
   *  sync state) and settings; the eval cache and this browser's storagePersisted are kept.
   *  'merge': only the backup's own profiles are replaced (by id); other profiles and the settings stay. */
  mode?: 'replace' | 'merge';
  asKind?: Profile['kind'];   // merge only: import every profile with this kind (the demo next to a real self profile)
  demo?: boolean;             // merge only: flag the profiles as the bundled example
  now?: number;               // clock for legacy imports
}
export const LEGACY_ENGINE = 'legacy-v2';
export function exportBackup(opts?: { now?: number }): Promise<BackupFile>;    // everything except the eval cache and storagePersisted
export function sanitizeSettings(raw: unknown): Settings;  // clamps to the Settings page's ranges/options, drops unknown fields and storagePersisted
/** Validates every nested field first (a damaged row rejects with "This backup is damaged: <table>[i] …" and
 *  nothing is written), then writes in one rw transaction. Legacy v2 (backup_version 1/2) always merges into
 *  the own profile: accounts added, its games restored like a PGN import, mistakes mapped (existing ones kept). */
export function importBackup(data: unknown, opts?: ImportOptions): Promise<ImportResult>;
export function legacyMistake(row: unknown, profileId: string, now: number): Mistake | null;
export function clearAllData(): Promise<void>;     // everything, settings and cached evals included
```

## services

### services/sync.ts
```ts
export const FIRST_RUN_GAMES = 300;          // first sync per account, then analysis, then backfill
export const CHUNK_SIZE = 100;               // games per stored chunk (one transaction with its cursor)
export const LICHESS_OVERLAP_MS = 3 * 86_400_000;
export interface SyncOptions { signal?: AbortSignal; onProgress?(p: SyncProgress): void; fetchImpl?: typeof fetch; now?: () => number;
  /** Cap this run per account (first-run fast pass = 300); defaults to settings.gamesPerAccount.
   *  The Lichess forward pass (new games) is not capped by it: it pages until a page comes back short. */
  limit?: number;
  /** Games kept per account (the backfill stops there); defaults to settings.gamesPerAccount. Scouted players use fewer. */
  perAccount?: number; }
export interface SyncError { account: Account; kind: SourceErrorKind; message: string; }
export interface SyncResult { added: number; unmatched: number; errors: SyncError[]; }
export function syncStateKey(profileId: string, account: Account): string;   // `${profileId}|${platform}|${username lower-cased}`
/** Every account in turn; account errors are collected and the run goes on; an abort rejects with an
 *  AbortError after storing what was received. During a Lichess 429 cooldown (shared across tabs) no
 *  Lichess request is made: the account reports 'rate-limited' and the progress phase is 'cooldown'. */
export function syncProfile(profileId: string, opts?: SyncOptions): Promise<SyncResult>;
export interface PgnImportResult { added: number; skipped: number; unmatched: number; duplicates: number; }
export function importPgnIntoProfile(profileId: string, input: Blob | string,
  opts?: { signal?: AbortSignal; onProgress?(p: SyncProgress): void; asColor?: Color }): Promise<PgnImportResult>;
```

### services/scheduler.ts
```ts
export interface EvalTask { key: string; fen: string; moves: string[]; weight: number; }
export type EvalOrigin = 'cache' | 'engine';
export const TRIAGE_LOSS = 2.5;
export type PoolLike = Pick<EnginePool, 'evaluatePosition' | 'size'>;
export interface EvalDeps {
  pool: PoolLike;
  getCached(keys: readonly string[]): Promise<Map<string, PositionEval>>;  // by `${engine}|${posKey}`
  putCached(ev: PositionEval): Promise<void>;
  engine: string; triageDepth: number; confirmDepth: number; signal?: AbortSignal;
  onResult(task: EvalTask, ev: PositionEval, origin: EvalOrigin): void | Promise<void>;
  onError?(task: EvalTask, err: unknown): void;        // a position the engine failed on; the run continues
}
export interface EvalSummary { cacheHits: number; engineEvals: number; failed: number; }
export function needsConfirm(ev: PositionEval, moves: readonly string[]): boolean;   // some move loses ≥ TRIAGE_LOSS
export function isCacheHit(ev: PositionEval, task: EvalTask, depths: { triageDepth: number; confirmDepth: number; engine?: string }): boolean;
// same engine build, covers all task.moves, and (depth ≥ confirmDepth or (depth ≥ triageDepth and no move loses ≥ 2.5))
export function evaluateAll(tasks: readonly EvalTask[], deps: EvalDeps): Promise<EvalSummary>;
// Cache hits first, then the engine with pool.size positions in flight, highest weight first: triageDepth,
// then confirmDepth where some move loses ≥ 2.5. Each eval is cached as it completes. On abort, rejects
// with an AbortError once the positions in flight have settled; repeated engine failures end the run.
```

### services/analysis.ts
```ts
export const PRESET_DEPTHS: Readonly<Record<AnalysisPreset, { triage: number; confirm: number }>>;
export const HYSTERESIS_LOSS = 3;
export interface AnalysisDeps { pool: PoolLike; book?: OpeningBook; signal?: AbortSignal;
  /** Settings to analyse with (default: the stored ones, read at the start); the caller records exactly these as applied. */
  settings?: Pick<Settings, 'openingPlies' | 'preset' | 'depthOverride'>;
  now?: () => number; clock?: () => number /* elapsed time for the ETA */;
  onProgress?(p: AnalysisProgress): void;
  onMistakes?(ms: Mistake[]): void;                       // rows as stored, batch by batch
  onPositionError?(fen: string, err: unknown): void; }    // the run goes on, ends with complete = false
export interface AnalysisResult { mistakes: number; positions: number; complete: boolean; }
export function presetDepths(s: Pick<Settings, 'preset' | 'depthOverride'>): { triage: number; confirm: number };  // quick 8/10, standard 10/14, thorough 12/18; depthOverride sets confirm
export const searchesOf: (task: Pick<EvalTask, 'moves'>) => number;   // moves + 1: the ETA's unit of work
export function analyzeProfile(profileId: string, deps: AnalysisDeps): Promise<AnalysisResult>;
// aggregate in time-sliced chunks → candidates → evaluateAll → classify per result (rows upserted with keepLinks
// in batches) → only when every position was evaluated: linkDependencies (rows whose link changed are rewritten)
// + reconcileMistakes; opponent profiles: then each mistake's after-move position for `refutation`.
// A profile without games is left untouched. An abort keeps the partial results and rejects with an AbortError.
```

### services/training.ts
```ts
export type { MoveVerdict, SessionCard } from '../core/types';
// SessionCard { mistake: Mistake; review?: ReviewState; isNew: boolean }
// MoveVerdict = { kind: 'correct'; best: boolean; line?: LineEval } | { kind: 'low-confidence'; loss: number; line?: LineEval }
//             | { kind: 'habit' } | { kind: 'wrong'; loss: number; line?: LineEval } | { kind: 'unknown' }   (line = the move's evaluated line, when known)
export interface SessionOptions { size: number; newToday: number; newPerDay: number; filters?: Partial<ViewFilters> /* default DEFAULT_FILTERS */ }
/** Due reviews first (oldest due first), then new cards by impact (at most newPerDay − newToday), at most `size`,
 *  parents before children. Only listed items (active, not dormant, not snoozed) passing the filters. */
export function buildSession(ms: readonly Mistake[], reviews: readonly ReviewState[], now: number, opts: SessionOptions): SessionCard[];
export interface SessionCounts { dueReviews: number; newAvailable: number; total: number; }   // total = buildSession(..., size ∞).length
export function sessionCounts(ms: readonly Mistake[], reviews: ReadonlyMap<string, ReviewState> | readonly ReviewState[], now: number,
  opts: Omit<SessionOptions, 'size'>): SessionCounts;     // one filter pass, no session built
export function judgeMove(m: Mistake, uci: string, ev?: PositionEval): MoveVerdict;      // habit, known acceptable, or by loss in `ev`; else 'unknown'
export function evaluateTrainingMove(pool: PoolLike, m: Mistake, uci: string, depth: number, signal?: AbortSignal): Promise<MoveVerdict>;
// interactive priority, same deterministic search; caches the eval and adds an acceptable move to the mistake
export function recordGrade(card: SessionCard, grade: Grade, now: number): Promise<ReviewState>;   // persists review + attempt
export function judgeRefutationMove(pool: PoolLike, m: Mistake, uci: string, depth: number, signal?: AbortSignal): Promise<MoveVerdict>;
// scout prep drill: your reply in m.refutation.fen; the refutation or a known acceptable reply is correct, others are evaluated live
```

### services/jobs.ts
```ts
export const JOB_LOCK = 'chess-analyzer:jobs';
export const CHANNEL = 'chess-analyzer';
export interface JobMessage { type: 'job-done' | 'job-started'; profileId: string; }
/** Runs fn while holding the cross-tab job lock; null (without running) if another tab holds it. Not re-entrant. No Web Locks → fn just runs. */
export function withJobLock<T>(fn: () => Promise<T>): Promise<T | null>;
export function queryJobLock(): Promise<boolean | null>;   // held by some tab? null = cannot tell (no Web Locks or no query)
export function isJobLockHeld(): Promise<boolean>;          // queryJobLock, unknown → false
export function onJobBroadcast(cb: (msg: JobMessage) => void): () => void;
export function broadcastJob(msg: JobMessage): void;
export function holdWakeLock(): Promise<() => void>;        // re-acquired when the page is visible again; no-op when unsupported
export function requestPersistentStorage(): Promise<boolean>;
```

## state (signals; the only API the UI uses besides pure core helpers)

### state/store.ts
Training goes through `startSession` / `submitMove` / `gradeCard`; the UI never touches the engine pool
directly. Long jobs (sync, analysis, PGN analysis) run one at a time under the cross-tab job lock.
```ts
export type Notice = { kind: 'info' | 'error' | 'success'; text: string; action?: { label: string; run(): void } };
export const SCOUT_GAMES = 500;                 // games per scouted account
export const AUTO_SYNC_AFTER_MS = 6 * 3_600_000;
export const OTHER_TAB_POLL_MS = 5_000;         // while otherTabBusy: re-check the job lock (a closed tab never says "done")
export const MISTAKES_MERGE_MS = 1_000;         // during an analysis, found mistakes reach `mistakes` at most this often

export const ready: Signal<boolean>;
export const settings: Signal<Settings>;
export const filters: Signal<ViewFilters>;               // persisted to localStorage
export const profiles: Signal<Profile[]>;
export const selfProfile: ReadonlySignal<Profile | null>;
export const scoutProfiles: ReadonlySignal<Profile[]>;
export const mistakes: Signal<Mistake[]>;                 // self profile, all statuses
export const reviews: Signal<Map<string, ReviewState>>;
export const games: Signal<StoredGame[]>;                 // self profile (for stats/openings)
export const syncProgress: Signal<SyncProgress | null>;
export const analysisProgress: Signal<AnalysisProgress | null>;
export const busy: ReadonlySignal<boolean>;
export const otherTabBusy: Signal<boolean>;               // cleared on 'job-done', on the lock poll, or when the page becomes visible
export const notice: Signal<Notice | null>;
export const updateAvailable: Signal<null | (() => void)>;  // call to apply a PWA update
export const visibleMistakes: ReadonlySignal<ViewMistake[]>; // applyFilters(mistakes, filters, now)
export type TrainingCounts = SessionCounts;
export const trainingCounts: ReadonlySignal<TrainingCounts>; // { dueReviews, newAvailable, total } for the self profile, default filters
export const dueCount: ReadonlySignal<number>;               // = trainingCounts.total (due reviews + today's new cards)
export class AccountError extends Error { readonly kind: 'not-found' | 'closed' | 'network'; readonly account: Account; }

export function init(): Promise<void>;                     // loads db, settings, self profile data; deep links; auto-sync when due. Idempotent
export function setupSelf(accounts: Account[]): Promise<Profile>;   // validates accounts (AccountError), creates/updates the self profile (replacing a demo), starts refresh
export function updateSelfAccounts(accounts: Account[]): Promise<void>;  // validates; a removed account's games/sync state go; stops a running refresh so added accounts are synced; starts refresh
export function addScout(input: { name?: string; accounts: Account[] }): Promise<Profile>;   // starts the scout's sync (≤ SCOUT_GAMES per account) and analysis
export function removeProfile(id: string): Promise<void>;
export function refresh(profileId?: string): Promise<void>;  // sync then analyse; first run: 300 newest → analyse → backfill → analyse
export function analyze(profileId?: string): Promise<void>;
export function scanPgn(file: Blob): Promise<{ name: string; games: number }[]>;   // "Which of these is you?"
export function importPgn(file: Blob, opts: { aliases?: string[]; asColor?: Color; profileId?: string }): Promise<void>; // resolves once stored; analysis runs in the background
export function cancelJobs(): void;
export function setMistakeStatus(id: string, status: MistakeStatus, opts?: { reason?: 'repertoire' | 'other'; snoozeDays?: number }): Promise<void>;
export function updateSettings(patch: Partial<Settings>): Promise<void>;
export function setFilters(patch: Partial<ViewFilters>): void;
export function getMistakeByShortId(shortId: string): Mistake | undefined;   // from the self profile's loaded mistakes
export function startSession(opts?: { profileId?: string; filters?: Partial<ViewFilters> }): Promise<SessionCard[]>; // self profile, or a scout prep drill
export function submitMove(card: SessionCard, uci: string, signal?: AbortSignal): Promise<MoveVerdict>;  // unknown moves go to the engine (interactive)
export function gradeCard(card: SessionCard, grade: Grade): Promise<ReviewState>;
export function practiceStats(days?: number /* 91 */): Promise<{ byDay: { day: string; total: number; correct: number }[]; streak: number }>;
export function loadScout(profileId: string): Promise<{ profile: Profile; mistakes: Mistake[]; games: StoredGame[] }>;
export function exportData(): Promise<Blob>;              // v3 backup JSON; records lastBackupAt
export function exportMistakesPgn(): Promise<Blob>;       // the visible mistakes as PGN
export function importData(file: Blob): Promise<void>;    // replace-mode restore (legacy v2 merges); refused while a job runs here or in another tab
export function clearData(): Promise<void>;
export function loadDemo(): Promise<void>;                // `${BASE_URL}demo/demo.json`: the (demo) own profile, or a scouted player next to a real one
export function diagnostics(): Promise<Record<string, unknown>>;
export function deepLinkAccounts(hash: string, search?: string): Account[];   // `#/?lichess=NAME&chesscom=NAME` (or the query string)
// Test hooks (not for the UI): StoreTestDeps, __setTestDeps(d), __resetForTests(), __jobsIdle()
```

## ui
`index.html`, `src/main.tsx`, `src/ui/**`, styles. Hash routes (`src/ui/router.ts`): `#/` (onboarding or
dashboard), `#/leaks`, `#/leaks/<shortId>`, `#/train` (`?leak=<shortId>` for one card), `#/openings`,
`#/scout`, `#/scout/<profileId>`, `#/settings`, `#/about`. Consumes `state/store.ts` and pure helpers
from `core/*` only.
