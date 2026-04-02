"""Chess opening analysis — finds recurring mistakes using Stockfish."""
from __future__ import annotations

import io
import hashlib
import queue
import threading
from typing import Any, Callable, Optional

import chess
import chess.engine
import chess.pgn

from chess_analyzer import db
from chess_analyzer.engine import start_engine
from chess_analyzer import opening as eco

# ── Defaults (overridable via env) ────────────────────────────────────────
import os

ANALYSIS_DEPTH   = int(os.environ.get("ANALYSIS_DEPTH",        "6"))   # tuned for fast opening triage
OPENING_PLIES    = int(os.environ.get("OPENING_PLIES_LIMIT",   "16"))
THRESHOLD_CP     = int(os.environ.get("MISTAKE_THRESHOLD_CP",  "50"))
MIN_OCCURRENCES  = int(os.environ.get("MIN_PAIR_OCCURRENCES",  "2"))
MULTIPV          = int(os.environ.get("MULTIPV",               "2"))   # enough for fast opening blunder detection
TOP_MOVE_DELTA   = int(os.environ.get("TOP_MOVE_THRESHOLD_CP", "35"))
MATE_SCORE       = int(os.environ.get("MATE_SCORE_CP",         "10000"))
MAX_GAMES        = int(os.environ.get("MAX_GAMES_PER_UPLOAD",  "5000"))
MAX_FILE_MB      = int(os.environ.get("MAX_FILE_SIZE_MB",      "10"))
ANALYSIS_BATCH_GAMES = int(os.environ.get("ANALYSIS_BATCH_GAMES", "20"))
ANALYSIS_BATCH_POSITION_LIMIT = int(os.environ.get("ANALYSIS_BATCH_POSITION_LIMIT", "60"))
ANALYSIS_MAX_CANDIDATES = int(os.environ.get("ANALYSIS_MAX_CANDIDATES", "250"))

_ANALYSIS_QUEUE: "queue.Queue[tuple[str, int]]" = queue.Queue()
_WORKER_LOCK = threading.Lock()
_WORKER_THREAD: Optional[threading.Thread] = None
_CURRENT_JOB_DEPTH: int = ANALYSIS_DEPTH  # set per job by _run_analysis_job


class AnalysisCancelled(Exception):
    pass


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
        if not _is_supported_game(game):
            continue
        truncated = chess.pgn.Game()
        node = truncated
        board = game.board()
        kept_moves = 0
        for i, move in enumerate(game.mainline_moves()):
            if i >= OPENING_PLIES:
                break
            if move not in board.legal_moves:
                kept_moves = 0
                break
            node = node.add_variation(move)
            board.push(move)
            kept_moves += 1
        if kept_moves == 0:
            continue
        exporter = chess.pgn.StringExporter(headers=False, variations=False, comments=False)
        buf.write(truncated.accept(exporter))
        buf.write("\n\n")
        count += 1
    return buf.getvalue(), count


def _is_supported_game(game: chess.pgn.Game) -> bool:
    variant = (game.headers.get("Variant") or "Standard").strip()
    if variant and variant.lower() != "standard":
        return False
    if game.headers.get("SetUp") == "1":
        return False
    if game.headers.get("FEN"):
        return False
    return True


def fingerprint_pgn(pgn_text: str) -> str:
    return hashlib.sha256(pgn_text.encode("utf-8", errors="ignore")).hexdigest()


def iter_supported_games(pgn_text: str):
    pgn_io = io.StringIO(pgn_text)
    seen = 0
    while seen < MAX_GAMES:
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break
        if not _is_supported_game(game):
            continue
        seen += 1
        yield game


def count_supported_games(pgn_text: str) -> int:
    return sum(1 for _ in iter_supported_games(pgn_text))


# ── Analysis core ──────────────────────────────────────────────────────────

def _pos_key(board: chess.Board) -> str:
    ep = chess.square_name(board.ep_square) if board.ep_square else "-"
    return f"{board.board_fen()} {'w' if board.turn else 'b'} {board.castling_xfen()} {ep}"


def _score_cp(score: Optional[chess.engine.PovScore]) -> Optional[int]:
    if score is None:
        return None
    val = score.white().score(mate_score=MATE_SCORE)
    return int(val) if val is not None else None


def _collect_pairs(pgn_text: str, color: str) -> tuple[dict, dict, dict, dict]:
    target      = chess.WHITE if color == "white" else chess.BLACK
    counts:     dict[tuple[str, str], int]             = {}
    fens:       dict[tuple[str, str], str]             = {}
    openings:   dict[tuple[str, str], tuple[str, str]] = {}
    move_lists: dict[tuple[str, str], str]             = {}
    for game in iter_supported_games(pgn_text):
        g_counts, g_fens, g_openings, g_move_lists = _collect_pairs_from_game(game, color)
        for key, value in g_counts.items():
            counts[key] = counts.get(key, 0) + value
        fens.update({key: value for key, value in g_fens.items() if key not in fens})
        openings.update({key: value for key, value in g_openings.items() if key not in openings})
        move_lists.update({key: value for key, value in g_move_lists.items() if key not in move_lists})
    return counts, fens, openings, move_lists


def _collect_pairs_from_game(
    game: chess.pgn.Game,
    color: str,
) -> tuple[
    dict[tuple[str, str], int],
    dict[tuple[str, str], str],
    dict[tuple[str, str], tuple[str, str]],
    dict[tuple[str, str], str],
]:
    target = chess.WHITE if color == "white" else chess.BLACK
    counts:     dict[tuple[str, str], int]             = {}
    fens:       dict[tuple[str, str], str]             = {}
    openings:   dict[tuple[str, str], tuple[str, str]] = {}
    move_lists: dict[tuple[str, str], str]             = {}
    board = game.board()
    last_op: Optional[tuple[str, str]] = None
    played_uci: list[str] = []
    for i, move in enumerate(game.mainline_moves()):
        if i >= OPENING_PLIES:
            break
        if move not in board.legal_moves:
            break
        op = eco.get_opening(board)
        if op:
            last_op = op
        if board.turn == target:
            key = (_pos_key(board), move.uci())
            counts[key] = counts.get(key, 0) + 1
            fens.setdefault(key, board.fen())
            if last_op and key not in openings:
                openings[key] = last_op
            if key not in move_lists:
                move_lists[key] = " ".join(played_uci)
        played_uci.append(move.uci())
        board.push(move)
    return counts, fens, openings, move_lists


def analyze(
    pgn_text: str,
    color: str,
    progress_cb: Any = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> list[dict[str, Any]]:
    """Run Stockfish analysis and return a list of mistake dicts.

    progress_cb(done, total) is called every few candidates if provided.
    """
    counts, fens, openings, move_lists = _collect_pairs(pgn_text, color)
    candidates = [(k, n) for k, n in counts.items() if n >= MIN_OCCURRENCES]
    if not candidates:
        if progress_cb:
            progress_cb(0, 0)
        return []
    candidates.sort(key=lambda x: x[1], reverse=True)
    if ANALYSIS_MAX_CANDIDATES > 0:
        candidates = candidates[:ANALYSIS_MAX_CANDIDATES]
    if progress_cb:
        progress_cb(0, len(candidates))

    pos_cache: dict[str, tuple[Optional[int], list[str]]] = {}
    after_cache: dict[str, Optional[int]] = {}
    depth = chess.engine.Limit(depth=ANALYSIS_DEPTH)
    mistakes: list[dict[str, Any]] = []

    engine, _ = start_engine()
    try:
        for _done_i, ((pos_key, user_move), count) in enumerate(candidates):
            if should_cancel and should_cancel():
                raise AnalysisCancelled()
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

            op = openings.get((pos_key, user_move))
            mistakes.append({
                "fen":          fen,
                "user_move":    user_move,
                "top_moves":    tops,
                "avg_cp_loss":  int(round(cp_loss)),
                "pair_count":   count,
                "color":        color,
                "opening_eco":  op[0] if op else None,
                "opening_name": op[1] if op else None,
                "move_list":    move_lists.get((pos_key, user_move)),
            })

            if progress_cb and (_done_i + 1) % 5 == 0:
                progress_cb(_done_i + 1, len(candidates))
        if progress_cb:
            progress_cb(len(candidates), len(candidates))
    finally:
        try:
            engine.quit()
        except chess.engine.EngineError:
            pass

    mistakes.sort(key=lambda m: (m["pair_count"], m["avg_cp_loss"]), reverse=True)
    return mistakes


# ── Async wrapper ──────────────────────────────────────────────────────────

def analyze_in_background(color: str, run_id: int) -> None:
    _ensure_worker()
    _ANALYSIS_QUEUE.put((color, run_id))


def _ensure_worker() -> None:
    global _WORKER_THREAD
    with _WORKER_LOCK:
        if _WORKER_THREAD is not None and _WORKER_THREAD.is_alive():
            return
        t = threading.Thread(target=_analysis_worker, daemon=True)
        t.start()
        _WORKER_THREAD = t


def _analysis_worker() -> None:
    while True:
        color, run_id = _ANALYSIS_QUEUE.get()
        try:
            if db.mark_run_started(run_id):
                _run_analysis_job(color, run_id)
        except Exception:  # noqa: BLE001 — keep worker alive on unexpected errors
            pass
        finally:
            _ANALYSIS_QUEUE.task_done()


def _run_analysis_job(color: str, run_id: int) -> None:
    global _CURRENT_JOB_DEPTH
    depth_setting = db.get_setting("analysis_depth")
    if depth_setting is not None:
        try:
            _CURRENT_JOB_DEPTH = max(1, min(30, int(depth_setting)))
        except (ValueError, TypeError):
            _CURRENT_JOB_DEPTH = ANALYSIS_DEPTH
    else:
        _CURRENT_JOB_DEPTH = ANALYSIS_DEPTH

    pgn_row = db.get_pgn(color)
    if not pgn_row:
        db.finish_run(run_id, status="error", error=f"No {color} games uploaded yet")
        return

    pgn_text = pgn_row["content"]
    source_fingerprint = fingerprint_pgn(pgn_text)
    checkpoint = db.get_analysis_checkpoint(color)

    if checkpoint and checkpoint["source_fingerprint"] == source_fingerprint and not checkpoint["completed"]:
        total_games = int(checkpoint["total_games"])
        processed_games = int(checkpoint["processed_games"])
        resumed = processed_games > 0
    else:
        total_games = count_supported_games(pgn_text)
        processed_games = 0
        resumed = False
        db.clear_analysis_workspace(color)
        db.upsert_analysis_checkpoint(color, source_fingerprint, total_games, 0, False)

    db.update_run_progress(run_id, processed_games, total_games)
    db.log_event(
        "analysis",
        f"{color} analysis {'resumed' if resumed else 'started'}",
        details={
            "run_id": run_id,
            "processed_games": processed_games,
            "total_games": total_games,
            "batch_size": ANALYSIS_BATCH_GAMES,
            "depth": _CURRENT_JOB_DEPTH,
            "opening_plies": OPENING_PLIES,
            "batch_position_limit": ANALYSIS_BATCH_POSITION_LIMIT,
        },
    )

    if total_games == 0:
        db.finish_run(run_id)
        db.upsert_analysis_checkpoint(color, source_fingerprint, 0, 0, True)
        db.log_event("analysis", f"{color} analysis completed with no supported games")
        return

    try:
        engine, _ = start_engine()
    except Exception as exc:
        db.finish_run(run_id, status="error", error=str(exc))
        db.log_event(
            "analysis",
            f"{color} analysis failed to start engine",
            level="error",
            details={"run_id": run_id, "error": str(exc)},
        )
        return
    try:
        processed_games = _run_incremental_batches(
            engine,
            pgn_text,
            color,
            run_id,
            source_fingerprint,
            total_games,
            processed_games,
        )
        db.upsert_analysis_checkpoint(color, source_fingerprint, total_games, processed_games, True)
        db.update_run_progress(run_id, processed_games, total_games)
        db.finish_run(run_id)
        db.log_event(
            "analysis",
            f"{color} analysis completed",
            details={
                "run_id": run_id,
                "processed_games": processed_games,
                "total_games": total_games,
                "mistakes_ready": db.count_active_mistakes(color),
            },
        )
    except AnalysisCancelled:
        db.finish_run(run_id, status="cancelled")
        checkpoint = db.get_analysis_checkpoint(color)
        db.log_event(
            "analysis",
            f"{color} analysis cancelled",
            level="warn",
            details={
                "run_id": run_id,
                "processed_games": checkpoint["processed_games"] if checkpoint else processed_games,
                "total_games": checkpoint["total_games"] if checkpoint else total_games,
                "mistakes_ready": db.count_active_mistakes(color),
            },
        )
    except Exception as exc:
        db.finish_run(run_id, status="error", error=str(exc))
        checkpoint = db.get_analysis_checkpoint(color)
        db.log_event(
            "analysis",
            f"{color} analysis failed",
            level="error",
            details={
                "run_id": run_id,
                "error": str(exc),
                "processed_games": checkpoint["processed_games"] if checkpoint else processed_games,
                "total_games": checkpoint["total_games"] if checkpoint else total_games,
            },
        )
    finally:
        try:
            engine.quit()
        except chess.engine.EngineError:
            pass


def _run_incremental_batches(
    engine: chess.engine.SimpleEngine,
    pgn_text: str,
    color: str,
    run_id: int,
    source_fingerprint: str,
    total_games: int,
    processed_games: int,
) -> int:
    resume_offset = processed_games
    skipped = 0
    batch: list[chess.pgn.Game] = []
    for game in iter_supported_games(pgn_text):
        if skipped < resume_offset:
            skipped += 1
            continue
        batch.append(game)
        if len(batch) >= ANALYSIS_BATCH_GAMES:
            processed_games = _process_analysis_batch(
                engine,
                color,
                run_id,
                batch,
                source_fingerprint,
                total_games,
                processed_games,
            )
            batch = []
    if batch:
        processed_games = _process_analysis_batch(
            engine,
            color,
            run_id,
            batch,
            source_fingerprint,
            total_games,
            processed_games,
        )
    return processed_games


def process_incremental_games(
    engine: chess.engine.SimpleEngine,
    color: str,
    run_id: int,
    games: list[chess.pgn.Game],
    source_fingerprint: str,
    total_games: int,
    processed_games: int,
) -> int:
    batch: list[chess.pgn.Game] = []
    for game in games:
        batch.append(game)
        if len(batch) >= ANALYSIS_BATCH_GAMES:
            processed_games = _process_analysis_batch(
                engine,
                color,
                run_id,
                batch,
                source_fingerprint,
                total_games,
                processed_games,
            )
            batch = []
    if batch:
        processed_games = _process_analysis_batch(
            engine,
            color,
            run_id,
            batch,
            source_fingerprint,
            total_games,
            processed_games,
        )
    return processed_games


def _process_analysis_batch(
    engine: chess.engine.SimpleEngine,
    color: str,
    run_id: int,
    batch_games: list[chess.pgn.Game],
    source_fingerprint: str,
    total_games: int,
    processed_games: int,
) -> int:
    if db.run_cancel_requested(run_id):
        raise AnalysisCancelled()

    batch_counts:     dict[tuple[str, str], int]             = {}
    batch_fens:       dict[tuple[str, str], str]             = {}
    batch_openings:   dict[tuple[str, str], tuple[str, str]] = {}
    batch_move_lists: dict[tuple[str, str], str]             = {}
    for game in batch_games:
        g_counts, g_fens, g_openings, g_move_lists = _collect_pairs_from_game(game, color)
        for key, count in g_counts.items():
            batch_counts[key] = batch_counts.get(key, 0) + count
        for key, fen in g_fens.items():
            batch_fens.setdefault(key, fen)
        for key, op in g_openings.items():
            batch_openings.setdefault(key, op)
        for key, ml in g_move_lists.items():
            batch_move_lists.setdefault(key, ml)

    touched_keys = list(batch_counts.keys())
    db.apply_pair_batch(
        color,
        [
            {
                "pos_key":    pos_key,
                "user_move":  user_move,
                "fen":        batch_fens[(pos_key, user_move)],
                "pair_count": count,
                "opening_eco":  batch_openings.get((pos_key, user_move), (None, None))[0],
                "opening_name": batch_openings.get((pos_key, user_move), (None, None))[1],
                "move_list":  batch_move_lists.get((pos_key, user_move)),
            }
            for (pos_key, user_move), count in batch_counts.items()
        ],
    )

    pair_states = db.get_pair_states(color, touched_keys)
    prioritized_states = sorted(
        (state for state in pair_states.values() if int(state["pair_count"]) >= MIN_OCCURRENCES),
        key=lambda state: int(state["pair_count"]),
        reverse=True,
    )
    if ANALYSIS_BATCH_POSITION_LIMIT > 0:
        prioritized_states = prioritized_states[:ANALYSIS_BATCH_POSITION_LIMIT]

    for state in prioritized_states:
        if db.run_cancel_requested(run_id):
            raise AnalysisCancelled()
        _refresh_pair_state(engine, color, state)

    processed_games += len(batch_games)
    db.upsert_analysis_checkpoint(color, source_fingerprint, total_games, processed_games, False)
    db.update_run_progress(run_id, processed_games, total_games)
    db.log_event(
        "analysis",
        f"{color} analysis batch processed",
        details={
            "run_id": run_id,
            "batch_games": len(batch_games),
            "processed_games": processed_games,
            "total_games": total_games,
            "mistakes_ready": db.count_active_mistakes(color),
            "touched_positions": len(touched_keys),
            "evaluated_positions": len(prioritized_states),
        },
    )
    return processed_games


def _refresh_pair_state(
    engine: chess.engine.SimpleEngine,
    color: str,
    state: dict[str, Any],
) -> None:
    if int(state["pair_count"]) < MIN_OCCURRENCES:
        return
    fen = state["fen"]
    user_move = state["user_move"]
    pos_key = state["pos_key"]
    try:
        board = chess.Board(fen)
    except ValueError:
        db.remove_active_mistake(color, fen, user_move)
        return

    best_cp, top_moves = _get_or_eval_position(engine, color, pos_key, fen, include_top_moves=True)
    if best_cp is None:
        return
    if top_moves and user_move in top_moves:
        db.remove_active_mistake(color, fen, user_move)
        return

    try:
        move_obj = chess.Move.from_uci(user_move)
    except ValueError:
        db.remove_active_mistake(color, fen, user_move)
        return
    if move_obj not in board.legal_moves:
        db.remove_active_mistake(color, fen, user_move)
        return

    board_after = board.copy(stack=False)
    board_after.push(move_obj)
    cp_after, _ = _get_or_eval_position(
        engine,
        color,
        _pos_key(board_after),
        board_after.fen(),
        include_top_moves=False,
    )
    if cp_after is None:
        return

    mover_white = board.turn == chess.WHITE
    cp_loss = (best_cp - cp_after) if mover_white else (cp_after - best_cp)
    if cp_loss <= THRESHOLD_CP:
        db.remove_active_mistake(color, fen, user_move)
        return

    db.upsert_mistake_record(
        color,
        {
            "fen":          fen,
            "user_move":    user_move,
            "top_moves":    top_moves,
            "avg_cp_loss":  int(round(cp_loss)),
            "pair_count":   int(state["pair_count"]),
            "opening_eco":  state.get("opening_eco"),
            "opening_name": state.get("opening_name"),
            "move_list":    state.get("move_list"),
        },
    )


def _get_or_eval_position(
    engine: chess.engine.SimpleEngine,
    color: str,
    pos_key: str,
    fen: str,
    *,
    include_top_moves: bool,
) -> tuple[Optional[int], list[str]]:
    cached = db.get_eval_cache(color, pos_key)
    if cached:
        cached_top_moves = cached.get("top_moves", [])
        if not include_top_moves or cached_top_moves or cached.get("eval_cp") is None:
            return cached.get("eval_cp"), cached_top_moves

    board = chess.Board(fen)
    depth = chess.engine.Limit(depth=_CURRENT_JOB_DEPTH)
    if include_top_moves:
        infos = engine.analyse(board, depth, multipv=MULTIPV)
        if isinstance(infos, dict):
            infos = [infos]
        best_cp = _score_cp(infos[0].get("score"))
        top_moves: list[str] = []
        if best_cp is not None:
            for info in infos:
                pv = info.get("pv") or []
                if not pv:
                    continue
                mv_cp = _score_cp(info.get("score"))
                if mv_cp is None:
                    continue
                if best_cp - mv_cp <= TOP_MOVE_DELTA:
                    top_moves.append(pv[0].uci())
    else:
        info = engine.analyse(board, depth)
        best_cp = _score_cp(info.get("score"))
        top_moves = []

    db.upsert_eval_cache(color, pos_key, fen, best_cp, top_moves)
    return best_cp, top_moves


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
