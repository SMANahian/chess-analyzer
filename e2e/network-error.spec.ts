// Lichess unreachable (a CORS rejection, an ad-blocker, a filtering network): the onboarding explains
// it and offers the PGN upload instead of creating a profile without games. When only the game
// export fails, the dashboard says so (never "no mistakes found") and leads to the PGN upload.
import { chooseFile, dbAll, expect, onboard, test, waitForAnalysis } from './support/app';
import { fixturePath, manifest } from './support/fixtures';

test.describe('Lichess unreachable', () => {
  test.use({ mockOptions: { lichess: 'unreachable' } });

  test('a CORS / network failure shows the friendly error with "upload a PGN file instead"', async ({ page, net }) => {
    await onboard(page, { lichess: manifest.lichess.hero });
    const error = page.getByRole('alert').filter({ hasText: 'Couldn’t reach Lichess' });
    // fetch() retries network errors with a back-off (1 + 2 + 4 s) before giving up.
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText('upload a PGN file instead');
    expect(net.requests.length).toBeGreaterThan(0);
    expect(net.requests.every(r => r.includes('lichess.org/api/user/'))).toBe(true);

    // Still on the onboarding, with nothing stored; the link leads to the PGN upload.
    expect(await dbAll(page, 'profiles')).toEqual([]);
    await error.getByRole('link', { name: 'Upload a PGN file instead' }).click();
    await expect(page.getByRole('button', { name: /Drop a \.pgn file here/ })).toBeFocused();
    await expect(page.getByLabel('Lichess username')).toHaveValue(manifest.lichess.hero);
  });
});

test.describe('Lichess game export unreachable', () => {
  test.use({ mockOptions: { lichess: 'export-unreachable' } });

  test('the dashboard reports it, shows no games (not "no mistakes") and offers the PGN upload in Settings', async ({ page, net }) => {
    await onboard(page, { lichess: manifest.lichess.hero });
    await expect(page.getByRole('heading', { name: 'Your openings' })).toBeVisible();
    const banner = page.locator('.banner-danger').filter({ hasText: 'Something went wrong' });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'No games yet' })).toBeVisible();
    await expect(page.getByText('No repeated mistakes found')).toHaveCount(0);
    // One failed export (with its retries); no backfill attempt after a sync that got nothing.
    expect(new Set(net.requests.filter(r => r.includes('/api/games/user/'))).size).toBe(1);
    expect((await dbAll<{ lastAnalysisAt?: number }>(page, 'profiles'))[0]?.lastAnalysisAt).toBeUndefined();

    await banner.getByRole('link', { name: 'Upload a PGN file instead' }).click();
    const upload = page.locator('#set-pgn');
    await expect(upload.getByRole('heading', { name: 'Upload games (PGN)' })).toBeVisible();
    await chooseFile(page, upload.getByRole('button', { name: /Drop a \.pgn file here/ }), fixturePath('upload.pgn'));
    await upload.getByRole('button', { name: 'Import games' }).click();
    await expect(page.locator('.toast')).toContainText(`Imported ${manifest.pgn.count} games`);
    await expect(upload.getByRole('button', { name: /Drop a \.pgn file here/ })).toBeVisible();
    await waitForAnalysis(page);
    await page.goto('/#/');
    await expect(page.locator('.dash-leaks .leak-list > li').first()).toBeVisible();
    await expect(banner).toHaveCount(0);
  });
});
