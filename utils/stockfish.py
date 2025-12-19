"""Stockfish engine management utilities."""
from __future__ import annotations

import os
import platform
import shutil
import sys
import threading
from pathlib import Path
from typing import Any

import chess.engine

from config import BASE_DIR


def binary_kind(path: Path) -> str | None:
    """Detect the binary format of a file."""
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
    """Get a note about the bundled Stockfish binary."""
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
    """Get installation hint for Stockfish based on the OS."""
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
    """Get list of candidate paths for the Stockfish binary."""
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
    """Start the Stockfish engine."""
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
    """Configure the Stockfish engine with optional environment settings."""
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
    """Check if the Stockfish engine is available and working."""
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
