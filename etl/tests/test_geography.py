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
        # Roughly between Valencia and Barcelona but closer to Valencia.
        assert nearest_city((39.6, 0.0)) == "valencia"
