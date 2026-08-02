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
# scope than guess wrong and silently crawl the wrong city. This is a
# ceiling, not a target: a profile's own (typically much smaller) radius_km
# further tightens the match (see nearest_city) so e.g. a 13km-radius
# Getafe profile doesn't get silently matched to Madrid just because
# Getafe is within 40km of it — Getafe's own radius says it isn't asking
# about Madrid at all.
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


def nearest_city(
    center: tuple[float, float], radius_km: float | None = None
) -> str | None:
    """Return the nearest known city name for `center`, or None if too far.

    "Too far" means farther than `min(_MAX_MATCH_DISTANCE_KM, radius_km)`
    from every known centroid — a profile scoped somewhere this connector
    has no coverage for should be skipped, not silently mapped to a random
    nearest city.

    `radius_km` (a profile's own search radius, when given) tightens the
    global `_MAX_MATCH_DISTANCE_KM` ceiling rather than replacing it: a
    profile centered on a small town near a known city (e.g. Getafe, ~13km
    from Madrid's centroid) with a *tight* search radius (say 10km) is
    explicitly saying "I mean this town, not the wider metro area" — it
    must NOT silently resolve to Madrid just because Madrid happens to be
    within the fixed 40km ceiling. A profile with a *wide* radius that
    genuinely reaches a known city's centroid (e.g. 20km, which does reach
    Getafe->Madrid's 13km) is treated as intentionally covering it.
    `radius_km=None` (or non-positive) falls back to the ceiling alone,
    matching pre-issue-#71-hardening behavior for callers that don't have a
    real profile radius to hand.
    """
    best_name: str | None = None
    best_distance = math.inf
    for name, centroid in CITY_CENTROIDS.items():
        distance = _haversine_km(center, centroid)
        if distance < best_distance:
            best_distance = distance
            best_name = name

    max_distance = _MAX_MATCH_DISTANCE_KM
    if radius_km is not None and radius_km > 0:
        max_distance = min(max_distance, radius_km)

    if best_name is None or best_distance > max_distance:
        return None
    return best_name
