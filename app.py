"""Chess Analyzer - Flask Application.

A web application for analyzing chess opening mistakes using Stockfish engine.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    abort,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

from config import (
    ANALYSIS_DEPTH,
    DATABASE_DIR,
    MAX_FILE_SIZE_MB,
    MAX_GAMES_PER_UPLOAD,
    MIN_PAIR_OCCURRENCES,
    MISTAKE_THRESHOLD_CP,
    OPENING_PLIES_LIMIT,
    Config,
)
from utils.analysis import analyze_async, clean_and_merge_pgns, compute_analysis_stats
from utils.database import atomic_write_json, load_users, save_users
from utils.stockfish import bundled_stockfish_note, get_engine_status, stockfish_install_hint
from utils.validation import validate_email, validate_password, validate_username

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__, static_folder="assets", static_url_path="/assets")
app.config.from_object(Config)

# Ensure sessions are permanent by default
@app.before_request
def make_session_permanent():
    session.permanent = True
    app.permanent_session_lifetime = timedelta(hours=24)


# ==============================================================================
# Decorators & Helpers
# ==============================================================================

def login_required(f):
    """Decorator to require authentication for a route."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if "username" not in session:
            flash("Please log in to access this page.", "warning")
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated_function


def get_user_dir(username: str | None = None) -> Path:
    """Get the data directory for a user."""
    candidate = username or session.get("username")
    if not candidate:
        abort(401)
    validated = validate_username(candidate)
    if not validated:
        session.clear()
        abort(401)
    return DATABASE_DIR / validated


def get_analysis_status(username: str, color: str) -> dict[str, Any]:
    """Get the current analysis status for a color."""
    user_path = DATABASE_DIR / username
    analysis_file = user_path / f"{username}_{color}_analysis.json"
    flag_file = user_path / f"analysis_{color}.processing"
    error_file = user_path / f"analysis_{color}.error.json"
    pgn_file = user_path / f"{username}_{color}.pgn"
    
    return {
        "has_pgn": pgn_file.exists(),
        "is_processing": flag_file.exists(),
        "has_results": analysis_file.exists(),
        "has_error": error_file.exists(),
    }


def load_mistakes(color: str) -> tuple[list[dict[str, Any]], bool, str | None]:
    """Load mistake analysis results for a color."""
    username = session["username"]
    user_path = get_user_dir()
    analysis_file = user_path / f"{username}_{color}_analysis.json"
    flag_file = user_path / f"analysis_{color}.processing"
    error_file = user_path / f"analysis_{color}.error.json"

    if analysis_file.exists():
        try:
            with analysis_file.open(encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, list):
                filtered = [
                    {**m, "color": color}
                    for m in data
                    if isinstance(m, dict) and m.get("avg_cp_loss", 0) >= MISTAKE_THRESHOLD_CP
                ]
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


def start_analysis(color: str) -> bool:
    """Start analysis for a specific color."""
    engine_ok, _engine_status = get_engine_status()
    if not engine_ok:
        return False

    username = session["username"]
    user_path = get_user_dir()
    pgn_file = user_path / f"{username}_{color}.pgn"
    if not pgn_file.exists():
        return False

    analysis_file = user_path / f"{username}_{color}_analysis.json"
    flag_file = user_path / f"analysis_{color}.processing"
    error_file = user_path / f"analysis_{color}.error.json"

    if flag_file.exists():
        return True
    try:
        flag_file.write_text("", encoding="utf-8")
    except OSError:
        return False

    error_file.unlink(missing_ok=True)
    analyze_async([str(pgn_file)], analysis_file, flag_file, error_file, color)
    logger.info(f"Started analysis for {username} ({color})")
    return True


# ==============================================================================
# Error Handlers
# ==============================================================================

@app.errorhandler(401)
def unauthorized(e):
    """Handle 401 Unauthorized errors."""
    flash("Please log in to continue.", "warning")
    return redirect(url_for("login"))


@app.errorhandler(404)
def not_found(e):
    """Handle 404 Not Found errors."""
    return render_template("error.html", error_code=404, error_message="Page not found"), 404


@app.errorhandler(500)
def server_error(e):
    """Handle 500 Internal Server errors."""
    logger.error(f"Server error: {e}")
    return render_template("error.html", error_code=500, error_message="Something went wrong"), 500


# ==============================================================================
# Context Processors
# ==============================================================================

@app.context_processor
def inject_globals():
    """Inject global variables into templates."""
    return {
        "current_year": datetime.now().year,
        "app_name": "Chess Analyzer",
    }


# ==============================================================================
# Routes - Authentication
# ==============================================================================

@app.route("/")
def home():
    """Landing page."""
    if "username" in session:
        return redirect(url_for("upload"))
    return render_template("home.html")


@app.route("/register", methods=["GET", "POST"])
def register():
    """User registration."""
    if "username" in session:
        return redirect(url_for("upload"))
        
    if request.method == "POST":
        username_raw = request.form.get("username", "")
        username = validate_username(username_raw)
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        
        # Validate username
        if not username:
            flash("Username must be 2-32 characters (letters, numbers, ._-).", "danger")
            return render_template("register.html")
        
        # Validate email
        email_valid, email_error = validate_email(email)
        if not email_valid:
            flash(email_error, "danger")
            return render_template("register.html")
        
        # Validate password
        password_valid, password_error = validate_password(password)
        if not password_valid:
            flash(password_error, "danger")
            return render_template("register.html")
        
        # Check if user exists
        users = load_users()
        if username in users:
            flash("Username already exists. Please choose another.", "danger")
            return render_template("register.html")
        
        # Create user
        users[username] = {
            "email": email,
            "password": generate_password_hash(password),
            "created_at": datetime.now().isoformat(),
        }
        save_users(users)
        
        # Log in user
        session["username"] = username
        session["email"] = email
        session.permanent = True
        (DATABASE_DIR / username).mkdir(parents=True, exist_ok=True)
        
        logger.info(f"New user registered: {username}")
        flash("Account created successfully! Welcome to Chess Analyzer.", "success")
        return redirect(url_for("upload"))
    
    return render_template("register.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    """User login."""
    if "username" in session:
        return redirect(url_for("upload"))
        
    if request.method == "POST":
        username_raw = request.form.get("username", "")
        username = validate_username(username_raw)
        password = request.form.get("password", "")
        
        users = load_users()
        user = users.get(username or "")
        
        if user and check_password_hash(user["password"], password):
            session["username"] = username
            session["email"] = user.get("email", "")
            session.permanent = True
            (DATABASE_DIR / username).mkdir(parents=True, exist_ok=True)
            
            logger.info(f"User logged in: {username}")
            flash(f"Welcome back, {username}!", "success")
            return redirect(url_for("upload"))
        
        flash("Invalid username or password.", "danger")
    
    return render_template("login.html")


@app.route("/logout")
def logout():
    """User logout."""
    username = session.get("username")
    session.clear()
    if username:
        logger.info(f"User logged out: {username}")
    flash("You have been logged out.", "info")
    return redirect(url_for("login"))


# ==============================================================================
# Routes - Main Features
# ==============================================================================

@app.route("/upload", methods=["GET", "POST"])
@login_required
def upload():
    """Upload PGN files."""
    if request.method == "POST":
        white_files = request.files.getlist("white_pgn")
        black_files = request.files.getlist("black_pgn")
        valid_white = [f for f in white_files if f and f.filename and f.filename.lower().endswith(".pgn")]
        valid_black = [f for f in black_files if f and f.filename and f.filename.lower().endswith(".pgn")]
        
        if not valid_white and not valid_black:
            flash("Please provide at least one .pgn file.", "warning")
            return redirect(url_for("upload"))
        
        username = session["username"]
        user_path = get_user_dir()
        games_uploaded = {"white": 0, "black": 0}

        if valid_white:
            dest = user_path / f"{username}_white.pgn"
            games_uploaded["white"] = clean_and_merge_pgns(valid_white, dest)
            (user_path / f"{username}_white_analysis.json").unlink(missing_ok=True)
            (user_path / "analysis_white.processing").unlink(missing_ok=True)
            (user_path / "analysis_white.error.json").unlink(missing_ok=True)

        if valid_black:
            dest = user_path / f"{username}_black.pgn"
            games_uploaded["black"] = clean_and_merge_pgns(valid_black, dest)
            (user_path / f"{username}_black_analysis.json").unlink(missing_ok=True)
            (user_path / "analysis_black.processing").unlink(missing_ok=True)
            (user_path / "analysis_black.error.json").unlink(missing_ok=True)

        total_games = games_uploaded["white"] + games_uploaded["black"]
        flash(f"Successfully uploaded {total_games} games!", "success")
        logger.info(f"User {username} uploaded games: white={games_uploaded['white']}, black={games_uploaded['black']}")
        return redirect(url_for("train"))
    
    # Get current status
    username = session["username"]
    white_status = get_analysis_status(username, "white")
    black_status = get_analysis_status(username, "black")
    
    return render_template(
        "upload.html",
        username=username,
        opening_plies_limit=OPENING_PLIES_LIMIT,
        max_games=MAX_GAMES_PER_UPLOAD,
        max_file_size_mb=MAX_FILE_SIZE_MB,
        white_status=white_status,
        black_status=black_status,
    )


@app.route("/clear_pgns", methods=["POST"])
@login_required
def clear_pgns():
    """Clear all PGN files and analysis for the current user."""
    username = session["username"]
    user_path = get_user_dir()
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
            (user_path / name).unlink(missing_ok=True)
        except OSError:
            pass
    
    flash("All games and analysis cleared.", "info")
    logger.info(f"User {username} cleared all data")
    return redirect(url_for("upload"))


@app.route("/train")
@login_required
def train():
    """Training dashboard."""
    engine_ok, engine_status = get_engine_status()
    install_label, install_value = stockfish_install_hint()
    bundled_note = bundled_stockfish_note()
    
    username = session["username"]
    white_status = get_analysis_status(username, "white")
    black_status = get_analysis_status(username, "black")
    
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
        white_status=white_status,
        black_status=black_status,
    )


@app.route("/train_<color>", methods=["POST"])
@login_required
def train_color(color):
    """Start analysis for a specific color."""
    if color not in {"white", "black", "both"}:
        abort(404)
    
    username = session["username"]
    user_path = get_user_dir()
    
    if color == "both":
        started = False
        if (user_path / f"{username}_white.pgn").exists():
            started = start_analysis("white") or started
        if (user_path / f"{username}_black.pgn").exists():
            started = start_analysis("black") or started
        
        if started:
            flash("Analysis started for both colors. This may take a few minutes.", "info")
        return redirect(url_for("analysis") if started else url_for("train"))
    
    if start_analysis(color):
        flash(f"Analysis started for {color}. This may take a few minutes.", "info")
        return redirect(url_for("analysis_color", color=color))
    
    flash(f"Could not start analysis for {color}. Make sure you have uploaded PGN files.", "warning")
    return redirect(url_for("train"))


@app.route("/analysis")
@login_required
def analysis():
    """Combined analysis view for both colors."""
    mistakes = []
    processing = False
    errors: list[str] = []
    
    for color in ["white", "black"]:
        m, p, err = load_mistakes(color)
        mistakes.extend(m)
        processing = processing or p
        if err:
            errors.append(f"{color.title()}: {err}")
    
    stats = compute_analysis_stats(mistakes)
    
    return render_template(
        "analysis.html",
        mistakes=mistakes,
        processing=processing,
        color=None,
        errors=errors,
        stats=stats,
        threshold_cp=MISTAKE_THRESHOLD_CP,
        opening_plies_limit=OPENING_PLIES_LIMIT,
    )


@app.route("/analysis_<color>")
@login_required
def analysis_color(color):
    """Analysis view for a specific color."""
    if color not in {"white", "black"}:
        abort(404)
    
    mistakes, processing, error = load_mistakes(color)
    errors = [error] if error else []
    stats = compute_analysis_stats(mistakes)
    
    return render_template(
        "analysis.html",
        mistakes=mistakes,
        processing=processing,
        color=color,
        errors=errors,
        stats=stats,
        threshold_cp=MISTAKE_THRESHOLD_CP,
        opening_plies_limit=OPENING_PLIES_LIMIT,
    )


@app.route("/delete_mistake/<color>/<int:index>", methods=["POST"])
@login_required
def delete_mistake(color, index):
    """Delete a specific mistake from analysis."""
    if color not in {"white", "black"}:
        return jsonify({"error": "Invalid color"}), 404
    
    username = session["username"]
    analysis_file = get_user_dir() / f"{username}_{color}_analysis.json"
    
    if not analysis_file.exists():
        return jsonify({"error": "Analysis file not found"}), 404
    
    try:
        with analysis_file.open(encoding="utf-8") as f:
            mistakes = json.load(f)
    except (OSError, json.JSONDecodeError):
        return jsonify({"error": "Failed to read analysis file"}), 500
    
    if 0 <= index < len(mistakes):
        deleted = mistakes.pop(index)
        atomic_write_json(analysis_file, mistakes)
        logger.info(f"User {username} deleted mistake at index {index} ({color})")
        return jsonify({"success": True, "remaining": len(mistakes)})
    
    return jsonify({"error": "Invalid index"}), 400


# ==============================================================================
# API Endpoints
# ==============================================================================

@app.route("/api/status")
@login_required
def api_status():
    """Get current analysis status."""
    username = session["username"]
    return jsonify({
        "white": get_analysis_status(username, "white"),
        "black": get_analysis_status(username, "black"),
    })


@app.route("/api/analysis/<color>")
@login_required
def api_analysis(color):
    """Get analysis results as JSON."""
    if color not in {"white", "black"}:
        return jsonify({"error": "Invalid color"}), 404
    
    mistakes, processing, error = load_mistakes(color)
    stats = compute_analysis_stats(mistakes)
    
    return jsonify({
        "mistakes": mistakes,
        "processing": processing,
        "error": error,
        "stats": stats,
    })


@app.route("/api/export")
@login_required
def api_export():
    """Export all analysis data."""
    mistakes = []
    for color in ["white", "black"]:
        m, _, _ = load_mistakes(color)
        mistakes.extend(m)
    
    stats = compute_analysis_stats(mistakes)
    
    return jsonify({
        "username": session["username"],
        "exported_at": datetime.now().isoformat(),
        "stats": stats,
        "mistakes": mistakes,
    })


# ==============================================================================
# Main Entry Point
# ==============================================================================

if __name__ == "__main__":
    DATABASE_DIR.mkdir(parents=True, exist_ok=True)
    debug = os.environ.get("FLASK_DEBUG") == "1"
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=debug, port=port, use_reloader=False)
