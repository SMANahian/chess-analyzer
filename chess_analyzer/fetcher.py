"""Fetch PGN games from Lichess and Chess.com, with incremental sync."""
from __future__ import annotations

import io
import re
import threading
from datetime import datetime, timezone
from typing import Optional

import chess.pgn
import requests

from chess_analyzer import analysis, db

_UA = {"User-Agent": "chess-analyzer/2.0 (https://github.com/chess-analyzer)"}
_LICHESS_ID = re.compile(r'\[Site "https://lichess\.org/([A-Za-z0-9]{8})(?:/.*)?"')
_CHESSCOM_ID = re.compile(r'\[(?:Link|Site) "https://www\.chess\.com/game/[^/]+/(\d+)"')


# ── Lichess ────────────────────────────────────────────────────────────────

def fetch_lichess_pgn(
    username: str,
    color: str,
    since_ms: Optional[int] = None,
    max_games: int = 500,
) -> tuple[str, list[str]]:
    """
    Download PGN games from Lichess for *username* playing as *color*.
    Uses `since` for incremental fetching (only games after last sync).
    Returns (pgn_text, list_of_game_ids).
    """
    params: dict = {
        "color":    color,
        "max":      min(max_games, 300),
        "clocks":   "false",
        "evals":    "false",
        "opening":  "false",
        "tags":     "true",
    }
    if since_ms is not None:
        params["since"] = since_ms + 1   # exclusive — don't re-fetch the last known game

    resp = requests.get(
        f"https://lichess.org/api/games/user/{username}",
        params=params,
        headers={**_UA, "Accept": "application/x-chess-pgn"},
        timeout=120,
    )
    if resp.status_code == 404:
        raise ValueError(f"Lichess user '{username}' not found")
    resp.raise_for_status()

    pgn_text = resp.text
    game_ids = _LICHESS_ID.findall(pgn_text)
    return pgn_text, game_ids


# ── Chess.com ──────────────────────────────────────────────────────────────

def fetch_chesscom_pgn(
    username: str,
    color: str,
    known_ids: set[str],
    max_games: int = 500,
) -> tuple[str, list[str]]:
    """
    Walk Chess.com monthly archives (newest first).
    Skips games already in *known_ids* and filters by *color*.
    Returns (pgn_text, list_of_new_game_ids).
    """
    archives_resp = requests.get(
        f"https://api.chess.com/pub/player/{username}/games/archives",
        headers=_UA,
        timeout=30,
    )
    if archives_resp.status_code == 404:
        raise ValueError(f"Chess.com user '{username}' not found")
    archives_resp.raise_for_status()

    archives: list[str] = archives_resp.json().get("archives", [])
    target = username.lower()
    pgn_blocks: list[str] = []
    new_ids: list[str] = []

    for archive_url in reversed(archives):      # newest month first
        if len(new_ids) >= max_games:
            break

        resp = requests.get(archive_url, headers=_UA, timeout=60)
        resp.raise_for_status()
        games = resp.json().get("games", [])

        month_all_known = True
        for game in games:
            pgn_str = game.get("pgn", "")
            if not pgn_str:
                continue

            m = _CHESSCOM_ID.search(pgn_str)
            gid = m.group(1) if m else None
            if not gid:
                continue

            if gid not in known_ids:
                month_all_known = False
                # Filter by color before storing
                pgn_io = io.StringIO(pgn_str)
                pgame = chess.pgn.read_game(pgn_io)
                if not pgame:
                    continue
                h = pgame.headers
                if color == "white" and h.get("White", "").lower() != target:
                    continue
                if color == "black" and h.get("Black", "").lower() != target:
                    continue
                pgn_blocks.append(pgn_str)
                new_ids.append(gid)

        # If every game in this archive was already known, older months will be too
        if month_all_known and known_ids:
            break

    return "\n\n".join(pgn_blocks), new_ids


# ── Background sync task ───────────────────────────────────────────────────

def sync_in_background(config_id: int) -> None:
    threading.Thread(target=_sync_task, args=(config_id,), daemon=True).start()


def _sync_task(config_id: int) -> None:
    run_id = db.start_sync_run(config_id)
    try:
        config = db.get_sync_config(config_id)
        if not config:
            raise ValueError(f"Config {config_id} not found")

        color    = config["color"]
        platform = config["platform"]
        username = config["username"]
        known    = db.get_known_game_ids(platform)

        if platform == "lichess":
            since_ms: Optional[int] = None
            if config["last_synced_at"]:
                ts = datetime.fromisoformat(config["last_synced_at"])
                since_ms = int(ts.timestamp() * 1000)
            pgn_text, fetched_ids = fetch_lichess_pgn(username, color, since_ms)
            new_ids = [i for i in fetched_ids if i not in known]
            # Trim PGN to only new games (avoid re-processing known ones)
            if len(new_ids) < len(fetched_ids):
                pgn_text = _filter_lichess_pgn(pgn_text, set(new_ids))
        else:
            pgn_text, new_ids = fetch_chesscom_pgn(username, color, known)

        if new_ids:
            existing = db.get_pgn(color)
            base     = existing["content"] if existing else ""
            merged   = (base + "\n\n" + pgn_text).strip()
            cleaned, count = analysis.parse_and_truncate(merged)
            db.upsert_pgn(color, cleaned, count)
            db.record_game_ids(platform, color, new_ids)

        db.update_sync_config_synced(config_id)
        db.finish_sync_run(run_id, games_new=len(new_ids))

    except Exception as exc:
        db.finish_sync_run(run_id, games_new=0, error=str(exc))


def _filter_lichess_pgn(pgn_text: str, keep_ids: set[str]) -> str:
    """Return only the PGN game blocks whose Lichess ID is in *keep_ids*."""
    if not keep_ids:
        return ""
    blocks: list[str] = []
    current_block: list[str] = []
    current_id: Optional[str] = None

    for line in pgn_text.splitlines(keepends=True):
        m = _LICHESS_ID.search(line)
        if m:
            current_id = m.group(1)
        current_block.append(line)
        # Empty line signals end of a PGN game header/move block
        if not line.strip() and current_block:
            text = "".join(current_block)
            if current_id and current_id in keep_ids:
                blocks.append(text)
            current_block = []
            current_id = None

    if current_block and current_id and current_id in keep_ids:
        blocks.append("".join(current_block))

    return "\n".join(blocks)
