// "See an example report": the bundled demo (public/demo/demo.json) loads as the own profile,
// works without any network request, and "Analyze my own games" removes it again.
import { applyFilters } from '../src/core/filters';
import { DEFAULT_FILTERS } from '../src/core/types';
import { dbAll, expect, openApp, test } from './support/app';
import { demo } from './support/fixtures';

test('the example report loads, can be explored, and is removed for your own games', async ({ page, net }) => {
  const [profile] = demo.profiles;
  const listed = applyFilters(demo.mistakes, DEFAULT_FILTERS, Date.now());
  expect(listed.length).toBeGreaterThan(5);

  await openApp(page);
  await page.getByRole('button', { name: 'See an example report' }).click();
  await expect(page.getByText('You’re looking at an example report')).toBeVisible();
  await expect(page.locator('.page-sub').first()).toContainText(`${profile!.name} · ${demo.games.length} games`);
  // The example never syncs.
  await expect(page.getByRole('button', { name: 'Sync new games' })).toHaveCount(0);
  await expect(page.locator('.dash-leaks .leak-list > li')).toHaveCount(5);
  await expect(page.locator('.dash-leaks .leak-list > li').first()).toContainText(listed[0]!.openingName ?? 'Unnamed line');
  // Its training history: reviews are due by now, and the Train tab says so.
  await expect(page.locator('.train-card')).toContainText(/due/);

  await page.goto('/#/leaks');
  await expect(page.locator('.leaks-page .page-sub')).toContainText(`${listed.length} repeated mistakes in ${demo.games.length} games`);
  await page.getByRole('tab', { name: /Mastered/ }).click();
  await expect(page.locator('.leaks-list > li')).toHaveCount(demo.mistakes.filter(m => m.status === 'mastered').length);
  expect(net.requests).toEqual([]);

  await page.goto('/#/');
  await page.getByRole('button', { name: 'Analyze my own games' }).click();
  await expect(page.getByRole('heading', { name: /Find the opening mistakes you keep repeating/ })).toBeVisible();
  expect(await dbAll(page, 'profiles')).toEqual([]);
  expect(await dbAll(page, 'mistakes')).toEqual([]);
});
