// Friendly empty / zero-result state with an optional action.
import type { ComponentChildren, JSX } from 'preact';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  children?: ComponentChildren;
  /** Buttons / links. */
  actions?: ComponentChildren;
  /** 'success' tints the icon green (e.g. "No leaks found — nice!"). */
  tone?: 'neutral' | 'success';
  /** 1 when the empty state is the whole page (it then carries the page's h1), default 2. */
  headingLevel?: 1 | 2;
}

export function EmptyState({ icon = 'sparkle', title, children, actions, tone = 'neutral', headingLevel = 2 }: EmptyStateProps): JSX.Element {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <div class={`empty-state empty-${tone}`}>
      <span class="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <Heading class="empty-title">{title}</Heading>
      {children ? <div class="empty-body">{children}</div> : null}
      {actions ? <div class="empty-actions">{actions}</div> : null}
    </div>
  );
}
