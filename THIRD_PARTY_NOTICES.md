# Third-party notices

Chess Analyzer's own source code is released under the MIT licence (see `LICENSE`).
The built web app bundles the components below. Because some of them are licensed under the
GNU GPL v3, **the distributed application as a whole is subject to GPL-3.0 terms**. MIT is
GPL-compatible, and the complete corresponding source is this repository.

| Component | Licence | Use | Source |
| --- | --- | --- | --- |
| Stockfish 19 (lite NNUE, WASM build by stockfish.js) | GPL-3.0 | chess engine (`public/engine/`) | https://github.com/official-stockfish/Stockfish, https://github.com/nmrugg/stockfish.js |
| @lichess-org/chessground | GPL-3.0-or-later | chessboard UI | https://github.com/lichess-org/chessground |
| chessops | GPL-3.0-or-later | move generation, FEN/SAN/PGN | https://github.com/niklasf/chessops |
| Preact, @preact/signals | MIT | UI framework | https://github.com/preactjs/preact |
| Dexie.js | Apache-2.0 | IndexedDB wrapper | https://github.com/dexie/Dexie.js |
| Workbox (via vite-plugin-pwa) | MIT | offline support | https://github.com/GoogleChrome/workbox |
| lichess-org/chess-openings | CC0-1.0 | opening names (`data/openings/`) | https://github.com/lichess-org/chess-openings |
| cburnett piece set (in chessground assets) | GPL-2.0-or-later | piece images | https://github.com/lichess-org/lila |

Game data is fetched at runtime from the public [Lichess API](https://lichess.org/api) and the
[Chess.com Published-Data API](https://www.chess.com/news/view/published-data-api). Neither
service is affiliated with this project.
