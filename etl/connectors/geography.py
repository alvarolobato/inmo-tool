"""Resolve a (lat, lon) point to the nearest known Spanish municipality.

Shared across connectors because a municipality's coordinates don't depend
on which site you're scraping — Estepona is at the same point regardless.
What DOES depend on the site is how that municipality/province turns into a
URL/query (Fotocasa's "estepona" bare slug vs. Solvia's "malaga/estepona"
provincia/municipio path vs. Servihabitat's whole-province sitemap) — that
translation stays inside each connector, not here (see ConnectorScope's
docstring in etl/connectors/base.py for why).

Issue #169 history, worth keeping so nobody re-introduces it: this module
used to hardcode a 4-entry `CITY_CENTROIDS` dict (Madrid, Sevilla,
Barcelona, Valencia). Any profile centered on a 5th city — Malaga, Bilbao,
whatever — resolved to zero coverage on every connector, silently: no
error, no warning surfaced to an operator, just an empty result set that
read exactly like "we searched and there was nothing there." The owner's
first fix proposal was a bigger hand-curated table; the owner then
correctly rejected that too ("why do you need to do anything ad-hoc per
area?") — a longer manually-typed list is still ad-hoc, just with a higher
ceiling that will eventually get hit again the same way. The actual fix has
two independent parts:

  1. This module is now a real gazetteer (`etl/connectors/geodata/
     es_places.csv`, ~8,248 Spanish municipalities, vendored from GeoNames
     — see that directory's README.md for provenance/license/regeneration),
     not a curated list. "Do we cover Malaga" is no longer a question
     anyone has to remember to answer by editing a dict.
  2. `resolve_place()` RAISES (`UnresolvableGeographyError`) when a scope
     carries a real center point that matches no known municipality at all
     — as opposed to returning None, which every connector's discover()
     used to treat identically to "zero listings found here". A gazetteer
     this comprehensive still can't cover literally everywhere (mid-ocean,
     another country, the middle of an uninhabited sierra), and when a
     scope genuinely can't be resolved, an operator must see a real
     `connector_run_results` failure, never silence. This is the durable
     half of the fix — it holds for every place not in the gazetteer,
     forever, independent of how big the gazetteer gets.

`nearest_place`'s bound (`_MAX_MATCH_DISTANCE_KM`, still 40km) is unchanged
by any of this: it is still correct to refuse a match farther than that (or
farther than the scope's own tighter radius) from every known point, so a
profile near the Portuguese border doesn't get silently matched to the
nearest Spanish town across it.
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from pathlib import Path

from etl.connectors.base import ConnectorError, ConnectorScope

_DATA_PATH = Path(__file__).parent / "geodata" / "es_places.csv"


@dataclass(frozen=True)
class Place:
    """One resolved gazetteer entry — a Spanish municipality.

    `name` is the ascii, lowercased municipality name (e.g. "estepona"),
    matching the lookup keys connectors already use in their own
    `_CITY_SLUGS`-equivalent tables. `province` is the ascii province name
    (e.g. "Malaga") — needed by connectors whose own site organizes search
    by province rather than municipality (Solvia's provincia/municipio
    path, Servihabitat's per-province sitemap).
    """

    name: str
    province: str
    lat: float
    lon: float
    population: int


def _load_places() -> tuple[Place, ...]:
    with _DATA_PATH.open(encoding="utf-8", newline="") as f:
        return tuple(
            Place(
                name=row["name"],
                province=row["province"],
                lat=float(row["lat"]),
                lon=float(row["lon"]),
                population=int(row["population"] or 0),
            )
            for row in csv.DictReader(f)
        )


# Loaded once at import time — a vendored file, not a network call, so this
# is cheap and has no runtime dependency (issue #169: a live geocoder was
# explicitly considered and rejected for the ETL path — no API key, no rate
# limit, no network flakiness in a nightly sync, reproducible byte-for-byte
# from a checked-in file).
PLACES: tuple[Place, ...] = _load_places()

# A profile centered farther than this from every known place isn't
# confidently "about" any of them — better to treat a connector as having
# no coverage for that scope than guess wrong and silently crawl the wrong
# municipality. This is a ceiling, not a target: a profile's own (typically
# much smaller) radius_km further tightens the match (see nearest_place) so
# e.g. a 13km-radius Getafe profile doesn't get silently matched to Madrid
# just because Getafe is within 40km of it — Getafe's own radius says it
# isn't asking about Madrid at all. Unchanged by the gazetteer expansion
# (issue #169 review): a denser point set doesn't make a looser ceiling
# correct, and Getafe itself is now its own gazetteer entry anyway.
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


def nearest_place(
    center: tuple[float, float], radius_km: float | None = None
) -> Place | None:
    """Return the nearest gazetteer entry for `center`, or None if too far.

    "Too far" means farther than `min(_MAX_MATCH_DISTANCE_KM, radius_km)`
    from every known place — a profile scoped somewhere with no nearby
    known municipality should be flagged as unresolvable, not silently
    mapped to a random nearest place (see `resolve_place`, the caller most
    code should actually use).

    `radius_km` (a profile's own search radius, when given) tightens the
    global `_MAX_MATCH_DISTANCE_KM` ceiling rather than replacing it — see
    the module-level constant's docstring, and
    `TestNearestPlaceRadiusBounding` in test_geography.py for the exact
    Getafe/Madrid scenario this guards.
    """
    best: Place | None = None
    best_distance = math.inf
    for place in PLACES:
        distance = _haversine_km(center, (place.lat, place.lon))
        if distance < best_distance:
            best_distance = distance
            best = place

    max_distance = _MAX_MATCH_DISTANCE_KM
    if radius_km is not None and radius_km > 0:
        max_distance = min(max_distance, radius_km)

    if best is None or best_distance > max_distance:
        return None
    return best


def nearest_city(
    center: tuple[float, float], radius_km: float | None = None
) -> str | None:
    """Convenience wrapper over `nearest_place` for callers that only need
    the municipality name, not its province/population too."""
    place = nearest_place(center, radius_km)
    return place.name if place else None


class UnresolvableGeographyError(ConnectorError):
    """A scope carries a real center point that resolves to no known place.

    Distinct from a connector simply having no coverage for a *known*
    municipality (that's the connector's own `_CITY_SLUGS`-equivalent table
    returning nothing for a name `resolve_place` DID successfully resolve —
    a deliberate, logged, non-failure skip; see `scope_key`'s contract in
    base.py). This is "the gazetteer doesn't know what place this scope is
    even asking about" — which used to look identical to zero listings
    found, on every connector, before issue #169. Must be allowed to
    propagate out of a connector's `discover()` uncaught, so the
    orchestrator's existing `except Exception` around `run_connector`
    records it as a real `connector_run_results` failure. Must NEVER be
    caught and swallowed inside a connector's own `scope_key()` (which must
    not raise at all — the orchestrator calls it with no try/except around
    it, see `unresolvable_scope_key` below for the safe alternative there).
    """


def resolve_place(scope: ConnectorScope) -> Place | None:
    """The shared half of every connector's `_resolve_geography`: turn
    `scope.center` into a gazetteer `Place`.

    Returns None only when `scope.center` is None — there is nothing to
    resolve at all, a legitimate no-op matching `scope_key()`'s "None means
    no coverage, not a failure" contract in base.py. Callers should check
    their own `scope.geography` free-text escape hatch (see
    `ConnectorScope`'s docstring) BEFORE calling this — that string is
    already a site-specific slug/query, not a place name to look up here.

    Raises `UnresolvableGeographyError` when `scope.center` IS given but
    `nearest_place` can't match it to anything in the gazetteer within
    bound. Every caller must let this propagate out of `discover()`
    uncaught — see the exception's own docstring for why this must never be
    caught inside `scope_key()`.
    """
    if scope.center is None:
        return None
    place = nearest_place(scope.center, scope.radius_km)
    if place is None:
        raise UnresolvableGeographyError(
            f"center={scope.center} radius_km={scope.radius_km} does not "
            "resolve to any place in the gazetteer "
            "(etl/connectors/geodata/es_places.csv) within range — this "
            "scope's geography could not be identified at all, which is "
            "different from 'a known municipality this connector doesn't "
            "cover' (issue #169)"
        )
    return place


def unresolvable_scope_key(scope: ConnectorScope) -> str:
    """A stable `scope_key()` value for a scope whose geography resolution
    will raise, safe to return from a method that must never raise itself.

    Never collides with a real resolved key (the `unresolvable-geography:`
    prefix isn't a valid slug/province-pair any connector produces), so the
    orchestrator's `seen_scope_keys` dedup treats it as its own distinct
    target. Crucially it is NOT `None`: returning `None` here would put this
    scope back on the "no coverage, not a failure, skip before calling
    discover()" path in `etl.orchestrator.run_all_connectors` — exactly the
    silent behaviour issue #169 exists to eliminate. Returning this sentinel
    instead means the orchestrator calls `discover()`, whose own
    `resolve_place()` call raises `UnresolvableGeographyError` there,
    landing the scope as a genuine `connector_run_results` failure.
    """
    return f"unresolvable-geography:{scope.center}:{scope.radius_km}"
