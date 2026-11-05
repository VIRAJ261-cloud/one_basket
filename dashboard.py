"""Delivery operations dashboard (user-friendly web front end).

Usage:
    python dashboard.py                    # opens http://127.0.0.1:8060/
    python dashboard.py --port 9000 --no-browser

Uses the same backend and optimiser as the CLI (``python main.py``) and the
search visualizer (``python visualize.py``), which keep working unchanged.
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from main import DEFAULT_DATA_DIR
from src.dashboard_server import DashboardBackend, serve_dashboard
from src.data_loader import DataError


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Food delivery operations dashboard.")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR,
                        help="folder containing the CSV dataset")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8060,
                        help="port to listen on (default: 8060)")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window automatically")
    return parser.parse_args()


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()

    try:
        backend = DashboardBackend(args.data_dir, benchmark_runs=0)
    except DataError as exc:
        print(f"Dataset error: {exc}")
        return 1
    for warning in backend.warnings:
        print(f"[data warning] {warning}")

    try:
        server = serve_dashboard(backend, args.host, args.port)
    except OSError as exc:
        print(f"Could not start the server on port {args.port}: {exc}\n"
              f"Try another port, e.g. python dashboard.py --port 8061")
        return 1

    url = f"http://{args.host}:{args.port}/"
    print(f"Delivery dashboard running at {url}")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard server stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
