"""Resolve a (lat, lon) point to the nearest known Spanish city name.

Shared across connectors because a city's coordinates don't depend on which
site you're scraping — Madrid is at the same point regardless. What DOES
depend on the site is how that city name turns into a URL/query (Fotocasa's
"madrid-capital" hyphenated slug vs. Milanuncios's "madrid-madrid" doubled
path segment) — that translation stays inside each connector, not here (see
ConnectorScope's docstring in etl/connectors/base.py for why).

Centroids are approximate city-center points, good enough for "which major
city is this profile's search radius centered on or near" — not a general
geocoder. Live-verified against real Fotocasa/Milanuncios responses during
issue #71's implementation (HTTP 200 + real listing data, not just a
non-error status) for every city listed here.
"""

from __future__ import annotations

import math

# (lat, lon) city-center approximations.
CITY_CENTROIDS: dict[str, tuple[float, float]] = {
    "madrid": (40.4168, -3.7038),
    "sevilla": (37.3891, -5.9845),
    "barcelona": (41.3851, 2.1734),
    "valencia": (39.4699, -0.3763),
}

# A profile centered farther than this from every known city isn't
# confidently "about" any of them — better to skip a connector for that
# scope than guess wrong and silently crawl the wrong city.
_MAX_MATCH_DISTANCE_KM = 40.0


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def nearest_city(center: tuple[float, float]) -> str | None:
    """Return the nearest known city name for `center`, or None if too far.

    "Too far" means farther than `_MAX_MATCH_DISTANCE_KM` from every known
    centroid — a profile scoped somewhere this connector has no coverage for
    should be skipped, not silently mapped to a random nearest city.
    """
    best_name: str | None = None
    best_distance = math.inf
    for name, centroid in CITY_CENTROIDS.items():
        distance = _haversine_km(center, centroid)
        if distance < best_distance:
            best_distance = distance
            best_name = name
    if best_name is None or best_distance > _MAX_MATCH_DISTANCE_KM:
        return None
    return best_name
