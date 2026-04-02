"""Fetch PGN games from Lichess and Chess.com, with incremental sync."""
from __future__ import annotations

import io
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

import chess.pgn
import requests

from chess_analyzer import analysis, db
from chess_analyzer.engine import engine_status, start_engine

_UA = {"User-Agent": "chess-analyzer/2.1 (https://github.com/SMANahian/chess-analyzer)"}
_LICHESS_ID = re.compile(r'\[Site "https://lichess\.org/([A-Za-z0-9]{8})(?:/.*)?"')
_CHESSCOM_ID = re.compile(r'\[(?:Link|Site) "https://www\.chess\.com/game/[^/]+/(\d+)"')

_SYNC_RETRIES = int(os.environ.get("SYNC_HTTP_RETRIES", "3"))
_SYNC_BACKOFF_SECONDS = float(os.environ.get("SYNC_HTTP_BACKOFF_SECONDS", "1.5"))
_SYNC_BATCH_SIZE = max(1, int(os.environ.get("SYNC_BATCH_SIZE", "100")))
_LICHESS_MAX_GAMES = int(os.environ.get("LICHESS_SYNC_MAX_GAMES", str(analysis.MAX_GAMES)))
_CHESSCOM_MAX_GAMES = int(os.environ.get("CHESSCOM_SYNC_MAX_GAMES", str(analysis.MAX_GAMES)))


def fetch_lichess_pgn(
    username: str,
    color: str,
    since_ms: Optional[int] = None,
    max_games: int = _LICHESS_MAX_GAMES,
) -> tuple[str, list[str], dict[str, Any]]:
    batches = list(iter_lichess_pgn_batches(username, color, since_ms=since_ms, max_games=max_games))
    return _combine_batches("lichess", max_games, batches)


def fetch_chesscom_pgn(
    username: str,
    color: str,
    known_ids: set[str],
    max_games: int = _CHESSCOM_MAX_GAMES,
) -> tuple[str, list[str], dict[str, Any]]:
    batches = list(iter_chesscom_pgn_batches(username, color, known_ids, max_games=max_games))
    return _combine_batches("chesscom", max_games, batches)


def iter_lichess_pgn_batches(
    username: str,
    color: str,
    *,
    since_ms: Optional[int] = None,
    max_games: int = _LICHESS_MAX_GAMES,
    batch_size: int = _SYNC_BATCH_SIZE,
) -> Iterator[dict[str, Any]]:
    remaining = max_games
    until_ms: Optional[int] = None
    pages = 0

    while remaining > 0:
        page_limit = min(remaining, batch_size, 300)
        params: dict[str, Any] = {
            "color": color,
            "max": page_limit,
            "clocks": "false",
            "evals": "false",
            "opening": "false",
            "tags": "true",
            "sort": "dateDesc",
        }
        if since_ms is not None:
            params["since"] = since_ms + 1
        if until_ms is not None:
            params["until"] = until_ms

        resp = _request(
            "GET",
            f"https://lichess.org/api/games/user/{username}",
            params=params,
            headers={**_UA, "Accept": "application/x-chess-pgn"},
            timeout=120,
            user_label=f"Lichess user '{username}'",
        )
        games = _parse_lichess_games(resp.text)
        if not games:
            break

        pages += 1
        selected = games[:page_limit]
        yield {
            "platform": "lichess",
            "pgn_text": "\n\n".join(game["pgn"] for game in selected).strip(),
            "game_ids": [game["id"] for game in selected],
            "raw_count": len(selected),
            "pages_fetched": pages,
            "effective_limit": page_limit,
            "oldest_ms": selected[-1]["utc_ms"] if selected else None,
        }

        remaining -= len(selected)
        if len(selected) < page_limit:
            break
        oldest_ms = selected[-1]["utc_ms"]
        if oldest_ms is None:
            break
        until_ms = oldest_ms - 1


def iter_chesscom_pgn_batches(
    username: str,
    color: str,
    known_ids: set[str],
    *,
    max_games: int = _CHESSCOM_MAX_GAMES,
    batch_size: int = _SYNC_BATCH_SIZE,
) -> Iterator[dict[str, Any]]:
    archives_resp = _request(
        "GET",
        f"https://api.chess.com/pub/player/{username}/games/archives",
        headers=_UA,
        timeout=30,
        user_label=f"Chess.com user '{username}'",
    )

    archives: list[str] = archives_resp.json().get("archives", [])
    target = username.lower()
    emitted = 0
    archives_scanned = 0
    chunk_blocks: list[str] = []
    chunk_ids: list[str] = []

    for archive_url in reversed(archives):
        if emitted >= max_games:
            break

        archives_scanned += 1
        resp = _request(
            "GET",
            archive_url,
            headers=_UA,
            timeout=60,
            user_label=f"Chess.com archives for '{username}'",
        )
        games = resp.json().get("games", [])
        month_all_known = True

        for game in games:
            if emitted >= max_games:
                break

            pgn_str = game.get("pgn", "")
            if not pgn_str:
                continue

            match = _CHESSCOM_ID.search(pgn_str)
            gid = match.group(1) if match else None
            if not gid:
                continue

            if gid in known_ids:
                continue

            month_all_known = False
            pgame = chess.pgn.read_game(io.StringIO(pgn_str))
            if not pgame:
                continue
            headers = pgame.headers
            if color == "white" and headers.get("White", "").lower() != target:
                continue
            if color == "black" and headers.get("Black", "").lower() != target:
                continue

            chunk_blocks.append(pgn_str.strip())
            chunk_ids.append(gid)
            emitted += 1
            if len(chunk_ids) >= batch_size:
                yield {
                    "platform": "chesscom",
                    "pgn_text": "\n\n".join(chunk_blocks).strip(),
                    "game_ids": chunk_ids[:],
                    "raw_count": len(chunk_ids),
                    "archives_scanned": archives_scanned,
                    "archives_available": len(archives),
                }
                chunk_blocks = []
                chunk_ids = []

        if month_all_known and known_ids:
            break

    if chunk_ids:
        yield {
            "platform": "chesscom",
            "pgn_text": "\n\n".join(chunk_blocks).strip(),
            "game_ids": chunk_ids[:],
            "raw_count": len(chunk_ids),
            "archives_scanned": archives_scanned,
            "archives_available": len(archives),
        }


def sync_in_background(config_id: int, max_games: Optional[int] = None, full_resync: bool = False) -> None:
    threading.Thread(target=_sync_task, args=(config_id, max_games, full_resync), daemon=True).start()


def sync_opponent_in_background(opponent_id: int, max_games: int = 500) -> None:
    threading.Thread(target=_opponent_sync_task, args=(opponent_id, max_games), daemon=True).start()


def _opponent_sync_task(opponent_id: int, max_games: int) -> None:
    run_id = db.start_opponent_sync_run(opponent_id)
    try:
        opponent = db.get_opponent(opponent_id)
        if not opponent:
            raise ValueError(f"Opponent {opponent_id} not found")

        details: dict[str, Any] = {"games_fetched": 0, "analysis_status": "fetching"}
        pgn_by_color: dict[str, list[str]] = {"white": [], "black": []}
        total_fetched = 0

        per_color_limit = max(50, max_games // 2)

        if opponent.get("lichess_username"):
            for color in ("white", "black"):
                for batch in iter_lichess_pgn_batches(
                    opponent["lichess_username"], color,
                    since_ms=None, max_games=per_color_limit,
                ):
                    if batch.get("pgn_text"):
                        pgn_by_color[color].append(batch["pgn_text"])
                    total_fetched += batch.get("raw_count", 0)
                    details["games_fetched"] = total_fetched
                    db.update_opponent_sync_run(run_id, details=details)

        if opponent.get("chesscom_username"):
            for color in ("white", "black"):
                known: set[str] = set()
                for batch in iter_chesscom_pgn_batches(
                    opponent["chesscom_username"], color,
                    known, max_games=per_color_limit,
                ):
                    if batch.get("pgn_text"):
                        pgn_by_color[color].append(batch["pgn_text"])
                    total_fetched += batch.get("raw_count", 0)
                    details["games_fetched"] = total_fetched
                    db.update_opponent_sync_run(run_id, details=details)

        details["analysis_status"] = "analyzing"
        db.update_opponent_sync_run(run_id, details=details)

        for color in ("white", "black"):
            parts = pgn_by_color[color]
            if not parts:
                continue
            pgn_text = "\n\n".join(parts)
            mistakes = analysis.analyze(pgn_text, color)
            db.replace_opponent_mistakes(opponent_id, color, mistakes)
            details[f"mistakes_{color}"] = len(mistakes)

        db.update_opponent_last_synced(opponent_id)
        details["analysis_status"] = "done"
        db.finish_opponent_sync_run(run_id, games_new=total_fetched, details=details)
        db.log_event(
            "sync",
            f"Opponent sync finished for opponent {opponent_id}",
            details={"opponent_id": opponent_id, "run_id": run_id, "details": details},
        )
    except Exception as exc:
        db.finish_opponent_sync_run(run_id, games_new=0, error=str(exc), details=None)
        db.log_event(
            "sync",
            f"Opponent sync failed for opponent {opponent_id}",
            level="error",
            details={"opponent_id": opponent_id, "run_id": run_id, "error": str(exc)},
        )


def _sync_task(config_id: int, max_games: Optional[int] = None, full_resync: bool = False) -> None:
    run_id = db.start_sync_run(config_id)
    stream_ctx: Optional[dict[str, Any]] = None
    stream_cancelled = False
    try:
        config = db.get_sync_config(config_id)
        if not config:
            raise ValueError(f"Config {config_id} not found")

        color = config["color"]
        platform = config["platform"]
        username = config["username"]
        known = db.get_known_game_ids(platform, username, color)
        existing = db.get_pgn(color)
        merged_content = existing["content"] if existing else ""
        total_games_after_merge = int(existing["game_count"]) if existing else 0

        default_limit = _LICHESS_MAX_GAMES if platform == "lichess" else _CHESSCOM_MAX_GAMES
        requested_limit = max_games if max_games is not None else default_limit
        details: dict[str, Any] = {
            "platform": platform,
            "requested_limit": requested_limit,
            "sync_batch_size": _SYNC_BATCH_SIZE,
            "known_ids": len(known),
            "fetched_ids": 0,
            "new_ids": 0,
            "supported_new_games": 0,
            "total_games_after_merge": total_games_after_merge,
            "analysis_streaming": False,
            "analysis_ready": db.count_active_mistakes(color),
        }
        db.update_sync_run(run_id, details=details)
        db.log_event(
            "sync",
            f"{platform} sync started for {username}",
            details={"config_id": config_id, "run_id": run_id, "color": color, "known_ids": len(known)},
        )

        stream_ctx = _start_stream_analysis(color, merged_content)
        if stream_ctx:
            details["analysis_streaming"] = True
            details["analysis_run_id"] = stream_ctx["run_id"]
            details["analysis_progress"] = stream_ctx["processed_games"]
            details["analysis_total"] = stream_ctx["total_games"]
            db.update_sync_run(run_id, details=details)

        if platform == "lichess":
            since_ms: Optional[int] = None
            if config["last_synced_at"] and not full_resync:
                ts = datetime.fromisoformat(config["last_synced_at"])
                since_ms = int(ts.timestamp() * 1000)
            batches = iter_lichess_pgn_batches(username, color, since_ms=since_ms, max_games=requested_limit)
        else:
            batches = iter_chesscom_pgn_batches(username, color, known, max_games=requested_limit)

        for batch_index, batch in enumerate(batches, start=1):
            previous_content = merged_content
            batch_ids = [game_id for game_id in batch["game_ids"] if game_id not in known]
            known.update(batch_ids)

            details["fetched_ids"] = int(details["fetched_ids"]) + int(batch.get("raw_count", len(batch["game_ids"])))
            details["chunk_index"] = batch_index
            if "pages_fetched" in batch:
                details["pages_fetched"] = batch["pages_fetched"]
            if "archives_scanned" in batch:
                details["archives_scanned"] = batch["archives_scanned"]
                details["archives_available"] = batch.get("archives_available")

            if batch_ids:
                cleaned_batch, supported_batch_games = analysis.parse_and_truncate(batch["pgn_text"])
                details["new_ids"] = int(details["new_ids"]) + len(batch_ids)
                details["supported_new_games"] = int(details["supported_new_games"]) + supported_batch_games
                db.record_game_ids(platform, username, color, batch_ids)

                if cleaned_batch:
                    merged_source = (merged_content + "\n\n" + cleaned_batch).strip()
                    merged_content, total_games_after_merge = analysis.parse_and_truncate(merged_source)
                    db.upsert_pgn(color, merged_content, total_games_after_merge, reset_analysis=False)

                    if stream_ctx:
                        stream_ctx, stream_cancelled = _stream_sync_analysis_chunk(
                            stream_ctx,
                            color,
                            cleaned_batch,
                            merged_content,
                            total_games_after_merge,
                        )
                    elif not db.latest_active_run(color):
                        _carry_forward_analysis_checkpoint(
                            color,
                            previous_content,
                            merged_content,
                            total_games_after_merge,
                        )

                    details["total_games_after_merge"] = total_games_after_merge
                    details["analysis_ready"] = db.count_active_mistakes(color)
                    checkpoint = db.get_analysis_checkpoint(color)
                    if checkpoint:
                        details["analysis_progress"] = int(checkpoint["processed_games"])
                        details["analysis_total"] = int(checkpoint["total_games"])
                        details["analysis_checkpoint_completed"] = bool(checkpoint["completed"])

            db.update_sync_run(run_id, games_new=int(details["new_ids"]), details=details)

        db.update_sync_config_synced(config_id)

        if stream_ctx:
            stream_completed = _finish_stream_analysis(stream_ctx, color)
            details["analysis_progress"] = stream_ctx["processed_games"]
            details["analysis_total"] = stream_ctx["total_games"]
            details["analysis_ready"] = db.count_active_mistakes(color)
            details["analysis_checkpoint_completed"] = stream_completed
            if not stream_completed:
                queued = _queue_catchup_analysis(color)
                if queued:
                    details["analysis_enqueued"] = True
                    details["analysis_run_id"] = queued["run_id"]
                    details["analysis_progress"] = queued["progress"]
                    details["analysis_total"] = queued["total"]
        elif not stream_cancelled:
            queued = _queue_catchup_analysis(color)
            if queued:
                details["analysis_enqueued"] = True
                details["analysis_run_id"] = queued["run_id"]
                details["analysis_progress"] = queued["progress"]
                details["analysis_total"] = queued["total"]

        db.finish_sync_run(run_id, games_new=int(details["new_ids"]), details=details)
        db.log_event(
            "sync",
            f"{platform} sync finished for {username}",
            details={
                "config_id": config_id,
                "run_id": run_id,
                "games_new": int(details["new_ids"]),
                "details": details,
            },
        )
    except Exception as exc:
        if stream_ctx:
            try:
                db.finish_run(stream_ctx["run_id"], status="error", error=str(exc))
            finally:
                try:
                    stream_ctx["engine"].quit()
                except Exception:
                    pass
        db.finish_sync_run(run_id, games_new=0, error=str(exc))
        db.log_event(
            "sync",
            f"Sync failed for config {config_id}",
            level="error",
            details={"run_id": run_id, "error": str(exc)},
        )


def _combine_batches(
    platform: str,
    requested_limit: int,
    batches: list[dict[str, Any]],
) -> tuple[str, list[str], dict[str, Any]]:
    pgn_parts = [batch["pgn_text"] for batch in batches if batch["pgn_text"]]
    game_ids = [gid for batch in batches for gid in batch["game_ids"]]
    details: dict[str, Any] = {
        "platform": platform,
        "requested_limit": requested_limit,
        "fetched_ids": len(game_ids),
        "sync_batch_size": _SYNC_BATCH_SIZE,
    }
    if batches:
        last = batches[-1]
        if "effective_limit" in last:
            details["effective_limit"] = last["effective_limit"]
        if "pages_fetched" in last:
            details["pages_fetched"] = last["pages_fetched"]
        if "archives_scanned" in last:
            details["archives_scanned"] = last["archives_scanned"]
            details["archives_available"] = last.get("archives_available")
    return "\n\n".join(pgn_parts).strip(), game_ids, details


def _parse_lichess_games(pgn_text: str) -> list[dict[str, Any]]:
    games: list[dict[str, Any]] = []
    pgn_io = io.StringIO(pgn_text)

    while True:
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break
        site = game.headers.get("Site", "")
        match = _LICHESS_ID.search(f'[Site "{site}"]')
        if not match:
            continue
        pgn = game.accept(
            chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        ).strip()
        if not pgn:
            continue
        games.append(
            {
                "id": match.group(1),
                "pgn": pgn,
                "utc_ms": _pgn_utc_ms(game),
            }
        )
    return games


def _pgn_utc_ms(game: chess.pgn.Game) -> Optional[int]:
    date_str = game.headers.get("UTCDate") or game.headers.get("Date")
    time_str = game.headers.get("UTCTime")
    if not date_str or not time_str or "?" in date_str or "?" in time_str:
        return None
    try:
        stamp = datetime.strptime(f"{date_str} {time_str}", "%Y.%m.%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(stamp.timestamp() * 1000)


def _start_stream_analysis(color: str, base_content: str) -> Optional[dict[str, Any]]:
    ok, _ = engine_status()
    if not ok:
        return None
    if db.latest_active_run(color):
        return None

    checkpoint = db.get_analysis_checkpoint(color)
    processed_games = 0
    total_games = 0
    source_fingerprint = analysis.fingerprint_pgn(base_content)

    if base_content:
        if not checkpoint or checkpoint["source_fingerprint"] != source_fingerprint:
            return None
        processed_games = int(checkpoint["processed_games"])
        total_games = int(checkpoint["total_games"])
    else:
        db.clear_analysis_workspace(color)
        db.upsert_analysis_checkpoint(color, source_fingerprint, 0, 0, True)

    run_id = db.start_run(color, progress=processed_games, total=total_games)
    if not db.mark_run_started(run_id):
        return None

    try:
        engine, engine_path = start_engine()
    except Exception as exc:
        db.finish_run(run_id, status="error", error=str(exc))
        db.log_event(
            "analysis",
            f"{color} sync-linked analysis failed to start engine",
            level="error",
            details={"run_id": run_id, "error": str(exc)},
        )
        return None

    db.log_event(
        "analysis",
        f"{color} sync-linked analysis started",
        details={
            "run_id": run_id,
            "processed_games": processed_games,
            "total_games": total_games,
            "batch_size": analysis.ANALYSIS_BATCH_GAMES,
            "engine_path": engine_path,
        },
    )
    return {
        "run_id": run_id,
        "engine": engine,
        "processed_games": processed_games,
        "total_games": total_games,
        "source_fingerprint": source_fingerprint,
    }


def _stream_sync_analysis_chunk(
    stream_ctx: dict[str, Any],
    color: str,
    cleaned_batch: str,
    merged_content: str,
    total_games_after_merge: int,
) -> tuple[Optional[dict[str, Any]], bool]:
    new_games = list(analysis.iter_supported_games(cleaned_batch))
    new_fingerprint = analysis.fingerprint_pgn(merged_content)
    db.upsert_analysis_checkpoint(
        color,
        new_fingerprint,
        total_games_after_merge,
        stream_ctx["processed_games"],
        False,
    )

    if not new_games:
        stream_ctx["total_games"] = total_games_after_merge
        stream_ctx["source_fingerprint"] = new_fingerprint
        db.update_run_progress(stream_ctx["run_id"], stream_ctx["processed_games"], total_games_after_merge)
        return stream_ctx, False

    try:
        stream_ctx["processed_games"] = analysis.process_incremental_games(
            stream_ctx["engine"],
            color,
            stream_ctx["run_id"],
            new_games,
            new_fingerprint,
            total_games_after_merge,
            stream_ctx["processed_games"],
        )
        stream_ctx["total_games"] = total_games_after_merge
        stream_ctx["source_fingerprint"] = new_fingerprint
        return stream_ctx, False
    except analysis.AnalysisCancelled:
        db.upsert_analysis_checkpoint(
            color,
            new_fingerprint,
            total_games_after_merge,
            stream_ctx["processed_games"],
            False,
        )
        db.finish_run(stream_ctx["run_id"], status="cancelled")
        db.log_event(
            "analysis",
            f"{color} sync-linked analysis cancelled",
            level="warn",
            details={
                "run_id": stream_ctx["run_id"],
                "processed_games": stream_ctx["processed_games"],
                "total_games": total_games_after_merge,
            },
        )
        try:
            stream_ctx["engine"].quit()
        except Exception:
            pass
        return None, True


def _finish_stream_analysis(stream_ctx: dict[str, Any], color: str) -> bool:
    completed = stream_ctx["processed_games"] >= stream_ctx["total_games"]
    db.upsert_analysis_checkpoint(
        color,
        stream_ctx["source_fingerprint"],
        stream_ctx["total_games"],
        stream_ctx["processed_games"],
        completed,
    )
    db.update_run_progress(
        stream_ctx["run_id"],
        stream_ctx["processed_games"],
        stream_ctx["total_games"],
    )
    if completed:
        db.finish_run(stream_ctx["run_id"])
        db.log_event(
            "analysis",
            f"{color} sync-linked analysis completed",
            details={
                "run_id": stream_ctx["run_id"],
                "processed_games": stream_ctx["processed_games"],
                "total_games": stream_ctx["total_games"],
                "mistakes_ready": db.count_active_mistakes(color),
            },
        )
    else:
        db.finish_run(stream_ctx["run_id"], status="cancelled")
        db.log_event(
            "analysis",
            f"{color} sync-linked analysis paused with checkpoint",
            level="warn",
            details={
                "run_id": stream_ctx["run_id"],
                "processed_games": stream_ctx["processed_games"],
                "total_games": stream_ctx["total_games"],
                "mistakes_ready": db.count_active_mistakes(color),
            },
        )
    try:
        stream_ctx["engine"].quit()
    except Exception:
        pass
    return completed


def _carry_forward_analysis_checkpoint(
    color: str,
    previous_content: str,
    merged_content: str,
    total_games_after_merge: int,
) -> bool:
    checkpoint = db.get_analysis_checkpoint(color)
    if not checkpoint:
        return False
    if checkpoint["source_fingerprint"] != analysis.fingerprint_pgn(previous_content):
        return False
    if previous_content and not merged_content.startswith(previous_content):
        return False

    processed_games = min(int(checkpoint["processed_games"]), total_games_after_merge)
    completed = bool(int(checkpoint["completed"]) and processed_games >= total_games_after_merge)
    if total_games_after_merge > processed_games:
        completed = False

    db.upsert_analysis_checkpoint(
        color,
        analysis.fingerprint_pgn(merged_content),
        total_games_after_merge,
        processed_games,
        completed,
    )
    return True


def _queue_catchup_analysis(color: str) -> Optional[dict[str, Any]]:
    ok, _ = engine_status()
    if not ok:
        return None
    if db.latest_active_run(color):
        return None

    pgn_row = db.get_pgn(color)
    if not pgn_row:
        return None

    source_fingerprint = analysis.fingerprint_pgn(pgn_row["content"])
    checkpoint = db.get_analysis_checkpoint(color)
    if checkpoint and checkpoint["source_fingerprint"] == source_fingerprint:
        if checkpoint["completed"]:
            return None
        progress = int(checkpoint["processed_games"])
        total = int(checkpoint["total_games"])
        resumed = progress > 0
    else:
        progress = 0
        total = int(pgn_row["game_count"])
        resumed = False

    run_id = db.start_run(color, progress=progress, total=total)
    analysis.analyze_in_background(color, run_id)
    db.log_event(
        "analysis",
        f"{color} catch-up analysis queued after sync",
        details={"run_id": run_id, "progress": progress, "total": total, "resumed": resumed},
    )
    return {"run_id": run_id, "progress": progress, "total": total, "resumed": resumed}


def _request(
    method: str,
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    params: Optional[dict[str, Any]] = None,
    timeout: int = 30,
    user_label: str,
) -> requests.Response:
    last_error: Optional[Exception] = None
    for attempt in range(1, _SYNC_RETRIES + 1):
        try:
            response = requests.request(method, url, headers=headers, params=params, timeout=timeout)
        except requests.RequestException as exc:
            last_error = exc
            if attempt == _SYNC_RETRIES:
                break
            time.sleep(_SYNC_BACKOFF_SECONDS * attempt)
            continue

        if response.status_code == 404:
            raise ValueError(f"{user_label} not found")
        if response.status_code == 429:
            try:
                wait = min(float(response.headers.get("Retry-After", 60)), 120)
            except (TypeError, ValueError):
                wait = 60
            if attempt < _SYNC_RETRIES:
                time.sleep(wait)
                continue
            raise ValueError(
                f"{user_label} is rate-limited by the remote API. "
                f"Retry after {wait:.0f} seconds."
            )
        if response.status_code in (403, 401):
            raise ValueError(f"{user_label} could not be fetched due to remote access restrictions")

        if response.status_code >= 500:
            last_error = ValueError(
                f"{user_label} returned HTTP {response.status_code} from the remote API"
            )
            if attempt == _SYNC_RETRIES:
                break
            time.sleep(_SYNC_BACKOFF_SECONDS * attempt)
            continue

        try:
            response.raise_for_status()
        except requests.HTTPError as exc:
            raise ValueError(f"{user_label} returned HTTP {response.status_code}") from exc
        return response

    if last_error is None:
        raise ValueError(f"{user_label} could not be fetched")
    raise ValueError(str(last_error))
