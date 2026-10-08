# Third-party notices

Chess Analyzer's own source code is released under the MIT licence (see `LICENSE`).
The built web app bundles the components below. Because some of them are licensed under the
GNU GPL v3, **the distributed application as a whole is subject to GPL-3.0 terms**. MIT is
GPL-compatible, and the complete corresponding source is this repository (the published build also
ships source maps).

| Component | Licence | Use | Source |
| --- | --- | --- | --- |
| Stockfish 19 (lite NNUE incl. its embedded network, WASM build by stockfish.js) | GPL-3.0 | chess engine (`public/engine/`, licence text in `public/engine/COPYING.txt`) | https://github.com/official-stockfish/Stockfish, https://github.com/nmrugg/stockfish.js |
| @lichess-org/chessground | GPL-3.0-or-later | chessboard UI and board theme | https://github.com/lichess-org/chessground |
| cburnett piece set (in chessground's assets) | GPL-2.0-or-later | piece images | https://github.com/lichess-org/lila |
| chessops | GPL-3.0-or-later | move generation, FEN/SAN/PGN | https://github.com/niklasf/chessops |
| @badrap/result (chessops dependency) | MIT | result type | https://github.com/badrap/result |
| Preact, @preact/signals | MIT | UI framework and state | https://github.com/preactjs/preact, https://github.com/preactjs/signals |
| Dexie.js | Apache-2.0 | IndexedDB wrapper | https://github.com/dexie/Dexie.js |
| Workbox (via vite-plugin-pwa) | MIT | offline support, update prompt | https://github.com/GoogleChrome/workbox, https://github.com/vite-pwa/vite-plugin-pwa |
| lichess-org/chess-openings | CC0-1.0 | opening names (`data/openings/`, built into `data/openings.json`) | https://github.com/lichess-org/chess-openings |

The win-percentage model, the severity thresholds and the mate rule are reimplemented from the
formulas Lichess publishes (https://github.com/lichess-org/lila, AGPL-3.0); no lila source code is
included.

Development-only tools (Vite, TypeScript, Vitest, Playwright, fake-indexeddb) are not part of the
distributed app.

Game data is fetched at runtime from the public [Lichess API](https://lichess.org/api) and the
[Chess.com Published-Data API](https://www.chess.com/news/view/published-data-api). Neither
service is affiliated with this project.
