// Direct requests to the Lichess and Chess.com endpoints the app uses, made with fetch() from the app's
// own page: a response the page can read proves CORS works from a browser for real. The
// Access-Control-Allow-Origin header itself is not readable by the page, so it is taken from
// Playwright's view of the network.
import type { Page, Response } from '@playwright/test';
import type { ProbeResult } from './report';

type ProbeKind = 'lichess-user' | 'lichess-games' | 'chesscom-player' | 'chesscom-archives' | 'chesscom-month';

interface ProbeSpec {
  name: string;
  kind: ProbeKind;
  url: string;
  accept?: string;
  /** Same cache mode as the app's Chess.com requests. */
  noCache?: boolean;
}

interface InPageResult {
  status: number | null;
  ok: boolean;
  readable: boolean;
  contentType: string | null;
  etagReadable: boolean;
  lastModifiedReadable: boolean;
  json: 'ok' | 'invalid' | 'skipped';
  items: number | null;
  latestArchive: string | null;
  ms: number;
  error?: string;
}

/** Runs in the page: fetch, then parse the body the way the app would. Self-contained (serialised). */
async function fetchInPage(spec: ProbeSpec): Promise<InPageResult> {
  const t0 = performance.now();
  const base = { contentType: null, etagReadable: false, lastModifiedReadable: false, json: 'skipped' as const, items: null, latestArchive: null };
  const res = await fetch(spec.url, { headers: spec.accept ? { Accept: spec.accept } : {}, cache: spec.noCache ? 'no-cache' : 'default' }).catch(
    (err: unknown) => new Error(String(err)),
  );
  // A CORS rejection and a network failure look the same from the page: fetch() rejects.
  if (res instanceof Error) return { ...base, status: null, ok: false, readable: false, ms: performance.now() - t0, error: res.message };
  const text = await res.text();
  const out: InPageResult = {
    ...base,
    status: res.status,
    ok: res.ok,
    readable: true,
    contentType: res.headers.get('content-type'),
    etagReadable: res.headers.get('etag') !== null,
    lastModifiedReadable: res.headers.get('last-modified') !== null,
    ms: 0,
  };
  if (res.ok) {
    try {
      if (spec.kind === 'lichess-games') {
        const lines = text.split('\n').filter(l => l.trim() !== '');
        for (const line of lines) JSON.parse(line);
        out.items = lines.length;
      } else {
        const body = JSON.parse(text) as { count?: { all?: number }; archives?: string[]; games?: unknown[] };
        if (spec.kind === 'lichess-user') out.items = body.count?.all ?? null;
        if (spec.kind === 'chesscom-archives') {
          out.items = body.archives?.length ?? null;
          out.latestArchive = body.archives?.at(-1) ?? null;
        }
        if (spec.kind === 'chesscom-month') out.items = body.games?.length ?? null;
      }
      out.json = 'ok';
    } catch {
      out.json = 'invalid';
    }
  }
  out.ms = performance.now() - t0;
  return out;
}

async function runProbe(page: Page, spec: ProbeSpec, responses: Map<string, Response>): Promise<{ result: ProbeResult; latestArchive: string | null }> {
  const inPage = await page.evaluate(fetchInPage, spec);
  const response = responses.get(spec.url);
  const allowOrigin = response ? ((await response.allHeaders())['access-control-allow-origin'] ?? null) : null;
  const { latestArchive, ...rest } = inPage;
  return {
    result: { name: spec.name, url: spec.url, ...rest, status: inPage.status ?? response?.status() ?? null, allowOrigin, ms: Math.round(inPage.ms) },
    latestArchive,
  };
}

/** Probes every endpoint the sync uses, for the accounts given (null = that site is skipped). */
export async function probeApis(page: Page, accounts: { lichess: string | null; chesscom: string | null }): Promise<ProbeResult[]> {
  const responses = new Map<string, Response>();
  const onResponse = (r: Response): void => void responses.set(r.url(), r);
  page.on('response', onResponse);
  const results: ProbeResult[] = [];
  try {
    if (accounts.lichess) {
      const u = encodeURIComponent(accounts.lichess);
      results.push((await runProbe(page, { name: 'Lichess user', kind: 'lichess-user', url: `https://lichess.org/api/user/${u}` }, responses)).result);
      const games: ProbeSpec = { name: 'Lichess games (max 5)', kind: 'lichess-games', url: `https://lichess.org/api/games/user/${u}?max=5&moves=true`, accept: 'application/x-ndjson' };
      results.push((await runProbe(page, games, responses)).result);
    }
    if (accounts.chesscom) {
      const u = encodeURIComponent(accounts.chesscom.toLowerCase());
      const player = `https://api.chess.com/pub/player/${u}`;
      results.push((await runProbe(page, { name: 'Chess.com player', kind: 'chesscom-player', url: player, noCache: true }, responses)).result);
      const archives = await runProbe(page, { name: 'Chess.com archives', kind: 'chesscom-archives', url: `${player}/games/archives`, noCache: true }, responses);
      results.push(archives.result);
      if (archives.latestArchive) {
        const month: ProbeSpec = { name: 'Chess.com latest month', kind: 'chesscom-month', url: archives.latestArchive, noCache: true };
        results.push((await runProbe(page, month, responses)).result);
      }
    }
  } finally {
    page.off('response', onResponse);
  }
  return results;
}
