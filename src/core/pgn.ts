// Fast PGN extraction: headers plus the first N mainline SAN moves, without building move trees
// (several times faster than chessops' parsePgn). Checked against chessops on 3,000 synthetic games:
// identical headers, SAN and mainline length. Games are split at a blank line followed by a tag
// line (`[Name "`); unlike chessops, a blank line inside the movetext does not start a new game.
import { isStandardStartFen, sansToUci } from './chess';
import { fnv1a64 } from './hash';
import { MAX_STORED_PLIES, type GameResult, type Platform, type RawGame, type Speed } from './types';

export interface PgnGame {
  headers: Record<string, string>;
  /** Mainline SAN (at most `maxPlies`), without move numbers, NAGs or `!?` suffixes; `0-0` → `O-O`. */
  sans: string[];
  /** Mainline moves in the whole game (not capped by `maxPlies`). */
  plyCount: number;
}

const code = (ch: string): number => ch.charCodeAt(0);
const LF = code('\n');
const CR = code('\r');
const TAB = code('\t');
const SPACE = code(' ');
const BOM = 0xfeff;
const DOLLAR = code('$');
const PERCENT = code('%');
const LPAREN = code('(');
const RPAREN = code(')');
const DOT = code('.');
const SEMICOLON = code(';');
const LBRACKET = code('[');
const LBRACE = code('{');
const RBRACE = code('}');
const BANG = code('!');
const QUESTION = code('?');
const QUOTE = code('"');
const STAR = code('*');
const DASH = code('-');
const SLASH = code('/');
const AT = code('@');
const ZERO = code('0');
const NINE = code('9');
const EN_DASH = code('–');
const EM_DASH = code('—');
const UPPER_A = code('A');
const UPPER_Z = code('Z');
const LOWER_A = code('a');
const LOWER_Z = code('z');
const UNDERSCORE = code('_');

const ELLIPSIS = code('…');

const isDigit = (c: number): boolean => c >= ZERO && c <= NINE;
const isDot = (c: number): boolean => c === DOT || c === ELLIPSIS;
const isTagNameChar = (c: number): boolean =>
  isDigit(c) || (c >= UPPER_A && c <= UPPER_Z) || (c >= LOWER_A && c <= LOWER_Z) || c === UNDERSCORE;
const isDelimiter = (c: number): boolean =>
  c <= SPACE || c === LBRACE || c === RBRACE || c === LPAREN || c === RPAREN || c === SEMICOLON || c === DOLLAR;

// ── Splitting ─────────────────────────────────────────────────────────────

/** Game termination markers (with the en and em dashes some editors produce). */
const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '½-½', '*', '1–0', '0–1', '1/2–1/2', '1—0', '0—1', '1/2—1/2']);

function isBlank(s: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (s.charCodeAt(i) > SPACE) return false;
  return true;
}

/** `[ \t]*\[Name[ \t]+"` at the start of the line. */
function isTagLine(s: string, start: number, end: number): boolean {
  let i = start;
  while (i < end && (s.charCodeAt(i) === SPACE || s.charCodeAt(i) === TAB)) i++;
  if (s.charCodeAt(i++) !== LBRACKET) return false;
  const nameStart = i;
  while (i < end && isTagNameChar(s.charCodeAt(i))) i++;
  if (i === nameStart) return false;
  const nameEnd = i;
  while (i < end && (s.charCodeAt(i) === SPACE || s.charCodeAt(i) === TAB)) i++;
  return i > nameEnd && s.charCodeAt(i) === QUOTE;
}

/** Does the line text[start, end) end with a game termination marker ('1-0', '*', …)? */
function endsWithResult(s: string, start: number, end: number): boolean {
  let e = end;
  while (e > start && s.charCodeAt(e - 1) <= SPACE) e--;
  let b = e;
  while (b > start && e - b <= 7 && s.charCodeAt(b - 1) > SPACE) b--;
  // The longest marker is '1/2-1/2'; longer tokens are never sliced.
  return e > b && e - b <= 7 && (b === start || s.charCodeAt(b - 1) <= SPACE) && RESULTS.has(s.slice(b, e));
}

/**
 * Incremental game splitter for huge files. Feed text chunks of any size (split anywhere, even inside
 * a CRLF pair); returns whole-game texts, trimmed of surrounding blank lines. Works line by line, so
 * the output never depends on where the chunks were cut, and in linear time: chunks without a line
 * break are only joined once one arrives, and a game's lines are kept as pieces until it is complete.
 *
 * A new game starts at a tag line after a blank line, or at any line after a line ending with a
 * result when the two are separated by a blank line or the new line is a tag line (games without
 * headers, or a missing blank line between games). A blank line inside the movetext is not a break.
 */
export class PgnStreamSplitter {
  /** Text after the last line break (a partial line). */
  private tail = '';
  /** Chunks without a line break, appended to `tail` when a line break arrives. */
  private pending: string[] = [];
  /** The current game's complete lines so far. */
  private pieces: string[] = [];
  private piecesLength = 0;
  /** Length of the current game up to the end of its last non-blank line (line break excluded); -1 before its first line. */
  private contentLength = -1;
  private prevBlank = false;
  private afterResult = false;
  private started = false;

  push(chunk: string): string[] {
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === BOM) chunk = chunk.slice(1);
    }
    if (!chunk.includes('\n')) {
      if (chunk) this.pending.push(chunk);
      return [];
    }
    const out: string[] = [];
    this.tail = this.consume(this.joinTail(chunk), false, out);
    return out;
  }

  flush(): string[] {
    const out: string[] = [];
    this.consume(this.joinTail(''), true, out);
    if (this.contentLength >= 0) this.emit('', out);
    this.tail = '';
    this.prevBlank = false;
    this.afterResult = false;
    this.started = false;
    return out;
  }

  private joinTail(chunk: string): string {
    const text = this.pending.length > 0 ? this.tail + this.pending.join('') + chunk : this.tail + chunk;
    this.pending = [];
    return text;
  }

  /** Processes the complete lines of `text` (and its last partial line when `final`); returns the rest. */
  private consume(text: string, final: boolean, out: string[]): string {
    let segStart = 0; // start of the current game's lines that are not in `pieces` yet
    let start = 0;
    while (start < text.length) {
      let nl = text.indexOf('\n', start);
      if (nl < 0) {
        if (!final) break;
        nl = text.length;
      }
      const end = nl > start && text.charCodeAt(nl - 1) === CR ? nl - 1 : nl;
      if (isBlank(text, start, end)) {
        this.prevBlank = true;
        if (this.contentLength < 0) segStart = nl + 1;
      } else {
        if (this.contentLength >= 0 && this.startsGame(text, start, end)) {
          this.emit(text.slice(segStart, start), out);
          segStart = start;
        }
        this.contentLength = this.piecesLength + (end - segStart);
        this.prevBlank = false;
        this.afterResult = endsWithResult(text, start, end);
      }
      start = nl + 1;
    }
    const done = Math.min(start, text.length);
    if (this.contentLength >= 0 && done > segStart) {
      this.pieces.push(text.slice(segStart, done));
      this.piecesLength += done - segStart;
    }
    return text.slice(done);
  }

  private startsGame(text: string, start: number, end: number): boolean {
    if (this.afterResult && this.prevBlank) return true;
    return (this.prevBlank || this.afterResult) && isTagLine(text, start, end);
  }

  /** Emits the current game (its pieces plus `last`), trimmed after its last non-blank line. */
  private emit(last: string, out: string[]): void {
    const text = this.pieces.length > 0 ? this.pieces.join('') + last : last;
    out.push(text.slice(0, this.contentLength));
    this.pieces = [];
    this.piecesLength = 0;
    this.contentLength = -1;
  }
}

// ── Parsing one game ──────────────────────────────────────────────────────

const TAG = /\[([A-Za-z0-9][A-Za-z0-9_+#=:-]*)\s+"((?:[^"\\]|\\.)*)"\s*\]/g;

function unescapeTag(value: string): string {
  return value.includes('\\') ? value.replace(/\\(["\\])/g, '$1') : value;
}

/** Reads the tag-pair section; returns the headers and the offset where the movetext starts. */
function parseHeaders(text: string): { headers: Record<string, string>; end: number } {
  const headers: Record<string, string> = {};
  let i = text.charCodeAt(0) === BOM ? 1 : 0;
  while (i < text.length) {
    let eol = text.indexOf('\n', i);
    if (eol < 0) eol = text.length;
    let first = i;
    while (first < eol && text.charCodeAt(first) <= SPACE) first++;
    if (first < eol) {
      const c = text.charCodeAt(first);
      if (c === LBRACKET) {
        const line = text.slice(first, eol);
        let tagsEnd = 0;
        TAG.lastIndex = 0;
        for (let m = TAG.exec(line); m; m = TAG.exec(line)) {
          headers[m[1]!] = unescapeTag(m[2]!);
          tagsEnd = m.index + m[0].length;
        }
        // Movetext on the same line as the last tags ('[Result "1-0"] 1. e4 …'); a trailing comment
        // ('[Event "x"] ; note') still belongs to the tag section.
        let rest = first + tagsEnd;
        while (rest < eol && text.charCodeAt(rest) <= SPACE) rest++;
        const next = text.charCodeAt(rest);
        if (tagsEnd > 0 && rest < eol && next !== LBRACKET && next !== SEMICOLON && next !== LBRACE) return { headers, end: rest };
      } else if (!(c === PERCENT && first === i)) {
        return { headers, end: i };
      }
    }
    i = eol + 1;
  }
  return { headers, end: text.length };
}

const NULL_MOVES = new Set(['--', 'Z0', '0000', '@@@@']);
const CASTLING = /^[O0o][-–—][O0o]([-–—][O0o])?([+#]?)$/;
const RESULT: unique symbol = Symbol('result');

const FILE_A = code('a');
const FILE_H = code('h');
const RANK_1 = code('1');
const RANK_8 = code('8');
const UPPER_O = code('O');
const LOWER_O = code('o');

/** Has a `[a-h][1-8]` pair, i.e. could be a SAN move (rules out glyphs like `+-`, `=`, `e.p.`). */
function hasSquare(text: string, start: number, end: number): boolean {
  for (let i = start; i + 1 < end; i++) {
    const file = text.charCodeAt(i);
    const rank = text.charCodeAt(i + 1);
    if (file >= FILE_A && file <= FILE_H && rank >= RANK_1 && rank <= RANK_8) return true;
  }
  return false;
}

/** Cheap pre-check: could text[start, end) be a result ('1-0', '½-½', '*') or a null move ('--', 'Z0', '0000', '@@@@')? */
function maybeSpecialToken(text: string, start: number, end: number): boolean {
  const c0 = text.charCodeAt(start);
  const c1 = text.charCodeAt(start + 1);
  return (
    c0 === STAR || c0 === DASH || c0 === UPPER_Z || c0 === AT || (end - start === 4 && c0 === ZERO) ||
    c1 === DASH || c1 === SLASH || c1 === EN_DASH || c1 === EM_DASH
  );
}

/**
 * The mainline token text[start, end) → SAN, `null` if it is not a move (move number, glyph), or
 * RESULT. Works on indices so that move numbers (half of all tokens) are never sliced.
 */
function readToken(text: string, start: number, end: number): string | null | typeof RESULT {
  if (maybeSpecialToken(text, start, end)) {
    const token = text.slice(start, end);
    if (RESULTS.has(token)) return RESULT;
    if (NULL_MOVES.has(token)) return '--';
  }
  let s = start;
  while (s < end && isDigit(text.charCodeAt(s))) s++;
  if (s === end) return null; // bare move number "12"
  if (!isDot(text.charCodeAt(s))) s = start; // "0-0" castling, not a move number
  while (s < end && isDot(text.charCodeAt(s))) s++; // "12." "12..." "12.e4" "..." "12…"
  let e = end;
  while (e > s && (text.charCodeAt(e - 1) === BANG || text.charCodeAt(e - 1) === QUESTION)) e--;
  if (e <= s) return null;
  const first = text.charCodeAt(s);
  if (first === UPPER_O || first === ZERO || first === LOWER_O) {
    const castle = CASTLING.exec(text.slice(s, e));
    if (castle) return (castle[1] ? 'O-O-O' : 'O-O') + castle[2];
  }
  return hasSquare(text, s, e) ? text.slice(s, e) : null;
}

function skipPast(text: string, ch: string, from: number): number {
  const j = text.indexOf(ch, from);
  return j < 0 ? text.length : j + 1;
}

/** Mainline SAN from `start`: skips {comments}, ;comments, %lines, (nested variations) and $NAGs. */
function scanMovetext(text: string, start: number, maxPlies: number): { sans: string[]; plyCount: number } {
  const sans: string[] = [];
  let plyCount = 0;
  let depth = 0;
  const n = text.length;
  let i = start;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= SPACE || c === RBRACE) i++;
    else if (c === LBRACE) i = skipPast(text, '}', i + 1);
    else if (c === SEMICOLON || (c === PERCENT && (i === 0 || text.charCodeAt(i - 1) === LF))) i = skipPast(text, '\n', i + 1);
    else if (c === LPAREN) {
      depth++;
      i++;
    } else if (c === RPAREN) {
      if (depth > 0) depth--;
      i++;
    } else if (c === DOLLAR) {
      i++;
      while (i < n && isDigit(text.charCodeAt(i))) i++;
    } else {
      let j = i + 1;
      while (j < n && !isDelimiter(text.charCodeAt(j))) j++;
      if (depth === 0) {
        const san = readToken(text, i, j);
        if (san === RESULT) break;
        if (san !== null) {
          if (sans.length < maxPlies) sans.push(san);
          plyCount++;
        }
      }
      i = j;
    }
  }
  return { sans, plyCount };
}

/** Parses one game's text (as produced by PgnStreamSplitter). */
export function parsePgnGame(text: string, maxPlies: number = MAX_STORED_PLIES): PgnGame {
  const { headers, end } = parseHeaders(text);
  return { headers, ...scanMovetext(text, end, maxPlies) };
}

/** Splits a (multi-game) PGN text into whole-game texts. */
export function splitPgnGames(text: string): string[] {
  const splitter = new PgnStreamSplitter();
  const games = splitter.push(text);
  games.push(...splitter.flush());
  return games;
}

/** Every game in `text` (tolerant: comments, variations, NAGs, BOM, CRLF, '0-0'). Skips empty chunks. */
export function* parsePgnText(text: string, maxPlies: number): Generator<PgnGame> {
  for (const game of splitPgnGames(text)) {
    const parsed = parsePgnGame(game, maxPlies);
    if (parsed.plyCount > 0 || Object.keys(parsed.headers).length > 0) yield parsed;
  }
}

// ── Player names ──────────────────────────────────────────────────────────

const NAME_TAG = /^[ \t]*\[(White|Black)[ \t]+"((?:[^"\\\r\n]|\\.)*)"/gm;

/**
 * Counts White/Black names across games (case-insensitively; a name is displayed as first seen).
 * Feed whole header lines, e.g. game texts from PgnStreamSplitter or a whole file.
 */
export class PgnNameCounter {
  private readonly counts = new Map<string, { name: string; games: number }>();
  private lastWhite = '';

  add(text: string): void {
    NAME_TAG.lastIndex = 0;
    for (let m = NAME_TAG.exec(text); m; m = NAME_TAG.exec(text)) {
      const name = unescapeTag(m[2]!).trim();
      const key = name.toLowerCase();
      const isWhite = m[1] === 'White';
      // Self-play (same name on both sides) counts as one game.
      const sameGame = !isWhite && key === this.lastWhite;
      this.lastWhite = isWhite ? key : '';
      if (key === '' || key === '?' || sameGame) continue;
      const entry = this.counts.get(key);
      if (entry) entry.games++;
      else this.counts.set(key, { name, games: 1 });
    }
  }

  top(limit = 10): { name: string; games: number }[] {
    return [...this.counts.values()]
      .sort((a, b) => b.games - a.games || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, limit)
      .map(e => ({ ...e }));
  }
}

/** Most frequent White/Black names (header-only scan), for "Which of these is you?". */
export function scanPgnNames(text: string, limit = 10): { name: string; games: number }[] {
  const counter = new PgnNameCounter();
  counter.add(text);
  return counter.top(limit);
}

// ── Header interpretation ─────────────────────────────────────────────────

function speedFromSeconds(base: number, increment: number): Speed {
  const estimate = base + 40 * increment;
  if (estimate < 30) return 'ultraBullet';
  if (estimate < 180) return 'bullet';
  if (estimate < 480) return 'blitz';
  if (estimate < 1500) return 'rapid';
  return 'classical';
}

/** Lichess speed rules: estimate = base + 40 × increment (seconds). '1/n' and '-' mean daily/correspondence. */
export function speedFromTimeControl(tc: string | undefined): Speed {
  const value = tc?.trim();
  if (!value || value === '?') return 'unknown';
  if (value === '-') return 'correspondence';
  const period = value.split(':')[0]!; // multi-period controls: the first period decides
  // 'moves/seconds', optionally with an increment as FIDE events write it ('40/5400+30:1800+30').
  const perMoves = /^(\d+)\/(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(period);
  if (perMoves) return perMoves[1] === '1' ? 'correspondence' : speedFromSeconds(Number(perMoves[2]), Number(perMoves[3] ?? 0));
  const m = /^\*?(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?$/.exec(period);
  return m ? speedFromSeconds(Number(m[1]), Number(m[2] ?? 0)) : 'unknown';
}

const SPEED_WORDS: [RegExp, Speed][] = [
  [/\bultra ?bullet\b/i, 'ultraBullet'],
  [/\bbullet\b/i, 'bullet'],
  [/\bblitz\b/i, 'blitz'],
  [/\brapid\b/i, 'rapid'],
  [/\bclassical\b/i, 'classical'],
  [/\b(correspondence|daily)\b/i, 'correspondence'],
];

function speedOf(h: Record<string, string>): Speed {
  const speed = speedFromTimeControl(h.TimeControl);
  if (speed !== 'unknown') return speed;
  const event = h.Event ?? '';
  return SPEED_WORDS.find(([re]) => re.test(event))?.[1] ?? 'unknown';
}

export function resultFromHeader(r: string | undefined): GameResult {
  const value = r?.trim().replace(/[–—]/g, '-');
  if (value === '1-0' || value === '0-1') return value;
  if (value === '1/2-1/2' || value === '½-½' || value === '1/2' || value === '0.5-0.5') return '1/2-1/2';
  return '*';
}

function parseDate(date: string | undefined): number | undefined {
  const m = date && /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(date.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? ms : undefined;
}

function parseTime(time: string | undefined): number {
  const m = time && /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time.trim());
  if (!m) return 0;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  return h < 24 && min < 60 && s < 60 ? ((h * 60 + min) * 60 + s) * 1000 : 0;
}

/** Start time in ms: UTCDate + UTCTime, else Date (+ UTCTime/Time); 0 if unknown or partial ('????.??.??'). */
export function pgnDate(headers: Record<string, string>): number {
  const utc = parseDate(headers.UTCDate);
  if (utc !== undefined) return utc + parseTime(headers.UTCTime);
  const local = parseDate(headers.Date);
  if (local !== undefined) return local + parseTime(headers.UTCTime ?? headers.Time);
  return 0;
}

const STANDARD_VARIANTS = new Set(['', 'standard', 'chess', 'normal', 'from position']);

/** Standard chess from the standard start (a [FEN] equal to the start position is fine). */
function isStandardGame(h: Record<string, string>): boolean {
  if (!STANDARD_VARIANTS.has((h.Variant ?? '').trim().toLowerCase())) return false;
  const fen = h.FEN?.trim();
  return !fen || isStandardStartFen(fen);
}

const LICHESS_GAME = /lichess\.org\/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?![A-Za-z0-9])/;
/** Lichess routes that look like 8-character game ids. */
const LICHESS_ROUTES = new Set(['analysis', 'training', 'practice', 'streamer', 'insights', 'features', 'download', 'explorer', 'timeline']);
// Current links (/game/live/123) and the older /live/game/123 form name the same game.
const CHESSCOM_GAME = /chess\.com\/(?:analysis\/)?(?:game\/(live|daily)|(live|daily)\/game)\/(\d+)/i;

interface Source { platform: Platform; sourceId: string; url?: string }

function onlineSource(value: string): Source | undefined {
  const li = LICHESS_GAME.exec(value);
  if (li && !LICHESS_ROUTES.has(li[1]!)) {
    return { platform: 'lichess', sourceId: li[1]!, url: `https://lichess.org/${li[1]}` };
  }
  const cc = CHESSCOM_GAME.exec(value);
  if (cc) {
    const kind = (cc[1] ?? cc[2])!.toLowerCase();
    return { platform: 'chesscom', sourceId: `${kind}/${cc[3]}`, url: `https://www.chess.com/game/${kind}/${cc[3]}` };
  }
  return undefined;
}

function sourceOf(h: Record<string, string>, sans: readonly string[]): Source {
  for (const value of [h.Link, h.Site]) {
    const source = value ? onlineSource(value) : undefined;
    if (source) return source;
  }
  const id = fnv1a64([h.White ?? '', h.Black ?? '', h.Date ?? '', h.UTCTime ?? '', sans.slice(0, MAX_STORED_PLIES).join(' ')].join('|'));
  const link = [h.Link, h.Site].find(v => v !== undefined && /^https?:\/\//i.test(v.trim()));
  return link ? { platform: 'pgn', sourceId: id, url: link.trim() } : { platform: 'pgn', sourceId: id };
}

function rating(value: string | undefined): number | undefined {
  const v = value?.trim();
  return v && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined;
}

function isRated(h: Record<string, string>, hasRatings: boolean): boolean {
  const event = h.Event ?? '';
  if (/\b(casual|unrated)\b/i.test(event)) return false;
  if (/\brated\b/i.test(event)) return true;
  return hasRatings;
}

/**
 * A parsed PGN game → RawGame, or null for variants, non-standard starts and games without a legal
 * first move. Moves are stored as standard UCI (first MAX_STORED_PLIES plies, up to the first illegal one).
 */
export function pgnGameToRaw(g: PgnGame): RawGame | null {
  const h = g.headers;
  if (!isStandardGame(h)) return null;
  const moves = sansToUci(g.sans, MAX_STORED_PLIES);
  if (moves.length === 0) return null;
  const { platform, sourceId, url } = sourceOf(h, g.sans);
  const whiteRating = rating(h.WhiteElo);
  const blackRating = rating(h.BlackElo);
  const raw: RawGame = {
    platform,
    sourceId,
    playedAt: pgnDate(h),
    white: h.White?.trim() || '?',
    black: h.Black?.trim() || '?',
    speed: speedOf(h),
    rated: isRated(h, whiteRating !== undefined || blackRating !== undefined),
    result: resultFromHeader(h.Result),
    moves,
    plyCount: Math.max(g.plyCount, moves.length),
  };
  if (url !== undefined) raw.url = url;
  if (whiteRating !== undefined) raw.whiteRating = whiteRating;
  if (blackRating !== undefined) raw.blackRating = blackRating;
  return raw;
}
