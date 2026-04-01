from __future__ import annotations

import io

import chess
import chess.pgn

from chess_analyzer import analysis, opening
from tests.support import DatabaseIsolatedTestCase


class AnalysisHelpersTest(DatabaseIsolatedTestCase):
    def test_parse_and_truncate_respects_game_and_ply_limits(self) -> None:
        original_max_games = analysis.MAX_GAMES
        original_opening_plies = analysis.OPENING_PLIES
        analysis.MAX_GAMES = 1
        analysis.OPENING_PLIES = 4
        try:
            pgn_text = """
[Event "Game 1"]
[Site "?"]
[Date "2026.01.01"]
[Round "?"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *

[Event "Game 2"]
[Site "?"]
[Date "2026.01.02"]
[Round "?"]
[White "White"]
[Black "Black"]
[Result "*"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 *
""".strip()
            truncated, count = analysis.parse_and_truncate(pgn_text)
        finally:
            analysis.MAX_GAMES = original_max_games
            analysis.OPENING_PLIES = original_opening_plies

        self.assertEqual(count, 1)
        game = chess.pgn.read_game(io.StringIO(truncated))
        self.assertIsNotNone(game)
        self.assertEqual(len(list(game.mainline_moves())), 4)

    def test_opening_lookup_returns_expected_tag(self) -> None:
        board = chess.Board()
        for move in ("e4", "c5", "Nf3", "d6"):
            board.push_san(move)

        self.assertEqual(
            opening.get_opening(board),
            ("B50", "Sicilian Defense: Modern Variations"),
        )

    def test_parse_and_truncate_skips_unsupported_variant_games(self) -> None:
        pgn_text = """
[Event "Variant Game"]
[Site "?"]
[Date "2026.01.01"]
[Round "?"]
[White "White"]
[Black "Black"]
[Result "*"]
[Variant "Horde"]

1. e4 e5 *

[Event "Standard Game"]
[Site "?"]
[Date "2026.01.02"]
[Round "?"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *
""".strip()

        truncated, count = analysis.parse_and_truncate(pgn_text)

        self.assertEqual(count, 1)
        game = chess.pgn.read_game(io.StringIO(truncated))
        self.assertIsNotNone(game)
        self.assertEqual([move.uci() for move in game.mainline_moves()], ["e2e4", "e7e5", "g1f3", "b8c6"])
