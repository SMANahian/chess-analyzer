// Horizontal swipe detection for touch screens (next / previous item), ignoring vertical scrolls and
// gestures that start on interactive elements such as the board.
import { useEffect, useRef } from 'preact/hooks';

/** px the finger must travel horizontally, and how much more horizontal than vertical the gesture must be. */
const MIN_DISTANCE = 60;
const DIRECTIONALITY = 1.6;
const IGNORE = '.board, input, select, textarea, button, a, [role="slider"]';

export function useSwipe<T extends HTMLElement>(handlers: { onLeft?(): void; onRight?(): void }, enabled = true): { current: T | null } {
  const ref = useRef<T | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      const target = e.target instanceof Element ? e.target : null;
      start = t && e.touches.length === 1 && !target?.closest(IGNORE) ? { x: t.clientX, y: t.clientY } : null;
    };
    const onEnd = (e: TouchEvent): void => {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start = null;
      if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * DIRECTIONALITY) return;
      if (dx < 0) latest.current.onLeft?.();
      else latest.current.onRight?.();
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, [enabled]);
  return ref;
}

/** True when a key event comes from a text field (shortcuts must not fire while typing). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Single-key shortcuts only: no Ctrl/Cmd/Alt combinations, not while typing, not inside a dialog. */
export function isShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (isTypingTarget(e.target)) return false;
  return !(typeof Element !== 'undefined' && e.target instanceof Element && e.target.closest('dialog[open]'));
}

/** Character keys used as shortcuts (j, k, f, ?, h, Space): only when the user has them turned on. */
export const CHARACTER_SHORTCUTS: ReadonlySet<string> = new Set(['j', 'k', 'f', '?', 'h', ' ']);

/**
 * isShortcut, plus: a character key counts only while single-key shortcuts are on (`enabled`,
 * Settings → Appearance). Other keys (arrows, Escape, Enter) are not affected by the setting.
 */
export function isKeyShortcut(e: KeyboardEvent, enabled: boolean): boolean {
  if (!isShortcut(e)) return false;
  return enabled || !CHARACTER_SHORTCUTS.has(e.key);
}

/** The key event's target is the page itself (nothing focused), not a control. */
export function isPageTarget(target: EventTarget | null): boolean {
  return typeof document !== 'undefined' && (target === document.body || target === document.documentElement || target === document);
}
