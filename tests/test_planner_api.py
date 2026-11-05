"""Tests for the scenario API behind the web planner and CLI option 5.

Run with:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import threading
import unittest
import urllib.error
import urllib.request

from src.scenario import ScenarioSpec, run_scenario
from src.serviceability import ServiceabilityPolicy
from src.visualization import VisualizationBackend, serve
from tests.test_simulation import DATA_DIR, _real_graph

EXAMPLE = {
    "orders": [{"restaurant": "R001", "society": "S004"},
               {"restaurant": "R001", "society": "S003"},
               {"restaurant": "R002", "society": "S004"},
               {"restaurant": "R190", "society": "S010"}],
    "drivers": ["S005", "S010"],
    "capacity": 3,
}


class ScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.graph = _real_graph()
        cls.policy = ServiceabilityPolicy.default(cls.graph)

    def run_spec(self, **changes) -> dict:
        return run_scenario(self.graph,
                            ScenarioSpec.from_dict({**EXAMPLE, **changes}),
                            self.policy)

    def test_both_methods_deliver_and_respect_constraints(self) -> None:
        for algorithm in ("dijkstra", "astar", "tree"):
            report = self.run_spec(algorithm=algorithm)
            for method in report["methods"].values():
                self.assertEqual(method["violations"], [])
                self.assertEqual(method["totals"]["delivered"], 3)
                self.assertEqual(method["totals"]["rejected"], 1)
            opt = report["methods"]["insertion"]
            self.assertLessEqual(opt["totals"]["distance_km"],
                                 report["methods"]["append"]["totals"]
                                 ["distance_km"])

    def test_algorithms_give_identical_plans(self) -> None:
        plans = []
        for algorithm in ("dijkstra", "astar", "tree"):
            opt = self.run_spec(algorithm=algorithm)["methods"]["insertion"]
            plans.append([(s["order_id"], s["kind"], s["node"])
                          for d in opt["drivers"] for s in d["stops"]])
        self.assertEqual(plans[0], plans[1])
        self.assertEqual(plans[0], plans[2])

    def test_stop_details_and_cumulative_totals(self) -> None:
        opt = self.run_spec()["methods"]["insertion"]
        for driver in opt["drivers"]:
            cum = [s["cum_km"] for s in driver["stops"]]
            self.assertEqual(cum, sorted(cum))
            self.assertAlmostEqual(cum[-1], driver["distance_km"])
            for s in driver["stops"]:
                self.assertIn(s["kind"], ("PICKUP", "DROPOFF"))
                self.assertTrue(s["name"])
            for u, v in zip(driver["path"], driver["path"][1:]):
                self.assertIn(v, self.graph.adjacency[u])

    def test_rejection_reason_reported(self) -> None:
        orders = self.run_spec()["methods"]["insertion"]["orders"]
        rejected = [o for o in orders if o["status"] == "REJECTED"]
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["reason"], "OUTSIDE_SERVICE_ZONE")
        self.assertIn("Miraj", rejected[0]["message"])

    def test_serviceability_can_be_disabled(self) -> None:
        report = self.run_spec(enforce_serviceability=False)
        self.assertEqual(report["methods"]["insertion"]["totals"]
                         ["delivered"], 4)

    def test_unknown_location_is_rejected_with_reason(self) -> None:
        report = self.run_spec(orders=[{"restaurant": "R999",
                                        "society": "S004"}])
        order = report["methods"]["insertion"]["orders"][0]
        self.assertEqual(order["reason"], "INVALID_RESTAURANT_OR_SOCIETY")

    def test_deadline_failure_reported(self) -> None:
        report = self.run_spec(orders=[{"restaurant": "R001",
                                        "society": "S004", "deadline": 1}])
        order = report["methods"]["insertion"]["orders"][0]
        self.assertEqual(order["status"], "FAILED")
        self.assertEqual(order["reason"], "DEADLINE_UNREACHABLE")

    def test_closure_rerouted_and_graph_restored(self) -> None:
        before = {n: dict(v) for n, v in self.graph.adjacency.items()}
        road = ["S003", "S004"]
        report = self.run_spec(closures=[{"source": road[0],
                                          "target": road[1], "at": 0}])
        for method in report["methods"].values():
            self.assertEqual(method["violations"], [])
            for driver in method["drivers"]:
                pairs = list(zip(driver["path"], driver["path"][1:]))
                self.assertNotIn(tuple(road), pairs)
        self.assertEqual({n: dict(v) for n, v in
                          self.graph.adjacency.items()}, before)

    def test_invalid_requests(self) -> None:
        for bad in ({"orders": []},
                    {"drivers": []},
                    {"drivers": ["X1"]},
                    {"capacity": 0},
                    {"algorithm": "bfs"},
                    {"closures": [{"source": "S001", "target": "S999"}]}):
            with self.assertRaises(ValueError):
                self.run_spec(**bad)


class HttpApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = serve(VisualizationBackend(DATA_DIR, 0), "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever,
                         daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body: bytes) -> tuple[int, dict]:
        request = urllib.request.Request(
            self.base + "/api/multistop", data=body,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    def test_planner_page_is_served(self) -> None:
        for path in ("/planner.html", "/planner.js", "/"):
            with urllib.request.urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)

    def test_run_example(self) -> None:
        status, data = self.post(json.dumps(EXAMPLE).encode())
        self.assertEqual(status, 200)
        self.assertEqual(set(data["methods"]), {"append", "insertion"})

    def test_bad_requests(self) -> None:
        self.assertEqual(self.post(b"not json")[0], 400)
        status, data = self.post(json.dumps({"orders": []}).encode())
        self.assertEqual(status, 400)
        self.assertIn("order", data["error"])


if __name__ == "__main__":
    unittest.main()
