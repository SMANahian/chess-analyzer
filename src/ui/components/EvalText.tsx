// Evaluation from the USER's side, in numbers and words: "You: +0.3 → −0.8 (slightly worse)".
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

export function EvalText({ from, to, sideToMove, user, who = 'You' }: EvalTextProps): JSX.Element {
  const a = scoreFor(from, sideToMove, user);
  const words = evalWords(scoreForColor(to ?? from, sideToMove, user));
  if (!to) {
    return (
      <span class="eval" aria-label={`${who}: ${a}, ${words}`}>
        <span class="eval-who">{who}:</span> <span class="num">{a}</span> <span class="eval-words">({words})</span>
      </span>
    );
  }
  const b = scoreFor(to, sideToMove, user);
  return (
    <span class="eval" aria-label={`${who}: ${a} with the best move, ${b} after this move — ${words}`}>
      <span class="eval-who">{who}:</span> <span class="num">{a}</span> <span aria-hidden="true">→</span>{' '}
      <span class="num eval-after">{b}</span> <span class="eval-words">({words})</span>
    </span>
  );
}
