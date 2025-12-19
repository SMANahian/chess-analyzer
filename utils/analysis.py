"""Chess game analysis utilities."""
from __future__ import annotations

import io
import threading
from pathlib import Path
from typing import Any

import chess
import chess.engine
import chess.pgn

from config import (
    ANALYSIS_DEPTH,
    MATE_SCORE_CP,
    MAX_FILE_SIZE_MB,
    MAX_GAMES_PER_UPLOAD,
    MIN_PAIR_OCCURRENCES,
    MISTAKE_THRESHOLD_CP,
    MULTIPV,
    OPENING_PLIES_LIMIT,
    TOP_MOVE_THRESHOLD_CP,
)
from utils.database import atomic_write_json
from utils.stockfish import configure_engine, start_stockfish


def clean_and_merge_pgns(files: list[Any], dest_path: Path) -> int:
    """Clean and merge PGN files, keeping only opening moves."""
    total_games = 0
    total_size = 0

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with dest_path.open("w", encoding="utf-8") as out:
        for fs in files:
            data_bytes = fs.read()
            total_size += len(data_bytes)
            if total_size > MAX_FILE_SIZE_MB * 1024 * 1024:
                break
            data = data_bytes.decode("utf-8", "ignore")
            pgn_io = io.StringIO(data)

            while total_games < MAX_GAMES_PER_UPLOAD:
                game = chess.pgn.read_game(pgn_io)
                if game is None:
                    break
                new_game = chess.pgn.Game()
                node = new_game
                for ply_index, move in enumerate(game.mainline_moves()):
                    if ply_index >= OPENING_PLIES_LIMIT:
                        break
                    node = node.add_variation(move)

                exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
                out.write(new_game.accept(exporter))
                out.write("\n\n")
                total_games += 1

            if total_games >= MAX_GAMES_PER_UPLOAD:
                break
    return total_games


def position_key(board: chess.Board) -> str:
    """Generate a unique key for a board position."""
    ep = chess.square_name(board.ep_square) if board.ep_square is not None else "-"
    return f"{board.board_fen()} {'w' if board.turn else 'b'} {board.castling_xfen()} {ep}"


def score_to_cp(score: chess.engine.PovScore | None) -> int | None:
    """Convert an engine score to centipawns."""
    if score is None:
        return None
    value = score.white().score(mate_score=MATE_SCORE_CP)
    if value is None:
        return None
    return int(value)


def collect_move_pairs(paths: list[str], color: str) -> tuple[dict[tuple[str, str], int], dict[tuple[str, str], str]]:
    """Collect position-move pairs from PGN files."""
    pair_counts: dict[tuple[str, str], int] = {}
    pair_fens: dict[tuple[str, str], str] = {}

    target_turn = chess.WHITE if color == "white" else chess.BLACK
    for path in paths:
        pgn_path = Path(path)
        if not pgn_path.exists():
            continue
        with pgn_path.open(encoding="utf-8", errors="ignore") as pgn:
            while True:
                game = chess.pgn.read_game(pgn)
                if game is None:
                    break
                board = game.board()
                for ply_index, move in enumerate(game.mainline_moves()):
                    if ply_index >= OPENING_PLIES_LIMIT:
                        break
                    if board.turn != target_turn:
                        board.push(move)
                        continue
                    key = (position_key(board), move.uci())
                    pair_counts[key] = pair_counts.get(key, 0) + 1
                    pair_fens.setdefault(key, board.fen())
                    board.push(move)

    return pair_counts, pair_fens


def analyze_pgn(paths: list[str], color: str) -> list[dict[str, Any]]:
    """Analyze PGN files for opening mistakes."""
    pair_counts, pair_fens = collect_move_pairs(paths, color)
    candidates = [(key, count) for key, count in pair_counts.items() if count >= MIN_PAIR_OCCURRENCES]
    if not candidates:
        return []

    candidates.sort(key=lambda item: item[1], reverse=True)

    mistakes: list[dict[str, Any]] = []
    position_cache: dict[str, tuple[int | None, list[str]]] = {}
    after_cache: dict[str, int | None] = {}
    depth_limit = chess.engine.Limit(depth=ANALYSIS_DEPTH)

    engine, _stockfish_path = start_stockfish()

    try:
        configure_engine(engine)
        for (pos_key, user_move), count in candidates:
            fen = pair_fens.get((pos_key, user_move))
            if not fen:
                continue
            try:
                board = chess.Board(fen)
            except ValueError:
                continue

            if pos_key not in position_cache:
                try:
                    infos = engine.analyse(board, depth_limit, multipv=MULTIPV)
                except chess.engine.EngineError:
                    position_cache[pos_key] = (None, [])
                else:
                    if isinstance(infos, dict):
                        infos = [infos]
                    best_score = score_to_cp(infos[0].get("score"))
                    top_moves: list[str] = []
                    if best_score is not None:
                        for info in infos:
                            pv = info.get("pv") or []
                            if not pv:
                                continue
                            mv = pv[0]
                            mv_score = score_to_cp(info.get("score"))
                            if mv_score is None:
                                continue
                            if best_score - mv_score <= TOP_MOVE_THRESHOLD_CP:
                                top_moves.append(mv.uci())
                    position_cache[pos_key] = (best_score, top_moves)

            best_score, top_moves = position_cache[pos_key]
            if best_score is None:
                continue

            try:
                move_obj = chess.Move.from_uci(user_move)
            except ValueError:
                continue
            if move_obj not in board.legal_moves:
                continue

            if top_moves and user_move in top_moves:
                continue

            board_after = board.copy(stack=False)
            board_after.push(move_obj)
            after_key = position_key(board_after)
            if after_key not in after_cache:
                try:
                    info_after = engine.analyse(board_after, depth_limit)
                except chess.engine.EngineError:
                    after_cache[after_key] = None
                else:
                    after_cache[after_key] = score_to_cp(info_after.get("score"))

            score_after = after_cache.get(after_key)
            if score_after is None:
                continue

            mover_is_white = board.turn == chess.WHITE
            cp_loss = (best_score - score_after) if mover_is_white else (score_after - best_score)
            if cp_loss <= MISTAKE_THRESHOLD_CP:
                continue

            mistakes.append(
                {
                    "fen": fen,
                    "user_move": user_move,
                    "top_moves": top_moves,
                    "avg_cp_loss": int(round(cp_loss)),
                    "pair_count": count,
                    "color": color,
                }
            )
    finally:
        try:
            engine.quit()
        except chess.engine.EngineError:
            pass

    mistakes.sort(key=lambda item: (item["pair_count"], item["avg_cp_loss"]), reverse=True)
    return mistakes


def analyze_async(paths: list[str], analysis_file: Path, flag_file: Path, error_file: Path, color: str) -> None:
    """Run analysis asynchronously in a background thread."""
    def task() -> None:
        try:
            mistakes = analyze_pgn(paths, color)
            atomic_write_json(analysis_file, mistakes)
        except Exception as exc:
            atomic_write_json(error_file, {"error": str(exc)})
        finally:
            try:
                flag_file.unlink(missing_ok=True)
            except OSError:
                pass

    threading.Thread(target=task, daemon=True).start()


def compute_analysis_stats(mistakes: list[dict[str, Any]]) -> dict[str, int]:
    """Compute statistics from analysis results."""
    if not mistakes:
        return {
            "total": 0,
            "avg_cp": 0,
            "median_cp": 0,
            "total_frequency": 0,
            "max_cp": 0,
            "white_count": 0,
            "black_count": 0,
        }

    cp_values = [int(m.get("avg_cp_loss", 0)) for m in mistakes if isinstance(m.get("avg_cp_loss"), (int, float))]
    cp_values.sort()
    total_frequency = sum(int(m.get("pair_count", 0) or 0) for m in mistakes)
    avg_cp = round(sum(cp_values) / len(cp_values)) if cp_values else 0
    mid = len(cp_values) // 2
    if len(cp_values) % 2:
        median_cp = cp_values[mid]
    else:
        median_cp = round((cp_values[mid - 1] + cp_values[mid]) / 2) if cp_values else 0

    white_count = sum(1 for m in mistakes if m.get("color") == "white")
    black_count = sum(1 for m in mistakes if m.get("color") == "black")

    return {
        "total": len(mistakes),
        "avg_cp": avg_cp,
        "median_cp": median_cp,
        "total_frequency": total_frequency,
        "max_cp": max(cp_values) if cp_values else 0,
        "white_count": white_count,
        "black_count": black_count,
    }
