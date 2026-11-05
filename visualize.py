"""Interactive Dijkstra / A* search visualization (separate from the CLI).

Usage:
    python visualize.py                 # opens http://127.0.0.1:8050
    python visualize.py --port 9000 --no-browser

The existing CLI (``python main.py``) is unaffected by this tool.
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from main import DEFAULT_DATA_DIR
from src.data_loader import DataError
from src.visualization import VisualizationBackend, serve


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Visualize Dijkstra and A* on the food delivery graph.")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR,
                        help="folder containing the CSV dataset")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8050,
                        help="port to listen on (default: 8050)")
    parser.add_argument("--runs", type=int, default=200,
                        help="benchmark repetitions for avg/min timing")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window automatically")
    return parser.parse_args()


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()

    try:
        backend = VisualizationBackend(args.data_dir, max(args.runs, 0))
    except DataError as exc:
        print(f"Dataset error: {exc}")
        return 1
    for warning in backend.warnings:
        print(f"[data warning] {warning}")

    try:
        server = serve(backend, args.host, args.port)
    except OSError as exc:
        print(f"Could not start the server on port {args.port}: {exc}\n"
              f"Try another port, e.g. python visualize.py --port 8051")
        return 1

    url = f"http://{args.host}:{args.port}/"
    print(f"Route search visualization running at {url}")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nVisualization server stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
