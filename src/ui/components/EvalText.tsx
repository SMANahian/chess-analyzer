// Evaluation from the USER's side, in numbers and words: "You: +0.3 → −0.8 (slightly worse)".
// Screen readers get the same sentence with the meaning of each number spelled out
// ("You: +0.30 with the best move, −0.80 after this move (slightly worse)"); the arrow is hidden.
import type { JSX } from 'preact';
import { scoreForColor } from '../../core/winrate';
import type { Color, Score } from '../../core/types';
import { evalWords, scoreFor } from './format';

export interface EvalTextProps {
  /** Side-to-move score before (usually Mistake.scoreBest: what the position is worth with the best move). */
  from: Score;
  /** Side-to-move score after the move in question (usually Mistake.scorePlayed). Omit to show one score. */
  to?: Score;
  /** Side to move at the analysed root (the scores' point of view). */
  sideToMove: Color;
  /** The user's colour: numbers and words are from this side. */
  user: Color;
  /** Prefix, default 'You'. */
  who?: string;
}

/** One piece of the eval text: shown to everyone, to screen readers only ('sr'), or only visually ('visual'). */
export interface EvalPart {
  text: string;
  class?: string;
  only?: 'sr' | 'visual';
}

/** Pure: the pieces EvalText renders. */
export function evalParts({ from, to, sideToMove, user, who = 'You' }: EvalTextProps): EvalPart[] {
  const a = scoreFor(from, sideToMove, user);
  const words = evalWords(scoreForColor(to ?? from, sideToMove, user));
  const head: EvalPart[] = [{ text: `${who}:`, class: 'eval-who' }, { text: ' ' }, { text: a, class: 'num' }];
  if (!to) return [...head, { text: ' ' }, { text: `(${words})`, class: 'eval-words' }];
  return [
    ...head,
    { text: ' with the best move,', only: 'sr' },
    { text: ' ' },
    { text: '→', only: 'visual' },
    { text: ' ', only: 'visual' },
    { text: scoreFor(to, sideToMove, user), class: 'num eval-after' },
    { text: ' after this move', only: 'sr' },
    { text: ' ' },
    { text: `(${words})`, class: 'eval-words' },
  ];
}

/** What a screen reader reads (the visual-only parts left out). */
export const evalSpoken = (parts: readonly EvalPart[]): string =>
  parts
    .filter(p => p.only !== 'visual')
    .map(p => p.text)
    .join('');

export function EvalText(props: EvalTextProps): JSX.Element {
  return (
    <span class="eval">
      {evalParts(props).map((p, i) => {
        const cls = [p.class, p.only === 'sr' ? 'sr-only' : ''].filter(Boolean).join(' ');
        if (!cls && !p.only) return p.text;
        return (
          <span key={i} class={cls || undefined} aria-hidden={p.only === 'visual' ? 'true' : undefined}>
            {p.text}
          </span>
        );
      })}
    </span>
  );
}
