// Keyboard preferences and state shared by pages:
// - the single-key shortcuts setting (j/k/f/?/h/Space), per device in localStorage, on by default
//   (WCAG 2.1.4: character-key shortcuts can be turned off);
// - whether the last interaction was a key press (focus moves made for keyboard users, such as into
//   the move input, must not open the on-screen keyboard of a touch user).
import { signal, type ReadonlySignal } from '@preact/signals';

export const SHORTCUTS_STORAGE_KEY = 'ca:shortcuts';

function storedShortcuts(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

const shortcuts = signal(typeof localStorage === 'undefined' ? true : storedShortcuts());
/** Single-key shortcuts are on (Settings → Appearance). */
export const shortcutsOn: ReadonlySignal<boolean> = shortcuts;

export function setShortcutsOn(on: boolean): void {
  shortcuts.value = on;
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode / storage disabled: the choice lasts for this session.
  }
}

let keyboardLast = false;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (keyboardLast = true), true);
  document.addEventListener('pointerdown', () => (keyboardLast = false), true);
}

/** The most recent interaction was a key press (not a pointer or touch). */
export function usedKeyboardLast(): boolean {
  return keyboardLast;
}

/**
 * Focus for keyboard flow: moves focus to `el` only when nothing else holds it (focus fell back to
 * <body>) or it is inside `scope`, so a user working elsewhere on the page is never interrupted.
 */
export function focusIfIdle(el: HTMLElement | null | undefined, scope?: Element | null): boolean {
  if (!el || !el.isConnected) return false;
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement && !scope?.contains(active)) return false;
  el.focus({ preventScroll: !usedKeyboardLast() });
  return true;
}
