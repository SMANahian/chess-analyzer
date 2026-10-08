// Named opening positions (lichess-org/chess-openings, built by scripts/build-openings.mjs), keyed by
// position key (EPD with an en-passant square only when a legal capture exists — see chess.ts posKey).
export interface OpeningName {
  eco: string;
  name: string;
}

export interface OpeningsJson {
  entries: [string, string, string][];
}

/** First four FEN fields, so a full FEN finds its book entry too. */
function epdOf(keyOrFen: string): string {
  return keyOrFen.trim().split(/\s+/).slice(0, 4).join(' ');
}

export class OpeningBook {
  private constructor(private readonly byKey: ReadonlyMap<string, OpeningName>) {}

  /** Malformed entries are skipped; for duplicate keys the first entry wins (as in the build script). */
  static fromJson(json: OpeningsJson): OpeningBook {
    const byKey = new Map<string, OpeningName>();
    for (const entry of json.entries) {
      if (!Array.isArray(entry)) continue;
      const [key, eco, name] = entry;
      if (typeof key === 'string' && typeof eco === 'string' && typeof name === 'string' && !byKey.has(key)) {
        byKey.set(key, { eco, name });
      }
    }
    return new OpeningBook(byKey);
  }

  get size(): number {
    return this.byKey.size;
  }

  /** By position key (a full FEN is accepted too). */
  lookup(key: string): OpeningName | undefined {
    return this.byKey.get(key) ?? this.byKey.get(epdOf(key));
  }

  has(key: string): boolean {
    return this.lookup(key) !== undefined;
  }

  /** The deepest named position along a path: the last key that is in the book. */
  nameForKeys(keys: readonly string[]): OpeningName | undefined {
    for (let i = keys.length - 1; i >= 0; i--) {
      const hit = this.lookup(keys[i]!);
      if (hit) return hit;
    }
    return undefined;
  }
}

function isOpeningsJson(json: unknown): json is OpeningsJson {
  return typeof json === 'object' && json !== null && Array.isArray((json as { entries?: unknown }).entries);
}

function defaultUrl(): string {
  // import.meta.env only exists under Vite (app, Vitest); plain Node has no base URL.
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}data/openings.json`;
}

async function fetchBook(url: string, fetchImpl: typeof fetch): Promise<OpeningBook> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Could not load the openings book from ${url} (HTTP ${res.status})`);
  const json: unknown = await res.json();
  if (!isOpeningsJson(json)) throw new Error(`The openings book at ${url} is malformed`);
  return OpeningBook.fromJson(json);
}

const loaded = new Map<string, Promise<OpeningBook>>();

/** Loads `${BASE_URL}data/openings.json` (or `url`) once; a failed load is forgotten so it can be retried. */
export function loadOpeningBook(url: string = defaultUrl(), fetchImpl?: typeof fetch): Promise<OpeningBook> {
  const cached = loaded.get(url);
  if (cached) return cached;
  const doFetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const promise = fetchBook(url, doFetch).catch((err: unknown) => {
    loaded.delete(url);
    throw err;
  });
  loaded.set(url, promise);
  return promise;
}
