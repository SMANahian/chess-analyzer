// One row of the Leaks list: severity, the habit move ('6…Nxe4?'), "k of n games", opening, when it was
// last played and what happened then. Rows that only arise after an earlier mistake are indented under
// it ("after 6.Bc5?!"). Rows in the Mastered/Ignored/Snoozed tabs carry their status and a Restore button.
import type { ComponentChildren, JSX } from 'preact';
import type { Mistake } from '../../core/types';
import { colorName, relativeTime } from './format';
import { Icon } from './Icon';
import { habitLabel, outcomeBadge, type Badge } from './leakView';
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
  now: number;
  /** Replaces the outcome/last-played line (status rows). */
  status?: ComponentChildren;
  /** A button shown at the end of the row (e.g. Restore). */
  action?: ComponentChildren;
}

export function OutcomeBadge({ badge }: { badge: Badge | null }): JSX.Element | null {
  if (!badge) return null;
  return <span class={`badge badge-${badge.tone}`}>{badge.text}</span>;
}

export function LeakListItem({ m, href, k, n, depth = 0, parent, selected, now, status, action }: LeakListItemProps): JSX.Element {
  return (
    <li class={`li-item${depth > 0 ? ' li-child' : ''}${selected ? ' is-selected' : ''}`} style={depth > 1 ? { '--depth': depth } : undefined}>
      <a class="li-row" href={href} aria-current={selected ? 'true' : undefined} data-short-id={m.shortId}>
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
            {status ?? (
              <>
                <OutcomeBadge badge={outcomeBadge(m)} />
                <span class="li-when">{relativeTime(m.lastPlayedAt, now)}</span>
              </>
            )}
          </span>
        </span>
      </a>
      {action ? <span class="li-action">{action}</span> : null}
    </li>
  );
}
