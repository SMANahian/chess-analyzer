# Architecture

Chess Analyzer v3 is a static web app (PWA). There is no server: games are downloaded from the
Lichess and Chess.com public APIs straight into the browser, analysed by Stockfish compiled to
WebAssembly running in Web Workers, and stored in IndexedDB.

Why the rewrite, in measured numbers (old v2 Python app, see `docs/ENGINE.md` for method):

| Problem in v2 | Measured |
| --- | --- |
| Sync re-parses the whole stored PGN after every 100-game batch | 3,000 games: 45 s, 90 % of it re-parsing; 5,000 games: 115 s (16.5× more parses than needed) |
| Incremental sync beyond 5,000 games | new games silently discarded and marked as synced (data loss) |
| Chess.com sync | every sync re-downloads the full archive history, twice (once per colour) |
| Depth-6 verdicts | 73 % precision vs a depth-18 reference; 4 of the top 5 "mistakes" were false alarms (e.g. 3.Bc4 flagged at −106 cp while it is the best move); 15 % of verdicts flip on re-run |
| Batch cap | 7.9 % of recurring positions never evaluated at 2.5k games; opponent prep skips most positions beyond 1k games |
| Install | Python 3.8+, pip/pipx and a separate Stockfish install |

## Pipeline

```
 Lichess NDJSON stream ─┐
 Chess.com archives  ───┼─► RawGame ─► StoredGame (IndexedDB, first 40 plies as UCI)
 PGN files (any size) ──┘                    │
                                             ▼
                          Aggregator (2 passes, distinct-game counts)
                                             │ candidate positions (a move seen in ≥2 games)
                                             ▼
                 Scheduler (priority by weight) ─► EnginePool (N × Stockfish 19 lite WASM)
                     triage depth 10 ─► confirm depth 14 only if some move loses ≥ 2.5 %
                                             │ PositionEval (cached per engine build)
                                             ▼
                      classify: win-% loss, severity, confidence, book, impact, dependsOn
                                             ▼
                      Mistake records ─► live view filters ─► Leaks list / Train (SRS) / Scout
```

## Engine

Decision (benchmark in `docs/ENGINE.md`): **Stockfish 19 lite NNUE, single-threaded WASM (1.8 MB)**,
in a pool of `N` Web Workers, one position per worker.

- Lite matches the full 99 MB build on severity classification (p = 0.87 at depth 14) while being 1.7×
  faster and loading 6.6× quicker. It agrees with a native Stockfish depth-22 reference on 89.6 % of
  severity classes at depth 14 — the reference agrees with itself at depth 18 only 92.2 % of the time.
- Multi-threaded WASM needs `SharedArrayBuffer`, i.e. COOP/COEP headers that GitHub Pages cannot send.
  Positions are independent, so a pool of single-threaded engines scales instead: 1/2/3/4 engines →
  1.00/1.99/2.86/3.86× throughput on a 4-core machine.
- **MultiPV 1 + `searchmoves`**: one search for the best move, then one `go depth D searchmoves <m>`
  per other candidate move from the same root. Same accuracy as MultiPV 3 (p = 0.86), 1.7–3× cheaper.
- **Two-stage triage**: every candidate position is first searched at depth 10 (≈ 43 ms); only when a
  candidate move loses ≥ 2.5 win-% is it re-searched at the confirm depth (14 ≈ 350 ms). In the
  benchmark this dropped none of the reference mistakes.
- **Determinism**: `ucinewgame` + `isready` before each position, so results never depend on worker
  count or order (without it, 31/450 severity classes changed between two run orders).
- Pool size: `min(hardwareConcurrency − 1, 4)`, reduced to 2 on touch devices or `deviceMemory ≤ 4`
  and 1 on `deviceMemory ≤ 2` (each worker ≈ 60–70 MB). Hash fixed at 16 MB. Idle workers are
  terminated after 60 s (one is kept warm while training). Interactive (training) searches jump the
  queue.
- Robustness: 10 s init timeout (a wasm served with the wrong MIME type fails silently), per-search
  watchdog with one respawn + retry, `stop` → `bestmove` → `isready` sequencing, and an assertion that a
  `searchmoves` result's PV starts with the requested move (Stockfish silently searches *all* moves when
  given an invalid one such as king-takes-rook castling `e1h1`).

Presets: Quick (triage 8 → confirm 10), **Standard (10 → 14)**, Thorough (12 → 18).

Lichess cloud evaluations were considered and **not used**: local triage makes the common positions
cheap, the cloud DB rarely contains the actual bad move (91 % of flagged moves are outside its top-5
lines), and Lichess asks that the endpoint be used for "a few positions here and there".

## Aggregation (core/aggregate.ts)

Input: the profile's stored games, `openingPlies` (default 20). For each game, replay its UCI moves; at
each ply where the profile is to move record (posKey, move). Counting is by **distinct games**: only the
first visit of a position in a game counts, its move included (a repetition inside one game counts
once), so a move's game count never exceeds the position's.

Pass 1 counts `(posKey|move)` and `posKey` distinct-game totals only (low memory). Candidate positions
are those with at least one move seen in ≥ `ANALYSIS_MIN_GAMES` (2) games. Pass 2 builds details only for
candidate positions: FEN, ply, the path of the most recent visit, and every visit as an `Occurrence`
(`{g, t, s, r, o, m}`), newest first.

`weight(position)` = number of distinct games that reached it. Candidate moves to evaluate = **every**
move the profile ever played there (count ≥ 1), so "fixed in real games" and new deviations are known.

Position key = first four FEN fields from chessops `makeFen(pos.toSetup())`, which writes the en-passant
square only when a legal capture exists, so transpositions merge.

## Classification (core/classify.ts)

For each candidate position with its eval and each move `m` with count ≥ 2:

- `winPercent(cp) = 50 + 50 · (2 / (1 + e^(−0.00368208 · cp)) − 1)` with cp clamped to ±1000 (Lichess).
  Mate for the side to move = 100, mated = 0.
- `best` = the highest-scoring evaluated move (not blindly the MultiPV line, which a `searchmoves` result
  occasionally beats). `loss(m) = max(0, win(best) − win(m))`.
- Mate rule (Lichess `Advice.scala`): if best is a mate and `m` is not, severity is by the remaining cp —
  `> 999` inaccuracy, `> 700` mistake, else blunder.
- Severity: blunder ≥ 15, mistake ≥ 10, inaccuracy ≥ 5. Stored if loss ≥ 5. `confidence = 'low'` when
  `loss < 7.5` (measured: 33–43 % of lite-depth-14 flags in 5–7.5 are noise; 3 % in 7.5–10; 0 % ≥ 10).
- **Book awareness**: if the position *after* `m` is a named position in the lichess openings dataset
  and `loss < 10`, `kind = 'book'` ("dubious book choice": King's Gambit, Bird, Budapest…). Book items
  are hidden from the default list and from training; shown on the Openings page.
- `acceptable` = evaluated moves with loss < 5, never including the habit move.
- **Impact** = `Σ over games where m was played of 0.5^(ageDays / 180)` × `max(0, loss − 2.5)`.
  Recency-weighted, and the 2.5 offset (≈ 2× the measured mean eval error) stops borderline noise
  in very frequent early positions from dominating.
- **lastOutcome / fixedStreak** from the occurrences: most recent visit played the habit (`habit`), an
  acceptable move (`fixed`), or another evaluated non-acceptable move (`other-bad`).
- **dependsOn**: if another recorded mistake's (posKey, move) lies on this mistake's path, this position
  only arises after that error; the UI groups it under the parent and training schedules the parent first.
- Opening name: deepest named position along the path (lichess-org/chess-openings, 3,865 positions).

Re-analysis never deletes a mistake that has a review history; it is marked `dormant`. A reviewed
mistake is only dropped when its loss falls below 3 (hysteresis).

## View filters (core/filters.ts)

Analysis always uses all standard games with `ANALYSIS_MIN_GAMES = 2` and `ANALYSIS_MIN_LOSS = 5`.
Colour, time control, rated, date range, minimum games, severity, low-confidence, book, opening and text
filters are applied live to the stored occurrences: counts, `k of n` and impact are recomputed from the
filtered occurrences, so changing a filter is instant and never touches the engine or training data.

## Sync (services/sync.ts)

- **Lichess** — `GET /api/games/user/{u}` NDJSON, `perfType` = all standard speeds, `moves=true`,
  streamed. Each account keeps a contiguous covered interval `[oldestCreatedAt, newestCreatedAt]`.
  - Forward pass: `sort=dateAsc&since=newestCreatedAt − 3 days` (duplicates are skipped), so an
    interrupted run never leaves a gap. It is not capped by the run's game limit: it keeps paging while
    pages come back full (at most 50 requests), so after a long break every new game is stored.
  - Backfill pass: `sort=dateDesc&until=oldestCreatedAt − 1&max=remaining` until `gamesPerAccount` is
    reached or the stream ends (`reachedStart`), if the forward pass left some of the run's budget.
  - The cursor advances per stored chunk **in the same IndexedDB transaction** as the games.
  - Anonymous exports are throttled by Lichess to 20 games/s; the UI shows an ETA. A 45 s no-data
    watchdog aborts and resumes. HTTP 429 → 60 s cooldown shared across tabs (localStorage).
- **Chess.com** — `GET /pub/player/{u}/games/archives`, then monthly archives newest first, one request
  at a time, with `cache: 'no-cache'` (no hand-set conditional headers: they would trigger a CORS
  preflight). Months strictly before the previous UTC month that were fully consumed are marked done and
  never fetched again. Only `rules === 'chess'` and standard starts are kept.
- **PGN files** — streamed through `Blob.stream()`; a header scan lists the most frequent player names
  ("Which of these is you?"), saved as aliases; or "all games in this file are mine as White/Black".
- Duplicates: same `platform:sourceId` → same key; plus a cross-source `contentKey` check, so a PGN
  exported from Chess.com and the same games from the API are stored once.
- First run fetches the newest 300 games per account, analyses them, then backfills to
  `gamesPerAccount` (default 1,000) and re-analyses (cheap: evals are cached).

## Training (services/training.ts)

Session = due reviews first (oldest due first), then new cards by impact (max `newPerDay` new cards per
day), `sessionSize` cards (10). Parents (`dependsOn`) before children. Book and low-confidence items are
excluded by default. The counts the UI shows (`sessionCounts`: due reviews, new cards still allowed
today, their sum) come from one filter pass with the same rules, without building a session.

Card flow: replay the last `replayPlies` plies (skippable, disabled with `prefers-reduced-motion`), then
"Your move (you are Black)" with the opponent's last move highlighted and no arrows. Grading is
automatic (SM-2 style intervals):

| What happened | Grade |
| --- | --- |
| acceptable move, first try, no hint | good (easy if the previous interval was ≥ 3 days and also good) |
| acceptable after a hint or a second try | hard |
| a move losing 5–7.5 (low-confidence band) | hard ("playable, but X is more precise") |
| the habit move, or two wrong tries | again (relearn in 10 minutes) |

Unknown moves are evaluated live (interactive priority) with the same deterministic search and written
back to the eval cache and the mistake's acceptable list, so the same move always gets the same verdict.
After the habit move, the refutation line is played out with a one-line explanation (material lost).
Promotions use a picker (no auto-queen; e.g. the Lasker Trap's 7…fxg1=N+). Moves can also be typed in SAN.

## Scout (opponent preparation)

Separate section; scouted players never appear in the training queue. For each of their recurring
mistakes the app also evaluates the position *after* their habit move from your side and stores the
punishing reply (`refutation`). The Scout report shows their repertoire per colour (engine-free), their
leaks shown from your side ("they play 6…Nxe4?! in 7 of 9 games — punish with 7.Qe2"), and a prep drill.

## Storage (IndexedDB via Dexie, db `chess-analyzer`)

| Table | Primary key | Indexes |
| --- | --- | --- |
| profiles | id | kind |
| games | key | profileId, [profileId+playedAt], [profileId+contentKey] |
| syncState | key | profileId |
| evals | key (`engine|posKey`) | posKey, updatedAt |
| mistakes | id | profileId, shortId, [profileId+status] |
| reviews | mistakeId | profileId, due |
| attempts | ++id | mistakeId, profileId, at |
| meta | key | — (settings, jobs, flags) |

`navigator.storage.persist()` is requested after the first analysis; if storage is not persistent the
app shows backup reminders (Safari deletes site data after 7 days without a visit unless installed).

Backups (`db/backup.ts`) are JSON files of every table except the eval cache: the analysis trusts cached
evals, so a file must not be able to plant them, and they are cheap to recompute. Every nested field is
validated before anything is written (a damaged file changes nothing), and settings are clamped to what
the Settings page can produce. A restore replaces all profiles, games, progress and settings; this
browser's eval cache and its persistent-storage state stay. The bundled example is merged next to the
user's data instead.

## Concurrency between tabs

A Web Lock (`chess-analyzer:jobs`) ensures only one tab runs sync/analysis; other tabs show "running in
another tab" and refresh when a `BroadcastChannel` message says the job finished. A tab that is closed or
crashes mid-job never sends that message, but the browser releases its lock, so a waiting tab also
re-checks the lock every 5 s and whenever it becomes visible again. A Screen Wake Lock is
held during analysis; when the page becomes visible again an interrupted analysis resumes (cheap thanks
to the eval cache). PWA updates use a prompt and are never applied while a job is running.

## Build and deployment

The production build is a set of static files for GitHub Pages, which cannot send HTTP headers, so:

- `index.html` carries a **Content-Security-Policy** `<meta>` added at build time
  (`scripts/vite-plugins.ts`): scripts only from the site itself plus the inline theme script by its
  SHA-256 hash (computed from the final HTML, so it cannot go stale), workers and the service worker from
  the site, network requests only to the site, `lichess.org` and `api.chess.com`, images from the site and
  `data:` URIs, styles from the site (Preact and chessground set styles through the CSSOM, which the
  policy does not restrict) plus the `<noscript>` message's inline styles by hash, and no plugins,
  `<base>` or form submissions. It is build-only: Vite's dev server injects inline styles and scripts.
- `THIRD-PARTY-LICENSES.md` ships next to `index.html` with the licence text (and NOTICE file) of every
  package in the bundle and the service worker; the engine's GPL text ships as `engine/COPYING.txt`.
- `scripts/check-dist.mjs` runs after every `npm run build` and fails it when the CSP does not allow an
  inline script, a bundled package (read from the source maps) has no licence section, or the manifest's
  maskable icon is a regular icon.
- `.github/workflows/pages.yml` deploys only after CI (unit tests, build, e2e on the production build)
  has passed for the commit on `master`.

## Testing

- Unit tests (Vitest) for every core/source/engine/db/service module, with `fake-indexeddb`.
- A real-engine integration test runs the vendored WASM in Node.
- Playwright e2e runs the production build in Chromium with Lichess/Chess.com mocked from recorded
  fixtures and the real WASM engine, under the build's CSP: every test fails on a CSP violation.
- `live-smoke` GitHub Actions workflow runs the built app against the real APIs for real accounts
  (GitHub's runners can reach Lichess and Chess.com) and publishes a summary.
