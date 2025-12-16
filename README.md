# Chess Analyzer

Chess Analyzer is a Flask web application that helps chess players review the
opening phase of their games. Upload your personal PGN archives and the app will
use the bundled Stockfish engine to highlight common mistakes and suggest
stronger alternatives so that you can focus your training on the positions that
matter most.

## Features

- **Account system with local storage** – Register and log in to manage your own
  uploads and training results, stored in the local `database/` directory.
- **PGN ingestion pipeline** – Upload separate PGN files for White and Black,
  automatically merge up to 1,000 games per color, and keep only the first ten
  moves of each game to focus on opening preparation.
- **Background Stockfish analysis** – Launch asynchronous Stockfish analysis for
  each color, calculate centipawn loss, and aggregate common mistakes with
  recommended top moves.
- **Training dashboards** – Review combined or color-specific mistake lists,
  delete items you have mastered, and track whether fresh analysis is still
  running.

## Requirements

- Python 3.10 or later
- [Flask](https://flask.palletsprojects.com/) and
  [python-chess](https://python-chess.readthedocs.io/)
- A Stockfish binary. One is included at `./stockfish`, but it may not match
  your OS/CPU; you can point to a working engine via
  `STOCKFISH_PATH=/path/to/stockfish`.

If you don't have Stockfish installed yet:
- macOS: `brew install stockfish`
- Ubuntu/Debian: `sudo apt-get install stockfish`

Create a virtual environment and install the required packages:

```bash
python -m venv .venv
source .venv/bin/activate
pip install flask python-chess
```
Or install from `requirements.txt`:

```bash
pip install -r requirements.txt
```

## Running the application

1. Set an optional secret key for session cookies:
   ```bash
   export SECRET_KEY="change-me"
   ```
   You can also tweak analysis settings via environment variables:
   - `ANALYSIS_DEPTH` (default: 14)
   - `OPENING_PLIES_LIMIT` (default: 20 plies = 10 full moves)
   - `MISTAKE_THRESHOLD_CP` (default: 100; only show mistakes with ≥ this centipawn loss)
   - `MIN_PAIR_OCCURRENCES` (default: 2)
   - `MAX_REQUEST_SIZE_MB` (default: 4)
   - `STOCKFISH_THREADS`, `STOCKFISH_HASH_MB` (optional engine tuning)
2. Start the Flask development server:
   ```bash
   python app.py
   ```
3. Visit <http://localhost:5000> in your browser, register an account, and start
   uploading PGN files.

The server will create a folder under `database/<username>/` the first time you
log in. PGN files, analysis JSON, and processing flags live in this directory.

## Usage tips

- Upload PGNs generated from services such as
  [OpeningTree](https://www.openingtree.com/) or your database of personal
  games.
- Choose **Train Both** to analyze White and Black in one click, or trigger
  color-specific analysis if you only updated one side.
- Delete mistakes from the analysis page once you have rehearsed them to keep
  your queue focused.

## Project structure

```
assets/        # Static files served by Flask
app.py         # Flask application, routes, and analysis workflow
stockfish      # Bundled Stockfish engine binary
templates/     # Jinja templates for the HTML interface
requirements.txt
```

## Disclaimer

This project is intended for personal study. The bundled Stockfish engine runs on
the same machine as the Flask server; do not expose the application directly to
the public internet without additional hardening.
