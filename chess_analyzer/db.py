"""SQLite database layer."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Generator, Optional

DATA_DIR = Path(os.environ.get("CHESS_ANALYZER_DATA", Path.home() / ".chess-analyzer"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "chess_analyzer.db"
SCHEMA_VERSION = 5
_DB_TIMEOUT_SECONDS = float(os.environ.get("SQLITE_TIMEOUT_SECONDS", "15"))
_INIT_LOCK = threading.Lock()
_INITIALIZED_DB_PATH: Optional[Path] = None
_THREAD_LOCAL = threading.local()
_CONNECTION_LOCK = threading.Lock()
_OPEN_CONNECTIONS: list[sqlite3.Connection] = []
_INTERRUPTED_ANALYSIS_ERROR = "Application stopped before analysis completed"
_INTERRUPTED_SYNC_ERROR = "Application stopped before sync completed"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pgn_files (
    color       TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    game_count  INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    color            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued',
    queued_at        TEXT,
    started_at       TEXT,
    finished_at      TEXT,
    error            TEXT,
    progress         INTEGER NOT NULL DEFAULT 0,
    progress_total   INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS analysis_checkpoints (
    color              TEXT PRIMARY KEY,
    source_fingerprint TEXT NOT NULL,
    total_games        INTEGER NOT NULL DEFAULT 0,
    processed_games    INTEGER NOT NULL DEFAULT 0,
    completed          INTEGER NOT NULL DEFAULT 0,
    updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_pair_state (
    color        TEXT NOT NULL,
    pos_key      TEXT NOT NULL,
    user_move    TEXT NOT NULL,
    fen          TEXT NOT NULL,
    pair_count   INTEGER NOT NULL DEFAULT 0,
    opening_eco  TEXT,
    opening_name TEXT,
    PRIMARY KEY (color, pos_key, user_move)
);

CREATE TABLE IF NOT EXISTS analysis_eval_cache (
    color      TEXT NOT NULL,
    pos_key    TEXT NOT NULL,
    fen        TEXT NOT NULL,
    eval_cp    INTEGER,
    top_moves  TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (color, pos_key)
);

CREATE TABLE IF NOT EXISTS mistakes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    color        TEXT NOT NULL,
    fen          TEXT NOT NULL,
    user_move    TEXT NOT NULL,
    top_moves    TEXT NOT NULL,
    avg_cp_loss  INTEGER NOT NULL,
    pair_count   INTEGER NOT NULL,
    mastered     INTEGER NOT NULL DEFAULT 0,
    mastered_at  TEXT,
    snoozed      INTEGER NOT NULL DEFAULT 0,
    snoozed_at   TEXT,
    opening_eco  TEXT,
    opening_name TEXT,
    analyzed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_configs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    color          TEXT NOT NULL,
    platform       TEXT NOT NULL,
    username       TEXT NOT NULL,
    last_synced_at TEXT,
    created_at     TEXT NOT NULL,
    UNIQUE(color, platform)
);

CREATE TABLE IF NOT EXISTS sync_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',
    games_new   INTEGER DEFAULT 0,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    error       TEXT,
    details     TEXT
);

CREATE TABLE IF NOT EXISTS synced_game_ids (
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    game_id  TEXT NOT NULL,
    color    TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (platform, username, color, game_id)
);

CREATE TABLE IF NOT EXISTS practice_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    color       TEXT NOT NULL,
    correct     INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    started_at  TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS app_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    level      TEXT NOT NULL,
    scope      TEXT NOT NULL,
    message    TEXT NOT NULL,
    details    TEXT
);

CREATE TABLE IF NOT EXISTS mistake_attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id   INTEGER NOT NULL,
    correct      INTEGER NOT NULL DEFAULT 0,
    attempted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opponents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    lichess_username   TEXT,
    chesscom_username  TEXT,
    last_synced_at    TEXT,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opponent_sync_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    opponent_id  INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'running',
    games_new    INTEGER DEFAULT 0,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    error        TEXT,
    details      TEXT
);

CREATE TABLE IF NOT EXISTS opponent_mistakes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    opponent_id  INTEGER NOT NULL,
    color        TEXT NOT NULL,
    fen          TEXT NOT NULL,
    user_move    TEXT NOT NULL,
    top_moves    TEXT NOT NULL DEFAULT '[]',
    avg_cp_loss  INTEGER NOT NULL,
    pair_count   INTEGER NOT NULL,
    opening_eco  TEXT,
    opening_name TEXT,
    move_list    TEXT,
    analyzed_at  TEXT NOT NULL
);
"""

_MIGRATIONS = [
    "ALTER TABLE analysis_runs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE analysis_runs ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE analysis_runs ADD COLUMN queued_at TEXT",
    "ALTER TABLE analysis_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mistakes ADD COLUMN opening_eco TEXT",
    "ALTER TABLE mistakes ADD COLUMN opening_name TEXT",
    "ALTER TABLE mistakes ADD COLUMN snoozed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mistakes ADD COLUMN snoozed_at TEXT",
    "ALTER TABLE sync_runs ADD COLUMN details TEXT",
    # v4: SM-2 spaced repetition fields + move breadcrumb
    "ALTER TABLE mistakes ADD COLUMN sm2_interval INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE mistakes ADD COLUMN sm2_ease REAL NOT NULL DEFAULT 2.5",
    "ALTER TABLE mistakes ADD COLUMN sm2_due_at TEXT",
    "ALTER TABLE mistakes ADD COLUMN sm2_reps INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mistakes ADD COLUMN move_list TEXT",
    "ALTER TABLE analysis_pair_state ADD COLUMN move_list TEXT",
]

_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_analysis_runs_color_status ON analysis_runs(color, status, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_analysis_checkpoints_completed ON analysis_checkpoints(completed, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_analysis_pair_state_color_count ON analysis_pair_state(color, pair_count DESC)",
    "CREATE INDEX IF NOT EXISTS idx_analysis_eval_cache_color ON analysis_eval_cache(color, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_mistakes_color_state ON mistakes(color, mastered, snoozed)",
    "CREATE INDEX IF NOT EXISTS idx_mistakes_color_order ON mistakes(color, pair_count DESC, avg_cp_loss DESC)",
    "CREATE INDEX IF NOT EXISTS idx_sync_runs_config_id ON sync_runs(config_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_practice_sessions_color_id ON practice_sessions(color, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_app_logs_created_at ON app_logs(id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_mistake_attempts_mistake_id ON mistake_attempts(mistake_id, attempted_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_mistakes_sm2_due ON mistakes(color, mastered, snoozed, sm2_due_at)",
    "CREATE INDEX IF NOT EXISTS idx_mistakes_color_practice ON mistakes(color, mastered, snoozed, sm2_reps)",
    "CREATE INDEX IF NOT EXISTS idx_opponent_mistakes_opp ON opponent_mistakes(opponent_id, color, pair_count DESC, avg_cp_loss DESC)",
    "CREATE INDEX IF NOT EXISTS idx_opponent_sync_runs_opp ON opponent_sync_runs(opponent_id, id DESC)",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    _ensure_initialized()
    conn = _get_thread_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _get_thread_connection() -> sqlite3.Connection:
    conn = getattr(_THREAD_LOCAL, "conn", None)
    conn_path = getattr(_THREAD_LOCAL, "conn_path", None)
    if conn is not None and conn_path == DB_PATH:
        return conn

    if conn is not None:
        _close_connection(conn)

    conn = sqlite3.connect(DB_PATH, timeout=_DB_TIMEOUT_SECONDS, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout={int(_DB_TIMEOUT_SECONDS * 1000)}")
    conn.execute("PRAGMA foreign_keys=ON")
    _THREAD_LOCAL.conn = conn
    _THREAD_LOCAL.conn_path = DB_PATH
    with _CONNECTION_LOCK:
        _OPEN_CONNECTIONS.append(conn)
    return conn


def _close_connection(conn: sqlite3.Connection) -> None:
    with _CONNECTION_LOCK:
        try:
            _OPEN_CONNECTIONS.remove(conn)
        except ValueError:
            pass
    try:
        conn.close()
    except sqlite3.Error:
        pass


def _ensure_initialized() -> None:
    global _INITIALIZED_DB_PATH
    if _INITIALIZED_DB_PATH == DB_PATH and DB_PATH.exists():
        return
    with _INIT_LOCK:
        if _INITIALIZED_DB_PATH == DB_PATH and DB_PATH.exists():
            return
        conn = sqlite3.connect(DB_PATH, timeout=_DB_TIMEOUT_SECONDS)
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout={int(_DB_TIMEOUT_SECONDS * 1000)}")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            conn.executescript(_SCHEMA)
            _apply_migrations(conn)
            _migrate_synced_game_ids(conn)
            _apply_indexes(conn)
            _recover_incomplete_jobs(conn)
            _set_schema_version(conn, SCHEMA_VERSION)
            conn.commit()
            _INITIALIZED_DB_PATH = DB_PATH
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _apply_migrations(conn: sqlite3.Connection) -> None:
    for sql in _MIGRATIONS:
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass


def _apply_indexes(conn: sqlite3.Connection) -> None:
    for sql in _INDEXES:
        conn.execute(sql)


def _recover_incomplete_jobs(conn: sqlite3.Connection) -> None:
    finished_at = now_iso()
    analysis_updated = conn.execute(
        """
        UPDATE analysis_runs
        SET status='cancelled',
            cancel_requested=1,
            finished_at=COALESCE(finished_at, ?),
            error=COALESCE(NULLIF(error, ''), ?)
        WHERE status IN ('queued', 'running')
        """,
        (finished_at, _INTERRUPTED_ANALYSIS_ERROR),
    ).rowcount
    sync_updated = conn.execute(
        """
        UPDATE sync_runs
        SET status='error',
            finished_at=COALESCE(finished_at, ?),
            error=COALESCE(NULLIF(error, ''), ?)
        WHERE status='running'
        """,
        (finished_at, _INTERRUPTED_SYNC_ERROR),
    ).rowcount
    conn.execute(
        """
        UPDATE opponent_sync_runs
        SET status='error',
            finished_at=COALESCE(finished_at, ?),
            error=COALESCE(NULLIF(error, ''), ?)
        WHERE status='running'
        """,
        (finished_at, _INTERRUPTED_SYNC_ERROR),
    )
    if analysis_updated:
        conn.execute(
            "INSERT INTO app_logs (created_at, level, scope, message, details) VALUES (?,?,?,?,?)",
            (
                now_iso(),
                "warn",
                "system",
                "Recovered interrupted analysis jobs on startup",
                json.dumps({"jobs": analysis_updated}),
            ),
        )
    if sync_updated:
        conn.execute(
            "INSERT INTO app_logs (created_at, level, scope, message, details) VALUES (?,?,?,?,?)",
            (
                now_iso(),
                "warn",
                "system",
                "Recovered interrupted sync jobs on startup",
                json.dumps({"jobs": sync_updated}),
            ),
        )


def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ("schema_version", str(version)),
    )


def _migrate_synced_game_ids(conn: sqlite3.Connection) -> None:
    cols = conn.execute("PRAGMA table_info(synced_game_ids)").fetchall()
    if not cols:
        return

    names = {row["name"] for row in cols}
    pk_cols = [row["name"] for row in sorted((row for row in cols if row["pk"]), key=lambda row: row["pk"])]
    wanted_pk = ["platform", "username", "color", "game_id"]
    if names == {"platform", "username", "game_id", "color", "added_at"} and pk_cols == wanted_pk:
        return

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS synced_game_ids_new (
            platform TEXT NOT NULL,
            username TEXT NOT NULL,
            game_id  TEXT NOT NULL,
            color    TEXT NOT NULL,
            added_at TEXT NOT NULL,
            PRIMARY KEY (platform, username, color, game_id)
        )
        """
    )
    if "username" in names:
        conn.execute(
            """
            INSERT OR IGNORE INTO synced_game_ids_new (platform, username, game_id, color, added_at)
            SELECT platform, COALESCE(username, ''), game_id, color, added_at
            FROM synced_game_ids
            """
        )
    else:
        conn.execute(
            """
            INSERT OR IGNORE INTO synced_game_ids_new (platform, username, game_id, color, added_at)
            SELECT platform, '', game_id, color, added_at
            FROM synced_game_ids
            """
        )
    conn.execute("DROP TABLE synced_game_ids")
    conn.execute("ALTER TABLE synced_game_ids_new RENAME TO synced_game_ids")


# ── PGN files ──────────────────────────────────────────────────────────────

def upsert_pgn(color: str, content: str, game_count: int, *, reset_analysis: bool = True) -> None:
    with get_db() as db:
        db.execute(
            "INSERT INTO pgn_files (color, content, game_count, uploaded_at) VALUES (?,?,?,?) "
            "ON CONFLICT(color) DO UPDATE SET content=excluded.content, "
            "game_count=excluded.game_count, uploaded_at=excluded.uploaded_at",
            (color, content, game_count, now_iso()),
        )
        if reset_analysis:
            db.execute("DELETE FROM analysis_checkpoints WHERE color=?", (color,))
            db.execute("DELETE FROM analysis_pair_state WHERE color=?", (color,))
            db.execute("DELETE FROM analysis_eval_cache WHERE color=?", (color,))
            db.execute(
                "DELETE FROM mistakes WHERE color=? AND mastered=0 AND snoozed=0",
                (color,),
            )


def get_pgn(color: str) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute("SELECT * FROM pgn_files WHERE color=?", (color,)).fetchone()
        return dict(row) if row else None


def delete_pgn(color: str) -> None:
    with get_db() as db:
        db.execute("DELETE FROM pgn_files WHERE color=?", (color,))
        db.execute("DELETE FROM analysis_checkpoints WHERE color=?", (color,))
        db.execute("DELETE FROM analysis_pair_state WHERE color=?", (color,))
        db.execute("DELETE FROM analysis_eval_cache WHERE color=?", (color,))
        db.execute(
            "DELETE FROM mistakes WHERE color=? AND mastered=0 AND snoozed=0",
            (color,),
        )


# ── Analysis runs ──────────────────────────────────────────────────────────

def start_run(color: str, progress: int = 0, total: int = 0) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO analysis_runs (color, status, queued_at, progress, progress_total) VALUES (?,?,?,?,?)",
            (color, "queued", now_iso(), progress, total),
        )
        return int(cur.lastrowid)


def latest_run(color: str) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM analysis_runs WHERE color=? ORDER BY id DESC LIMIT 1",
            (color,),
        ).fetchone()
        return _row_to_analysis_run(row) if row else None


def latest_active_run(color: str) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM analysis_runs WHERE color=? AND status IN ('queued', 'running') "
            "ORDER BY id DESC LIMIT 1",
            (color,),
        ).fetchone()
        return _row_to_analysis_run(row) if row else None


def mark_run_started(run_id: int) -> bool:
    with get_db() as db:
        cur = db.execute(
            "UPDATE analysis_runs SET status='running', started_at=?, error=NULL "
            "WHERE id=? AND status='queued' AND cancel_requested=0",
            (now_iso(), run_id),
        )
        return cur.rowcount > 0


def run_cancel_requested(run_id: int) -> bool:
    with get_db() as db:
        row = db.execute(
            "SELECT cancel_requested FROM analysis_runs WHERE id=?",
            (run_id,),
        ).fetchone()
        return bool(row and row["cancel_requested"])


def cancel_run(run_id: int) -> bool:
    with get_db() as db:
        row = db.execute(
            "SELECT status FROM analysis_runs WHERE id=?",
            (run_id,),
        ).fetchone()
        if not row:
            return False
        status = row["status"]
        if status == "queued":
            cur = db.execute(
                "UPDATE analysis_runs SET status='cancelled', cancel_requested=1, finished_at=?, error=NULL "
                "WHERE id=? AND status='queued'",
                (now_iso(), run_id),
            )
            return cur.rowcount > 0
        if status == "running":
            cur = db.execute(
                "UPDATE analysis_runs SET cancel_requested=1 WHERE id=? AND status='running'",
                (run_id,),
            )
            return cur.rowcount > 0
        return False


def finish_run(run_id: int, status: str = "done", error: Optional[str] = None) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE analysis_runs SET status=?, finished_at=?, error=? WHERE id=?",
            (status, now_iso(), error, run_id),
        )


def update_run_progress(run_id: int, done: int, total: int) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE analysis_runs SET progress=?, progress_total=? WHERE id=?",
            (done, total, run_id),
        )


def run_queue_position(run_id: int) -> int:
    with get_db() as db:
        row = db.execute(
            "SELECT status FROM analysis_runs WHERE id=?",
            (run_id,),
        ).fetchone()
        if not row or row["status"] != "queued":
            return 0
        return int(
            db.execute(
                "SELECT COUNT(*) FROM analysis_runs WHERE status='queued' AND id<=?",
                (run_id,),
            ).fetchone()[0]
        )


def get_analysis_checkpoint(color: str) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM analysis_checkpoints WHERE color=?",
            (color,),
        ).fetchone()
        return _row_to_analysis_checkpoint(row) if row else None


def upsert_analysis_checkpoint(
    color: str,
    source_fingerprint: str,
    total_games: int,
    processed_games: int,
    completed: bool,
) -> None:
    with get_db() as db:
        db.execute(
            "INSERT INTO analysis_checkpoints "
            "(color, source_fingerprint, total_games, processed_games, completed, updated_at) "
            "VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(color) DO UPDATE SET "
            "source_fingerprint=excluded.source_fingerprint, "
            "total_games=excluded.total_games, "
            "processed_games=excluded.processed_games, "
            "completed=excluded.completed, "
            "updated_at=excluded.updated_at",
            (
                color,
                source_fingerprint,
                int(total_games),
                int(processed_games),
                1 if completed else 0,
                now_iso(),
            ),
        )


def clear_analysis_state(color: str) -> None:
    with get_db() as db:
        db.execute("DELETE FROM analysis_checkpoints WHERE color=?", (color,))
        db.execute("DELETE FROM analysis_pair_state WHERE color=?", (color,))
        db.execute("DELETE FROM analysis_eval_cache WHERE color=?", (color,))


def clear_active_mistakes(color: str) -> None:
    with get_db() as db:
        db.execute(
            "DELETE FROM mistakes WHERE color=? AND mastered=0 AND snoozed=0",
            (color,),
        )


def clear_analysis_workspace(color: str) -> None:
    with get_db() as db:
        db.execute("DELETE FROM analysis_checkpoints WHERE color=?", (color,))
        db.execute("DELETE FROM analysis_pair_state WHERE color=?", (color,))
        db.execute("DELETE FROM analysis_eval_cache WHERE color=?", (color,))
        db.execute(
            "DELETE FROM mistakes WHERE color=? AND mastered=0 AND snoozed=0",
            (color,),
        )


def apply_pair_batch(color: str, items: list[dict[str, Any]]) -> None:
    if not items:
        return
    with get_db() as db:
        db.executemany(
            "INSERT INTO analysis_pair_state "
            "(color, pos_key, user_move, fen, pair_count, opening_eco, opening_name, move_list) "
            "VALUES (?,?,?,?,?,?,?,?) "
            "ON CONFLICT(color, pos_key, user_move) DO UPDATE SET "
            "pair_count=analysis_pair_state.pair_count + excluded.pair_count, "
            "fen=excluded.fen, "
            "opening_eco=COALESCE(analysis_pair_state.opening_eco, excluded.opening_eco), "
            "opening_name=COALESCE(analysis_pair_state.opening_name, excluded.opening_name), "
            "move_list=COALESCE(analysis_pair_state.move_list, excluded.move_list)",
            [
                (
                    color,
                    item["pos_key"],
                    item["user_move"],
                    item["fen"],
                    int(item["pair_count"]),
                    item.get("opening_eco"),
                    item.get("opening_name"),
                    item.get("move_list"),
                )
                for item in items
            ],
        )


def get_pair_states(color: str, keys: list[tuple[str, str]]) -> dict[tuple[str, str], dict[str, Any]]:
    if not keys:
        return {}
    placeholders = ",".join(["(?, ?)"] * len(keys))
    params: list[Any] = [color]
    for pos_key, user_move in keys:
        params.extend([pos_key, user_move])
    sql = (
        "SELECT * FROM analysis_pair_state WHERE color=? AND (pos_key, user_move) IN "
        f"({placeholders})"
    )
    with get_db() as db:
        rows = db.execute(sql, params).fetchall()
        return {
            (row["pos_key"], row["user_move"]): dict(row)
            for row in rows
        }


def get_eval_cache(color: str, pos_key: str) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM analysis_eval_cache WHERE color=? AND pos_key=?",
            (color, pos_key),
        ).fetchone()
        return _row_to_eval_cache(row) if row else None


def upsert_eval_cache(color: str, pos_key: str, fen: str, eval_cp: Optional[int], top_moves: list[str]) -> None:
    with get_db() as db:
        db.execute(
            "INSERT INTO analysis_eval_cache (color, pos_key, fen, eval_cp, top_moves, updated_at) "
            "VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(color, pos_key) DO UPDATE SET "
            "fen=excluded.fen, eval_cp=excluded.eval_cp, top_moves=excluded.top_moves, updated_at=excluded.updated_at",
            (color, pos_key, fen, eval_cp, json.dumps(top_moves), now_iso()),
        )


# ── Mistakes ───────────────────────────────────────────────────────────────

def replace_mistakes(color: str, items: list[dict[str, Any]]) -> None:
    with get_db() as db:
        snoozed_keys = {
            (row["fen"], row["user_move"])
            for row in db.execute(
                "SELECT fen, user_move FROM mistakes WHERE color=? AND snoozed=1 AND mastered=0",
                (color,),
            ).fetchall()
        }
        db.execute("DELETE FROM mistakes WHERE color=? AND mastered=0 AND snoozed=0", (color,))
        ts = now_iso()
        db.executemany(
            "INSERT INTO mistakes "
            "(color, fen, user_move, top_moves, avg_cp_loss, pair_count, opening_eco, opening_name, move_list, analyzed_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    color,
                    m["fen"],
                    m["user_move"],
                    json.dumps(m.get("top_moves", [])),
                    int(m["avg_cp_loss"]),
                    int(m["pair_count"]),
                    m.get("opening_eco"),
                    m.get("opening_name"),
                    m.get("move_list"),
                    ts,
                )
                for m in items
                if (m["fen"], m["user_move"]) not in snoozed_keys
            ],
        )


def get_mistakes(color: str) -> list[dict[str, Any]]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM mistakes WHERE color=? AND mastered=0 AND snoozed=0 "
            "ORDER BY pair_count DESC, avg_cp_loss DESC",
            (color,),
        ).fetchall()
        mistakes = [_row_to_mistake(row) for row in rows]
        if mistakes:
            ids = [m["id"] for m in mistakes]
            placeholders = ",".join("?" * len(ids))
            stats_rows = db.execute(
                f"SELECT mistake_id, COUNT(*) as total, SUM(correct) as correct "
                f"FROM mistake_attempts WHERE mistake_id IN ({placeholders}) GROUP BY mistake_id",
                ids,
            ).fetchall()
            stats_map = {int(r["mistake_id"]): r for r in stats_rows}
            for m in mistakes:
                stats = stats_map.get(m["id"])
                total = int(stats["total"] or 0) if stats else 0
                correct = int(stats["correct"] or 0) if stats else 0
                m["practice_total"] = total
                m["practice_correct"] = correct
                m["practice_rate"] = round(correct / total, 2) if total > 0 else None
        return mistakes


def get_mastered(color: str) -> list[dict[str, Any]]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM mistakes WHERE color=? AND mastered=1 ORDER BY mastered_at DESC",
            (color,),
        ).fetchall()
        return [_row_to_mistake(row) for row in rows]


def get_snoozed(color: str) -> list[dict[str, Any]]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM mistakes WHERE color=? AND snoozed=1 AND mastered=0 ORDER BY snoozed_at DESC",
            (color,),
        ).fetchall()
        return [_row_to_mistake(row) for row in rows]


def master_mistake(mistake_id: int) -> bool:
    with get_db() as db:
        cur = db.execute(
            "UPDATE mistakes SET mastered=1, mastered_at=?, snoozed=0, snoozed_at=NULL "
            "WHERE id=? AND mastered=0",
            (now_iso(), mistake_id),
        )
        return cur.rowcount > 0


def restore_mistake(mistake_id: int) -> bool:
    with get_db() as db:
        cur = db.execute(
            "UPDATE mistakes SET mastered=0, mastered_at=NULL WHERE id=? AND mastered=1",
            (mistake_id,),
        )
        return cur.rowcount > 0


def snooze_mistake(mistake_id: int) -> bool:
    with get_db() as db:
        cur = db.execute(
            "UPDATE mistakes SET snoozed=1, snoozed_at=? WHERE id=? AND mastered=0 AND snoozed=0",
            (now_iso(), mistake_id),
        )
        return cur.rowcount > 0


def unsnooze_mistake(mistake_id: int) -> bool:
    with get_db() as db:
        cur = db.execute(
            "UPDATE mistakes SET snoozed=0, snoozed_at=NULL WHERE id=? AND mastered=0 AND snoozed=1",
            (mistake_id,),
        )
        return cur.rowcount > 0


def count_active_mistakes(color: str) -> int:
    with get_db() as db:
        return int(
            db.execute(
                "SELECT COUNT(*) FROM mistakes WHERE color=? AND mastered=0 AND snoozed=0",
                (color,),
            ).fetchone()[0]
        )


def count_mastered(color: str) -> int:
    with get_db() as db:
        return int(
            db.execute(
                "SELECT COUNT(*) FROM mistakes WHERE color=? AND mastered=1",
                (color,),
            ).fetchone()[0]
        )


def count_snoozed(color: str) -> int:
    with get_db() as db:
        return int(
            db.execute(
                "SELECT COUNT(*) FROM mistakes WHERE color=? AND mastered=0 AND snoozed=1",
                (color,),
            ).fetchone()[0]
        )


def upsert_mistake_record(color: str, item: dict[str, Any]) -> None:
    with get_db() as db:
        row = db.execute(
            "SELECT id, mastered, snoozed FROM mistakes WHERE color=? AND fen=? AND user_move=? "
            "ORDER BY mastered DESC, snoozed DESC, id DESC LIMIT 1",
            (color, item["fen"], item["user_move"]),
        ).fetchone()
        payload = (
            json.dumps(item.get("top_moves", [])),
            int(item["avg_cp_loss"]),
            int(item["pair_count"]),
            item.get("opening_eco"),
            item.get("opening_name"),
            item.get("move_list"),
            now_iso(),
        )
        if row:
            db.execute(
                "UPDATE mistakes SET top_moves=?, avg_cp_loss=?, pair_count=?, opening_eco=?, opening_name=?, "
                "move_list=COALESCE(move_list, ?), analyzed_at=? "
                "WHERE id=?",
                (*payload, row["id"]),
            )
            return
        db.execute(
            "INSERT INTO mistakes "
            "(color, fen, user_move, top_moves, avg_cp_loss, pair_count, opening_eco, opening_name, move_list, analyzed_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (color, item["fen"], item["user_move"], *payload),
        )


def remove_active_mistake(color: str, fen: str, user_move: str) -> None:
    with get_db() as db:
        db.execute(
            "DELETE FROM mistakes WHERE color=? AND fen=? AND user_move=? AND mastered=0 AND snoozed=0",
            (color, fen, user_move),
        )


# ── Sync configs ───────────────────────────────────────────────────────────

def upsert_sync_config(color: str, platform: str, username: str) -> int:
    with get_db() as db:
        db.execute(
            "INSERT INTO sync_configs (color, platform, username, created_at) VALUES (?,?,?,?) "
            "ON CONFLICT(color, platform) DO UPDATE SET username=excluded.username",
            (color, platform, username, now_iso()),
        )
        row = db.execute(
            "SELECT id FROM sync_configs WHERE color=? AND platform=?",
            (color, platform),
        ).fetchone()
        return int(row["id"])


def get_sync_config(config_id: int) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute("SELECT * FROM sync_configs WHERE id=?", (config_id,)).fetchone()
        return dict(row) if row else None


def delete_sync_config(config_id: int) -> bool:
    with get_db() as db:
        cur = db.execute("DELETE FROM sync_configs WHERE id=?", (config_id,))
        db.execute("DELETE FROM sync_runs WHERE config_id=?", (config_id,))
        return cur.rowcount > 0


def list_sync_configs() -> list[dict[str, Any]]:
    with get_db() as db:
        configs = [dict(row) for row in db.execute("SELECT * FROM sync_configs ORDER BY id").fetchall()]
        for cfg in configs:
            run_row = db.execute(
                "SELECT * FROM sync_runs WHERE config_id=? ORDER BY id DESC LIMIT 1",
                (cfg["id"],),
            ).fetchone()
            cfg["latest_run"] = _row_to_sync_run(run_row) if run_row else None
        return configs


def update_sync_config_synced(config_id: int) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE sync_configs SET last_synced_at=? WHERE id=?",
            (now_iso(), config_id),
        )


# ── Sync runs ──────────────────────────────────────────────────────────────

def start_sync_run(config_id: int) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO sync_runs (config_id, status, started_at) VALUES (?,?,?)",
            (config_id, "running", now_iso()),
        )
        return int(cur.lastrowid)


def finish_sync_run(
    run_id: int,
    games_new: int = 0,
    error: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE sync_runs SET status=?, games_new=?, finished_at=?, error=?, details=? WHERE id=?",
            (
                "error" if error else "done",
                games_new,
                now_iso(),
                error,
                json.dumps(details) if details is not None else None,
                run_id,
            ),
        )


def update_sync_run(
    run_id: int,
    *,
    games_new: Optional[int] = None,
    details: Optional[dict[str, Any]] = None,
) -> None:
    fields: list[str] = []
    values: list[Any] = []
    if games_new is not None:
        fields.append("games_new=?")
        values.append(int(games_new))
    if details is not None:
        fields.append("details=?")
        values.append(json.dumps(details))
    if not fields:
        return
    values.append(run_id)
    with get_db() as db:
        db.execute(
            f"UPDATE sync_runs SET {', '.join(fields)} WHERE id=?",
            tuple(values),
        )


def latest_sync_run(config_id: int) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM sync_runs WHERE config_id=? ORDER BY id DESC LIMIT 1",
            (config_id,),
        ).fetchone()
        return _row_to_sync_run(row) if row else None


# ── Synced game IDs ────────────────────────────────────────────────────────

def get_known_game_ids(platform: str, username: str, color: str) -> set[str]:
    with get_db() as db:
        rows = db.execute(
            "SELECT game_id FROM synced_game_ids WHERE platform=? AND username=? AND color=?",
            (platform, username, color),
        ).fetchall()
        return {row["game_id"] for row in rows}


def record_game_ids(platform: str, username: str, color: str, game_ids: list[str]) -> None:
    if not game_ids:
        return
    ts = now_iso()
    with get_db() as db:
        db.executemany(
            "INSERT OR IGNORE INTO synced_game_ids (platform, username, game_id, color, added_at) "
            "VALUES (?,?,?,?,?)",
            [(platform, username, gid, color, ts) for gid in game_ids],
        )


# ── Practice sessions ─────────────────────────────────────────────────────

def save_practice_session(color: str, correct: int, total: int, best_streak: int) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO practice_sessions (color, correct, total, best_streak, started_at, finished_at) "
            "VALUES (?,?,?,?,?,?)",
            (color, correct, total, best_streak, now_iso(), now_iso()),
        )
        return int(cur.lastrowid)


def get_practice_history(color: str, limit: int = 10) -> list[dict[str, Any]]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM practice_sessions WHERE color=? ORDER BY id DESC LIMIT ?",
            (color, limit),
        ).fetchall()
        return [dict(row) for row in rows]


# ── Mistake attempts & SM-2 ────────────────────────────────────────────────

def record_mistake_attempt(mistake_id: int, correct: bool) -> None:
    with get_db() as db:
        db.execute(
            "INSERT INTO mistake_attempts (mistake_id, correct, attempted_at) VALUES (?,?,?)",
            (mistake_id, 1 if correct else 0, now_iso()),
        )


def update_sm2(mistake_id: int, correct: bool) -> None:
    """Advance SM-2 scheduling for a mistake after a practice attempt."""
    with get_db() as db:
        row = db.execute(
            "SELECT sm2_interval, sm2_ease, sm2_reps FROM mistakes WHERE id=?",
            (mistake_id,),
        ).fetchone()
        if not row:
            return
        interval = int(row["sm2_interval"] or 1)
        ease = float(row["sm2_ease"] or 2.5)
        reps = int(row["sm2_reps"] or 0)
        quality = 5 if correct else 1
        if quality < 3:
            interval = 1
            reps = 0
        else:
            if reps == 0:
                interval = 1
            elif reps == 1:
                interval = 6
            else:
                interval = max(1, round(interval * ease))
            reps += 1
        ease = max(1.3, ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        due_at = (datetime.now(timezone.utc) + timedelta(days=interval)).date().isoformat()
        db.execute(
            "UPDATE mistakes SET sm2_interval=?, sm2_ease=?, sm2_reps=?, sm2_due_at=? WHERE id=?",
            (interval, round(ease, 3), reps, due_at, mistake_id),
        )


# ── Opening breakdown ─────────────────────────────────────────────────────

def get_opening_breakdown(color: str) -> list[dict[str, Any]]:
    """Aggregate mistakes per opening for heatmap/breakdown display."""
    with get_db() as db:
        rows = db.execute(
            """
            SELECT
                COALESCE(opening_eco, '?') AS eco,
                COALESCE(opening_name, 'Unlabeled') AS name,
                SUM(CASE WHEN mastered=0 AND snoozed=0 THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN mastered=1 THEN 1 ELSE 0 END) AS mastered_count,
                SUM(CASE WHEN snoozed=1 AND mastered=0 THEN 1 ELSE 0 END) AS snoozed_count,
                ROUND(AVG(CASE WHEN mastered=0 AND snoozed=0 THEN avg_cp_loss END)) AS avg_cp_loss,
                SUM(pair_count) AS total_occurrences
            FROM mistakes
            WHERE color=?
            GROUP BY COALESCE(opening_eco, '?'), COALESCE(opening_name, 'Unlabeled')
            ORDER BY active DESC, avg_cp_loss DESC
            """,
            (color,),
        ).fetchall()
        result = []
        for row in rows:
            d = dict(row)
            total = (d["active"] or 0) + (d["mastered_count"] or 0) + (d["snoozed_count"] or 0)
            d["total"] = total
            d["mastery_rate"] = round((d["mastered_count"] or 0) / total, 2) if total > 0 else 0.0
            d["avg_cp_loss"] = int(d["avg_cp_loss"] or 0)
            result.append(d)
        return result


# ── Practice activity calendar ────────────────────────────────────────────

def get_practice_calendar(days: int = 91) -> list[dict[str, Any]]:
    """Return per-day attempt counts for the last N days."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    with get_db() as db:
        rows = db.execute(
            """
            SELECT DATE(attempted_at) AS day, COUNT(*) AS total, SUM(correct) AS correct
            FROM mistake_attempts
            WHERE attempted_at >= ?
            GROUP BY DATE(attempted_at)
            ORDER BY day ASC
            """,
            (cutoff,),
        ).fetchall()
        return [
            {"day": row["day"], "total": int(row["total"]), "correct": int(row["correct"] or 0)}
            for row in rows
        ]


# ── App settings ──────────────────────────────────────────────────────────

def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    with get_db() as db:
        row = db.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return str(row["value"]) if row else default


def set_setting(key: str, value: str) -> None:
    with get_db() as db:
        db.execute(
            "INSERT INTO app_settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


# ── App logs ──────────────────────────────────────────────────────────────

_LOG_MAX_ROWS = int(os.environ.get("CHESS_ANALYZER_LOG_MAX_ROWS", "5000"))


def log_event(scope: str, message: str, *, level: str = "info", details: Optional[dict[str, Any]] = None) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO app_logs (created_at, level, scope, message, details) VALUES (?,?,?,?,?)",
            (
                now_iso(),
                level,
                scope,
                message,
                json.dumps(details) if details is not None else None,
            ),
        )
        row_id = int(cur.lastrowid)
        # Keep table bounded — delete oldest rows beyond the cap
        db.execute(
            "DELETE FROM app_logs WHERE id <= ("
            "  SELECT id FROM app_logs ORDER BY id DESC LIMIT 1 OFFSET ?"
            ")",
            (_LOG_MAX_ROWS - 1,),
        )
        return row_id


def list_logs(limit: int = 200) -> list[dict[str, Any]]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM app_logs ORDER BY id DESC LIMIT ?",
            (max(1, min(limit, 1000)),),
        ).fetchall()
        return [_row_to_app_log(row) for row in rows]


# ── Data management ────────────────────────────────────────────────────────

def clear_all() -> None:
    with get_db() as db:
        db.execute("DELETE FROM mistakes")
        db.execute("DELETE FROM mistake_attempts")
        db.execute("DELETE FROM pgn_files")
        db.execute("DELETE FROM analysis_runs")
        db.execute("DELETE FROM analysis_checkpoints")
        db.execute("DELETE FROM analysis_pair_state")
        db.execute("DELETE FROM analysis_eval_cache")
        db.execute("DELETE FROM sync_configs")
        db.execute("DELETE FROM sync_runs")
        db.execute("DELETE FROM synced_game_ids")
        db.execute("DELETE FROM practice_sessions")
        db.execute("DELETE FROM app_logs")


def has_active_jobs() -> bool:
    with get_db() as db:
        analysis_active = db.execute(
            "SELECT 1 FROM analysis_runs WHERE status IN ('queued', 'running') LIMIT 1"
        ).fetchone()
        sync_running = db.execute(
            "SELECT 1 FROM sync_runs WHERE status='running' LIMIT 1"
        ).fetchone()
        return bool(analysis_active or sync_running)


# ── Summary stats ──────────────────────────────────────────────────────────

def get_summary() -> dict[str, Any]:
    with get_db() as db:
        total_mistakes = int(
            db.execute("SELECT COUNT(*) FROM mistakes WHERE mastered=0 AND snoozed=0").fetchone()[0]
        )
        total_mastered = int(
            db.execute("SELECT COUNT(*) FROM mistakes WHERE mastered=1").fetchone()[0]
        )
        total_snoozed = int(
            db.execute("SELECT COUNT(*) FROM mistakes WHERE mastered=0 AND snoozed=1").fetchone()[0]
        )
        total_games = int(
            db.execute("SELECT COALESCE(SUM(game_count),0) FROM pgn_files").fetchone()[0]
        )
        queued_runs = int(
            db.execute("SELECT COUNT(*) FROM analysis_runs WHERE status='queued'").fetchone()[0]
        )
        running_runs = int(
            db.execute("SELECT COUNT(*) FROM analysis_runs WHERE status='running'").fetchone()[0]
        )
        running_syncs = int(
            db.execute("SELECT COUNT(*) FROM sync_runs WHERE status='running'").fetchone()[0]
        )
        practice_rows = db.execute(
            "SELECT SUM(correct) as c, SUM(total) as t, MAX(best_streak) as bs FROM practice_sessions"
        ).fetchone()
        return {
            "total_mistakes": total_mistakes,
            "total_mastered": total_mastered,
            "total_snoozed": total_snoozed,
            "total_games": total_games,
            "analysis_queue": queued_runs,
            "analysis_running": running_runs,
            "analysis_active": queued_runs + running_runs,
            "sync_running": running_syncs,
            "active_jobs": queued_runs + running_runs + running_syncs,
            "practice_correct": practice_rows["c"] or 0,
            "practice_total": practice_rows["t"] or 0,
            "practice_best_streak": practice_rows["bs"] or 0,
        }


def export_backup() -> dict[str, Any]:
    with get_db() as db:
        return {
            "backup_version": 2,
            "created_at": now_iso(),
            "schema_version": get_schema_version(db),
            "pgn_files": [
                dict(row)
                for row in db.execute(
                    "SELECT color, content, game_count, uploaded_at FROM pgn_files ORDER BY color"
                ).fetchall()
            ],
            "mistakes": [
                _row_to_mistake(row)
                for row in db.execute("SELECT * FROM mistakes ORDER BY id").fetchall()
            ],
            "sync_configs": [
                dict(row)
                for row in db.execute(
                    "SELECT color, platform, username, last_synced_at, created_at FROM sync_configs ORDER BY id"
                ).fetchall()
            ],
            "synced_game_ids": [
                dict(row)
                for row in db.execute(
                    "SELECT platform, username, game_id, color, added_at "
                    "FROM synced_game_ids ORDER BY platform, username, color, game_id"
                ).fetchall()
            ],
            "practice_sessions": [
                dict(row)
                for row in db.execute(
                    "SELECT color, correct, total, best_streak, started_at, finished_at "
                    "FROM practice_sessions ORDER BY id"
                ).fetchall()
            ],
        }


def import_backup(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = _normalize_backup(payload)
    with get_db() as db:
        db.execute("DELETE FROM mistakes")
        db.execute("DELETE FROM mistake_attempts")
        db.execute("DELETE FROM pgn_files")
        db.execute("DELETE FROM analysis_runs")
        db.execute("DELETE FROM analysis_checkpoints")
        db.execute("DELETE FROM analysis_pair_state")
        db.execute("DELETE FROM analysis_eval_cache")
        db.execute("DELETE FROM sync_configs")
        db.execute("DELETE FROM sync_runs")
        db.execute("DELETE FROM synced_game_ids")
        db.execute("DELETE FROM practice_sessions")
        db.execute("DELETE FROM app_logs")

        if normalized["pgn_files"]:
            db.executemany(
                "INSERT INTO pgn_files (color, content, game_count, uploaded_at) VALUES (?,?,?,?)",
                [
                    (
                        row["color"],
                        row["content"],
                        int(row["game_count"]),
                        row.get("uploaded_at") or now_iso(),
                    )
                    for row in normalized["pgn_files"]
                ],
            )

        if normalized["mistakes"]:
            db.executemany(
                "INSERT INTO mistakes "
                "(color, fen, user_move, top_moves, avg_cp_loss, pair_count, mastered, mastered_at, "
                "snoozed, snoozed_at, opening_eco, opening_name, analyzed_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                    (
                        row["color"],
                        row["fen"],
                        row["user_move"],
                        json.dumps(row.get("top_moves", [])),
                        int(row["avg_cp_loss"]),
                        int(row["pair_count"]),
                        1 if row.get("mastered") else 0,
                        row.get("mastered_at"),
                        1 if row.get("snoozed") else 0,
                        row.get("snoozed_at"),
                        row.get("opening_eco"),
                        row.get("opening_name"),
                        row.get("analyzed_at") or now_iso(),
                    )
                    for row in normalized["mistakes"]
                ],
            )

        if normalized["sync_configs"]:
            db.executemany(
                "INSERT INTO sync_configs (color, platform, username, last_synced_at, created_at) "
                "VALUES (?,?,?,?,?)",
                [
                    (
                        row["color"],
                        row["platform"],
                        row["username"],
                        row.get("last_synced_at"),
                        row.get("created_at") or now_iso(),
                    )
                    for row in normalized["sync_configs"]
                ],
            )

        if normalized["synced_game_ids"]:
            db.executemany(
                "INSERT INTO synced_game_ids (platform, username, game_id, color, added_at) VALUES (?,?,?,?,?)",
                [
                    (
                        row["platform"],
                        row.get("username", ""),
                        row["game_id"],
                        row["color"],
                        row.get("added_at") or now_iso(),
                    )
                    for row in normalized["synced_game_ids"]
                ],
            )

        if normalized["practice_sessions"]:
            db.executemany(
                "INSERT INTO practice_sessions (color, correct, total, best_streak, started_at, finished_at) "
                "VALUES (?,?,?,?,?,?)",
                [
                    (
                        row["color"],
                        int(row["correct"]),
                        int(row["total"]),
                        int(row["best_streak"]),
                        row.get("started_at") or now_iso(),
                        row.get("finished_at") or now_iso(),
                    )
                    for row in normalized["practice_sessions"]
                ],
            )

    return get_summary()


def get_schema_version(conn: Optional[sqlite3.Connection] = None) -> int:
    owns_conn = conn is None
    if owns_conn:
        _ensure_initialized()
        conn = sqlite3.connect(DB_PATH, timeout=_DB_TIMEOUT_SECONDS)
        conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()
        return int(row["value"]) if row else 0
    finally:
        if owns_conn and conn is not None:
            conn.close()


def reset_runtime_state() -> None:
    global _INITIALIZED_DB_PATH
    with _INIT_LOCK:
        _INITIALIZED_DB_PATH = None


# ── Opponents ──────────────────────────────────────────────────────────────

def create_opponent(
    name: str,
    lichess_username: Optional[str] = None,
    chesscom_username: Optional[str] = None,
) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO opponents (name, lichess_username, chesscom_username, created_at) VALUES (?,?,?,?)",
            (name.strip(), lichess_username or None, chesscom_username or None, now_iso()),
        )
        return cur.lastrowid  # type: ignore[return-value]


def get_opponent(opponent_id: int) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute("SELECT * FROM opponents WHERE id=?", (opponent_id,)).fetchone()
        if not row:
            return None
        opp = dict(row)
        run_row = db.execute(
            "SELECT * FROM opponent_sync_runs WHERE opponent_id=? ORDER BY id DESC LIMIT 1",
            (opponent_id,),
        ).fetchone()
        opp["latest_sync_run"] = _row_to_sync_run(run_row) if run_row else None
        return opp


def list_opponents() -> list[dict[str, Any]]:
    with get_db() as db:
        rows = db.execute("SELECT * FROM opponents ORDER BY name ASC").fetchall()
        result = []
        for row in rows:
            opp = dict(row)
            run_row = db.execute(
                "SELECT * FROM opponent_sync_runs WHERE opponent_id=? ORDER BY id DESC LIMIT 1",
                (opp["id"],),
            ).fetchone()
            opp["latest_sync_run"] = _row_to_sync_run(run_row) if run_row else None
            white_count = db.execute(
                "SELECT COUNT(*) FROM opponent_mistakes WHERE opponent_id=? AND color='white'",
                (opp["id"],),
            ).fetchone()[0]
            black_count = db.execute(
                "SELECT COUNT(*) FROM opponent_mistakes WHERE opponent_id=? AND color='black'",
                (opp["id"],),
            ).fetchone()[0]
            opp["mistake_count_white"] = int(white_count)
            opp["mistake_count_black"] = int(black_count)
            result.append(opp)
        return result


def update_opponent(
    opponent_id: int,
    name: str,
    lichess_username: Optional[str],
    chesscom_username: Optional[str],
) -> bool:
    with get_db() as db:
        cur = db.execute(
            "UPDATE opponents SET name=?, lichess_username=?, chesscom_username=? WHERE id=?",
            (name.strip(), lichess_username or None, chesscom_username or None, opponent_id),
        )
        return cur.rowcount > 0


def delete_opponent(opponent_id: int) -> bool:
    with get_db() as db:
        db.execute("DELETE FROM opponent_mistakes WHERE opponent_id=?", (opponent_id,))
        db.execute("DELETE FROM opponent_sync_runs WHERE opponent_id=?", (opponent_id,))
        cur = db.execute("DELETE FROM opponents WHERE id=?", (opponent_id,))
        return cur.rowcount > 0


def update_opponent_last_synced(opponent_id: int) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE opponents SET last_synced_at=? WHERE id=?",
            (now_iso(), opponent_id),
        )


# ── Opponent sync runs ────────────────────────────────────────────────────

def start_opponent_sync_run(opponent_id: int) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO opponent_sync_runs (opponent_id, status, started_at) VALUES (?,?,?)",
            (opponent_id, "running", now_iso()),
        )
        return cur.lastrowid  # type: ignore[return-value]


def finish_opponent_sync_run(
    run_id: int,
    *,
    games_new: int = 0,
    error: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
) -> None:
    status = "error" if error else "done"
    with get_db() as db:
        db.execute(
            "UPDATE opponent_sync_runs SET status=?, games_new=?, finished_at=?, error=?, details=? WHERE id=?",
            (
                status,
                games_new,
                now_iso(),
                error,
                json.dumps(details) if details else None,
                run_id,
            ),
        )


def update_opponent_sync_run(run_id: int, *, details: dict[str, Any]) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE opponent_sync_runs SET details=? WHERE id=?",
            (json.dumps(details), run_id),
        )


def latest_opponent_sync_run(opponent_id: int) -> Optional[dict[str, Any]]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM opponent_sync_runs WHERE opponent_id=? ORDER BY id DESC LIMIT 1",
            (opponent_id,),
        ).fetchone()
        return _row_to_sync_run(row) if row else None


# ── Opponent mistakes ─────────────────────────────────────────────────────

def replace_opponent_mistakes(opponent_id: int, color: str, items: list[dict[str, Any]]) -> None:
    ts = now_iso()
    with get_db() as db:
        db.execute(
            "DELETE FROM opponent_mistakes WHERE opponent_id=? AND color=?",
            (opponent_id, color),
        )
        if items:
            db.executemany(
                """INSERT INTO opponent_mistakes
                   (opponent_id, color, fen, user_move, top_moves, avg_cp_loss, pair_count,
                    opening_eco, opening_name, move_list, analyzed_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        opponent_id,
                        color,
                        m["fen"],
                        m["user_move"],
                        json.dumps(m.get("top_moves") or []),
                        int(m["avg_cp_loss"]),
                        int(m["pair_count"]),
                        m.get("opening_eco"),
                        m.get("opening_name"),
                        m.get("move_list"),
                        ts,
                    )
                    for m in items
                ],
            )


def get_opponent_mistakes(opponent_id: int, color: Optional[str] = None) -> list[dict[str, Any]]:
    with get_db() as db:
        if color:
            rows = db.execute(
                "SELECT * FROM opponent_mistakes WHERE opponent_id=? AND color=? "
                "ORDER BY pair_count DESC, avg_cp_loss DESC",
                (opponent_id, color),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM opponent_mistakes WHERE opponent_id=? "
                "ORDER BY color ASC, pair_count DESC, avg_cp_loss DESC",
                (opponent_id,),
            ).fetchall()
        return [_row_to_opponent_mistake(r) for r in rows]
    conn = getattr(_THREAD_LOCAL, "conn", None)
    if conn is not None:
        _close_connection(conn)
        _THREAD_LOCAL.conn = None
        _THREAD_LOCAL.conn_path = None
    with _CONNECTION_LOCK:
        open_conns = list(_OPEN_CONNECTIONS)
        _OPEN_CONNECTIONS.clear()
    for conn in open_conns:
        try:
            conn.close()
        except sqlite3.Error:
            pass


# ── Helpers ───────────────────────────────────────────────────────────────

def _row_to_analysis_run(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["cancel_requested"] = bool(data.get("cancel_requested"))
    return data


def _row_to_analysis_checkpoint(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["completed"] = bool(data.get("completed"))
    return data


def _row_to_eval_cache(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["top_moves"] = json.loads(data.get("top_moves") or "[]")
    return data


def _row_to_sync_run(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    raw_details = data.get("details")
    if raw_details:
        try:
            data["details"] = json.loads(raw_details)
        except json.JSONDecodeError:
            data["details"] = {"raw": raw_details}
    else:
        data["details"] = None
    return data


def _row_to_mistake(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["top_moves"] = json.loads(data["top_moves"])
    data["mastered"] = bool(data.get("mastered"))
    data["snoozed"] = bool(data.get("snoozed"))
    return data


def _row_to_opponent_mistake(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["top_moves"] = json.loads(data.get("top_moves") or "[]")
    return data


def _row_to_app_log(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    raw_details = data.get("details")
    if raw_details:
        try:
            data["details"] = json.loads(raw_details)
        except json.JSONDecodeError:
            data["details"] = {"raw": raw_details}
    else:
        data["details"] = None
    return data


def _normalize_backup(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Backup must be a JSON object")

    if payload.get("backup_version") in {1, 2}:
        return {
            "pgn_files": payload.get("pgn_files", []),
            "mistakes": payload.get("mistakes", []),
            "sync_configs": payload.get("sync_configs", []),
            "synced_game_ids": payload.get("synced_game_ids", []),
            "practice_sessions": payload.get("practice_sessions", []),
        }

    if {"white", "black"}.issubset(payload.keys()):
        mistakes: list[dict[str, Any]] = []
        for color in ("white", "black"):
            bucket = payload.get(color, {})
            for item in bucket.get("mistakes", []):
                mistakes.append({
                    **item,
                    "color": color,
                    "mastered": False,
                    "snoozed": False,
                })
            for item in bucket.get("mastered", []):
                mistakes.append({
                    **item,
                    "color": color,
                    "mastered": True,
                    "mastered_at": item.get("mastered_at"),
                    "snoozed": False,
                })
        return {
            "pgn_files": [],
            "mistakes": mistakes,
            "sync_configs": [],
            "synced_game_ids": [],
            "practice_sessions": [],
        }

    raise ValueError("Unsupported backup format")
