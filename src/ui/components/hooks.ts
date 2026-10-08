// Small shared hooks and action helpers for pages.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { friendlyError } from './errors';

/** Re-renders every `intervalMs` while enabled and returns the current time (for countdowns and "x min ago"). */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

function mediaMatches(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
export const prefersReducedMotion = (): boolean => mediaMatches(REDUCED_MOTION);

/** Shows a store notice. */
export function toast(kind: store.Notice['kind'], text: string, action?: store.Notice['action']): void {
  store.notice.value = action ? { kind, text, action } : { kind, text };
}

/**
 * Runs a store action; on failure shows a friendly error notice (cancellations stay silent) and
 * resolves false. Store calls may throw synchronously, so they are invoked inside the try.
 */
export async function runAction(fn: () => Promise<unknown> | unknown, opts: { success?: string } = {}): Promise<boolean> {
  try {
    await fn();
    if (opts.success) toast('success', opts.success);
    return true;
  } catch (err) {
    const e = friendlyError(err);
    if (e.kind !== 'aborted') toast('error', `${e.title}. ${e.text}`);
    return false;
  }
}

/** [run, pending]: like runAction, with a pending flag for disabling the button that started it. */
export function useAction(): [(fn: () => Promise<unknown> | unknown, opts?: { success?: string }) => Promise<boolean>, boolean] {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const run = useCallback(async (fn: () => Promise<unknown> | unknown, opts?: { success?: string }) => {
    setPending(true);
    try {
      return await runAction(fn, opts);
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);
  return [run, pending];
}

/** Saves a Blob as a file via a temporary object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Clipboard write with a fallback for non-secure contexts / older Safari. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Copy failed: your browser blocked clipboard access.');
}
