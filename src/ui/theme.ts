// Theme: settings.theme ('system' | 'light' | 'dark') → data-theme="light|dark" on <html>.
// index.html runs the same resolution inline before first paint, from localStorage 'ca:theme'.
import type { Settings } from '../core/types';

export type ThemePref = Settings['theme'];
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ca:theme';
/** Browser chrome colour per theme (matches --bg in styles/tokens.css). */
export const THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = { dark: '#161512', light: '#f6f5f2' };

/** Dark unless the preference or the system says light. */
export function resolveTheme(pref: ThemePref, systemPrefersLight: boolean): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersLight ? 'light' : 'dark';
}

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark';
}

function lightQuery(): MediaQueryList | undefined {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : undefined;
}

/** The preference saved by the last applyTheme call (or 'system'). Storage failures are ignored. */
export function storedThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePref(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function setDocumentTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}

let unwatch: (() => void) | undefined;

/** Applies a preference now, remembers it for the pre-paint script, and follows system changes for 'system'. */
export function applyTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Private mode / storage disabled: the theme still applies for this session.
  }
  unwatch?.();
  unwatch = undefined;
  const mq = lightQuery();
  setDocumentTheme(resolveTheme(pref, mq?.matches ?? false));
  if (pref === 'system' && mq) {
    const onChange = (): void => setDocumentTheme(resolveTheme('system', mq.matches));
    mq.addEventListener('change', onChange);
    unwatch = () => mq.removeEventListener('change', onChange);
  }
}
