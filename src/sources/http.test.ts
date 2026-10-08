import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LICHESS_COOLDOWN_KEY,
  SourceError,
  fetchWithRetry,
  lichessCooldownUntil,
  readJson,
  readNdjson,
  retryAfterHeaderMs,
  setLichessCooldown,
} from './http';
import { chunkBytes, fixture, flush, hangUntilAborted, scriptedFetch, streamResponse, testBody } from './__fixtures__/testing';

const URL_A = 'https://lichess.org/api/thing';
const ok = (text = 'ok'): Response => new Response(text);
const status = (code: number, headers: HeadersInit = {}): Response => new Response('error page', { status: code, headers });

async function collect(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of gen) out.push(value);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SourceError', () => {
  it('carries kind, status and retryAfterMs', () => {
    const err = new SourceError('rate-limited', 'slow down', { status: 429, retryAfterMs: 60_000 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'SourceError', kind: 'rate-limited', status: 429, retryAfterMs: 60_000, message: 'slow down' });
    expect(new SourceError('network', 'x')).toMatchObject({ kind: 'network', status: undefined, retryAfterMs: undefined });
  });
});

describe('fetchWithRetry', () => {
  it('passes the request through without adding headers or its own options', async () => {
    const { fetchImpl, calls } = scriptedFetch([ok('hello')]);
    const signal = new AbortController().signal;
    const res = await fetchWithRetry(URL_A, { fetchImpl, cache: 'no-cache', headers: { Accept: 'application/x-ndjson' }, signal, retries: 2, backoffMs: [5] });
    expect(await res.text()).toBe('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_A);
    // The signal is fetchWithRetry's own (it also carries the response timeout) and follows the caller's.
    const { signal: passed, ...rest } = calls[0]!.init;
    expect(rest).toEqual({ cache: 'no-cache', headers: { Accept: 'application/x-ndjson' } });
    expect(passed).toBeInstanceOf(AbortSignal);
  });

  it('retries network errors and 5xx after 1 s, 2 s and 4 s', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scriptedFetch([status(503), new TypeError('Failed to fetch'), status(502), ok('finally')]);
    const res = fetchWithRetry(URL_A, { fetchImpl });
    const callsAfter = async (ms: number): Promise<number> => {
      await vi.advanceTimersByTimeAsync(ms);
      return calls.length;
    };
    expect(await callsAfter(0)).toBe(1);
    expect(await callsAfter(999)).toBe(1);
    expect(await callsAfter(1)).toBe(2);
    expect(await callsAfter(1999)).toBe(2);
    expect(await callsAfter(1)).toBe(3);
    expect(await callsAfter(3999)).toBe(3);
    expect(await callsAfter(1)).toBe(4);
    expect(await (await res).text()).toBe('finally');
  });

  it('gives up after `retries` retries with the last error', async () => {
    const http = scriptedFetch([status(500), status(500), status(503)]);
    await expect(fetchWithRetry(URL_A, { fetchImpl: http.fetchImpl, retries: 2, backoffMs: [0] })).rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(http.calls).toHaveLength(3);

    const net = scriptedFetch([new TypeError('a'), new TypeError('b'), new TypeError('c'), new TypeError('d')]);
    const err = await fetchWithRetry(URL_A, { fetchImpl: net.fetchImpl, backoffMs: [0] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ kind: 'network', message: 'Could not reach lichess.org' });
    expect(net.calls).toHaveLength(4);

    const once = scriptedFetch([status(500)]);
    await expect(fetchWithRetry(URL_A, { fetchImpl: once.fetchImpl, retries: 0 })).rejects.toMatchObject({ kind: 'http', status: 500 });
  });

  it.each([
    [404, 'not-found'],
    [410, 'not-found'],
    [400, 'http'],
    [403, 'http'],
    [401, 'http'],
  ] as const)('maps HTTP %i to %s without retrying', async (code, kind) => {
    const { fetchImpl, calls } = scriptedFetch([status(code), ok()]);
    await expect(fetchWithRetry(URL_A, { fetchImpl, backoffMs: [0] })).rejects.toMatchObject({ kind, status: code });
    expect(calls).toHaveLength(1);
  });

  it('lets user endpoints map 403/410 to closed', async () => {
    const statusKinds = { 403: 'closed', 410: 'closed' } as const;
    for (const code of [403, 410]) {
      const { fetchImpl } = scriptedFetch([status(code)]);
      await expect(fetchWithRetry(URL_A, { fetchImpl, statusKinds })).rejects.toMatchObject({ kind: 'closed', status: code });
    }
    const { fetchImpl } = scriptedFetch([status(404)]);
    await expect(fetchWithRetry(URL_A, { fetchImpl, statusKinds })).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('turns 429 into rate-limited with at least a minute to wait, never retried', async () => {
    const cases: [HeadersInit, number][] = [
      [{}, 60_000],
      [{ 'Retry-After': '5' }, 60_000],
      [{ 'Retry-After': '120' }, 120_000],
      [{ 'Retry-After': 'soon' }, 60_000],
    ];
    for (const [headers, wait] of cases) {
      const { fetchImpl, calls } = scriptedFetch([status(429, headers), ok()]);
      await expect(fetchWithRetry(URL_A, { fetchImpl, backoffMs: [0] })).rejects.toMatchObject({ kind: 'rate-limited', status: 429, retryAfterMs: wait });
      expect(calls).toHaveLength(1);
    }
  });

  it('wraps errors that are not network errors as unknown, without retrying', async () => {
    const { fetchImpl, calls } = scriptedFetch([new RangeError('bad init'), ok()]);
    await expect(fetchWithRetry(URL_A, { fetchImpl })).rejects.toMatchObject({ kind: 'unknown' });
    expect(calls).toHaveLength(1);
  });

  describe('abort', () => {
    it('rejects before fetching when already aborted', async () => {
      const { fetchImpl, calls } = scriptedFetch([ok()]);
      await expect(fetchWithRetry(URL_A, { fetchImpl, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(0);
    });

    it('rejects immediately when aborted during a request, without retrying', async () => {
      const ac = new AbortController();
      const { fetchImpl, calls } = scriptedFetch([hangUntilAborted, ok()]);
      const res = fetchWithRetry(URL_A, { fetchImpl, signal: ac.signal, backoffMs: [0] });
      await flush();
      ac.abort();
      const err: unknown = await res.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DOMException);
      expect(err).toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(1);
    });

    it('gives up on an attempt without response headers after 45 s and retries it like a network error', async () => {
      vi.useFakeTimers();
      const { fetchImpl, calls } = scriptedFetch([hangUntilAborted, hangUntilAborted, ok('third time')]);
      const res = fetchWithRetry(URL_A, { fetchImpl });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls[0]!.init.signal?.aborted).toBe(true); // the stalled request is cancelled, not leaked
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(45_000 + 2_000);
      expect(await (await res).text()).toBe('third time');

      const stalled = scriptedFetch([hangUntilAborted]);
      const outcome = expect(fetchWithRetry(URL_A, { fetchImpl: stalled.fetchImpl, retries: 0, responseTimeoutMs: 5_000 })).rejects.toMatchObject({ kind: 'network' });
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
    });

    it('a caller abort still reaches a request whose headers arrived (the body read is aborted too)', async () => {
      const ac = new AbortController();
      const { fetchImpl, calls } = scriptedFetch([ok('body')]);
      await fetchWithRetry(URL_A, { fetchImpl, signal: ac.signal });
      expect(calls[0]!.init.signal?.aborted).toBe(false);
      ac.abort();
      expect(calls[0]!.init.signal?.aborted).toBe(true);
    });

    it('rejects immediately when aborted during the backoff', async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const { fetchImpl, calls } = scriptedFetch([status(503), ok()]);
      const res = fetchWithRetry(URL_A, { fetchImpl, signal: ac.signal });
      const outcome = expect(res).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(500);
      ac.abort('user cancelled'); // a custom reason still surfaces as AbortError
      await outcome;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(1);
    });
  });
});

describe('retryAfterHeaderMs', () => {
  it('reads delay-seconds and HTTP dates', () => {
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    expect(retryAfterHeaderMs('90', now)).toBe(90_000);
    expect(retryAfterHeaderMs(' 0 ', now)).toBe(0);
    expect(retryAfterHeaderMs('Thu, 08 Oct 2026 12:02:00 GMT', now)).toBe(120_000);
    expect(retryAfterHeaderMs('Thu, 08 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(retryAfterHeaderMs('later', now)).toBeUndefined();
    expect(retryAfterHeaderMs(null, now)).toBeUndefined();
  });
});

describe('readNdjson', () => {
  const NDJSON = fixture('lichess-games.ndjson');
  const expected = NDJSON.split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as unknown);

  it('parses every line whatever the chunking', async () => {
    expect(expected).toHaveLength(14);
    for (const sizes of [[1], [2], [3], [7], [64], [1000], [5, 1, 400, 2], [NDJSON.length]]) {
      const res = new Response(testBody(chunkBytes(NDJSON, sizes)).stream);
      expect(await collect(readNdjson(res)), `chunk sizes ${sizes.join(',')}`).toEqual(expected);
    }
  });

  it('decodes multi-byte characters split across chunks; skips blank lines, CRLF and bad lines', async () => {
    const text = '{"name":"Müller ♞"}\r\n\n   \n{"name":"Ærø 🐴"}\n{bad json\n[1,2]\nnull\n{"last":true}';
    const bad: string[] = [];
    for (const size of [1, 2, 3, 5]) {
      bad.length = 0;
      const res = new Response(testBody(chunkBytes(text, [size])).stream);
      const values = await collect(readNdjson(res, { onBadLine: line => bad.push(line) }));
      expect(values).toEqual([{ name: 'Müller ♞' }, { name: 'Ærø 🐴' }, [1, 2], null, { last: true }]);
      expect(bad).toEqual(['{bad json']);
    }
  });

  it('handles an empty body', async () => {
    expect(await collect(readNdjson(new Response('')))).toEqual([]);
    expect(await collect(readNdjson(new Response(null)))).toEqual([]);
  });

  it('stops with an AbortError when aborted mid-stream and cancels the body', async () => {
    const ac = new AbortController();
    const body = testBody(chunkBytes(NDJSON, [900]), { end: 'stall' });
    const lines = readNdjson(new Response(body.stream), { signal: ac.signal });
    expect((await lines.next()).value).toEqual(expected[0]);
    ac.abort();
    await expect(lines.next()).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(body.cancelled).toBe(true);
  });

  it('stops with an AbortError when aborted while waiting for data', async () => {
    const ac = new AbortController();
    const body = testBody(chunkBytes('{"a":1}\n', [100]), { end: 'stall' });
    const lines = readNdjson(new Response(body.stream), { signal: ac.signal });
    expect((await lines.next()).value).toEqual({ a: 1 });
    const pending = lines.next();
    await flush();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(body.cancelled).toBe(true);
  });

  it('rejects with AbortError up front for an aborted signal', async () => {
    await expect(readNdjson(new Response('{}\n'), { signal: AbortSignal.abort() }).next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels the body when the consumer stops early', async () => {
    const body = testBody(chunkBytes(NDJSON, [500]));
    for await (const value of readNdjson(new Response(body.stream))) {
      expect(value).toEqual(expected[0]);
      break;
    }
    await flush();
    expect(body.cancelled).toBe(true);
  });

  it('turns a connection error mid-stream into a network SourceError', async () => {
    const body = testBody(chunkBytes('{"a":1}\n{"b":', [100]), { end: new TypeError('terminated') });
    const values: unknown[] = [];
    const err = await (async () => {
      for await (const value of readNdjson(new Response(body.stream))) values.push(value);
    })().catch((e: unknown) => e);
    expect(values).toEqual([{ a: 1 }]);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ kind: 'network' });
  });

  describe('idle watchdog', () => {
    it('aborts the read after 45 s without data', async () => {
      vi.useFakeTimers();
      const body = testBody(chunkBytes('{"a":1}\n{"b"', [100]), { end: 'stall' });
      const lines = readNdjson(new Response(body.stream));
      expect((await lines.next()).value).toEqual({ a: 1 });
      let settled = false;
      const pending = lines.next().finally(() => (settled = true));
      const outcome = expect(pending).rejects.toSatisfy(e => e instanceof SourceError && e.kind === 'network' && e.message === 'stream stalled');
      await vi.advanceTimersByTimeAsync(44_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      await vi.advanceTimersByTimeAsync(0);
      expect(body.cancelled).toBe(true);
    });

    it('honours a custom timeout and tolerates slow but steady streams', async () => {
      vi.useFakeTimers();
      const slow = testBody(chunkBytes('{"a":1}\n{"b":2}\n{"c":3}\n', [8]), { delayMs: 30_000 });
      const values = collect(readNdjson(new Response(slow.stream)));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await values).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);

      const stalled = testBody([], { end: 'stall' });
      const outcome = expect(collect(readNdjson(new Response(stalled.stream), { idleTimeoutMs: 5_000 }))).rejects.toMatchObject({ kind: 'network' });
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
    });
  });
});

describe('readJson', () => {
  it('reads a chunked JSON body', async () => {
    const value = { archives: ['a', 'b'], name: 'Ærø' };
    expect(await readJson(streamResponse(JSON.stringify(value), { sizes: [1, 2] }))).toEqual(value);
  });

  it('rejects malformed bodies as unknown and honours abort', async () => {
    await expect(readJson(new Response('<html>Cloudflare</html>'))).rejects.toMatchObject({ kind: 'unknown' });
    await expect(readJson(new Response('{}'), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Lichess cooldown', () => {
  beforeEach(() => setLichessCooldown(0));
  afterEach(() => {
    vi.unstubAllGlobals();
    setLichessCooldown(0);
  });

  it('falls back to memory when there is no localStorage (Node)', () => {
    expect(typeof localStorage).toBe('undefined');
    expect(lichessCooldownUntil()).toBe(0);
    setLichessCooldown(1_000_000);
    expect(lichessCooldownUntil()).toBe(1_000_000);
  });

  it('shares the cooldown through localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    setLichessCooldown(5_000);
    expect(store.get(LICHESS_COOLDOWN_KEY)).toBe('5000');
    expect(LICHESS_COOLDOWN_KEY).toBe('ca:lichessCooldownUntil');
    store.set(LICHESS_COOLDOWN_KEY, '9000'); // another tab hit a 429
    expect(lichessCooldownUntil()).toBe(9_000);
    store.set(LICHESS_COOLDOWN_KEY, 'garbage');
    expect(lichessCooldownUntil()).toBe(5_000);
  });

  it('still works when storage throws (blocked or private mode)', () => {
    const throwing = (): never => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: throwing, setItem: throwing });
    setLichessCooldown(7_000);
    expect(lichessCooldownUntil()).toBe(7_000);
  });
});
