// Loading placeholders that keep the final layout's size (no jump when the content arrives).
import type { JSX } from 'preact';

/** A shimmering block; `width` as CSS (e.g. '60%'), height in px. */
export function Skeleton({ width = '100%', height = 14, round = false }: { width?: string; height?: number; round?: boolean }): JSX.Element {
  return <span class={`skeleton${round ? ' skeleton-round' : ''}`} style={{ width, height: `${height}px` }} aria-hidden="true" />;
}

/** List rows like the leak lists ("Loading" for screen readers once). */
export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }): JSX.Element {
  return (
    <div class="skeleton-rows" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div class="skeleton-row" key={i}>
          <Skeleton width="28px" height={24} round />
          <span class="skeleton-lines">
            <Skeleton width={`${55 + ((i * 17) % 30)}%`} height={16} />
            <Skeleton width={`${35 + ((i * 23) % 35)}%`} height={12} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** A square board placeholder of the board's size. */
export function SkeletonBoard(): JSX.Element {
  return <div class="skeleton skeleton-board" aria-hidden="true" />;
}
