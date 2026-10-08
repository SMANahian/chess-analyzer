// Shared domain types. This file is the contract between core logic, sources, engine,
// storage, services and UI. Keep it dependency-free.

export type Color = 'white' | 'black';
export type Platform = 'lichess' | 'chesscom' | 'pgn';
export type OnlinePlatform = Exclude<Platform, 'pgn'>;
export type Speed = 'ultraBullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence' | 'unknown';
export type Outcome = 'win' | 'loss' | 'draw' | 'unknown';
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

/** Moves stored per game (standard UCI, from the standard start). Analysis uses settings.openingPlies <= this. */
export const MAX_STORED_PLIES = 40;
/** Analysis records every (position, move) seen in at least this many distinct games. View filters may raise it. */
export const ANALYSIS_MIN_GAMES = 2;
/** Analysis stores every move losing at least this many win-% points. View filters may raise it. */
export const ANALYSIS_MIN_LOSS = 5;

export interface Account {
  platform: OnlinePlatform;
  /** As typed by the user; matching is case-insensitive. */
  username: string;
}

export interface Profile {
  id: string;
  /** Display name (defaults to the first username). */
  name: string;
  /** 'self' = the user's own games (exactly one); 'opponent' = a scouted player (Scout section). */
  kind: 'self' | 'opponent';
  accounts: Account[];
  /** Lower-cased names that identify this player in uploaded PGN files (chosen by the user). */
  aliases: string[];
  createdAt: number;
  lastSyncAt?: number;
  lastAnalysisAt?: number;
  /** Set for the bundled example profile. */
  demo?: boolean;
}

/** A game as produced by a source (Lichess, Chess.com, PGN), before it is tied to a profile. */
export interface RawGame {
  platform: Platform;
  /**
   * Stable id within the platform. Lichess: 8-char game id. Chess.com: `${'live'|'daily'}/${numericId}`
   * parsed from the game URL (identical for API JSON and PGN Link/Site headers). PGN: FNV-1a hash.
   */
  sourceId: string;
  url?: string;
  /** Game start time, ms since epoch (Lichess createdAt; Chess.com/PGN UTCDate+UTCTime, else end_time); 0 if unknown. */
  playedAt: number;
  white: string;
  black: string;
  /** Lower-cased platform user ids when known (Lichess user.id, Chess.com username). */
  whiteId?: string;
  blackId?: string;
  whiteRating?: number;
  blackRating?: number;
  speed: Speed;
  rated: boolean;
  result: GameResult;
  /** First MAX_STORED_PLIES plies in standard UCI (castling e1g1, promotions e7e8q). Non-empty. */
  moves: string[];
  /** Total plies in the full game, when known. */
  plyCount?: number;
}

/** A game stored for a profile. */
export interface StoredGame {
  /** `${profileId}|${platform}:${sourceId}` */
  key: string;
  profileId: string;
  platform: Platform;
  sourceId: string;
  /** Cross-source duplicate key: `${white}|${black}|${YYYY-MM-DD}|${moves}` lower-cased (see core/games.ts). */
  contentKey: string;
  url?: string;
  playedAt: number;
  /** The profile's colour in this game. */
  color: Color;
  opponent: string;
  playerRating?: number;
  opponentRating?: number;
  speed: Speed;
  rated: boolean;
  outcome: Outcome;
  /** Space-separated standard UCI moves (first MAX_STORED_PLIES plies). */
  moves: string;
  plyCount?: number;
}

/** Evaluation from the point of view of the side to move at the analysed root. Exactly one field is set. */
export interface Score {
  cp?: number;
  /** Mate in N moves; positive = side to move mates, negative = side to move gets mated. */
  mate?: number;
}

export interface LineEval {
  /** First move (standard UCI). */
  move: string;
  score: Score;
  /** Principal variation in standard UCI, starting with `move`. */
  pv: string[];
  depth: number;
}

/**
 * Cached evaluation of one position by one engine build. Global (shared by profiles).
 * Produced by EnginePool.evaluatePosition: `ucinewgame`, a MultiPV-1 search for the best move, then one
 * `searchmoves <m>` search per requested move that is not the best move — same root, same depth.
 */
export interface PositionEval {
  /** `${engine}|${posKey}` */
  key: string;
  posKey: string;
  fen: string;
  /** Engine build id incl. eval version, e.g. 'sf19-lite@1'. */
  engine: string;
  depth: number;
  best: LineEval;
  /** Evaluations of specific moves keyed by standard UCI (includes best.move). */
  moves: Record<string, LineEval>;
  updatedAt: number;
}

export type Severity = 'inaccuracy' | 'mistake' | 'blunder';
export type MistakeStatus = 'active' | 'mastered' | 'ignored';
/** 'mistake' = a real recurring error; 'book' = a named-book move that is objectively dubious (gambits etc.). */
export type MistakeKind = 'mistake' | 'book';
/** What the profile played on its most recent visit to this position. */
export type LastOutcome = 'habit' | 'fixed' | 'other-bad' | 'unknown';

/** One visit of the profile to a position (compact: stored per mistake for live view filtering). */
export interface Occurrence {
  /** Game key. */
  g: string;
  /** playedAt (ms). */
  t: number;
  /** Speed. */
  s: Speed;
  /** Rated. */
  r: boolean;
  /** Outcome for the profile. */
  o: Outcome;
  /** Move played (standard UCI). */
  m: string;
}

export interface Refutation {
  /** Position after the opponent's habitual move (your turn). */
  fen: string;
  posKey: string;
  bestMove: string;
  bestLine: string[];
  score: Score;
  /** Your moves known to be acceptable here (loss < 5). */
  acceptable: string[];
  depth: number;
}

export interface Mistake {
  /** `${profileId}|${posKey}|${move}` — stable across re-analysis. */
  id: string;
  /** 10 hex chars of FNV-1a(posKey|move) — used in URLs. */
  shortId: string;
  profileId: string;
  color: Color;
  posKey: string;
  /** Full FEN of the position (for the board). */
  fen: string;
  ply: number;
  /** Standard UCI moves from the start position to this position (most recent occurrence). */
  path: string[];
  /** The habitual move (standard UCI). */
  move: string;
  kind: MistakeKind;
  /** Distinct games in which the profile played `move` here (all analysed games). */
  count: number;
  /** Distinct games in which the profile reached this position. */
  positionCount: number;
  /** Every visit to this position (all moves), newest first. Used for live view filters and progress. */
  occurrences: Occurrence[];
  bestMove: string;
  /** Moves that count as correct in training (evaluated loss < 5). Never contains `move`. */
  acceptable: string[];
  bestLine: string[];
  /** PV starting with the habitual move; playedLine[1] is the refutation. */
  playedLine: string[];
  scoreBest: Score;
  scorePlayed: Score;
  /** Win-percentage points lost by the habitual move (0..100). */
  winLoss: number;
  severity: Severity;
  /** 'low' when 5 <= winLoss < 7.5 (engine noise band). */
  confidence: 'normal' | 'low';
  /** Recency-weighted ranking key (see core/classify.ts impactOf). Recomputed under view filters. */
  impact: number;
  lastPlayedAt: number;
  lastOutcome: LastOutcome;
  /** Consecutive most-recent visits where an acceptable move was played. */
  fixedStreak: number;
  /** Id of an earlier mistake on this mistake's path (this position usually arises only after that error). */
  dependsOn?: string;
  openingEco?: string;
  openingName?: string;
  evalDepth: number;
  engine: string;
  status: MistakeStatus;
  ignoreReason?: 'repertoire' | 'other';
  /** Hidden from lists/training until this time (ms). */
  snoozedUntil?: number;
  /** No longer produced by the latest analysis (kept because it has training history). */
  dormant?: boolean;
  /** Opponent profiles only: the punishing reply. */
  refutation?: Refutation;
  createdAt: number;
  updatedAt: number;
}

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface ReviewState {
  mistakeId: string;
  profileId: string;
  /** ms epoch when the card is next due. */
  due: number;
  /** Days. */
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
  lastReviewedAt?: number;
  lastGrade?: Grade;
}

export interface Attempt {
  id?: number;
  mistakeId: string;
  profileId: string;
  at: number;
  grade: Grade;
}

/**
 * Per-account sync cursor. Lichess: the stored games cover [oldestCreatedAt, newestCreatedAt] contiguously.
 * Chess.com: monthly archives; a month is "done" only when fully consumed and before the previous UTC month.
 * Updated in the same transaction as the games it describes.
 */
export interface SyncState {
  /** `${profileId}|${platform}|${username.toLowerCase()}` */
  key: string;
  profileId: string;
  platform: OnlinePlatform;
  username: string;
  newestCreatedAt?: number;
  oldestCreatedAt?: number;
  /** True when the account's whole history (within the standard perf types) is covered. */
  reachedStart?: boolean;
  /** Chess.com archive URLs fully processed. */
  doneArchives?: string[];
  /** Games stored for this account. */
  stored: number;
  lastSyncAt?: number;
  lastError?: string;
}

export type AnalysisPreset = 'quick' | 'standard' | 'thorough';

export interface Settings {
  /** Plies of each game to analyse (default 20 = first 10 moves each). */
  openingPlies: number;
  preset: AnalysisPreset;
  /** Advanced overrides (0 = use preset). */
  depthOverride: number;
  /** Number of engine workers (0 = auto). */
  engineWorkers: number;
  /** Most recent games kept per account (the first sync fetches min(300, this) first, then backfills). */
  gamesPerAccount: number;
  /** Training: cards per session and new cards per day. */
  sessionSize: number;
  newPerDay: number;
  /** Replay the last N plies before each training card (0 = off). */
  replayPlies: number;
  /** Sync automatically when the app opens and the last sync is older than 6 h. */
  autoSync: boolean;
  theme: 'system' | 'light' | 'dark';
  /** Result of navigator.storage.persist(), if requested. */
  storagePersisted?: boolean;
  /** ms of the last backup export. */
  lastBackupAt?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  openingPlies: 20,
  preset: 'standard',
  depthOverride: 0,
  engineWorkers: 0,
  gamesPerAccount: 1000,
  sessionSize: 10,
  newPerDay: 5,
  replayPlies: 6,
  autoSync: true,
  theme: 'system',
};

/**
 * The values the Settings page offers. Settings from outside (a backup file) are sanitised to these
 * (db/backup.ts sanitizeSettings). Ranges are inclusive; `step` is the RangeField step.
 */
export const SETTING_RANGES = {
  openingPlies: { min: 10, max: 40, step: 2 },
  sessionSize: { min: 5, max: 30, step: 1 },
  newPerDay: { min: 0, max: 20, step: 1 },
  replayPlies: { min: 0, max: 12, step: 1 },
  /** 0 = automatic; the pool never uses more workers than there are cores. */
  engineWorkers: { min: 0, max: 32, step: 1 },
} as const;
/** Confirm-depth choices (0 = from the preset). */
export const DEPTH_OVERRIDE_OPTIONS: readonly number[] = [0, 8, 10, 12, 14, 16, 18, 20, 22];
export const GAMES_PER_ACCOUNT_OPTIONS: readonly number[] = [300, 1000, 3000, 10000];
export const ANALYSIS_PRESETS: readonly AnalysisPreset[] = ['quick', 'standard', 'thorough'];
export const THEMES: readonly Settings['theme'][] = ['system', 'light', 'dark'];

/** Live view filters (UI state, persisted in localStorage; never trigger re-analysis). */
export interface ViewFilters {
  color: Color | 'both';
  speeds: Speed[];
  ratedOnly: boolean;
  /** Only games played after this time (ms), 0 = all. */
  since: number;
  minGames: number;
  minSeverity: Severity;
  showLowConfidence: boolean;
  showBook: boolean;
  opening: string | null;
  query: string;
  sort: 'impact' | 'frequency' | 'loss' | 'recent' | 'due';
}

export const DEFAULT_FILTERS: ViewFilters = {
  color: 'both',
  speeds: ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown'],
  ratedOnly: false,
  since: 0,
  minGames: 2,
  minSeverity: 'inaccuracy',
  showLowConfidence: false,
  showBook: false,
  opening: null,
  query: '',
  sort: 'impact',
};

export interface SyncProgress {
  profileId: string;
  phase: 'idle' | 'running' | 'done' | 'error' | 'cancelled' | 'cooldown';
  account?: Account;
  /** Games received from the current account in this run. */
  fetched: number;
  /** New games stored in this run (all accounts). */
  added: number;
  /** What `fetched` should reach when the current request ends, when known (progress bar and ETA). */
  expected?: number;
  /** ms epoch when a rate-limit cooldown ends. */
  cooldownUntil?: number;
  message?: string;
  error?: string;
  errorKind?: SourceErrorKind;
}

export type SourceErrorKind = 'not-found' | 'closed' | 'rate-limited' | 'network' | 'http' | 'aborted' | 'unknown';

export interface AnalysisProgress {
  profileId: string;
  phase: 'idle' | 'preparing' | 'evaluating' | 'done' | 'error' | 'cancelled';
  gamesUsed: number;
  totalPositions: number;
  donePositions: number;
  /** Sum of candidate weights analysed / total — progress by importance. */
  weightDone: number;
  weightTotal: number;
  cacheHits: number;
  engineEvals: number;
  mistakesFound: number;
  startedAt: number;
  etaMs?: number;
  error?: string;
}

/** A mistake as shown under the current view filters. */
export interface ViewMistake extends Mistake {
  /** Games with the habit move after filters. */
  viewCount: number;
  /** Games reaching the position after filters. */
  viewPositionCount: number;
  viewImpact: number;
  /** Profile's score (0..1) in filtered games where it played the habit move, and in all filtered games here. */
  habitScore: number | null;
  positionScore: number | null;
}

export interface SessionCard {
  mistake: Mistake;
  review?: ReviewState;
  isNew: boolean;
}

export type MoveVerdict =
  | { kind: 'correct'; best: boolean; line?: LineEval }
  | { kind: 'low-confidence'; loss: number; line?: LineEval }
  | { kind: 'habit' }
  | { kind: 'wrong'; loss: number; line?: LineEval }
  | { kind: 'unknown' };
