"""Unit tests for etl.connectors.geography (issue #71, expanded #169).

Issue #169 replaced the old 4-entry `CITY_CENTROIDS` dict with a vendored
~8,248-municipality gazetteer (etl/connectors/geodata/es_places.csv). Some
of the original tests below encoded assumptions that only held because the
gazetteer was tiny (e.g. "the Getafe test point resolves to Madrid" — true
only because Getafe itself wasn't a known place; with a real gazetteer it
correctly resolves to Getafe, its own entry). Updated accordingly, with the
reasoning kept inline so nobody mistakes these updates for silently
loosening what's being tested.
"""

from __future__ import annotations

import pytest

from etl.connectors.base import ConnectorScope
from etl.connectors.geography import (
    Place,
    UnresolvableGeographyError,
    nearest_city,
    nearest_place,
    resolve_place,
    unresolvable_scope_key,
)


class TestNearestCity:
    def test_exact_centroid_matches_its_own_city(self):
        assert nearest_city((37.3891, -5.9845)) == "sevilla"

    def test_a_few_km_off_still_resolves_to_the_right_city(self):
        # ~2km north of Sevilla's centroid — well within a search profile's
        # radius being centered slightly off the exact city-center point.
        assert nearest_city((37.407, -5.9845)) == "sevilla"

    def test_far_from_every_known_city_returns_none(self):
        # Lisbon — nowhere near any Spanish municipality, even against the
        # full ~8,248-place gazetteer (issue #169) rather than the original
        # 4-entry table. Confirms expanding coverage didn't also expand the
        # match radius into a neighbouring country.
        assert nearest_city((38.7223, -9.1393)) is None

    def test_picks_the_actually_nearest_place_not_a_bigger_far_one(self):
        # Roughly between Valencia city and Barcelona. Under the old
        # 4-centroid table this matched "valencia" (the nearest of only 4
        # candidates); with the real gazetteer (issue #169) a smaller,
        # genuinely closer coastal municipality wins instead — which is the
        # *correct* behaviour a real gazetteer is supposed to produce, not
        # a regression. This test now asserts the property that matters
        # ("nearest, not first/biggest"), not a specific place name that
        # would be an artifact of exactly which small towns GeoNames
        # happens to carry.
        place = nearest_place((39.6, 0.0), radius_km=100)
        assert place is not None
        assert place.province == "Valencia"
        assert place.name != "barcelona"


class TestNearestPlaceReturnsProvince:
    """Issue #169: some connectors (Solvia's provincia/municipio path,
    Servihabitat's per-province sitemap) need the resolved place's province,
    not just its municipality name."""

    def test_costa_del_sol_towns_resolve_to_malaga_province(self):
        # The owner's stated v1 markets (issue #169 course-correction) —
        # verified end-to-end against real connector responses in the PR,
        # this test only checks the gazetteer resolution step.
        for name, coords in {
            "malaga": (36.75854, -4.39717),
            "marbella": (36.51443, -4.88604),
            "estepona": (36.44543, -5.12739),
            "fuengirola": (36.55815, -4.61475),
            "torremolinos": (36.62387, -4.50458),
            "benalmadena": (36.58975, -4.54213),
            "mijas": (36.53507, -4.67355),
        }.items():
            place = nearest_place(coords)
            assert place is not None, f"{name} did not resolve to any place"
            assert place.name == name
            assert place.province == "Malaga"

    def test_sevilla_metro_belt_resolves_to_sevilla_province(self):
        for name, coords in {
            "sevilla": (37.39141, -5.95918),
            "dos hermanas": (37.25217, -5.95985),
            "alcala de guadaira": (37.27456, -5.81642),
            "tomares": (37.3727, -6.04372),
        }.items():
            place = nearest_place(coords)
            assert place is not None, f"{name} did not resolve to any place"
            assert place.name == name
            assert place.province == "Sevilla"


class TestNearestCityRadiusBounding:
    """Issue #71 review finding: a profile's own radius_km must tighten the
    match, not just the fixed _MAX_MATCH_DISTANCE_KM ceiling. Issue #169
    note: with the expanded gazetteer, the point this test uses (~13km south
    of Madrid, roughly Getafe's real-world offset) now resolves to Getafe
    ITSELF at every radius, because Getafe is a real gazetteer entry now —
    which is exactly the outcome this whole test class exists to want
    ("don't misattribute a nearby town to a bigger neighbour"). The
    surviving, still-meaningful assertion is that a small radius does not
    reach all the way to the much-more-distant Madrid centroid, tested with
    a point that genuinely has no gazetteer entry of its own nearby.
    """

    # Open countryside roughly equidistant between small villages, tuned to
    # be within the old 40km ceiling of Madrid's centroid (40.4168,
    # -3.7038) but not within a tight radius of any single known place.
    _REMOTE_COUNTRYSIDE_NEAR_MADRID = (40.05, -3.95)

    def test_wide_radius_reaches_a_known_place(self):
        # A wide-enough radius (30km) does reach at least the nearest real
        # gazetteer entry from this remote point.
        assert (
            nearest_city(self._REMOTE_COUNTRYSIDE_NEAR_MADRID, radius_km=30) is not None
        )

    def test_tight_radius_refuses_to_match_anything_far_away(self):
        # 1km is tighter than the distance to literally every gazetteer
        # entry from this deliberately-chosen empty-countryside point.
        assert nearest_city(self._REMOTE_COUNTRYSIDE_NEAR_MADRID, radius_km=1) is None

    def test_getafe_resolves_to_itself_not_to_madrid(self):
        # The scenario the pre-#169 version of this test was actually
        # guarding against ("don't misattribute Getafe to Madrid just
        # because Madrid is within the fixed ceiling"): with a real
        # gazetteer, Getafe resolves to Getafe, correctly, regardless of
        # radius — there is no longer a "which of two named cities does
        # this ambiguous point belong to" question at all.
        near_getafe = (40.305, -3.7038)
        for radius_km in (None, 0, 5, 20):
            place = nearest_place(near_getafe, radius_km=radius_km)
            assert place is not None
            assert place.name == "getafe", (
                f"radius_km={radius_km}: expected getafe, got {place}"
            )

    def test_non_positive_radius_is_ignored_not_treated_as_zero_tolerance(self):
        # A malformed/zero radius shouldn't make every match impossible —
        # fall back to the ceiling alone, same as radius_km=None.
        assert nearest_city(
            self._REMOTE_COUNTRYSIDE_NEAR_MADRID, radius_km=0
        ) == nearest_city(self._REMOTE_COUNTRYSIDE_NEAR_MADRID)


class TestResolvePlace:
    """Issue #169: `resolve_place` is the shared, must-not-be-silent half of
    every connector's `_resolve_geography`."""

    def test_none_center_resolves_to_none_not_a_failure(self):
        # Nothing to resolve at all — a legitimate no-op, matching
        # scope_key()'s "None means no coverage" contract in base.py.
        scope = ConnectorScope(center=None)
        assert resolve_place(scope) is None

    def test_known_center_resolves_to_a_place(self):
        scope = ConnectorScope(center=(36.51543, -4.88583), radius_km=10)  # Marbella
        place = resolve_place(scope)
        assert isinstance(place, Place)
        assert place.name == "marbella"

    def test_unresolvable_center_raises_not_returns_none(self):
        # Lisbon: a real center point, but not a place resolve_place can
        # identify. This is the core issue #169 fix — this must RAISE, not
        # silently return None the way every connector's discover() used to
        # treat identically to "zero listings found here".
        scope = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        with pytest.raises(UnresolvableGeographyError):
            resolve_place(scope)


class TestUnresolvableScopeKey:
    def test_never_none_and_never_collides_with_a_real_key(self):
        scope = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        key = unresolvable_scope_key(scope)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_same_scope_produces_the_same_key(self):
        # Two profiles resolving to the identical unresolvable scope should
        # still dedupe against each other in the orchestrator's
        # seen_scope_keys tracking, same as any other scope_key.
        scope_a = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        scope_b = ConnectorScope(center=(38.7223, -9.1393), radius_km=10)
        assert unresolvable_scope_key(scope_a) == unresolvable_scope_key(scope_b)
