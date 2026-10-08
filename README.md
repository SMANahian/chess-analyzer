# Chess Analyzer

**Find the opening mistakes you keep repeating in your Lichess and Chess.com games, and drill them until the right move is automatic.**

### [Open the app →](https://smanahian.github.io/chess-analyzer/)

Free, open source, nothing to install. It runs entirely in your browser: your games are downloaded
straight from Lichess and Chess.com, analysed by Stockfish on your own device, and kept in your browser.

[![CI](https://github.com/SMANahian/chess-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/SMANahian/chess-analyzer/actions/workflows/ci.yml)
[![Deploy](https://github.com/SMANahian/chess-analyzer/actions/workflows/pages.yml/badge.svg)](https://github.com/SMANahian/chess-analyzer/actions/workflows/pages.yml)

## How it works

1. **Enter your username** (Lichess, Chess.com or both), or upload a PGN file. The app fetches your
   newest 300 games per account, then keeps going back to 1,000 (adjustable).
2. **Stockfish checks the positions you reach again and again**: every position from the first 10
   moves where you played the same move in at least two games, with every move you ever played there.
3. **Drill your leaks** with spaced repetition. A leak is a move you played in the same position in
   two or more games that gives away at least 5 % winning chances. You see each position again just
   before you would forget it, until you stop playing the bad move in real games.

## Features

- **Your real habits, ranked.** Leaks are counted by distinct games ("you played 6…Nxe4?! in 7 of 9
  games") and ranked by impact: how often you played the move, recent games weighted more, times how
  much it loses.
- **Honest verdicts.** A quick depth-10 search for every position, then depth 14 wherever a move
  seems to lose something. Borderline losses inside the engine's own noise are marked and hidden by
  default. Dubious-but-named book moves (King's Gambit, Budapest…) are listed separately instead of
  being called mistakes.
- **Live filters.** Colour, time control, rated only, date range, minimum games, severity and
  opening, applied instantly without re-running the engine.
- **Training.** The position is set up by replaying the last few moves of your own game. Grading is
  automatic. A move the app hasn't seen before is checked by Stockfish on the spot. After your
  habitual move, it plays out the refutation and explains what it loses. Promotions use a picker, and
  moves can also be typed in SAN.
- **Openings overview.** Your repertoire by colour, with your score in each line.
- **Scout an opponent.** Their recurring mistakes, shown from your side with the punishing reply, plus
  a prep drill. Scouted players never enter your own training queue.
- **Bring your own games.** Import a PGN file of any size (over-the-board games, other sites); the app
  asks which player in the file is you.
- **Your data, portable.** Back up and restore everything as a JSON file. Export your leaks as PGN
  (opens in a Lichess study or Chessable).
- **Installable and offline-capable** (PWA). Light and dark themes. Shareable links such as
  `https://smanahian.github.io/chess-analyzer/#/?lichess=NAME&chesscom=NAME` start an analysis
  directly.

## Privacy

Your games, mistakes and progress are stored only in your browser. The app requests your public games
from Lichess and Chess.com. No accounts, no analytics.

The usernames you enter (yours and any player you scout) are sent to Lichess and Chess.com, because
that is how the public games are requested. The app is a set of static files on GitHub Pages,
which, like any web host, sees your IP address. Nothing else leaves your device.

## FAQ

**Why is my opening flagged?**
A move is flagged when you played it in the same position in at least two games and Stockfish finds a
move that keeps at least 5 percentage points more winning chances. "7 of 9" means you reached the
position in 9 games and chose this move in 7 of them. If the move leads to a named opening position
and costs less than 10 points (many gambits do), it is labelled a dubious book choice instead of a
leak, and it stays out of your leak list and training. Anything you play on purpose can be marked
"This is my repertoire" and won't be flagged again.

**What is win %?**
Engines score positions in pawns, but a pawn matters far more in a level position than in a won one.
Like Lichess, the app converts the score into a winning chance,
`50 + 50 · (2 / (1 + e^(−0.00368208 · centipawns)) − 1)`, and measures how many percentage points a
move gives away. Inaccuracy: 5+ points, mistake: 10+, blunder: 15+. From an equal position, 10 points is
roughly one pawn. Losses between 5 and 7.5 points are within the engine's noise at this depth, so
they are marked *borderline* and hidden unless you turn them on.

**Why is it slow on my phone?**
Stockfish runs on your device. Phones have fewer fast cores and less memory, so the app uses at most
two engines there (up to four on a desktop), and a first analysis can take several minutes. Keep the
tab open; the app asks the screen to stay on. Everything found so far is saved, and an interrupted
analysis resumes where it stopped. Results are cached, so later syncs only check new positions. The
Quick preset in Settings is faster.

**Where is my data? How do I back it up?**
In your browser's storage (IndexedDB) for this site, on this device only. **Settings → Your data →
Download backup** saves everything to a file; **Restore backup** loads it in any browser. Clearing the site data, or Settings → Delete
all data, removes everything. Safari deletes the data of sites you haven't visited for 7 days unless
you add the app to your Home Screen. The app asks the browser for persistent storage after the first
analysis and reminds you to back up when it doesn't get it.

## Engine

The app uses **Stockfish 19 lite NNUE, compiled to single-threaded WebAssembly (1.8 MB)**, in a pool of
Web Workers. The choice and settings come from a benchmark on 150 opening positions and 450 moves
against a native Stockfish depth-22 reference. The full report is in [docs/ENGINE.md](docs/ENGINE.md).

- **Small and as accurate:** 1.8 MB, against 99 MB for the full NNUE build. Both classify mistakes
  equally well, and the lite build is **1.7× faster** per position.
- **~90 % agreement** with the depth-22 reference on mistake severity at depth 14 (89.6 %). The
  reference agrees with itself at depth 18 only 92.2 % of the time, so this is close to the ceiling.
- **Parallel without special headers:** multi-threaded WASM needs `SharedArrayBuffer` (COOP/COEP
  headers), which GitHub Pages cannot send. Positions are independent, so a pool of single-threaded
  engines scales instead: **3.86× with 4 engines on 4 cores**.
- One search for the best move plus one `searchmoves` search per move you played. This is as accurate
  as MultiPV 3 and 1.7–3× cheaper. A depth-10 triage pass decides which positions get the depth-14
  confirmation.

## Development

Requires Node.js 22.12 or newer.

```sh
git clone https://github.com/SMANahian/chess-analyzer.git
cd chess-analyzer
npm install            # also builds public/data/openings.json from data/openings/
npm run dev            # dev server at http://localhost:5173
npm test               # unit tests (Vitest), including the real engine running in Node
npm run typecheck
npm run build          # static site in dist/, checked by scripts/check-dist.mjs
```

End-to-end tests run the production build in Chromium with the real engine. Lichess and Chess.com
are mocked from `e2e/fixtures/`.

```sh
npx playwright install chromium   # once
npm run test:e2e
```

The engine benchmark has its own, separate install, because the `stockfish` npm package it uses is
about 160 MB. The depth-22 reference step also needs a native Stockfish (`$STOCKFISH` or
`/usr/games/stockfish`):

```sh
npm --prefix scripts/bench install
npm run bench -- all   # see docs/ENGINE.md for the individual steps
```

Other scripts: `npm run icons` re-renders the PNG app icons from `public/icon.svg`, and
`node scripts/update-engine.mjs <version>` updates the vendored engine in `public/engine/`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for code layout and conventions.

## Deployment

`.github/workflows/pages.yml` builds the app and deploys `dist/` to GitHub Pages after each push to
`master` once CI (unit tests, build and end-to-end tests) has passed for that commit, or when run by
hand, so a commit that fails CI is never published. The repository owner has to do **one-time
setup**: go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. After each
deployment, the workflow checks that the live site serves `index.html` and that the engine's `.wasm`
file has the content type `application/wasm`. Browsers refuse to run the engine with any other type,
and they fail silently when that happens.

The build uses relative URLs, so `dist/` also works from any other static host or sub-path. Because
GitHub Pages cannot send HTTP headers, `index.html` carries the Content-Security-Policy as a `<meta>`
tag (generated at build time, with the hash of its inline script): scripts only from the site itself,
network requests only to the site, Lichess and the Chess.com API.

## Live smoke test

CI never talks to the real sites. The **Live smoke** workflow does: it runs the built app in Chromium
against the real Lichess and Chess.com APIs. It runs weekly, on changes to the sync code, and on demand.

To run it for your accounts: **Actions → Live smoke → Run workflow**, then enter a Lichess username, a
Chess.com username (leave one empty to skip that site) and the number of games per account (default
300).

The test does two things:

1. From the app's own page, it requests every endpoint the sync uses and records the status, the CORS
   header and whether the response parses.
2. It enters the usernames in the onboarding form, waits for the download and the analysis, and
   reports games per platform, mistakes by severity, the top 10 leaks, timings and the engine pool
   size.

The summary appears on the run's page and is attached as `live-summary.json`. The test fails only on
errors: CORS or network failures, an unknown account, a crash, or an analysis that doesn't finish. An
account with few games is not an error.

Locally (needs network access to both sites):

```sh
npm run build
LIVE_LICHESS_USER=YourName LIVE_CHESSCOM_USER=YourName LIVE_GAMES=300 npm run test:live
```

`LIVE_MOCK=1 npm run test:live` rehearses the same test offline against recorded fixtures.

## Project structure

```text
src/
  core/       pure chess and domain logic: replay, aggregation, classification, win %, filters, SRS, PGN
  sources/    Lichess and Chess.com API clients, PGN file reader
  engine/     UCI parsing, Stockfish worker wrapper, engine pool
  db/         IndexedDB schema (Dexie), repository, backup/restore
  services/   sync, analysis scheduler, analysis, training, cross-tab jobs
  state/      app state (Preact signals) and actions; the only API the UI uses
  ui/         Preact pages and components
public/
  engine/     vendored Stockfish 19 lite WASM (GPL-3.0)
  icon*.svg/png
data/openings/  lichess-org/chess-openings TSVs (CC0); built into public/data/openings.json
scripts/      openings build, build plugins (CSP, licences) and dist check, engine update, icons, benchmark
e2e/          Playwright tests with mocked APIs; e2e/live/ is the live smoke test
docs/         ARCHITECTURE.md, CONTRACTS.md, ENGINE.md, legacy-v2-profile.md
```

The algorithms and design decisions are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
and the module signatures in [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Credits and licences

- The source code of this repository is released under the **MIT licence** ([LICENSE](LICENSE)).
- The app as distributed bundles GPL-licensed components: Stockfish (GPL-3.0), chessops and
  chessground (GPL-3.0-or-later). The **distributed app is therefore subject to GPL-3.0**. MIT is
  GPL-compatible, and this repository is the complete corresponding source.
- Opening names come from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
  (**CC0**).
- Full list of components and licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The
  published app ships the licence texts of everything it bundles in `THIRD-PARTY-LICENSES.md`
  (next to `index.html`, generated at build time).

Thanks to the Stockfish developers, [stockfish.js](https://github.com/nmrugg/stockfish.js), and the
Lichess team for chessops, chessground, the openings dataset, the win-% model and an open API.

Chess Analyzer is an independent project. It is **not affiliated with, endorsed by or sponsored by
Lichess or Chess.com**. It only uses their public APIs.

## Legacy v2 (Python)

Versions up to 2.1.0 were a local Python/FastAPI app with a native Stockfish. Version 3 replaces it
completely; the reasons, with measurements, are in
[docs/legacy-v2-profile.md](docs/legacy-v2-profile.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
The last v2 code is in the git history at commit
[`0511590`](https://github.com/SMANahian/chess-analyzer/tree/05115905d758c5d9d6bac6061089e115313d9fd5),
the `master` branch before the v3 rewrite. Version 3 can import v2 backup files (**Settings → Your data
→ Restore backup**).
