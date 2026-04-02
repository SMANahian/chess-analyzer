from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from chess_analyzer import db


class DatabaseIsolatedTestCase(TestCase):
    def setUp(self) -> None:
        super().setUp()
        self._tmpdir = TemporaryDirectory()
        self._old_db_path = db.DB_PATH
        db.reset_runtime_state()
        db.DB_PATH = Path(self._tmpdir.name) / "chess_analyzer.db"

    def tearDown(self) -> None:
        db.reset_runtime_state()
        db.DB_PATH = self._old_db_path
        self._tmpdir.cleanup()
        super().tearDown()
