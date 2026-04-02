const { defineConfig } = require('@playwright/test');

const port = Number(process.env.PLAYWRIGHT_PORT || '8765');
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `python -m chess_analyzer --no-browser --host 127.0.0.1 --port ${port}`,
    url: `${baseURL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      CHESS_ANALYZER_DATA: '.playwright-data',
    },
  },
});
