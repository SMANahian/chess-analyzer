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
- A Stockfish binary accessible at `./stockfish/stockfish` (one is included for
  convenience, but you can replace it with a newer version for your platform).

Create a virtual environment and install the required packages:

```bash
python -m venv .venv
source .venv/bin/activate
pip install flask python-chess
```

## Running the application

1. Set an optional secret key for session cookies:
   ```bash
   export SECRET_KEY="change-me"
   ```
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
stockfish/     # Bundled Stockfish engine binary
templates/     # Jinja templates for the HTML interface
```

## Disclaimer

This project is intended for personal study. The bundled Stockfish engine runs on
the same machine as the Flask server; do not expose the application directly to
the public internet without additional hardening.
