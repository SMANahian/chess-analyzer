"""FastAPI application."""
from __future__ import annotations

import json
import os
from enum import Enum
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from chess_analyzer import __version__, analysis, db, fetcher
from chess_analyzer.engine import engine_status, install_hint


class Color(str, Enum):
    white = "white"
    black = "black"


class PracticeColor(str, Enum):
    white = "white"
    black = "black"
    mixed = "mixed"


class Platform(str, Enum):
    lichess = "lichess"
    chesscom = "chesscom"


class SyncConfigIn(BaseModel):
    color: Color
    platform: Platform
    username: str = Field(min_length=1, max_length=64)


class RunSyncIn(BaseModel):
    max_games: int = Field(default=0, ge=0, le=50000)
    full_resync: bool = False


class PracticeSessionIn(BaseModel):
    color: PracticeColor
    correct: int = Field(ge=0)
    total: int = Field(ge=0)
    best_streak: int = Field(ge=0)


class PracticeAttemptIn(BaseModel):
    mistake_id: int = Field(gt=0)
    correct: bool


class AnalysisDepthIn(BaseModel):
    depth: int = Field(ge=1, le=30)


class OpponentIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    lichess_username: Optional[str] = Field(default=None, max_length=64)
    chesscom_username: Optional[str] = Field(default=None, max_length=64)

    def clean(self) -> "OpponentIn":
        self.lichess_username = (self.lichess_username or "").strip() or None
        self.chesscom_username = (self.chesscom_username or "").strip() or None
        return self


class RunOpponentSyncIn(BaseModel):
    max_games: int = Field(default=500, ge=50, le=5000)


app = FastAPI(
    title="Chess Analyzer",
    description="Analyze your chess opening mistakes and train to fix them.",
    version=__version__,
    docs_url="/api/docs",
)

_STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=_STATIC), name="static")


def _dev_mode() -> bool:
    return os.environ.get("CHESS_ANALYZER_DEV_MODE") == "1"


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(_STATIC / "index.html")


@app.get("/api/status")
async def status() -> JSONResponse:
    ok, msg = engine_status()
    runs: dict[str, dict[str, object]] = {}
    for color in (Color.white.value, Color.black.value):
        run = db.latest_run(color)
        checkpoint = db.get_analysis_checkpoint(color)
        pgn = db.get_pgn(color)
        progress = run["progress"] if run else (checkpoint["processed_games"] if checkpoint else 0)
        progress_total = run["progress_total"] if run and run["progress_total"] else (
            checkpoint["total_games"] if checkpoint else 0
        )
        can_resume = bool(
            checkpoint
            and not checkpoint["completed"]
            and progress_total > 0
            and progress < progress_total
            and (not run or run["status"] in {"cancelled", "error", "done"})
        )
        runs[color] = {
            "pgn_uploaded": pgn is not None,
            "game_count": pgn["game_count"] if pgn else 0,
            "run_status": run["status"] if run else None,
            "run_error": run["error"] if run else None,
            "run_progress": progress,
            "run_progress_total": progress_total,
            "run_queue_position": db.run_queue_position(run["id"]) if run else 0,
            "run_cancel_requested": run["cancel_requested"] if run else False,
            "partial_mistakes_ready": db.count_active_mistakes(color),
            "checkpoint_completed": checkpoint["completed"] if checkpoint else False,
            "can_resume": can_resume,
        }
    return JSONResponse(
        {
            "engine_ok": ok,
            "engine_path": msg,
            "engine_hint": install_hint() if not ok else None,
            "colors": runs,
            "summary": db.get_summary(),
            "schema_version": db.get_schema_version(),
            "dev_mode": _dev_mode(),
            "analysis_batch_games": analysis.ANALYSIS_BATCH_GAMES,
            "analysis_depth": int(db.get_setting("analysis_depth") or analysis.ANALYSIS_DEPTH),
        }
    )


@app.post("/api/pgn/{color}")
async def upload_pgn(color: Color, file: UploadFile = File(...)) -> JSONResponse:
    raw = await file.read()
    if len(raw) > analysis.MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {analysis.MAX_FILE_MB} MB limit")
    text = raw.decode("utf-8", errors="ignore")
    cleaned, count = analysis.parse_and_truncate(text)
    if count == 0:
        raise HTTPException(400, "No valid games found in the PGN file")
    db.upsert_pgn(color.value, cleaned, count)
    db.log_event("api", f"{color.value} PGN uploaded", details={"game_count": count})
    return JSONResponse({"game_count": count, "color": color.value})


@app.delete("/api/pgn/{color}")
async def delete_pgn(color: Color) -> JSONResponse:
    db.delete_pgn(color.value)
    db.log_event("api", f"{color.value} PGN deleted")
    return JSONResponse({"ok": True})


@app.post("/api/analyze/{color}", status_code=202)
async def start_analysis(color: Color) -> JSONResponse:
    ok, msg = engine_status()
    if not ok:
        raise HTTPException(503, f"Stockfish unavailable: {msg}. Install: {install_hint()}")

    pgn_row = db.get_pgn(color.value)
    if not pgn_row:
        raise HTTPException(400, f"No {color.value} games uploaded yet")

    active_run = db.latest_active_run(color.value)
    if active_run:
        raise HTTPException(409, "Analysis already queued or running for this color")

    checkpoint = db.get_analysis_checkpoint(color.value)
    source_fingerprint = analysis.fingerprint_pgn(pgn_row["content"])
    if checkpoint and checkpoint["source_fingerprint"] == source_fingerprint and not checkpoint["completed"]:
        progress = int(checkpoint["processed_games"])
        total = int(checkpoint["total_games"])
        resumed = progress > 0
    else:
        progress = 0
        total = int(pgn_row["game_count"])
        resumed = False

    run_id = db.start_run(color.value, progress=progress, total=total)
    analysis.analyze_in_background(color.value, run_id)
    db.log_event(
        "api",
        f"{color.value} analysis queued",
        details={"run_id": run_id, "progress": progress, "total": total, "resumed": resumed},
    )
    return JSONResponse({"status": "queued", "run_id": run_id, "resumed": resumed, "progress": progress, "total": total})


@app.post("/api/analyze/{color}/cancel")
async def cancel_analysis(color: Color) -> JSONResponse:
    active_run = db.latest_active_run(color.value)
    if not active_run:
        raise HTTPException(404, "No queued or running analysis found for this color")
    if not db.cancel_run(active_run["id"]):
        raise HTTPException(409, "Analysis could not be cancelled")
    db.log_event("api", f"{color.value} analysis cancel requested", level="warn", details={"run_id": active_run["id"]})
    return JSONResponse({"ok": True, "run_id": active_run["id"]})


@app.get("/api/analysis/{color}")
async def get_analysis(color: Color) -> JSONResponse:
    mistakes = db.get_mistakes(color.value)
    run = db.latest_run(color.value)
    checkpoint = db.get_analysis_checkpoint(color.value)
    progress = run["progress"] if run else (checkpoint["processed_games"] if checkpoint else 0)
    progress_total = run["progress_total"] if run and run["progress_total"] else (
        checkpoint["total_games"] if checkpoint else 0
    )
    return JSONResponse(
        {
            "mistakes": mistakes,
            "stats": analysis.compute_stats(mistakes),
            "mastered_count": db.count_mastered(color.value),
            "snoozed_count": db.count_snoozed(color.value),
            "run_status": run["status"] if run else None,
            "run_error": run["error"] if run else None,
            "run_progress": progress,
            "run_progress_total": progress_total,
            "run_queue_position": db.run_queue_position(run["id"]) if run else 0,
            "run_cancel_requested": run["cancel_requested"] if run else False,
            "partial_mistakes_ready": len(mistakes),
            "checkpoint_completed": checkpoint["completed"] if checkpoint else False,
            "can_resume": bool(
                checkpoint
                and not checkpoint["completed"]
                and progress_total > 0
                and progress < progress_total
                and (not run or run["status"] in {"cancelled", "error", "done"})
            ),
            "progress_unit": "games",
            "analysis_batch_games": analysis.ANALYSIS_BATCH_GAMES,
        }
    )


@app.put("/api/mistakes/{mistake_id}/master")
async def master_mistake(mistake_id: int) -> JSONResponse:
    if not db.master_mistake(mistake_id):
        raise HTTPException(404, "Mistake not found or already mastered")
    return JSONResponse({"ok": True})


@app.put("/api/mistakes/{mistake_id}/restore")
async def restore_mistake(mistake_id: int) -> JSONResponse:
    if not db.restore_mistake(mistake_id):
        raise HTTPException(404, "Mastered mistake not found")
    return JSONResponse({"ok": True})


@app.put("/api/mistakes/{mistake_id}/snooze")
async def snooze_mistake(mistake_id: int) -> JSONResponse:
    if not db.snooze_mistake(mistake_id):
        raise HTTPException(404, "Mistake not found or already snoozed")
    return JSONResponse({"ok": True})


@app.put("/api/mistakes/{mistake_id}/unsnooze")
async def unsnooze_mistake(mistake_id: int) -> JSONResponse:
    if not db.unsnooze_mistake(mistake_id):
        raise HTTPException(404, "Snoozed mistake not found")
    return JSONResponse({"ok": True})


@app.get("/api/mastered/{color}")
async def get_mastered(color: Color) -> JSONResponse:
    return JSONResponse({"mastered": db.get_mastered(color.value)})


@app.get("/api/snoozed/{color}")
async def get_snoozed(color: Color) -> JSONResponse:
    return JSONResponse({"snoozed": db.get_snoozed(color.value)})


@app.get("/api/sync")
async def list_syncs() -> JSONResponse:
    return JSONResponse({"configs": db.list_sync_configs()})


@app.post("/api/sync", status_code=201)
async def create_sync_config(body: SyncConfigIn) -> JSONResponse:
    username = body.username.strip()
    if not username:
        raise HTTPException(400, "username is required")
    config_id = db.upsert_sync_config(body.color.value, body.platform.value, username)
    db.log_event("api", "Sync source saved", details={"config_id": config_id, "color": body.color.value, "platform": body.platform.value})
    return JSONResponse({"config_id": config_id})


@app.delete("/api/sync/{config_id}")
async def delete_sync_config(config_id: int) -> JSONResponse:
    if not db.delete_sync_config(config_id):
        raise HTTPException(404, "Sync config not found")
    db.log_event("api", "Sync source deleted", details={"config_id": config_id})
    return JSONResponse({"ok": True})


@app.post("/api/sync/{config_id}/run", status_code=202)
async def run_sync(config_id: int, body: RunSyncIn = Body(default=RunSyncIn())) -> JSONResponse:
    config = db.get_sync_config(config_id)
    if not config:
        raise HTTPException(404, "Sync config not found")

    run = db.latest_sync_run(config_id)
    if run and run["status"] == "running":
        raise HTTPException(409, "Sync already running for this config")

    max_games = body.max_games if body.max_games > 0 else None
    fetcher.sync_in_background(config_id, max_games=max_games, full_resync=body.full_resync)
    db.log_event("api", "Sync queued", details={"config_id": config_id, "max_games": max_games, "full_resync": body.full_resync})
    return JSONResponse({"status": "started", "config_id": config_id})


@app.get("/api/sync/{config_id}/status")
async def sync_status(config_id: int) -> JSONResponse:
    config = db.get_sync_config(config_id)
    if not config:
        raise HTTPException(404, "Sync config not found")
    run = db.latest_sync_run(config_id)
    return JSONResponse({"config": dict(config), "latest_run": run})


@app.post("/api/practice/session")
async def save_practice_session(body: PracticeSessionIn) -> JSONResponse:
    session_id = db.save_practice_session(
        body.color.value, body.correct, body.total, body.best_streak
    )
    return JSONResponse({"session_id": session_id})


@app.get("/api/practice/history/{color}")
async def practice_history(color: PracticeColor) -> JSONResponse:
    return JSONResponse({"history": db.get_practice_history(color.value)})


@app.delete("/api/data")
async def clear_data() -> JSONResponse:
    if db.has_active_jobs():
        raise HTTPException(409, "Wait for analysis or sync jobs to finish before clearing data")
    db.clear_all()
    db.log_event("api", "Local data cleared")
    return JSONResponse({"ok": True})


@app.get("/api/logs")
async def get_logs(limit: int = 200) -> JSONResponse:
    if not _dev_mode():
        raise HTTPException(404, "Developer logs are disabled")
    return JSONResponse({"logs": db.list_logs(limit=limit)})


@app.get("/api/export")
async def export_data() -> JSONResponse:
    if _dev_mode():
        db.log_event("api", "Backup exported")
    return JSONResponse(db.export_backup())


@app.post("/api/import", status_code=201)
async def import_data(file: UploadFile = File(...)) -> JSONResponse:
    if db.has_active_jobs():
        raise HTTPException(409, "Wait for analysis or sync jobs to finish before importing data")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Backup file is empty")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, f"Invalid backup file: {exc}") from exc
    try:
        summary = db.import_backup(payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    db.log_event("api", "Backup imported", details={"summary": summary})
    return JSONResponse({"ok": True, "summary": summary}, status_code=201)


@app.get("/api/summary")
async def summary() -> JSONResponse:
    return JSONResponse(db.get_summary())


@app.post("/api/practice/attempt", status_code=201)
async def record_practice_attempt(body: PracticeAttemptIn) -> JSONResponse:
    db.record_mistake_attempt(body.mistake_id, body.correct)
    db.update_sm2(body.mistake_id, body.correct)
    return JSONResponse({"ok": True})


@app.get("/api/openings/{color}")
async def get_opening_breakdown(color: Color) -> JSONResponse:
    return JSONResponse({"openings": db.get_opening_breakdown(color.value)})


@app.get("/api/practice/calendar")
async def get_practice_calendar(days: int = 91) -> JSONResponse:
    days = max(7, min(365, days))
    return JSONResponse({"calendar": db.get_practice_calendar(days)})


@app.put("/api/settings/analysis-depth")
async def set_analysis_depth(body: AnalysisDepthIn) -> JSONResponse:
    db.set_setting("analysis_depth", str(body.depth))
    return JSONResponse({"ok": True, "depth": body.depth})


@app.get("/api/settings/analysis-depth")
async def get_analysis_depth() -> JSONResponse:
    raw = db.get_setting("analysis_depth")
    depth = int(raw) if raw else analysis.ANALYSIS_DEPTH
    return JSONResponse({"depth": depth})


# ── Opponent prep ──────────────────────────────────────────────────────────

@app.get("/api/opponents")
async def list_opponents_route() -> JSONResponse:
    return JSONResponse({"opponents": db.list_opponents()})


@app.post("/api/opponents", status_code=201)
async def create_opponent_route(body: OpponentIn) -> JSONResponse:
    body = body.clean()
    if not body.lichess_username and not body.chesscom_username:
        raise HTTPException(400, "At least one username (Lichess or Chess.com) is required")
    opponent_id = db.create_opponent(body.name, body.lichess_username, body.chesscom_username)
    return JSONResponse({"opponent_id": opponent_id})


@app.get("/api/opponents/{opponent_id}")
async def get_opponent_route(opponent_id: int) -> JSONResponse:
    opp = db.get_opponent(opponent_id)
    if not opp:
        raise HTTPException(404, "Opponent not found")
    return JSONResponse({"opponent": opp})


@app.put("/api/opponents/{opponent_id}")
async def update_opponent_route(opponent_id: int, body: OpponentIn) -> JSONResponse:
    body = body.clean()
    if not body.lichess_username and not body.chesscom_username:
        raise HTTPException(400, "At least one username (Lichess or Chess.com) is required")
    if not db.update_opponent(opponent_id, body.name, body.lichess_username, body.chesscom_username):
        raise HTTPException(404, "Opponent not found")
    return JSONResponse({"ok": True})


@app.delete("/api/opponents/{opponent_id}")
async def delete_opponent_route(opponent_id: int) -> JSONResponse:
    if not db.delete_opponent(opponent_id):
        raise HTTPException(404, "Opponent not found")
    return JSONResponse({"ok": True})


@app.post("/api/opponents/{opponent_id}/sync", status_code=202)
async def sync_opponent_route(opponent_id: int, body: RunOpponentSyncIn = Body(default=RunOpponentSyncIn())) -> JSONResponse:
    opp = db.get_opponent(opponent_id)
    if not opp:
        raise HTTPException(404, "Opponent not found")
    if not opp.get("lichess_username") and not opp.get("chesscom_username"):
        raise HTTPException(400, "Opponent has no usernames configured")
    run = db.latest_opponent_sync_run(opponent_id)
    if run and run["status"] == "running":
        raise HTTPException(409, "Sync already running for this opponent")
    ok, _ = fetcher.engine_status() if hasattr(fetcher, "engine_status") else (True, "")
    from chess_analyzer.engine import engine_status as _eng_status
    eng_ok, _ = _eng_status()
    if not eng_ok:
        raise HTTPException(503, "Stockfish engine not available — install it first")
    fetcher.sync_opponent_in_background(opponent_id, max_games=body.max_games)
    db.log_event("api", f"Opponent sync queued for {opponent_id}", details={"opponent_id": opponent_id})
    return JSONResponse({"status": "started", "opponent_id": opponent_id})


@app.get("/api/opponents/{opponent_id}/status")
async def opponent_sync_status(opponent_id: int) -> JSONResponse:
    opp = db.get_opponent(opponent_id)
    if not opp:
        raise HTTPException(404, "Opponent not found")
    run = db.latest_opponent_sync_run(opponent_id)
    return JSONResponse({"opponent": opp, "latest_run": run})


@app.get("/api/opponents/{opponent_id}/mistakes")
async def get_opponent_mistakes_route(opponent_id: int) -> JSONResponse:
    opp = db.get_opponent(opponent_id)
    if not opp:
        raise HTTPException(404, "Opponent not found")
    all_mistakes = db.get_opponent_mistakes(opponent_id)
    white = [m for m in all_mistakes if m["color"] == "white"]
    black = [m for m in all_mistakes if m["color"] == "black"]
    return JSONResponse({
        "opponent": opp,
        "white": white,
        "black": black,
        "white_count": len(white),
        "black_count": len(black),
    })


@app.get("/health", include_in_schema=False)
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str) -> FileResponse:
    return FileResponse(_STATIC / "index.html")
