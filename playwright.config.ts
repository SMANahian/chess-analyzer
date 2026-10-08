// End-to-end tests: the production build (vite preview) in Chromium, the real Stockfish WASM engine,
// and Lichess / Chess.com mocked from e2e/fixtures (every other external request is blocked).
// WebKit runs too when E2E_WEBKIT=1 (its browser must be installed). Live-API checks under e2e/live/
// are not part of this suite.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['live/**'],
  // Real engine analyses take a while on a busy machine; individual waits have their own budgets.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Service workers would answer some requests before page.route sees them; the offline spec opts in.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    ...(process.env.E2E_WEBKIT === '1' ? [{ name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } } }] : []),
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
