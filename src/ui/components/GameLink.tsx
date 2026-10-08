// Link to a game on Lichess (at a ply, from the player's side) or Chess.com; plain text for PGN imports.
import type { ComponentChildren, JSX } from 'preact';
import type { Color } from '../../core/types';
import { gameUrl, parseGameKey, platformName, type GameRef } from './format';
import { Icon } from './Icon';

export interface GameLinkProps {
  /** A StoredGame (or anything with platform/sourceId/url), or a game key (Occurrence.g). */
  game: GameRef | string;
  /** Plies played when the board should open (Lichess only): Mistake.ply = before the habit move. */
  ply?: number;
  /** Board orientation on Lichess. */
  color?: Color;
  children?: ComponentChildren;
}

export function GameLink({ game, ply, color, children }: GameLinkProps): JSX.Element {
  const ref = typeof game === 'string' ? parseGameKey(game) : game;
  const url = ref ? gameUrl(ref, { ply, color }) : undefined;
  const text = children ?? (ref ? `View on ${platformName(ref.platform)}` : 'Game');
  if (!url) return <span class="game-link game-link-plain">{children ?? 'Imported game'}</span>;
  return (
    <a class="game-link" href={url} target="_blank" rel="noopener noreferrer">
      {text}
      <Icon name="external" size={14} />
      <span class="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
