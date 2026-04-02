from __future__ import annotations

from unittest.mock import patch

import chess

from chess_analyzer import analysis, db
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


class BatchedAnalysisTest(DatabaseIsolatedTestCase):
    def test_incremental_batches_do_not_skip_future_games_after_progress_updates(self) -> None:
        original_batch = analysis.ANALYSIS_BATCH_GAMES
        analysis.ANALYSIS_BATCH_GAMES = 2
        try:
            pgn_text = """
[Event "G1"]
[Site "?"]
[Date "2026.01.01"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

[Event "G2"]
[Site "?"]
[Date "2026.01.02"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. d4 d5 2. c4 e6 *

[Event "G3"]
[Site "?"]
[Date "2026.01.03"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. c4 e5 2. Nc3 Nf6 *

[Event "G4"]
[Site "?"]
[Date "2026.01.04"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. Nf3 d5 2. g3 c5 *

[Event "G5"]
[Site "?"]
[Date "2026.01.05"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 c5 2. Nf3 d6 *
            """.strip()

            cleaned, count = analysis.parse_and_truncate(pgn_text)
            self.assertEqual(count, 5)

            calls: list[tuple[int, int]] = []

            def fake_process(
                engine,
                color,
                run_id,
                batch_games,
                source_fingerprint,
                total_games,
                processed_games,
            ) -> int:
                calls.append((len(batch_games), processed_games))
                return processed_games + len(batch_games)

            with patch.object(analysis, "_process_analysis_batch", side_effect=fake_process):
                processed = analysis._run_incremental_batches(
                    engine=None,
                    pgn_text=cleaned,
                    color="white",
                    run_id=1,
                    source_fingerprint=analysis.fingerprint_pgn(cleaned),
                    total_games=count,
                    processed_games=0,
                )

            self.assertEqual(processed, 5)
            self.assertEqual(calls, [(2, 0), (2, 2), (1, 4)])
        finally:
            analysis.ANALYSIS_BATCH_GAMES = original_batch

    def test_batched_analysis_publishes_partial_results_and_resumes(self) -> None:
        original_batch = analysis.ANALYSIS_BATCH_GAMES
        original_occurrences = analysis.MIN_OCCURRENCES
        original_threshold = analysis.THRESHOLD_CP
        analysis.ANALYSIS_BATCH_GAMES = 2
        analysis.MIN_OCCURRENCES = 1
        analysis.THRESHOLD_CP = 50
        try:
            pgn_text = """
[Event "G1"]
[Site "?"]
[Date "2026.01.01"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

[Event "G2"]
[Site "?"]
[Date "2026.01.02"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

[Event "G3"]
[Site "?"]
[Date "2026.01.03"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Bc4 Nc6 *

[Event "G4"]
[Site "?"]
[Date "2026.01.04"]
[Round "?"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Bc4 Nc6 *
            """.strip()

            cleaned, count = analysis.parse_and_truncate(pgn_text)
            db.upsert_pgn("white", cleaned, count)
            source_fingerprint = analysis.fingerprint_pgn(cleaned)
            first_run = db.start_run("white", progress=0, total=count)
            self.assertTrue(db.mark_run_started(first_run))
            db.upsert_analysis_checkpoint("white", source_fingerprint, count, 0, False)

            games = list(analysis.iter_supported_games(cleaned))
            self.assertEqual(len(games), 4)
            processed = analysis._process_analysis_batch(
                _FakeEngine(),
                "white",
                first_run,
                games[:2],
                source_fingerprint,
                count,
                0,
            )
            self.assertEqual(processed, 2)
            db.finish_run(first_run, status="cancelled")

            partial_run = db.latest_run("white")
            partial_checkpoint = db.get_analysis_checkpoint("white")
            self.assertIsNotNone(partial_run)
            self.assertEqual(partial_run["status"], "cancelled")
            self.assertEqual(partial_run["progress"], 2)
            self.assertEqual(partial_run["progress_total"], 4)
            self.assertIsNotNone(partial_checkpoint)
            self.assertFalse(partial_checkpoint["completed"])
            self.assertEqual(partial_checkpoint["processed_games"], 2)
            self.assertGreater(db.count_active_mistakes("white"), 0)

            second_run = db.start_run(
                "white",
                progress=partial_checkpoint["processed_games"],
                total=partial_checkpoint["total_games"],
            )
            self.assertTrue(db.mark_run_started(second_run))
            with patch.object(analysis, "start_engine", return_value=(_FakeEngine(), "fake")):
                analysis._run_analysis_job("white", second_run)

            final_run = db.latest_run("white")
            final_checkpoint = db.get_analysis_checkpoint("white")
            self.assertIsNotNone(final_run)
            self.assertEqual(final_run["status"], "done")
            self.assertEqual(final_run["progress"], 4)
            self.assertIsNotNone(final_checkpoint)
            self.assertTrue(final_checkpoint["completed"])
            self.assertEqual(final_checkpoint["processed_games"], 4)
        finally:
            analysis.ANALYSIS_BATCH_GAMES = original_batch
            analysis.MIN_OCCURRENCES = original_occurrences
            analysis.THRESHOLD_CP = original_threshold
