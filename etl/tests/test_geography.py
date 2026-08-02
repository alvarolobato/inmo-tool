"""Unit tests for etl.connectors.geography.nearest_city (issue #71)."""

from __future__ import annotations

from etl.connectors.geography import nearest_city


class TestNearestCity:
    def test_exact_centroid_matches_its_own_city(self):
        assert nearest_city((37.3891, -5.9845)) == "sevilla"

    def test_a_few_km_off_still_resolves_to_the_right_city(self):
        # ~2km north of Sevilla's centroid — well within a search profile's
        # radius being centered slightly off the exact city-center point.
        assert nearest_city((37.407, -5.9845)) == "sevilla"

    def test_far_from_every_known_city_returns_none(self):
        # Lisbon — nowhere near any of the currently-known Spanish centroids.
        assert nearest_city((38.7223, -9.1393)) is None

    def test_picks_the_actually_nearest_city_not_just_the_first_in_the_dict(self):
        # Roughly between Valencia and Barcelona but closer to Valencia
        # (~35km away — no coincidence with _MAX_MATCH_DISTANCE_KM's 40km
        # default ceiling; this test is about "nearest of two candidates",
        # not the ceiling itself, so it passes a generous explicit
        # radius_km rather than relying on the no-radius default staying
        # above 35km forever).
        assert nearest_city((39.6, 0.0), radius_km=100) == "valencia"


class TestNearestCityRadiusBounding:
    """Issue #71 review finding: a profile's own radius_km must tighten the
    match, not just the fixed _MAX_MATCH_DISTANCE_KM ceiling — otherwise a
    profile centered on a small town near a known city (e.g. Getafe, ~13km
    from Madrid) with a genuinely tight search radius silently gets matched
    to the wrong, much larger city."""

    # ~13km south of Madrid's centroid (40.4168, -3.7038) — roughly Getafe's
    # real-world distance from central Madrid.
    _NEAR_MADRID_BUT_NOT_MADRID = (40.305, -3.7038)

    def test_wide_radius_still_matches_the_nearby_known_city(self):
        assert nearest_city(self._NEAR_MADRID_BUT_NOT_MADRID, radius_km=20) == "madrid"

    def test_tight_radius_refuses_to_match_a_city_outside_it(self):
        # radius_km=5 is well short of the ~13km to Madrid's centroid — a
        # profile this tightly scoped means "just this specific area", not
        # "the wider metro region", and must not silently fall back to
        # Madrid's connector coverage.
        assert nearest_city(self._NEAR_MADRID_BUT_NOT_MADRID, radius_km=5) is None

    def test_no_radius_given_falls_back_to_the_fixed_ceiling(self):
        # radius_km=None (or omitted) preserves pre-#71-hardening behavior
        # for callers with no real profile radius to hand — the fixed 40km
        # ceiling alone decides the match.
        assert nearest_city(self._NEAR_MADRID_BUT_NOT_MADRID) == "madrid"

    def test_non_positive_radius_is_ignored_not_treated_as_zero_tolerance(self):
        # A malformed/zero radius shouldn't make every match impossible —
        # fall back to the ceiling exactly like radius_km=None.
        assert nearest_city(self._NEAR_MADRID_BUT_NOT_MADRID, radius_km=0) == "madrid"
