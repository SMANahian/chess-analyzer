// Onboarding with a Chess.com username only: monthly archives (one request at a time, newest first),
// non-standard games skipped, real-engine analysis, the planted habits found.
import type { Mistake, StoredGame } from '../src/core/types';
import { dbAll, dbMistakes, expect, onboard, test, waitForAnalysis } from './support/app';
import { manifest, plantedBlunders, plantedShortId } from './support/fixtures';

test('Chess.com sync from the monthly archives', async ({ page, net }) => {
  const set = manifest.chesscom;
  await onboard(page, { chesscom: set.hero });
  await expect(page.getByRole('heading', { name: 'Your openings' })).toBeVisible();
  const self = await waitForAnalysis(page);
  // The display spelling comes from the profile URL (the API's username is lower-case).
  expect(self.accounts).toEqual([{ platform: 'chesscom', username: set.hero }]);

  const games = await dbAll<StoredGame>(page, 'games');
  expect(games, `${set.count} standard games (the ${set.skipped} variant games are skipped)`).toHaveLength(set.count);
  expect(new Set(games.map(g => g.platform))).toEqual(new Set(['chesscom']));
  expect(games.filter(g => g.color === 'white').length).toBeGreaterThan(0);
  expect(games.filter(g => g.color === 'black').length).toBeGreaterThan(0);

  // Only Chess.com was asked: the player, the archive list, then every month (newest first).
  expect(net.requests.some(r => r.includes('lichess.org'))).toBe(false);
  const months = set.archives.map(f => `/games/${f.replace('.json', '').replace('-', '/')}`);
  const firstPass = net.requests.filter(r => /\/games\/\d{4}\/\d{2}$/.test(r)).slice(0, months.length);
  expect(firstPass.map(r => r.slice(r.indexOf('/games/')))).toEqual([...months].reverse());

  const mistakes = new Map((await dbMistakes(page)).map((m: Mistake) => [m.shortId, m]));
  const blunders = plantedBlunders(set);
  expect(blunders.length).toBeGreaterThan(0);
  for (const p of blunders) {
    expect(mistakes.get(plantedShortId(p)), p.move_san).toMatchObject({
      move: p.move_uci,
      severity: 'blunder',
      count: p.times_played,
      positionCount: p.times_reached,
    });
  }
  await page.reload();
  await expect(page.locator('.page-sub').first()).toContainText(`${set.hero} on Chess.com · ${set.count} games`);
  await expect(page.locator('.dash-leaks .leak-list > li').first()).toBeVisible();
});
