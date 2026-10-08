// Promotion choice over the board (queen, knight, rook, bishop), stacked from the promotion square
// like on Lichess. Esc or a click outside cancels. Pieces reuse chessground's piece CSS (cburnett).
import { createElement, type JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { Role, SquareName } from 'chessops/types';
import type { Color } from '../../core/types';

const ROLES: readonly Role[] = ['queen', 'knight', 'rook', 'bishop'];
const NAMES: Readonly<Record<string, string>> = { queen: 'Queen', knight: 'Knight', rook: 'Rook', bishop: 'Bishop' };

export interface PromotionPickerProps {
  dest: SquareName;
  color: Color;
  orientation: Color;
  /** null = cancelled. */
  onPick(role: Role | null): void;
}

export function PromotionPicker({ dest, color, orientation, onPick }: PromotionPickerProps): JSX.Element {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const file = dest.charCodeAt(0) - 97;
  const rank = Number(dest[1]) - 1;
  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank; // 0 = top edge
  const downward = row === 0;
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onPick(null);
    }
  };
  return (
    <div class="promo cg-wrap" role="dialog" aria-label="Promote to" onKeyDown={onKeyDown} onClick={() => onPick(null)}>
      {ROLES.map((role, i) => (
        <button
          key={role}
          ref={i === 0 ? first : undefined}
          type="button"
          class="promo-choice"
          style={{ left: `${col * 12.5}%`, top: `${(downward ? i : 7 - i) * 12.5}%` }}
          aria-label={NAMES[role]}
          onClick={e => {
            e.stopPropagation();
            onPick(role);
          }}
        >
          {createElement('piece', { class: `${role} ${color}` })}
        </button>
      ))}
    </div>
  );
}
