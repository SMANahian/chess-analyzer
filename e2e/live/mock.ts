// LIVE_MOCK=1: serves Lichess and Chess.com from recorded fixtures, to rehearse the live test where
// the real sites are unreachable. The summary is labelled "mock"; the workflow never sets it.
// Lichess serves the synthetic player 'hero' (300 games with planted habits); Chess.com serves the
// hand-made SMA-Nahian archives. Responses carry the CORS header the real APIs send.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';

const fixture = (path: string): string => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

export const MOCK_ACCOUNTS = { lichess: 'hero', chesscom: 'SMA-Nahian' } as const;

function fulfill(route: Route, status: number, body: string, contentType = 'application/json'): Promise<void> {
  return route.fulfill({ status, body, contentType, headers: { 'access-control-allow-origin': '*' } });
}

function lichess(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const lines = readFileSync(fixture('services/__fixtures__/hero-300.ndjson'), 'utf8').split('\n').filter(Boolean);
  const user = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  if (user.toLowerCase() !== MOCK_ACCOUNTS.lichess) return fulfill(route, 404, '{"error":"Not found"}');
  if (url.pathname.startsWith('/api/user/')) {
    return fulfill(route, 200, JSON.stringify({ id: user.toLowerCase(), username: user, count: { all: lines.length } }));
  }
  return fulfill(route, 200, lichessPage(lines, url.searchParams), 'application/x-ndjson');
}

/** The export's since / until / sort / max parameters over the fixture (which is newest first). */
function lichessPage(lines: readonly string[], params: URLSearchParams): string {
  const since = Number(params.get('since') ?? -Infinity);
  const until = Number(params.get('until') ?? Infinity);
  const max = Number(params.get('max') ?? Infinity);
  const createdAt = (line: string): number => (JSON.parse(line) as { createdAt: number }).createdAt;
  const page = lines.filter(l => createdAt(l) >= since && createdAt(l) <= until);
  if (params.get('sort') === 'dateAsc') page.reverse();
  return page
    .slice(0, max)
    .map(l => `${l}\n`)
    .join('');
}

function chesscom(route: Route): Promise<void> {
  const path = new URL(route.request().url()).pathname;
  const month = /\/games\/(\d{4})\/(\d{2})$/.exec(path);
  let file: string;
  if (month) file = `sources/__fixtures__/chesscom-${month[1]}-${month[2]}.json`;
  else if (path.endsWith('/games/archives')) file = 'sources/__fixtures__/chesscom-archives.json';
  else file = 'sources/__fixtures__/chesscom-player.json';
  if (!path.startsWith(`/pub/player/${MOCK_ACCOUNTS.chesscom.toLowerCase()}`)) return fulfill(route, 404, '{"code":0,"message":"not found"}');
  if (!existsSync(fixture(file))) return fulfill(route, 200, '{"games":[]}');
  return fulfill(route, 200, readFileSync(fixture(file), 'utf8'));
}

export async function routeRecordedApis(page: Page): Promise<void> {
  await page.route('https://lichess.org/api/**', lichess);
  await page.route('https://api.chess.com/pub/**', chesscom);
}
