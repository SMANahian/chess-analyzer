// Phone layout (390 × 844, touch): bottom tab bar instead of the header navigation, the leak list →
// leak screen → back, training, and the More sheet; nothing wider than the screen.
import type { Page } from '@playwright/test';
import { expect, openApp, test } from './support/app';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test('phone: bottom navigation, leak list → detail → back, training, More sheet', async ({ page }) => {
  await openApp(page);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'See an example report' }).tap();
  await expect(page.getByRole('heading', { name: 'Your openings' })).toBeVisible();

  const tabs = page.locator('nav.tab-bar');
  await expect(tabs).toBeVisible();
  await expect(page.locator('.top-nav-main')).toBeHidden();
  for (const name of [/^Home/, /^Leaks/, /^Train/, /^Openings/]) await expect(tabs.getByRole('link', { name })).toBeVisible();
  await expect(tabs.getByRole('button', { name: 'More' })).toBeVisible();
  const bar = (await tabs.boundingBox())!;
  expect(bar.y + bar.height).toBeCloseTo(844, -1);
  await expectNoHorizontalScroll(page);

  await tabs.getByRole('link', { name: /^Leaks/ }).tap();
  await expect(tabs.getByRole('link', { name: /^Leaks/ })).toHaveAttribute('aria-current', 'page');
  await page.locator('.leaks-list .li-row').first().tap();
  const detail = page.locator('.leak-detail');
  await expect(detail).toBeVisible();
  await expect(page.locator('.leaks-list')).toHaveCount(0);
  const board = (await detail.locator('.board').boundingBox())!;
  expect(board.width).toBeGreaterThan(300);
  expect(board.width).toBeLessThanOrEqual(390);
  expect(Math.abs(board.width - board.height)).toBeLessThan(2);
  await expect(detail.getByRole('navigation', { name: 'Leak navigation' })).toContainText(/1 of \d+/);
  await expectNoHorizontalScroll(page);
  await detail.getByRole('link', { name: 'Next leak' }).tap();
  await expect(detail.getByRole('navigation', { name: 'Leak navigation' })).toContainText(/2 of \d+/);
  await detail.getByRole('link', { name: 'All leaks' }).tap();
  await expect(page.locator('.leaks-list')).toBeVisible();

  await tabs.getByRole('link', { name: /^Train/ }).tap();
  await expect(page.locator('.train-board .board')).toBeVisible();
  const trainBoard = (await page.locator('.train-board .board').boundingBox())!;
  expect(trainBoard.x).toBeGreaterThanOrEqual(0);
  expect(trainBoard.x + trainBoard.width).toBeLessThanOrEqual(390);
  await expectNoHorizontalScroll(page);

  await tabs.getByRole('button', { name: 'More' }).tap();
  const sheet = page.getByRole('dialog', { name: 'More' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('link', { name: /Settings/ }).tap();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(sheet).toBeHidden();
  await expectNoHorizontalScroll(page);
});
