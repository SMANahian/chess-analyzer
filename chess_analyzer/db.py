"""SQLite database layer."""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generator, Optional

DATA_DIR = Path(os.environ.get("CHESS_ANALYZER_DATA", Path.home() / ".chess-analyzer"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "chess_analyzer.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pgn_files (
    color       TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    game_count  INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    color       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    started_at  TEXT,
    finished_at TEXT,
    error       TEXT
);

CREATE TABLE IF NOT EXISTS mistakes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    color       TEXT NOT NULL,
    fen         TEXT NOT NULL,
    user_move   TEXT NOT NULL,
    top_moves   TEXT NOT NULL,
    avg_cp_loss INTEGER NOT NULL,
    pair_count  INTEGER NOT NULL,
    mastered    INTEGER NOT NULL DEFAULT 0,
    mastered_at TEXT,
    analyzed_at TEXT NOT NULL
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
    error       TEXT
);

CREATE TABLE IF NOT EXISTS synced_game_ids (
    platform TEXT NOT NULL,
    game_id  TEXT NOT NULL,
    color    TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (platform, game_id)
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        conn.executescript(_SCHEMA)
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── PGN files ──────────────────────────────────────────────────────────────

def upsert_pgn(color: str, content: str, game_count: int) -> None:
    with get_db() as db:
        db.execute(
            "INSERT INTO pgn_files (color, content, game_count, uploaded_at) VALUES (?,?,?,?) "
            "ON CONFLICT(color) DO UPDATE SET content=excluded.content, "
            "game_count=excluded.game_count, uploaded_at=excluded.uploaded_at",
            (color, content, game_count, now_iso()),
        )


def get_pgn(color: str) -> Optional[dict]:
    with get_db() as db:
        row = db.execute("SELECT * FROM pgn_files WHERE color=?", (color,)).fetchone()
        return dict(row) if row else None


def delete_pgn(color: str) -> None:
    with get_db() as db:
        db.execute("DELETE FROM pgn_files WHERE color=?", (color,))


# ── Analysis runs ──────────────────────────────────────────────────────────

def start_run(color: str) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO analysis_runs (color, status, started_at) VALUES (?,?,?)",
            (color, "running", now_iso()),
        )
        return cur.lastrowid  # type: ignore[return-value]


def finish_run(run_id: int, error: Optional[str] = None) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE analysis_runs SET status=?, finished_at=?, error=? WHERE id=?",
            ("error" if error else "done", now_iso(), error, run_id),
        )


def latest_run(color: str) -> Optional[dict]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM analysis_runs WHERE color=? ORDER BY id DESC LIMIT 1",
            (color,),
        ).fetchone()
        return dict(row) if row else None


# ── Mistakes ───────────────────────────────────────────────────────────────

def replace_mistakes(color: str, items: list[dict[str, Any]]) -> None:
    with get_db() as db:
        db.execute("DELETE FROM mistakes WHERE color=? AND mastered=0", (color,))
        ts = now_iso()
        db.executemany(
            "INSERT INTO mistakes (color, fen, user_move, top_moves, avg_cp_loss, pair_count, analyzed_at) "
            "VALUES (?,?,?,?,?,?,?)",
            [
                (color, m["fen"], m["user_move"], json.dumps(m.get("top_moves", [])),
                 int(m["avg_cp_loss"]), int(m["pair_count"]), ts)
                for m in items
            ],
        )


def get_mistakes(color: str) -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM mistakes WHERE color=? AND mastered=0 ORDER BY pair_count DESC, avg_cp_loss DESC",
            (color,),
        ).fetchall()
        return [_row_to_mistake(r) for r in rows]


def get_mastered(color: str) -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM mistakes WHERE color=? AND mastered=1 ORDER BY mastered_at DESC",
            (color,),
        ).fetchall()
        return [_row_to_mistake(r) for r in rows]


def master_mistake(mistake_id: int) -> bool:
    with get_db() as db:
        cur = db.execute(
            "UPDATE mistakes SET mastered=1, mastered_at=? WHERE id=? AND mastered=0",
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


# ── Sync configs ───────────────────────────────────────────────────────────

def upsert_sync_config(color: str, platform: str, username: str) -> int:
    """Create or update a sync config. Returns the config id."""
    with get_db() as db:
        db.execute(
            "INSERT INTO sync_configs (color, platform, username, created_at) VALUES (?,?,?,?) "
            "ON CONFLICT(color, platform) DO UPDATE SET username=excluded.username",
            (color, platform, username, now_iso()),
        )
        row = db.execute(
            "SELECT id FROM sync_configs WHERE color=? AND platform=?", (color, platform)
        ).fetchone()
        return row["id"]


def get_sync_config(config_id: int) -> Optional[dict]:
    with get_db() as db:
        row = db.execute("SELECT * FROM sync_configs WHERE id=?", (config_id,)).fetchone()
        return dict(row) if row else None


def list_sync_configs() -> list[dict]:
    """Return all sync configs with their latest run status attached."""
    with get_db() as db:
        configs = [dict(r) for r in db.execute("SELECT * FROM sync_configs ORDER BY id").fetchall()]
        for cfg in configs:
            run = db.execute(
                "SELECT * FROM sync_runs WHERE config_id=? ORDER BY id DESC LIMIT 1",
                (cfg["id"],),
            ).fetchone()
            cfg["latest_run"] = dict(run) if run else None
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
        return cur.lastrowid  # type: ignore[return-value]


def finish_sync_run(run_id: int, games_new: int = 0, error: Optional[str] = None) -> None:
    with get_db() as db:
        db.execute(
            "UPDATE sync_runs SET status=?, games_new=?, finished_at=?, error=? WHERE id=?",
            ("error" if error else "done", games_new, now_iso(), error, run_id),
        )


def latest_sync_run(config_id: int) -> Optional[dict]:
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM sync_runs WHERE config_id=? ORDER BY id DESC LIMIT 1",
            (config_id,),
        ).fetchone()
        return dict(row) if row else None


# ── Synced game IDs ────────────────────────────────────────────────────────

def get_known_game_ids(platform: str) -> set[str]:
    with get_db() as db:
        rows = db.execute(
            "SELECT game_id FROM synced_game_ids WHERE platform=?", (platform,)
        ).fetchall()
        return {r["game_id"] for r in rows}


def record_game_ids(platform: str, color: str, game_ids: list[str]) -> None:
    ts = now_iso()
    with get_db() as db:
        db.executemany(
            "INSERT OR IGNORE INTO synced_game_ids (platform, game_id, color, added_at) VALUES (?,?,?,?)",
            [(platform, gid, color, ts) for gid in game_ids],
        )


# ── Data management ────────────────────────────────────────────────────────

def clear_all() -> None:
    with get_db() as db:
        db.execute("DELETE FROM mistakes")
        db.execute("DELETE FROM pgn_files")
        db.execute("DELETE FROM analysis_runs")
        db.execute("DELETE FROM sync_configs")
        db.execute("DELETE FROM sync_runs")
        db.execute("DELETE FROM synced_game_ids")


# ── Helpers ───────────────────────────────────────────────────────────────

def _row_to_mistake(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["top_moves"] = json.loads(d["top_moves"])
    return d
