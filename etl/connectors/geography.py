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

`nearest_place`'s bound (`_MAX_MATCH_DISTANCE_KM`, still 40km) refuses a
match farther than that (or farther than the scope's own tighter radius)
from every known point — but 40km is wide enough that it does NOT, in
practice, stop a point just across the border in another country from
silently matching the nearest Spanish town. PR #177 round 3 (N3) found
this claim was false as written, not just untested: Elvas (Portugal) still
resolves to `badajoz` (16.5km away), Gibraltar (UK) to `la linea de la
concepcion` (3.1km), Bayonne (France) to `urdazubi/urdax` (24.1km), and
Andorra la Vella (Andorra) to `les valls de valira` (15.6km) — 10/10
independently-sourced near-border foreign points tested resolve to SOME
Spanish municipality, none of them raising `UnresolvableGeographyError`.
The M3 population credit makes this measurably worse for a populous
border town (it can win the ranking from up to ~9km farther than plain
nearest-neighbour would reach), but the false claim predates M3 entirely
— a plain 40km nearest-neighbour ceiling was never going to stop this,
since genuine Spanish towns exist well within 40km of literally every
land border Spain has. Actually preventing it would need Spain's real
country-boundary polygon (the same class of fix, and the same vendoring/
dependency cost, as the municipality-containment discussion under
`_POPULATION_WEIGHT_KM` below) — a distance ceiling alone cannot
distinguish "a Spanish town near the border" from "a foreign town near the
border" when both are a few km from the line. Left as a known, now
explicitly documented and tested limitation (see
`TestCrossBorderResolution` in test_geography.py) rather than a false
guarantee nobody had checked.

Issue #177 (Opus review of #169) history, also worth keeping: a denser
gazetteer introduced its own silent failure mode. Plain nearest-neighbour
is population-blind, so a point genuinely inside a big city could resolve
to a smaller neighbouring municipality with a marginally closer centroid —
one that's typically NOT in any connector's own coverage table, so the
scope got silently skipped as "no coverage" one layer below the #169 fix
(real cases: Barcelona's Sant Martí resolving to Sant Adrià de Besòs;
Valencia's Benimaclet resolving to Alboraya). See `_population_credit_km`
and `nearest_place`'s own docstring for the fix (a small population-based
bias on the ranking, not a change to the distance bound).

PR #177 round 3, must-fix 1, also worth keeping: the M3 population-credit
fix above was itself hard-failing every profile pinned exactly on top of
certain real municipalities (poio, ansoain, berriozar, tavernes blanques,
arratzua-ubarrundia among them — a point AT distance 0.0 from a real,
known place, raising `UnresolvableGeographyError` anyway). Cause: the old
`nearest_place` ranked every place by population-adjusted score first and
only checked the distance bound against whichever place won that ranking
— so a farther-away, more populous place could out-score the true (0km)
match, and ITS distance is what got compared to the bound, not the real
match's. `nearest_place` now filters every candidate against the bound
BEFORE ranking (see its own docstring) — a place can no longer be
rejected over a competitor's bound check it never had to pass itself.
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


# Issue #177 (Opus review of #169, M3): plain nearest-neighbour is
# population-blind, so a point genuinely inside a big city (Barcelona,
# Madrid, Valencia — all in every connector's own _CITY_SLUGS/coverage
# table) can resolve to a much smaller, unrelated neighbouring municipality
# that happens to have a marginally closer centroid, and that smaller
# place is typically NOT in any connector's coverage table — the point
# resolves "successfully" to a real gazetteer entry, but scope_key() then
# returns None (that resolved municipality just isn't one this connector
# crawls), and the whole scope is silently skipped as "no coverage",
# exactly the failure mode issue #169 exists to eliminate, just one layer
# deeper. Measured real cases (independently-sourced coordinates, not the
# gazetteer's own): a point at Barcelona's Sant Martí district resolves to
# "sant adria de besos" (pop 34,482) instead of "barcelona" (pop
# 1,620,943); a point at Valencia's Benimaclet neighbourhood resolves to
# "alboraya" (pop 23,228) instead of "valencia" (pop 797,028).
#
# Fix: bias the nearest-neighbour ranking by population, cheaply
# approximating "a bigger city's built-up area extends farther from its
# recorded centroid than a small town's does" without needing real
# municipality-boundary polygons (not available in the vendored gazetteer
# — see geodata/README.md, and see the "containment vs. credit" note
# below for why that remains the structurally correct fix and this
# remains a heuristic standing in for it). `ln(1 + population)` grows
# slowly enough that it only overturns a match when the raw distances are
# close (a few km); it cannot make a genuinely distant big city (e.g.
# Madrid, ~270km away) beat a real nearby small town, since a big city's
# maximum credit here (Madrid, pop 3.2M: ln(1+pop) ≈ 15) is far smaller
# than that kind of gap.
#
# PR #177 round 3 (M3) corrected the calibration comment that used to sit
# here, which was factually wrong: it claimed weight 1.0 "clears all three
# [test] cases with several km of margin" and that changing it "requires
# re-checking all three cases". Measured directly (constraint: `dw - dl <
# w * (ln(1+pop_win) - ln(1+pop_lose))`, solved per pair): Getafe never
# bound anything — it passes at every weight from 0.0 up to ~4.3, because
# Getafe's own centroid is only ~0.2km from itself vs. Madrid's ~12-13km,
# a gap population credit alone can't close until absurdly large. Only
# Sant Martí actually binds a lower bound (needs w ≳ 0.40 — 0.72 in the
# original round-2 estimate using slightly different landmark
# coordinates; both comfortably clear at the value below). The REAL upper
# bound was never Getafe either — it's `tomares` (Sevilla-belt town,
# `TestNearestPlaceReturnsProvince`), which starts losing to Sevilla once
# w exceeds ~1.79. Neither of the two tests whose docstrings claim to
# calibrate this constant was the test actually enforcing its safe window.
#
# Round 3 also tried to close 4 more real cases the review found still
# open (M3 "not closed"): Barcelona's Nou Barris and Sant Andreu districts
# resolving to `santa coloma de gramenet`, Madrid's Barajas district to
# `coslada`, Málaga's Churriana district to `alhaurin de la torre` (this
# review's own independent landmark coordinates; see
# `TestPopulationWeightedResolutionRoundThree` in test_geography.py).
# Solving the same per-pair constraint for these: Nou Barris/Sant Andreu
# need w ≳ 1.22, Barajas needs w ≳ 1.70 — both technically fit UNDER
# Tomares's 1.79 ceiling with little room to spare — but Churriana needs w
# ≳ 2.46 to beat `alhaurin de la torre`, which is mathematically
# impossible without pushing Tomares (and, checked separately, several
# other already-correct small towns) the other way. There is no single
# weight that closes all four without breaking an already-passing,
# independently-verified case — proof, not a hunch, that a global scalar
# credit is maxed out, not merely under-tuned.
#
# That prompted checking whether the credit even generalizes to towns
# nobody had looked at yet, the way the review's own critique of this PR
# warns against ("a heuristic tuned on three points closes three points"):
# a full-gazetteer sweep — every one of the 8,124 municipalities queried
# at its OWN centroid, radius_km=2, does it resolve to itself? — found
# that at the then-shipped w=1.0, 120 small towns within ~2km of a
# slightly bigger neighbour already did NOT resolve to themselves (e.g.
# `benissoda` 0.52km from `albaida` loses to it). That count is monotonic
# in w (0 at w=0.0, 24 at w=0.5, 120 at w=1.0, 244 at w=1.75) — every step
# taken to reach for one more big-city district silently mis-resolves
# more real small towns nobody has independently checked. Weighed against
# that cost, chasing Nou Barris/Sant Andreu/Barajas was not worth roughly
# doubling that collateral count while Churriana remains unreachable
# regardless — so this constant moved DOWN, to the tightest value with
# real margin over the two constraints this module's own tests actually
# rely on (Sant Martí ≳ 0.40, Benimaclet's own bound is looser still),
# cutting the same sweep's failure count from 120 to 24 for no loss of
# passing behaviour. Nou Barris, Sant Andreu, Barajas, and Churriana
# remain genuinely unresolved by this module — see the containment note
# below for the fix that would actually close them without this
# whack-a-mole trade-off, and `TestPopulationWeightedResolutionRoundThree`
# for the tests documenting them as a known, open gap rather than a
# silent one.
#
# Containment vs. credit (PR #177 round 3): the structurally correct
# answer to "which municipality contains this point" is point-in-polygon
# against real municipal boundaries (published by IGN/INE; OSM also
# carries them), not a nearest-weighted-centroid heuristic — a district
# point inside Barcelona's actual boundary would resolve to Barcelona by
# construction, regardless of Santa Coloma's population credit, and
# `benissoda`-style small towns pinned on their own centroid could never
# lose to a neighbour they aren't inside at all. That is a materially
# bigger change than this module's existing scope: it needs a new
# dependency (a point-in-polygon library, e.g. shapely), a new vendored
# boundary dataset this gazetteer does not carry today (the CSV has only
# point centroids, not shapes), a fallback rule for points outside every
# boundary (rural addresses, coastline rounding), and its own test suite —
# not a same-file, same-PR patch. Recorded here rather than attempted
# blind: this constant and its docstring are the load-bearing evidence for
# why a follow-up should do that properly instead of a fourth round of
# retuning this scalar.
_POPULATION_WEIGHT_KM = 0.5


def _population_credit_km(population: int) -> float:
    return _POPULATION_WEIGHT_KM * math.log1p(max(population, 0))


def nearest_place(
    center: tuple[float, float], radius_km: float | None = None
) -> Place | None:
    """Return the nearest (population-weighted) gazetteer entry for `center`,
    or None if too far.

    "Nearest" is not pure haversine distance — see
    `_population_credit_km`'s module-level comment (issue #177, M3): a
    bigger municipality gets a small credit against its raw distance, so a
    point genuinely inside e.g. Barcelona resolves to Barcelona rather than
    to a much smaller neighbouring town whose centroid happens to be
    marginally closer. This selection bias is intentionally small (see the
    same comment) — it changes which of several *nearby* places wins, it
    never reaches out to make a distant big city win over a genuinely
    local match.

    "Too far" means farther than `min(_MAX_MATCH_DISTANCE_KM, radius_km)`
    from a place — that bound is applied to every candidate's real
    haversine distance BEFORE ranking, never loosened by the
    population-adjusted score, so the population bias can change which
    in-bound place wins but can never pull an out-of-bound place into
    contention (PR #177 round 3, must-fix 1 — see below for why this must
    filter first, not rank-then-check).

    `radius_km` (a profile's own search radius, when given) tightens the
    global `_MAX_MATCH_DISTANCE_KM` ceiling rather than replacing it — see
    the module-level constant's docstring, and
    `TestNearestPlaceRadiusBounding` in test_geography.py for the exact
    Getafe/Madrid scenario this guards (also the scenario that bounds how
    large `_POPULATION_WEIGHT_KM` may safely be).

    PR #177 round 3, must-fix 1: this function used to rank ALL 8,248
    places by population-adjusted score FIRST, then check the bound against
    only the winner's distance. That let a place dozens of km away, but
    with enough population credit to out-score everything else, become the
    "winner" checked against the bound — even when a DIFFERENT place sat
    genuinely inside it. Concretely: a point pinned exactly on a real
    municipality's own recorded centroid (distance 0.0 to itself) could
    still lose the ranking to some unrelated, more populous, farther-away
    place, and THAT place's distance (not 0.0) is what got compared to the
    bound -- raising `UnresolvableGeographyError` for a point sitting
    exactly on a known municipality. Measured on the full gazetteer: 150
    such municipalities raised at radius_km=2, 66 at radius_km=3, 4 even at
    radius_km=5 -- zero under plain nearest-neighbour (i.e. entirely
    introduced by the population credit, not a pre-existing gap). Filtering
    every candidate against the bound BEFORE ranking (below) makes this
    structurally impossible: a place cannot lose to a farther-away
    competitor's bound check it was never subjected to, because only
    in-bound places are ranked at all.
    """
    max_distance = _MAX_MATCH_DISTANCE_KM
    if radius_km is not None and radius_km > 0:
        max_distance = min(max_distance, radius_km)

    best: Place | None = None
    best_score = math.inf
    for place in PLACES:
        distance = _haversine_km(center, (place.lat, place.lon))
        if distance > max_distance:
            continue
        score = distance - _population_credit_km(place.population)
        if score < best_score:
            best_score = score
            best = place

    return best


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


UNRESOLVABLE_SCOPE_KEY_PREFIX = "unresolvable-geography:"


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
    return f"{UNRESOLVABLE_SCOPE_KEY_PREFIX}{scope.center}:{scope.radius_km}"


def is_unresolvable_scope_key(scope_key: str | None) -> bool:
    """True if *scope_key* is the `unresolvable_scope_key` sentinel.

    Exists so callers that only hold a key string — the orchestrator's
    breaker-cut classification loop, which never gets to the `discover()`
    call that would raise `UnresolvableGeographyError` — can still tell the
    sentinel apart from a real resolved key. Without it that loop had to
    treat the sentinel as an ordinary key and reported such a scope as a
    budget casualty ("more budget would have helped"), when in fact
    `discover()` raises for it on every run by construction (PR #228 review,
    finding 3).
    """
    return scope_key is not None and scope_key.startswith(UNRESOLVABLE_SCOPE_KEY_PREFIX)
