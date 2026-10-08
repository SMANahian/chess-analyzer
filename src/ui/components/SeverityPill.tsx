// Severity badge: glyph + word + colour (never colour alone). Book choices and low confidence are labelled too.
import type { JSX } from 'preact';
import type { MistakeKind, Severity } from '../../core/types';
import { Icon } from './Icon';

export const SEVERITY_GLYPH: Readonly<Record<Severity, string>> = { inaccuracy: '?!', mistake: '?', blunder: '??' };
export const SEVERITY_WORD: Readonly<Record<Severity, string>> = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };

export interface SeverityPillProps {
  severity: Severity;
  /** 'book' renders a "Book choice" pill instead (dubious but named opening move). */
  kind?: MistakeKind;
  /** 'low' adds "borderline" (5–7.5 win-% loss: within engine noise). */
  confidence?: 'normal' | 'low';
  /** Glyph only (keeps the word for screen readers) — for dense lists. */
  compact?: boolean;
}

export function SeverityPill({ severity, kind = 'mistake', confidence = 'normal', compact = false }: SeverityPillProps): JSX.Element {
  if (kind === 'book') {
    return (
      <span class="pill pill-book" title="A named opening move that the engine dislikes">
        <Icon name="openings" size={14} class="pill-glyph" />
        <span class={compact ? 'sr-only' : undefined}>Book choice</span>
      </span>
    );
  }
  const word = SEVERITY_WORD[severity];
  const borderline = confidence === 'low';
  return (
    <span class={`pill pill-${severity}${borderline ? ' pill-borderline' : ''}`} title={borderline ? `${word} (borderline: within engine noise)` : word}>
      <span class="pill-glyph" aria-hidden="true">
        {SEVERITY_GLYPH[severity]}
      </span>
      <span class={compact ? 'sr-only' : undefined}>
        {word}
        {borderline ? <span class="pill-note"> · borderline</span> : null}
      </span>
    </span>
  );
}
