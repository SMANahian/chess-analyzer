// After a first visit the service worker has precached the app: with the network cut, the app shell,
// the Stockfish engine (JS + WASM) and the example report still load, and training checks a new move
// with the engine.
import { sanOf } from '../src/core/chess';
import { applyFilters } from '../src/core/filters';
import { DEFAULT_FILTERS } from '../src/core/types';
import { legalMoves } from '../src/ui/components/moves';
import { expect, openApp, test } from './support/app';
import { demo } from './support/fixtures';

test.use({ serviceWorkers: 'allow' });

test('offline after the first load: app shell, engine and example report from the cache', async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The first page load is not controlled by the service worker it installed; the next one is.
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Find the opening mistakes you keep repeating/ })).toBeVisible();
  // (A page load without the cache would fail outright while offline.)
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);

  // The engine worker and its WASM come from the cache.
  const reply = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker('./engine/stockfish-19-lite-single.js');
        const timer = setTimeout(() => reject(new Error('the engine did not answer')), 20_000);
        worker.onmessage = e => {
          const line = String(e.data);
          if (!line.startsWith('bestmove')) return;
          clearTimeout(timer);
          worker.terminate();
          resolve(line);
        };
        for (const cmd of ['uci', 'isready', 'position startpos moves e2e4', 'go depth 8']) worker.postMessage(cmd);
      }),
  );
  expect(reply).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/);

  // The example report, and a move it has never seen checked live by the app's engine pool.
  await page.getByRole('button', { name: 'See an example report' }).click();
  await expect(page.getByRole('heading', { name: 'Your openings' })).toBeVisible();
  const leak = applyFilters(demo.mistakes, DEFAULT_FILTERS, Date.now())[0]!;
  const known = new Set([leak.move, leak.bestMove, ...leak.acceptable]);
  const fresh = legalMoves(leak.fen).find(m => !known.has(m.uci))!;
  expect(sanOf(leak.fen, fresh.uci)).toBe(fresh.san);
  await page.goto(`/#/train?leak=${leak.shortId}`);
  const panel = page.locator('.train-panel');
  const skip = panel.getByRole('button', { name: 'Skip to the position' });
  if (await skip.isVisible()) await skip.click();
  await expect(panel.locator('.prompt-title')).toHaveText(/^Your move/);
  await panel.getByLabel('Or type your move').fill(fresh.san);
  await panel.getByLabel('Or type your move').press('Enter');
  await expect(panel.locator('.prompt-title')).toHaveText(/^(Correct|Playable|Not quite)/, { timeout: 30_000 });
});
