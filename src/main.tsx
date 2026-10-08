// Entry point: styles, theme, router, render, store boot and the PWA update prompt.
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './ui/styles/tokens.css';
import './ui/styles/base.css';
import './ui/styles/layout.css';
import './ui/styles/components.css';
import './ui/styles/pages.css';
import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import * as store from './state/store';
import { App } from './ui/app';
import { boot } from './ui/components/diagnostics';
import { recordVisit } from './ui/components/visits';
import { startRouter } from './ui/router';
import { applyTheme, storedThemePref } from './ui/theme';

applyTheme(storedThemePref());
startRouter();
recordVisit(Date.now());

const root = document.getElementById('app');
if (root) render(<App />, root);

// store.init() failures are shown in-app (the onboarding still renders below the error).
void boot();

/** New versions wait for the user: an "Update available" toast (hidden while a job runs) applies it. */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const updateSW = registerSW({
    onNeedRefresh() {
      store.updateAvailable.value = () => void updateSW(true);
    },
    onRegisterError(err: unknown) {
      console.warn('Service worker registration failed', err);
    },
  });
}
registerServiceWorker();
