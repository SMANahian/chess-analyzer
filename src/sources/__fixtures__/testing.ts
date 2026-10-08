// Helpers for the sources tests (Node only: never import from app code).
import { readFileSync } from 'node:fs';

export function fixture(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixture(name)) as unknown;
}

/** Cuts `text` (as UTF-8) into chunks of the given sizes, cycling through them; cuts may split characters. */
export function chunkBytes(text: string, sizes: readonly number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < bytes.length; k++) {
    const size = sizes[k % sizes.length]!;
    chunks.push(bytes.slice(i, i + size));
    i += size;
  }
  return chunks;
}

export interface TestBody {
  stream: ReadableStream<Uint8Array>;
  /** True once the consumer cancelled the stream. */
  readonly cancelled: boolean;
}

/**
 * A body that delivers one chunk per read, then closes, stalls forever, or errors. `delayMs` waits
 * (with setTimeout, so fake timers apply) before each chunk.
 */
export function testBody(chunks: readonly Uint8Array[], opts: { end?: 'close' | 'stall' | Error; delayMs?: number } = {}): TestBody {
  const { end = 'close', delayMs = 0 } = opts;
  let next = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (next < chunks.length) {
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          controller.enqueue(chunks[next++]!);
        } else if (end === 'close') {
          controller.close();
        } else if (end === 'stall') {
          await new Promise(() => undefined);
        } else {
          controller.error(end);
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    get cancelled() {
      return cancelled;
    },
  };
}

export function streamResponse(text: string, opts: { sizes?: readonly number[]; status?: number; headers?: HeadersInit } = {}): Response {
  const body = testBody(chunkBytes(text, opts.sizes ?? [7, 1, 64, 3, 333]));
  return new Response(body.stream, { status: opts.status ?? 200, headers: opts.headers ?? {} });
}

export const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export type FetchStep = Response | Error | ((call: FetchCall) => Response | Promise<Response>);

/** A fetch that answers the n-th request with the n-th step (a Response, a thrown error, or a handler). */
export function scriptedFetch(steps: readonly FetchStep[]): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    const step = steps[calls.length - 1];
    if (step === undefined) throw new Error(`unexpected request #${calls.length}: ${call.url}`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(call) : step;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A step that never answers, but rejects with an AbortError when the request's signal aborts (like fetch). */
export const hangUntilAborted = (call: FetchCall): Promise<Response> =>
  new Promise((_, reject) => {
    call.init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks and stream reads run. */
export const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
