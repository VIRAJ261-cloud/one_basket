"""Tests for restaurant -> society serviceability.

Run with:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import unittest

from src.dijkstra import dijkstra
from src.dispatch import DispatchEngine
from src.driver import Driver, DriverStatus
from src.graph import Graph, Location
from src.order import Order, OrderStatus, generate_orders
from src.serviceability import (Reason, ServiceabilityConfig,
                                ServiceabilityPolicy)
from src.simulation import DeliverySimulation
from tests.test_simulation import _real_graph

SANGLI = "Main Road, Sangli 416416, Maharashtra"
MIRAJ = "Station Road, Miraj 416410, Maharashtra"


def _zoned_graph() -> Graph:
    """Synthetic graph with Sangli and Miraj locations.

    RS1 (Sangli) -> SS1 (Sangli): 2 km / 8 min, local delivery
    RM1 (Miraj)  -> SS1 (Sangli): 3 km / 10 min, cross-area but short
    RS2 (Sangli) -> SS2 (Sangli): 12 km / 20 min, too far
    RS3 (Sangli) -> SS3 (Sangli): 5 km / 45 min, too slow
    RS4 (Sangli): no roads, so unreachable
    RX1 (no town in address) -> SS1
    RA1 (Miraj) shares the Area label "Shared Area" with SS1
    """
    graph = Graph()

    def add(node_id: str, kind: str, address: str,
            area: str = "Area") -> None:
        graph.add_location(Location(node_id, node_id, kind, area, address,
                                    16.85, 74.60))

    add("SS1", "Society", SANGLI, area="Shared Area")
    add("SS2", "Society", SANGLI)
    add("SS3", "Society", SANGLI)
    add("RS1", "Restaurant", SANGLI)
    add("RS2", "Restaurant", SANGLI)
    add("RS3", "Restaurant", SANGLI)
    add("RS4", "Restaurant", SANGLI)
    add("RM1", "Restaurant", MIRAJ)
    add("RX1", "Restaurant", "Unnamed lane, Maharashtra")
    add("RA1", "Restaurant", MIRAJ, area="Shared Area")
    for source, target, km, minutes in [
        ("RS1", "SS1", 2.0, 8.0), ("SS1", "RS1", 2.0, 8.0),
        ("RM1", "SS1", 3.0, 10.0), ("SS1", "RM1", 3.0, 10.0),
        ("RS2", "SS2", 12.0, 20.0), ("SS2", "RS2", 12.0, 20.0),
        ("RS3", "SS3", 5.0, 45.0), ("SS3", "RS3", 5.0, 45.0),
        ("RX1", "SS1", 1.0, 4.0), ("RA1", "SS1", 1.0, 4.0),
    ]:
        graph.add_edge(source, target, km, minutes)
    return graph


def _policy(**overrides) -> ServiceabilityPolicy:
    config = ServiceabilityConfig(max_distance_km=8.0, max_time_min=30.0)
    for key, value in overrides.items():
        setattr(config, key, value)
    return ServiceabilityPolicy(_zoned_graph(), config)


