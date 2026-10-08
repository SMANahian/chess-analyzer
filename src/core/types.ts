// Shared domain types. This file is the contract between core logic, sources, engine,
// storage, services and UI. Keep it dependency-free.

export type Color = 'white' | 'black';
export type Platform = 'lichess' | 'chesscom' | 'pgn';
export type OnlinePlatform = Exclude<Platform, 'pgn'>;
export type Speed = 'ultraBullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence' | 'unknown';
export type Outcome = 'win' | 'loss' | 'draw' | 'unknown';
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

/** Moves stored per game (UCI, from the standard start). analysis uses settings.openingPlies <= this. */
export const MAX_STORED_PLIES = 40;

export interface Account {
  platform: OnlinePlatform;
  /** As typed by the user; matching is case-insensitive. */
  username: string;
}

export interface Profile {
  id: string;
  /** Display name (defaults to the first username). */
  name: string;
  /** 'self' = the user's own games; 'opponent' = a scouted player. */
  kind: 'self' | 'opponent';
  accounts: Account[];
  /** Extra lower-cased names that identify this player in uploaded PGN files. */
  aliases: string[];
  createdAt: number;
  lastSyncAt?: number;
  lastAnalysisAt?: number;
}

/** A game as produced by a source (Lichess, Chess.com, PGN), before it is tied to a profile. */
export interface RawGame {
  platform: Platform;
  /** Stable id within the platform (Lichess game id, Chess.com uuid/url id, PGN content hash). */
  sourceId: string;
  url?: string;
  /** ms since epoch, 0 if unknown. */
  playedAt: number;
  white: string;
  black: string;
  whiteRating?: number;
  blackRating?: number;
  speed: Speed;
  rated: boolean;
  result: GameResult;
  /** First MAX_STORED_PLIES plies in standard UCI (castling as e1g1, promotions like e7e8q). */
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

/** Evaluation from the point of view of the side to move at the analysed root. */
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

export type EvalSource = 'cloud' | 'local';

/** Cached evaluation of one position. Global (not per profile). */
export interface PositionEval {
  /** Position key (see core/chess.ts posKey). */
  key: string;
  fen: string;
  source: EvalSource;
  /** Depth of the MultiPV search. */
  depth: number;
  /** Engine identifier, e.g. 'sf19-lite' or 'lichess-cloud'. */
  engine: string;
  /** MultiPV lines, best first. */
  lines: LineEval[];
  /** Extra single-move evaluations (searchmoves) keyed by standard UCI, same root, same depth. */
  moves: Record<string, LineEval>;
  updatedAt: number;
}

export type Severity = 'inaccuracy' | 'mistake' | 'blunder';
export type MistakeStatus = 'active' | 'mastered' | 'ignored';

export interface Mistake {
  /** `${profileId}|${posKey}|${move}` — stable across re-analysis. */
  id: string;
  profileId: string;
  color: Color;
  posKey: string;
  /** Full FEN of the position (for the board). */
  fen: string;
  /** Standard UCI moves from the start position to this position (most recent occurrence). */
  path: string[];
  /** The habitual move (standard UCI). */
  move: string;
  /** Times the profile played `move` here (within the analysed games). */
  count: number;
  /** Times the profile reached this position with the move (any move). */
  positionCount: number;
  bestMove: string;
  /** Moves that count as correct in training (win-% loss below the inaccuracy threshold). */
  acceptable: string[];
  bestLine: string[];
  /** PV starting with the habitual move; playedLine[1] is the refutation. */
  playedLine: string[];
  scoreBest: Score;
  scorePlayed: Score;
  /** Win-percentage points lost by the habitual move (0..100). */
  winLoss: number;
  severity: Severity;
  /** count * winLoss — ranking key. */
  impact: number;
  /** Most recent game keys (max 10) where `move` was played here, newest first. */
  gameKeys: string[];
  lastPlayedAt: number;
  /** Most recent time an acceptable move was played here in a real game. */
  lastCorrectAt?: number;
  openingEco?: string;
  openingName?: string;
  evalSource: EvalSource;
  evalDepth: number;
  status: MistakeStatus;
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

export interface SyncState {
  /** `${profileId}|${platform}|${username.toLowerCase()}` */
  key: string;
  profileId: string;
  platform: OnlinePlatform;
  username: string;
  /** Newest game time seen (ms). Lichess incremental sync uses since = this + 1. */
  newestGameAt?: number;
  /** Chess.com: archive URL -> ETag/Last-Modified of the last fetch. */
  archiveTags?: Record<string, string>;
  /** Chess.com: archive URLs fully processed (months that can no longer change). */
  doneArchives?: string[];
  lastSyncAt?: number;
  lastError?: string;
}

export interface Settings {
  /** Plies of each game to analyse (default 20 = first 10 moves each). */
  openingPlies: number;
  /** Minimum times the same move must be played in the same position. */
  minOccurrences: number;
  /** Minimum win-% loss to record a mistake (5 = inaccuracy). */
  minWinLoss: number;
  /** Local engine depth. */
  depth: number;
  /** MultiPV for local searches. */
  multiPv: number;
  /** Use the Lichess cloud evaluation database for common positions. */
  useCloudEval: boolean;
  /** Number of engine workers (0 = auto). */
  engineWorkers: number;
  /** Speeds included in analysis. */
  speeds: Speed[];
  ratedOnly: boolean;
  /** Most recent games downloaded per account per sync. */
  maxGamesPerAccount: number;
  theme: 'system' | 'light' | 'dark';
  /** Replay the moves leading to the position before each training card. */
  replayLine: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  openingPlies: 20,
  minOccurrences: 2,
  minWinLoss: 5,
  depth: 14,
  multiPv: 3,
  useCloudEval: true,
  engineWorkers: 0,
  speeds: ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'],
  ratedOnly: false,
  maxGamesPerAccount: 1000,
  theme: 'system',
  replayLine: true,
};

export interface SyncProgress {
  profileId: string;
  phase: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  account?: Account;
  /** Games received from the current account in this run. */
  fetched: number;
  /** New games stored in this run (all accounts). */
  added: number;
  message?: string;
  error?: string;
}

export interface AnalysisProgress {
  profileId: string;
  phase: 'idle' | 'preparing' | 'evaluating' | 'done' | 'error' | 'cancelled';
  gamesUsed: number;
  totalPositions: number;
  donePositions: number;
  cacheHits: number;
  cloudHits: number;
  localEvals: number;
  mistakesFound: number;
  startedAt: number;
  /** Estimated ms remaining. */
  etaMs?: number;
  error?: string;
}
