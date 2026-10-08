// Live smoke test against the real Lichess and Chess.com APIs (network required; never run in normal CI).
//   npm run build && npx playwright test --config playwright.live.config.ts
// Accounts and size: LIVE_LICHESS_USER, LIVE_CHESSCOM_USER (default SMA-Nahian; blank = skip that site),
// LIVE_GAMES (games per account, default 300), LIVE_TIMEOUT_MIN (analysis wait, default 15),
// LIVE_ONBOARDING=deep-link (start through ?lichess=…&chesscom=… instead of the form),
// LIVE_MOCK=1 (offline rehearsal with recorded fixtures). Writes test-results/live-summary.json.
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.LIVE_PORT ?? 4183);
// Served under the same sub-path as GitHub Pages, so relative-URL mistakes show up here too.
const basePath = '/chess-analyzer/';
const baseURL = `http://127.0.0.1:${port}${basePath}`;

export default defineConfig({
  testDir: './e2e/live',
  outputDir: './test-results/live',
  // Onboarding, a 300-game sync per site and the analysis; the analysis itself is capped at 15 min.
  timeout: 25 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/live' }]],
  // live.spec.ts skips itself unless it runs under this config.
  metadata: { live: true },
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    // The service worker would precache the engine a second time and hide requests from Playwright.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort --base ${basePath}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
