"""Interactive command-line interface (pipeline stages: Comparison, Output)."""

from __future__ import annotations

from src.astar import astar
from src.dijkstra import dijkstra
from src.graph import METRIC_UNITS, Graph, Location
from src.multistop_sim import (Comparison, MultiStopConfig, check_compliance,
                               compare)
from src.routing import DistanceMatrix
from src.scenario import OrderSpec, ScenarioSpec, run_scenario
from src.serviceability import ServiceabilityPolicy
from src.simulation import DeliverySimulation, SimulationMetrics
from src.utils import SearchResult, benchmark, format_duration, format_ms

WIDTH = 66
LABEL_W, COL_W = 24, 21

METRIC_TITLES = {
    "time": ("Minimum Travel Time", "Distance"),
    "distance": ("Minimum Distance", "Travel Time"),
}


def _rule(char: str = "-") -> str:
    return char * WIDTH


def _title(text: str) -> None:
    print("\n" + _rule("="))
    print(text.center(WIDTH))
    print(_rule("="))


class RouteOptimizerCLI:
    """Menu-driven front end around the Dijkstra and A* searches."""

    def __init__(self, graph: Graph, metric: str, heuristic_scale: float,
                 benchmark_runs: int,
                 serviceability: ServiceabilityPolicy | None = None,
                 enforce_serviceability: bool = True) -> None:
        self.graph = graph
        # Policy for option 4 and (when enforced) for simulations;
        # None -> config/serviceability.json, loaded on first use.
        self._serviceability = serviceability
        self.enforce_serviceability = enforce_serviceability
        self.metric = metric
        self.heuristic_scale = heuristic_scale
        self.benchmark_runs = benchmark_runs
        # Stable numbering used by the location list: societies, then
        # restaurants, each sorted by ID.
        self.ordered_ids = sorted(
            graph.locations,
            key=lambda nid: (graph.locations[nid].kind != "Society", nid))
        self.list_number = {nid: i for i, nid in
                            enumerate(self.ordered_ids, start=1)}
        # Label the secondary metric neutrally: it was not minimised.
        self.time_label = ("Minimum Time" if metric == "time"
                           else "Travel Time")
        self.distance_label = ("Minimum Distance" if metric == "distance"
                               else "Total Distance")

    @property
    def serviceability(self) -> ServiceabilityPolicy:
        if self._serviceability is None:
            self._serviceability = ServiceabilityPolicy.default(self.graph)
        return self._serviceability

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    def run(self) -> None:
        _title("FOOD DELIVERY ROUTE OPTIMIZER")
        primary, secondary = METRIC_TITLES[self.metric]
        print(f"  Primary optimization : {primary}")
        print(f"  Secondary metric     : {secondary}")
        print(f"  Graph                : {self.graph.node_count} locations, "
              f"{self.graph.edge_count} directed roads")

        actions = {"1": self.find_route, "2": self.show_locations,
                  "3": self.prompt_run_simulation,
                  "4": self.prompt_check_serviceability,
                  "5": self.prompt_multistop}
        while True:
            print("\n" + _rule())
            print("  1. Find Route")
            print("  2. Show Available Locations")
            print("  3. Run Delivery Simulation")
            print("  4. Check Restaurant Serviceability")
            print("  5. Multi-Stop Planner (several orders per driver)")
            print("  6. Exit")
            print(_rule())
            choice = self._ask("Select an option (1-6): ")
            if choice is None or choice == "6":
                print("\nThank you for using the Food Delivery Route "
                      "Optimizer. Goodbye!")
                return
            action = actions.get(choice)
            if action is None:
                print("  ! Invalid option. Please enter 1-6.")
            else:
                action()

    @staticmethod
    def _ask(prompt: str) -> str | None:
        """input() that returns None on Ctrl+C / end of input."""
        try:
            return input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None

    # ------------------------------------------------------------------
    # Option 2: list locations
    # ------------------------------------------------------------------
    def _describe(self, node_id: str) -> str:
        loc = self.graph.locations[node_id]
        return f"[{loc.node_id}] {loc.name}"

    def _print_numbered(self, node_ids: list[str]) -> None:
        for node_id in node_ids:
            number = self.list_number[node_id]
            marker = "" if self.graph.is_connected_node(node_id) else "  *"
            print(f"  {number:>3}. {self._describe(node_id)}{marker}")

    def _print_societies(self) -> None:
        societies = [n for n in self.ordered_ids
                     if self.graph.locations[n].kind == "Society"]
        print(f"\nSOCIETIES / DELIVERY POINTS ({len(societies)})")
        print(_rule())
        self._print_numbered(societies)

    def show_locations(self) -> None:
        _title("AVAILABLE LOCATIONS")
        self._print_societies()

        restaurants = [n for n in self.ordered_ids
                       if self.graph.locations[n].kind == "Restaurant"]
        print(f"\nRESTAURANTS ({len(restaurants)}), grouped by area")
        print(_rule())
        by_area: dict[str, list[str]] = {}
        for node_id in restaurants:
            area = self.graph.locations[node_id].area or "Unknown area"
            by_area.setdefault(area, []).append(node_id)
        for area in sorted(by_area):
            print(f"\n  -- {area} --")
            self._print_numbered(by_area[area])
        print("\n  * = no road data for this location in the dataset "
              "(no route possible)")

    # ------------------------------------------------------------------
    # Option 1: find a route
    # ------------------------------------------------------------------
    def resolve_location(self, text: str) -> tuple[str | None, str]:
        """Map user input (ID, list number or name) to a node ID.

        Returns (node_id, "") on success or (None, error message).
        """
        query = text.strip()
        if not query:
            return None, "Please enter a location."
        if query.upper() in self.graph.locations:
            return query.upper(), ""
        if query.isdigit():
            number = int(query)
            if 1 <= number <= len(self.ordered_ids):
                return self.ordered_ids[number - 1], ""
            return None, (f"Location number must be between 1 and "
                          f"{len(self.ordered_ids)}.")

        wanted = query.casefold()
        names = {n: self.graph.locations[n].name.casefold()
                 for n in self.ordered_ids}
        matches = ([n for n, name in names.items() if name == wanted]
                   or [n for n, name in names.items() if wanted in name])
        if len(matches) == 1:
            return matches[0], ""
        if not matches:
            return None, (f"'{query}' is not a known location. Use an ID "
                          f"(e.g. S001, R190), a list number or a name.")
        shown = "\n".join(f"      {self._describe(n)}" for n in matches[:10])
        more = f"\n      ... and {len(matches) - 10} more" \
            if len(matches) > 10 else ""
        return None, (f"'{query}' matches {len(matches)} locations. "
                      f"Please type the ID:\n{shown}{more}")

    def _prompt_location(self, label: str,
                         exclude: str | None = None) -> str | None:
        """Ask until a valid location is given; None means 'go back'."""
        while True:
            text = self._ask(f"Enter {label} location (or 'b' to go back): ")
            if text is None or text.lower() == "b":
                return None
            node_id, error = self.resolve_location(text)
            if node_id is None:
                print(f"  ! {error}")
            elif node_id == exclude:
                print("  ! Source and destination are the same. "
                      "Please choose a different destination.")
            else:
                loc = self.graph.locations[node_id]
                print(f"    -> {self._describe(node_id)} "
                      f"({loc.kind}, {loc.area})")
                return node_id

    def find_route(self) -> None:
        _title("FIND ROUTE")
        self._print_societies()
        restaurant_count = sum(1 for loc in self.graph.locations.values()
                               if loc.kind == "Restaurant")
        print(f"\n  + {restaurant_count} restaurants (numbers "
              f"{len(self.ordered_ids) - restaurant_count + 1}-"
              f"{len(self.ordered_ids)}) - see option 2.")
        print("  Tip: a delivery usually goes restaurant -> society.")
        print("  You can type an ID (R190), a list number or part of a "
              "name.\n")

        source = self._prompt_location("source")
        if source is None:
            return
        target = self._prompt_location("destination", exclude=source)
        if target is None:
            return
        self.compare(source, target)

    # ------------------------------------------------------------------
    # Running and comparing the algorithms
    # ------------------------------------------------------------------
    def compare(self, source: str, target: str) -> None:
        """Run Dijkstra and A*, then print both results and a comparison."""
        results = [
            dijkstra(self.graph, source, target, self.metric),
            astar(self.graph, source, target, self.metric,
                  self.heuristic_scale),
        ]
        if self.benchmark_runs > 0:
            searches = [
                lambda: dijkstra(self.graph, source, target, self.metric),
                lambda: astar(self.graph, source, target, self.metric,
                              self.heuristic_scale),
            ]
            for result, search in zip(results, searches):
                result.avg_time_s, result.min_time_s = benchmark(
                    search, self.benchmark_runs)

        self._print_endpoints(source, target)
        if not results[0].found:
            self._print_no_route(results)
            return
        for result in results:
            self._print_result(result)
        self._print_legs(results)
        self._print_comparison(results)

    def _location_details(self, loc: Location) -> str:
        details = [loc.kind, loc.area]
        if loc.cuisine:
            details.append(loc.cuisine)
        if loc.rating is not None:
            details.append(f"rating {loc.rating:.1f}")
        return ", ".join(d for d in details if d)

    def _print_endpoints(self, source: str, target: str) -> None:
        _title("ROUTE SEARCH")
        for label, node_id in (("From", source), ("To", target)):
            loc = self.graph.locations[node_id]
            print(f"  {label:<5}: {self._describe(node_id)}")
            print(f"         {self._location_details(loc)}")
        primary, secondary = METRIC_TITLES[self.metric]
        print(f"  Optimizing for: {primary} (secondary: {secondary})")

    def _print_no_route(self, results: list[SearchResult]) -> None:
        source, target = results[0].source, results[0].target
        print("\n" + _rule())
        print(f"  NO ROUTE EXISTS from {source} to {target}.")
        for node_id in (source, target):
            if not self.graph.is_connected_node(node_id):
                print(f"  Reason: {self._describe(node_id)} has no road "
                      f"data in the dataset.")
        for result in results:
            print(f"  {result.algorithm:<9} explored {result.nodes_visited} "
                  f"node(s) in {format_ms(result.execution_time_s)} "
                  f"before giving up.")
        print(_rule())

    def _print_result(self, result: SearchResult) -> None:
        print(f"\n--- {result.algorithm} " + "-" * (WIDTH - 5
                                                 - len(result.algorithm)))
        print(f"  Algorithm Used     : {result.algorithm}")
        print(f"  From               : {self._describe(result.source)}")
        print(f"  To                 : {self._describe(result.target)}")
        print(f"  Route / Path       : {' -> '.join(result.path)}")
        print(f"  {self.distance_label:<19}: "
              f"{result.total_distance_km:.3f} km")
        print(f"  {self.time_label:<19}: {result.total_time_min:.1f} min")
        print(f"  Nodes Visited      : {result.nodes_visited}")
        print(f"  Edges Traversed    : {result.edges_traversed}")
        print(f"  Execution Time     : "
              f"{format_duration(result.execution_time_s)}")

    def _print_legs(self, results: list[SearchResult]) -> None:
        """Print the route leg by leg (once if both paths are equal)."""
        dijkstra_result, astar_result = results
        routes = [("Route details", dijkstra_result)]
        if astar_result.path != dijkstra_result.path:
            routes = [("Dijkstra route details", dijkstra_result),
                      ("A* route details", astar_result)]
        for heading, result in routes:
            print(f"\n{heading}:")
            for step, node_id in enumerate(result.path, start=1):
                loc = self.graph.locations[node_id]
                print(f"  {step:>2}. {self._describe(node_id)} "
                      f"({loc.kind})")
                if step <= len(result.legs):
                    _, _, km, minutes = result.legs[step - 1]
                    print(f"        |  {km:.3f} km, {minutes:.1f} min")

    def _print_comparison(self, results: list[SearchResult]) -> None:
        d, a = results
        rows = [
            ("From", d.source, a.source),
            ("To", d.target, a.target),
            ("Optimized For", d.metric.title(), a.metric.title()),
            (self.distance_label, f"{d.total_distance_km:.3f} km",
             f"{a.total_distance_km:.3f} km"),
            (self.time_label, f"{d.total_time_min:.1f} min",
             f"{a.total_time_min:.1f} min"),
            ("Nodes Visited", d.nodes_visited, a.nodes_visited),
            ("Edges Relaxed", d.edges_relaxed, a.edges_relaxed),
            ("Edges Traversed", d.edges_traversed, a.edges_traversed),
            ("Execution Time", format_ms(d.execution_time_s),
             format_ms(a.execution_time_s)),
        ]
        if d.avg_time_s is not None and a.avg_time_s is not None:
            n = self.benchmark_runs
            rows += [
                (f"Avg Time ({n} runs)", format_ms(d.avg_time_s),
                 format_ms(a.avg_time_s)),
                (f"Min Time ({n} runs)", format_ms(d.min_time_s),
                 format_ms(a.min_time_s)),
            ]

        _title("ROUTE COMPARISON")
        print(f"{'':<{LABEL_W}}{'DIJKSTRA':<{COL_W}}{'A*':<{COL_W}}")
        print(_rule())
        for label, left, right in rows:
            print(f"{label:<{LABEL_W}}{str(left):<{COL_W}}{str(right):<{COL_W}}")
        print(_rule())
        self._print_verdict(d, a)

    def _print_verdict(self, d: SearchResult, a: SearchResult) -> None:
        unit = METRIC_UNITS[d.metric]
        same_cost = abs(d.cost - a.cost) < 1e-9
        print(f"Optimal cost         : "
              f"{'Both found ' if same_cost else 'MISMATCH: '}"
              f"{d.cost:.3f} {unit}"
              f"{'' if same_cost else f' vs {a.cost:.3f} {unit}'}")
        if d.path == a.path:
            print("Same route           : Yes")
        else:
            print("Same route           : No (different path, equal cost)")

        if a.nodes_visited < d.nodes_visited:
            saved = 100 * (1 - a.nodes_visited / d.nodes_visited)
            print(f"Fewer nodes visited  : A* ({a.nodes_visited} vs "
                  f"{d.nodes_visited}, {saved:.0f}% fewer)")
        elif a.nodes_visited == d.nodes_visited:
            print(f"Fewer nodes visited  : Tie ({d.nodes_visited} each)")
        else:
            print(f"Fewer nodes visited  : Dijkstra ({d.nodes_visited} vs "
                  f"{a.nodes_visited})")

        # Prefer the benchmark average: a single run of a few microseconds
        # is dominated by timer noise.
        use_avg = d.avg_time_s is not None and a.avg_time_s is not None
        d_time = d.avg_time_s if use_avg else d.execution_time_s
        a_time = a.avg_time_s if use_avg else a.execution_time_s
        basis = "average time" if use_avg else "single run"
        faster, slower = ("A*", "Dijkstra") if a_time < d_time \
            else ("Dijkstra", "A*")
        ratio = max(d_time, a_time) / max(min(d_time, a_time), 1e-12)
        print(f"\nFaster Algorithm: {faster} "
              f"({ratio:.2f}x faster than {slower}, by {basis})")

    # ------------------------------------------------------------------
    # Option 3: run the delivery simulation
    # ------------------------------------------------------------------
    def _ask_int(self, label: str, default: int) -> int:
        text = self._ask(f"{label} [{default}]: ")
        if not text:
            return default
        try:
            value = int(text)
        except ValueError:
            print(f"  ! Not a number, using default ({default}).")
            return default
        if value <= 0:
            print(f"  ! Must be positive, using default ({default}).")
            return default
        return value

    def prompt_run_simulation(self) -> None:
        """Menu-driven wrapper around :meth:`run_simulation`."""
        _title("RUN DELIVERY SIMULATION")
        print("  Press Enter to accept each default.\n")
        num_drivers = self._ask_int("Drivers", 50)
        num_orders = self._ask_int("Orders", 100)
        seed_text = self._ask("Seed [42]: ")
        seed = int(seed_text) if seed_text and seed_text.lstrip("-").isdigit() \
            else 42
        algorithm = self._ask("Algorithm (dijkstra/astar) [astar]: ").lower()
        if algorithm not in ("dijkstra", "astar"):
            algorithm = "astar"
        self.run_simulation(num_drivers, num_orders, seed, algorithm)

    def run_simulation(self, num_drivers: int = 50, num_orders: int = 100,
                       seed: int = 42, algorithm: str = "astar",
                       reject_unserviceable: bool = False) -> SimulationMetrics:
        """Run the greedy-dispatch delivery simulation and print a report."""
        _title("DELIVERY SIMULATION")
        print(f"  Drivers   : {num_drivers}")
        print(f"  Orders    : {num_orders}")
        print(f"  Algorithm : {algorithm}")
        print(f"  Metric    : {self.metric}")
        print(f"  Seed      : {seed}")

        print(f"  Serviceability: "
              f"{'enforced' if self.enforce_serviceability else 'not enforced'}"
              f"{', unserviceable orders kept as REJECTED' if reject_unserviceable and self.enforce_serviceability else ''}")

        simulation = DeliverySimulation(
            self.graph, num_drivers, num_orders, seed, algorithm, self.metric,
            serviceability=(self.serviceability
                            if self.enforce_serviceability else None),
            enforce_serviceability=self.enforce_serviceability,
            reject_unserviceable=reject_unserviceable)
        m = simulation.run()

        _title("SIMULATION RESULTS")
        rows = [
            ("Total Orders", m.total_orders),
            ("Delivered Orders", m.delivered_orders),
            ("Failed Orders", m.failed_orders),
            ("  of which Rejected (service)", m.rejected_orders),
            ("Total Distance (km)", f"{m.total_distance_km:.3f}"),
            ("Avg Distance/Order (km)", f"{m.avg_distance_km:.3f}"),
            ("Total Travel Time (min)", f"{m.total_travel_time_min:.1f}"),
            ("Avg Travel Time/Order (min)", f"{m.avg_travel_time_min:.1f}"),
            ("Drivers Used", f"{m.drivers_used} / {m.num_drivers}"),
            ("Driver Utilization", f"{m.driver_utilization * 100:.1f}%"),
            ("Assignment Compute Time", format_duration(
                m.assignment_computation_time_s)),
            ("Total Simulation Time", format_duration(
                m.total_simulation_time_s)),
            ("P50 Assignment Latency", f"{m.p50_assignment_latency_ms:.4f} ms"),
            ("P95 Assignment Latency", f"{m.p95_assignment_latency_ms:.4f} ms"),
            ("P99 Assignment Latency", f"{m.p99_assignment_latency_ms:.4f} ms"),
        ]
        for label, value in rows:
            print(f"  {label:<30}: {value}")
        print(_rule())
        return m

    # ------------------------------------------------------------------
    # Option 4: restaurant -> society serviceability
    # ------------------------------------------------------------------
    def prompt_check_serviceability(self) -> None:
        _title("CHECK SERVICEABILITY")
        restaurant = self._prompt_location("Restaurant")
        if restaurant is None:
            return
        society = self._prompt_location("Society")
        if society is None:
            return
        self.check_serviceability(restaurant, society)

    def check_serviceability(self, restaurant_id: str, society_id: str
                             ) -> None:
        """Print whether ``restaurant_id`` may deliver to ``society_id``."""
        policy = self.serviceability
        r = policy.check(restaurant_id, society_id)
        cfg = policy.config
        print(f"  Restaurant : [{restaurant_id}] zone {r.restaurant_zone or '-'}")
        print(f"  Society    : [{society_id}] zone {r.society_zone or '-'}")
        if r.distance_km is not None:
            print(f"  Route      : {' -> '.join(r.route)}")
            print(f"  Delivery   : {r.distance_km:.3f} km "
                  f"(limit {cfg.max_distance_km}), {r.time_min:.1f} min "
                  f"(limit {cfg.max_time_min})")
        verdict = "SERVICEABLE" if r.serviceable else             f"NOT SERVICEABLE - {r.reason.value}"
        print(f"  Result     : {verdict}")
        if not r.serviceable:
            print(f"  Reason     : {r.message}")
        print(_rule())

    # ------------------------------------------------------------------
    # Multi-stop pickup-and-delivery: baseline vs optimiser
    # ------------------------------------------------------------------
    def run_multistop(self, config: MultiStopConfig) -> Comparison:
        """Run the naive baseline and the insertion optimiser on the same
        scenario and print both, plus the distance KPI."""
        _title("MULTI-STOP DELIVERY SIMULATION")
        policy = self.serviceability if self.enforce_serviceability else None
        print(f"  Drivers x capacity : {config.num_drivers} x "
              f"{config.capacity} active orders")
        print(f"  Orders             : {config.num_orders} over "
              f"{config.horizon_min:g} min, dispatch every "
              f"{config.dispatch_interval_min:g} min")
        print(f"  Prep time          : {config.prep_time_min[0]:g}-"
              f"{config.prep_time_min[1]:g} min, deadline "
              f"{config.max_delivery_min} min, max detour "
              f"{config.max_ride_extra_min} min")
        print(f"  Metric / back-end  : {config.metric} / {config.algorithm}")
        print(f"  Seed               : {config.seed}")
        print(f"  Serviceability     : "
              f"{'enforced' if policy else 'not enforced'}")

        result = compare(self.graph, config, policy)
        base, opt = result.baseline, result.optimized

        _title("BASELINE vs OPTIMISED")
        print(f"{'':<28}{'NAIVE GREEDY':>18}{'INSERTION':>18}")
        print(_rule())
        rows = [
            ("Delivered", "delivered", "{}"),
            ("Failed (no driver/deadline)", "failed", "{}"),
            ("Rejected (serviceability)", "rejected", "{}"),
            ("Total distance (km)", "total_distance_km", "{:.3f}"),
            ("Total drive time (min)", "total_drive_time_min", "{:.1f}"),
            ("Avg order-to-door (min)", "avg_delivery_min", "{:.1f}"),
            ("Max order-to-door (min)", "max_delivery_min", "{:.1f}"),
            ("Late deliveries", "late_deliveries", "{}"),
            ("Orders batched", "batched_orders", "{}"),
            ("Drivers used", "drivers_used", "{}"),
            ("Dispatch rounds", "dispatch_rounds", "{}"),
            ("p50 round latency (ms)", "p50_latency_ms", "{:.3f}"),
            ("p95 round latency (ms)", "p95_latency_ms", "{:.3f}"),
            ("Max round latency (ms)", "max_latency_ms", "{:.3f}"),
        ]
        for label, attr, fmt in rows:
            print(f"{label:<28}{fmt.format(getattr(base, attr)):>18}"
                  f"{fmt.format(getattr(opt, attr)):>18}")
        print(_rule())
        print(f"  Distance matrix precompute: "
              f"{result.precompute_s * 1000:.1f} ms (once, not in latency)")
        print(f"  Route distance reduction  : "
              f"{result.distance_reduction * 100:.1f}% vs naive greedy")
        if not result.same_service_level:
            verdict = "NOT COMPARABLE (optimiser delivered fewer orders)"
        elif result.kpi_passed():
            verdict = "MET for this scenario (>= 15%)"
        else:
            verdict = "NOT MET for this scenario (< 15%)"
        print(f"  15% distance KPI          : {verdict}")
        matrix = DistanceMatrix(self.graph, config.metric)
        for res in (base, opt):
            label = "Naive greedy" if res.mode == "append" else "Insertion"
            problems = check_compliance(res, policy,
                                        config.max_ride_extra_min, matrix)
            print(f"  {label + ' constraints':<26}: "
                  f"{'all satisfied' if not problems else '; '.join(problems)}")
            for event in res.reroutes:
                print(f"    minute {event.at:g}: {event.action} "
                      f"{event.road[0]}->{event.road[1]}, "
                      f"{len(event.affected_drivers)} driver(s) affected, "
                      f"{event.latency_s * 1000:.2f} ms")
                for order_id, why in {**event.released_orders,
                                      **event.failed_orders,
                                      **event.at_risk_orders}.items():
                    print(f"      {order_id}: {why}")
        print(_rule())
        return result

    # ------------------------------------------------------------------
    # Option 5: multi-stop planner
    # ------------------------------------------------------------------
    def prompt_multistop(self) -> None:
        _title("MULTI-STOP PLANNER")
        print("  1. Build a scenario (choose orders and drivers)")
        print("  2. Run the random simulation (baseline vs optimiser)")
        choice = self._ask("Select (1-2, 'b' to go back): ")
        if choice == "1":
            self.prompt_scenario()
        elif choice == "2":
            self.run_multistop(MultiStopConfig(
                num_drivers=self._ask_int("Drivers", 50),
                num_orders=self._ask_int("Orders", 100),
                capacity=self._ask_int("Capacity (orders per driver)", 3),
                seed=self._ask_int("Seed", 42), metric=self.metric))

    def _prompt_kind(self, label: str, kind: str) -> str | None:
        while True:
            node = self._prompt_location(label)
            if node is None or self.graph.locations[node].kind == kind:
                return node
            print(f"  ! Please choose a {kind.lower()}.")

    def prompt_scenario(self) -> None:
        """Interactive version of the web planner (same core code)."""
        orders: list[OrderSpec] = []
        print("\n  Add orders. Press 'b' at the restaurant prompt when done.")
        while True:
            print(f"\n  Order {len(orders) + 1}")
            restaurant = self._prompt_kind("restaurant (pickup)", "Restaurant")
            if restaurant is None:
                break
            society = self._prompt_kind("society (drop-off)", "Society")
            if society is None:
                break
            orders.append(OrderSpec(restaurant, society))
        if not orders:
            print("  No orders entered.")
            return
        drivers: list[str] = []
        print("\n  Add driver start locations. Press 'b' when done.")
        while True:
            node = self._prompt_location(f"driver {len(drivers) + 1} start")
            if node is None:
                break
            drivers.append(node)
        if not drivers:
            print("  No drivers entered.")
            return
        capacity = self._ask_int("Capacity (orders per driver)", 3)
        algorithm = (self._ask("Algorithm (dijkstra/astar) [dijkstra]: ")
                     or "dijkstra").lower()
        if algorithm not in ("dijkstra", "astar"):
            algorithm = "dijkstra"
        self.run_custom_scenario(ScenarioSpec(
            orders=orders, driver_nodes=drivers, capacity=capacity,
            algorithm=algorithm, metric=self.metric,
            enforce_serviceability=self.enforce_serviceability))

    def run_custom_scenario(self, spec: ScenarioSpec) -> dict:
        """Run a hand-built scenario and print stops, totals and reasons."""
        try:
            report = run_scenario(self.graph, spec, self.serviceability)
        except ValueError as exc:
            print(f"  ! {exc}")
            return {}
        for mode in ("append", "insertion"):
            method = report["methods"][mode]
            _title(f"{method['label'].upper()} PLAN")
            for driver in method["drivers"]:
                print(f"  {driver['driver_id']} starts at {driver['start']} "
                      f"({driver['start_name']}): "
                      f"{driver['distance_km']:.3f} km, "
                      f"{driver['drive_time_min']:.1f} min")
                for k, stop in enumerate(driver["stops"], start=1):
                    kind = "PICKUP " if stop["kind"] == "PICKUP" else "DROPOFF"
                    print(f"    {k:>2}. {kind} {stop['order_id']} at "
                          f"{stop['node']} {stop['name'][:28]:<28} "
                          f"arr {stop['arrival']:6.1f}  "
                          f"cum {stop['cum_km']:7.3f} km "
                          f"{stop['cum_min']:6.1f} min")
                print(f"        road path: {' -> '.join(driver['path'])}")
            for order in method["orders"]:
                if order["status"] != "DELIVERED" or order["late"]:
                    print(f"  {order['order_id']} {order['restaurant']} -> "
                          f"{order['society']}: {order['status']}"
                          f"{' (LATE)' if order['late'] else ''} "
                          f"{order['reason'] or ''} {order['message']}")
            for event in method["reroutes"]:
                print(f"  minute {event['at']:g}: {event['action']} "
                      f"{event['road'][0]}->{event['road'][1]}, affected "
                      f"{event['affected_drivers'] or '-'}, rerouted in "
                      f"{event['latency_ms']:.2f} ms")
            totals = method["totals"]
            print(_rule())
            print(f"  Delivered {totals['delivered']}, rejected "
                  f"{totals['rejected']}, failed {totals['failed']}, late "
                  f"{totals['late']}; total {totals['distance_km']:.3f} km, "
                  f"{totals['drive_time_min']:.1f} min")
            print("  Constraints: " + ("all satisfied" if not
                                       method["violations"] else
                                       "; ".join(method["violations"])))
        print(f"\n  Optimiser route distance: "
              f"{report['distance_reduction'] * 100:.1f}% shorter than the "
              f"naive greedy plan.")
        print(_rule())
        return report

