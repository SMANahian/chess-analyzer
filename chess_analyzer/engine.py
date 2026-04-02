"""Stockfish engine discovery and management."""
from __future__ import annotations

import os
import shutil
import sys
import threading
import time
import multiprocessing
from pathlib import Path
from typing import Optional, Tuple

import chess.engine


def _candidates() -> list[str]:
    env = os.environ.get("STOCKFISH_PATH")
    if env:
        return [env]

    found: list[str] = []

    system = shutil.which("stockfish")
    if system:
        found.append(system)

    # Homebrew paths
    for brew_path in ("/opt/homebrew/bin/stockfish", "/usr/local/bin/stockfish"):
        if Path(brew_path).exists():
            found.append(brew_path)

    # Deduplicate preserving order
    seen: set[str] = set()
    result: list[str] = []
    for c in found:
        if c not in seen:
            seen.add(c)
            result.append(c)

    return result or ["stockfish"]


def start_engine() -> Tuple[chess.engine.SimpleEngine, str]:
    last: Optional[Exception] = None
    for path in _candidates():
        try:
            engine = chess.engine.SimpleEngine.popen_uci(path)
        except (OSError, chess.engine.EngineError) as exc:
            last = exc
            continue
        opts: dict = {}
        try:
            opts["Threads"] = max(1, int(os.environ.get("STOCKFISH_THREADS", _default_threads())))
        except (ValueError, NotImplementedError):
            pass
        if (h := os.environ.get("STOCKFISH_HASH_MB")):
            try:
                opts["Hash"] = max(16, int(h))
            except ValueError:
                pass
        if opts:
            try:
                engine.configure(opts)
            except chess.engine.EngineError:
                pass
        return engine, path

    raise RuntimeError(
        f"Stockfish not found. Tried: {_candidates()}. "
        "Install it with `brew install stockfish` (macOS) or `apt install stockfish` (Linux), "
        "or set STOCKFISH_PATH explicitly."
    ) from last


_status_cache: Optional[Tuple[bool, str]] = None
_status_cache_ts: float = 0.0
_STATUS_TTL = 300.0  # re-probe every 5 minutes
_status_lock = threading.Lock()


def engine_status() -> Tuple[bool, str]:
    global _status_cache, _status_cache_ts
    with _status_lock:
        now = time.monotonic()
        if _status_cache and _status_cache[0] and (now - _status_cache_ts) < _STATUS_TTL:
            return _status_cache
        try:
            engine, path = start_engine()
            engine.quit()
            _status_cache = (True, path)
            _status_cache_ts = now
            return _status_cache
        except RuntimeError as exc:
            return (False, str(exc))


def install_hint() -> str:
    if sys.platform == "darwin":
        return "brew install stockfish"
    if sys.platform.startswith("linux"):
        return "sudo apt install stockfish  # or: sudo snap install stockfish"
    return "https://stockfishchess.org/download/"


def _default_threads() -> int:
    try:
        cpu_total = multiprocessing.cpu_count()
    except (NotImplementedError, OSError):
        return 1
    if cpu_total <= 3:
        return 1
    return min(2, cpu_total - 1)
