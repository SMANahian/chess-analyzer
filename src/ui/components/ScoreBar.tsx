// A result score (0..1, win = 1, draw = ½) as a percentage with a small bar, coloured by how it went.
import type { JSX } from 'preact';
import { formatPercent } from './format';

export interface ScoreBarProps {
  /** 0..1, or null when no game has a known result. */
  score: number | null;
  /** Visually hidden prefix for screen readers, e.g. "Score with 6…Nxe4". */
  label?: string;
  /** Show the number only (no bar). */
  compact?: boolean;
}

export function scoreTone(score: number): 'good' | 'neutral' | 'bad' {
  if (score >= 0.55) return 'good';
  if (score < 0.45) return 'bad';
  return 'neutral';
}

export function ScoreBar({ score, label, compact = false }: ScoreBarProps): JSX.Element {
  if (score === null) return <span class="score-bar score-none muted">—</span>;
  const tone = scoreTone(score);
  return (
    <span class={`score-bar score-${tone}`}>
      {label ? <span class="sr-only">{label}: </span> : null}
      <span class="score-num num">{formatPercent(score)}</span>
      {compact ? null : (
        <span class="score-track" aria-hidden="true">
          <span class="score-fill" style={{ width: `${Math.round(score * 100)}%` }} />
        </span>
      )}
    </span>
  );
}
