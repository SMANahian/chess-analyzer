const { test, expect } = require('@playwright/test');

function sampleBackup() {
  return {
    backup_version: 2,
    pgn_files: [
      {
        color: 'white',
        content: '[Event "White"]\n1. e4 e5 2. Nf3 Nc6 *',
        game_count: 4,
      },
      {
        color: 'black',
        content: '[Event "Black"]\n1. d4 d5 2. c4 e6 *',
        game_count: 3,
      },
    ],
    mistakes: [
      {
        color: 'white',
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        user_move: 'e7e5',
        top_moves: ['c7c5'],
        avg_cp_loss: 135,
        pair_count: 4,
        opening_eco: 'B20',
        opening_name: 'Sicilian Defense',
      },
      {
        color: 'white',
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 2 3',
        user_move: 'g8f6',
        top_moves: ['f8c5'],
        avg_cp_loss: 210,
        pair_count: 3,
        opening_eco: 'C45',
        opening_name: 'Scotch Game',
      },
      {
        color: 'black',
        fen: 'rnbqkbnr/pp2pppp/2p5/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2',
        user_move: 'g8f6',
        top_moves: ['e7e6'],
        avg_cp_loss: 160,
        pair_count: 2,
        opening_eco: 'D06',
        opening_name: "Queen's Gambit Declined",
        snoozed: true,
        snoozed_at: '2026-01-01T00:00:00+00:00',
      },
      {
        color: 'black',
        fen: 'rnbqkbnr/pp2pppp/2p5/3p4/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 2',
        user_move: 'c6c5',
        top_moves: ['g8f6'],
        avg_cp_loss: 180,
        pair_count: 2,
        opening_eco: 'D02',
        opening_name: 'Queen Pawn Game',
      },
      {
        color: 'white',
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 1 2',
        user_move: 'f1c4',
        top_moves: ['d2d4'],
        avg_cp_loss: 110,
        pair_count: 2,
        opening_eco: 'C50',
        opening_name: 'Italian Game',
        mastered: true,
        mastered_at: '2026-01-02T00:00:00+00:00',
      },
    ],
    practice_sessions: [
      {
        color: 'mixed',
        correct: 6,
        total: 8,
        best_streak: 4,
      },
    ],
  };
}

test.beforeEach(async ({ request }) => {
  const clearResponse = await request.delete('/api/data');
  expect(clearResponse.ok()).toBeTruthy();

  const importResponse = await request.post('/api/import', {
    multipart: {
      file: {
        name: 'backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(sampleBackup()), 'utf8'),
      },
    },
  });

  expect(importResponse.ok()).toBeTruthy();
});

test('dashboard, analysis, archives, and practice flows render cleanly', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Turn your opening leaks/i })).toBeVisible();
  await expect(page.getByText('Games in library')).toBeVisible();
  await expect(page.getByText('Active mistakes')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Background jobs and partial results' })).toBeVisible();
  await expect(page.locator('.color-card')).toHaveCount(2);

  await page.locator('.nav-track').getByRole('link', { name: 'White', exact: true }).click();
  await expect(page.getByRole('heading', { name: /White repertoire/i })).toBeVisible();
  await expect(page.locator('.mistake-row')).toHaveCount(2);

  await page.locator('#filter-query').fill('Scotch');
  await expect(page.locator('.mistake-row')).toHaveCount(1);
  await expect(page.locator('#detail')).toContainText('Scotch Game');

  await page.locator('#btn-snooze').click();
  await expect(page.getByText('Moved to snoozed')).toBeVisible();
  await expect(page.locator('#mlist')).toContainText('No mistakes match the current filters');

  await page.locator('.nav-track').getByRole('link', { name: 'Snoozed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Snoozed positions' })).toBeVisible();
  await expect(page.locator('.archive-row')).toHaveCount(2);
  await expect(page.locator('.archive-list')).toContainText('Scotch Game');

  await page
    .locator('.archive-row', { hasText: 'Scotch Game' })
    .getByRole('button', { name: 'Unsnooze' })
    .click();
  await expect(page.getByText('Returned to the active queue')).toBeVisible();
  await expect(page.locator('.archive-row')).toHaveCount(1);

  await page.locator('.nav-track').getByRole('link', { name: 'Mastered', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mastered positions' })).toBeVisible();
  await expect(page.locator('.archive-row')).toHaveCount(1);
  await expect(page.locator('.archive-list')).toContainText('Italian Game');

  await page.locator('.nav-track').getByRole('link', { name: 'Practice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Practice the current mistake queue' })).toBeVisible();
  await expect(page.locator('#p-msg')).toContainText('Find the best move');
  await expect(page.locator('.practice-shell .metric-card')).toHaveCount(4);
});
