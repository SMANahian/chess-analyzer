// The main journey with a Lichess account: onboarding → sync → real-engine analysis → leaks (the
// planted habits of the fixture player), a leak in detail, training, backup round trip, and a
// re-analysis from an empty eval cache that must reproduce the same mistakes.
import { test, expect } from '@playwright/test';
import { sanOf } from '../src/core/chess';
import type { Mistake } from '../src/core/types';
import { boardArrows, chooseFile, clearEvalCache, clickMove, dbAll, dbMistakes, dbReviews, savedSettings, selfProfile, waitForAnalysis } from './support/app';
import { manifest, plantedBlunders, plantedShortId, type Planted } from './support/fixtures';
import { sharedSession, type SharedSession } from './support/session';

test.describe.configure({ mode: 'serial' });

let s: SharedSession;
/** Planted piece-hanging habits that the analysis found, with their stored mistake. */
let found: { p: Planted; m: Mistake }[] = [];

/** What a re-analysis or a restore must reproduce: the mistakes and their verdicts. */
function verdicts(ms: readonly Mistake[]): string[] {
  return ms.map(m => `${m.id} ${m.severity} ${m.kind} ${m.confidence} ${m.winLoss.toFixed(2)} ${m.bestMove} ${m.count}/${m.positionCount}`).sort();
}

test.beforeAll(async ({ browser }, info) => {
  s = await sharedSession(browser, info, { holdLichessExport: true });
});
test.afterAll(async () => {
  await s?.close();
});

test('onboarding with a Lichess username: sync, analysis, leaks', async () => {
  const { page, net } = s;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Find the opening mistakes you keep repeating/ })).toBeVisible();
  await page.getByLabel('Lichess username').fill(manifest.lichess.hero);
  await page.getByRole('button', { name: 'Analyze my games' }).click();

  // The dashboard replaces the onboarding at once and shows the download while the export is held.
  await expect(page.getByRole('heading', { name: 'Your openings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: `Downloading your games from Lichess (${manifest.lichess.hero})` })).toBeVisible();
  net.release();
  await expect(page.getByRole('heading', { name: 'Checking your positions with Stockfish' })).toBeVisible();

  const t0 = Date.now();
  const self = await waitForAnalysis(page);
  console.log(`first run (sync + analysis + backfill + analysis): ${((Date.now() - t0) / 1000).toFixed(1)} s after the export`);
  expect(self.accounts).toEqual([{ platform: 'lichess', username: manifest.lichess.hero }]);
  expect(await dbAll(page, 'games')).toHaveLength(manifest.lichess.count);
  // First run: the newest 300 (dateDesc, max=300), the forward pass, then the backfill of the rest.
  expect(net.requests.filter(r => r.includes('/api/games/user/'))).toHaveLength(3);
  expect(net.requests.filter(r => r.includes('/api/games/user/'))[0]).toContain('max=300');

  const mistakes = await dbMistakes(page);
  const byKey = new Map(mistakes.map(m => [m.shortId, m]));
  const blunders = plantedBlunders(manifest.lichess);
  found = blunders.flatMap(p => {
    const m = byKey.get(plantedShortId(p));
    return m ? [{ p, m }] : [];
  });
  console.log(`${mistakes.length} mistakes; planted: ${blunders.map(p => `${p.move_san} ${byKey.get(plantedShortId(p))?.severity ?? 'MISSING'}`).join(', ')}`);
  // Every planted habit that hangs a piece (and was played in 3+ games) is found, as a blunder.
  expect(blunders.length).toBeGreaterThanOrEqual(2);
  expect(
    found.map(f => f.p.move_san),
    'planted piece-hanging habits found',
  ).toEqual(blunders.map(p => p.move_san));
  for (const { p, m } of found) {
    expect(m, p.move_san).toMatchObject({ move: p.move_uci, color: p.color, severity: 'blunder', kind: 'mistake', status: 'active' });
    expect(m.count, p.move_san).toBe(p.times_played);
    expect(m.positionCount, p.move_san).toBe(p.times_reached);
  }

  // The UI lists them: the dashboard's top leaks and the full list.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Top leaks' })).toBeVisible();
  await expect(page.locator('.dash-leaks .leak-list > li').first()).toBeVisible();
  await expect(page.locator('.page-sub').first()).toContainText(`${manifest.lichess.count} games`);
  await page.goto('/#/leaks');
  for (const { p } of found) await expect(page.locator(`.leaks-list [data-short-id="${plantedShortId(p)}"]`)).toContainText(p.move_san);
});

test('leak detail: arrows, lines, master → Mastered tab → restore', async () => {
  const { page } = s;
  const { p, m } = found[0]!;
  const id = plantedShortId(p);
  await page.goto(`/#/leaks/${id}`);
  const detail = page.locator('.leak-detail');
  await expect(detail.locator('#ld-title')).toContainText(p.move_san);
  await expect(detail.locator('.ld-headline')).toContainText(`${m.count} of ${m.positionCount}`);

  // Orange = the habit, blue = the best move.
  const board = detail.locator('.ld-board-col .board');
  await expect
    .poll(() => boardArrows(board))
    .toEqual(
      expect.arrayContaining([
        { from: m.move.slice(0, 2), to: m.move.slice(2, 4), brush: 'orange' },
        { from: m.bestMove.slice(0, 2), to: m.bestMove.slice(2, 4), brush: 'blue' },
      ]),
    );
  // The lines: how you get here, the best line, and what happens after the habit.
  const lines = detail.locator('.ld-line');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(1)).toContainText('Better:');
  await expect(lines.nth(2)).toContainText(`What happens after`);
  // Stepping into the refutation shows that position (no arrows away from the leak position).
  await lines.nth(2).getByRole('button').nth(1).click();
  await expect.poll(() => boardArrows(board)).toEqual([]);
  await detail.getByRole('button', { name: 'Back to the leak position' }).click();
  await expect.poll(async () => (await boardArrows(board)).length).toBe(2);

  // Master it: it leaves the active list and shows in the Mastered tab, from where it can be restored.
  await detail.getByRole('button', { name: 'Mark mastered' }).click();
  await expect(page.locator('.toast')).toContainText('Marked as mastered.');
  await expect(page.locator(`.leaks-list [data-short-id="${id}"]`)).toHaveCount(0);
  await page.getByRole('tab', { name: /Mastered/ }).click();
  const row = page.locator(`.leaks-list li:has([data-short-id="${id}"])`);
  await expect(row).toContainText('Mastered');
  expect((await dbMistakes(page)).find(x => x.id === m.id)?.status).toBe('mastered');
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.toast')).toContainText('Back in your active leaks.');
  await page.getByRole('tab', { name: /Active/ }).click();
  await expect(page.locator(`.leaks-list [data-short-id="${id}"]`)).toBeVisible();
  expect((await dbMistakes(page)).find(x => x.id === m.id)?.status).toBe('active');
});

test('training: the habit is refuted, a typed SAN retry is graded; a correct board move is graded', async () => {
  const { page } = s;
  const { p, m } = found[0]!;
  await page.goto(`/#/train?leak=${plantedShortId(p)}`);
  const panel = page.locator('.train-panel');
  const board = page.locator('.train-board .board');
  const skip = panel.getByRole('button', { name: 'Skip to the position' });
  if (await skip.isVisible()) await skip.click();
  await expect(panel.locator('.prompt-title')).toHaveText(`Your move — you are ${p.color === 'white' ? 'White' : 'Black'}`);

  // The habit: recognised, refuted on the board, then a retry.
  await clickMove(page, board, m.move);
  await expect(panel.locator('.prompt-title')).toContainText('That’s your usual');
  await expect(panel.locator('.prompt-title')).toContainText(p.move_san);
  await panel.getByRole('button', { name: 'Try again' }).click();
  // Typed SAN input: the best move.
  await panel.getByLabel('Or type your move').fill(sanOf(m.fen, m.bestMove));
  await panel.getByLabel('Or type your move').press('Enter');
  await expect(panel.locator('.prompt-title')).toHaveText('That’s the one');
  await expect(panel.locator('.train-schedule')).toContainText('You’ll see this again');
  await expect.poll(async () => (await dbReviews(page)).find(r => r.mistakeId === m.id)?.lastGrade).toBe('again');

  // Another leak, solved first try on the board: graded "good".
  const other = found[1]!;
  await page.goto(`/#/train?leak=${plantedShortId(other.p)}`);
  if (await skip.isVisible()) await skip.click();
  await expect(panel.locator('.prompt-title')).toHaveText(/^Your move/);
  await clickMove(page, board, other.m.bestMove);
  await expect(panel.locator('.prompt-title')).toHaveText('Correct!');
  await expect(panel.locator('.train-schedule')).toContainText('Next review');
  await expect.poll(async () => (await dbReviews(page)).find(r => r.mistakeId === other.m.id)?.lastGrade).toBe('good');
});

test('settings: download a backup, delete all data, restore it', async ({}, info) => {
  const { page } = s;
  const before = { mistakes: await dbMistakes(page), reviews: await dbReviews(page), games: (await dbAll(page, 'games')).length };
  expect(before.reviews.length).toBeGreaterThan(0);

  await page.goto('/#/settings');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const file = info.outputPath('backup.json');
  await (await download).saveAs(file);
  await expect(page.locator('.toast')).toContainText('Backup downloaded.');

  await page.getByRole('button', { name: 'Delete all data' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete all data?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  // "Delete everything" ignores clicks in the first MIN_CONFIRM_MS (600 ms, src/ui/components/buttons.tsx)
  // after the dialog opens, so the second click of a double-click on "Delete all data" cannot land on it.
  await page.waitForTimeout(700);
  await confirm.getByRole('button', { name: 'Delete everything' }).click();
  await expect(page.getByRole('heading', { name: /Find the opening mistakes you keep repeating/ })).toBeVisible();
  expect(await dbAll(page, 'games')).toEqual([]);
  expect(await dbMistakes(page)).toEqual([]);
  expect(await dbAll(page, 'evals')).toEqual([]);

  await chooseFile(page, page.getByRole('button', { name: 'Restore a backup' }), file);
  await expect(page.locator('.toast')).toContainText(`Backup restored: ${before.mistakes.length} mistakes, ${before.games} games.`);
  await expect(page.getByRole('heading', { name: 'Your openings' })).toBeVisible();
  expect(verdicts(await dbMistakes(page))).toEqual(verdicts(before.mistakes));
  expect((await dbMistakes(page)).map(m => m.status).sort()).toEqual(before.mistakes.map(m => m.status).sort());
  expect(await dbReviews(page)).toEqual(expect.arrayContaining(before.reviews));
  await page.goto('/#/leaks');
  await expect(page.locator(`.leaks-list [data-short-id="${plantedShortId(found[0]!.p)}"]`)).toBeVisible();
});

test('re-analysis from an empty eval cache reproduces every verdict, with any number of engines', async () => {
  const { page } = s;
  const first = verdicts(await dbMistakes(page));

  /** Empties the eval cache, re-analyses with `workers` engines, returns the verdicts. */
  const reanalyse = async (workers: string): Promise<string[]> => {
    await page.goto('/#/settings');
    const advanced = page.locator('details.settings-advanced');
    if ((await advanced.getAttribute('open')) === null) await advanced.locator('summary').click();
    await page.getByLabel('Engine workers').fill(workers);
    await expect.poll(async () => (await savedSettings(page)).engineWorkers ?? 0).toBe(Number(workers));
    await clearEvalCache(page);
    expect(await dbAll(page, 'evals')).toEqual([]);
    const since = (await selfProfile(page))!.lastAnalysisAt!;
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Re-analyze now' }).click();
    await waitForAnalysis(page, { after: since });
    console.log(`re-analysis with ${workers === '0' ? 'automatic' : workers} worker(s): ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    expect((await dbAll(page, 'evals')).length).toBeGreaterThan(0);
    return verdicts(await dbMistakes(page));
  };

  const a = await reanalyse('0');
  const b = await reanalyse('1');
  expect(b).toEqual(a);
  // The first run analysed the newest 300 games, then all 400 reusing those evals: same verdicts.
  expect(a).toEqual(first);
});
