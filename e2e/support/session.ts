// A browser context shared by the tests of one serial describe block (a user journey whose steps
// build on each other, so the real-engine analysis runs once), with the same network fakes and
// page-error checks as the per-test fixtures in app.ts. (Playwright traces contexts created in tests
// and screenshots their pages on failure, as configured, so nothing else is needed here.)
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { mockNetwork, type MockNetwork, type MockOptions } from './network';

export interface SharedSession {
  context: BrowserContext;
  page: Page;
  net: MockNetwork;
  /** Closes the context, then asserts nothing unexpected happened. */
  close(): Promise<void>;
}

export async function sharedSession(browser: Browser, info: TestInfo, mock: MockOptions = {}): Promise<SharedSession> {
  const { baseURL, viewport } = info.project.use;
  const context = await browser.newContext({ baseURL, viewport, serviceWorkers: 'block', acceptDownloads: true });
  const net = await mockNetwork(context, mock);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(`${err.name}: ${err.message}`));
  return {
    context,
    page,
    net,
    async close() {
      await context.close();
      expect(errors, 'uncaught errors in the page').toEqual([]);
      expect(net.blocked, 'requests to hosts other than Lichess / Chess.com').toEqual([]);
    },
  };
}
