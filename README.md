# Chess Analyzer

Local chess opening analysis and training app built with FastAPI, SQLite, Stockfish, and a single-page frontend.

It lets you:

- upload PGNs for white and black separately
- sync games from Lichess and Chess.com
- find recurring opening mistakes with Stockfish
- analyze games in background batches with live progress
- keep synced games usable while more games are still being fetched
- practice those positions in the browser
- pause analysis and continue later from the last checkpoint
- mark mistakes as mastered
- export and restore full local backups

## Requirements

- Python 3.8+
- Stockfish available through one of:
  - `STOCKFISH_PATH`
  - a system `stockfish` install

Install Stockfish if needed:

```bash
# macOS
brew install stockfish

# Ubuntu / Debian
sudo apt install stockfish
```

## Quick Start

```bash
git clone https://github.com/SMANahian/chess-analyzer.git
cd chess-analyzer
python -m venv .venv
source .venv/bin/activate
pip install -e .
chess-analyzer
```

Published install:

```bash
pipx install chess-analyzer
```

Installer script:

```bash
curl -sSL https://raw.githubusercontent.com/SMANahian/chess-analyzer/main/install.sh | bash
```

The CLI starts a local server on `http://127.0.0.1:8765` and opens the browser automatically.

You can also run it directly as a module:

```bash
python -m chess_analyzer --no-browser --port 8765
```

## Features

- Opening-focused analysis over the first `OPENING_PLIES_LIMIT` plies
- Recurring-mistake detection based on position plus played move
- ECO opening tagging for common opening families
- Incremental sync for Lichess and Chess.com with streamed PGN merges
- Practice mode with hints, streak tracking, and session history
- Batched background analysis with partial results published after each batch
- Sync-linked analysis so newly fetched games can become usable before sync completes
- Resume support for cancelled or incomplete analysis runs
- Dark mode by default, with a persisted light-mode toggle
- Local backup export/import for PGNs, mistakes, sync config, and practice data

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHESS_ANALYZER_DATA` | `~/.chess-analyzer` | Local data directory |
| `ANALYSIS_DEPTH` | `6` | Stockfish depth for fast opening triage |
| `OPENING_PLIES_LIMIT` | `16` | Opening plies kept per game |
| `MISTAKE_THRESHOLD_CP` | `120` | Minimum centipawn loss to keep |
| `MIN_PAIR_OCCURRENCES` | `2` | Minimum repeat count for a mistake |
| `MULTIPV` | `2` | Number of top engine lines checked |
| `TOP_MOVE_THRESHOLD_CP` | `35` | Range for acceptable top moves |
| `MATE_SCORE_CP` | `10000` | Mate score normalization |
| `MAX_GAMES_PER_UPLOAD` | `1000` | Upload cap per color |
| `MAX_FILE_SIZE_MB` | `10` | PGN upload limit |
| `SYNC_BATCH_SIZE` | `100` | Remote sync chunk size before merging and publishing progress |
| `LICHESS_SYNC_MAX_GAMES` | `1000` | Max Lichess games fetched per sync |
| `CHESSCOM_SYNC_MAX_GAMES` | `1000` | Max Chess.com games fetched per sync |
| `ANALYSIS_BATCH_GAMES` | `20` | Games processed before publishing partial results |
| `ANALYSIS_BATCH_POSITION_LIMIT` | `60` | Repeated positions evaluated per batch |
| `ANALYSIS_MAX_CANDIDATES` | `250` | Global recurring candidates considered in full analysis |
| `STOCKFISH_PATH` | auto-detected | Engine binary path |
| `STOCKFISH_THREADS` | `min(2, cpu_count - 1)` | Engine thread count |
| `STOCKFISH_HASH_MB` | unset | Engine hash size |

CLI flags:

```bash
chess-analyzer --host 127.0.0.1 --port 8765 --no-browser
```

Developer mode:

```bash
chess-analyzer --dev-mode
```

This exposes a live log page in the web UI for sync, analysis, and API events.

## Data Storage

All persistent app data lives in a local SQLite database under:

```text
~/.chess-analyzer/chess_analyzer.db
```

That includes:

- uploaded PGNs
- analysis results and mastered mistakes
- sync configuration and known remote game IDs
- practice session history

## Project Layout

```text
chess_analyzer/
├── __main__.py
├── analysis.py
├── cli.py
├── db.py
├── engine.py
├── fetcher.py
├── opening.py
├── server.py
└── static/
    ├── app.js
    ├── index.html
    ├── style.css
    └── vendor/
```

## Development

Run the test suite:

```bash
python -m pip install -e '.[dev]'
python -m unittest discover -s tests -v
```

Run the browser smoke tests:

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

Rebuild or inspect the app locally:

```bash
python -m chess_analyzer --no-browser
```

API docs are available at:

```text
http://127.0.0.1:8765/api/docs
```

## Packaging

Build the distributable artifacts:

```bash
python -m pip install -e '.[dev]'
python -m build
python -m twine check dist/*
```

Smoke-test the wheel in a clean virtualenv:

```bash
python -m venv .pkg-venv
source .pkg-venv/bin/activate
pip install dist/*.whl
python -m chess_analyzer --version
```

If you want the installer to pull an unreleased Git ref instead of PyPI:

```bash
CHESS_ANALYZER_INSTALL_SOURCE=git CHESS_ANALYZER_GIT_REF=main ./install.sh
```

## Notes

- This app is intended to run locally.
- The API no longer enables permissive cross-origin access.
- Analysis jobs are queued and can be cancelled from the UI.
- Analysis progress is tracked in supported games, not just final completion.
- Partial mistakes are published while analysis is still running, so practice can start immediately.
- The default analysis path is intentionally biased toward fast repeated-opening-blunder detection rather than deep engine accuracy.
- Active mistakes, snoozed mistakes, and mastered positions are tracked separately.
- Stockfish is expected to come from `STOCKFISH_PATH` or a system install.

## License

MIT. See [LICENSE](LICENSE).
