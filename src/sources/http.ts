// Network plumbing shared by the game sources: typed errors, a retrying fetch, streamed NDJSON/JSON
// readers with an idle watchdog, and the Lichess rate-limit cooldown shared across tabs.
import type { SourceErrorKind } from '../core/types';

export class SourceError extends Error {
  override readonly name = 'SourceError';
  readonly kind: SourceErrorKind;
  readonly status?: number;
  /** Rate limits: how long to wait before the next request to this host. */
  readonly retryAfterMs?: number;

  constructor(kind: SourceErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Like `signal.throwIfAborted()`, but always throws an AbortError (never a custom abort reason). */
export function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Resolves after `ms`; rejects with an AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Lets the browser render and handle input between slices of synchronous work. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Settles like `promise`, or rejects with an AbortError as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── fetchWithRetry ────────────────────────────────────────────────────────

/** Delay before retry n (the last entry repeats). */
export const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
/** Lichess asks clients to wait a full minute after a 429; Chess.com gives no guidance, so the same applies. */
export const MIN_RATE_LIMIT_MS = 60_000;

const DEFAULT_STATUS_KINDS: Readonly<Partial<Record<number, SourceErrorKind>>> = {
  404: 'not-found',
  410: 'not-found',
  429: 'rate-limited',
};

export interface FetchRetryInit extends RequestInit {
  /** Retries after a network error or a 5xx (default 3). */
  retries?: number;
  fetchImpl?: typeof fetch;
  backoffMs?: readonly number[];
  /** Error kinds for specific statuses, e.g. `{ 410: 'closed' }` on user endpoints. Unlisted 4xx/5xx → 'http'. */
  statusKinds?: Readonly<Partial<Record<number, SourceErrorKind>>>;
  /** An attempt without response headers after this long is cancelled and retried like a network error (default 45 s). */
  responseTimeoutMs?: number;
}

/**
 * fetch with retries for transient failures: network errors (TypeError), 5xx and attempts that get
 * no response headers within `responseTimeoutMs` are retried after 1 s, 2 s and 4 s. 404/410 →
 * 'not-found', 429 → 'rate-limited' (retryAfterMs ≥ 60 s), other statuses → 'http'; none of these is
 * retried. An abort rejects at once with an AbortError. `init` is passed to fetch unchanged apart from
 * the options above (no headers are added), except that `signal` is replaced by one that follows it.
 */
export async function fetchWithRetry(url: string, init: FetchRetryInit = {}): Promise<Response> {
  const { retries = DEFAULT_BACKOFF_MS.length, fetchImpl, backoffMs = DEFAULT_BACKOFF_MS, statusKinds, responseTimeoutMs, ...request } = init;
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const signal = request.signal;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
    let res: Response;
    try {
      res = await fetchOnce(doFetch, url, request, responseTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw abortError();
      if (!(err instanceof TypeError || err instanceof ResponseTimeout) || attempt >= retries) throw requestError(url, err);
      await sleep(wait, signal);
      continue;
    }
    if (res.ok) return res;
    const error = statusError(url, res, { ...DEFAULT_STATUS_KINDS, ...statusKinds });
    discardBody(res);
    if (res.status < 500 || attempt >= retries) throw error;
    await sleep(wait, signal);
  }
}

/** No response headers within the response timeout; the attempt was cancelled. */
class ResponseTimeout extends Error {
  override readonly name = 'ResponseTimeout';
}

/**
 * One fetch under its own signal, which follows the caller's (for the whole life of the response, so a
 * caller abort also stops a body being read) and also fires when no headers arrive within `timeoutMs`
 * — the body readers' idle watchdog only starts once there is a body.
 */
async function fetchOnce(doFetch: typeof fetch, url: string, request: RequestInit, timeoutMs: number): Promise<Response> {
  const caller = request.signal;
  const ctl = new AbortController();
  const follow = (): void => ctl.abort();
  caller?.addEventListener('abort', follow, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url, { ...request, signal: ctl.signal });
  } catch (err) {
    caller?.removeEventListener('abort', follow);
    throw timedOut ? new ResponseTimeout('no response') : err;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    // The timer fired as the headers arrived: the body is already cancelled, so this attempt is lost.
    caller?.removeEventListener('abort', follow);
    throw new ResponseTimeout('no response');
  }
  return res;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function requestError(url: string, err: unknown): SourceError {
  if (err instanceof TypeError) return new SourceError('network', `Could not reach ${hostOf(url)}`, { cause: err });
  if (err instanceof ResponseTimeout) return new SourceError('network', `${hostOf(url)} did not answer`, { cause: err });
  return new SourceError('unknown', `Request to ${hostOf(url)} failed: ${String(err)}`, { cause: err });
}

function statusError(url: string, res: Response, kinds: Readonly<Partial<Record<number, SourceErrorKind>>>): SourceError {
  const kind = kinds[res.status] ?? 'http';
  const message = `${hostOf(url)} answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (kind !== 'rate-limited') return new SourceError(kind, message, { status: res.status });
  const retryAfterMs = Math.max(MIN_RATE_LIMIT_MS, retryAfterHeaderMs(res.headers.get('Retry-After')) ?? 0);
  return new SourceError(kind, message, { status: res.status, retryAfterMs });
}

/** `Retry-After` as delay-seconds or an HTTP date → ms from now. */
export function retryAfterHeaderMs(value: string | null, now: number = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Frees the connection of a response we will not read. */
function discardBody(res: Response): void {
  if (res.body && !res.bodyUsed) res.body.cancel().catch(() => undefined);
}

// ── Streamed bodies ───────────────────────────────────────────────────────

/** Abort a body read after this long without a single byte (Lichess streams can stall behind proxies). */
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

export interface ReadOptions {
  signal?: AbortSignal | null;
  /** Default 45 s. */
  idleTimeoutMs?: number;
}

type Chunk = ReadableStreamReadResult<Uint8Array>;

/** One `reader.read()` raced against the idle watchdog and the abort signal. */
function readWithWatchdog(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number, signal?: AbortSignal | null): Promise<Chunk> {
  return new Promise<Chunk>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new SourceError('network', 'stream stalled'));
    }, idleMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      chunk => {
        cleanup();
        resolve(chunk);
      },
      (err: unknown) => {
        cleanup();
        if (isAbortError(err) || signal?.aborted) reject(abortError());
        else reject(new SourceError('network', 'The connection was lost while downloading', { cause: err }));
      },
    );
    if (signal?.aborted) onAbort();
  });
}

/** Decoded text chunks of a response body (UTF-8, multi-byte characters may span network chunks). */
async function* textChunks(res: Response, opts: ReadOptions): AsyncGenerator<string> {
  throwIfAborted(opts.signal);
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  try {
    for (;;) {
      const chunk = await readWithWatchdog(reader, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, opts.signal);
      if (chunk.done) {
        finished = true;
        const tail = decoder.decode();
        if (tail) yield tail;
        return;
      }
      yield decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Aborted, stalled or abandoned by the consumer: release the connection.
    if (!finished) reader.cancel().catch(() => undefined);
  }
}

const SKIP: unique symbol = Symbol('skip');

export interface NdjsonOptions extends ReadOptions {
  /** Called with each non-blank line that is not valid JSON (the line is skipped). */
  onBadLine?(line: string): void;
}

function parseLine(line: string, onBadLine: NdjsonOptions['onBadLine']): unknown {
  const text = line.trim();
  if (text === '') return SKIP;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    onBadLine?.(text);
    return SKIP;
  }
}

/**
 * Streams newline-delimited JSON. Lines may be split anywhere across chunks; blank lines are ignored;
 * a line that is not valid JSON is skipped and reported to `onBadLine`. Rejects with
 * SourceError('network', 'stream stalled') after `idleTimeoutMs` without data, and with an AbortError
 * when `signal` aborts. Stopping the iteration early cancels the body.
 */
export async function* readNdjson(res: Response, opts: NdjsonOptions = {}): AsyncGenerator<unknown> {
  let pending = '';
  for await (const text of textChunks(res, opts)) {
    const lines = (pending + text).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const value = parseLine(line, opts.onBadLine);
      if (value === SKIP) continue;
      throwIfAborted(opts.signal);
      yield value;
    }
  }
  const last = parseLine(pending, opts.onBadLine);
  if (last === SKIP) return;
  throwIfAborted(opts.signal);
  yield last;
}

/** Reads a JSON body with the same watchdog and abort handling as readNdjson. */
export async function readJson(res: Response, opts: ReadOptions = {}): Promise<unknown> {
  let text = '';
  for await (const chunk of textChunks(res, opts)) text += chunk;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new SourceError('unknown', `Unexpected response from ${hostOf(res.url) || 'the server'} (not JSON)`, { status: res.status, cause: err });
  }
}

// ── Lichess cooldown (shared by all tabs and Lichess endpoints) ───────────

export const LICHESS_COOLDOWN_KEY = 'ca:lichessCooldownUntil';

/** Fallback when localStorage is missing (Node) or throws (blocked storage, private mode). */
let memoryCooldownUntil = 0;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** ms epoch until which no Lichess request may be made (0 when none). */
export function lichessCooldownUntil(): number {
  let stored = 0;
  try {
    stored = Number(storage()?.getItem(LICHESS_COOLDOWN_KEY) ?? 0) || 0;
  } catch {
    // unreadable storage: the in-memory value still applies to this tab
  }
  return Math.max(stored, memoryCooldownUntil);
}

export function setLichessCooldown(untilMs: number): void {
  memoryCooldownUntil = untilMs;
  try {
    storage()?.setItem(LICHESS_COOLDOWN_KEY, String(untilMs));
  } catch {
    // quota or blocked storage: this tab still honours the in-memory value
  }
}
