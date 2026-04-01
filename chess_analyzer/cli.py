"""CLI entry point — starts the server and opens the browser."""
from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser


def _open_browser(port: int) -> None:
    time.sleep(1.5)
    webbrowser.open(f"http://localhost:{port}")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="chess-analyzer",
        description="Chess opening analyzer — opens a local web UI.",
    )
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on (default: 8765)")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--no-browser", action="store_true", help="Don't open the browser automatically")
    parser.add_argument("--version", action="version", version="chess-analyzer 2.0.0")
    args = parser.parse_args()

    if not args.no_browser:
        t = threading.Thread(target=_open_browser, args=(args.port,), daemon=True)
        t.start()

    try:
        import uvicorn
    except ImportError:
        print("uvicorn is not installed. Run: pip install 'chess-analyzer'", file=sys.stderr)
        sys.exit(1)

    print(f"Chess Analyzer running at http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")

    uvicorn.run(
        "chess_analyzer.server:app",
        host=args.host,
        port=args.port,
        log_level="warning",
    )
