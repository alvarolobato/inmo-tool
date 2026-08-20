"""Signal 2: address + coordinates + size proximity (issue #16 item 2).

Requires normalized-address similarity, coordinates within ~15m, AND
m2_built within ~5% to fire at all — all three, not just the latter two.
Coordinates alone (even tight ones) are a building-level signal, not a
unit-level one: two genuinely different flats in the same building can
easily land within 15m of each other (many sites geocode to the building
entrance) and within 5% of a shared size band by coincidence. Requiring the
address text to actually agree too (reusing fuzzy.normalize_address, the
same normalization signal 5 uses) closes that false-positive path — this is
the strongest auto-merge signal issue #16 defines; it shouldn't fire on
proximity alone.

Both this project's connectors *can* extract precise lat/lon when a listing
publishes them (`realEstate.coordinates` in etl/connectors/fotocasa.py,
`location.geolocation` in milanuncios.py) — but a live sweep during this
task's development found zero real (non-fixture) listings from either site
with non-null coordinates among the ones actually sampled, so in practice
this signal should be expected to fire rarely against this project's real
data, not never. Its coordinate/size thresholds (not the address-text
requirement added here) are reused by phone_extract.py as the *strict* half
of "corroboration" when coordinates do happen to be present.

Practical consequence of the address-text requirement worth knowing: this
project's two connectors publish address text at very different
granularity — Fotocasa includes neighborhood/district
(`realEstate.address.upperLevel`/`district`), Milanuncios only ever
publishes city/province (see milanuncios.py's address-assembly comment).
Two listings of the *same* property from these two specific sites will
rarely score high enough on address-text similarity for this signal to fire
between them, even with matching coordinates — phone_extract (which doesn't
require address agreement, just coordinate/size *or* price/size proximity
as corroboration) is the realistic cross-connector auto-merge path today.
That's an acceptable trade: a signal that fires less often but doesn't
false-positive beats one that fires more often and sometimes merges two
different flats in the same building.
"""

from __future__ import annotations

import math
from decimal import Decimal

from rapidfuzz import fuzz

from etl.dedup.signals.floor import floors_conflict
from etl.dedup.signals.fuzzy import normalize_address
from etl.dedup.types import ListingRecord, PairEvaluation

# Re-exported so phone_extract.py and reference_code.py can keep importing
# every shared proximity/corroboration primitive from this one module
# (`from etl.dedup.signals.address_coords import coords_close, prices_close,
# sizes_close, floors_conflict`), the same pattern already used for the
# other three — rather than half from here and half from etl.dedup.signals.floor.
__all__ = [
    "addresses_close",
    "coords_close",
    "evaluate",
    "floors_conflict",
    "haversine_meters",
    "prices_close",
    "sizes_close",
    "sizes_equal",
]

_MAX_DISTANCE_METERS = 15.0
_MAX_SIZE_RATIO = Decimal("0.05")
_MIN_ADDRESS_SIMILARITY = 0.80
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


def sizes_equal(a_m2: Decimal | None, b_m2: Decimal | None) -> bool:
    """True when both sizes are present and EXACTLY equal — no tolerance band.

    Issue #602/D-137: the photo_hash exact-photo-match auto-merge path used
    to corroborate with `sizes_close(..., 5%)`. Replaying candidate rules
    against 68 hand-reviewed photo_hash pairs (49 merged, 19 rejected) found
    m2_built is the actual discriminator, not a proximity band — all 49
    merges had identical m2_built; none of the 19 rejections did. A 5% band
    is exactly what let a same-building-different-unit false merge through.
    See D-137 for the full measurement.

    Same missing-value discipline as `sizes_close`/`prices_close`: absence
    or a non-positive value on either side is never a match, never a
    permissive default.
    """
    if a_m2 is None or b_m2 is None or a_m2 <= 0 or b_m2 <= 0:
        return False
    return a_m2 == b_m2


def prices_close(a: Decimal | None, b: Decimal | None, tolerance: Decimal) -> bool:
    """True when both prices are present and within `tolerance` of each other.

    Shared by phone_extract.py and reference_code.py's corroboration
    fallback (price+size proximity when coordinates aren't available on
    both sides) — moved here rather than duplicated or imported as a
    private symbol across sibling signal modules.
    """
    if a is None or b is None or a <= 0 or b <= 0:
        return False
    return abs(a - b) / max(a, b) <= tolerance


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


def addresses_close(
    a_address: str | None,
    b_address: str | None,
    min_similarity: float = _MIN_ADDRESS_SIMILARITY,
) -> bool:
    """True when both addresses are present and their normalized text agrees.

    Absence on either side returns False (not True) — a missing address is
    not evidence of a match; it just means this conjunct can't be
    evaluated, so the pair falls through to a weaker signal instead of
    auto-merging on coordinates/size alone.
    """
    if not a_address or not b_address:
        return False
    similarity = (
        fuzz.token_sort_ratio(
            normalize_address(a_address), normalize_address(b_address)
        )
        / 100
    )
    return similarity >= min_similarity


def evaluate(a: ListingRecord, b: ListingRecord) -> PairEvaluation | None:
    if (
        coords_close(a.lat, a.lon, b.lat, b.lon)
        and sizes_close(a.m2_built, b.m2_built, _MAX_SIZE_RATIO)
        and addresses_close(a.address, b.address)
        # Issue #186: floor as an additional required corroborating
        # condition. Coordinates+size+address alone can't tell two units in
        # the same building apart (see this module's own docstring on why
        # coords are a building-level signal) — a floor that's present on
        # both sides and disagrees is direct evidence these are different
        # units, so it vetoes the merge even though the other three
        # conditions are satisfied. Floor missing on either side falls
        # through permissively (floors_conflict returns False), same as
        # every other "can't corroborate, don't block" case in this engine.
        and not floors_conflict(a.floor, b.floor)
    ):
        return PairEvaluation(
            basis="address_coords", confidence=Decimal("0.900"), decision="merge"
        )
    return None
