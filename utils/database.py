"""Database utilities for user management."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from config import USERS_FILE


def atomic_write_json(path: Path, payload: Any) -> None:
    """Atomically write JSON data to a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        tmp_name = handle.name
    os.replace(tmp_name, path)


def load_users() -> dict[str, dict[str, str]]:
    """Load users from the JSON database file."""
    if not USERS_FILE.exists():
        return {}
    try:
        with USERS_FILE.open(encoding="utf-8") as handle:
            data = json.load(handle)
            if isinstance(data, dict):
                return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_users(users: dict[str, dict[str, str]]) -> None:
    """Save users to the JSON database file."""
    atomic_write_json(USERS_FILE, users)
