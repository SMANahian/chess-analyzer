// Shared e2e fixtures and helpers: the mocked network (installed for every test), page-error and
// CSP-violation collection, IndexedDB reads for waiting on background jobs, and chessground board
// interaction.
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { Mistake, Profile, ReviewState, Settings } from '../../src/core/types';
import { watchCsp } from './csp';
import { mockNetwork, type MockNetwork, type MockOptions } from './network';

export { expect };

export const test = base.extend<{ mockOptions: MockOptions; net: MockNetwork; pageErrors: string[]; cspViolations: string[] }>({
  mockOptions: [{}, { option: true }],
  net: [
    async ({ context, mockOptions }, use) => {
      const net = await mockNetwork(context, mockOptions);
      await use(net);
      expect(net.blocked, 'requests to hosts other than Lichess / Chess.com').toEqual([]);
    },
    { auto: true },
  ],
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', err => errors.push(`${err.name}: ${err.message}`));
      await use(errors);
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
  cspViolations: [
    async ({ context }, use) => {
      const violations = await watchCsp(context);
      await use(violations);
      expect(violations, 'Content-Security-Policy violations').toEqual([]);
    },
    { auto: true },
  ],
});

// ── IndexedDB (peeks at the app's database) ───────────────────────────────

const DB_NAME = 'chess-analyzer';

/** Every row of an object store ([] when the store does not exist yet). */
export function dbAll<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    async ([name, table]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        if (!db.objectStoreNames.contains(table)) return [];
        return await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(table).objectStore(table).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    [DB_NAME, store] as const,
  ) as Promise<T[]>;
}

export async function selfProfile(page: Page): Promise<Profile | undefined> {
  return (await dbAll<Profile>(page, 'profiles')).find(p => p.kind === 'self');
}

export const dbMistakes = (page: Page): Promise<Mistake[]> => dbAll<Mistake>(page, 'mistakes');
export const dbReviews = (page: Page): Promise<ReviewState[]> => dbAll<ReviewState>(page, 'reviews');

/** The saved settings (only the fields stored so far; the app merges them over its defaults). */
export async function savedSettings(page: Page): Promise<Partial<Settings>> {
  const row = (await dbAll<{ key: string; value: Partial<Settings> }>(page, 'meta')).find(r => r.key === 'settings');
  return row?.value ?? {};
}

/** Empties the engine's eval cache (the only write the tests make to the app's database). */
export async function clearEvalCache(page: Page): Promise<void> {
  await page.evaluate(
    name =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('evals', 'readwrite');
          tx.objectStore('evals').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    DB_NAME,
  );
}

/**
 * Waits until the own profile has been analysed (after `after`, ms) and no background job is running
 * (the store keeps a `job` meta row for the whole sync → analyse → backfill → analyse run).
 */
export async function waitForAnalysis(page: Page, opts: { after?: number; timeout?: number } = {}): Promise<Profile> {
  const deadline = Date.now() + (opts.timeout ?? 150_000);
  let last = '';
  for (;;) {
    const self = await selfProfile(page);
    const job = (await dbAll<{ key: string }>(page, 'meta')).find(r => r.key === 'job');
    if (self?.lastAnalysisAt !== undefined && self.lastAnalysisAt > (opts.after ?? 0) && !job) return self;
    last = JSON.stringify({ self, job });
    if (Date.now() > deadline) throw new Error(`analysis did not finish in time: ${last}`);
    await page.waitForTimeout(300);
  }
}

// ── App flows ─────────────────────────────────────────────────────────────

export async function openApp(page: Page, hash = '#/'): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator('#app .app')).toBeVisible();
}

/** Settings → Analysis → Depth preset (works before onboarding too). */
export async function choosePreset(page: Page, preset: 'Quick' | 'Standard' | 'Thorough'): Promise<void> {
  await page.goto('/#/settings');
  // The radios are visually hidden inside their labels (a segmented control): click the label.
  await page
    .locator('label.segmented-option')
    .filter({ hasText: new RegExp(`^${preset}`) })
    .click();
  await expect(page.getByRole('radio', { name: new RegExp(`^${preset}`) })).toBeChecked();
  await expect.poll(async () => (await savedSettings(page)).preset).toBe(preset.toLowerCase());
}

export async function onboard(page: Page, accounts: { lichess?: string; chesscom?: string }): Promise<void> {
  await openApp(page);
  if (accounts.lichess) await page.getByLabel('Lichess username').fill(accounts.lichess);
  if (accounts.chesscom) await page.getByLabel('Chess.com username').fill(accounts.chesscom);
  await page.getByRole('button', { name: 'Analyze my games' }).click();
}

/** Hidden file input behind a button: picks `file` through the browser's file chooser. */
export async function chooseFile(page: Page, button: Locator, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await button.click();
  await (await chooser).setFiles(file);
}

// ── Board (chessground) ───────────────────────────────────────────────────

async function squareCenter(board: Locator, square: string): Promise<{ x: number; y: number }> {
  const box = await board.locator('cg-board').boundingBox();
  if (!box) throw new Error('board not visible');
  const black = ((await board.locator('.cg-wrap').getAttribute('class')) ?? '').includes('orientation-black');
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = black ? 7 - file : file;
  const row = black ? rank : 7 - rank;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}

/** Plays a move by clicking its from- and to-square (standard UCI; promotions need the picker). */
export async function clickMove(page: Page, board: Locator, uci: string): Promise<void> {
  for (const square of [uci.slice(0, 2), uci.slice(2, 4)]) {
    const p = await squareCenter(board, square);
    await page.mouse.click(p.x, p.y);
  }
}

/** Drags a piece from one square to another. */
export async function dragMove(page: Page, board: Locator, uci: string): Promise<void> {
  const from = await squareCenter(board, uci.slice(0, 2));
  const to = await squareCenter(board, uci.slice(2, 4));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

export interface Arrow {
  from: string;
  to: string;
  brush: string;
}

/** Arrows drawn by chessground, decoded from its shape hashes ("w,h,…,orig,dest,brush,…"). */
export async function boardArrows(board: Locator): Promise<Arrow[]> {
  const hashes = await board.locator('svg.cg-shapes g[cgHash]').evaluateAll(gs => gs.map(g => g.getAttribute('cgHash') ?? ''));
  const arrows: Arrow[] = [];
  for (const hash of hashes) {
    const parts = hash.split(',');
    const i = parts.findIndex(p => /^[a-h][1-8]$/.test(p));
    if (i >= 0 && /^[a-h][1-8]$/.test(parts[i + 1] ?? '')) arrows.push({ from: parts[i]!, to: parts[i + 1]!, brush: parts[i + 2] ?? '' });
  }
  return arrows;
}
