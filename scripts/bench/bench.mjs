#!/usr/bin/env node
// Engine benchmark harness for opening-mistake detection (chess-analyzer v3).
//
// Question it answers: which Stockfish build / depth / MultiPV should the browser app use to
// classify "your move vs the best move" in opening positions, and what does it cost?
//
// Pipeline (each step writes JSON into --out, default: this directory):
//   build-set   lichess-org/chess-openings TSVs -> testset.json
//               (seeded; positions at plies [min..max] spread evenly; candidates = theory
//               continuation (if any) + one random legal move (+ a second random one when there is
//               no theory move))
//   reference   native Stockfish, depth 22, MultiPV 3, Hash 64, `ucinewgame` before every position
//               (order-independent, so it can run in --procs parallel processes). Adds one of the
//               reference's 2nd/3rd best moves to each position's candidates, then evaluates every
//               candidate not covered by the top lines with `go depth D searchmoves <move>`
//               -> reference.json (this freezes the final candidate set)
//   run         one engine config over the frozen set, single engine process, hash kept between
//               positions, same method as the reference (MultiPV k at depth D + searchmoves for
//               uncovered candidates) -> runs/<engine>-d<D>-mp<k>.json
//   parallel    N engines driven concurrently from a shared queue (pool design) -> runs/parallel-*.json
//   init        engine init time (load + uci + isready), each repetition in a fresh Node process
//   report      metrics vs reference (+ paired significance tests) -> results.json, markdown on stdout
//   paired      paired comparison of named runs: node bench.mjs paired lite-d12-mp1 lite-d14-mp1
//   all         every step whose output is missing (--force: all): build-set, reference, init,
//               DEFAULT_MATRIX runs, PARALLEL_MATRIX pool runs, report
//
// Usage:
//   node bench.mjs all
//   node bench.mjs run --engine lite --depth 12 [--multipv 3] [--hash 16] [--limit 50]
//   node bench.mjs parallel --engine lite --depth 12 --workers 1,2,3,4
//   node bench.mjs report
// Engines: native (--native-bin, default /usr/games/stockfish or $STOCKFISH),
//          lite (stockfish npm: stockfish-19-lite-single), full (stockfish-19-single, 99 MB).
//
// Scores are from the side to move at the root. winPct(cp) = 50 + 50*(2/(1+exp(-0.00368208*cp))-1),
// mate => 100/0. loss = max(0, winPct(best) - winPct(move)). Severity: >=15 blunder, >=10 mistake,
// >=5 inaccuracy, else ok.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Chess, normalizeMove } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import { makeSquare, parseUci, roleToChar, squareFile, squareRank } from 'chessops/util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: HERE },
    data: { type: 'string' },
    seed: { type: 'string', default: '20261008' },
    positions: { type: 'string', default: '150' },
    'min-ply': { type: 'string', default: '2' },
    'max-ply': { type: 'string', default: '24' },
    engine: { type: 'string', default: 'lite' },
    depth: { type: 'string', default: '12' },
    multipv: { type: 'string', default: '3' },
    hash: { type: 'string', default: '16' },
    threads: { type: 'string', default: '1' },
    limit: { type: 'string' },
    procs: { type: 'string', default: String(Math.max(1, os.availableParallelism?.() ?? os.cpus().length)) },
    workers: { type: 'string', default: '1,2,3,4' },
    reps: { type: 'string', default: '5' },
    'native-bin': { type: 'string', default: process.env.STOCKFISH || '/usr/games/stockfish' },
    'ref-depth': { type: 'string', default: '22' },
    'ref-multipv': { type: 'string', default: '3' },
    'ref-hash': { type: 'string', default: '64' },
    tag: { type: 'string' },
    mode: { type: 'string', default: 'in-process' }, // init-once for wasm: in-process | process
    quiet: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

const OUT = path.resolve(args.out);
const RUNS = path.join(OUT, 'runs');
const TESTSET = path.join(OUT, 'testset.json');
const REFERENCE = path.join(OUT, 'reference.json');
const int = (v) => (v === undefined ? undefined : Number.parseInt(v, 10));

const ENGINES = {
  native: { kind: 'native', label: 'Stockfish native binary (--native-bin)' },
  lite: { kind: 'wasm', build: 'lite-single', label: 'Stockfish 19 lite single-threaded WASM (1.8 MB)' },
  full: { kind: 'wasm', build: 'single', label: 'Stockfish 19 full single-threaded WASM (99 MB)' },
};

const log = (...a) => { if (!args.quiet) console.error(...a); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 1)); };

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

const winPct = (s) =>
  s.type === 'mate' ? (s.value > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * s.value)) - 1);
const lossOf = (best, move) => Math.max(0, winPct(best) - winPct(move));
const SEVERITIES = ['ok', 'inaccuracy', 'mistake', 'blunder'];
const severity = (loss) => (loss >= 15 ? 'blunder' : loss >= 10 ? 'mistake' : loss >= 5 ? 'inaccuracy' : 'ok');

// ---------------------------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------------------------------------------------------------------------------------------
// Chess helpers (chessops)
// ---------------------------------------------------------------------------------------------

/** EPD key: board, turn, castling, ep only if a legal ep capture exists (chessops toSetup). */
const posKey = (pos) => makeFen(pos.toSetup(), { epd: true });
const fenOf = (pos) => makeFen(pos.toSetup());

/** chessops move -> standard UCI (castling as e1g1, not chessops' king-takes-rook e1h1). */
function toUci(pos, move) {
  const piece = pos.board.get(move.from);
  const target = pos.board.get(move.to);
  if (piece?.role === 'king' && target?.role === 'rook' && target.color === piece.color) {
    const file = squareFile(move.to) > squareFile(move.from) ? 6 : 2;
    return makeSquare(move.from) + makeSquare((move.from & ~7) | file);
  }
  return makeSquare(move.from) + makeSquare(move.to) + (move.promotion ? roleToChar(move.promotion) : '');
}

function legalUcis(pos) {
  const out = new Set();
  for (const [from, dests] of pos.allDests()) {
    const piece = pos.board.get(from);
    for (const to of dests) {
      const promo = piece.role === 'pawn' && (squareRank(to) === 0 || squareRank(to) === 7);
      if (promo) for (const r of ['queen', 'rook', 'bishop', 'knight']) out.add(toUci(pos, { from, to, promotion: r }));
      else out.add(toUci(pos, { from, to }));
    }
  }
  return [...out].sort();
}

const sanOf = (pos, uci) => makeSan(pos, normalizeMove(pos, parseUci(uci)));

function loadOpeningLines(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^[a-e]\.tsv$/.test(f)).sort();
  if (!files.length) throw new Error(`no a..e.tsv files in ${dir}`);
  const lines = [];
  for (const f of files) {
    const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (const row of rows.slice(1)) {
      if (!row.trim()) continue;
      const [eco, name, pgn] = row.split('\t');
      const sans = pgn.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t));
      lines.push({ eco, name, sans });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// UCI engines
// ---------------------------------------------------------------------------------------------

function parseInfo(line) {
  const t = line.trim().split(/\s+/);
  const o = {};
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'string': return null;
      case 'depth': o.depth = +t[++i]; break;
      case 'seldepth': o.seldepth = +t[++i]; break;
      case 'multipv': o.multipv = +t[++i]; break;
      case 'nodes': o.nodes = +t[++i]; break;
      case 'nps': o.nps = +t[++i]; break;
      case 'time': o.time = +t[++i]; break;
      case 'hashfull': o.hashfull = +t[++i]; break;
      case 'wdl': i += 3; break;
      case 'score':
        o.score = { type: t[++i], value: +t[++i] };
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') o.bound = t[++i];
        break;
      case 'pv': o.pv = t.slice(i + 1); i = t.length; break;
      default: break; // currmove, tbhits, ... (values are skipped as unknown tokens)
    }
  }
  return o;
}

class UciEngine {
  constructor(name) {
    this.name = name;
    this.waiters = [];
    this.onSearchLine = null;
    this.options = new Set();
    this.id = '';
    this.init = {};
  }

  _line(line) {
    if (this.onSearchLine) this.onSearchLine(line);
    if (line.startsWith('option name ')) this.options.add(line.slice(12).split(' type ')[0]);
    if (line.startsWith('id name ')) this.id = line.slice(8);
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].pred(line)) {
        const [w] = this.waiters.splice(i--, 1);
        clearTimeout(w.timer);
        w.resolve(line);
      }
    }
  }

  waitFor(pred, timeoutMs = 30 * 60_000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => reject(new Error(`${this.name}: timeout waiting for engine output`)), timeoutMs);
      this.waiters.push(w);
    });
  }

  async _handshake(t0) {
    this.send('uci');
    await this.waitFor((l) => l === 'uciok');
    const tUci = performance.now();
    this.send('isready');
    await this.waitFor((l) => l === 'readyok');
    const tReady = performance.now();
    Object.assign(this.init, { uciokMs: tUci - t0, totalMs: tReady - t0 });
  }

  async sync() {
    this.send('isready');
    await this.waitFor((l) => l === 'readyok');
  }

  async configure({ hash, threads, multipv }) {
    if (threads !== undefined && this.options.has('Threads')) this.send(`setoption name Threads value ${threads}`);
    if (hash !== undefined) this.send(`setoption name Hash value ${hash}`);
    if (multipv !== undefined) this.send(`setoption name MultiPV value ${multipv}`);
    this.send('ucinewgame');
    await this.sync();
  }

  /** One `go depth` search from `fen`. Wall time is measured from `position` to `bestmove`. */
  search(fen, depth, searchmoves) {
    return new Promise((resolve) => {
      const byPv = new Map();
      let nodes = 0;
      let engineMs = 0;
      const t0 = performance.now();
      this.onSearchLine = (line) => {
        if (line.startsWith('info ')) {
          const o = parseInfo(line);
          if (!o) return;
          if (o.nodes !== undefined) nodes = o.nodes;
          if (o.time !== undefined) engineMs = o.time;
          if (o.score && o.pv?.length && !o.bound) byPv.set(o.multipv ?? 1, o);
        } else if (line.startsWith('bestmove')) {
          const wallMs = performance.now() - t0;
          this.onSearchLine = null;
          const lines = [...byPv.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([k, o]) => ({ multipv: k, depth: o.depth, seldepth: o.seldepth, score: o.score, move: o.pv[0], pv: o.pv }));
          resolve({ wallMs, engineMs, nodes, bestmove: line.split(/\s+/)[1], lines });
        }
      };
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}${searchmoves?.length ? ` searchmoves ${searchmoves.join(' ')}` : ''}`);
    });
  }
}

/** A UCI engine in its own OS process (native binary, or Node running the stockfish.js CLI glue). */
class ProcessEngine extends UciEngine {
  static async start(name, cmd, argv = []) {
    const e = new ProcessEngine(name);
    const t0 = performance.now();
    e.proc = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'inherit'] });
    const failed = new Promise((_, rej) => e.proc.on('error', rej));
    readline.createInterface({ input: e.proc.stdout }).on('line', (l) => e._line(l));
    await Promise.race([e._handshake(t0), failed]);
    return e;
  }
  send(cmd) { this.proc.stdin.write(`${cmd}\n`); }
  async quit() {
    this.send('quit');
    await new Promise((res) => {
      const timer = setTimeout(() => { this.proc.kill('SIGKILL'); res(); }, 2000);
      this.proc.once('exit', () => { clearTimeout(timer); res(); });
    });
  }
}

// stockfish.js refuses to export its factory inside a Node worker thread (it assumes it is an
// Emscripten pthread helper there), so for search benchmarks each WASM engine runs as its own Node
// process using the package's CLI mode (stdin/stdout UCI). Same WASM, same V8, real parallelism.
const requireCjs = createRequire(import.meta.url);
function wasmGluePath(build) {
  const pkgDir = path.dirname(requireCjs.resolve('stockfish/package.json'));
  const version = requireCjs('stockfish/package.json').buildVersion;
  return path.join(pkgDir, 'bin', `stockfish-${version}-${build}.js`);
}

/** In-process WASM engine via the package API (main thread only). Used to time engine init. */
async function startInProcessWasm(build) {
  const t0 = performance.now();
  const origLog = console.log;
  console.log = () => {}; // the glue prints a banner before a listener can be attached
  let engine;
  try {
    engine = await requireCjs('stockfish')(build);
  } finally {
    console.log = origLog;
  }
  const loadedMs = performance.now() - t0;
  const e = new UciEngine(`wasm-inproc:${build}`);
  e.send = (cmd) => engine.sendCommand(cmd);
  e.quit = async () => {};
  engine.listener = (line) => e._line(line);
  e.init.loadedMs = loadedMs;
  await e._handshake(t0);
  return e;
}

async function startEngine(engine) {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`unknown engine '${engine}' (native|lite|full)`);
  const e = spec.kind === 'native'
    ? await ProcessEngine.start('native', args['native-bin'])
    : await ProcessEngine.start(`wasm:${spec.build}`, process.execPath, [wasmGluePath(spec.build)]);
  e.engine = engine;
  return e;
}

/**
 * The method under test (identical for reference and candidates):
 * MultiPV k at depth D from the root, then `go depth D searchmoves <m>` from the same root for
 * every candidate move that is not one of the k PV moves.
 */
async function evalPosition(engine, p, depth, candidates, chooseExtra) {
  const t0 = performance.now();
  const main = await engine.search(p.fen, depth);
  const top = main.lines.map((l) => ({ move: l.move, score: l.score, depth: l.depth, pv: l.pv.slice(0, 16) }));
  let cands = candidates;
  let added = [];
  if (chooseExtra) {
    added = chooseExtra(top, candidates);
    cands = candidates.concat(added);
  }
  const evals = [];
  const extra = [];
  for (const c of cands) {
    const rank = top.findIndex((t) => t.move === c.uci);
    if (rank >= 0) {
      evals.push({ uci: c.uci, score: top[rank].score, via: 'multipv', rank: rank + 1 });
      continue;
    }
    const r = await engine.search(p.fen, depth, [c.uci]);
    const l = r.lines[0];
    if (!l || l.move !== c.uci) throw new Error(`searchmoves ${c.uci} returned ${l?.move} for ${p.fen}`);
    evals.push({ uci: c.uci, score: l.score, via: 'searchmoves', depth: l.depth, pv: l.pv.slice(0, 12) });
    extra.push(r);
  }
  return {
    id: p.id,
    wallMs: performance.now() - t0,
    multipvMs: main.wallMs,
    searchmovesMs: extra.map((r) => r.wallMs),
    nodes: main.nodes + extra.reduce((s, r) => s + r.nodes, 0),
    searches: 1 + extra.length,
    top,
    evals,
    added,
  };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function cmdBuildSet() {
  const seed = int(args.seed);
  const n = int(args.positions);
  const minPly = int(args['min-ply']);
  const maxPly = int(args['max-ply']);
  const dataDir = args.data
    ? path.resolve(args.data)
    : [path.join(HERE, '../data'), path.join(HERE, '../../data/openings')].find((d) => fs.existsSync(d));
  if (!dataDir) throw new Error('openings TSV directory not found; pass --data <dir with a.tsv..e.tsv>');
  const rng = mulberry32(seed);
  const lines = loadOpeningLines(dataDir);

  // Replay every line once: theory map (posKey -> next moves) + per-ply positions.
  const theory = new Map();
  const replayed = [];
  let bad = 0;
  for (const l of lines) {
    const pos = Chess.default();
    const ucis = [];
    for (const san of l.sans) {
      const move = parseSan(pos, san);
      if (!move) { bad++; break; }
      const key = posKey(pos);
      const uci = toUci(pos, move);
      if (!theory.has(key)) theory.set(key, new Set());
      theory.get(key).add(uci);
      ucis.push(uci);
      pos.play(move);
    }
    replayed.push({ eco: l.eco, name: l.name, ucis });
  }

  const replay = (ucis, plies) => {
    const pos = Chess.default();
    for (const u of ucis.slice(0, plies)) pos.play(normalizeMove(pos, parseUci(u)));
    return pos;
  };

  const seen = new Set();
  const positions = [];
  const span = maxPly - minPly + 1;
  for (let i = 0; i < n; i++) {
    const ply = minPly + Math.floor((i * span) / n);
    const pool = replayed.filter((r) => r.ucis.length >= ply);
    let chosen = null;
    for (let attempt = 0; attempt < 1000 && !chosen; attempt++) {
      const r = pick(rng, pool);
      const pos = replay(r.ucis, ply);
      const key = posKey(pos);
      if (seen.has(key) || pos.isEnd()) continue;
      seen.add(key);
      chosen = { r, pos, key };
    }
    if (!chosen) { log(`warning: no new position found at ply ${ply}`); continue; }
    const { r, pos, key } = chosen;
    const candidates = [];
    const theoryMoves = [...(theory.get(key) ?? [])].sort();
    if (theoryMoves.length) candidates.push({ uci: pick(rng, theoryMoves), source: 'theory' });
    const nRandom = theoryMoves.length ? 1 : 2;
    for (let k = 0; k < nRandom; k++) {
      const legal = legalUcis(pos).filter((u) => !candidates.some((c) => c.uci === u));
      if (legal.length) candidates.push({ uci: pick(rng, legal), source: 'random' });
    }
    for (const c of candidates) c.san = sanOf(pos, c.uci);
    positions.push({
      ply,
      fen: fenOf(pos),
      posKey: key,
      line: r.ucis.slice(0, ply),
      eco: r.eco,
      opening: r.name,
      theoryMoves,
      legalMoves: legalUcis(pos).length,
      candidates,
    });
  }
  // Shuffle the run order (seeded) so consecutive positions are not from the same line.
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  positions.forEach((p, i) => { p.id = `p${String(i + 1).padStart(3, '0')}`; });
  const set = {
    created: new Date().toISOString(),
    seed, minPly, maxPly, source: path.relative(OUT, dataDir), linesLoaded: lines.length, linesUnparsable: bad,
    positions: positions.map(({ id, ...rest }) => ({ id, ...rest })),
  };
  writeJson(TESTSET, set);
  const pairs = positions.reduce((s, p) => s + p.candidates.length, 0);
  log(`testset: ${positions.length} positions, ${pairs} initial candidate pairs (ref-alt moves are added by 'reference') -> ${TESTSET}`);
}

async function cmdReference() {
  const set = readJson(TESTSET);
  const positions = set.positions.slice(0, int(args.limit) ?? set.positions.length);
  const depth = int(args['ref-depth']);
  const multipv = int(args['ref-multipv']);
  const hash = int(args['ref-hash']);
  const procs = Math.min(int(args.procs), positions.length);
  const seed = set.seed;
  log(`reference: native depth ${depth} MultiPV ${multipv} Hash ${hash}, ${positions.length} positions on ${procs} processes`);
  const engines = await Promise.all(Array.from({ length: procs }, () => startEngine('native')));
  await Promise.all(engines.map((e) => e.configure({ hash, threads: 1, multipv })));

  const chooseAlt = (p) => (top, cands) => {
    const rng = mulberry32(fnv1a(`${seed}:${p.id}:alt`));
    const options = top.slice(1, 3).filter((t) => !cands.some((c) => c.uci === t.move));
    if (!options.length) return [];
    const t = pick(rng, options);
    const pos = Chess.fromSetup(parseFenSetup(p.fen)).unwrap();
    return [{ uci: t.move, source: 'ref-alt', refRank: top.indexOf(t) + 1, san: sanOf(pos, t.move) }];
  };

  const results = new Array(positions.length);
  let next = 0;
  let done = 0;
  const tStart = performance.now();
  await Promise.all(engines.map(async (e) => {
    while (next < positions.length) {
      const i = next++;
      const p = positions[i];
      e.send('ucinewgame'); // order independent => reproducible regardless of --procs
      await e.sync();
      const r = await evalPosition(e, p, depth, p.candidates, chooseAlt(p));
      results[i] = { ...p, candidates: p.candidates.concat(r.added), result: r };
      if (++done % 10 === 0) log(`  reference ${done}/${positions.length} (${((performance.now() - tStart) / 1000).toFixed(0)} s)`);
    }
  }));
  const totalMs = performance.now() - tStart;
  const engineId = engines[0].id;
  await Promise.all(engines.map((e) => e.quit()));

  writeJson(REFERENCE, {
    created: new Date().toISOString(),
    engine: engineId, bin: args['native-bin'], depth, multipv, hash, threads: 1, procs,
    note: 'ucinewgame before each position; positions distributed over procs parallel processes (timings are under parallel load)',
    totalMs,
    positions: results.map(({ result, ...p }) => ({
      id: p.id, ply: p.ply, fen: p.fen, eco: p.eco, opening: p.opening, candidates: p.candidates,
      top: result.top, evals: result.evals, wallMs: result.wallMs, nodes: result.nodes, searches: result.searches,
    })),
  });
  const pairs = results.reduce((s, p) => s + p.candidates.length, 0);
  log(`reference: ${results.length} positions, ${pairs} pairs, ${(totalMs / 1000).toFixed(1)} s -> ${REFERENCE}`);
}

const parseFenSetup = (fen) => parseFen(fen).unwrap();

function loadFrozenSet() {
  if (!fs.existsSync(REFERENCE)) throw new Error(`missing ${REFERENCE}: run 'node bench.mjs reference' first`);
  const ref = readJson(REFERENCE);
  return ref.positions.map((p) => ({ id: p.id, fen: p.fen, ply: p.ply, candidates: p.candidates }));
}

const runName = (engine, depth, multipv, extra = '') =>
  `${engine}-d${depth}-mp${multipv}${extra}${args.tag ? `-${args.tag}` : ''}`;

async function cmdRun() {
  const engine = args.engine;
  const depth = int(args.depth);
  const multipv = int(args.multipv);
  const hash = int(args.hash);
  const threads = int(args.threads);
  const all = loadFrozenSet();
  const limit = int(args.limit);
  const positions = all.slice(0, limit ?? all.length);
  const name = runName(engine, depth, multipv, limit ? `-n${limit}` : '');
  const e = await startEngine(engine);
  const init = { ...e.init };
  await e.configure({ hash, threads, multipv });
  log(`[${name}] ${e.id}: init ${init.totalMs.toFixed(0)} ms, ${positions.length} positions`);
  const results = [];
  const tStart = performance.now();
  for (const p of positions) {
    results.push(await evalPosition(e, p, depth, p.candidates));
    if (results.length % 25 === 0) {
      const med = quantile(results.map((r) => r.wallMs), 0.5);
      log(`  [${name}] ${results.length}/${positions.length} median ${med.toFixed(0)} ms/pos, elapsed ${((performance.now() - tStart) / 1000).toFixed(0)} s`);
    }
  }
  const totalMs = performance.now() - tStart;
  const engineId = e.id;
  await e.quit();
  const file = path.join(RUNS, `${name}.json`);
  writeJson(file, {
    type: 'run', name, engine, engineId, label: ENGINES[engine].label, depth, multipv, hash, threads,
    created: new Date().toISOString(), init, totalMs, positions: results,
  });
  log(`[${name}] done in ${(totalMs / 1000).toFixed(1)} s -> ${path.relative(OUT, file)}`);
}

async function cmdParallel() {
  const engine = args.engine;
  const depth = int(args.depth);
  const multipv = int(args.multipv);
  const hash = int(args.hash);
  const all = loadFrozenSet();
  const positions = all.slice(0, int(args.limit) ?? all.length);
  for (const workers of args.workers.split(',').map(Number)) {
    const name = `parallel-${runName(engine, depth, multipv, `-w${workers}`)}`;
    const tInit = performance.now();
    const engines = await Promise.all(Array.from({ length: workers }, () => startEngine(engine)));
    await Promise.all(engines.map((e) => e.configure({ hash, threads: 1, multipv })));
    const initWallMs = performance.now() - tInit;
    const results = new Array(positions.length);
    let next = 0;
    const tStart = performance.now();
    await Promise.all(engines.map(async (e, w) => {
      while (next < positions.length) {
        const i = next++;
        results[i] = { ...(await evalPosition(e, positions[i], depth, positions[i].candidates)), worker: w };
      }
    }));
    const totalMs = performance.now() - tStart;
    await Promise.all(engines.map((e) => e.quit()));
    const file = path.join(RUNS, `${name}.json`);
    writeJson(file, {
      type: 'parallel', name, engine, label: ENGINES[engine].label, depth, multipv, hash, threads: 1, workers,
      created: new Date().toISOString(), initWallMs, totalMs, positions: results,
    });
    log(`[${name}] ${positions.length} positions in ${(totalMs / 1000).toFixed(1)} s (init ${initWallMs.toFixed(0)} ms)`);
  }
}

async function cmdInitOnce() {
  const spec = ENGINES[args.engine];
  const inProcess = spec.kind === 'wasm' && args.mode === 'in-process';
  const e = inProcess ? await startInProcessWasm(spec.build) : await startEngine(args.engine);
  const init = { ...e.init, id: e.id, mode: inProcess ? 'in-process' : 'child-process' };
  await e.quit();
  process.stdout.write(`${JSON.stringify(init)}\n`);
  process.exit(0);
}

function cmdInit() {
  const reps = int(args.reps);
  const engines = args.engine === 'all' ? Object.keys(ENGINES) : args.engine.split(',');
  const file = path.join(RUNS, 'init.json');
  const out = fs.existsSync(file) ? readJson(file) : { type: 'init', engines: {} };
  const variants = engines.flatMap((engine) =>
    ENGINES[engine].kind === 'wasm' ? [[engine, 'in-process'], [`${engine}-process`, 'process', engine]] : [[engine, 'process']]);
  for (const [key, mode, engine = key] of variants) {
    const samples = [];
    for (let i = 0; i < reps; i++) {
      const r = spawnSync(process.execPath, [SELF, 'init-once', '--engine', engine, '--mode', mode, '--native-bin', args['native-bin']], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`init-once ${engine} failed: ${r.stderr}`);
      samples.push(JSON.parse(r.stdout.trim().split('\n').pop()));
    }
    out.engines[key] = { label: ENGINES[engine].label, id: samples[0].id, mode: samples[0].mode, reps, samples };
    log(`init ${key}: total ms ${samples.map((x) => x.totalMs.toFixed(0)).join(', ')}`);
  }
  out.created = new Date().toISOString();
  out.note = 'each sample is a fresh Node process; native = spawn..readyok; wasm = in-process require(stockfish)(build)..readyok on the main thread (loadedMs = module load + wasm compile/instantiate), i.e. what a browser worker pays after the download; <engine>-process = spawn node CLI glue..readyok (what the search benchmarks use, includes Node startup)';
  writeJson(file, out);
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** 95% Wilson score interval for k successes out of n. */
function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96;
  const ph = k / n;
  const d = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
  return [r3(c - h), r3(c + h)];
}

function classMetrics(pairs) {
  const pr = (T) => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const p of pairs) {
      const r = p.refLoss >= T;
      const c = p.cfgLoss >= T;
      if (r && c) tp++; else if (c) fp++; else if (r) fn++; else tn++;
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    return {
      tp, fp, fn, tn,
      precision: r3(precision), precisionCi95: wilson(tp, tp + fp),
      recall: r3(recall), recallCi95: wilson(tp, tp + fn),
      f1: r3((2 * precision * recall) / (precision + recall)),
    };
  };
  const confusion = Object.fromEntries(SEVERITIES.map((s) => [s, Object.fromEntries(SEVERITIES.map((t) => [t, 0]))]));
  for (const p of pairs) confusion[severity(p.refLoss)][severity(p.cfgLoss)]++;
  const absErr = pairs.map((p) => Math.abs(p.cfgLoss - p.refLoss));
  const agree = pairs.filter((p) => severity(p.refLoss) === severity(p.cfgLoss)).length;
  return {
    pairs: pairs.length,
    atLeastInaccuracy: pr(5),
    atLeastMistake: pr(10),
    severityAgreement: r3(agree / pairs.length),
    severityAgreementCi95: wilson(agree, pairs.length),
    lossMAE: r3(mean(absErr)),
    lossAbsErrP90: r3(quantile(absErr, 0.9)),
    confusionRefRowsCfgCols: confusion,
  };
}

function accuracyVsReference(refPositions, runPositions) {
  const byId = new Map(runPositions.map((p) => [p.id, p]));
  const pairs = [];
  let n = 0, bestAgree = 0, bestInTop = 0, bestKnown = 0, bestAcceptable = 0;
  for (const rp of refPositions) {
    const cp = byId.get(rp.id);
    if (!cp) continue;
    n++;
    const refBest = rp.top[0].score;
    const cfgBest = cp.top[0].score;
    for (const c of rp.candidates) {
      const re = rp.evals.find((e) => e.uci === c.uci);
      const ce = cp.evals.find((e) => e.uci === c.uci);
      pairs.push({ id: rp.id, uci: c.uci, source: c.source, refLoss: lossOf(refBest, re.score), cfgLoss: lossOf(cfgBest, ce.score) });
    }
    const cfgMove = cp.top[0].move;
    if (cfgMove === rp.top[0].move) bestAgree++;
    if (rp.top.some((t) => t.move === cfgMove)) bestInTop++;
    const known = rp.top.find((t) => t.move === cfgMove)?.score ?? rp.evals.find((e) => e.uci === cfgMove)?.score;
    if (known) { bestKnown++; if (lossOf(refBest, known) < 5) bestAcceptable++; }
  }
  return {
    positions: n,
    ...classMetrics(pairs),
    bestMoveAgreement: r3(bestAgree / n),
    bestMoveInRefTop3: r3(bestInTop / n),
    bestMoveAcceptableByRef: { rate: r3(bestAcceptable / bestKnown), knownFor: bestKnown },
    subsetNonRandom: classMetrics(pairs.filter((p) => p.source !== 'random')),
  };
}

/** Per (position, candidate) pair: [absolute loss error, severity class correct?] grouped by position. */
function pairErrors(refPositions, runPositions) {
  const byId = new Map(runPositions.map((p) => [p.id, p]));
  return refPositions.map((rp) => {
    const cp = byId.get(rp.id);
    return rp.candidates.map((c) => {
      const r = lossOf(rp.top[0].score, rp.evals.find((e) => e.uci === c.uci).score);
      const k = lossOf(cp.top[0].score, cp.evals.find((e) => e.uci === c.uci).score);
      return [Math.abs(r - k), severity(r) === severity(k)];
    });
  });
}

/**
 * Paired comparison of two runs on the same pairs: exact McNemar test on severity-class correctness
 * and a position-clustered bootstrap (2000 resamples, seeded) of the loss-MAE difference (b - a).
 */
function pairedComparison(refPositions, a, b) {
  const A = pairErrors(refPositions, a.positions);
  const B = pairErrors(refPositions, b.positions);
  let onlyA = 0, onlyB = 0;
  A.forEach((pos, i) => pos.forEach(([, ok], j) => { if (ok && !B[i][j][1]) onlyA++; else if (!ok && B[i][j][1]) onlyB++; }));
  const n = onlyA + onlyB;
  let tail = 0;
  for (let k = 0, c = 1; k <= Math.min(onlyA, onlyB); k++) { tail += c * 0.5 ** n; c = (c * (n - k)) / (k + 1); }
  const maeDiff = (idx) => {
    let da = 0, db = 0, m = 0;
    for (const i of idx) A[i].forEach(([e], j) => { da += e; db += B[i][j][0]; m++; });
    return (db - da) / m;
  };
  const all = A.map((_, i) => i);
  const rng = mulberry32(fnv1a(`${a.name}|${b.name}`));
  const boots = Array.from({ length: 2000 }, () => maeDiff(all.map(() => Math.floor(rng() * all.length)))).sort((x, y) => x - y);
  return {
    a: a.name, b: b.name,
    severity: { onlyARight: onlyA, onlyBRight: onlyB, mcnemarExactP: r3(Math.min(1, 2 * tail)) },
    lossMAEChange: { value: r3(maeDiff(all)), ci95: [r3(boots[49]), r3(boots[1950])] },
  };
}

const DEFAULT_PAIRS = [
  ['lite-d8-mp3', 'lite-d14-mp3'], ['native-d8-mp3', 'lite-d8-mp3'],
  ['lite-d10-mp1', 'lite-d12-mp1'], ['lite-d12-mp1', 'lite-d14-mp1'], ['lite-d14-mp1', 'lite-d16-mp1'],
  ['lite-d12-mp3', 'lite-d14-mp3'], ['lite-d14-mp3', 'lite-d16-mp3'],
  ['lite-d12-mp1', 'lite-d12-mp3'], ['lite-d14-mp1', 'lite-d14-mp3'], ['lite-d14-mp3', 'lite-d14-mp5'],
  ['lite-d12-mp3', 'full-d12-mp3'], ['lite-d14-mp3', 'full-d14-mp3'],
  ['lite-d12-mp3', 'parallel-lite-d12-mp3-w4'], ['lite-d14-mp1', 'parallel-native-d18-mp3-w4'],
];

function timing(positions) {
  const wall = positions.map((p) => p.wallMs);
  const nodes = positions.map((p) => p.nodes);
  const totalNodes = nodes.reduce((a, b) => a + b, 0);
  const totalWall = wall.reduce((a, b) => a + b, 0);
  return {
    msPerPositionMedian: r1(quantile(wall, 0.5)),
    msPerPositionP90: r1(quantile(wall, 0.9)),
    msPerPositionMean: r1(mean(wall)),
    msPerPositionMax: r1(Math.max(...wall)),
    sumWallMs: r1(totalWall),
    multipvShareOfTime: positions.every((p) => p.multipvMs !== undefined) ? r3(positions.reduce((s, p) => s + p.multipvMs, 0) / totalWall) : null,
    searchesPerPositionMean: r3(mean(positions.map((p) => p.searches))),
    nodesPerPositionMedian: Math.round(quantile(nodes, 0.5)),
    knps: r1(totalNodes / totalWall),
  };
}

function cmdReport() {
  const ref = readJson(REFERENCE);
  const files = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort() : [];
  const runs = files.map((f) => readJson(path.join(RUNS, f)));
  const initRun = runs.find((r) => r.type === 'init');
  const engineOrder = Object.keys(ENGINES);
  const configs = runs
    .filter((r) => r.type === 'run')
    .sort((a, b) => engineOrder.indexOf(a.engine) - engineOrder.indexOf(b.engine) || a.depth - b.depth || a.multipv - b.multipv || a.positions.length - b.positions.length || a.name.length - b.name.length)
    .map((r) => ({
      name: r.name, engine: r.engine, engineId: r.engineId, depth: r.depth, multipv: r.multipv, hash: r.hash, threads: r.threads,
      positions: r.positions.length, initMs: r1(r.init.totalMs), totalMs: r1(r.totalMs),
      timing: timing(r.positions),
      accuracy: accuracyVsReference(ref.positions, r.positions),
    }));
  const parallel = runs
    .filter((r) => r.type === 'parallel')
    .sort((a, b) => a.depth - b.depth || a.workers - b.workers)
    .map((r) => ({
      name: r.name, engine: r.engine, depth: r.depth, multipv: r.multipv, workers: r.workers, positions: r.positions.length,
      initWallMs: r1(r.initWallMs), totalWallMs: r1(r.totalMs), positionsPerSecond: r3(r.positions.length / (r.totalMs / 1000)),
      timing: timing(r.positions),
      accuracy: (({ atLeastInaccuracy, atLeastMistake, severityAgreement, lossMAE, bestMoveAgreement }) =>
        ({ atLeastInaccuracy, atLeastMistake, severityAgreement, lossMAE, bestMoveAgreement }))(accuracyVsReference(ref.positions, r.positions)),
    }));
  for (const group of new Set(parallel.map((p) => `${p.engine}-${p.depth}-${p.multipv}`))) {
    const g = parallel.filter((p) => `${p.engine}-${p.depth}-${p.multipv}` === group);
    const base = g.find((p) => p.workers === 1);
    if (base) for (const p of g) p.speedupVs1 = r3(base.totalWallMs / p.totalWallMs);
  }

  const byName = new Map(runs.filter((r) => r.positions).map((r) => [r.name, r]));
  const paired = DEFAULT_PAIRS.filter(([a, b]) => byName.has(a) && byName.has(b))
    .map(([a, b]) => pairedComparison(ref.positions, byName.get(a), byName.get(b)));

  const init = initRun
    ? Object.fromEntries(Object.entries(initRun.engines).map(([k, v]) => [k, {
      label: v.label, id: v.id, reps: v.reps,
      totalMsMedian: r1(quantile(v.samples.map((s) => s.totalMs), 0.5)),
      totalMsMin: r1(Math.min(...v.samples.map((s) => s.totalMs))),
      totalMsMax: r1(Math.max(...v.samples.map((s) => s.totalMs))),
      loadedMsMedian: v.samples[0].loadedMs !== undefined ? r1(quantile(v.samples.map((s) => s.loadedMs), 0.5)) : undefined,
    }]))
    : {};

  // Test-set composition (by reference severity).
  const refPairs = [];
  for (const p of ref.positions) {
    for (const c of p.candidates) {
      const e = p.evals.find((x) => x.uci === c.uci);
      const loss = lossOf(p.top[0].score, e.score);
      refPairs.push({ id: p.id, ply: p.ply, uci: c.uci, san: c.san, source: c.source, via: e.via, refLoss: r3(loss), refSeverity: severity(loss) });
    }
  }
  const countBy = (xs, f) => xs.reduce((m, x) => { m[f(x)] = (m[f(x)] ?? 0) + 1; return m; }, {});
  const composition = {
    positions: ref.positions.length,
    pairs: refPairs.length,
    plyHistogram: countBy(ref.positions, (p) => p.ply),
    sideToMove: countBy(ref.positions, (p) => p.fen.split(' ')[1]),
    bySource: countBy(refPairs, (p) => p.source),
    byRefSeverity: countBy(refPairs, (p) => p.refSeverity),
    bySourceAndSeverity: countBy(refPairs, (p) => `${p.source}/${p.refSeverity}`),
  };

  const cpu = os.cpus();
  const results = {
    generated: new Date().toISOString(),
    machine: { cpuModel: cpu[0]?.model, cpus: cpu.length, platform: `${os.platform()} ${os.release()}`, node: process.version, totalMemGB: r1(os.totalmem() / 2 ** 30) },
    method: {
      winPct: '50 + 50*(2/(1+exp(-0.00368208*cp)) - 1); mate => 100 (mover mates) / 0 (mover is mated)',
      loss: 'max(0, winPct(best) - winPct(move)), best = MultiPV 1 score; all scores from the root side to move',
      severity: 'blunder >= 15, mistake >= 10, inaccuracy >= 5, else ok',
      search: 'MultiPV k at depth D from the root; each candidate not among the k PV moves gets `go depth D searchmoves <move>` from the same root',
      candidates: 'Threads 1, Hash 16, hash kept between positions (no ucinewgame), each config in a fresh engine process',
    },
    reference: { engine: ref.engine, depth: ref.depth, multipv: ref.multipv, hash: ref.hash, procs: ref.procs, totalMs: r1(ref.totalMs), timing: timing(ref.positions) },
    composition,
    init,
    configs,
    parallel,
    paired,
    referencePairs: refPairs,
  };
  const file = path.join(OUT, 'results.json');
  writeJson(file, results);
  process.stdout.write(markdownTables(results));
  log(`-> ${file}`);
}

function markdownTables(res) {
  const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  let s = '\n| Config | Depth | MPV | n | ms/pos median | ms/pos p90 | knps | P>=5 | R>=5 | P>=10 | R>=10 | Severity agree | Loss MAE | Best move agree |\n';
  s += '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const c of res.configs) {
    const a = c.accuracy;
    s += `| ${c.name} | ${c.depth} | ${c.multipv} | ${c.positions} | ${c.timing.msPerPositionMedian} | ${c.timing.msPerPositionP90} | ${c.timing.knps} | ${pct(a.atLeastInaccuracy.precision)} | ${pct(a.atLeastInaccuracy.recall)} | ${pct(a.atLeastMistake.precision)} | ${pct(a.atLeastMistake.recall)} | ${pct(a.severityAgreement)} | ${a.lossMAE} | ${pct(a.bestMoveAgreement)} |\n`;
  }
  s += '\nNon-random subset (theory + reference 2nd/3rd-best moves):\n\n| Config | Depth | MPV | pairs | P>=5 | R>=5 | P>=10 | R>=10 | Severity agree | Loss MAE |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const c of res.configs) {
    const a = c.accuracy.subsetNonRandom;
    s += `| ${c.name} | ${c.depth} | ${c.multipv} | ${a.pairs} | ${pct(a.atLeastInaccuracy.precision)} | ${pct(a.atLeastInaccuracy.recall)} | ${pct(a.atLeastMistake.precision)} | ${pct(a.atLeastMistake.recall)} | ${pct(a.severityAgreement)} | ${a.lossMAE} |\n`;
  }
  if (res.parallel.length) {
    s += '\n| Engine | Depth | Workers | total wall s | positions/s | speedup vs 1 | ms/pos median (per engine) | Severity agree |\n|---|---:|---:|---:|---:|---:|---:|---:|\n';
    for (const p of res.parallel) s += `| ${p.engine} | ${p.depth} | ${p.workers} | ${(p.totalWallMs / 1000).toFixed(1)} | ${p.positionsPerSecond} | ${p.speedupVs1 ?? 'n/a'} | ${p.timing.msPerPositionMedian} | ${pct(p.accuracy.severityAgreement)} |\n`;
  }
  if (res.paired.length) {
    s += '\n| A | B | only A right | only B right | McNemar p | MAE change B-A [95% CI] |\n|---|---|---:|---:|---:|---|\n';
    for (const p of res.paired) s += `| ${p.a} | ${p.b} | ${p.severity.onlyARight} | ${p.severity.onlyBRight} | ${p.severity.mcnemarExactP} | ${p.lossMAEChange.value} [${p.lossMAEChange.ci95.join(', ')}] |\n`;
  }
  if (Object.keys(res.init).length) {
    s += '\n| Build | init median ms (min-max) | of which load/compile ms |\n|---|---:|---:|\n';
    for (const [k, v] of Object.entries(res.init)) s += `| ${k} (${v.id}) | ${v.totalMsMedian} (${v.totalMsMin}-${v.totalMsMax}) | ${v.loadedMsMedian ?? 'n/a'} |\n`;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

// Default matrix for `all`: build x depths x MultiPV values.
const DEFAULT_MATRIX = [
  { engine: 'native', depths: [8, 10, 12, 14], multipvs: [3] },
  { engine: 'lite', depths: [8, 10, 12, 14, 16], multipvs: [3] },
  { engine: 'full', depths: [10, 12, 14], multipvs: [3] },
  { engine: 'lite', depths: [10, 12, 14, 16], multipvs: [1] }, // MultiPV sweep
  { engine: 'lite', depths: [12, 14], multipvs: [5] },
];
// Pool experiments: [engine, depth, workers]. The depth-18 runs on 4 engines are accuracy-only
// "ceiling" checks (how well does a much deeper search agree with the reference?).
const PARALLEL_MATRIX = [
  ['lite', 12, '1,2,3,4'],
  ['native', 18, '4'],
  ['lite', 18, '4'],
];

function child(argv) {
  const r = spawnSync(process.execPath, [SELF, ...argv, '--out', OUT, '--native-bin', args['native-bin']], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`step failed: ${argv.join(' ')}`);
}

/** Runs every step whose output is missing (or all of them with --force). One fresh process per config. */
function cmdAll() {
  const missing = (f) => args.force || !fs.existsSync(f);
  if (!fs.existsSync(TESTSET)) child(['build-set', '--seed', args.seed, '--positions', args.positions]);
  if (!fs.existsSync(REFERENCE)) child(['reference', '--procs', args.procs]);
  if (missing(path.join(RUNS, 'init.json'))) child(['init', '--engine', 'all', '--reps', args.reps]);
  for (const { engine, depths, multipvs } of DEFAULT_MATRIX) {
    for (const multipv of multipvs) {
      for (const depth of depths) {
        if (missing(path.join(RUNS, `${runName(engine, depth, multipv)}.json`))) {
          child(['run', '--engine', engine, '--depth', String(depth), '--multipv', String(multipv)]);
        }
      }
    }
  }
  for (const [engine, depth, workers] of PARALLEL_MATRIX) {
    const todo = workers.split(',').filter((w) => missing(path.join(RUNS, `parallel-${runName(engine, depth, 3, `-w${w}`)}.json`)));
    if (todo.length) child(['parallel', '--engine', engine, '--depth', String(depth), '--multipv', '3', '--workers', todo.join(',')]);
  }
  child(['report']);
}

function cmdPaired() {
  const ref = readJson(REFERENCE);
  const names = positionals.slice(1);
  if (names.length < 2 || names.length % 2) throw new Error('usage: paired <runA> <runB> [<runC> <runD> ...]');
  for (let i = 0; i < names.length; i += 2) {
    const [a, b] = [names[i], names[i + 1]].map((n) => readJson(path.join(RUNS, `${n}.json`)));
    process.stdout.write(`${JSON.stringify(pairedComparison(ref.positions, a, b))}\n`);
  }
}

const COMMANDS = {
  'build-set': cmdBuildSet,
  reference: cmdReference,
  run: cmdRun,
  parallel: cmdParallel,
  init: cmdInit,
  'init-once': cmdInitOnce,
  report: cmdReport,
  paired: cmdPaired,
  all: cmdAll,
};

const cmd = positionals[0] ?? 'all';
if (!COMMANDS[cmd]) {
  console.error(`unknown command '${cmd}'. Commands: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(2);
}
try {
  await COMMANDS[cmd]();
} catch (err) {
  console.error(err?.stack || err);
  process.exit(1);
}
