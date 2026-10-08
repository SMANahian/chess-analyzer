// Toasts. <NoticeHost/> (mounted once by the app) shows store.notice; pages raise one with
// toast(kind, text, action?) from hooks.ts, e.g. toast('success', 'Snoozed for 30 days', { label: 'Undo', run: undo }).
// <Banner/> is the inline (in-page) variant for persistent messages.
import type { ComponentChildren, JSX, Ref } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { toastFocusOf } from './hooks';
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
export function ToastView({ kind, children, action, onClose, actionRef }: ToastViewProps & { actionRef?: Ref<HTMLButtonElement> }): JSX.Element {
  return (
    <div class={`toast toast-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={ICONS[kind]} class="toast-icon" />
      <div class="toast-text">{children}</div>
      {action ? (
        <button type="button" class="btn btn-sm toast-action" ref={actionRef} onClick={() => action.run()}>
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

/**
 * Toast area; `children` are extra toasts shown above the store notice (e.g. the update prompt).
 * Auto-hide pauses while the pointer is over a toast or focus is in one. A toast raised from the
 * keyboard can take focus (toast(…, { focusAction: true })); closing it hands focus back.
 */
export function NoticeHost({ children }: { children?: ComponentChildren }): JSX.Element {
  const n = store.notice.value;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  const paused = hovered || focused;
  useEffect(() => {
    if (!n || n.kind === 'error' || paused) return;
    const id = setTimeout(() => {
      if (store.notice.value === n) close(false);
    }, n.action ? AUTO_HIDE_MS.withAction : AUTO_HIDE_MS.plain);
    return () => clearTimeout(id);
  }, [n, paused]);
  useEffect(() => {
    if (n && toastFocusOf(n)?.focusAction) actionButton.current?.focus();
  }, [n]);
  /** Closes the store notice; when it held focus, focus goes back to the page instead of <body>. */
  const close = (byUser = true): void => {
    const current = store.notice.value;
    const hadFocus = !!region.current?.contains(document.activeElement);
    store.notice.value = null;
    setFocused(false);
    if (!hadFocus || !current) return;
    const target = toastFocusOf(current)?.returnFocus?.() ?? document.getElementById('main');
    if (target?.isConnected) target.focus({ preventScroll: !byUser });
  };
  return (
    <div
      class="toast-region"
      aria-live="polite"
      ref={region}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusIn={() => setFocused(true)}
      onFocusOut={e => setFocused(!!e.relatedTarget && !!region.current?.contains(e.relatedTarget as Node))}
    >
      {children}
      {n ? (
        <ToastView
          kind={n.kind}
          onClose={() => close()}
          actionRef={actionButton}
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
