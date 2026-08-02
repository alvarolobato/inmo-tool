"""Signal 2: address + coordinates + size proximity (issue #16 item 2).

Requires *coordinates* within ~15m and m2_built within ~5% to fire at all.
Both this project's connectors *can* extract precise lat/lon when a listing
publishes them (`realEstate.coordinates` in etl/connectors/fotocasa.py,
`location.geolocation` in milanuncios.py) — but a live sweep during this
task's development found zero real (non-fixture) listings from either site
with non-null coordinates among the ones actually sampled, so in practice
this signal should be expected to fire rarely against this project's real
data, not never. Its thresholds are reused by phone_extract.py as the
*strict* half of "corroboration" when coordinates do happen to be present.
"""

from __future__ import annotations

import math
from decimal import Decimal

from etl.dedup.types import ListingRecord, PairEvaluation

_MAX_DISTANCE_METERS = 15.0
_MAX_SIZE_RATIO = Decimal("0.05")
_EARTH_RADIUS_METERS = 6_371_000.0


def haversine_meters(
    lat1: Decimal, lon1: Decimal, lat2: Decimal, lon2: Decimal
) -> float:
    """Great-circle distance between two lat/lon points, in meters."""
    phi1, phi2 = math.radians(float(lat1)), math.radians(float(lat2))
    d_phi = math.radians(float(lat2) - float(lat1))
    d_lambda = math.radians(float(lon2) - float(lon1))
    hav = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_METERS * math.asin(math.sqrt(hav))


def sizes_close(a_m2: Decimal | None, b_m2: Decimal | None, tolerance: Decimal) -> bool:
    """True when both sizes are present and within `tolerance` of each other."""
    if a_m2 is None or b_m2 is None or a_m2 <= 0 or b_m2 <= 0:
        return False
    ratio = abs(a_m2 - b_m2) / max(a_m2, b_m2)
    return ratio <= tolerance


def coords_close(
    a_lat: Decimal | None,
    a_lon: Decimal | None,
    b_lat: Decimal | None,
    b_lon: Decimal | None,
    max_meters: float = _MAX_DISTANCE_METERS,
) -> bool:
    """True when both coordinate pairs are present and within max_meters."""
    if a_lat is None or a_lon is None or b_lat is None or b_lon is None:
        return False
    return haversine_meters(a_lat, a_lon, b_lat, b_lon) <= max_meters


def evaluate(a: ListingRecord, b: ListingRecord) -> PairEvaluation | None:
    if coords_close(a.lat, a.lon, b.lat, b.lon) and sizes_close(
        a.m2_built, b.m2_built, _MAX_SIZE_RATIO
    ):
        return PairEvaluation(
            basis="address_coords", confidence=Decimal("0.900"), decision="merge"
        )
    return None
