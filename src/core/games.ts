// RawGame → StoredGame: duplicate keys, outcome and attribution of a game to a profile.
import type { Account, Color, GameResult, Outcome, Profile, RawGame, StoredGame } from './types';

export type Attribution = { color: Color } | { color: null; reason: 'no-match' | 'both-match' };

function utcDay(ms: number): string {
  if (!ms) return '?';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '?' : d.toISOString().slice(0, 10);
}

/** Cross-source duplicate key: lower-cased names, UTC day ('?' when unknown) and the stored moves. */
export function contentKey(raw: Pick<RawGame, 'white' | 'black' | 'playedAt' | 'moves'>): string {
  return `${raw.white.toLowerCase()}|${raw.black.toLowerCase()}|${utcDay(raw.playedAt)}|${raw.moves.join(' ')}`;
}

/** `${profileId}|${platform}:${sourceId}` — the StoredGame primary key. */
export function gameKey(profileId: string, raw: Pick<RawGame, 'platform' | 'sourceId'>): string {
  return `${profileId}|${raw.platform}:${raw.sourceId}`;
}

export function outcomeFor(result: GameResult, color: Color): Outcome {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return color === 'white' ? 'win' : 'loss';
  if (result === '0-1') return color === 'black' ? 'win' : 'loss';
  return 'unknown';
}

const norm = (name: string | undefined): string => (name ?? '').trim().toLowerCase();

function decide(white: boolean, black: boolean): Attribution {
  if (white && black) return { color: null, reason: 'both-match' };
  if (white) return { color: 'white' };
  if (black) return { color: 'black' };
  return { color: null, reason: 'no-match' };
}

/** API games: only the queried account, by platform user id first, then by display name. */
function attributeToAccount(raw: RawGame, account: Account): Attribution {
  const user = norm(account.username);
  if (user === '') return decide(false, false);
  const byId = decide(norm(raw.whiteId) === user, norm(raw.blackId) === user);
  if (byId.color !== null || byId.reason === 'both-match') return byId;
  return decide(norm(raw.white) === user, norm(raw.black) === user);
}

/** PGN games: any alias or any account username, against the names (and ids when present). */
function attributeByNames(raw: RawGame, profile: Profile): Attribution {
  const names = new Set([...profile.aliases, ...profile.accounts.map(a => a.username)].map(norm));
  names.delete('');
  const matches = (name: string, id: string | undefined): boolean =>
    names.has(norm(name)) || (id !== undefined && names.has(norm(id)));
  return decide(matches(raw.white, raw.whiteId), matches(raw.black, raw.blackId));
}

/**
 * Attributes a raw game to a profile. `account` = the account that was queried (API games), or
 * undefined for PGN imports. Returns a reason instead of a colour when neither or both sides match.
 */
export function attribute(raw: RawGame, profile: Profile, account?: Account): Attribution {
  return account ? attributeToAccount(raw, account) : attributeByNames(raw, profile);
}

export function toStoredGame(raw: RawGame, profileId: string, color: Color): StoredGame {
  const asWhite = color === 'white';
  const game: StoredGame = {
    key: gameKey(profileId, raw),
    profileId,
    platform: raw.platform,
    sourceId: raw.sourceId,
    contentKey: contentKey(raw),
    playedAt: raw.playedAt,
    color,
    opponent: asWhite ? raw.black : raw.white,
    speed: raw.speed,
    rated: raw.rated,
    outcome: outcomeFor(raw.result, color),
    moves: raw.moves.join(' '),
  };
  const playerRating = asWhite ? raw.whiteRating : raw.blackRating;
  const opponentRating = asWhite ? raw.blackRating : raw.whiteRating;
  if (raw.url !== undefined) game.url = raw.url;
  if (playerRating !== undefined) game.playerRating = playerRating;
  if (opponentRating !== undefined) game.opponentRating = opponentRating;
  if (raw.plyCount !== undefined) game.plyCount = raw.plyCount;
  return game;
}
