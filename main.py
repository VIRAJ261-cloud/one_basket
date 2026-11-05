"""Food Delivery Route Optimizer - entry point.

Pipeline:
    Data Loading -> Data Cleaning -> Graph Construction
        -> Dijkstra -> A* -> Comparison -> CLI Output

Usage:
    python main.py                            # interactive menu
    python main.py --metric distance          # optimise km instead of minutes
    python main.py --source R190 --destination S010   # one-shot comparison
"""

from __future__ import annotations

import argparse
import os
import sys

from src.cli import RouteOptimizerCLI
from src.data_loader import DataError, load_dataset
from src.graph import build_graph
from src.heuristics import calibrate_scale
from src.multistop_sim import ClosureEvent, MultiStopConfig
from src.serviceability import (DEFAULT_CONFIG_PATH, ServiceabilityConfig,
                                ServiceabilityPolicy)

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "data")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Food delivery route optimization with Dijkstra and A*.")
    parser.add_argument(
        "--data-dir", default=DEFAULT_DATA_DIR,
        help="folder containing the CSV dataset (default: ./data)")
    parser.add_argument(
        "--metric", choices=["time", "distance"], default="time",
        help="edge weight to minimise (default: time)")
    parser.add_argument(
        "--runs", type=int, default=200,
        help="benchmark repetitions per algorithm for avg/min timing; "
             "0 disables (default: 200)")
    parser.add_argument("--source", help="source location for a one-shot run")
    parser.add_argument("--destination",
                        help="destination location for a one-shot run")
    parser.add_argument(
        "--simulate", action="store_true",
        help="run the greedy-dispatch delivery simulation and exit")
    parser.add_argument(
        "--drivers", type=int, default=50,
        help="number of simulated drivers (default: 50, with --simulate)")
    parser.add_argument(
        "--orders", type=int, default=100,
        help="number of simulated orders (default: 100, with --simulate)")
    parser.add_argument(
        "--sim-seed", type=int, default=42,
        help="random seed for the simulation (default: 42)")
    parser.add_argument(
        "--algorithm", choices=["dijkstra", "astar"], default="astar",
        help="routing algorithm used for dispatch (default: astar)")
    parser.add_argument(
        "--service-config", default=DEFAULT_CONFIG_PATH,
        help="serviceability policy JSON (default: config/serviceability.json)")
    parser.add_argument(
        "--no-serviceability", action="store_true",
        help="simulate without the serviceability check (any routable pair)")
    parser.add_argument(
        "--reject-unserviceable", action="store_true",
        help="with --simulate: keep unserviceable generated orders as "
             "REJECTED (with reason) instead of skipping them")
    parser.add_argument(
        "--multistop", action="store_true",
        help="run the multi-stop pickup-and-delivery simulation (naive "
             "greedy baseline vs insertion optimiser) and exit; uses "
             "--drivers, --orders, --sim-seed and --metric")
    parser.add_argument(
        "--capacity", type=int, default=3,
        help="active orders per driver for --multistop (default: 3)")
    parser.add_argument(
        "--route-backend", choices=["tree", "dijkstra", "astar"],
        default="tree",
        help="shortest-path back-end for --multistop (default: tree)")
    parser.add_argument(
        "--close-road", nargs=3, action="append", default=[],
        metavar=("FROM", "TO", "MINUTE"),
        help="with --multistop: close the road FROM->TO at MINUTE "
             "(repeatable); 'auto' 'auto' MINUTE closes the busiest road")
    parser.add_argument(
        "--improve", choices=["relocate", "intra", "none"],
        default="relocate",
        help="optimiser local improvement for --multistop (default: "
             "relocate)")
    parser.add_argument(
        "--check-service", nargs=2, metavar=("RESTAURANT", "SOCIETY"),
        help="check whether a restaurant may deliver to a society and exit")
    return parser.parse_args()


def main() -> int:
    # Location names include Devanagari script; make sure printing them
    # never crashes on a legacy Windows console code page.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    args = parse_args()
    if args.runs < 0:
        print("Error: --runs must be 0 or more.")
        return 2

    try:
        dataset = load_dataset(args.data_dir)
        graph = build_graph(dataset)
    except DataError as exc:
        print(f"Dataset error: {exc}")
        return 1
    for warning in dataset.warnings:
        print(f"[data warning] {warning}")

    # The policy is always loaded (option 4 / --check-service use it);
    # --no-serviceability only switches off enforcement in simulations.
    try:
        policy = ServiceabilityPolicy(
            graph, ServiceabilityConfig.from_json(args.service_config))
    except (OSError, ValueError) as exc:
        print(f"Serviceability config error: {exc}")
        return 1

    heuristic_scale = calibrate_scale(graph, args.metric)
    app = RouteOptimizerCLI(graph, args.metric, heuristic_scale, args.runs,
                            serviceability=policy,
                            enforce_serviceability=not args.no_serviceability)

    if args.check_service:
        endpoints = []
        for text in args.check_service:
            node_id, error = app.resolve_location(text)
            if node_id is None:
                print(f"Error: {error}")
                return 2
            endpoints.append(node_id)
        app.check_serviceability(*endpoints)
        return 0

    if args.multistop:
        closures = []
        for source, target, minute in args.close_road:
            auto = source.lower() == "auto"
            try:
                at = float(minute)
            except ValueError:
                print(f"Error: --close-road minute '{minute}' is not a "
                      f"number.")
                return 2
            if not auto and not graph.has_edge(source.upper(),
                                               target.upper()):
                print(f"Error: there is no road {source} -> {target}.")
                return 2
            closures.append(ClosureEvent(
                at, None if auto else source.upper(),
                None if auto else target.upper()))
        if min(args.drivers, args.orders, args.capacity) <= 0:
            print("Error: --drivers, --orders and --capacity must be "
                  "positive.")
            return 2
        app.run_multistop(MultiStopConfig(
            num_drivers=args.drivers, num_orders=args.orders,
            seed=args.sim_seed, capacity=args.capacity, metric=args.metric,
            algorithm=args.route_backend,
            precompute=args.route_backend == "tree",
            improve=args.improve, closures=closures))
        return 0

    if args.simulate:
        app.run_simulation(args.drivers, args.orders, args.sim_seed,
                           args.algorithm, args.reject_unserviceable)
        return 0

    if args.source or args.destination:
        if not (args.source and args.destination):
            print("Error: --source and --destination must be used together.")
            return 2
        endpoints = []
        for text in (args.source, args.destination):
            node_id, error = app.resolve_location(text)
            if node_id is None:
                print(f"Error: {error}")
                return 2
            endpoints.append(node_id)
        if endpoints[0] == endpoints[1]:
            print("Error: source and destination are the same location.")
            return 2
        app.compare(*endpoints)
        return 0

    app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
