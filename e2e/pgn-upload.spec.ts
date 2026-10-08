// PGN upload from the onboarding: the "Which of these is you?" name picker, import, and an analysis
// with the Quick preset chosen beforehand in Settings (hung pieces need no depth).
import type { StoredGame } from '../src/core/types';
import { chooseFile, choosePreset, dbAll, dbMistakes, expect, openApp, test, waitForAnalysis } from './support/app';
import { fixturePath, manifest, plantedBlunders, plantedShortId } from './support/fixtures';

test('PGN upload with the name picker', async ({ page, net }) => {
  const set = manifest.pgn;
  await choosePreset(page, 'Quick');
  await openApp(page);
  await chooseFile(page, page.getByRole('button', { name: /Drop a \.pgn file here/ }), fixturePath('upload.pgn'));

  // The most frequent name (the file's owner) comes first and is pre-selected.
  const picker = page.getByRole('group', { name: /Which of these is you\?/ });
  await expect(picker).toBeVisible();
  await expect(picker.locator('label').first()).toContainText(set.hero);
  await expect(picker.locator('label').first()).toContainText(`${set.count + set.skipped} games`);
  await expect(picker.getByRole('checkbox', { name: new RegExp(set.hero) })).toBeChecked();
  await expect(picker.getByRole('checkbox')).not.toHaveCount(1);
  await page.getByRole('button', { name: 'Import games' }).click();

  await expect(page.locator('.toast')).toContainText(`Imported ${set.count} games · ${set.skipped} skipped (variants or no moves).`);
  await expect(page.getByRole('heading', { name: 'Your openings' })).toBeVisible();
  const self = await waitForAnalysis(page);
  expect(self).toMatchObject({ name: set.hero, aliases: [set.hero.toLowerCase()], accounts: [] });

  const games = await dbAll<StoredGame>(page, 'games');
  expect(games).toHaveLength(set.count);
  expect(new Set(games.map(g => g.platform))).toEqual(new Set(['pgn']));
  const mistakes = new Map((await dbMistakes(page)).map(m => [m.shortId, m]));
  const blunders = plantedBlunders(set);
  expect(blunders.length).toBeGreaterThan(0);
  for (const p of blunders) {
    // Quick: triage depth 8, confirm depth 10.
    expect(mistakes.get(plantedShortId(p)), p.move_san).toMatchObject({ move: p.move_uci, severity: 'blunder', count: p.times_played, evalDepth: 10 });
  }
  await expect(page.locator('.page-sub').first()).toContainText(`${set.hero} · ${set.count} games`);
  // A local file: no request left the page.
  expect(net.requests).toEqual([]);
});
