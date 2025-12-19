# Chess Analyzer ♔

A modern Flask web application that helps chess players review and improve their opening repertoire. Upload your personal PGN archives and let Stockfish highlight common mistakes and suggest stronger alternatives.

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![Flask](https://img.shields.io/badge/Flask-2.3+-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

### 🎯 Core Features
- **Smart Opening Analysis** – Analyzes the first 20 plies (10 moves) of each game to focus on opening preparation
- **Mistake Detection** – Identifies recurring mistakes with centipawn loss calculations
- **Interactive Training Board** – Practice positions directly in the browser with drag-and-drop piece movement
- **Stockfish Integration** – Powered by the strongest chess engine for accurate analysis

### 🎨 Modern UI/UX
- **Beautiful Dark Theme** – Eye-friendly design with gradient accents
- **Responsive Design** – Works seamlessly on desktop, tablet, and mobile
- **Toast Notifications** – Real-time feedback for all actions
- **Progress Indicators** – Visual feedback during analysis and uploads
- **Keyboard Navigation** – Arrow keys to navigate positions, shortcuts for common actions

### 📊 Analysis Dashboard
- **Statistics Overview** – Total mistakes, average CP loss, frequency data
- **Severity Indicators** – Color-coded severity (Severe/High/Moderate)
- **Advanced Filtering** – Search, filter by CP loss, severity level
- **Sortable Table** – Sort by frequency, CP loss, or original order
- **Export Functionality** – Export analysis results as JSON

### 🔒 Account System
- **Secure Authentication** – Password hashing with Werkzeug security
- **Session Management** – Secure cookie-based sessions
- **Per-User Storage** – Each user's games and analysis stored separately

### 🔗 API Endpoints
- `GET /api/status` – Check analysis status for both colors
- `GET /api/analysis/<color>` – Get analysis results as JSON
- `GET /api/export` – Export all user data

## 📋 Requirements

- Python 3.10 or later
- [Flask](https://flask.palletsprojects.com/) and [python-chess](https://python-chess.readthedocs.io/)
- A Stockfish binary (automatically detected if installed via package manager)

### Installing Stockfish

**macOS:**
```bash
brew install stockfish
```

**Ubuntu/Debian:**
```bash
sudo apt-get install stockfish
```

**Windows:**
Download from [stockfishchess.org/download](https://stockfishchess.org/download/)

## 🚀 Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/SMANahian/chess-analyzer.git
   cd chess-analyzer
   ```

2. **Create and activate virtual environment:**
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the application:**
   ```bash
   python app.py
   ```

5. **Open in browser:**
   Visit [http://localhost:5000](http://localhost:5000)

## ⚙️ Configuration

Set environment variables to customize the application:

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | Random | Flask session secret key |
| `ANALYSIS_DEPTH` | 14 | Stockfish analysis depth |
| `OPENING_PLIES_LIMIT` | 20 | Number of plies to analyze (10 full moves) |
| `MISTAKE_THRESHOLD_CP` | 100 | Minimum CP loss to consider a mistake |
| `MIN_PAIR_OCCURRENCES` | 2 | Minimum times a position must occur |
| `MAX_GAMES_PER_UPLOAD` | 1000 | Maximum games per upload |
| `MAX_FILE_SIZE_MB` | 2 | Maximum PGN file size |
| `STOCKFISH_PATH` | Auto | Path to Stockfish binary |
| `STOCKFISH_THREADS` | - | Number of CPU threads for engine |
| `STOCKFISH_HASH_MB` | - | Hash table size in MB |
| `PORT` | 5000 | Server port |

Example:
```bash
export SECRET_KEY="your-secret-key"
export ANALYSIS_DEPTH=16
python app.py
```

## 📁 Project Structure

```
chess-analyzer/
├── app.py              # Main Flask application
├── config.py           # Configuration settings
├── requirements.txt    # Python dependencies
├── utils/              # Utility modules
│   ├── __init__.py
│   ├── analysis.py     # Chess analysis logic
│   ├── database.py     # User data management
│   ├── stockfish.py    # Engine management
│   └── validation.py   # Input validation
├── templates/          # Jinja2 HTML templates
│   ├── base.html       # Base layout
│   ├── home.html       # Landing page
│   ├── login.html      # Login page
│   ├── register.html   # Registration page
│   ├── upload.html     # PGN upload page
│   ├── train.html      # Training dashboard
│   ├── analysis.html   # Analysis/training board
│   └── error.html      # Error pages
├── assets/             # Static files
│   ├── css/
│   ├── js/
│   └── img/
└── database/           # User data storage
```

## 💡 Usage Tips

1. **Export from OpeningTree** – Use [OpeningTree](https://www.openingtree.com/) to generate focused PGN files from your games
2. **Separate Colors** – Upload White and Black games separately for faster, targeted analysis
3. **Regular Updates** – Re-upload games periodically as you play more
4. **Train Actively** – Delete mistakes once mastered to keep your training queue focused
5. **Use Keyboard Shortcuts:**
   - `←` / `→` – Navigate between positions
   - `Home` / `End` – Jump to first/last position
   - `H` – Show best move (hint)

## 🔧 Development

Run in debug mode:
```bash
FLASK_DEBUG=1 python app.py
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Credits

- Built by [S M A Nahian](https://smanahian.com)
- Powered by [Stockfish](https://stockfishchess.org/)
- Chess board UI by [chessboard.js](https://chessboardjs.com/)
- Move validation by [chess.js](https://github.com/jhlywa/chess.js)

## ⚠️ Disclaimer

This application is intended for personal study. The Stockfish engine runs on the same machine as the Flask server. Do not expose the application directly to the public internet without additional security hardening.
