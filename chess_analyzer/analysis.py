"""Chess opening analysis — finds recurring mistakes using Stockfish."""
from __future__ import annotations

import io
import threading
from typing import Any, Optional

import chess
import chess.engine
import chess.pgn

from chess_analyzer import db
from chess_analyzer.engine import start_engine

# ── Defaults (overridable via env) ────────────────────────────────────────
import os

ANALYSIS_DEPTH   = int(os.environ.get("ANALYSIS_DEPTH",        "8"))   # depth 8 is fast & sufficient for openings
OPENING_PLIES    = int(os.environ.get("OPENING_PLIES_LIMIT",   "20"))
THRESHOLD_CP     = int(os.environ.get("MISTAKE_THRESHOLD_CP",  "100"))
MIN_OCCURRENCES  = int(os.environ.get("MIN_PAIR_OCCURRENCES",  "2"))
MULTIPV          = int(os.environ.get("MULTIPV",               "3"))   # 3 lines is enough
TOP_MOVE_DELTA   = int(os.environ.get("TOP_MOVE_THRESHOLD_CP", "50"))
MATE_SCORE       = int(os.environ.get("MATE_SCORE_CP",         "10000"))
MAX_GAMES        = int(os.environ.get("MAX_GAMES_PER_UPLOAD",  "1000"))
MAX_FILE_MB      = int(os.environ.get("MAX_FILE_SIZE_MB",      "10"))


# ── PGN utilities ──────────────────────────────────────────────────────────

def parse_and_truncate(pgn_text: str) -> tuple[str, int]:
    """Return cleaned PGN (first OPENING_PLIES only) and game count."""
    buf = io.StringIO()
    count = 0
    pgn_io = io.StringIO(pgn_text)
    while count < MAX_GAMES:
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break
        truncated = chess.pgn.Game()
        node = truncated
        for i, move in enumerate(game.mainline_moves()):
            if i >= OPENING_PLIES:
                break
            node = node.add_variation(move)
        exporter = chess.pgn.StringExporter(headers=False, variations=False, comments=False)
        buf.write(truncated.accept(exporter))
        buf.write("\n\n")
        count += 1
    return buf.getvalue(), count


# ── Analysis core ──────────────────────────────────────────────────────────

def _pos_key(board: chess.Board) -> str:
    ep = chess.square_name(board.ep_square) if board.ep_square else "-"
    return f"{board.board_fen()} {'w' if board.turn else 'b'} {board.castling_xfen()} {ep}"


def _score_cp(score: Optional[chess.engine.PovScore]) -> Optional[int]:
    if score is None:
        return None
    val = score.white().score(mate_score=MATE_SCORE)
    return int(val) if val is not None else None


def _collect_pairs(pgn_text: str, color: str) -> tuple[dict, dict]:
    target = chess.WHITE if color == "white" else chess.BLACK
    counts: dict[tuple[str, str], int] = {}
    fens:   dict[tuple[str, str], str] = {}
    pgn_io = io.StringIO(pgn_text)
    while True:
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break
        board = game.board()
        for i, move in enumerate(game.mainline_moves()):
            if i >= OPENING_PLIES:
                break
            if board.turn == target:
                key = (_pos_key(board), move.uci())
                counts[key] = counts.get(key, 0) + 1
                fens.setdefault(key, board.fen())
            board.push(move)
    return counts, fens


def analyze(pgn_text: str, color: str) -> list[dict[str, Any]]:
    """Run Stockfish analysis and return a list of mistake dicts."""
    counts, fens = _collect_pairs(pgn_text, color)
    candidates = [(k, n) for k, n in counts.items() if n >= MIN_OCCURRENCES]
    if not candidates:
        return []
    candidates.sort(key=lambda x: x[1], reverse=True)

    pos_cache: dict[str, tuple[Optional[int], list[str]]] = {}
    after_cache: dict[str, Optional[int]] = {}
    depth = chess.engine.Limit(depth=ANALYSIS_DEPTH)
    mistakes: list[dict[str, Any]] = []

    engine, _ = start_engine()
    try:
        for (pos_key, user_move), count in candidates:
            fen = fens.get((pos_key, user_move))
            if not fen:
                continue
            try:
                board = chess.Board(fen)
            except ValueError:
                continue

            # Analyse the position if not cached
            if pos_key not in pos_cache:
                try:
                    infos = engine.analyse(board, depth, multipv=MULTIPV)
                except chess.engine.EngineError:
                    pos_cache[pos_key] = (None, [])
                else:
                    if isinstance(infos, dict):
                        infos = [infos]
                    best_cp = _score_cp(infos[0].get("score"))
                    tops: list[str] = []
                    if best_cp is not None:
                        for info in infos:
                            pv = info.get("pv") or []
                            if not pv:
                                continue
                            mv_cp = _score_cp(info.get("score"))
                            if mv_cp is None:
                                continue
                            if best_cp - mv_cp <= TOP_MOVE_DELTA:
                                tops.append(pv[0].uci())
                    pos_cache[pos_key] = (best_cp, tops)

            best_cp, tops = pos_cache[pos_key]
            if best_cp is None:
                continue

            # Skip if user's move is already one of the top moves
            if tops and user_move in tops:
                continue

            try:
                move_obj = chess.Move.from_uci(user_move)
            except ValueError:
                continue
            if move_obj not in board.legal_moves:
                continue

            # Analyse position after user's move
            board_after = board.copy(stack=False)
            board_after.push(move_obj)
            after_key = _pos_key(board_after)
            if after_key not in after_cache:
                try:
                    info_after = engine.analyse(board_after, depth)
                except chess.engine.EngineError:
                    after_cache[after_key] = None
                else:
                    after_cache[after_key] = _score_cp(info_after.get("score"))

            cp_after = after_cache.get(after_key)
            if cp_after is None:
                continue

            mover_white = board.turn == chess.WHITE
            cp_loss = (best_cp - cp_after) if mover_white else (cp_after - best_cp)
            if cp_loss <= THRESHOLD_CP:
                continue

            mistakes.append({
                "fen":         fen,
                "user_move":   user_move,
                "top_moves":   tops,
                "avg_cp_loss": int(round(cp_loss)),
                "pair_count":  count,
                "color":       color,
            })
    finally:
        try:
            engine.quit()
        except chess.engine.EngineError:
            pass

    mistakes.sort(key=lambda m: (m["pair_count"], m["avg_cp_loss"]), reverse=True)
    return mistakes


# ── Async wrapper ──────────────────────────────────────────────────────────

def analyze_in_background(pgn_text: str, color: str, run_id: int) -> None:
    def _task() -> None:
        try:
            results = analyze(pgn_text, color)
            db.replace_mistakes(color, results)
            db.finish_run(run_id)
        except Exception as exc:
            db.finish_run(run_id, error=str(exc))

    threading.Thread(target=_task, daemon=True).start()


# ── Stats ─────────────────────────────────────────────────────────────────

def compute_stats(mistakes: list[dict]) -> dict:
    if not mistakes:
        return {"total": 0, "avg_cp": 0, "median_cp": 0, "max_cp": 0, "total_occurrences": 0}
    cp = sorted(int(m["avg_cp_loss"]) for m in mistakes)
    mid = len(cp) // 2
    median = cp[mid] if len(cp) % 2 else (cp[mid - 1] + cp[mid]) // 2
    return {
        "total":             len(mistakes),
        "avg_cp":            round(sum(cp) / len(cp)),
        "median_cp":         median,
        "max_cp":            max(cp),
        "total_occurrences": sum(int(m["pair_count"]) for m in mistakes),
    }
