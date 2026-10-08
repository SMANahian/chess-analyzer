// The committed example report (public/demo/demo.json, `npm run build:demo`) loads through
// store.loadDemo as a demo own profile that looks alive and never syncs.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupFile } from '../db/backup';
import { useTestDb } from '../db/schema';
import * as store from './store';

const TEXT = readFileSync(new URL('../../public/demo/demo.json', import.meta.url), 'utf8');
const DEMO = JSON.parse(TEXT) as BackupFile;
/** A month after the demo was built: its reviews are due by then. */
const NOW = DEMO.exportedAt + 30 * 86_400_000;

let requests: string[] = [];

beforeEach(async () => {
  await store.__resetForTests();
  useTestDb();
  requests = [];
  store.__setTestDeps({
    fetchImpl: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return String(input).endsWith('demo/demo.json') ? new Response(TEXT) : new Response('', { status: 404 });
    }) as typeof fetch,
    now: () => NOW,
  });
});
afterEach(() => store.__resetForTests());

describe('public/demo/demo.json', () => {
  it('is a small v3 backup of one demo profile, without evals or accounts', () => {
    expect(TEXT.length).toBeLessThan(1.5 * 1024 * 1024);
    expect(DEMO).toMatchObject({ app: 'chess-analyzer', version: 3 });
    expect(DEMO.evals).toBeUndefined();
    expect(DEMO.profiles).toEqual([expect.objectContaining({ kind: 'self', demo: true, accounts: [] })]);
    const games = new Set(DEMO.games.map(g => g.key));
    for (const m of DEMO.mistakes) for (const o of m.occurrences) expect(games.has(o.g), `${m.shortId} → ${o.g}`).toBe(true);
    expect(new Set(DEMO.mistakes.map(m => m.shortId)).size).toBe(DEMO.mistakes.length);
  });

  it('loads as the own profile with leaks, due reviews and history', async () => {
    await store.init();
    await store.loadDemo();
    await store.__jobsIdle();
    expect(store.selfProfile.value).toMatchObject({ name: 'Demo Player', demo: true, accounts: [] });
    expect(store.games.value).toHaveLength(DEMO.games.length);
    expect(store.visibleMistakes.value.length).toBeGreaterThan(10);
    expect(store.visibleMistakes.value.some(m => m.severity === 'blunder')).toBe(true);
    expect(store.reviews.value.size).toBe(DEMO.reviews.length);
    expect(store.dueCount.value).toBeGreaterThan(0);
    expect(store.mistakes.value.some(m => m.status === 'mastered')).toBe(true);
    // Loading it fetches only the file, and never triggers a sync or an analysis.
    expect(requests).toEqual(['/demo/demo.json']);
    expect(store.syncProgress.value).toBeNull();
    expect(store.analysisProgress.value).toBeNull();
  });
});
