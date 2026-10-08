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
}

export function EmptyState({ icon = 'sparkle', title, children, actions, tone = 'neutral' }: EmptyStateProps): JSX.Element {
  return (
    <div class={`empty-state empty-${tone}`}>
      <span class="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h2 class="empty-title">{title}</h2>
      {children ? <div class="empty-body">{children}</div> : null}
      {actions ? <div class="empty-actions">{actions}</div> : null}
    </div>
  );
}
