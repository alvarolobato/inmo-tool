"""Fixture-based tests for the BuildingCenter connector (issue #118).

Detail fixtures are real, live-captured JSON from apifrontend.buildingcenter.es
(trimmed to a couple of images/features per listing rather than the full
18-image/11-feature payload — every FIELD the parsing code reads is real,
unmodified data, not hand-authored). Search-page fixtures are a small,
realistic 2-page reconstruction built from four real captured product
records (two Sevilla-province Viviendas, one Madrid Vivienda, one non-
Viviendas category) rather than the full ~2,100-item national sweep this
connector reads live.

Includes a real-Postgres round-trip test (see vivantial's own test module
docstring for why: PR #138 shipped a connector whose `property_type`
violated a CHECK constraint while every unit test stayed green, because
none of them ever inserted a row).
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.buildingcenter import BuildingCenterConnector, _normalize_text
from etl.connectors.buildingcenter_mapping import (
    extract_energy_rating,
    extract_features,
    extract_full_address,
    extract_operation,
    extract_postal_code,
    extract_price,
    extract_property_type,
    extract_province,
    extract_status,
    parse_coordinate,
)
from etl.connectors.geography import UnresolvableGeographyError

FIXTURES = Path(__file__).parent / "fixtures"

# Sevilla capital's real gazetteer centroid, used for center-based discover()
# tests below.
_SEVILLA_CENTER = (37.3891, -5.9845)


def _fixture_json(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _mock_response(payload: dict, status: int = 200):
    class _R:
        def __init__(self) -> None:
            self._payload = payload
            self.status_code = status

        def raise_for_status(self) -> None:
            return None

        def json(self):
            return self._payload

    return _R()


class TestCoordinateParsing:
    """The gotcha this connector exists to get right: the SAME field, even
    within a single list-scope response, appears in two different string
    formats — not determined by which endpoint you called (module
    docstring). One tolerant parser, not two endpoint-keyed ones."""

    def test_parses_the_plain_sign_prefixed_format(self):
        assert parse_coordinate("+040.2296000") == Decimal("40.2296000")
        assert parse_coordinate("-003.8445600") == Decimal("-3.8445600")

    def test_parses_the_spanish_comma_decimal_format(self):
        assert parse_coordinate("37,423859") == Decimal("37.423859")
        assert parse_coordinate("-5,984684") == Decimal("-5.984684")

    def test_both_formats_seen_on_real_products_in_the_same_search_response(self):
        """60672388 and 60540896 (comma-decimal) sit in the same real
        search page as 00295250 (plain-decimal) — see
        buildingcenter_sample_search_page0.json."""
        page = _fixture_json("buildingcenter_sample_search_page0.json")
        by_code = {p["code"]: p for p in page["products"]}
        assert "," in by_code["60672388"]["latitude"]
        assert "," in by_code["60540896"]["latitude"]
        assert "," not in by_code["00295250"]["latitude"]
        for code in by_code:
            assert parse_coordinate(by_code[code]["latitude"]) is not None

    def test_none_or_empty_yields_none(self):
        assert parse_coordinate(None) is None
        assert parse_coordinate("") is None


class TestFieldExtraction:
    """Values asserted here are the real ones from the live Sevilla listing
    (code 60672388)."""

    def test_extracts_every_field_from_a_real_listing(self):
        detail = _fixture_json("buildingcenter_sample_detail_sevilla.json")
        assert extract_price(detail) == Decimal("81750.0")
        assert extract_status(detail) == "active"
        assert extract_operation(detail) == "sale"
        assert extract_property_type(detail) == "piso"
        assert extract_energy_rating(detail) == "E"
        postal_code = extract_postal_code(detail["address"])
        assert postal_code == "41015"
        assert extract_province(postal_code) == "Sevilla"
        assert extract_full_address(detail) == "ESTURION, 41015, SEVILLA"

    def test_features_are_only_the_active_ones(self):
        """Every feature on the Sevilla fixture is inactive; the overlap
        fixture (60540896) has exactly one active feature ('yard') among
        the same 11 — both real, live-captured shapes."""
        sevilla = _fixture_json("buildingcenter_sample_detail_sevilla.json")
        overlap = _fixture_json("buildingcenter_sample_detail_overlap.json")
        assert extract_features(sevilla) == ()
        assert extract_features(overlap) == ("yard",)

    def test_price_falls_back_to_formatted_value_when_value_is_absent(self):
        """Required fallback-chain proof (issue #118 acceptance criteria):
        primary path `price.value` removed, `price.formattedValue`
        (real value from the Sevilla fixture — the live API renders this
        with a non-breaking space before the currency symbol, this
        fixture uses a plain space; strip_price_punctuation only reads
        digits either way) still yields the correct Decimal."""
        detail = _fixture_json("buildingcenter_sample_detail_sevilla.json")
        detail["price"] = dict(detail["price"])
        del detail["price"]["value"]
        assert "81.750" in detail["price"]["formattedValue"]
        assert extract_price(detail) == Decimal(81750)

    def test_price_is_none_when_both_paths_are_absent(self):
        assert extract_price({}) is None
        assert extract_price({"price": {}}) is None

    def test_no_cadastral_ref_is_fabricated_from_idufir(self):
        """idufir is a real but DIFFERENT Spanish registry identifier — see
        buildingcenter_mapping's module docstring. normalize() must leave
        cadastral_ref unset, never substitute idufir for it.

        The real idufir value ("41024000288425", 14 digits, no letters)
        would already fail base.py's own cadastral-ref format validator
        (20 alphanumeric chars, at least one letter) — which would mask a
        connector-level regression that started passing `idufir` into
        `cadastral_ref`, since the validator would silently swallow it
        either way. This test instead substitutes a value shaped to
        actually PASS that validator, so it verifies this connector's own
        choice not to read `idufir` for that field, not an accident of the
        base class's leniency."""
        connector = BuildingCenterConnector()
        detail = _fixture_json("buildingcenter_sample_detail_sevilla.json")
        detail = dict(detail)
        detail["idufir"] = "4102400028842X5Y0000"  # 20 alphanumeric chars, has a letter
        from etl.connectors.base import RawListing

        raw = RawListing(external_id="60672388", source="buildingcenter", raw=detail)
        listing = connector.normalize(raw)
        assert listing.cadastral_ref is None
        assert listing.raw_extra["idufir"] == "4102400028842X5Y0000"

    def test_status_is_withdrawn_when_not_commercialized(self):
        detail = _fixture_json("buildingcenter_sample_detail_sevilla.json")
        detail = dict(detail)
        detail["commercializedForSale"] = False
        detail["commercializedForRent"] = False
        assert extract_status(detail) == "withdrawn"

    def test_property_type_unrecognised_value_is_none_not_a_guess(self):
        assert extract_property_type({"realStateType": "Suelo urbanizable"}) is None
        assert extract_property_type({}) is None


class TestNormalizeText:
    """scope.geography free text is plain ASCII elsewhere in this codebase
    (e.g. Vivantial's `_CITY_SLUGS` uses "malaga"), but BuildingCenter's own
    `population` field is properly accented ("MÁLAGA"). Both sides must
    normalize the same way or a correctly-spelled filter silently matches
    nothing."""

    def test_strips_accents_and_lowercases(self):
        assert _normalize_text("Málaga") == "malaga"
        assert _normalize_text("SEVILLA") == "sevilla"
        assert _normalize_text("Palacios Y Villafranca (LOS)") == (
            "palacios y villafranca (los)"
        )


class TestDiscover:
    def test_filters_by_category_and_radius_from_a_real_center(self):
        """Sevilla capital, radius=30km: matches the two real category-101
        (Viviendas) products within range (60672388 at ~4km, 60540896 at
        ~26km), excludes the non-Viviendas product (00295250, category 105)
        and the far-away Madrid Vivienda (73239392, ~390km)."""
        connector = BuildingCenterConnector()
        page0 = _mock_response(_fixture_json("buildingcenter_sample_search_page0.json"))
        page1 = _mock_response(_fixture_json("buildingcenter_sample_search_page1.json"))
        with patch(
            "etl.connectors.buildingcenter.requests.get",
            side_effect=[page0, page1],
        ):
            ids = connector.discover(
                ConnectorScope(center=_SEVILLA_CENTER, radius_km=30.0),
                throttle=lambda: None,
            )
        assert ids == ["60540896", "60672388"]

    def test_default_radius_excludes_a_farther_match(self):
        """No radius_km on the scope falls back to this connector's own
        15km default (module docstring) — 60540896 at ~26km falls outside
        it, unlike the explicit radius=30 case above."""
        connector = BuildingCenterConnector()
        page0 = _mock_response(_fixture_json("buildingcenter_sample_search_page0.json"))
        page1 = _mock_response(_fixture_json("buildingcenter_sample_search_page1.json"))
        with patch(
            "etl.connectors.buildingcenter.requests.get",
            side_effect=[page0, page1],
        ):
            ids = connector.discover(
                ConnectorScope(center=_SEVILLA_CENTER), throttle=lambda: None
            )
        assert ids == ["60672388"]

    def test_geography_text_filter_matches_by_population(self):
        connector = BuildingCenterConnector()
        page0 = _mock_response(_fixture_json("buildingcenter_sample_search_page0.json"))
        page1 = _mock_response(_fixture_json("buildingcenter_sample_search_page1.json"))
        with patch(
            "etl.connectors.buildingcenter.requests.get",
            side_effect=[page0, page1],
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert ids == ["73239392"]

    def test_discovered_prices_populated_from_the_search_scope(self):
        connector = BuildingCenterConnector()
        page0 = _mock_response(_fixture_json("buildingcenter_sample_search_page0.json"))
        page1 = _mock_response(_fixture_json("buildingcenter_sample_search_page1.json"))
        with patch(
            "etl.connectors.buildingcenter.requests.get",
            side_effect=[page0, page1],
        ):
            connector.discover(
                ConnectorScope(center=_SEVILLA_CENTER, radius_km=30.0),
                throttle=lambda: None,
            )
        prices = connector.discovered_prices()
        assert prices["60672388"] == Decimal("81750.0")
        assert prices["60540896"] == Decimal("90815.0")

    def test_no_geography_at_all_raises(self):
        connector = BuildingCenterConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_unresolvable_center_raises_not_returns_empty(self):
        """discovers_full_inventory=True — an empty discover() would read
        as mass withdrawal, so an unresolvable scope must raise, never
        silently return []."""
        connector = BuildingCenterConnector()
        with pytest.raises(UnresolvableGeographyError):
            connector.discover(
                ConnectorScope(center=(0.0, 0.0), radius_km=5.0),
                throttle=lambda: None,
            )

    def test_zero_total_results_on_page_zero_raises(self):
        """A structural/API change must not be read as 'catalogue is
        genuinely empty' — this connector claims full inventory."""
        connector = BuildingCenterConnector()
        empty_page = _mock_response(
            {
                "pagination": {
                    "currentPage": 0,
                    "totalPages": 1,
                    "totalResults": 0,
                },
                "products": [],
            }
        )
        with (
            patch(
                "etl.connectors.buildingcenter.requests.get",
                return_value=empty_page,
            ),
            pytest.raises(ConnectorError, match="0 total results"),
        ):
            connector.discover(
                ConnectorScope(center=_SEVILLA_CENTER, radius_km=30.0),
                throttle=lambda: None,
            )

    def test_malformed_response_raises(self):
        connector = BuildingCenterConnector()
        bad_page = _mock_response({"unexpected": "shape"})
        with (
            patch(
                "etl.connectors.buildingcenter.requests.get",
                return_value=bad_page,
            ),
            pytest.raises(ConnectorError, match="API shape may have changed"),
        ):
            connector.discover(
                ConnectorScope(center=_SEVILLA_CENTER, radius_km=30.0),
                throttle=lambda: None,
            )


class TestFetchDetailAndNormalize:
    def test_normalize_produces_a_canonical_listing(self):
        connector = BuildingCenterConnector()
        detail = _fixture_json("buildingcenter_sample_detail_sevilla.json")
        with patch(
            "etl.connectors.buildingcenter.requests.get",
            return_value=_mock_response(detail),
        ):
            raw = connector.fetch_detail("60672388", throttle=lambda: None)
        listing = connector.normalize(raw)

        assert listing.source == "buildingcenter"
        assert listing.external_id == "60672388"
        assert listing.current_price == Decimal("81750.0")
        assert listing.m2_built == Decimal("46.82")
        assert listing.rooms == 3
        assert listing.bathrooms == 1
        assert listing.city == "SEVILLA"
        assert listing.province == "Sevilla"
        assert listing.postal_code == "41015"
        assert listing.operation == "sale"
        assert listing.listing_kind == "agency"
        assert listing.status == "active"
        assert listing.property_type == "piso"
        assert listing.energy_rating == "E"
        assert listing.reference_code == "60672388"
        assert listing.cadastral_ref is None
        assert listing.raw_extra["idufir"] == "41024000288425"

        assert listing.lat == Decimal("37.423859")
        assert listing.lon == Decimal("-5.984684")

        assert (
            listing.url
            == "https://www.buildingcenter.es/es/product/60672388/vivienda-en-sevilla"
        )
        assert listing.photo_urls == (
            "https://apifrontend.buildingcenter.es/medias/CMF-300Wx300H-Default-WorkingFormat-null?context=bWFzdGVyfGltYWdlc3wzNDc0NHxpbWFnZS9qcGVn",
            "https://apifrontend.buildingcenter.es/medias/CMF-1200Wx1200H-Default-WorkingFormat-null?context=bWFzdGVyfGltYWdlc3w0NjE4NjJ8aW1hZ2UvanBlZw",
        )

    def test_fetch_detail_raises_on_code_mismatch(self):
        """A structural change (or a soft-block page shaped like JSON)
        must surface as ConnectorError, not silently ingest the wrong
        listing."""
        connector = BuildingCenterConnector()
        with (
            patch(
                "etl.connectors.buildingcenter.requests.get",
                return_value=_mock_response({"code": "99999999"}),
            ),
            pytest.raises(ConnectorError, match="missing/mismatched"),
        ):
            connector.fetch_detail("60672388", throttle=lambda: None)


class TestPersistsToRealPostgres:
    """A `normalize()`-only assertion cannot catch a value the schema
    rejects (see vivantial's own test module for the PR #138 incident this
    guards against)."""

    def test_normalized_listing_round_trips_through_the_real_schema(self, pg_conn):
        from etl import orchestrator

        sql = (Path(__file__).parent.parent / "schema" / "init.sql").read_text(
            encoding="utf-8"
        )
        with pg_conn.cursor() as cur:
            cur.execute(sql)
        pg_conn.commit()

        connector = BuildingCenterConnector()
        detail = _fixture_json("buildingcenter_sample_detail_overlap.json")
        with patch(
            "etl.connectors.buildingcenter.requests.get",
            return_value=_mock_response(detail),
        ):
            raw = connector.fetch_detail("60540896", throttle=lambda: None)
        canonical = connector.normalize(raw)

        try:
            orchestrator._upsert_canonical_listing(pg_conn, canonical)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT p.property_type, p.lat, p.lon, p.city, p.province, "
                    "       p.postal_code, p.rooms, p.bathrooms, p.features, "
                    "       l.current_price, l.operation, l.status "
                    "  FROM listing l JOIN property p ON p.id = l.property_id "
                    " WHERE l.source = %s AND l.external_id = %s",
                    ("buildingcenter", "60540896"),
                )
                row = cur.fetchone()

            assert row is not None, "listing did not persist"
            (
                property_type,
                lat,
                lon,
                city,
                province,
                postal_code,
                rooms,
                bathrooms,
                features,
                current_price,
                operation,
                status,
            ) = row
            assert property_type == "piso"
            assert lat == Decimal("37.159100")
            assert lon == Decimal("-5.918187")
            assert city == "PALACIOS Y VILLAFRANCA (LOS)"
            assert province == "Sevilla"
            assert postal_code == "41720"
            assert rooms == 3
            assert bathrooms == 2
            assert "yard" in features
            assert current_price == Decimal("90815.00")
            assert operation == "sale"
            assert status == "active"
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM listing_status_event WHERE listing_id IN "
                    "(SELECT id FROM listing WHERE source = 'buildingcenter')"
                )
                cur.execute(
                    "DELETE FROM listing_price_history WHERE listing_id IN "
                    "(SELECT id FROM listing WHERE source = 'buildingcenter')"
                )
                cur.execute(
                    "CREATE TEMP TABLE _bc_props ON COMMIT DROP AS "
                    "SELECT property_id FROM listing WHERE source = 'buildingcenter'"
                )
                cur.execute("DELETE FROM listing WHERE source = 'buildingcenter'")
                cur.execute(
                    "DELETE FROM property WHERE id IN "
                    "(SELECT property_id FROM _bc_props)"
                )
            pg_conn.commit()


class TestRegistration:
    def test_registered_and_claims_full_inventory(self):
        from etl.connectors import register_all
        from etl.orchestrator import CONNECTORS

        register_all()
        matches = [c for c in CONNECTORS if c.name == "buildingcenter"]
        assert len(matches) == 1
        connector = matches[0]
        assert connector.discovers_full_inventory is True
        assert connector.supports_discovery is True

    def test_registration_is_idempotent(self):
        from etl.connectors import register_all
        from etl.orchestrator import CONNECTORS

        register_all()
        register_all()
        matches = [c for c in CONNECTORS if c.name == "buildingcenter"]
        assert len(matches) == 1
