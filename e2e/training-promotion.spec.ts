// Training a leak whose answer is a promotion: the picker appears (no auto-queen), Escape cancels it,
// the habit (=Q) is refuted, and the under-promotion (=N) is accepted and graded.
import { chooseFile, clickMove, dbReviews, dragMove, expect, openApp, test } from './support/app';
import { LASKER_BEST, LASKER_HABIT, promotionBackup } from './support/backup';

test('promotion picker in training (Lasker Trap, 7…fxg1=N+)', async ({ page }) => {
  const { file, leak } = promotionBackup(Date.now());
  await openApp(page);
  await chooseFile(page, page.getByRole('button', { name: 'Restore a backup' }), {
    name: 'lasker-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator('.toast')).toContainText('Backup restored: 1 mistakes, 3 games.');

  await page.goto(`/#/train?leak=${leak.shortId}`);
  const panel = page.locator('.train-panel');
  const board = page.locator('.train-board .board');
  const prompt = panel.locator('.prompt-title');
  const skip = panel.getByRole('button', { name: 'Skip to the position' });
  if (await skip.isVisible()) await skip.click();
  await expect(prompt).toHaveText('Your move — you are Black');

  // Dragging the pawn to the last rank asks which piece; Escape cancels and the move can be made again.
  const picker = page.getByRole('dialog', { name: 'Promote to' });
  await dragMove(page, board, LASKER_BEST);
  await expect(picker).toBeVisible();
  for (const piece of ['Queen', 'Knight', 'Rook', 'Bishop']) await expect(picker.getByRole('button', { name: piece })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Queen' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(prompt).toHaveText('Your move — you are Black');

  // Queen: the habit, refuted on the board.
  await clickMove(page, board, LASKER_HABIT);
  await picker.getByRole('button', { name: 'Queen' }).click();
  await expect(prompt).toContainText('That’s your usual');
  await expect(prompt).toContainText('fxg1=Q');
  await panel.getByRole('button', { name: 'Try again' }).click();

  // Knight: correct.
  await clickMove(page, board, LASKER_BEST);
  await picker.getByRole('button', { name: 'Knight' }).click();
  await expect(prompt).toHaveText('That’s the one');
  await expect(panel).toContainText('fxg1=N+');
  await expect.poll(async () => (await dbReviews(page)).map(r => [r.mistakeId, r.lastGrade])).toEqual([[leak.id, 'again']]);
});
