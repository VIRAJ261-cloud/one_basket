"""Reproducible KPI benchmark for the multi-stop optimiser.

Usage:
    python benchmark.py               # all sections
    python benchmark.py --seeds 1-10,42 --runs 3

Sections
--------
1. Distance: naive greedy vs optimiser per seed (identical orders, drivers,
   capacity, serviceability, prep times, deadlines and ride limits), with
   delivered/failed/late, batched orders and a full constraint check.
2. Dispatch latency: per dispatch round (candidate evaluation + assignment +
   local improvement), 100 orders / 50 drivers, for each shortest-path
   back-end. One warm-up run per back-end is discarded.
3. Burst: all 100 orders arrive in one round (worst case).
4. Rerouting: latency of each road closure (busiest active road) during
   the seed-42 simulation.

Timings depend on the machine and its load; rerun to compare.
"""

from __future__ import annotations

import argparse
import os
import sys

from src.data_loader import load_dataset
from src.graph import build_graph
from src.multistop_sim import (ClosureEvent, MultiStopConfig,
                               check_compliance, compare)
from src.routing import DistanceMatrix
from src.serviceability import ServiceabilityPolicy
from src.simulation import _percentile

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def parse_seeds(text: str) -> list[int]:
    seeds: list[int] = []
    for part in text.split(","):
        if "-" in part:
            lo, hi = part.split("-")
            seeds.extend(range(int(lo), int(hi) + 1))
        else:
            seeds.append(int(part))
    return seeds


def stats(values: list[float]) -> str:
    ordered = sorted(values)
    return (f"p50 {_percentile(ordered, 50):7.2f}  p95 "
            f"{_percentile(ordered, 95):7.2f}  max {ordered[-1]:7.2f} ms "
            f"(n={len(ordered)})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seeds", default="1-10,42")
    parser.add_argument("--runs", type=int, default=3,
                        help="measured runs per latency benchmark")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    graph = build_graph(load_dataset(DATA_DIR))
    policy = ServiceabilityPolicy.default(graph)
    matrix = DistanceMatrix(graph, "time")
    matrix.precompute()
    checker = DistanceMatrix(graph, "time")

    print("1. Distance: naive greedy vs optimiser (50 drivers, 100 orders, "
          "capacity 3)")
    print(f"{'seed':>5} {'base km':>9} {'opt km':>9} {'reduct':>7} "
          f"{'deliv b/o':>10} {'fail b/o':>9} {'late b/o':>9} "
          f"{'batched':>8} constraints")
    reductions = []
    for seed in parse_seeds(args.seeds):
        cfg = MultiStopConfig(seed=seed)
        c = compare(graph, cfg, policy, matrix=matrix)
        b, o = c.baseline, c.optimized
        problems = (check_compliance(b, policy, cfg.max_ride_extra_min,
                                     checker)
                    + check_compliance(o, policy, cfg.max_ride_extra_min,
                                       checker))
        reductions.append(c.distance_reduction)
        print(f"{seed:>5} {b.total_distance_km:9.1f} "
              f"{o.total_distance_km:9.1f} "
              f"{c.distance_reduction * 100:6.1f}% "
              f"{b.delivered:>4}/{o.delivered:<5} {b.failed:>4}/{o.failed:<4} "
              f"{b.late_deliveries:>4}/{o.late_deliveries:<4} "
              f"{o.batched_orders:>8} "
              f"{'OK' if not problems else '; '.join(problems)}")
    print(f"  reduction min {min(reductions) * 100:.1f}%  mean "
          f"{sum(reductions) / len(reductions) * 100:.1f}%  max "
          f"{max(reductions) * 100:.1f}%  "
          f"(>= 15% in {sum(r >= 0.15 for r in reductions)}/"
          f"{len(reductions)} seeds)")

    print("\n2. Dispatch latency per round, 100 orders / 50 drivers, seed 42")
    for backend in ("tree", "dijkstra", "astar"):
        cfg = MultiStopConfig(algorithm=backend,
                              precompute=backend == "tree")
        compare(graph, cfg, policy)                    # warm-up, discarded
        values: list[float] = []
        for _ in range(args.runs):
            values += compare(graph, cfg, policy).optimized.latencies_ms
        print(f"  {backend:<9} {stats(values)}")

    print("\n3. Burst: all 100 orders in one round (optimiser, tree)")
    burst: list[float] = []
    for _ in range(args.runs):
        burst.append(compare(graph, MultiStopConfig(horizon_min=0.0),
                             policy, matrix=matrix).optimized.max_latency_ms)
    print(f"  burst round {stats(burst)}")

    print("\n4. Rerouting latency (busiest road closed at minutes 15..45)")
    events = tuple(ClosureEvent(float(t)) for t in range(15, 50, 5))
    reroute: list[float] = []
    for _ in range(args.runs):
        c = compare(graph, MultiStopConfig(closures=events), policy,
                    matrix=matrix)
        for result in (c.baseline, c.optimized):
            reroute += [r.latency_s * 1000 for r in result.reroutes
                        if r.action == "close"]
    print(f"  reroute {stats(reroute)}  "
          f"(< 50 ms in {sum(v < 50 for v in reroute)}/{len(reroute)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
