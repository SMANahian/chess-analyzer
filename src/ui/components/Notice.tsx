// Toasts. <NoticeHost/> (mounted once by the app) shows store.notice; pages raise one with
// toast(kind, text, action?) from hooks.ts, e.g. toast('success', 'Snoozed for 30 days', { label: 'Undo', run: undo }).
// <Banner/> is the inline (in-page) variant for persistent messages.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { Icon, type IconName } from './Icon';

const ICONS: Readonly<Record<store.Notice['kind'], IconName>> = { info: 'about', success: 'check', error: 'alert' };
/** Errors stay until dismissed; others fade after a while (longer when there is an action to take). */
const AUTO_HIDE_MS = { plain: 6000, withAction: 10000 } as const;

export interface ToastViewProps {
  kind: store.Notice['kind'];
  children: ComponentChildren;
  action?: { label: string; run(): void };
  onClose?(): void;
}

/** Presentational toast (also used for the "update available" prompt). */
export function ToastView({ kind, children, action, onClose }: ToastViewProps): JSX.Element {
  return (
    <div class={`toast toast-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={ICONS[kind]} class="toast-icon" />
      <div class="toast-text">{children}</div>
      {action ? (
        <button type="button" class="btn btn-sm toast-action" onClick={() => action.run()}>
          {action.label}
        </button>
      ) : null}
      {onClose ? (
        <button type="button" class="btn btn-ghost btn-icon btn-sm toast-close" onClick={onClose} aria-label="Dismiss">
          <Icon name="close" size={18} />
        </button>
      ) : null}
    </div>
  );
}

/** Toast area; `children` are extra toasts shown above the store notice (e.g. the update prompt). */
export function NoticeHost({ children }: { children?: ComponentChildren }): JSX.Element {
  const n = store.notice.value;
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!n || n.kind === 'error' || paused) return;
    const id = setTimeout(() => {
      if (store.notice.value === n) store.notice.value = null;
    }, n.action ? AUTO_HIDE_MS.withAction : AUTO_HIDE_MS.plain);
    return () => clearTimeout(id);
  }, [n, paused]);
  const close = (): void => {
    store.notice.value = null;
  };
  return (
    <div
      class="toast-region"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusIn={() => setPaused(true)}
      onFocusOut={() => setPaused(false)}
    >
      {children}
      {n ? (
        <ToastView
          kind={n.kind}
          onClose={close}
          action={
            n.action
              ? {
                  label: n.action.label,
                  run: () => {
                    close();
                    n.action?.run();
                  },
                }
              : undefined
          }
        >
          {n.text}
        </ToastView>
      ) : null}
    </div>
  );
}

export interface BannerProps {
  tone?: 'info' | 'warn' | 'danger' | 'good';
  icon?: IconName;
  title?: ComponentChildren;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  onDismiss?(): void;
}

/** In-page message box (backup reminder, errors with a retry, explanations). */
export function Banner({ tone = 'info', icon, title, children, actions, onDismiss }: BannerProps): JSX.Element {
  const defaultIcon: IconName = tone === 'good' ? 'check' : tone === 'info' ? 'about' : 'alert';
  return (
    <div class={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon ?? defaultIcon} class="banner-icon" size={22} />
      <div class="banner-main">
        {title ? <p class="banner-title">{title}</p> : null}
        {children ? <div class="banner-text">{children}</div> : null}
        {actions ? <div class="banner-actions">{actions}</div> : null}
      </div>
      {onDismiss ? (
        <button type="button" class="btn btn-ghost btn-icon btn-sm banner-close" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="close" size={18} />
        </button>
      ) : null}
    </div>
  );
}
