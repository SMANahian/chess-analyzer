// Stat tiles: a big number with a label and an optional detail line.
import type { ComponentChildren, JSX } from 'preact';

export interface StatProps {
  label: string;
  value: ComponentChildren;
  /** Small line under the value, e.g. "212 White · 188 Black". */
  detail?: ComponentChildren;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
  /** Makes the whole tile a link. */
  href?: string;
}

export function Stat({ label, value, detail, tone = 'neutral', href }: StatProps): JSX.Element {
  const body = (
    <>
      <span class="stat-label">{label}</span>
      <span class="stat-value num">{value}</span>
      {detail ? <span class="stat-detail">{detail}</span> : null}
    </>
  );
  return href ? (
    <a class={`stat stat-${tone} stat-link`} href={href}>
      {body}
    </a>
  ) : (
    <div class={`stat stat-${tone}`}>{body}</div>
  );
}

/** Responsive grid of Stat tiles (2 columns on phones, up to 4 on desktop). */
export function StatGrid({ children, label }: { children: ComponentChildren; label?: string }): JSX.Element {
  return (
    <div class="stat-grid" role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  );
}
