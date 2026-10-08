# Profile of the legacy v2 app

Measurements of the Python/FastAPI app (v2.1) taken before the v3 rewrite, on a 4-vCPU Linux VM with
native Stockfish 16 and synthetic but realistic game histories (a fixed repertoire with planted
habitual deviations). Network calls were mocked. These numbers motivated the v3 design; see
`ARCHITECTURE.md`.

## 0. Environment

Python 3.13, python-chess 1.11, FastAPI 0.142, native Stockfish 16 (Debian generic build), 4 vCPUs. Some runs overlapped with other benchmarks; timings that ran under contention are labelled.

## 1. Synthetic data (gen_games.py)

Command: `python -I gen_games.py --data <scratchpad>/data --out games [--count 3000] [--seed 20261008]`. It produced 3000 games: games/games.pgn (1.73 MB), games/games.ndjson (1.77 MB) and games/manifest.json. A second run with a different PYTHONHASHSEED gave byte-identical files. SHA-256: games.pgn 6cbc1ae05a339bf437f06fe628e7f6c2e682b43b32d024e2023d9279c25a6f6a, games.ndjson d6dc907c26eb793a34c2276f86c4af03a28564b7f7a3757125dd78500c6a3ffd. Validation: all 3000 PGN games parse with 0 errors, the 3000 ids are unique, NDJSON moves, players and results match the PGN, and createdAt is sorted newest first. Game length 4-46 plies (mean 39.9). In the first 16 plies, white (1529 games) has 4871 distinct hero (position, move) pairs, 638 seen at least twice and 166 at least 5 times. Black (1471 games) has 5815 distinct pairs, 723 at least twice and 204 at least 5 times.

How the games are built:
- Opening book: all lines of the 5 TSVs, merged into a trie keyed by EPD so transpositions merge; each move is weighted by (#lines)^0.8.
- Repertoire, 4 TSV lines per colour. White: C54 Giuoco Pianissimo, B22 Alapin Barmen, C02 French Advance Paulsen, B12 Caro-Kann Advance Short. Black: B90 Najdorf English Attack, E94 King's Indian Orthodox, A48 London with Be2, A15 English King's Indian formation.
- 70% of games are repertoire games. Hero plays its line move with probability 0.92 and the opponent follows a line with probability 0.75. Off the line, hero repeats a habitual move with probability 0.8. The other 30% are 'experiment' games played from weighted book moves.
- After the book, both sides play random legal moves (captures preferred 35% of the time) up to 34-46 plies.
- 5 habitual deviations are planted per colour and recorded in the manifest with times reached and times played. Half hang material (e.g. 4.Qg4, played 67 of 129 times the position was reached); half are off-book moves.
- 600 opponents with Zipf-like recurrence. Results follow Elo expectation against a fixed hero strength of 1500; hero's rating ranged 1387-1595. Speeds: blitz 1847, rapid 726, bullet 427. Games run from 2025-07-26 to 2026-09-30, newest first, like a sort=dateDesc export.
- PGN headers: Event, Site https://lichess.org/<8-char id>, Date, White, Black, Result, UTCDate, UTCTime, WhiteElo, BlackElo, WhiteRatingDiff, BlackRatingDiff, Variant, TimeControl, Termination.
- NDJSON fields: id, rated, variant 'standard', speed, perf, createdAt, lastMoveAt, status, players.{white,black}.{user.{name,id}, rating, ratingDiff}, winner (omitted on draws, as Lichess does), moves (SAN), plus source 'pool' and clock.
- games5100/ is the same generator run with --count 5100; it was used for the 5000-game tests.

## 2. Sync merge path: 3000 games, batches of 100 (prof_sync.py)

Total wall time over 3 idle-machine runs: 44.12 / 45.09 / 46.01 s for 30 batches. Per-batch wall time (median of 3, range in brackets):
- batch 1: 224 ms [198-243]
- batch 2: 332 ms
- batch 5: 589 ms
- batch 10: 1071 ms [984-1156]
- batch 20: 1805 ms
- batch 30: 2647 ms [2400-2724]

Where the time goes:
- Re-parsing the whole merged blob each batch costs 88 ms at batch 1, 929 ms at batch 10 and 2488 ms at batch 30; summed over the run it is 39.9-41.6 s, about 90% of the total.
- Parsing only the new 100 games is roughly constant at 130-146 ms per batch (4.1-4.3 s total).
- All SQLite in the loop is 0.13-0.19 s total. upsert_pgn rewrites the blob at 1.0-2.7 ms per batch.

The run did 49,500 python-chess game parses for 3000 games (16.5 times the minimum). Parsing all 3000 games once takes 3.48-4.38 s. The final stored blob is 264,952 bytes (about 88 B per game).

Method: fetcher._sync_task runs for a lichess/white config. iter_lichess_pgn_batches is replaced by a generator that yields the real iterator's dict shape, with pgn_text built (untimed) by the real _parse_lichess_games. engine_status is patched to (False, '') so no analysis runs. Per-batch time is measured between the generator's yield and its resume, and every parse_and_truncate and db.* call is timed.

Model fitted to these measurements (not itself a measurement): about 1.3 ms per new raw game, plus about 0.83 ms per already-stored game for every batch.

The SHA-256 fingerprint is not part of this cost: hashing the final blob takes 0.14-0.18 ms, and fingerprint_pgn is never called on this path when the engine is off and no checkpoint exists.

Not included: the real iterator also runs _parse_lichess_games on every page. Measured separately on 3000 games it takes 4.5-5.3 s (1.5-1.8 ms per game, linear; results/parse_lichess_games.txt). Network time is also excluded.

All 3000 games were fed through one config. That is valid because Lichess filters by colour on the server and the merge code never inspects colour.

## 2b. Sync at 5000 games (MAX_GAMES default)

Clean run (load 1.5-2.0): 114.55 s wall, 114.39 s CPU. A contended run took 118.66 s. Per-batch wall time, batch 1 / 10 / 25 / 30 / 40 / 50: 194 / 1060 / 2022 / 2786 / 3810 / 4391 ms. The run did 132,500 game parses. Re-parsing the merged blob accounts for 107.6 s (94%). Parsing all 5000 games once takes 6.70 s.

## 2c. Incremental re-sync beyond MAX_GAMES drops new games

After the 5000-game sync, feeding the 100 newest games as an incremental sync took 4.83 s (3.88 s in a second run) and did 5,100 game parses. The stored PGN was byte-identical afterwards (content_unchanged: true) and game_count stayed at 5000. synced_game_ids went from 5000 to 5100.

This is data loss. Lichess returns games newest first, so the blob is stored newest to oldest. An incremental sync appends the newer games at the end, and parse_and_truncate keeps only the first MAX_GAMES = 5000, so the new games are discarded. Because they are still recorded as synced, a normal sync never fetches them again.

## 3. Analysis: 1000 white games, depth 6, MultiPV 2, 20-game batches, cap 60, Threads 2 (prof_analysis.py, instrumented)

Wall time over 3 runs at load 1.6-1.8: 4.93 / 5.15 / 5.37 s. Main process CPU 3.60-3.65 s; Stockfish child CPU 2.01-2.18 s.

Positions evaluated: 554, 554 and 560 engine searches. Each run did 335 MultiPV-2 root searches plus 219-225 single searches of the position after the move, about 1.05-1.11 M nodes and about 2.6 ms of wall time per search.

Time breakdown (median of 3):
- engine analyse(): 1.457 s (28.3%); Stockfish itself reports 1.387 s of search time
- engine start and quit: 0.404 s (7.8%)
- SQLite: 0.985 s (19.1%)
- chess.pgn.read_game: 0.644 s (12.5%)
- _collect_pairs_from_game (board replay, position keys, per-ply ECO lookup): 1.307 s (25.4%)
- other Python: 0.343 s (6.7%)

So python-chess parsing plus board work is 38% of the time, more than the engine search (28%).

Wall times and breakdowns are in results/ana_white_r{1,2,3}.json.

real_analysis_cost: read_game is called 2,002 times for 1000 games, because the whole blob is parsed twice (once in count_supported_games, then again for batching).

SQLite: 8,363-8,511 db.* calls per job, about 3.9 per _refresh_pair_state call. Every call commits (8,441 commits). The cost is mostly writes. Run 2:
- upsert_eval_cache: 554 calls, 351 ms (0.63 ms each)
- upsert_mistake_record: 393 calls, 184 ms
- apply_pair_batch: 50 calls, 92 ms
- get_eval_cache: 3,199 calls, 71 ms (0.022 ms each)
- remove_active_mistake: 1,771 calls, 48 ms (a DELETE for every non-mistake)
- run_cancel_requested: 2,214 calls, 35 ms

Under heavy contention (load about 4, results/ana_white_contended.json) SQLite took 4.63 s of a 9.57 s job, at 3.1-3.4 ms per write.

Redundant work: 2,164 _refresh_pair_state calls cover only 407 distinct pairs, so 1,757 calls (81%) re-refresh pairs that were already evaluated. They are served from the cache but each still costs several DB round trips.

Black, 1000 games (results/ana_black_r1.json): 5.77 s, 691 searches.

## 3b. Analysis cProfile breakdown

Under cProfile the job took 11.8 s wall (5 s without it). Self time by category: python-chess board code 59%, C builtins 10%, sqlite3 8%, waiting on the engine pipe (epoll) 8%, python-chess UCI protocol 3%, python-chess PGN 3%.

Call counts:
- Board.board_fen: 34,589 (4.1 s cumulative)
- opening.get_opening: 15,986, i.e. every ply including opponent plies, each building a full position-key string (2.3 s cumulative)
- Board.piece_at: 2.2 million
- Board.push: 62,690
- read_game: 2,002
- sqlite3 commit: 8,441 (0.73 s)
- SimpleEngine.analyse: 559
- UCI info lines parsed: 5,917 (0.87 s cumulative)

In Python 3.13, cProfile also records the engine's asyncio I/O thread. Profiler overhead inflates the many tiny python-chess calls, so the low-overhead instrumented breakdown in 3 is the primary one, and cProfile is mainly useful for call counts.

## 3c. Recurring pairs never evaluated because of ANALYSIS_BATCH_POSITION_LIMIT=60

| Run | Recurring pairs | Never evaluated | Batches over the cap | Mistakes found |
|---|---|---|---|---|
| White, 1000 games (×3) | 409 | 2, all with count 2 | 1 / 50 | 137 / 142 / 133 |
| Black, 1000 games | 526 | 13, all with count 2 | 4 / 50 | 124 |
| White, all 2568 white games of the 5100-game set | 1095 | 86 = 7.9% (85 with count 2, 1 with count 3-4) | 25 / 129 | 358 |
| White, 2568 games, cap removed (limit 0) | 1095 | 0 | – | 403 |

At 2568 games, removing the cap found 45 more mistakes (+12.6%) and took 13.13 s instead of 12.39 s. At 1000 white games the uncapped run found 131 mistakes, which is within the run-to-run noise.

The number of eligible pairs per batch grows with history: from 13 in batch 1 to 26-62 later at 1000 games, and up to 74 at 2568 games. So the cap barely matters for a young history but drops a growing share of the low-count recurring pairs as history grows.

Minor effects:
- Mistakes with a stale pair_count: 0-1 per run. Duplicate mistake rows: 0-1 per run.
- 476 of 3,366 pair keys carry an en-passant square with no legal en-passant capture. Normalising the keys merges only 2 pairs, and the recurring count is unchanged, so this is negligible on this synthetic data.

Opponent path (analyze(), ANALYSIS_MAX_CANDIDATES=250), counted with the app's _collect_pairs and no engine (results/opponent_cap.txt):
- The default opponent sync of 500 games gives 250 per colour and 109/111 recurring pairs, so the cap is not hit.
- 1000 games per colour: 407/496 recurring, 157/246 silently skipped.
- 2500 games per colour: 1070/1245 recurring, 820/995 skipped.

## 3d. Quality of the depth-6 verdicts (prof_quality.py, prof_quality_consistent.py)

Compared against a reference search (SF16, Threads 1, Hash 64, fresh hash per search, depth 18; best move and user's move both scored from the same root with searchmoves; mistake = more than 50 cp loss), over the 407 evaluated recurring pairs of white run 1:
- The old app flagged 137; the reference finds 109 mistakes.
- TP 100, FP 37, FN 9, TN 261: precision 73.0%, recall 91.7%.
- The 37 false alarms cover 641 game occurrences; the 9 missed mistakes cover 43.

4 of the old top-5 'mistakes' by frequency are false alarms:
- 3.Bc4 (219 times): old 106 cp loss; the reference rates it the best move (0 cp)
- 5.d3 (166): old 66 cp; reference best move
- 6.Nbd2 (83): old 72 cp; reference −2 cp
- 6.Qe2 (69): old 91 cp; reference 22 cp

Re-running the exact old procedure with a fresh engine flips 61 of 407 verdicts (15%).

A consistent same-root search at shallow depth, against the same reference:
- depth 6: precision 58.8%, recall 89.0%
- depth 10: precision 87.0%, recall 91.7%
- depth 12: precision 86.6%, recall 94.5%

Depth 18 is not ground truth, but it is much more reliable than depth 6. The main problem is the shallow depth itself; the old 'within 35 cp of a MultiPV top move' filter partly hides it. All 4 genuine planted white blunders (reference losses of 183-755 cp, e.g. 4.Qg4 and 6.Ba6) were flagged; the fifth planted deviation (6.Qe2, 22 cp) is one of the false alarms. The reference run took 246 s on 2 workers.

## 3e. Analysis cost versus depth, old pipeline, native Stockfish, Threads 2

Same 1000 white games, with the analysis_depth setting changed:
- depth 6: about 5.2 s wall, engine 1.46 s, 2.6 ms per search
- depth 10: 16.46 s wall, engine 12.75 s, 24 ms per search, 526 searches, Stockfish CPU 24.3 s
- depth 12: 36.40 s wall, engine 32.59 s, 62 ms per search, 529 searches, Stockfish CPU 63.9 s

From depth 10 upwards the engine dominates. At the default depth 6 it does not. These runs were at load 1.7-1.9, with the other agent running a single engine.

## 4. /api/status cost (TestClient, 20 sequential calls per scenario, 3 runs, load about 1.9)

| Scenario | First call | Median per call | engine_status() | Spawn attempts |
|---|---|---|---|---|
| STOCKFISH_PATH=/nonexistent, empty DB | 37-45 ms (DB init) | 4.27 / 4.34 / 5.91 ms | 0.97-1.19 ms | 20 / 20 calls (failure never cached) |
| /nonexistent, contended run | – | 2.95 ms | 0.57 ms | 20 / 20 |
| Real engine | 416-534 ms (spawn, UCI handshake, quit) | 3.30-3.44 ms | 0.003 ms (cached) | 1 / 20 |
| /nonexistent, DB holding the 3000-game white blob | 17-19 ms | 4.55-4.93 ms | about 1 ms | 20 / 20 |
| STOCKFISH_PATH=/bin/cat (exists but is not a UCI engine), 3 calls | 10,279 ms | 10,020 ms | 10,015 ms | 3 / 3 |

With the blob, get_pgn loads the full 264,952-byte blob on every poll.

On a real uvicorn server, /health takes 1.4 ms on its own. Sent 0.5 s into a /bin/cat status call, it took 9,541 ms. Sent 0.5 s into the first real-engine probe (531 ms), it took 30.6 ms.

When the binary is simply missing, the uncached failure costs only about 1 ms per poll, so it is not a performance problem in that case. When the path exists but is not a working engine, python-chess waits out its 10 s initialisation timeout. That TimeoutError is an OSError, so start_engine catches it and nothing is cached. Because the handler is async def and calls the blocking probe directly, the whole event loop is blocked. With a working engine, the successful probe is cached for 300 s, so every 5 minutes one poll costs about 0.4-0.5 s.

From the code (not measured): app.js runs refreshAll every 10 s always (line 69), every 2 s during sync (lines 665-688) and every 3 s during analysis (lines 727-743). Each refreshAll calls /api/status and /api/sync. Browser re-render cost was not measured.

## 5a. Chess.com is fetched twice, and incremental sync re-downloads everything (prof_chesscom.py, mocked requests)

Setup: 3000 games served as 15 monthly archives. Each colour config makes 16 requests and downloads 2,337,798 bytes, for a total of 32 requests and 4.68 MB covering 16 distinct URLs (2.34 MB). A second sync with nothing new still makes 16 requests per colour. The whole two-config test (both initial syncs plus both no-op re-syncs) took 38 s wall under contention.

Every game in every archive is also parsed with read_game once per colour, just to filter by colour. The early exit (`month_all_known and known_ids`) can never fire: every month contains games of the other colour, whose ids are never 'known' to this colour's config. So every incremental Chess.com sync re-downloads the full archive history, twice.

## 5b. Sync-linked analysis ignores the analysis_depth setting

With analysis_depth=12 stored, the streaming analysis during a sync made 39 engine searches, all at depth 6.

_CURRENT_JOB_DEPTH is a module global that only _run_analysis_job sets. The streaming path therefore uses whatever the last full job set, or the default 6 in a fresh process. A related point, read from the code but not measured: the eval cache has no depth column. A full re-analysis wipes the cache (clear_analysis_workspace), but resumed and sync-linked runs reuse cached evaluations from any depth, so one result set can mix depths.

## 6. Could not be measured

Not measured: real Lichess or Chess.com network latency, page sizes and rate limits (the hosts are blocked; every network path was mocked); install friction; browser and UI re-render cost; the unused tailwind.js; real-player data distributions; fsync latency on users' machines.

The data is synthetic. Real games contain more transpositions, so the phantom en-passant effect may be larger than the 2 merged pairs measured here. Per-commit cost varied from 0.47-0.63 ms at load about 1.7 to 3.1-3.4 ms under heavy contention. The REPORT.md file was not written because subagent policy blocks report .md files; this structured output is the report.

## 7. Implications for v3 (derived from the measurements)

1. Store games per record and parse each game once. That removes 90-94% of sync CPU (about 40 of 45 s at 3000 games, about 108 of 115 s at 5000) and fixes the bug that drops new games.
2. Use a consistent same-root search at depth 10 or more. Depth 6 gives 73% precision with 15% verdict flips; depth 10-12 gives about 87% precision and 92-95% recall. Native 2-thread cost is 24 / 62 ms per search, so budget engine time accordingly.
3. Batch database writes and skip pairs that are already evaluated: 81% of refresh calls were redundant, and each write cost 0.5-3.4 ms.
4. Look up opening names once per unique position, not once per ply (15,986 lookups per 1000 games), and never parse the game set twice.
5. Evaluate every recurring pair, ranked by impact; the current caps drop 7.9% of recurring pairs at 2568 games, and the opponent cap drops most pairs beyond 1000 games.
6. Never probe the engine inside a request path; cache failures too.
7. Use one account record for both colours, with incremental fetching that does not depend on per-colour known ids.

The synthetic generator's NDJSON output is reused as the v3 end-to-end test fixture (`e2e/fixtures/`).
