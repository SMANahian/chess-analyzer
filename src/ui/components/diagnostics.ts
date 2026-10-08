// App boot state (store.init) and the "Copy diagnostics" payload used by the fatal panel, the crash
// boundary and Settings.
import { signal } from '@preact/signals';
import * as store from '../../state/store';
import { messageOf } from './errors';

export type BootState = 'loading' | 'ready' | 'failed';
export const bootState = signal<BootState>('loading');
export const bootError = signal<unknown>(null);

/** Runs store.init(). A failure leaves the app usable (onboarding still renders) under an error panel. */
export async function boot(): Promise<void> {
  bootState.value = 'loading';
  try {
    await store.init();
    bootState.value = 'ready';
  } catch (err) {
    console.error('Chess Analyzer failed to start', err);
    bootError.value = err;
    bootState.value = 'failed';
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err);
}

/** JSON for bug reports: the store's diagnostics when available, plus what the page itself can see. No games. */
export async function collectDiagnostics(error?: unknown): Promise<string> {
  let fromStore: Record<string, unknown>;
  try {
    fromStore = await store.diagnostics();
  } catch (err) {
    fromStore = { error: `diagnostics unavailable: ${messageOf(err)}` };
  }
  const nav: (Navigator & { deviceMemory?: number }) | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  const page = {
    url: location.href,
    time: new Date().toISOString(),
    userAgent: nav?.userAgent,
    language: nav?.language,
    hardwareConcurrency: nav?.hardwareConcurrency,
    deviceMemory: nav?.deviceMemory,
    features: {
      indexedDB: typeof indexedDB !== 'undefined',
      webAssembly: typeof WebAssembly !== 'undefined',
      worker: typeof Worker !== 'undefined',
      serviceWorker: !!nav && 'serviceWorker' in nav,
      webLocks: !!nav && 'locks' in nav,
      storageManager: !!nav?.storage,
    },
    boot: bootState.value,
    bootError: bootError.value ? errorText(bootError.value) : undefined,
    error: error ? errorText(error) : undefined,
  };
  return JSON.stringify({ app: 'chess-analyzer', ...page, store: fromStore }, null, 2);
}
