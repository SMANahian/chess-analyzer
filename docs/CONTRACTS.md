# Module contracts

Implementation agents code against these signatures. `src/core/types.ts` holds the shared
types. Any change to a signature here must be reflected in every consumer.

Conventions:
- **Standard UCI** everywhere: castling `e1g1/e1c1/e8g8/e8c8`, promotions `e7e8q`. chessops
  represents castling as king-takes-rook (`e1h1`) internally, so always convert with
  `toStandardUci` / `parseStandardUci` from `core/chess.ts` at the boundary.
- Scores are **side-to-move POV of the analysed root**. Lichess cloud eval is White POV →
  converted in `sources/cloudEval.ts`.
- Position key = first 4 FEN fields from `makeFen(pos.toSetup())` (chessops writes the ep square
  only when a legal en-passant capture exists, so transpositions merge).
- Everything that can take long accepts an `AbortSignal` and throws `DOMException('AbortError')`
  (`name === 'AbortError'`) when aborted.
- `fetchImpl?: typeof fetch` parameters exist so tests can inject fakes.

## core (pure, no DOM / IndexedDB / network)

### core/chess.ts
```ts
import { Chess } from 'chessops/chess';
import type { Move } from 'chessops/types';
export const START_FEN: string;
export function posFromFen(fen: string): Chess;                      // throws Error on invalid FEN
export function posKey(pos: Chess): string;                            // 'board turn castling ep'
export function fenOf(pos: Chess): string;
export function turnColor(pos: Chess): Color;
export function parseStandardUci(pos: Chess, uci: string): Move | undefined; // accepts e1g1 or e1h1; legal moves only
export function toStandardUci(pos: Chess, move: Move): string;
export function normalizeUci(fen: string, uci: string): string | undefined;  // any castling form → standard; undefined if illegal
export function sanOf(pos: Chess, uci: string): string;               // SAN of a legal standard-UCI move ('' if illegal)
export function lineToSan(fen: string, ucis: string[]): string[];     // stops at first illegal move
export function sansToUci(sans: string[], maxPlies: number): string[] | null; // from start; null if first move illegal; truncates at first illegal
export function formatMoves(sans: string[], startFen?: string): string; // "1. e4 e5 2. Nf3" (or "5... Nc6" when starting with black)
export interface ReplayStep { ply: number; pos: Chess /* BEFORE the move */; key: string; fen: string; uci: string; }
export function replay(ucis: string[], maxPlies: number): ReplayStep[]; // stops at first illegal move
export function playUci(fen: string, uci: string): string | undefined; // FEN after move
```

### core/pgn.ts
```ts
export interface PgnGame { headers: Record<string, string>; sans: string[]; plyCount: number; }
export function parsePgnText(text: string, maxPlies: number): Generator<PgnGame>;  // multi-game, tolerant (comments, variations, NAGs, BOM, CRLF)
export class PgnStreamSplitter { push(chunk: string): string[]; flush(): string[]; } // incremental game splitting for huge files
export function speedFromTimeControl(tc: string | undefined): Speed;      // Lichess estimate base + 40*inc
export function resultFromHeader(r: string | undefined): GameResult;
export function pgnDate(headers: Record<string,string>): number;           // UTCDate/UTCTime or Date; 0 if unknown
export function pgnGameToRaw(g: PgnGame, opts?: { platform?: Platform }): RawGame | null; // null for variants/FEN setups/no legal moves
// Platform detection: Site "https://lichess.org/<8 chars>" → platform 'lichess', sourceId = id;
// Link/Site "https://www.chess.com/game/live/<id>" → 'chesscom'; otherwise 'pgn' with a hash id
// (FNV-1a over normalised headers + moves).
```

### core/winrate.ts
```ts
export const THRESHOLDS: { inaccuracy: 5; mistake: 10; blunder: 15 };
export function winPercent(s: Score): number;           // side-to-move POV, 0..100
export function winLoss(best: Score, played: Score): number; // max(0, win(best) - win(played))
export function severityOf(loss: number): Severity | null;
export function negateScore(s: Score): Score;
export function formatScore(s: Score): string;           // "+0.35", "-1.20", "#3", "#-2"  (side-to-move POV)
export function scoreToCp(s: Score): number;             // mate → ±(100000 - |mate|*100)
```

### core/openings.ts
```ts
export interface OpeningName { eco: string; name: string; }
export class OpeningBook {
  static fromJson(json: { entries: [string, string, string][] }): OpeningBook;
  lookup(key: string): OpeningName | undefined;
  /** Deepest named position along a sequence of position keys (last match wins). */
  nameForKeys(keys: string[]): OpeningName | undefined;
  readonly size: number;
}
export function loadOpeningBook(url?: string, fetchImpl?: typeof fetch): Promise<OpeningBook>; // default 'data/openings.json', cached
```

### core/aggregate.ts
```ts
export interface MoveStat { move: string; count: number; gameKeys: string[]; lastPlayedAt: number; }
export interface PositionStat {
  key: string; fen: string; color: Color; ply: number;
  count: number;              // times the profile was to move here
  path: string[];             // UCI path of the most recent occurrence
  pathKeys: string[];         // position keys along that path (for opening naming)
  moves: Map<string, MoveStat>;
  lastAt: number;
  lastMove: string;           // move played at the most recent occurrence
}
export function aggregateGames(games: StoredGame[], opts: { openingPlies: number }): Map<string, PositionStat>;
export interface Candidate { key: string; fen: string; moves: string[]; weight: number; stat: PositionStat; }
export function selectCandidates(stats: Map<string, PositionStat>, minOccurrences: number): Candidate[]; // weight desc
```

### core/classify.ts
```ts
export function moveEval(ev: PositionEval, uci: string): LineEval | undefined; // from lines or moves
export function acceptableMoves(ev: PositionEval): string[];   // loss < THRESHOLDS.inaccuracy vs best
export function classifyCandidate(c: Candidate, ev: PositionEval, opts: {
  profileId: string; minOccurrences: number; minWinLoss: number; book?: OpeningBook; now: number;
}): Mistake[];  // status 'active', createdAt=updatedAt=now (repo preserves status/createdAt on upsert)
```

### core/srs.ts
```ts
export function newReview(mistakeId: string, profileId: string, now: number): ReviewState; // due = now
export function gradeReview(r: ReviewState, grade: Grade, now: number): ReviewState;
export function isDue(r: ReviewState | undefined, now: number): boolean;  // undefined (never reviewed) → true
```

## sources (network / files)

### sources/http.ts
```ts
export class HttpError extends Error { status: number; retryAfterMs?: number; }
export class RateLimitError extends HttpError {}
export class NotFoundError extends HttpError {}
export class NetworkError extends Error {}        // fetch threw (offline, CORS, DNS)
export function fetchWithRetry(url: string, init?: RequestInit & { retries?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<Response>;
// retries 5xx/network with backoff (1s, 2s, 4s); 429 → RateLimitError immediately (caller decides); 404 → NotFoundError
export function readNdjson(res: Response, signal?: AbortSignal): AsyncGenerator<unknown>;
```

### sources/lichess.ts
```ts
export interface LichessOptions { since?: number; max: number; signal?: AbortSignal; fetchImpl?: typeof fetch; }
export function fetchLichessGames(username: string, opts: LichessOptions): AsyncGenerator<RawGame>;
// GET https://lichess.org/api/games/user/{u}?max&since&moves=true&tags=true&clocks=false&evals=false&opening=false
//   &perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence  Accept: application/x-ndjson ; streamed
export function lichessJsonToRaw(json: unknown): RawGame | null;  // skips non-standard variant, initialFen, aborted/noStart
export function lichessUser(username: string, fetchImpl?: typeof fetch): Promise<{ id: string; username: string } | null>;
```

### sources/chesscom.ts
```ts
export interface ChesscomOptions {
  max: number; signal?: AbortSignal; fetchImpl?: typeof fetch;
  doneArchives?: string[]; archiveTags?: Record<string, string>;
  onArchive?(info: { url: string; tag?: string; complete: boolean }): void; // complete = month is in the past
}
export function fetchChesscomGames(username: string, opts: ChesscomOptions): AsyncGenerator<RawGame>;
// archives newest-first, serial requests, If-None-Match with stored tags (304 → skip month), skips doneArchives
export function chesscomJsonToRaw(game: unknown): RawGame | null;  // rules==='chess' only, standard start only
export function chesscomUser(username: string, fetchImpl?: typeof fetch): Promise<{ username: string } | null>;
```

### sources/pgnFile.ts
```ts
export function readPgnFile(input: Blob | string, opts?: { signal?: AbortSignal; onProgress?(done: number, total: number): void }): AsyncGenerator<RawGame>;
```

### sources/cloudEval.ts
```ts
export class CloudEvalClient {
  constructor(opts?: { fetchImpl?: typeof fetch; maxRequests?: number /* default 400 */ });
  /** null = not in the cloud DB. Throws RateLimitError on 429 (and stays disabled afterwards). One request at a time. */
  get(fen: string, multiPv: number, signal?: AbortSignal): Promise<PositionEval | null>;
  readonly disabled: boolean;
  readonly requests: number;
}
```

## engine

### engine/uci.ts
```ts
export interface InfoLine { depth?: number; seldepth?: number; multipv?: number; score?: Score; bound?: 'upper' | 'lower'; nodes?: number; nps?: number; timeMs?: number; pv?: string[]; }
export function parseInfo(line: string): InfoLine | null;
export function parseBestMove(line: string): { best: string; ponder?: string } | null;
```

### engine/engine.ts
```ts
export interface EngineWorkerLike { postMessage(msg: string): void; onmessage: ((e: { data: unknown }) => void) | null; onerror?: ((e: unknown) => void) | null; terminate(): void; }
export interface SearchParams { fen: string; depth: number; multiPv: number; searchMoves?: string[]; signal?: AbortSignal; }
export interface SearchResult { lines: LineEval[]; depth: number; nodes: number; timeMs: number; }
export class UciEngine {
  constructor(worker: EngineWorkerLike, opts?: { hashMb?: number });
  init(): Promise<void>;
  search(p: SearchParams): Promise<SearchResult>;   // serialised per engine; abort → 'stop', rejects AbortError
  terminate(): void;
}
export const ENGINE_ID = 'sf19-lite';
export function createStockfishWorker(base?: string): Worker; // new Worker(`${base ?? import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`)
```

### engine/pool.ts
```ts
export function defaultPoolSize(): number;          // clamp(navigator.hardwareConcurrency - 1, 1, 4)
export class EnginePool {
  constructor(opts: { size: number; createWorker: () => EngineWorkerLike; hashMb?: number });
  readonly size: number;
  /** MultiPV search, then ONE extra `searchmoves` search (MultiPV = #uncovered) for candidate moves
   *  not among the lines — same engine, same depth, same root. Returns a PositionEval (source 'local'). */
  evaluatePosition(fen: string, candidateMoves: string[], opts: { depth: number; multiPv: number; signal?: AbortSignal }): Promise<PositionEval>;
  search(p: SearchParams): Promise<SearchResult>;
  terminate(): void;
}
```

## db (Dexie)

### db/schema.ts
```ts
export class AppDB extends Dexie { profiles; games; syncState; evals; mistakes; reviews; attempts; settings; }
export function getDb(): AppDB;              // singleton, name 'chess-analyzer'
export function setDbForTests(db: AppDB): void;
```

### db/repo.ts
```ts
export function getSettings(): Promise<Settings>;
export function saveSettings(patch: Partial<Settings>): Promise<Settings>;
export function listProfiles(): Promise<Profile[]>;
export function getProfile(id: string): Promise<Profile | undefined>;
export function createProfile(p: Omit<Profile, 'id' | 'createdAt'>): Promise<Profile>;
export function updateProfile(id: string, patch: Partial<Profile>): Promise<void>;
export function deleteProfile(id: string): Promise<void>;   // cascades games, syncState, mistakes, reviews, attempts
export function putGames(games: StoredGame[]): Promise<number>; // returns # newly added
export function getGames(profileId: string): Promise<StoredGame[]>;
export function countGames(profileId: string): Promise<number>;
export function getGamesByKeys(keys: string[]): Promise<StoredGame[]>;
export function getSyncState(key: string): Promise<SyncState | undefined>;
export function putSyncState(s: SyncState): Promise<void>;
export function getEvals(keys: string[]): Promise<Map<string, PositionEval>>;
export function putEvals(evals: PositionEval[]): Promise<void>;
export function getMistakes(profileId: string): Promise<Mistake[]>;
export function upsertMistakes(ms: Mistake[]): Promise<void>;  // preserves status + createdAt of existing rows
export function deleteMistakes(ids: string[]): Promise<void>;
export function setMistakeStatus(id: string, status: MistakeStatus): Promise<void>;
export function getReviews(profileId: string): Promise<ReviewState[]>;
export function putReview(r: ReviewState): Promise<void>;
export function addAttempt(a: Attempt): Promise<void>;
export function getAttempts(profileId: string, sinceMs?: number): Promise<Attempt[]>;
```

### db/backup.ts
```ts
export interface BackupFile { app: 'chess-analyzer'; version: 1; exportedAt: number; profiles; games; syncState; mistakes; reviews; attempts; settings; evals?; }
export function exportBackup(opts?: { includeEvals?: boolean }): Promise<BackupFile>;
export function importBackup(data: unknown): Promise<{ profiles: number; games: number; mistakes: number }>; // validates, replaces all
export function clearAllData(): Promise<void>;
```

## services

### services/sync.ts
```ts
export function syncProfile(profileId: string, opts?: { signal?: AbortSignal; onProgress?(p: SyncProgress): void; fetchImpl?: typeof fetch }): Promise<{ added: number }>;
export function importPgnIntoProfile(profileId: string, input: Blob | string, opts?: { signal?: AbortSignal; onProgress?(p: SyncProgress): void }): Promise<{ added: number; skipped: number; unmatched: number }>;
export function rawToStored(raw: RawGame, profile: Profile): StoredGame | null; // colour by account usernames/aliases (case-insensitive); null if the profile didn't play
```

### services/evalScheduler.ts
```ts
export interface EvalTask { key: string; fen: string; moves: string[]; weight: number; }
export type EvalOrigin = 'cache' | 'cloud' | 'local';
export function evaluateAll(tasks: EvalTask[], deps: {
  pool: Pick<EnginePool, 'evaluatePosition' | 'size'>;
  cloud?: Pick<CloudEvalClient, 'get' | 'disabled'>;
  getCached(keys: string[]): Promise<Map<string, PositionEval>>;
  putCached(evals: PositionEval[]): Promise<void>;
  depth: number; multiPv: number; signal?: AbortSignal;
  onResult(task: EvalTask, ev: PositionEval, origin: EvalOrigin): void | Promise<void>;
}): Promise<void>;
// Cache hit = local eval with depth >= requested, or any cloud eval, covering all task.moves.
// Cloud lane: one request at a time from the FRONT (highest weight); local lanes (pool.size) from the BACK;
// cloud misses go to a priority queue that local lanes take first. 429 → cloud lane stops.
```

### services/analysis.ts
```ts
export function analyzeProfile(profileId: string, deps: {
  pool: EnginePool; cloud?: CloudEvalClient; book?: OpeningBook;
  signal?: AbortSignal; onProgress?(p: AnalysisProgress): void; onMistakes?(ms: Mistake[]): void;
}): Promise<{ mistakes: number; positions: number }>;
```

### services/training.ts
```ts
export interface SessionCard { mistake: Mistake; review?: ReviewState; isNew: boolean; }
export function buildSession(mistakes: Mistake[], reviews: ReviewState[], now: number, opts?: { limit?: number; color?: Color; opening?: string }): SessionCard[];
// active mistakes only; due reviews first (oldest due first), then never-reviewed by impact desc
export function recordGrade(card: SessionCard, grade: Grade, now: number): Promise<ReviewState>; // persists review + attempt
export function judgeMove(mistake: Mistake, uci: string): 'correct' | 'habit' | 'unknown' | 'wrong';
// correct = in acceptable; habit = mistake.move; unknown = not evaluated (caller may live-evaluate)
export function evaluateTrainingMove(pool: EnginePool, mistake: Mistake, uci: string, depth: number, signal?: AbortSignal): Promise<{ acceptable: boolean; loss: number; line: LineEval }>;
```

## state (signals; consumed by UI)

### state/store.ts
```ts
import { signal, computed } from '@preact/signals';
export const ready: Signal<boolean>;                    // initial load done
export const settings: Signal<Settings>;
export const profiles: Signal<Profile[]>;
export const activeProfileId: Signal<string | null>;    // persisted in localStorage
export const activeProfile: ReadonlySignal<Profile | null>;
export const mistakes: Signal<Mistake[]>;               // active profile, all statuses
export const reviews: Signal<Map<string, ReviewState>>; // active profile
export const gameCount: Signal<number>;                 // active profile
export const syncProgress: Signal<SyncProgress | null>;
export const analysisProgress: Signal<AnalysisProgress | null>;
export const busy: ReadonlySignal<boolean>;             // sync or analysis running
export const lastError: Signal<string | null>;

export function init(): Promise<void>;
export function selectProfile(id: string): Promise<void>;
export function addProfile(input: { name?: string; kind: 'self' | 'opponent'; accounts: Account[] }): Promise<Profile>; // validates usernames exist (lichessUser/chesscomUser)
export function removeProfile(id: string): Promise<void>;
export function updateAccounts(id: string, accounts: Account[]): Promise<void>;
export function refresh(profileId?: string): Promise<void>;          // sync then analyse (the main button)
export function analyze(profileId?: string): Promise<void>;          // analyse only (after settings change)
export function importPgn(input: Blob | string, profileId?: string): Promise<void>;
export function cancelJobs(): void;
export function setStatus(mistakeId: string, status: MistakeStatus): Promise<void>;
export function updateSettings(patch: Partial<Settings>): Promise<void>;
export function gradeCard(card: SessionCard, grade: Grade): Promise<void>;
export function getEnginePool(): EnginePool;                         // lazy singleton (UI uses it for live training evals)
export function exportData(): Promise<Blob>;
export function importData(file: Blob): Promise<void>;
export function clearData(): Promise<void>;
```

## ui
`src/main.tsx`, `src/ui/**`, `index.html`, `public/icon.svg`. Hash routes: `#/` (onboarding or
dashboard), `#/mistakes`, `#/mistakes/<id>`, `#/train`, `#/openings`, `#/scout`, `#/settings`.
Consumes only `state/store.ts` + pure helpers from `core/*` (SAN formatting, win %, chess.ts).
