#!/usr/bin/env node
// Deterministic synthetic games for the e2e tests and the demo dataset: a fictional player with a
// fixed repertoire and planted habitual mistakes. Node port of the engine benchmark's gen_games.py
// (python-chess), using chessops and the vendored lichess-org/chess-openings TSVs (data/openings), so
// contributors need nothing beyond `npm install`. Same model, different PRNG: the output is
// byte-identical for a given seed, but not identical to the Python generator's output.
//
// Model
// * Opening book = every line of the TSVs, merged into a position-keyed trie (EPD keys, so
//   transpositions merge). Child weight = (#lines)^0.8.
// * The hero has 4 favourite lines per colour. In a "repertoire" game (70 %) the hero plays its
//   repertoire move on those lines and the opponent follows a favourite line with p = 0.75 per move.
// * Planted deviations: up to 5 hero-to-move positions per colour on the favourite lines get a fixed
//   deviation the hero plays with a fixed probability. Every other one hangs material (the moved piece
//   lands on a square attacked by a cheaper piece, or attacked and undefended); the rest are
//   arbitrary off-book moves.
// * Outside the repertoire the hero has habits: the first move it picks in a position is repeated
//   with p = 0.8. In "experiment" games (30 %) the hero just plays weighted book moves.
// * After the book runs out both sides play random legal moves (captures preferred 35 % of the time)
//   up to 34..46 plies.
//
// Usage: node scripts/gen-fixtures.mjs [--out e2e/fixtures] [--seed 20261008]
// Writes lichess-games.ndjson (+ lichess-user.json), chesscom/ (player, archives, monthly archives),
// upload.pgn and manifest.json (the planted deviations and how often each was reached and played).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Chess, castlingSide } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import { kingCastlesTo, makeSquare, makeUci, opposite } from 'chessops/util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HERO_STRENGTH = 1500;
const HOUR = 3_600_000;
/** The newest game of every set ends here (keeps outputs independent of the current date). */
export const END_TIME = Date.UTC(2026, 8, 30, 20, 0, 0);
const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const DEFAULT_SEED = 20261008;

/** (eco, exact pgn as in the TSV, weight) */
const FAVOURITES = {
  white: [
    ['C54', '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. Nbd2 O-O 7. O-O', 0.35],
    ['B22', '1. e4 c5 2. c3 d5 3. exd5 Qxd5 4. d4 Nc6 5. Nf3', 0.3],
    ['C02', '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3', 0.2],
    ['B12', '1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3', 0.15],
  ],
  black: [
    ['B90', '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6 8. f3', 0.4],
    ['E94', '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O', 0.25],
    ['A48', '1. d4 Nf6 2. Nf3 g6 3. Bf4 Bg7 4. e3 d6 5. Be2 O-O', 0.2],
    ['A15', '1. c4 Nf6 2. Nf3 g6', 0.15],
  ],
};

/** [speed, weight, time controls ("initial+increment", seconds)] */
const SPEEDS = [
  ['blitz', 0.6, ['180+0', '180+2', '300+0', '300+3']],
  ['rapid', 0.25, ['600+0', '600+5', '900+10']],
  ['bullet', 0.15, ['60+0', '120+1']],
];
const SPEED_WEIGHTS = SPEEDS.map(s => s[1]);
const PIECE_VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 };

// ── Seeded PRNG (sfc32 seeded through splitmix32) ─────────────────────────

export function makeRng(seed) {
  let s = seed >>> 0;
  const splitmix = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();
  const random = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  return {
    random,
    randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
    uniform: (lo, hi) => lo + (hi - lo) * random(),
    choice: items => items[Math.floor(random() * items.length)],
    shuffle(items) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
    gauss(mu, sigma) {
      const u = 1 - random();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    },
  };
}

function weightedChoice(rng, items, weights) {
  const total = weights.reduce((x, y) => x + y, 0);
  const r = rng.random() * total;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += weights[i];
    if (r < acc) return items[i];
  }
  return items[items.length - 1];
}

// ── Chess helpers (standard UCI, like src/core/chess.ts) ──────────────────

/** Position key: board, turn, castling and an en-passant square only when a legal capture exists. */
export const epdOf = pos => makeFen(pos.toSetup(), { epd: true });

function standardUci(pos, move) {
  const side = castlingSide(pos, move);
  return side ? makeSquare(move.from) + makeSquare(kingCastlesTo(pos.turn, side)) : makeUci(move);
}

/** Legal moves in a fixed order (squares ascending, promotions q r b n), with standard UCI. */
function legalMoves(pos) {
  const out = [];
  for (const from of pos.board[pos.turn]) {
    const piece = pos.board.get(from);
    for (const to of pos.dests(from)) {
      const lastRank = piece.role === 'pawn' && (to >> 3 === 7 || to >> 3 === 0);
      for (const promotion of lastRank ? ['queen', 'rook', 'bishop', 'knight'] : [undefined]) {
        const move = promotion ? { from, to, promotion } : { from, to };
        out.push({ move, uci: standardUci(pos, move) });
      }
    }
  }
  return out;
}

function isCapture(pos, move) {
  const target = pos.board.get(move.to);
  if (target) return target.color !== pos.turn;
  const piece = pos.board.get(move.from);
  return piece.role === 'pawn' && (move.to & 7) !== (move.from & 7); // en passant
}

/** The piece moved can be taken at once for profit (cheaper attacker, or attacked and undefended). */
function hangsMaterial(pos, move) {
  const piece = pos.board.get(move.from);
  if (!piece || piece.role === 'king' || castlingSide(pos, move)) return false;
  const after = pos.clone();
  after.play(move);
  const enemy = after.turn;
  const attackers = after.kingAttackers(move.to, enemy, after.board.occupied);
  if (attackers.isEmpty()) return false;
  const defenders = after.kingAttackers(move.to, opposite(enemy), after.board.occupied);
  let cheapest = Infinity;
  for (const sq of attackers) cheapest = Math.min(cheapest, PIECE_VALUE[after.board.get(sq).role]);
  return cheapest < PIECE_VALUE[piece.role] || defenders.isEmpty();
}

// ── Opening book ──────────────────────────────────────────────────────────

/** Lines and a position-keyed trie (epd → Map(uci → number of lines)) from data/openings/*.tsv. */
export function loadBook(dataDir = join(ROOT, 'data', 'openings')) {
  const lines = [];
  const trie = new Map();
  const files = readdirSync(dataDir)
    .filter(f => f.endsWith('.tsv'))
    .sort();
  for (const file of files) {
    const rows = readFileSync(join(dataDir, file), 'utf8').split('\n');
    const header = rows[0].split('\t');
    if (header[0] !== 'eco' || header[1] !== 'name' || header[2] !== 'pgn') throw new Error(`${file}: unexpected header ${header}`);
    for (const row of rows.slice(1)) {
      const [eco, name, pgn] = row.split('\t');
      if (!eco || !name || !pgn) continue;
      const pos = Chess.default();
      const ucis = [];
      let ok = true;
      for (const token of pgn.trim().split(/\s+/)) {
        if (/^\d+\.+$/.test(token)) continue;
        const move = parseSan(pos, token.replace(/^\d+\.+/, ''));
        if (!move) {
          ok = false;
          break;
        }
        const key = epdOf(pos);
        const uci = standardUci(pos, move);
        const children = trie.get(key) ?? new Map();
        children.set(uci, (children.get(uci) ?? 0) + 1);
        trie.set(key, children);
        ucis.push(uci);
        pos.play(move);
      }
      if (ok) lines.push({ eco, name, pgn, ucis });
    }
  }
  return { lines, trie };
}

function bookMove(rng, trie, pos, legal) {
  const children = trie.get(epdOf(pos));
  if (!children) return undefined;
  const moves = [...children.keys()];
  const weights = moves.map(m => children.get(m) ** 0.8);
  const uci = weightedChoice(rng, moves, weights);
  return legal.find(l => l.uci === uci);
}

function randomMove(rng, pos, legal) {
  if (legal.length === 0) return undefined;
  const captures = legal.filter(l => isCapture(pos, l.move));
  if (captures.length > 0 && rng.random() < 0.35) return rng.choice(captures);
  return rng.choice(legal);
}

// ── Repertoire and planted deviations ─────────────────────────────────────

/** Per colour: favourite lines, the hero's move per position, the opponent's choices, the deviations. */
export function buildRepertoire(book, seed) {
  const rng = makeRng(seed);
  const byKey = new Map(book.lines.map(l => [`${l.eco}|${l.pgn}`, l]));
  const rep = {};
  for (const color of ['white', 'black']) {
    const lines = [];
    const prefs = new Map();
    const opp = new Map();
    const heroPositions = [];
    FAVOURITES[color].forEach(([eco, pgn, weight], idx) => {
      const line = byKey.get(`${eco}|${pgn}`);
      if (!line) throw new Error(`favourite line not found in the TSVs: ${eco} ${pgn}`);
      lines.push({ eco, name: line.name, pgn, uci: line.ucis, weight });
      const pos = Chess.default();
      line.ucis.forEach((uci, ply) => {
        const key = epdOf(pos);
        if (pos.turn === color) {
          if (prefs.has(key) && prefs.get(key) !== uci) throw new Error(`inconsistent repertoire at ${key}`);
          if (!prefs.has(key)) heroPositions.push({ key, fen: makeFen(pos.toSetup()), ply, idx, uci });
          prefs.set(key, uci);
        } else {
          const choices = opp.get(key) ?? new Map();
          choices.set(uci, (choices.get(uci) ?? 0) + weight);
          opp.set(key, choices);
        }
        pos.play(legalMoves(pos).find(l => l.uci === uci).move);
      });
    });
    const eligible = rng.shuffle(heroPositions.filter(p => p.ply >= 2 && p.ply <= 13));
    const deviations = new Map();
    const perLine = new Map();
    for (const p of eligible) {
      if (deviations.size >= 5) break;
      if ((perLine.get(p.idx) ?? 0) >= 2) continue;
      const pos = Chess.fromSetup(parseFen(p.fen).unwrap()).unwrap();
      const children = book.trie.get(p.key) ?? new Map();
      const legal = legalMoves(pos).filter(l => l.uci !== p.uci);
      const kind = deviations.size % 2 === 0 ? 'hangs_material' : 'offbook';
      const pool =
        kind === 'hangs_material' ? legal.filter(l => hangsMaterial(pos, l.move)) : legal.filter(l => !children.has(l.uci) && !hangsMaterial(pos, l.move));
      if (pool.length === 0) continue;
      const pick = rng.choice(pool);
      perLine.set(p.idx, (perLine.get(p.idx) ?? 0) + 1);
      const role = pos.board.get(pick.move.from).role;
      deviations.set(p.key, {
        color,
        line: lines[p.idx].name,
        line_eco: lines[p.idx].eco,
        ply: p.ply,
        fen: p.fen,
        epd: p.key,
        repertoire_move: p.uci,
        move_uci: pick.uci,
        move_san: makeSan(pos, pick.move),
        kind,
        ...(kind === 'hangs_material' ? { hangs: role, hangs_value: PIECE_VALUE[role] } : {}),
        probability: Math.round(rng.uniform(0.35, 0.65) * 100) / 100,
      });
    }
    rep[color] = { lines, prefs, opp, deviations };
  }
  return rep;
}

// ── Games ─────────────────────────────────────────────────────────────────

function playGame(rng, book, rep, heroColor, habits, targetPlies) {
  const pos = Chess.default();
  const r = rep[heroColor];
  const mode = rng.random() < 0.7 ? 'rep' : 'exp';
  let inBook = true;
  const moves = [];
  const planted = [];
  while (moves.length < targetPlies && !pos.isEnd()) {
    const key = epdOf(pos);
    const legal = legalMoves(pos);
    const byUci = uci => legal.find(l => l.uci === uci);
    let pick;
    if (pos.turn === heroColor) {
      if (mode === 'rep' && r.prefs.has(key)) {
        const dev = r.deviations.get(key);
        if (dev && rng.random() < dev.probability) pick = byUci(dev.move_uci);
        else pick = rng.random() < 0.92 ? byUci(r.prefs.get(key)) : bookMove(rng, book.trie, pos, legal);
      } else if (mode === 'rep' && moves.length < 24) {
        const habit = habits.get(key);
        if (habit !== undefined && rng.random() < 0.8) pick = byUci(habit);
        else {
          pick = inBook ? bookMove(rng, book.trie, pos, legal) : undefined;
          pick ??= randomMove(rng, pos, legal);
          if (habit === undefined && pick) habits.set(key, pick.uci);
        }
      } else {
        pick = inBook ? bookMove(rng, book.trie, pos, legal) : undefined;
      }
    } else if (mode === 'rep' && r.opp.has(key) && rng.random() < 0.75) {
      const choices = r.opp.get(key);
      const ucis = [...choices.keys()];
      const weights = ucis.map(u => choices.get(u));
      pick = byUci(weightedChoice(rng, ucis, weights));
    } else if (inBook) {
      pick = bookMove(rng, book.trie, pos, legal);
    }
    if (!pick) {
      inBook = false;
      pick = randomMove(rng, pos, legal);
      if (!pick) break;
    } else if (inBook && !(book.trie.get(key)?.has(pick.uci) ?? false)) {
      inBook = false;
    }
    // Ground truth for the manifest, counted like the app: per game, the first visit (in any mode).
    const dev = pos.turn === heroColor ? r.deviations.get(key) : undefined;
    if (dev && !planted.some(p => p.epd === key)) planted.push({ epd: key, played: pick.uci === dev.move_uci });
    moves.push({ uci: pick.uci, san: makeSan(pos, pick.move) });
    pos.play(pick.move);
  }
  return { pos, moves, mode, planted };
}

function makeUsername(rng, taken, hero) {
  const a = 'Knight Rook Pawn Bishop Gambit Castle Fork Pin Zugzwang Endgame Blitz Tempo Fianchetto Sac Mate Queen Check Tactic Opening Patzer'.split(' ');
  const b = 'Rider Storm Master Hunter Lover King Wizard Ninja Fan Crusher Dragon Fox Wolf Bear Eagle Shark Tiger Owl Hawk Lion'.split(' ');
  for (;;) {
    const style = rng.random();
    let name;
    if (style < 0.45) name = `${rng.choice(a)}${rng.choice(b)}${rng.randint(1, 999)}`;
    else if (style < 0.75) name = `${rng.choice(a).toLowerCase()}_${rng.choice(b).toLowerCase()}${rng.randint(10, 99)}`;
    else name = Array.from({ length: rng.randint(4, 8) }, () => rng.choice('abcdefghijklmnopqrstuvwxyz')).join('') + rng.randint(1, 9999);
    name = name.slice(0, 20);
    if (!taken.has(name.toLowerCase()) && name.toLowerCase() !== hero.toLowerCase()) {
      taken.add(name.toLowerCase());
      return name;
    }
  }
}

function uniqueId(rng, taken, make) {
  for (;;) {
    const id = make();
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * `count` games of `hero`, newest first. Timestamps are anchored so the newest game ends at `endTime`.
 * Each game lists the planted deviations the hero reached and whether it played them (`planted`).
 */
export function generateGames({ book, rep, seed, count, hero, endTime = END_TIME, gapHours = [3, 30] }) {
  const rng = makeRng(seed);
  const taken = new Set();
  const opponents = Array.from({ length: 600 }, () => {
    const name = makeUsername(rng, taken, hero);
    return { name, id: name.toLowerCase(), base: Math.round(rng.gauss(0, 110)) };
  });
  const oppWeights = opponents.map((_, i) => 1 / (i + 1) ** 0.9); // Zipf-ish: some opponents recur
  const ids = new Set();
  const habits = { white: new Map(), black: new Map() };
  let t = 0;
  let heroRating = 1500;
  let sessionLeft = 0;
  const games = [];
  for (let i = 0; i < count; i++) {
    if (sessionLeft <= 0) {
      t += Math.round(rng.uniform(gapHours[0], gapHours[1]) * HOUR);
      sessionLeft = rng.randint(2, 8);
    }
    sessionLeft--;
    const [speed, , tcs] = weightedChoice(rng, SPEEDS, SPEED_WEIGHTS);
    const [initial, inc] = rng.choice(tcs).split('+').map(Number);
    const heroColor = rng.random() < 0.5 ? 'white' : 'black';
    const opp = weightedChoice(rng, opponents, oppWeights);
    const target = rng.randint(34, 46);
    const heroR = Math.round(heroRating);
    const oppRating = Math.round(Math.min(2900, Math.max(600, HERO_STRENGTH + opp.base + rng.gauss(0, 40))));
    const { pos, moves, mode, planted } = playGame(rng, book, rep, heroColor, habits[heroColor], target);

    let winner = null;
    let status;
    if (pos.isCheckmate()) {
      winner = opposite(pos.turn);
      status = 'mate';
    } else if (pos.isEnd()) {
      status = pos.isStalemate() ? 'stalemate' : 'draw';
    } else {
      // Results follow the Elo expectation of the hero's true strength against the opponent.
      const pWin = 1 / (1 + 10 ** ((oppRating - HERO_STRENGTH) / 400));
      if (rng.random() < 0.08) status = 'draw';
      else {
        winner = rng.random() < pWin ? heroColor : opposite(heroColor);
        status = rng.random() < 0.25 ? 'outoftime' : 'resign';
      }
    }
    const score = winner === heroColor ? 1 : winner ? 0 : 0.5;
    const expected = 1 / (1 + 10 ** ((oppRating - heroR) / 400));
    const diff = Math.round(20 * (score - expected));
    heroRating += diff;

    const durationS = Math.floor(Math.min(initial * 2 + inc * moves.length, Math.max(30, moves.length * rng.uniform(2, 0.5 + initial / 15))));
    const created = t;
    const last = t + durationS * 1000;
    t = last + rng.randint(20, 600) * 1000;
    const heroSide = { name: hero, id: hero.toLowerCase(), rating: heroR, diff };
    const oppSide = { name: opp.name, id: opp.id, rating: oppRating, diff: -diff };
    games.push({
      id: uniqueId(rng, ids, () => Array.from({ length: 8 }, () => rng.choice(ID_ALPHABET)).join('')),
      numericId: uniqueId(rng, ids, () => String(rng.randint(100_000_000, 999_999_999)) + String(rng.randint(10, 99))),
      rated: rng.random() < 0.9,
      speed,
      initial,
      inc,
      created,
      last,
      status,
      winner,
      result: winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '1/2-1/2',
      white: heroColor === 'white' ? heroSide : oppSide,
      black: heroColor === 'white' ? oppSide : heroSide,
      sans: moves.map(m => m.san),
      finalFen: makeFen(pos.toSetup()),
      heroColor,
      mode,
      planted,
    });
  }
  const shift = Math.round((endTime - games[games.length - 1].last) / 1000) * 1000;
  for (const g of games) {
    g.created += shift;
    g.last += shift;
  }
  return games.reverse();
}

// ── Output formats ────────────────────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');
const pgnDate = ms => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
};
const pgnTime = ms => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

function movetext(sans, result) {
  const parts = sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san));
  parts.push(result);
  return parts.join(' ');
}

/** One line of GET /api/games/user/{u} (application/x-ndjson). */
export function lichessJson(g) {
  const side = s => ({ user: { name: g[s].name, id: g[s].id }, rating: g[s].rating, ...(g.rated ? { ratingDiff: g[s].diff } : {}) });
  return {
    id: g.id,
    rated: g.rated,
    variant: 'standard',
    speed: g.speed,
    perf: g.speed,
    createdAt: g.created,
    lastMoveAt: g.last,
    status: g.status,
    source: 'pool',
    players: { white: side('white'), black: side('black') },
    ...(g.winner ? { winner: g.winner } : {}),
    moves: g.sans.join(' '),
    clock: { initial: g.initial, increment: g.inc, totalTime: g.initial + 40 * g.inc },
  };
}

/**
 * An over-the-board style PGN game (no site link, so the app stores it as a 'pgn' game). With `utc`
 * the start time is written too (UTCDate/UTCTime), else only the Date.
 */
export function pgnGame(g, { event = 'Club Rapid', utc = false } = {}) {
  const headers = [
    ['Event', event],
    ['Site', 'Riverside Chess Club'],
    ['Date', pgnDate(g.created)],
    ...(utc
      ? [
          ['UTCDate', pgnDate(g.created)],
          ['UTCTime', pgnTime(g.created)],
        ]
      : []),
    ['Round', '-'],
    ['White', g.white.name],
    ['Black', g.black.name],
    ['Result', g.result],
    ['WhiteElo', String(g.white.rating)],
    ['BlackElo', String(g.black.rating)],
    ['TimeControl', `${g.initial}+${g.inc}`],
  ];
  return `${headers.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${movetext(g.sans, g.result)}\n`;
}

const CHESSCOM_LOSS = { resign: 'resigned', outoftime: 'timeout', mate: 'checkmated' };
const CHESSCOM_DRAW = { draw: 'agreed', stalemate: 'stalemate' };

/** One game of a Chess.com monthly archive (GET /pub/player/{u}/games/{yyyy}/{mm}). */
export function chesscomJson(g) {
  const url = `https://www.chess.com/game/live/${g.numericId}`;
  const resultFor = color => (g.winner === color ? 'win' : g.winner ? CHESSCOM_LOSS[g.status] : (CHESSCOM_DRAW[g.status] ?? 'agreed'));
  const tc = g.inc > 0 ? `${g.initial}+${g.inc}` : String(g.initial);
  const termination = g.winner
    ? `${g[g.winner].name} won by ${g.status === 'mate' ? 'checkmate' : g.status === 'outoftime' ? 'time' : 'resignation'}`
    : 'Game drawn by agreement';
  const headers = [
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['Date', pgnDate(g.created)],
    ['Round', '-'],
    ['White', g.white.name],
    ['Black', g.black.name],
    ['Result', g.result],
    ['CurrentPosition', g.finalFen],
    ['Timezone', 'UTC'],
    ['UTCDate', pgnDate(g.created)],
    ['UTCTime', pgnTime(g.created)],
    ['WhiteElo', String(g.white.rating)],
    ['BlackElo', String(g.black.rating)],
    ['TimeControl', tc],
    ['Termination', termination],
    ['StartTime', pgnTime(g.created)],
    ['EndDate', pgnDate(g.last)],
    ['EndTime', pgnTime(g.last)],
    ['Link', url],
  ];
  const player = color => ({
    rating: g[color].rating,
    result: resultFor(color),
    '@id': `https://api.chess.com/pub/player/${g[color].id}`,
    username: g[color].name,
    uuid: `u-${g[color].id}`,
  });
  return {
    url,
    pgn: `${headers.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${movetext(g.sans, g.result)}\n`,
    time_control: tc,
    end_time: Math.floor(g.last / 1000),
    rated: g.rated,
    uuid: `g-${g.numericId}`,
    initial_setup: STANDARD_START,
    fen: g.finalFen,
    time_class: g.speed,
    rules: 'chess',
    white: player('white'),
    black: player('black'),
  };
}

// ── Manifest ──────────────────────────────────────────────────────────────

const sha256 = text => createHash('sha256').update(text).digest('hex');

/** How often each planted deviation was reached / played in `games` (and in the newest `window`). */
export function plantedStats(rep, games, window) {
  const out = [];
  for (const color of ['white', 'black']) {
    for (const dev of rep[color].deviations.values()) {
      const count = list => {
        let reached = 0;
        let played = 0;
        for (const g of list) {
          for (const p of g.planted) {
            if (p.epd !== dev.epd) continue;
            reached++;
            if (p.played) played++;
          }
        }
        return { reached, played };
      };
      const all = count(games);
      out.push({
        ...dev,
        times_reached: all.reached,
        times_played: all.played,
        ...(window ? { newest: { games: window, ...count(games.slice(0, window)) } } : {}),
      });
    }
  }
  return out;
}

function summary(games) {
  const by = key => Object.fromEntries([...new Set(games.map(key))].sort().map(k => [k, games.filter(g => key(g) === k).length]));
  return {
    count: games.length,
    first_created_at: games[games.length - 1].created,
    last_created_at: games[0].created,
    colors: by(g => g.heroColor),
    speeds: by(g => g.speed),
    modes: by(g => g.mode),
  };
}

const monthKey = ms => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}`;
};

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * Games the app must skip — Chess960, bughouse and a knight-odds start — taken from the hand-made
 * source fixtures (src/sources/__fixtures__) and rewritten for the hero.
 */
function chesscomVariants(hero, month) {
  const pick = ['chesscom-2024-04.json', 'chesscom-2024-05.json']
    .flatMap(name => JSON.parse(readFileSync(join(ROOT, 'src', 'sources', '__fixtures__', name), 'utf8')).games)
    .filter(g => g.rules !== 'chess' || g.initial_setup !== STANDARD_START);
  return pick.map((g, i) => {
    const json = JSON.stringify(g).replaceAll('SMA-Nahian', hero).replaceAll('sma-nahian', hero.toLowerCase());
    return { ...JSON.parse(json), end_time: Math.floor(Date.parse(`${month.replace('/', '-')}-15T12:00:00Z`) / 1000) + i * 600 };
  });
}

/** Writes every fixture file into `out`; returns the manifest. */
export function writeFixtures({ out, seed = DEFAULT_SEED }) {
  const book = loadBook();
  const rep = buildRepertoire(book, seed + 1);
  const files = {};
  const write = (name, text) => {
    const path = join(out, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    files[name] = sha256(text);
  };

  // Lichess: 400 games of TestHero, newest first (like the export with sort=dateDesc).
  const hero = 'TestHero';
  const lichess = generateGames({ book, rep, seed, count: 400, hero });
  write('lichess-games.ndjson', lichess.map(g => `${JSON.stringify(lichessJson(g))}\n`).join(''));
  const user = { id: hero.toLowerCase(), username: hero, count: { all: lichess.length, rated: lichess.filter(g => g.rated).length } };
  write('lichess-user.json', `${JSON.stringify(user, null, 2)}\n`);

  // Chess.com: 150 games of the same player over three months, plus variant games to skip.
  const cc = generateGames({ book, rep, seed: seed + 2, count: 150, hero, gapHours: [36, 96] });
  const months = new Map();
  for (const g of [...cc].reverse()) {
    const key = monthKey(g.last);
    months.set(key, [...(months.get(key) ?? []), chesscomJson(g)]);
  }
  const monthKeys = [...months.keys()];
  const variantMonth = monthKeys[monthKeys.length - 2] ?? monthKeys[0];
  const variants = chesscomVariants(hero, variantMonth);
  months.set(variantMonth, [...months.get(variantMonth), ...variants]);
  const ccUser = hero.toLowerCase();
  const archiveUrl = key => `https://api.chess.com/pub/player/${ccUser}/games/${key}`;
  const player = {
    '@id': `https://api.chess.com/pub/player/${ccUser}`,
    url: `https://www.chess.com/member/${hero}`,
    username: ccUser,
    player_id: 424242,
    status: 'basic',
    joined: 1591012800,
    last_online: Math.floor(END_TIME / 1000),
  };
  write('chesscom/player.json', `${JSON.stringify(player, null, 2)}\n`);
  write('chesscom/archives.json', `${JSON.stringify({ archives: monthKeys.map(archiveUrl) }, null, 2)}\n`);
  for (const [key, games] of months) write(`chesscom/${key.replace('/', '-')}.json`, `${JSON.stringify({ games })}\n`);

  // PGN upload: 120 over-the-board games as "Hero, Test", plus a Chess960 game the app must skip.
  const otb = generateGames({ book, rep, seed: seed + 3, count: 120, hero: 'Hero, Test', gapHours: [48, 120] });
  const chess960 = `[Event "Club 960"]\n[Site "Riverside Chess Club"]\n[Date "2026.09.01"]\n[White "Hero, Test"]\n[Black "Random, Fischer"]\n[Result "1-0"]\n[Variant "Chess960"]\n[SetUp "1"]\n[FEN "nrbkqbrn/pppppppp/8/8/8/8/PPPPPPPP/NRBKQBRN w KQkq - 0 1"]\n\n1. e4 e5 2. Nb3 Nb6 1-0\n`;
  write('upload.pgn', `${otb.map(g => pgnGame(g)).join('\n')}\n${chess960}`);

  const manifest = {
    generator: 'scripts/gen-fixtures.mjs',
    seed,
    repertoire_seed: seed + 1,
    note: 'Planted deviations are shared by all sets (same repertoire). Counts are distinct games.',
    repertoire: { white: rep.white.lines, black: rep.black.lines },
    lichess: { file: 'lichess-games.ndjson', hero, ...summary(lichess), planted: plantedStats(rep, lichess, 300) },
    chesscom: {
      dir: 'chesscom',
      username: ccUser,
      hero,
      archives: monthKeys.map(k => `${k.replace('/', '-')}.json`),
      skipped: variants.length,
      ...summary(cc),
      planted: plantedStats(rep, cc),
    },
    pgn: { file: 'upload.pgn', hero: 'Hero, Test', ...summary(otb), skipped: 1, planted: plantedStats(rep, otb) },
    sha256: files,
  };
  write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { out: { type: 'string', default: join(ROOT, 'e2e', 'fixtures') }, seed: { type: 'string', default: String(DEFAULT_SEED) } },
  });
  const out = resolve(values.out);
  const m = writeFixtures({ out, seed: Number(values.seed) });
  const brief = set => `${set.count} games, planted: ${set.planted.map(p => `${p.color} ${p.move_san} ${p.times_played}/${p.times_reached}`).join(', ')}`;
  console.log(`fixtures -> ${relative(process.cwd(), out) || '.'}`);
  console.log(`  lichess  ${brief(m.lichess)}`);
  console.log(`  chesscom ${brief(m.chesscom)} (+${m.chesscom.skipped} variants, ${m.chesscom.archives.length} archives)`);
  console.log(`  pgn      ${brief(m.pgn)}`);
}
