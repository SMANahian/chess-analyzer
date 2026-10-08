# Contributing

Thanks for helping. Bug reports with **Settings → Copy diagnostics** attached are the most useful
kind. The diagnostics contain your settings and the app's state, but no games.

## Setup

Requires Node.js 22.12 or newer.

```sh
npm install        # also builds public/data/openings.json
npm run dev        # http://localhost:5173
```

## Checks

CI (`.github/workflows/ci.yml`) runs these on every push and pull request. Run them before you open
one:

```sh
npm run typecheck
npm test                          # Vitest
npm run build                     # also type-checks, then checks dist/ (scripts/check-dist.mjs)
npx playwright install chromium   # once
npm run test:e2e                  # Playwright against the production build
```

- **Unit tests** sit next to the code as `src/**/<name>.test.ts` (Vitest). Database code runs on
  `fake-indexeddb`. The engine tests run the vendored WASM in Node through
  `src/engine/nodeWorker.ts`. Test behaviour and edge cases, not implementation details.
- **End-to-end tests** live in `e2e/`. They run the production build in Chromium with the real engine,
  and Lichess and Chess.com are mocked from `e2e/fixtures/`. No test in CI may reach the real sites.
  Every test also fails on an uncaught page error or a Content-Security-Policy violation.
- **Live smoke test** (`e2e/live/`, `playwright.live.config.ts`, `npm run test:live`): the app against
  the real APIs. It runs in GitHub Actions (weekly, on sync changes, or on demand) and never in CI.
  `LIVE_MOCK=1` rehearses it offline.

## Code layout

Dependencies point one way: `core` ← `sources` / `engine` / `db` ← `services` ← `state` ← `ui`.

| Directory | Contents | Rules |
| --- | --- | --- |
| `src/core/` | chess helpers, aggregation, classification, win %, filters, SRS, PGN | pure: no DOM, IndexedDB, `fetch`, timers or `Date.now()`. Take `now` as a parameter |
| `src/sources/` | Lichess, Chess.com and PGN file readers | network functions take `fetchImpl?: typeof fetch` for tests |
| `src/engine/` | UCI parser, Stockfish worker wrapper, engine pool | |
| `src/db/` | Dexie schema, repository, backup/restore | |
| `src/services/` | sync, scheduler, analysis, training, cross-tab jobs | |
| `src/state/store.ts` | signals and actions | the only module the UI calls besides pure `core` helpers |
| `src/ui/` | Preact pages and components | |

`src/core/types.ts` holds the shared types, and [docs/CONTRACTS.md](docs/CONTRACTS.md) an overview of
the module signatures (the code is authoritative). If you change a signature, update that file and
every consumer. The algorithms are explained in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Conventions

- **Standard UCI everywhere** (`e1g1`, `e7e8q`). Internally, chessops encodes castling as king takes
  rook (`e1h1`). It also treats *any* king move onto an own piece as castling, so
  `pos.isLegal(parseUci('e1e2'))` is true whenever O-O is legal. Always convert with
  `parseStandardUci` / `toStandardUci` from `src/core/chess.ts`, and never trust raw `isLegal` on
  external input.
- **Use deep chessops imports** (`chessops/chess`, `/fen`, `/san`, `/util`, `/compat`, `/types`). The
  root barrel lacks several functions.
- **Position key** = `makeFen(pos.toSetup(), { epd: true })`. It includes the en-passant square only
  when a legal capture exists, so transpositions merge.
- **Scores** are from the point of view of the side to move at the analysed root. The UI shows them
  from the user's side.
- **Cancellation:** long operations accept an `AbortSignal` and reject with a `DOMException` named
  `AbortError`.
- **Cross-origin requests:** never set conditional headers (`If-None-Match`, …) on cross-origin
  requests. They trigger CORS preflights, which the APIs do not answer.
- **Stockfish:** never send `go` before the previous `bestmove`. Check that a `searchmoves` result's PV
  starts with the requested move: Stockfish silently searches *all* moves when given an invalid one.
  Bump the suffix of `ENGINE_ID` in `src/engine/engine.ts` whenever evaluations change meaning, which
  invalidates cached evals.
- **IndexedDB:** `bulkPut` is not atomic outside a transaction, so wrap multi-row writes in
  `db.transaction('rw', …)`. Booleans are not valid index keys. Change the schema by adding a new
  Dexie `version()` with an upgrade, never by editing a released one.
- **TypeScript** is strict. Avoid `any`; where it is unavoidable, add a comment explaining why. Prefer
  small, focused functions, and write comments for the non-obvious reasons only.
- **Board UI:** `@lichess-org/chessground` 10.x (the unscoped `chessground` package is deprecated).
- **Content-Security-Policy:** the build adds a CSP `<meta>` to `index.html` (`scripts/vite-plugins.ts`).
  Inline `<script>`s in `index.html` are allowed by a hash computed at build time, so edit them freely;
  inline event handlers (`onclick=…`) and `javascript:` URLs in it fail the build. The app may only fetch from
  its own origin, `https://lichess.org` and `https://api.chess.com`: a new host needs `connectSrc` in
  `vite.config.ts`. Set styles through the CSSOM (`el.style.x`, Preact's `style` prop), not with
  `setAttribute('style', …)` or `innerHTML` markup that carries `style` attributes.

## Maintenance tasks

- **Engine update:** `node scripts/update-engine.mjs <version>`, then update the checksums in
  `public/engine/README.md` and `ENGINE_FILE` in `src/engine/engine.ts` if the file name changed.
- **Opening names:** edit the TSVs in `data/openings/` (from lichess-org/chess-openings, CC0).
  `public/data/openings.json` is generated at install and build time.
- **Icons:** edit `public/icon.svg`, then run `npm run icons`, which renders the PNGs with
  Playwright's Chromium.
- **Workflows:** job-level `env:` may only use the `github`, `inputs`, `vars`, `secrets`, `needs`,
  `strategy` and `matrix` contexts. Anything else (`runner.temp`, `steps.*`) makes GitHub reject the
  whole file. Pages deploys only from `master`, and only after the CI workflow (whose name, `CI`,
  `pages.yml` refers to) has passed for that commit.

## Licence

Contributions are accepted under the MIT licence of this repository. The app as distributed also
bundles GPL-3.0 components (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)), so do not add
dependencies whose licence is incompatible with GPL-3.0. The build ships the licence texts of every
bundled package in `THIRD-PARTY-LICENSES.md` automatically (and fails if one is missing); when you add a
runtime dependency, also add a row to `THIRD_PARTY_NOTICES.md`.
