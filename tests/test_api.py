from __future__ import annotations

import json

from fastapi.testclient import TestClient

from chess_analyzer import db, server
from tests.support import DatabaseIsolatedTestCase


class ApiBehaviorTest(DatabaseIsolatedTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.client = TestClient(server.app)

    def test_synced_game_ids_are_scoped_by_username_and_color(self) -> None:
        db.record_game_ids("lichess", "alice", "white", ["game-1"])

        self.assertEqual(db.get_known_game_ids("lichess", "alice", "white"), {"game-1"})
        self.assertEqual(db.get_known_game_ids("lichess", "bob", "white"), set())
        self.assertEqual(db.get_known_game_ids("lichess", "alice", "black"), set())

    def test_mixed_practice_sessions_are_accepted(self) -> None:
        response = self.client.post(
            "/api/practice/session",
            json={"color": "mixed", "correct": 5, "total": 7, "best_streak": 3},
        )

        self.assertEqual(response.status_code, 200)
        history = self.client.get("/api/practice/history/mixed").json()["history"]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["correct"], 5)

    def test_export_and_import_restore_full_local_state(self) -> None:
        db.upsert_pgn("white", "1. e4 e5 2. Nf3 Nc6 *", 1)
        db.replace_mistakes(
            "white",
            [
                {
                    "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                    "user_move": "e7e5",
                    "top_moves": ["c7c5"],
                    "avg_cp_loss": 120,
                    "pair_count": 3,
                    "opening_eco": "B00",
                    "opening_name": "King's Pawn Opening",
                },
                {
                    "fen": "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
                    "user_move": "g1f3",
                    "top_moves": ["d2d4"],
                    "avg_cp_loss": 95,
                    "pair_count": 2,
                    "opening_eco": "C20",
                    "opening_name": "King's Pawn Game",
                },
            ],
        )
        first_mistake_id = db.get_mistakes("white")[0]["id"]
        db.master_mistake(first_mistake_id)
        config_id = db.upsert_sync_config("white", "lichess", "alice")
        db.update_sync_config_synced(config_id)
        db.record_game_ids("lichess", "alice", "white", ["lichess-123"])
        db.save_practice_session("mixed", 4, 5, 4)

        backup = self.client.get("/api/export").json()
        db.clear_all()

        restore = self.client.post(
            "/api/import",
            files={
                "file": ("backup.json", json.dumps(backup), "application/json"),
            },
        )

        self.assertEqual(restore.status_code, 201)
        self.assertEqual(db.get_pgn("white")["game_count"], 1)
        self.assertEqual(len(db.get_mastered("white")), 1)
        self.assertEqual(db.list_sync_configs()[0]["username"], "alice")
        self.assertEqual(db.get_known_game_ids("lichess", "alice", "white"), {"lichess-123"})
        self.assertEqual(db.get_practice_history("mixed")[0]["correct"], 4)

    def test_api_does_not_advertise_permissive_cors(self) -> None:
        response = self.client.options(
            "/api/export",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )

        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_status_recovers_interrupted_jobs_after_restart(self) -> None:
        db.upsert_pgn("white", "1. e4 e5 2. Nf3 Nc6 *", 1)
        checkpoint_fp = "fingerprint"
        db.upsert_analysis_checkpoint("white", checkpoint_fp, 10, 4, False)
        run_id = db.start_run("white", progress=4, total=10)
        self.assertTrue(db.mark_run_started(run_id))

        config_id = db.upsert_sync_config("white", "lichess", "alice")
        sync_run_id = db.start_sync_run(config_id)
        db.update_sync_run(sync_run_id, games_new=3, details={"fetched_ids": 3})

        db.reset_runtime_state()

        response = self.client.get("/api/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["colors"]["white"]["run_status"], "cancelled")
        self.assertTrue(payload["colors"]["white"]["can_resume"])
        self.assertEqual(payload["summary"]["analysis_active"], 0)
        self.assertEqual(payload["summary"]["sync_running"], 0)

        recovered_run = db.latest_run("white")
        recovered_sync = db.latest_sync_run(config_id)
        self.assertEqual(recovered_run["status"], "cancelled")
        self.assertEqual(recovered_run["error"], "Application stopped before analysis completed")
        self.assertEqual(recovered_sync["status"], "error")
        self.assertEqual(recovered_sync["error"], "Application stopped before sync completed")
