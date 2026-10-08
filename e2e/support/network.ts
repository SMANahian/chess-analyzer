// Fake Lichess and Chess.com APIs served from e2e/fixtures through Playwright routing. Every other
// external request is blocked and recorded, so a test can assert the app talks to nobody else.
import type { BrowserContext, Route } from '@playwright/test';
import { lichessGames, manifest, readFixture } from './fixtures';

export interface MockOptions {
  /**
   * 'ok' serves the fixtures. 'unreachable' fails every request the way a CORS rejection, an
   * ad-blocker or being offline reaches the page: fetch() rejects with a TypeError. (A response
   * fulfilled by Playwright skips the browser's CORS check, so leaving out the CORS header would not do.)
   * 'export-unreachable' answers the account lookup but fails the game export that way.
   */
  lichess?: 'ok' | 'unreachable' | 'export-unreachable';
  /** Hold the first Lichess game export until release() is called (to observe the sync in progress). */
  holdLichessExport?: boolean;
}

export interface MockNetwork {
  /** External requests answered by the fakes (method, path and query). */
  readonly requests: string[];
  /** External requests to any other host (blocked). */
  readonly blocked: string[];
  /** Lets a held Lichess export through. */
  release(): void;
}

const CORS = { 'access-control-allow-origin': '*' };
const LICHESS_HERO = manifest.lichess.hero.toLowerCase();
const CHESSCOM_HERO = manifest.chesscom.username;

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

/** GET /api/games/user/{u}: the fixture games filtered and ordered like the real export. */
function lichessExport(url: URL): string {
  const q = url.searchParams;
  const since = q.has('since') ? Number(q.get('since')) : -Infinity;
  const until = q.has('until') ? Number(q.get('until')) : Infinity;
  const max = q.has('max') ? Number(q.get('max')) : Infinity;
  const asc = q.get('sort') === 'dateAsc';
  const games = lichessGames
    .filter(g => (g.createdAt as number) >= since && (g.createdAt as number) <= until)
    .sort((a, b) => (asc ? 1 : -1) * ((a.createdAt as number) - (b.createdAt as number)))
    .slice(0, max);
  return games.map(g => `${JSON.stringify(g)}\n`).join('');
}

export async function mockNetwork(context: BrowserContext, opts: MockOptions = {}): Promise<MockNetwork> {
  const requests: string[] = [];
  const blocked: string[] = [];
  let release: () => void = () => undefined;
  const held = opts.holdLichessExport ? new Promise<void>(resolve => (release = resolve)) : Promise.resolve();
  let exports = 0;

  const lichess = async (route: Route, url: URL): Promise<void> => {
    if (opts.lichess === 'unreachable') return route.abort('failed');
    const user = decodeURIComponent(url.pathname.split('/').pop() ?? '').toLowerCase();
    if (url.pathname.startsWith('/api/user/')) {
      return user === LICHESS_HERO ? json(route, 200, readFixture('lichess-user.json')) : json(route, 404, { error: 'Not found' });
    }
    if (url.pathname.startsWith('/api/games/user/')) {
      if (opts.lichess === 'export-unreachable') return route.abort('failed');
      if (user !== LICHESS_HERO) return json(route, 404, { error: 'Not found' });
      if (exports++ === 0) await held;
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/x-ndjson' }, body: lichessExport(url) });
    }
    return json(route, 404, { error: 'Not found' });
  };

  const chesscom = (route: Route, url: URL): Promise<void> => {
    const m = /^\/pub\/player\/([^/]+)(?:\/games\/(archives|\d{4}\/\d{2}))?$/.exec(url.pathname);
    if (!m || m[1]!.toLowerCase() !== CHESSCOM_HERO) return json(route, 404, { code: 0, message: 'User not found.' });
    if (m[2] === undefined) return json(route, 200, readFixture('chesscom/player.json'));
    if (m[2] === 'archives') return json(route, 200, readFixture('chesscom/archives.json'));
    const file = `${m[2].replace('/', '-')}.json`;
    if (!manifest.chesscom.archives.includes(file)) return json(route, 404, { code: 0, message: 'Not found.' });
    return json(route, 200, readFixture(`chesscom/${file}`));
  };

  await context.route(
    url => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'lichess.org') {
        requests.push(`${route.request().method()} lichess.org${url.pathname}${url.search}`);
        return lichess(route, url);
      }
      if (url.hostname === 'api.chess.com') {
        requests.push(`${route.request().method()} api.chess.com${url.pathname}`);
        return chesscom(route, url);
      }
      blocked.push(url.href);
      return route.abort('blockedbyclient');
    },
  );
  return { requests, blocked, release: () => release() };
}
