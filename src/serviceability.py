"""Restaurant -> society serviceability (who may deliver where).

Three concepts are kept separate in this project:

* **Road connectivity**   - does a route exist? (``dijkstra`` / ``astar``)
* **Serviceability**      - is this restaurant *allowed* to deliver to this
                            society under the configured policy? (this module)
* **Driver assignment**   - which driver carries the order? (``dispatch.py``)

A route existing is necessary but not sufficient: a Miraj restaurant is not
serviceable for a Sangli society when the policy excludes Miraj -> Sangli,
even though the graph connects them.

Zones
-----
Every address in the dataset ends with its postal town and PIN, e.g.
``"..., Miraj 416415, Maharashtra"``. A location's zone is that town (one of
``config.zones``), unless ``zone_overrides`` sets it explicitly. Area labels
and coordinates are *not* used to grant serviceability on their own.

Checks, in order (the first failure is the rejection reason):

1. restaurant and society exist with the right kind  -> INVALID_RESTAURANT_OR_SOCIETY
2. restaurant is accepting orders                     -> RESTAURANT_NOT_ACCEPTING_ORDERS
3. pair is authorised (deny list > allow list > zone rules)
                                                      -> OUTSIDE_SERVICE_ZONE
4. a road route exists                                -> NO_ROAD_ROUTE
5. route distance <= max_distance_km                  -> DELIVERY_DISTANCE_EXCEEDED
6. route time <= max_time_min                         -> DELIVERY_TIME_EXCEEDED

Explicitly allowed pairs skip only the zone rule; distance and time limits
still apply to them.

The default policy (``config/serviceability.json``) is a synthetic
assumption for this project, not a real platform's service boundaries.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field, fields
from enum import Enum

from src.dijkstra import dijkstra
from src.graph import METRIC_INDEX, Graph, Location

DEFAULT_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "config", "serviceability.json")


class Reason(str, Enum):
    """Why a (restaurant, society) pair is not serviceable."""

    INVALID_RESTAURANT_OR_SOCIETY = "INVALID_RESTAURANT_OR_SOCIETY"
    RESTAURANT_NOT_ACCEPTING_ORDERS = "RESTAURANT_NOT_ACCEPTING_ORDERS"
    OUTSIDE_SERVICE_ZONE = "OUTSIDE_SERVICE_ZONE"
    NO_ROAD_ROUTE = "NO_ROAD_ROUTE"
    DELIVERY_DISTANCE_EXCEEDED = "DELIVERY_DISTANCE_EXCEEDED"
    DELIVERY_TIME_EXCEEDED = "DELIVERY_TIME_EXCEEDED"


@dataclass
class ServiceabilityConfig:
    """Serviceability policy. ``None`` for a limit disables that limit."""

    zones: list[str] = field(
        default_factory=lambda: ["Sangli", "Miraj", "Kupwad"])
    zone_overrides: dict[str, str] = field(default_factory=dict)
    allow_same_zone: bool = True
    # (restaurant_zone, society_zone) pairs allowed across zones.
    # Keep in sync with config/serviceability.json (a test checks this).
    allowed_zone_pairs: set[tuple[str, str]] = field(
        default_factory=lambda: {("Kupwad", "Sangli"), ("Sangli", "Kupwad")})
    # (restaurant_id, society_id) pairs: explicit allow / deny.
    allowed_pairs: set[tuple[str, str]] = field(default_factory=set)
    denied_pairs: set[tuple[str, str]] = field(default_factory=set)
    disabled_restaurants: set[str] = field(default_factory=set)
    max_distance_km: float | None = 8.0
    max_time_min: float | None = 30.0
    route_metric: str = "time"

    def validate(self) -> None:
        """Raise ValueError for settings that could never take effect."""
        used = ({zone for pair in self.allowed_zone_pairs for zone in pair}
                | set(self.zone_overrides.values()))
        unknown = used - set(self.zones)
        if unknown:
            raise ValueError(f"unknown zone(s) {sorted(unknown)}; "
                             f"configured zones are {self.zones}")
        if self.route_metric not in METRIC_INDEX:
            raise ValueError(f"route_metric must be one of "
                             f"{sorted(METRIC_INDEX)}")
        for name in ("max_distance_km", "max_time_min"):
            value = getattr(self, name)
            if value is not None and (isinstance(value, bool)
                                      or not isinstance(value, (int, float))
                                      or value < 0):
                raise ValueError(
                    f"{name} must be a non-negative number or null")

    