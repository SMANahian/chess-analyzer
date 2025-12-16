from __future__ import annotations

import io
import json
import os
import platform
import re
import secrets
import shutil
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

import chess
import chess.engine
import chess.pgn
from flask import Flask, abort, redirect, render_template, render_template_string, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DATABASE_DIR = Path(os.environ.get("DATABASE_DIR", BASE_DIR / "database"))
USERS_FILE = DATABASE_DIR / "users.json"

ANALYSIS_DEPTH = int(os.environ.get("ANALYSIS_DEPTH", "14"))
MULTIPV = int(os.environ.get("MULTIPV", "5"))
OPENING_PLIES_LIMIT = int(os.environ.get("OPENING_PLIES_LIMIT", "20"))
MAX_GAMES_PER_UPLOAD = int(os.environ.get("MAX_GAMES_PER_UPLOAD", "1000"))
MAX_FILE_SIZE_MB = int(os.environ.get("MAX_FILE_SIZE_MB", "2"))
MAX_REQUEST_SIZE_MB = int(os.environ.get("MAX_REQUEST_SIZE_MB", str(MAX_FILE_SIZE_MB * 2)))
MISTAKE_THRESHOLD_CP = int(os.environ.get("MISTAKE_THRESHOLD_CP", "100"))
TOP_MOVE_THRESHOLD_CP = int(os.environ.get("TOP_MOVE_THRESHOLD_CP", "30"))
MIN_PAIR_OCCURRENCES = int(os.environ.get("MIN_PAIR_OCCURRENCES", "2"))
MATE_SCORE_CP = int(os.environ.get("MATE_SCORE_CP", "10000"))

USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$")

app = Flask(__name__, static_folder="assets", static_url_path="/assets")
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_SIZE_MB * 1024 * 1024

if os.environ.get("SECRET_KEY"):
    app.secret_key = os.environ["SECRET_KEY"]
else:
    app.secret_key = secrets.token_hex(32)


def validate_username(username: str) -> str | None:
    username = username.strip()
    if not USERNAME_RE.fullmatch(username):
        return None
    return username


def require_login() -> None:
    if "username" not in session:
        abort(401)


def user_dir(username: str | None = None) -> Path:
    require_login()
    candidate = username or session["username"]
    validated = validate_username(candidate)
    if not validated:
        session.clear()
        abort(401)
    return DATABASE_DIR / validated


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as handle:
        json.dump(payload, handle)
        tmp_name = handle.name
    os.replace(tmp_name, path)


def load_users() -> dict[str, dict[str, str]]:
    if not USERS_FILE.exists():
        return {}
    try:
        with USERS_FILE.open(encoding="utf-8") as handle:
            data = json.load(handle)
            if isinstance(data, dict):
                return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_users(users: dict[str, dict[str, str]]) -> None:
    atomic_write_json(USERS_FILE, users)


def binary_kind(path: Path) -> str | None:
    try:
        with path.open("rb") as handle:
            magic = handle.read(4)
    except OSError:
        return None

    if magic == b"\x7fELF":
        return "ELF"
    if magic[:2] == b"MZ":
        return "PE"
    if magic in {
        b"\xfe\xed\xfa\xce",
        b"\xce\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
    }:
        return "Mach-O"
    return None


def bundled_stockfish_note() -> str | None:
    candidates = [BASE_DIR / "stockfish", BASE_DIR / "stockfish" / "stockfish", BASE_DIR / "stockfish.exe"]
    for candidate in candidates:
        if not candidate.exists():
            continue
        kind = binary_kind(candidate)
        if kind == "ELF":
            return "Bundled ./stockfish is a Linux (ELF) binary and won't run on macOS/Windows."
        if kind == "Mach-O":
            return "Bundled ./stockfish is a macOS (Mach-O) binary."
        if kind == "PE":
            return "Bundled ./stockfish.exe is a Windows binary."
        return "Bundled Stockfish binary exists but format is unknown."
    return None


def stockfish_install_hint() -> tuple[str | None, str | None]:
    if sys.platform == "darwin":
        return "Install via Homebrew:", "brew install stockfish"
    if sys.platform.startswith("linux"):
        return "Install via apt (Ubuntu/Debian):", "sudo apt-get install stockfish"
    if sys.platform.startswith("win"):
        return "Download Stockfish:", "https://stockfishchess.org/download/"
    system = platform.system()
    if system:
        return f"Install Stockfish for {system}:", "https://stockfishchess.org/download/"
    return None, None


def stockfish_candidates() -> list[str]:
    env_path = os.environ.get("STOCKFISH_PATH")
    if env_path:
        return [env_path]

    candidates: list[str] = []
    for candidate in (BASE_DIR / "stockfish", BASE_DIR / "stockfish" / "stockfish", BASE_DIR / "stockfish.exe"):
        if candidate.exists():
            candidates.append(str(candidate))

    system_stockfish = shutil.which("stockfish")
    if system_stockfish:
        candidates.append(system_stockfish)

    seen: set[str] = set()
    deduped: list[str] = []
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            deduped.append(candidate)
    return deduped or ["stockfish"]


def start_stockfish() -> tuple[chess.engine.SimpleEngine, str]:
    last_exc: Exception | None = None
    candidates = stockfish_candidates()
    for candidate in candidates:
        try:
            engine = chess.engine.SimpleEngine.popen_uci(candidate)
        except (OSError, chess.engine.EngineError) as exc:
            last_exc = exc
            continue
        return engine, candidate

    display_candidates: list[str] = []
    for candidate in candidates:
        try:
            path = Path(candidate).resolve()
        except OSError:
            display_candidates.append(candidate)
            continue
        try:
            rel = path.relative_to(BASE_DIR)
        except ValueError:
            display_candidates.append(candidate)
        else:
            display_candidates.append(f"./{rel}")

    raise RuntimeError(
        "Unable to start Stockfish. "
        f"Tried: {', '.join(display_candidates)}."
    ) from last_exc


def configure_engine(engine: chess.engine.SimpleEngine) -> None:
    options: dict[str, Any] = {}
    threads = os.environ.get("STOCKFISH_THREADS")
    hash_mb = os.environ.get("STOCKFISH_HASH_MB")
    if threads:
        try:
            options["Threads"] = max(1, int(threads))
        except ValueError:
            pass
    if hash_mb:
        try:
            options["Hash"] = max(16, int(hash_mb))
        except ValueError:
            pass
    if options:
        try:
            engine.configure(options)
        except chess.engine.EngineError:
            pass


_ENGINE_STATUS: tuple[bool, str] | None = None
_ENGINE_STATUS_LOCK = threading.Lock()


def get_engine_status() -> tuple[bool, str]:
    global _ENGINE_STATUS
    with _ENGINE_STATUS_LOCK:
        if _ENGINE_STATUS is not None and _ENGINE_STATUS[0]:
            return _ENGINE_STATUS
        try:
            engine, path = start_stockfish()
        except RuntimeError as exc:
            return False, str(exc)

        try:
            engine.quit()
        except chess.engine.EngineError:
            pass

        _ENGINE_STATUS = (True, f"Stockfish: {path}")
        return _ENGINE_STATUS


def clean_and_merge_pgns(files: list[Any], dest_path: Path) -> int:
    total_games = 0
    total_size = 0

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with dest_path.open("w", encoding="utf-8") as out:
        for fs in files:
            data_bytes = fs.read()
            total_size += len(data_bytes)
            if total_size > MAX_FILE_SIZE_MB * 1024 * 1024:
                break
            data = data_bytes.decode("utf-8", "ignore")
            pgn_io = io.StringIO(data)

            while total_games < MAX_GAMES_PER_UPLOAD:
                game = chess.pgn.read_game(pgn_io)
                if game is None:
                    break
                new_game = chess.pgn.Game()
                node = new_game
                for ply_index, move in enumerate(game.mainline_moves()):
                    if ply_index >= OPENING_PLIES_LIMIT:
                        break
                    node = node.add_variation(move)

                exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
                out.write(new_game.accept(exporter))
                out.write("\n\n")
                total_games += 1

            if total_games >= MAX_GAMES_PER_UPLOAD:
                break
    return total_games


def position_key(board: chess.Board) -> str:
    ep = chess.square_name(board.ep_square) if board.ep_square is not None else "-"
    return f"{board.board_fen()} {'w' if board.turn else 'b'} {board.castling_xfen()} {ep}"


def score_to_cp(score: chess.engine.PovScore | None) -> int | None:
    if score is None:
        return None
    value = score.white().score(mate_score=MATE_SCORE_CP)
    if value is None:
        return None
    return int(value)


def collect_move_pairs(paths: list[str], color: str) -> tuple[dict[tuple[str, str], int], dict[tuple[str, str], str]]:
    pair_counts: dict[tuple[str, str], int] = {}
    pair_fens: dict[tuple[str, str], str] = {}

    target_turn = chess.WHITE if color == "white" else chess.BLACK
    for path in paths:
        pgn_path = Path(path)
        if not pgn_path.exists():
            continue
        with pgn_path.open(encoding="utf-8", errors="ignore") as pgn:
            while True:
                game = chess.pgn.read_game(pgn)
                if game is None:
                    break
                board = game.board()
                for ply_index, move in enumerate(game.mainline_moves()):
                    if ply_index >= OPENING_PLIES_LIMIT:
                        break
                    if board.turn != target_turn:
                        board.push(move)
                        continue
                    key = (position_key(board), move.uci())
                    pair_counts[key] = pair_counts.get(key, 0) + 1
                    pair_fens.setdefault(key, board.fen())
                    board.push(move)

    return pair_counts, pair_fens


def analyze_pgn(paths: list[str], color: str) -> list[dict[str, Any]]:
    pair_counts, pair_fens = collect_move_pairs(paths, color)
    candidates = [(key, count) for key, count in pair_counts.items() if count >= MIN_PAIR_OCCURRENCES]
    if not candidates:
        return []

    candidates.sort(key=lambda item: item[1], reverse=True)

    mistakes: list[dict[str, Any]] = []
    position_cache: dict[str, tuple[int | None, list[str]]] = {}
    after_cache: dict[str, int | None] = {}
    depth_limit = chess.engine.Limit(depth=ANALYSIS_DEPTH)

    engine, _stockfish_path = start_stockfish()

    try:
        configure_engine(engine)
        for (pos_key, user_move), count in candidates:
            fen = pair_fens.get((pos_key, user_move))
            if not fen:
                continue
            try:
                board = chess.Board(fen)
            except ValueError:
                continue

            if pos_key not in position_cache:
                try:
                    infos = engine.analyse(board, depth_limit, multipv=MULTIPV)
                except chess.engine.EngineError:
                    position_cache[pos_key] = (None, [])
                else:
                    if isinstance(infos, dict):
                        infos = [infos]
                    best_score = score_to_cp(infos[0].get("score"))
                    top_moves: list[str] = []
                    if best_score is not None:
                        for info in infos:
                            pv = info.get("pv") or []
                            if not pv:
                                continue
                            mv = pv[0]
                            mv_score = score_to_cp(info.get("score"))
                            if mv_score is None:
                                continue
                            if best_score - mv_score <= TOP_MOVE_THRESHOLD_CP:
                                top_moves.append(mv.uci())
                    position_cache[pos_key] = (best_score, top_moves)

            best_score, top_moves = position_cache[pos_key]
            if best_score is None:
                continue

            try:
                move_obj = chess.Move.from_uci(user_move)
            except ValueError:
                continue
            if move_obj not in board.legal_moves:
                continue

            if top_moves and user_move in top_moves:
                continue

            board_after = board.copy(stack=False)
            board_after.push(move_obj)
            after_key = position_key(board_after)
            if after_key not in after_cache:
                try:
                    info_after = engine.analyse(board_after, depth_limit)
                except chess.engine.EngineError:
                    after_cache[after_key] = None
                else:
                    after_cache[after_key] = score_to_cp(info_after.get("score"))

            score_after = after_cache.get(after_key)
            if score_after is None:
                continue

            mover_is_white = board.turn == chess.WHITE
            cp_loss = (best_score - score_after) if mover_is_white else (score_after - best_score)
            if cp_loss <= MISTAKE_THRESHOLD_CP:
                continue

            mistakes.append(
                {
                    "fen": fen,
                    "user_move": user_move,
                    "top_moves": top_moves,
                    "avg_cp_loss": int(round(cp_loss)),
                    "pair_count": count,
                }
            )
    finally:
        try:
            engine.quit()
        except chess.engine.EngineError:
            pass

    mistakes.sort(key=lambda item: (item["pair_count"], item["avg_cp_loss"]), reverse=True)
    return mistakes


def analyze_async(paths: list[str], analysis_file: Path, flag_file: Path, error_file: Path, color: str) -> None:
    def task() -> None:
        try:
            mistakes = analyze_pgn(paths, color)
            atomic_write_json(analysis_file, mistakes)
        except Exception as exc:
            atomic_write_json(error_file, {"error": str(exc)})
        finally:
            try:
                flag_file.unlink(missing_ok=True)
            except OSError:
                pass

    threading.Thread(target=task, daemon=True).start()


@app.route('/')
def home():
    if 'username' in session:
        return redirect(url_for("upload"))
    return render_template_string(
        """{% extends 'base.html' %}{% block content %}
<h1>Welcome to Chess Analyzer</h1>
<p>Use <a href='https://www.openingtree.com/' target='_blank'>OpeningTree</a> to create your PGN files and then upload them here.</p>
<p>This project was created by vibecoding with ChatGPT Codex.</p>
{% endblock %}"""
    )


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username_raw = request.form["username"]
        username = validate_username(username_raw)
        email = request.form["email"].strip()
        password = request.form["password"]
        users = load_users()
        if not username:
            return render_template("register.html", error="Username must be 2-32 chars (letters/numbers/._-).")
        if username in users:
            return render_template('register.html', error='Username already exists')
        users[username] = {
            'email': email,
            'password': generate_password_hash(password)
        }
        save_users(users)
        session["username"] = username
        session["email"] = email
        user_dir(username).mkdir(parents=True, exist_ok=True)
        return redirect(url_for("upload"))
    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username_raw = request.form["username"]
        username = validate_username(username_raw)
        password = request.form["password"]
        users = load_users()
        user = users.get(username or "")
        if user and check_password_hash(user['password'], password):
            session["username"] = username
            session["email"] = user["email"]
            user_dir(username).mkdir(parents=True, exist_ok=True)
            return redirect(url_for("upload"))
        return render_template('login.html', error='Invalid credentials')
    return render_template('login.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route('/upload', methods=['GET', 'POST'])
def upload():
    if 'username' not in session:
        return redirect(url_for("login"))
    if request.method == 'POST':
        white_files = request.files.getlist("white_pgn")
        black_files = request.files.getlist("black_pgn")
        valid_white = [f for f in white_files if f and f.filename and f.filename.lower().endswith(".pgn")]
        valid_black = [f for f in black_files if f and f.filename and f.filename.lower().endswith(".pgn")]
        if not valid_white and not valid_black:
            return render_template(
                "upload.html",
                username=session.get("username"),
                error="Please provide at least one .pgn file.",
            )
        username = session["username"]

        if valid_white:
            dest = user_dir() / f"{username}_white.pgn"
            clean_and_merge_pgns(valid_white, dest)
            (user_dir() / f"{username}_white_analysis.json").unlink(missing_ok=True)
            (user_dir() / "analysis_white.processing").unlink(missing_ok=True)
            (user_dir() / "analysis_white.error.json").unlink(missing_ok=True)

        if valid_black:
            dest = user_dir() / f"{username}_black.pgn"
            clean_and_merge_pgns(valid_black, dest)
            (user_dir() / f"{username}_black_analysis.json").unlink(missing_ok=True)
            (user_dir() / "analysis_black.processing").unlink(missing_ok=True)
            (user_dir() / "analysis_black.error.json").unlink(missing_ok=True)

        return redirect(url_for("train"))
    return render_template('upload.html', username=session.get('username'), error=None)


@app.route('/clear_pgns', methods=['POST'])
def clear_pgns():
    if 'username' not in session:
        return redirect(url_for("login"))
    username = session["username"]
    files = [
        f"{username}_white.pgn",
        f"{username}_black.pgn",
        f"{username}_white_analysis.json",
        f"{username}_black_analysis.json",
        "analysis_white.processing",
        "analysis_black.processing",
        "analysis_white.error.json",
        "analysis_black.error.json",
    ]
    for name in files:
        try:
            (user_dir() / name).unlink(missing_ok=True)
        except OSError:
            pass
    return redirect(url_for("upload"))


@app.route('/train')
def train():
    if 'username' not in session:
        return redirect(url_for("login"))
    engine_ok, engine_status = get_engine_status()
    install_label, install_value = stockfish_install_hint()
    bundled_note = bundled_stockfish_note()
    return render_template(
        "train.html",
        engine_ok=engine_ok,
        engine_status=engine_status,
        engine_install_label=install_label,
        engine_install_value=install_value,
        bundled_stockfish_note=bundled_note,
        analysis_depth=ANALYSIS_DEPTH,
        opening_plies_limit=OPENING_PLIES_LIMIT,
        min_pair_occurrences=MIN_PAIR_OCCURRENCES,
        mistake_threshold_cp=MISTAKE_THRESHOLD_CP,
    )


def start_analysis(color):
    engine_ok, _engine_status = get_engine_status()
    if not engine_ok:
        return False

    username = session["username"]
    pgn_file = user_dir() / f"{username}_{color}.pgn"
    if not pgn_file.exists():
        return False

    analysis_file = user_dir() / f"{username}_{color}_analysis.json"
    flag_file = user_dir() / f"analysis_{color}.processing"
    error_file = user_dir() / f"analysis_{color}.error.json"

    if flag_file.exists():
        return True
    try:
        flag_file.write_text("", encoding="utf-8")
    except OSError:
        return False

    error_file.unlink(missing_ok=True)
    analyze_async([str(pgn_file)], analysis_file, flag_file, error_file, color)
    return True


@app.route('/train_<color>', methods=['POST'])
def train_color(color):
    if 'username' not in session:
        return redirect(url_for("login"))
    if color not in {"white", "black", "both"}:
        abort(404)
    if color == "both":
        username = session["username"]
        started = False
        if (user_dir() / f"{username}_white.pgn").exists():
            started = start_analysis("white") or started
        if (user_dir() / f"{username}_black.pgn").exists():
            started = start_analysis("black") or started
        return redirect(url_for("analysis" if started else "train"))
    if start_analysis(color):
        return redirect(url_for("analysis_color", color=color))
    return redirect(url_for("train"))


def load_mistakes(color: str) -> tuple[list[dict[str, Any]], bool, str | None]:
    username = session["username"]
    analysis_file = user_dir() / f"{username}_{color}_analysis.json"
    flag_file = user_dir() / f"analysis_{color}.processing"
    error_file = user_dir() / f"analysis_{color}.error.json"

    if analysis_file.exists():
        try:
            with analysis_file.open(encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, list):
                filtered = [m for m in data if isinstance(m, dict) and m.get("avg_cp_loss", 0) >= MISTAKE_THRESHOLD_CP]
                return filtered, False, None
        except (OSError, json.JSONDecodeError):
            return [], False, "Analysis output is corrupted."

    if error_file.exists():
        try:
            with error_file.open(encoding="utf-8") as handle:
                data = json.load(handle)
            return [], False, str(data.get("error") or "Analysis failed.")
        except (OSError, json.JSONDecodeError):
            return [], False, "Analysis failed."

    if flag_file.exists():
        return [], True, None
    return [], False, None


@app.route('/analysis')
def analysis():
    if 'username' not in session:
        return redirect(url_for("login"))
    mistakes = []
    processing = False
    errors: list[str] = []
    for color in ['white', 'black']:
        m, p, err = load_mistakes(color)
        mistakes.extend(m)
        processing = processing or p
        if err:
            errors.append(f"{color.title()}: {err}")
    return render_template("analysis.html", mistakes=mistakes, processing=processing, color=None, errors=errors)


@app.route('/analysis_<color>')
def analysis_color(color):
    if 'username' not in session:
        return redirect(url_for("login"))
    if color not in {"white", "black"}:
        abort(404)
    mistakes, processing, error = load_mistakes(color)
    errors = [error] if error else []
    return render_template("analysis.html", mistakes=mistakes, processing=processing, color=color, errors=errors)


@app.route('/delete_mistake/<color>/<int:index>', methods=['POST'])
def delete_mistake(color, index):
    if 'username' not in session:
        return ('', 403)
    if color not in {"white", "black"}:
        return ("", 404)
    analysis_file = user_dir() / f"{session['username']}_{color}_analysis.json"
    if not analysis_file.exists():
        return ('', 404)
    try:
        with analysis_file.open(encoding="utf-8") as f:
            mistakes = json.load(f)
    except (OSError, json.JSONDecodeError):
        return ("", 500)
    if 0 <= index < len(mistakes):
        mistakes.pop(index)
        atomic_write_json(analysis_file, mistakes)
    return ('', 204)


if __name__ == '__main__':
    DATABASE_DIR.mkdir(parents=True, exist_ok=True)
    debug = os.environ.get("FLASK_DEBUG") == "1"
    app.run(debug=debug, use_reloader=False)
