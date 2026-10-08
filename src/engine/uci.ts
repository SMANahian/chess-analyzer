// Parsers for the Stockfish UCI lines the engine layer consumes ('info …' and 'bestmove …').
// Verified against lines captured from the vendored Stockfish 19 lite build (see uci.test.ts).
import type { Score } from '../core/types';

export interface InfoLine {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  /** Side-to-move POV at the searched root. */
  score?: Score;
  /** Set when the score is not exact (aspiration fail, or the iteration was cut short by `stop`). */
  bound?: 'upper' | 'lower';
  nodes?: number;
  nps?: number;
  timeMs?: number;
  pv?: string[];
}

type NumericField = 'depth' | 'seldepth' | 'multipv' | 'nodes' | 'nps' | 'timeMs';

const NUMERIC_TOKENS: Record<string, NumericField> = {
  depth: 'depth',
  seldepth: 'seldepth',
  multipv: 'multipv',
  nodes: 'nodes',
  nps: 'nps',
  time: 'timeMs',
};

/** Tokens followed by a fixed number of values we do not use. */
const SKIPPED_TOKENS: Record<string, number> = { hashfull: 1, tbhits: 1, sbhits: 1, cpuload: 1, wdl: 3 };

function toInt(token: string | undefined): number | undefined {
  if (token === undefined || !/^[+-]?\d+$/.test(token)) return undefined;
  const n = Number(token);
  return n === 0 ? 0 : n; // normalises -0
}

function tokens(line: string): string[] {
  return line.trim().split(/\s+/);
}

/**
 * Parses a search `info` line. Returns null for anything else, for `info string …` and for
 * `currmove` progress lines, and for info lines carrying none of the fields above.
 */
export function parseInfo(line: string): InfoLine | null {
  const t = tokens(line);
  if (t[0] !== 'info' || t[1] === 'string' || t.includes('currmove')) return null;
  const out: InfoLine = {};
  let found = false;
  for (let i = 1; i < t.length; i++) {
    const tok = t[i]!;
    const numeric = NUMERIC_TOKENS[tok];
    if (numeric) {
      const n = toInt(t[i + 1]);
      if (n !== undefined) {
        out[numeric] = n;
        found = true;
        i++;
      }
    } else if (tok === 'score') {
      i = parseScore(t, i, out);
      found ||= out.score !== undefined;
    } else if (tok === 'pv') {
      out.pv = t.slice(i + 1);
      found = true;
      break;
    } else if (tok === 'string' || tok === 'refutation' || tok === 'currline') {
      break; // the rest of the line is free text / move lists we do not use
    } else {
      i += SKIPPED_TOKENS[tok] ?? 0;
    }
  }
  return found ? out : null;
}

/** Parses `score cp N|mate N [upperbound|lowerbound]` starting at t[i] === 'score'; returns the last index consumed. */
function parseScore(t: readonly string[], i: number, out: InfoLine): number {
  const kind = t[i + 1];
  const value = toInt(t[i + 2]);
  if (value === undefined || (kind !== 'cp' && kind !== 'mate')) return i;
  out.score = kind === 'cp' ? { cp: value } : { mate: value };
  i += 2;
  const bound = t[i + 1];
  if (bound === 'upperbound' || bound === 'lowerbound') {
    out.bound = bound === 'upperbound' ? 'upper' : 'lower';
    i++;
  }
  return i;
}

/** 'bestmove e2e4 ponder e7e5' → { best: 'e2e4', ponder: 'e7e5' }; 'bestmove (none)' → { best: null }. */
export function parseBestMove(line: string): { best: string | null; ponder?: string } | null {
  const t = tokens(line);
  if (t[0] !== 'bestmove') return null;
  const move = t[1];
  const best = move && move !== '(none)' && move !== '0000' ? move : null;
  const ponder = t[2] === 'ponder' ? t[3] : undefined;
  return ponder ? { best, ponder } : { best };
}
