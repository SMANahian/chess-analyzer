"""Stockfish engine discovery and management."""
from __future__ import annotations

import os
import shutil
import sys
import threading
from pathlib import Path
from typing import Optional, Tuple

import chess.engine


def _candidates() -> list[str]:
    env = os.environ.get("STOCKFISH_PATH")
    if env:
        return [env]

    found: list[str] = []

    # Common packaged/dev locations relative to this file
    here = Path(__file__).parent
    for rel in ("../stockfish", "stockfish", "stockfish.exe"):
        p = (here / rel).resolve()
        if p.exists():
            found.append(str(p))

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
        # Apply tuning — default to all CPU cores for speed
        import multiprocessing
        opts: dict = {}
        try:
            opts["Threads"] = max(1, int(os.environ.get("STOCKFISH_THREADS", multiprocessing.cpu_count())))
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
        "Install it with `brew install stockfish` (macOS) or `apt install stockfish` (Linux)."
    ) from last


_status_cache: Optional[Tuple[bool, str]] = None
_status_lock = threading.Lock()


def engine_status() -> Tuple[bool, str]:
    global _status_cache
    with _status_lock:
        if _status_cache and _status_cache[0]:
            return _status_cache
        try:
            engine, path = start_engine()
            engine.quit()
            _status_cache = (True, path)
            return _status_cache
        except RuntimeError as exc:
            return (False, str(exc))


def install_hint() -> str:
    if sys.platform == "darwin":
        return "brew install stockfish"
    if sys.platform.startswith("linux"):
        return "sudo apt install stockfish  # or: sudo snap install stockfish"
    return "https://stockfishchess.org/download/"
