// Indeterminate progress indicator. Always pair with text (the label is read by screen readers).
import type { JSX } from 'preact';

export interface SpinnerProps {
  /** Accessible label, default 'Loading'. Pass '' when visible text next to it already says it. */
  label?: string;
  /** px, default 20. */
  size?: number;
}

export function Spinner({ label = 'Loading', size = 20 }: SpinnerProps): JSX.Element {
  const a11y = label ? { role: 'status' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} {...a11y}>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-opacity="0.22" stroke-width="3" />
        <path d="M21.5 12A9.5 9.5 0 0 0 12 2.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
      </svg>
    </span>
  );
}
