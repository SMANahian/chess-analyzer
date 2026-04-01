"""FastAPI application."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from chess_analyzer import analysis, db, fetcher
from chess_analyzer.engine import engine_status, install_hint

app = FastAPI(title="Chess Analyzer", docs_url="/api/docs")

_STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=_STATIC), name="static")


# ── SPA / index ───────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(_STATIC / "index.html")


# ── Status ────────────────────────────────────────────────────────────────

@app.get("/api/status")
async def status() -> JSONResponse:
    ok, msg = engine_status()
    runs: dict = {}
    for color in ("white", "black"):
        run = db.latest_run(color)
        pgn = db.get_pgn(color)
        runs[color] = {
            "pgn_uploaded": pgn is not None,
            "game_count":   pgn["game_count"] if pgn else 0,
            "run_status":   run["status"] if run else None,
            "run_error":    run["error"]  if run else None,
        }
    return JSONResponse({
        "engine_ok":   ok,
        "engine_path": msg,
        "engine_hint": install_hint() if not ok else None,
        "colors":      runs,
    })


# ── PGN upload ────────────────────────────────────────────────────────────

@app.post("/api/pgn/{color}")
async def upload_pgn(color: str, file: UploadFile = File(...)) -> JSONResponse:
    _chk_color(color)
    raw = await file.read()
    if len(raw) > analysis.MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {analysis.MAX_FILE_MB} MB limit")
    text = raw.decode("utf-8", errors="ignore")
    cleaned, count = analysis.parse_and_truncate(text)
    if count == 0:
        raise HTTPException(400, "No valid games found in the PGN file")
    db.upsert_pgn(color, cleaned, count)
    return JSONResponse({"game_count": count, "color": color})


@app.delete("/api/pgn/{color}")
async def delete_pgn(color: str) -> JSONResponse:
    _chk_color(color)
    db.delete_pgn(color)
    return JSONResponse({"ok": True})


# ── Analysis ──────────────────────────────────────────────────────────────

@app.post("/api/analyze/{color}", status_code=202)
async def start_analysis(color: str) -> JSONResponse:
    _chk_color(color)
    ok, msg = engine_status()
    if not ok:
        raise HTTPException(503, f"Stockfish unavailable: {msg}. Install: {install_hint()}")

    pgn_row = db.get_pgn(color)
    if not pgn_row:
        raise HTTPException(400, f"No {color} games uploaded yet")

    run = db.latest_run(color)
    if run and run["status"] == "running":
        raise HTTPException(409, "Analysis already running for this color")

    run_id = db.start_run(color)
    analysis.analyze_in_background(pgn_row["content"], color, run_id)
    return JSONResponse({"status": "started", "run_id": run_id})


@app.get("/api/analysis/{color}")
async def get_analysis(color: str) -> JSONResponse:
    _chk_color(color)
    mistakes = db.get_mistakes(color)
    stats    = analysis.compute_stats(mistakes)
    run      = db.latest_run(color)
    return JSONResponse({
        "mistakes":      mistakes,
        "stats":         stats,
        "mastered_count": len(db.get_mastered(color)),
        "run_status":    run["status"] if run else None,
    })


# ── Mistakes ──────────────────────────────────────────────────────────────

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


@app.get("/api/mastered/{color}")
async def get_mastered(color: str) -> JSONResponse:
    _chk_color(color)
    return JSONResponse({"mastered": db.get_mastered(color)})


# ── Platform sync ─────────────────────────────────────────────────────────

class SyncConfigIn(BaseModel):
    color:    str
    platform: str   # "lichess" | "chesscom"
    username: str


@app.get("/api/sync")
async def list_syncs() -> JSONResponse:
    return JSONResponse({"configs": db.list_sync_configs()})


@app.post("/api/sync", status_code=201)
async def create_sync_config(body: SyncConfigIn) -> JSONResponse:
    _chk_color(body.color)
    if body.platform not in ("lichess", "chesscom"):
        raise HTTPException(400, "platform must be 'lichess' or 'chesscom'")
    if not body.username.strip():
        raise HTTPException(400, "username is required")
    config_id = db.upsert_sync_config(body.color, body.platform, body.username.strip())
    return JSONResponse({"config_id": config_id})


@app.post("/api/sync/{config_id}/run", status_code=202)
async def run_sync(config_id: int) -> JSONResponse:
    config = db.get_sync_config(config_id)
    if not config:
        raise HTTPException(404, "Sync config not found")

    run = db.latest_sync_run(config_id)
    if run and run["status"] == "running":
        raise HTTPException(409, "Sync already running for this config")

    fetcher.sync_in_background(config_id)
    return JSONResponse({"status": "started", "config_id": config_id})


@app.get("/api/sync/{config_id}/status")
async def sync_status(config_id: int) -> JSONResponse:
    config = db.get_sync_config(config_id)
    if not config:
        raise HTTPException(404, "Sync config not found")
    run = db.latest_sync_run(config_id)
    return JSONResponse({
        "config":     dict(config),
        "latest_run": run,
    })


# ── Data ──────────────────────────────────────────────────────────────────

@app.delete("/api/data")
async def clear_data() -> JSONResponse:
    db.clear_all()
    return JSONResponse({"ok": True})


@app.get("/api/export")
async def export_data() -> JSONResponse:
    return JSONResponse({
        color: {"mistakes": db.get_mistakes(color), "mastered": db.get_mastered(color)}
        for color in ("white", "black")
    })


# ── SPA fallback ──────────────────────────────────────────────────────────

@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str) -> FileResponse:
    return FileResponse(_STATIC / "index.html")


# ── Helpers ───────────────────────────────────────────────────────────────

def _chk_color(color: str) -> None:
    if color not in ("white", "black"):
        raise HTTPException(400, "color must be 'white' or 'black'")
