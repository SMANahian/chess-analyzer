// PGN export of mistakes (Lichess study / Chessable import): one game per mistake, starting at the
// mistake position, with the best move as the mainline and the habit move as a variation.
import { formatLine, lineToSan, playUci } from './chess';
import { explainMistake } from './explain';
import type { Mistake, Severity } from './types';

/** Plies of the best line and of the refutation line shown. */
const LINE_PLIES = 8;
const LINE_WIDTH = 80;
const MINUS = '−';
/** ?! / ? / ?? as numeric annotation glyphs. */
const NAGS: Record<Severity, string> = { inaccuracy: '$6', mistake: '$2', blunder: '$4' };

const escapeTag = (value: string): string =>
  value.replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
/** PGN comments cannot contain a closing brace, and there is no escape for it. */
const comment = (text: string): string => `{${text.replace(/[{}]/g, '')}}`;

function pgnDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '????.??.??';
  return d.toISOString().slice(0, 10).replace(/-/g, '.');
}

function headers(m: Mistake, opts: { profileName: string; now: number }): string {
  const tags: [string, string][] = [
    ['Event', `Chess Analyzer: ${opts.profileName}`],
    ['Site', ''],
    ['Date', pgnDate(opts.now)],
    ['White', '?'],
    ['Black', '?'],
    ['Result', '*'],
    ['SetUp', '1'],
    ['FEN', m.fen],
    ['Annotator', 'Chess Analyzer'],
  ];
  if (m.openingEco) tags.push(['ECO', m.openingEco]);
  if (m.openingName) tags.push(['Opening', m.openingName]);
  return tags.map(([name, value]) => `[${name} "${escapeTag(value)}"]`).join('\n');
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "You played Bc5 in 7 of 9 games (−12% winning chances)." */
function statsComment(m: Mistake, habitSan: string): string {
  const loss = Math.round(m.winLoss);
  const tail = m.kind === 'book' ? ' A dubious book line.' : '';
  return `You played ${habitSan} in ${m.count} of ${plural(m.positionCount, 'game')} (${MINUS}${loss}% winning chances).${tail}`;
}

/** Move-number tokens for `sans` from `fen`; empty for an empty line. */
const lineTokens = (sans: readonly string[], fen: string): string[] => (sans.length ? formatLine(sans, fen).split(' ') : []);

/** "(7. Ng5 $2 {Loses a pawn.} 7... d5 8. exd5)" as tokens. */
function variationTokens(m: Mistake, sans: readonly string[]): string[] {
  const nag = NAGS[m.severity];
  // Judged against the best line: material the best move gives up too is not the habit's fault.
  const explanation = explainMistake(m);
  const after = playUci(m.fen, m.move) ?? m.fen;
  const tokens = [...lineTokens(sans.slice(0, 1), m.fen), nag];
  if (explanation) tokens.push(comment(`${explanation[0]!.toUpperCase()}${explanation.slice(1)}.`));
  tokens.push(...lineTokens(sans.slice(1), after));
  tokens[0] = `(${tokens[0]}`;
  tokens[tokens.length - 1] += ')';
  return tokens;
}

/** Joins tokens into lines of at most LINE_WIDTH characters (a long comment gets a line of its own). */
function wrap(tokens: readonly string[]): string {
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    if (line && line.length + 1 + token.length > LINE_WIDTH) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function gamePgn(m: Mistake, opts: { profileName: string; now: number }): string {
  const best = lineToSan(m.fen, m.bestLine.slice(0, LINE_PLIES));
  const habit = lineToSan(m.fen, m.playedLine.slice(0, LINE_PLIES));
  const tokens: string[] = [comment(statsComment(m, habit[0] ?? m.move))];
  if (best.length > 0) {
    tokens.push(...lineTokens(best.slice(0, 1), m.fen));
    if (habit.length > 0) tokens.push(...variationTokens(m, habit));
    tokens.push(...lineTokens(best.slice(1), playUci(m.fen, m.bestLine[0]!) ?? m.fen));
  }
  tokens.push('*');
  return `${headers(m, opts)}\n\n${wrap(tokens)}\n`;
}

/** One PGN game per mistake: best move as mainline, habit move as a variation with refutation, comments with stats. */
export function mistakesToPgn(ms: readonly Mistake[], opts: { profileName: string; now: number }): string {
  return ms.map(m => gamePgn(m, opts)).join('\n');
}
