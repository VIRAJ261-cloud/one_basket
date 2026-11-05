"""Web server for the delivery operations dashboard (``python dashboard.py``).

It *extends* the existing visualization server without modifying it:

* every existing endpoint is inherited unchanged from
  ``visualization.make_handler``: ``/api/graph``, ``/api/search``,
  ``POST /api/multistop``, plus the search visualizer (``/index.html``) and
  the multi-stop planner (``/planner.html``);
* ``/`` redirects to ``/dashboard/``, which serves the dashboard from
  ``web/dashboard`` (assets use relative paths);
* two small read-only endpoints add what the dashboard needs:

  ``GET /api/meta``            dataset counts, each location's service zone
                               and the serviceability policy in force
  ``GET /api/serviceability``  ``?restaurant=R001&society=S004`` -> the real
                               ``ServiceabilityPolicy.check`` result

All planning still happens in ``scenario.run_scenario`` (via
``POST /api/multistop``), i.e. the same optimiser as the CLI.
"""

from __future__ import annotations

import os
import re
from http.server import HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.visualization import VisualizationBackend, make_handler

DASHBOARD_DIR = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "web", "dashboard")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}
_SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]+\.(html|js|css|svg)$")


def dashboard_files(directory: str = DASHBOARD_DIR) -> dict[str, str]:
    """Whitelist of servable dashboard files: name -> absolute path."""
    files = {}
    if os.path.isdir(directory):
        for name in sorted(os.listdir(directory)):
            if _SAFE_NAME.match(name):
                files[name] = os.path.join(directory, name)
    return files


class DashboardBackend(VisualizationBackend):
    """The visualization backend plus dashboard metadata."""

    def meta(self) -> dict[str, Any]:
        config = self.policy.config
        zones = {node: self.policy.zone_of(node)
                 for node in sorted(self.graph.locations)}
        stats = self.graph_payload["stats"]
        return {
            "restaurants": stats["restaurants"],
            "societies": stats["societies"],
            "roads": stats["roads"],
            "zones": zones,
            "policy": {
                "zones": config.zones,
                "allow_same_zone": config.allow_same_zone,
                "allowed_zone_pairs": sorted(
                    list(pair) for pair in config.allowed_zone_pairs),
                "max_distance_km": config.max_distance_km,
                "max_time_min": config.max_time_min,
            },
            "algorithms": ["dijkstra", "astar"],
        }

    def serviceability(self, restaurant: str, society: str
                       ) -> dict[str, Any]:
        result = self.policy.check(restaurant.strip().upper(),
                                   society.strip().upper())
        return {
            "restaurant": result.restaurant_id,
            "society": result.society_id,
            "serviceable": result.serviceable,
            "reason": result.reason.value if result.reason else None,
            "message": result.message,
            "restaurant_zone": result.restaurant_zone,
            "society_zone": result.society_zone,
            "distance_km": result.distance_km,
            "time_min": result.time_min,
        }


def make_dashboard_handler(backend: DashboardBackend,
                           directory: str = DASHBOARD_DIR) -> type:
    """Existing handler + dashboard routes (existing routes untouched)."""
    base = make_handler(backend)
    files = dashboard_files(directory)

    class DashboardHandler(base):
        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            url = urlparse(self.path)
            if url.path in ("/", "/dashboard"):
                # Redirect so the page's relative asset paths resolve
                # under /dashboard/.
                self.send_response(302)
                self.send_header("Location", "/dashboard/")
                self.send_header("Content-Length", "0")
                self.end_headers()
            elif url.path == "/dashboard/":
                self._serve_file("index.html")
            elif url.path.startswith("/dashboard/"):
                self._serve_file(url.path[len("/dashboard/"):])
            elif url.path == "/api/meta":
                self._send_json(200, backend.meta())
            elif url.path == "/api/serviceability":
                query = parse_qs(url.query)
                restaurant = query.get("restaurant", [""])[0]
                society = query.get("society", [""])[0]
                if not restaurant or not society:
                    self._send_json(400, {"error": "Give a restaurant and a "
                                                   "society."})
                else:
                    self._send_json(200, backend.serviceability(restaurant,
                                                                society))
            else:
                super().do_GET()

        def _serve_file(self, name: str) -> None:
            path = files.get(name)
            if path is None:
                self._send_json(404, {"error": "Not found"})
                return
            try:
                with open(path, "rb") as fh:
                    body = fh.read()
            except OSError:
                self._send_json(500, {"error": f"{name} missing"})
                return
            self._send(200, body, CONTENT_TYPES[os.path.splitext(name)[1]])

    return DashboardHandler


def serve_dashboard(backend: DashboardBackend, host: str, port: int
                    ) -> HTTPServer:
    """Create (but do not start) the dashboard HTTP server."""
    return HTTPServer((host, port), make_dashboard_handler(backend))
