"""Local web server for the search visualization.

Everything shown in the browser comes from the existing project code:

* ``load_dataset`` + ``build_graph``  -> the real 268-node / 688-road graph
* ``calibrate_scale``                 -> the exact A* heuristic scale
* ``tracing.dijkstra_with_trace`` / ``astar_with_trace``
                                      -> steps of the unmodified algorithms
* ``dijkstra`` / ``astar`` + ``utils.benchmark`` -> real execution times
* ``RouteOptimizerCLI.resolve_location`` -> same ID/number/name matching as
                                          the CLI
* ``scenario.run_scenario``           -> the multi-stop planner page
                                          (``/planner.html``): the same
                                          PickupDeliveryPlanner the CLI and
                                          simulation use, baseline and
                                          optimiser, closures, serviceability

Only the Python standard library is used (``http.server``). The server binds
to 127.0.0.1 and serves a fixed whitelist of static files from ``web/``.
"""

from __future__ import annotations

import json
import math
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.astar import astar
from src.cli import RouteOptimizerCLI
from src.data_loader import load_dataset
from src.dijkstra import dijkstra
from src.graph import METRIC_INDEX, METRIC_UNITS, build_graph
from src.heuristics import calibrate_scale
from src.routing import DistanceMatrix
from src.scenario import ScenarioSpec, run_scenario
from src.serviceability import ServiceabilityPolicy
from src.tracing import astar_with_trace, dijkstra_with_trace
from src.utils import benchmark

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "web")

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/planner.html": ("planner.html", "text/html; charset=utf-8"),
    "/planner.js": ("planner.js", "text/javascript; charset=utf-8"),
}
MAX_BODY_BYTES = 200_000

LAYOUT_WIDTH = 1000.0  # SVG user units across the whole city


class VisualizationBackend:
    """Loads the real graph once and answers visualization queries."""

    def __init__(self, data_dir: str, benchmark_runs: int) -> None:
        dataset = load_dataset(data_dir)
        self.graph = build_graph(dataset)
        self.warnings = dataset.warnings
        self.benchmark_runs = benchmark_runs
        self.scales = {metric: calibrate_scale(self.graph, metric)
                       for metric in METRIC_INDEX}
        # Reuse the CLI's location matching (ID, list number or name).
        self._resolver = RouteOptimizerCLI(self.graph, "time", 0.0, 0)
        self.policy = ServiceabilityPolicy.default(self.graph)
        self._matrices: dict[tuple[str, str], DistanceMatrix] = {}
        self.graph_payload = self._build_graph_payload()

    def multistop(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Run a hand-built multi-stop scenario. Raises ValueError."""
        if not isinstance(payload, dict):
            raise ValueError("Expected a JSON object.")
        try:
            spec = ScenarioSpec.from_dict(payload)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Invalid scenario: {exc}") from exc
        return run_scenario(self.graph, spec, self.policy, self._matrices)

    # ------------------------------------------------------------------
    def _build_graph_payload(self) -> dict[str, Any]:
        """Nodes positioned by their real lat/lon, plus every road."""
        locations = list(self.graph.locations.values())
        mean_lat = sum(loc.latitude for loc in locations) / len(locations)
        # Equirectangular projection: at city scale one degree of longitude
        # is cos(latitude) times shorter than one degree of latitude.
        x_factor = math.cos(math.radians(mean_lat))
        xs = [loc.longitude * x_factor for loc in locations]
        ys = [-loc.latitude for loc in locations]  # north is up
        min_x, min_y = min(xs), min(ys)
        span = max(max(xs) - min_x, max(ys) - min_y) or 1.0
        unit = LAYOUT_WIDTH / span

        nodes = []
        for loc, x, y in zip(locations, xs, ys):
            nodes.append({
                "id": loc.node_id, "name": loc.name, "kind": loc.kind,
                "area": loc.area, "cuisine": loc.cuisine,
                "lat": loc.latitude, "lon": loc.longitude,
                "x": round((x - min_x) * unit, 3),
                "y": round((y - min_y) * unit, 3),
            })

        # One visual line per connected pair; both directions' weights kept.
        pairs: dict[tuple[str, str], dict[str, Any]] = {}
        for source, neighbours in self.graph.adjacency.items():
            for target, (km, minutes) in neighbours.items():
                a, b = sorted((source, target))
                pair = pairs.setdefault((a, b), {"a": a, "b": b,
                                                 "ab": None, "ba": None})
                pair["ab" if source == a else "ba"] = [km, minutes]

        societies = sum(1 for loc in locations if loc.kind == "Society")
        return {
            "nodes": nodes,
            "edges": list(pairs.values()),
            "width": round(max(n["x"] for n in nodes), 3),
            "height": round(max(n["y"] for n in nodes), 3),
            "stats": {
                "locations": len(locations),
                "societies": societies,
                "restaurants": len(locations) - societies,
                "roads": self.graph.edge_count,
            },
            "heuristic_scale": self.scales,
            "units": METRIC_UNITS,
            "benchmark_runs": self.benchmark_runs,
            "warnings": self.warnings,
        }

    # ------------------------------------------------------------------
    def search(self, source_text: str, target_text: str,
               metric: str) -> dict[str, Any]:
        """Trace both algorithms for one query. Raises ValueError."""
        if metric not in METRIC_INDEX:
            raise ValueError("Metric must be 'time' or 'distance'.")
        source, error = self._resolver.resolve_location(source_text)
        if source is None:
            raise ValueError(f"Source: {error}")
        target, error = self._resolver.resolve_location(target_text)
        if target is None:
            raise ValueError(f"Destination: {error}")
        if source == target:
            raise ValueError("Source and destination are the same location.")

        scale = self.scales[metric]
        runs = {
            "dijkstra": dijkstra_with_trace(self.graph, source, target,
                                            metric),
            "astar": astar_with_trace(self.graph, source, target, metric,
                                      scale),
        }
        if self.benchmark_runs > 0:
            timed = {
                "dijkstra": lambda: dijkstra(self.graph, source, target,
                                             metric),
                "astar": lambda: astar(self.graph, source, target, metric,
                                       scale),
            }
            for name, search in timed.items():
                avg_s, min_s = benchmark(search, self.benchmark_runs)
                runs[name]["avg_time_ms"] = avg_s * 1000
                runs[name]["min_time_ms"] = min_s * 1000

        return {
            "source": source,
            "target": target,
            "metric": metric,
            "unit": METRIC_UNITS[metric],
            "heuristic_scale": scale,
            "benchmark_runs": self.benchmark_runs,
            **runs,
        }


def make_handler(backend: VisualizationBackend) -> type:
    """Create a request handler class bound to ``backend``."""

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8")

        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            url = urlparse(self.path)
            if url.path == "/api/graph":
                self._send_json(200, backend.graph_payload)
            elif url.path == "/api/search":
                query = parse_qs(url.query)

                def arg(name: str, default: str = "") -> str:
                    return query.get(name, [default])[0]

                try:
                    payload = backend.search(arg("source"), arg("target"),
                                             arg("metric", "time"))
                except ValueError as exc:
                    self._send_json(400, {"error": str(exc)})
                else:
                    self._send_json(200, payload)
            elif url.path in STATIC_FILES:
                filename, content_type = STATIC_FILES[url.path]
                try:
                    with open(os.path.join(WEB_DIR, filename), "rb") as fh:
                        self._send(200, fh.read(), content_type)
                except OSError:
                    self._send_json(500, {"error": f"{filename} missing"})
            else:
                self._send_json(404, {"error": "Not found"})

        def do_POST(self) -> None:  # noqa: N802 (http.server naming)
            if urlparse(self.path).path != "/api/multistop":
                self._send_json(404, {"error": "Not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if not 0 < length <= MAX_BODY_BYTES:
                self._send_json(400, {"error": "Missing or too large body."})
                return
            try:
                payload = json.loads(self.rfile.read(length))
                result = backend.multistop(payload)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json(400, {"error": "Body is not valid JSON."})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            else:
                self._send_json(200, result)

        def log_message(self, *args: Any) -> None:
            """Keep the terminal quiet; errors surface in the browser."""

    return Handler


def serve(backend: VisualizationBackend, host: str, port: int) -> HTTPServer:
    """Create (but do not start) the HTTP server."""
    return HTTPServer((host, port), make_handler(backend))
