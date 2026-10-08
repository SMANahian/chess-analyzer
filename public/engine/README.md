# Bundled chess engine

These files are **Stockfish 19 (lite NNUE, single-threaded) compiled to WebAssembly** by
[stockfish.js](https://github.com/nmrugg/stockfish.js) (npm package `stockfish@19.0.0`).

| File | SHA-256 |
| --- | --- |
| `stockfish-19-lite-single.js` | `d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6` |
| `stockfish-19-lite-single.wasm` | `57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387` |

They are vendored (1.8 MB) instead of installed from npm because the npm package ships every
build flavour and is a 161 MB download.

To update them, run `node scripts/update-engine.mjs <version>`. It downloads the npm tarball,
extracts only the lite single-threaded build, and prints the new checksums for this file.

Licence: GPL-3.0 (see `COPYING.txt`). Source code:
- https://github.com/nmrugg/stockfish.js
- https://github.com/official-stockfish/Stockfish
