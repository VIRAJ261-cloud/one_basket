"""Tests for the dashboard server (``python dashboard.py``).

Run with:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request

from src.dashboard_server import (DashboardBackend, dashboard_files,
                                  serve_dashboard)
from tests.test_simulation import DATA_DIR


class DashboardServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = serve_dashboard(DashboardBackend(DATA_DIR, 0),
                                     "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever,
                         daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path: str) -> tuple[int, bytes, str]:
        try:
            with urllib.request.urlopen(self.base + path) as response:
                return (response.status, response.read(),
                        response.headers["Content-Type"])
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), exc.headers["Content-Type"]

    def get_json(self, path: str) -> tuple[int, dict]:
        status, body, _ = self.get(path)
        return status, json.loads(body)

    def post(self, payload: dict) -> tuple[int, dict]:
        request = urllib.request.Request(
            self.base + "/api/multistop", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    # -------------------------------------------------------- static files
    def test_dashboard_pages_are_served(self) -> None:
        status, body, ctype = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn(b"Optimize Delivery Route", body)
        for name, kind in (("dashboard.js", "javascript"),
                           ("routemap.js", "javascript"),
                           ("dashboard.css", "css")):
            status, _, ctype = self.get(f"/dashboard/{name}")
            self.assertEqual(status, 200, name)
            self.assertIn(kind, ctype)

    def test_root_redirects_so_relative_assets_resolve(self) -> None:
        import http.client
        host, port = self.server.server_address
        for path in ("/", "/dashboard"):
            conn = http.client.HTTPConnection(host, port)
            conn.request("GET", path)
            response = conn.getresponse()
            self.assertEqual(response.status, 302)
            self.assertEqual(response.getheader("Location"), "/dashboard/")
            conn.close()
        status, body, _ = self.get("/dashboard/")
        self.assertEqual(status, 200)
        self.assertIn(b'href="dashboard.css"', body)
        self.assertIn(b'src="dashboard.js"', body)

    def test_only_whitelisted_files_are_served(self) -> None:
        self.assertIn("index.html", dashboard_files())
        for path in ("/dashboard/../main.py", "/dashboard/nope.js",
                     "/dashboard/%2e%2e/main.py", "/dashboard/.hidden.js"):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_existing_endpoints_still_work(self) -> None:
        for path in ("/index.html", "/planner.html", "/app.js",
                     "/planner.js"):
            self.assertEqual(self.get(path)[0], 200, path)
        status, graph = self.get_json("/api/graph")
        self.assertEqual(status, 200)
        self.assertEqual(graph["stats"]["locations"], 268)
        status, search = self.get_json(
            "/api/search?source=R190&target=S010&metric=time")
        self.assertEqual(status, 200)
        self.assertEqual(search["dijkstra"]["path"], ["R190", "S001", "S010"])

    # -------------------------------------------------------- new endpoints
    def test_meta_uses_real_data(self) -> None:
        status, meta = self.get_json("/api/meta")
        self.assertEqual(status, 200)
        self.assertEqual((meta["restaurants"], meta["societies"],
                          meta["roads"]), (248, 20, 688))
        self.assertEqual(meta["zones"]["R190"], "Miraj")
        self.assertEqual(meta["zones"]["S010"], "Sangli")
        self.assertEqual(meta["policy"]["max_time_min"], 30.0)
        self.assertIn(["Kupwad", "Sangli"], meta["policy"]
                      ["allowed_zone_pairs"])

    def test_serviceability_endpoint(self) -> None:
        status, ok = self.get_json(
            "/api/serviceability?restaurant=r001&society=s004")
        self.assertEqual(status, 200)
        self.assertTrue(ok["serviceable"])
        self.assertAlmostEqual(ok["distance_km"], 5.506, places=3)
        status, bad = self.get_json(
            "/api/serviceability?restaurant=R190&society=S010")
        self.assertFalse(bad["serviceable"])
        self.assertEqual(bad["reason"], "OUTSIDE_SERVICE_ZONE")
        status, unknown = self.get_json(
            "/api/serviceability?restaurant=R999&society=S010")
        self.assertEqual(unknown["reason"], "INVALID_RESTAURANT_OR_SOCIETY")
        self.assertEqual(self.get("/api/serviceability?restaurant=R001")[0],
                         400)

    # -------------------------------------------------------- planning
    def scenario(self, orders, drivers, **extra) -> dict:
        status, data = self.post({
            "orders": [{"restaurant": r, "society": s} for r, s in orders],
            "drivers": drivers, "capacity": 3, **extra})
        self.assertEqual(status, 200, data)
        return data

    def stops(self, method: dict) -> list[tuple[str, str, str]]:
        return [(s["order_id"], s["kind"], s["node"])
                for d in method["drivers"] for s in d["stops"]]

    def test_three_dashboard_examples(self) -> None:
        # Two restaurants -> one society: both collected, then delivered.
        one_society = self.scenario([("R001", "S004"), ("R002", "S004")],
                                    ["S005"])["methods"]["insertion"]
        kinds = [k for _, k, _ in self.stops(one_society)]
        self.assertEqual(kinds, ["PICKUP", "PICKUP", "DROPOFF", "DROPOFF"])
        # One restaurant -> three societies: three pickups at R016 first.
        one_rest = self.scenario([("R016", "S017"), ("R016", "S007"),
                                  ("R016", "S012")], ["S020"])
        stops = self.stops(one_rest["methods"]["insertion"])
        self.assertEqual([n for _, k, n in stops[:3]], ["R016"] * 3)
        self.assertEqual({n for _, _, n in stops[3:]},
                         {"S017", "S007", "S012"})
        # Several -> several, with one unserviceable order.
        mixed = self.scenario([("R001", "S004"), ("R002", "S003"),
                               ("R016", "S012"), ("R190", "S010")],
                              ["S005", "S020"])
        opt = mixed["methods"]["insertion"]
        self.assertEqual(opt["totals"]["delivered"], 3)
        rejected = [o for o in opt["orders"] if o["status"] == "REJECTED"]
        self.assertEqual([(o["order_id"], o["reason"]) for o in rejected],
                         [("O04", "OUTSIDE_SERVICE_ZONE")])
        for method in mixed["methods"].values():
            self.assertEqual(method["violations"], [])
        self.assertLess(opt["totals"]["distance_km"],
                        mixed["methods"]["append"]["totals"]["distance_km"])

    def test_closure_without_alternative_reports_reason(self) -> None:
        # R003 can only be entered from S018.
        data = self.scenario([("R003", "S004"), ("R001", "S004")], ["S005"],
                             closures=[{"source": "S018", "target": "R003",
                                        "at": 0}])
        opt = data["methods"]["insertion"]
        failed = {o["order_id"]: o for o in opt["orders"]
                  if o["status"] != "DELIVERED"}
        self.assertEqual(list(failed), ["O01"])
        self.assertEqual(failed["O01"]["status"], "FAILED")
        self.assertEqual(failed["O01"]["reason"], "PICKUP_UNREACHABLE")
        self.assertEqual(opt["violations"], [])
        # The road is open again for the next request.
        again = self.scenario([("R003", "S004")], ["S005"])
        self.assertEqual(again["methods"]["insertion"]["totals"]
                         ["delivered"], 1)

    def test_invalid_scenarios_return_400(self) -> None:
        for payload in ({"orders": [], "drivers": ["S001"]},
                        {"orders": [{"restaurant": "R001",
                                     "society": "S004"}], "drivers": []},
                        {"orders": [{"restaurant": "R001",
                                     "society": "S004"}],
                         "drivers": ["S001"], "capacity": 99}):
            status, data = self.post(payload)
            self.assertEqual(status, 400)
            self.assertTrue(data["error"])


if __name__ == "__main__":
    unittest.main()
