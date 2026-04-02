from __future__ import annotations

import os

from fastapi.testclient import TestClient

from chess_analyzer import db, server
from tests.support import DatabaseIsolatedTestCase


class LogsApiTest(DatabaseIsolatedTestCase):
    def setUp(self) -> None:
        super().setUp()
        self._old_dev_mode = os.environ.get("CHESS_ANALYZER_DEV_MODE")
        os.environ["CHESS_ANALYZER_DEV_MODE"] = "1"
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        if self._old_dev_mode is None:
            os.environ.pop("CHESS_ANALYZER_DEV_MODE", None)
        else:
            os.environ["CHESS_ANALYZER_DEV_MODE"] = self._old_dev_mode
        super().tearDown()

    def test_logs_endpoint_returns_recent_events_in_dev_mode(self) -> None:
        db.log_event("analysis", "batch processed", details={"processed_games": 20})

        response = self.client.get("/api/logs?limit=10")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["logs"][0]["scope"], "analysis")
        self.assertEqual(payload["logs"][0]["details"]["processed_games"], 20)
