"""Direct unit tests for etl.dedup.signals.municipality's pure helpers
(issue #568, D-118). End-to-end engine-level veto coverage lives in
test_dedup_engine.py's TestMunicipalityConflictVeto — this file only
covers `normalize_city`/`municipality_conflict` in isolation, mirroring
test_dedup_signals_structured_fields.py's split between direct and
engine-level tests.
"""

from __future__ import annotations

import pytest

from etl.dedup.signals.municipality import municipality_conflict, normalize_city
from etl.dedup.types import ListingRecord


def _record(**overrides) -> ListingRecord:
    defaults = {
        "listing_id": 1,
        "property_id": 1,
        "source": "fotocasa",
        "external_id": "1",
        "listing_kind": None,
        "description": None,
        "photo_urls": (),
        "cadastral_ref": None,
        "address": None,
        "lat": None,
        "lon": None,
        "m2_built": None,
        "current_price": None,
        "contact_raw": None,
        "reference_code": None,
        "floor": None,
        "city": None,
    }
    defaults.update(overrides)
    return ListingRecord(**defaults)


class TestNormalizeCity:
    def test_none_and_blank_return_none(self):
        assert normalize_city(None) is None
        assert normalize_city("") is None
        assert normalize_city("   ") is None

    # Issue #568's own real ground-truth pairs — the exact strings found
    # in the live DB's pending fuzzy backlog.
    @pytest.mark.parametrize(
        "raw_a,raw_b",
        [
            ("sevilla capital", "sevilla"),
            ("Sevilla Capital", "Sevilla"),
            ("málaga", "málaga capital"),
            ("Málaga", "Málaga Capital"),
            ("málaga", "malaga"),  # accent-only difference
            ("Málaga", "Malaga"),
            ("Madrid Capital", "Madrid"),
        ],
    )
    def test_same_municipality_written_differently_normalizes_equal(self, raw_a, raw_b):
        assert normalize_city(raw_a) == normalize_city(raw_b)

    def test_servihabitat_no_space_slug_normalizes_equal_to_spaced_form(self):
        # Real merge evidence (property_merge_log ids 388/513/514/515,
        # all photo_hash) pairs exactly this shape — see
        # etl.dedup.signals.municipality's module docstring.
        assert normalize_city("sanjuandeaznalfarache") == normalize_city(
            "San Juan de Aznalfarache"
        )
        assert normalize_city("doshermanas") == normalize_city("Dos Hermanas")

    @pytest.mark.parametrize(
        "raw_a,raw_b",
        [
            ("Málaga", "Sevilla"),
            ("Madrid", "Sevilla"),
            ("Madrid", "Málaga"),
            ("Camas", "Sevilla"),
            ("Sevilla", "Dos Hermanas"),
            ("Almensilla", "Sevilla"),
        ],
    )
    def test_genuinely_different_municipalities_normalize_unequal(self, raw_a, raw_b):
        assert normalize_city(raw_a) != normalize_city(raw_b)

    def test_district_of_dos_hermanas_normalizes_to_dos_hermanas(self):
        # Issue #568's own named example: Montequinto is a district of Dos
        # Hermanas (Sevilla), not an independent municipality.
        assert normalize_city("Montequinto") == normalize_city("Dos Hermanas")
        assert normalize_city("Montequinto") == normalize_city("doshermanas")

    def test_district_of_malaga_normalizes_to_malaga(self):
        # Corroborated by a real photo_hash merge (property 6953) — see
        # the module docstring.
        assert normalize_city("Churriana") == normalize_city("Málaga")

    @pytest.mark.parametrize(
        "district_slug",
        [
            "madcanillejas",
            "madcarabanchel",
            "madciudadlineal",
            "madhortaleza",
            "madlalatina",
            "madmoncloa_aravaca",
            "madpuentedevallecas",
            "madtetuan_cuatrocaminos",
            "madusera",
            "madvicalvaro",
            "madvilladevallecas",
            "madvillaverde",
        ],
    )
    def test_servihabitat_madrid_district_slugs_normalize_to_madrid(
        self, district_slug
    ):
        assert normalize_city(district_slug) == normalize_city("Madrid")
        assert normalize_city(district_slug) == normalize_city("Madrid Capital")

    def test_real_but_unrelated_villaverde_municipality_is_not_aliased(self):
        # Villaverde del Río / Villaverde de Guadalimar are real, distinct
        # municipalities near Sevilla — must NOT collapse onto Madrid just
        # because the servihabitat Madrid-district alias table also
        # contains "madvillaverde". Exact-match aliasing only.
        assert normalize_city("Villaverde del Río") != normalize_city("Madrid")
        assert normalize_city("villaverdedelrio") != normalize_city("madrid")


class TestMunicipalityConflict:
    def test_missing_city_on_either_side_never_conflicts(self):
        a = _record(city=None)
        b = _record(city="Sevilla")
        assert municipality_conflict(a, b) is False
        assert municipality_conflict(b, a) is False

    def test_same_municipality_written_differently_does_not_conflict(self):
        a = _record(city="Sevilla Capital")
        b = _record(city="Sevilla")
        assert municipality_conflict(a, b) is False

        a = _record(city="málaga")
        b = _record(city="malaga")
        assert municipality_conflict(a, b) is False

    def test_district_does_not_conflict_with_its_municipality(self):
        a = _record(city="Montequinto")
        b = _record(city="Dos Hermanas")
        assert municipality_conflict(a, b) is False

        a = _record(city="Churriana")
        b = _record(city="Málaga")
        assert municipality_conflict(a, b) is False

    def test_genuinely_different_municipality_conflicts(self):
        a = _record(city="Málaga")
        b = _record(city="Sevilla")
        assert municipality_conflict(a, b) is True
        assert municipality_conflict(b, a) is True
