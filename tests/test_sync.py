from __future__ import annotations

from unittest.mock import patch

import chess

from chess_analyzer import db, fetcher
from tests.support import DatabaseIsolatedTestCase


class _FakeScore:
    def __init__(self, value: int) -> None:
        self.value = value

    def white(self) -> "_FakeScore":
        return self

    def score(self, mate_score: int | None = None) -> int:
        return self.value


class _FakeEngine:
    def analyse(self, board: chess.Board, limit, multipv: int | None = None):
        if multipv and multipv > 1:
            return [
                {"score": _FakeScore(120), "pv": [_best_move(board)]},
                {"score": _FakeScore(40), "pv": [_fallback_move(board)]},
            ]
        return {"score": _FakeScore(-80), "pv": [_best_move(board)]}

    def quit(self) -> None:
        return None


def _best_move(board: chess.Board) -> chess.Move:
    for uci in ("d2d4", "c2c4", "g1f3", "d7d5", "c7c5", "g8f6"):
        move = chess.Move.from_uci(uci)
        if move in board.legal_moves:
            return move
    return next(iter(board.legal_moves))


def _fallback_move(board: chess.Board) -> chess.Move:
    for move in board.legal_moves:
        if move != _best_move(board):
            return move
    return _best_move(board)


class SyncBehaviorTest(DatabaseIsolatedTestCase):
    def test_parse_lichess_games_preserves_one_block_per_game(self) -> None:
        pgn_text = """
[Event "G1"]
[Site "https://lichess.org/game0001"]
[Date "2026.01.01"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

[Event "G2"]
[Site "https://lichess.org/game0002"]
[Date "2026.01.02"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. d4 d5 2. c4 e6 *
""".strip()

        games = fetcher._parse_lichess_games(pgn_text)

        self.assertEqual(len(games), 2)
        self.assertIn("game0001", games[0]["pgn"])
        self.assertIn("game0002", games[1]["pgn"])
        self.assertNotIn("game0001", games[1]["pgn"])

    def test_lichess_sync_skips_unsupported_variant_games(self) -> None:
        config_id = db.upsert_sync_config("black", "lichess", "alice")
        pgn_text = """
[Event "Variant Game"]
[Site "https://lichess.org/variant01"]
[Date "2026.01.01"]
[Round "?"]
[White "White"]
[Black "alice"]
[Result "*"]
[Variant "Horde"]

1. e4 e5 *

[Event "Standard Game"]
[Site "https://lichess.org/standard1"]
[Date "2026.01.02"]
[Round "?"]
[White "Bob"]
[Black "alice"]
[Result "*"]

1. e4 c5 2. Nf3 d6 *
""".strip()

        with patch.object(
            fetcher,
            "iter_lichess_pgn_batches",
            return_value=iter(
                [
                    {
                        "platform": "lichess",
                        "pgn_text": pgn_text,
                        "game_ids": ["variant01", "standard1"],
                        "raw_count": 2,
                        "effective_limit": 2,
                        "pages_fetched": 1,
                    }
                ]
            ),
        ), patch.object(fetcher, "engine_status", return_value=(False, "missing")):
            fetcher._sync_task(config_id)

        run = db.latest_sync_run(config_id)
        self.assertIsNotNone(run)
        self.assertEqual(run["status"], "done")
        self.assertIsNone(run["error"])

        stored = db.get_pgn("black")
        self.assertIsNotNone(stored)
        self.assertEqual(stored["game_count"], 1)

    def test_streaming_sync_updates_library_and_analysis_between_batches(self) -> None:
        config_id = db.upsert_sync_config("white", "lichess", "alice")
        observations: dict[str, int] = {}

        batch_one = """
[Event "G1"]
[Site "https://lichess.org/game0001"]
[Date "2026.01.01"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

[Event "G2"]
[Site "https://lichess.org/game0002"]
[Date "2026.01.02"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *
""".strip()

        batch_two = """
[Event "G3"]
[Site "https://lichess.org/game0003"]
[Date "2026.01.03"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. d4 d5 2. c4 e6 *
""".strip()

        def fake_batches(*_args, **_kwargs):
            yield {
                "platform": "lichess",
                "pgn_text": batch_one,
                "game_ids": ["game0001", "game0002"],
                "raw_count": 2,
                "effective_limit": 2,
                "pages_fetched": 1,
            }
            observations["games_after_first_chunk"] = db.get_pgn("white")["game_count"]
            observations["mistakes_after_first_chunk"] = db.count_active_mistakes("white")
            observations["progress_after_first_chunk"] = db.get_analysis_checkpoint("white")["processed_games"]
            yield {
                "platform": "lichess",
                "pgn_text": batch_two,
                "game_ids": ["game0003"],
                "raw_count": 1,
                "effective_limit": 1,
                "pages_fetched": 2,
            }

        with patch.object(fetcher, "iter_lichess_pgn_batches", side_effect=fake_batches), patch.object(
            fetcher,
            "engine_status",
            return_value=(True, "fake-stockfish"),
        ), patch.object(fetcher, "start_engine", return_value=(_FakeEngine(), "fake-stockfish")):
            fetcher._sync_task(config_id)

        sync_run = db.latest_sync_run(config_id)
        analysis_run = db.latest_run("white")
        checkpoint = db.get_analysis_checkpoint("white")
        stored = db.get_pgn("white")

        self.assertEqual(observations["games_after_first_chunk"], 2)
        self.assertEqual(observations["progress_after_first_chunk"], 2)
        self.assertGreater(observations["mistakes_after_first_chunk"], 0)

        self.assertIsNotNone(sync_run)
        self.assertEqual(sync_run["status"], "done")
        self.assertTrue(sync_run["details"]["analysis_streaming"])
        self.assertEqual(sync_run["details"]["analysis_progress"], 3)
        self.assertEqual(sync_run["details"]["analysis_total"], 3)

        self.assertIsNotNone(analysis_run)
        self.assertEqual(analysis_run["status"], "done")
        self.assertEqual(analysis_run["progress"], 3)
        self.assertEqual(analysis_run["progress_total"], 3)

        self.assertIsNotNone(checkpoint)
        self.assertTrue(checkpoint["completed"])
        self.assertEqual(checkpoint["processed_games"], 3)

        self.assertIsNotNone(stored)
        self.assertEqual(stored["game_count"], 3)
        self.assertGreater(db.count_active_mistakes("white"), 0)

    def test_sync_queues_catchup_analysis_when_stream_checkpoint_remains_incomplete(self) -> None:
        config_id = db.upsert_sync_config("white", "lichess", "alice")
        pgn_text = """
[Event "G1"]
[Site "?"]
[Date "2026.01.01"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

[Event "G2"]
[Site "?"]
[Date "2026.01.02"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. d4 d5 2. c4 e6 *

[Event "G3"]
[Site "?"]
[Date "2026.01.03"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. c4 e5 2. Nc3 Nf6 *

[Event "G4"]
[Site "?"]
[Date "2026.01.04"]
[Round "?"]
[White "alice"]
[Black "B"]
[Result "*"]

1. Nf3 d5 2. g3 c5 *
""".strip()

        cleaned, count = fetcher.analysis.parse_and_truncate(pgn_text)
        db.upsert_pgn("white", cleaned, count, reset_analysis=False)
        fingerprint = fetcher.analysis.fingerprint_pgn(cleaned)
        db.upsert_analysis_checkpoint("white", fingerprint, count, 2, False)

        with patch.object(fetcher, "iter_lichess_pgn_batches", return_value=iter([])), patch.object(
            fetcher,
            "engine_status",
            return_value=(True, "fake-stockfish"),
        ), patch.object(fetcher, "start_engine", return_value=(_FakeEngine(), "fake-stockfish")), patch.object(
            fetcher.analysis,
            "analyze_in_background",
            return_value=None,
        ):
            fetcher._sync_task(config_id)

        sync_run = db.latest_sync_run(config_id)
        latest_run = db.latest_run("white")
        checkpoint = db.get_analysis_checkpoint("white")

        self.assertIsNotNone(sync_run)
        self.assertEqual(sync_run["status"], "done")
        self.assertTrue(sync_run["details"]["analysis_enqueued"])

        self.assertIsNotNone(latest_run)
        self.assertEqual(latest_run["status"], "queued")
        self.assertEqual(latest_run["progress"], 2)
        self.assertEqual(latest_run["progress_total"], 4)

        self.assertIsNotNone(checkpoint)
        self.assertFalse(checkpoint["completed"])
        self.assertEqual(checkpoint["processed_games"], 2)
