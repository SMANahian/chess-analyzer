// Pure formatting helpers for UI copy (no DOM). Everything user-facing reads from the USER's side.
import { posFromFen, sanOf } from '../../core/chess';
import { formatScore, scoreForColor } from '../../core/winrate';
import type { Color, Platform, Score, Speed } from '../../core/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ELLIPSIS = '…';

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** plural(1, 'game') → '1 game'; plural(3, 'leak') → '3 leaks'; plural(2, 'match', 'matches'). */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** 0.456 → '46%'. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** '5 min ago', '3 days ago', 'in 2 h'; 'never' for 0/undefined. */
export function relativeTime(ms: number | undefined, now: number): string {
  if (!ms) return 'never';
  const diff = now - ms;
  const abs = Math.abs(diff);
  const ago = (s: string): string => (diff >= 0 ? `${s} ago` : `in ${s}`);
  if (abs < MINUTE) return 'just now';
  if (abs < HOUR) return ago(`${Math.floor(abs / MINUTE)} min`);
  if (abs < DAY) return ago(`${Math.floor(abs / HOUR)} h`);
  const days = Math.floor(abs / DAY);
  if (days === 1) return diff >= 0 ? 'yesterday' : 'tomorrow';
  if (days < 14) return ago(`${days} days`);
  if (days < 60) return ago(`${Math.floor(days / 7)} weeks`);
  if (days < 730) return ago(`${Math.floor(days / 30)} months`);
  return ago(`${Math.floor(days / 365)} years`);
}

/** Remaining-time copy for progress: 'less than a minute', 'about 4 min', 'about 1 h 20 min'. */
export function formatEta(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 45_000) return 'less than a minute';
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

/** Countdown copy: '45 s', '1:05'. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The move as a chess player writes it in a sentence: '6…Nxe4', '7.Qe2'. Falls back to the UCI string. */
export function moveLabel(fen: string, uci: string): string {
  const san = sanOf(fen, uci);
  if (!san) return uci;
  const parts = fen.split(' ');
  const moveNo = Number(parts[5]) || 1;
  return parts[1] === 'b' ? `${moveNo}${ELLIPSIS}${san}` : `${moveNo}.${san}`;
}

/** Which side moves in `fen` ('white' for an unparsable FEN). */
export function sideToMove(fen: string): Color {
  return posFromFen(fen)?.turn ?? 'white';
}

/** Plain-language assessment of a score from the viewer's side (cp thresholds as on Lichess-style eval bars). */
export function evalWords(s: Score): string {
  if (s.mate !== undefined) {
    if (s.mate > 0) return `mate in ${s.mate}`;
    return s.mate === 0 ? 'checkmated' : `gets mated in ${-s.mate}`;
  }
  const cp = s.cp ?? 0;
  const abs = Math.abs(cp);
  if (abs <= 30) return 'about equal';
  const side = cp > 0 ? 'better' : 'worse';
  if (abs <= 80) return `slightly ${side}`;
  if (abs <= 180) return side;
  if (abs <= 400) return `clearly ${side}`;
  return cp > 0 ? 'winning' : 'losing';
}

/** A side-to-move score as '+0.30' from `viewer`'s side. */
export function scoreFor(s: Score, sideToMoveColor: Color, viewer: Color): string {
  return formatScore(scoreForColor(s, sideToMoveColor, viewer));
}

const COLOR_NAMES: Readonly<Record<Color, string>> = { white: 'White', black: 'Black' };
export const colorName = (c: Color): string => COLOR_NAMES[c];

const SPEED_NAMES: Readonly<Record<Speed, string>> = {
  ultraBullet: 'UltraBullet',
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  correspondence: 'Daily',
  unknown: 'Other',
};
export const speedName = (s: Speed): string => SPEED_NAMES[s];

const PLATFORM_NAMES: Readonly<Record<Platform, string>> = { lichess: 'Lichess', chesscom: 'Chess.com', pgn: 'PGN file' };
export const platformName = (p: Platform): string => PLATFORM_NAMES[p];

export interface GameRef {
  platform: Platform;
  sourceId: string;
  url?: string;
}

/** `${profileId}|${platform}:${sourceId}` (StoredGame.key / Occurrence.g) → platform + sourceId. */
export function parseGameKey(key: string): GameRef | undefined {
  const bar = key.lastIndexOf('|');
  const rest = key.slice(bar + 1);
  const colon = rest.indexOf(':');
  if (bar < 0 || colon < 0) return undefined;
  const platform = rest.slice(0, colon);
  if (platform !== 'lichess' && platform !== 'chesscom' && platform !== 'pgn') return undefined;
  return { platform, sourceId: rest.slice(colon + 1) };
}

/**
 * Link to a game on its site. Lichess: board from `color`'s side at `ply` (plies played, so
 * Mistake.ply shows the position before the habit move and ply + 1 the position after it).
 * Chess.com: the game page. PGN imports: undefined.
 */
export function gameUrl(game: GameRef, opts: { ply?: number; color?: Color } = {}): string | undefined {
  if (game.platform === 'lichess') {
    const id = game.sourceId.slice(0, 8);
    if (!/^[A-Za-z0-9]{8}$/.test(id)) return game.url;
    const side = opts.color === 'black' ? '/black' : '';
    const anchor = opts.ply !== undefined && opts.ply > 0 ? `#${opts.ply}` : '';
    return `https://lichess.org/${id}${side}${anchor}`;
  }
  if (game.platform === 'chesscom') {
    if (game.url) return game.url;
    return /^(live|daily)\/\d+$/.test(game.sourceId) ? `https://www.chess.com/game/${game.sourceId}` : undefined;
  }
  return undefined;
}

/** 'YYYY-MM-DD' (UTC) for file names. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 'Mar 5, 2024' style date. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
