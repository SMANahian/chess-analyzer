// PGN files of any size: streamed from a Blob in chunks, split into games and converted to RawGame,
// yielding to the event loop regularly so the page stays responsive.
import { LoneCrNormalizer, PgnNameCounter, PgnStreamSplitter, parsePgnGame, pgnGameToRaw } from '../core/pgn';
import { MAX_STORED_PLIES, type RawGame } from '../core/types';
import { throwIfAborted, yieldToEventLoop } from './http';

export interface PgnReadCounts {
  /** Games yielded so far. */
  games: number;
  /** Games that are not standard chess from the standard start, or have no legal moves. */
  skipped: number;
}

export interface PgnReadOptions {
  signal?: AbortSignal;
  /** After each chunk; `totalBytes` is the UTF-8 size (for a string input too). */
  onProgress?(doneBytes: number, totalBytes: number, counts: PgnReadCounts): void;
  /** Moves kept per game (default MAX_STORED_PLIES). */
  maxPlies?: number;
}

/** Games converted between two yields to the event loop. */
const GAMES_PER_SLICE = 200;

/** Decoded chunks of a Blob with their byte sizes; the last chunk has `last: true`. */
async function* blobText(blob: Blob, signal?: AbortSignal): AsyncGenerator<{ text: string; bytes: number; last: boolean }> {
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder();
  let finished = false;
  try {
    for (;;) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        yield { text: decoder.decode(), bytes: 0, last: true };
        return;
      }
      yield { text: decoder.decode(chunk.value, { stream: true }), bytes: chunk.value.byteLength, last: false };
    }
  } finally {
    if (!finished) reader.cancel().catch(() => undefined);
  }
}

const asBlob = (input: Blob | string): Blob => (typeof input === 'string' ? new Blob([input]) : input);

/**
 * Streams the standard games of a PGN file (or text) as RawGame. Rejects with an AbortError when
 * `signal` aborts. Returns the final counts when the iteration completes.
 */
export async function* readPgnFile(input: Blob | string, opts: PgnReadOptions = {}): AsyncGenerator<RawGame, PgnReadCounts, undefined> {
  const { signal, onProgress, maxPlies = MAX_STORED_PLIES } = opts;
  const blob = asBlob(input);
  const splitter = new PgnStreamSplitter();
  const counts: PgnReadCounts = { games: 0, skipped: 0 };
  let doneBytes = 0;
  let sliceLeft = GAMES_PER_SLICE;
  for await (const { text, bytes, last } of blobText(blob, signal)) {
    const games = splitter.push(text);
    if (last) games.push(...splitter.flush());
    for (const gameText of games) {
      const raw = pgnGameToRaw(parsePgnGame(gameText, maxPlies));
      if (raw) {
        counts.games++;
        throwIfAborted(signal);
        yield raw;
      } else {
        counts.skipped++;
      }
      if (--sliceLeft === 0) {
        sliceLeft = GAMES_PER_SLICE;
        await yieldToEventLoop();
        throwIfAborted(signal);
      }
    }
    doneBytes += bytes;
    onProgress?.(doneBytes, blob.size, { ...counts });
  }
  return counts;
}

/**
 * Most frequent White/Black names in a PGN file, for "Which of these is you?". Reads tag lines only:
 * no game is split or parsed.
 */
export async function scanPgnFileNames(input: Blob | string, limit = 10, opts: { signal?: AbortSignal } = {}): Promise<{ name: string; games: number }[]> {
  const counter = new PgnNameCounter();
  // Lone CRs (old Mac files) become line breaks, so the file is still read a line at a time.
  const cr = new LoneCrNormalizer();
  let partialLine = '';
  for await (const chunk of blobText(asBlob(input), opts.signal)) {
    const text = cr.push(chunk.text);
    const cut = text.lastIndexOf('\n') + 1;
    if (cut === 0) {
      partialLine += text;
      continue;
    }
    counter.add(partialLine + text.slice(0, cut));
    partialLine = text.slice(cut);
  }
  counter.add(partialLine + cr.flush());
  return counter.top(limit);
}
