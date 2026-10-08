// One row of the Leaks list: severity, the habit move ('6…Nxe4?'), "k of n games", opening, when it was
// last played and what happened then. Rows that only arise after an earlier mistake are indented under
// it ("after 6.Bc5?!"). Rows in the Mastered/Ignored/Snoozed tabs carry their status and a Restore button.
// Memoised: every prop is a primitive or a stable object, so changing a filter re-renders only the rows
// that changed.
import type { JSX } from 'preact';
import type { Mistake } from '../../core/types';
import { colorName, relativeTime } from './format';
import { Icon } from './Icon';
import { habitLabel, outcomeBadge, statusBadge, type Badge, type LeakTab } from './leakView';
import { memo } from './memo';
import { SeverityPill } from './SeverityPill';

export interface LeakListItemProps {
  m: Mistake;
  href: string;
  /** Games with the habit / reaching the position, under the view filters. */
  k: number;
  n: number;
  depth?: number;
  parent?: Mistake;
  selected?: boolean;
  /** The row in the Tab order (the list uses a roving tabindex: ↑/↓ move between rows). */
  tabbable?: boolean;
  now: number;
  /** A status tab (Mastered/Ignored/Snoozed): shows the status instead of the outcome, and a Restore button. */
  tab?: Exclude<LeakTab, 'active'>;
  /** Restore button handler (status tabs); keep it a stable function. */
  onRestore?(m: Mistake): void;
}

export function OutcomeBadge({ badge }: { badge: Badge | null }): JSX.Element | null {
  if (!badge) return null;
  return <span class={`badge badge-${badge.tone}`}>{badge.text}</span>;
}

function LeakListItemView({ m, href, k, n, depth = 0, parent, selected, tabbable = true, now, tab, onRestore }: LeakListItemProps): JSX.Element {
  return (
    <li class={`li-item${depth > 0 ? ' li-child' : ''}${selected ? ' is-selected' : ''}`} style={depth > 1 ? { '--depth': depth } : undefined}>
      <a class="li-row" href={href} aria-current={selected ? 'true' : undefined} data-short-id={m.shortId} tabIndex={tabbable ? 0 : -1}>
        <SeverityPill severity={m.severity} kind={m.kind} confidence={m.confidence} compact />
        <span class="li-main">
          {parent ? (
            <span class="li-after">
              <Icon name="back" size={12} class="li-after-icon" />
              after <span class="move">{habitLabel(parent)}</span>
            </span>
          ) : null}
          <span class="li-top">
            <span class="move move-habit li-move">{habitLabel(m)}</span>
            <span class="li-count num">
              {k} of {n} games
            </span>
          </span>
          <span class="li-sub">
            {m.openingName ?? 'Unnamed line'} · {colorName(m.color)}
          </span>
          <span class="li-meta">
            {tab ? (
              <OutcomeBadge badge={statusBadge(m, tab)} />
            ) : (
              <>
                <OutcomeBadge badge={outcomeBadge(m)} />
                <span class="li-when">{relativeTime(m.lastPlayedAt, now)}</span>
              </>
            )}
          </span>
        </span>
      </a>
      {tab && onRestore ? (
        <span class="li-action">
          <button type="button" class="btn btn-sm btn-ghost" onClick={() => onRestore(m)}>
            Restore
          </button>
        </span>
      ) : null}
    </li>
  );
}

export const LeakListItem = memo(LeakListItemView);
