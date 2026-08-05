"""Diglo connector tests (issue #117).

Fixtures are trimmed from real pages/sitemap captured live 2026-08-05, not
synthesised from imagination — including the "inmuebles similares" neighbour
card, which is load-bearing for the carousel-isolation regression in
TestCarouselIsolation (same class of bug PR #139/#141 hit on Vivantial and
Servihabitat). No test makes a network call: the HTTP layer is monkeypatched.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.diglo import (
    DigloConnector,
    extract_drupal_settings,
    extract_utag_data,
)
from etl.connectors.diglo_mapping import (
    is_refcode,
    is_residential,
    map_property_type,
    parse_listing_path,
    province_slug,
)
from etl.orchestrator import _upsert_canonical_listing

FIXTURES = Path(__file__).parent / "fixtures"
_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

SUBJECT_ID = "venta-pisos/madrid/madrid/efe0000200053"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _mock_response(text: str):
    class _R:
        def __init__(self, t: str) -> None:
            self.text = t

        def raise_for_status(self) -> None:
            return None

    return _R(text)


def _normalize_fixture(external_id: str = SUBJECT_ID):
    connector = DigloConnector()
    with patch(
        "etl.connectors.diglo.requests.get",
        return_value=_mock_response(_read("diglo_sample_detail.html")),
    ):
        raw = connector.fetch_detail(external_id, throttle=lambda: None)
    return connector.normalize(raw)


class TestNormalize:
    def test_matches_the_real_listing_values(self):
        """Values cross-checked against the live page for ref EFE0000200053."""
        n = _normalize_fixture()
        # Price/city/province/type come from the page's own utag_data blob,
        # not the .listing-info carousel.
        assert n.current_price == Decimal("308000.00")
        assert n.reference_code == "EFE0000200053"
        assert n.city == "Madrid"
        assert n.province == "Madrid"
        assert n.property_type == "piso"
        assert n.operation == "sale"
        assert n.address == "VIV CALLE MENDIVIL, 44 - BAJO 1"
        # Santander servicer selling bank-owned stock — never a private
        # seller. Load-bearing for issue #16's phone-corroboration rule.
        assert n.listing_kind == "agency"
        assert n.status == "active"

    def test_surface_split_built_and_useful(self):
        """The description gives both figures: "78,30 m² (51,67 m² útiles)"."""
        n = _normalize_fixture()
        assert n.m2_built == Decimal(78)
        assert n.m2_useful == Decimal(51)

    def test_rooms_and_baths_from_subject_summary(self):
        n = _normalize_fixture()
        assert n.rooms == 2
        assert n.bathrooms == 1

    def test_coordinates_from_drupal_settings(self):
        """Diglo is the first REO connector in the batch to publish lat/lon
        (drupalSettings.yera_producto_lat/lon) — enables issue #16's
        address_coords dedup signal for a servicer source."""
        n = _normalize_fixture()
        assert n.lat == Decimal("40.3993774335")
        assert n.lon == Decimal("-3.6635205596738")

    def test_fields_this_site_does_not_publish_stay_none(self):
        """Asserted rather than left silent (issue #132 checklist): if the
        site ever starts publishing these, this test fails and prompts an
        update."""
        n = _normalize_fixture()
        # Only 5-digit code on the page is Santander's HQ, not the asset's.
        assert n.postal_code is None
        # No referencia catastral (like Servihabitat/Vivantial, unlike Solvia).
        assert n.cadastral_ref is None
        assert n.energy_rating is None


class TestCarouselIsolation:
    """The bug this connector would otherwise have shipped.

    The detail page renders an "inmuebles similares" carousel whose
    .listing-info cards carry their OWN price/m²/rooms/baths. The real page
    for EFE0000200053 (308.000 €, 78 m², 2 hab) contains a neighbour card
    reading "385.000 € ... 91 m² 3 Hab. 2 Baño/s" (ref EFE0000200055). A blob
    scan over page text/photos would attribute the neighbour's figures/images
    to the subject.
    """

    def test_subject_values_win_over_the_neighbour_card(self):
        html = _read("diglo_sample_detail.html")
        assert "385.000" in html and "91 m" in html, (
            "fixture must retain a neighbour card or this regression is retired"
        )
        n = _normalize_fixture()
        assert n.current_price == Decimal("308000.00"), "read the neighbour's price"
        assert n.m2_built == Decimal(78), "read the neighbour's 91 m²"
        assert n.rooms == 2, "read the neighbour's 3 rooms"
        assert n.bathrooms == 1, "read the neighbour's 2 baths"

    def test_photos_are_scoped_to_the_subject_refcode(self):
        """Photos are filtered by the subject refcode in the CDN path, so the
        neighbour's EFE0000200055 images never attach to the subject."""
        n = _normalize_fixture()
        assert n.photo_urls, "subject has photos"
        assert all("EFE0000200053" in u for u in n.photo_urls)
        assert not any("EFE0000200055" in u for u in n.photo_urls)


class TestFallbackChain:
    def test_price_falls_back_to_subject_summary_when_utag_absent(self):
        """Proves the fallback is real, not dead code: strip the primary
        (utag_data) source and the price must still resolve from the subject's
        .product-print-sheet block — NOT from the carousel's 385.000 €."""
        import re

        html = _read("diglo_sample_detail.html")
        # Remove both utag_data assignments.
        without_utag = re.sub(
            r"window\.utag_data\s*=\s*\{.*?\}\s*;", "", html, flags=re.DOTALL
        )
        assert extract_utag_data(without_utag) == {}
        connector = DigloConnector()
        with patch(
            "etl.connectors.diglo.requests.get",
            return_value=_mock_response(without_utag),
        ):
            raw = connector.fetch_detail(SUBJECT_ID, throttle=lambda: None)
        n = connector.normalize(raw)
        assert n.current_price == Decimal(308000)
        # reference_code falls back to the uppercased URL refcode.
        assert n.reference_code == "EFE0000200053"


class TestExtractors:
    def test_extract_utag_prefers_populated_over_empty_placeholder(self):
        """The page has an empty `{}` utag_data first, then the real one —
        the extractor must return the populated one regardless of order."""
        utag = extract_utag_data(_read("diglo_sample_detail.html"))
        assert utag["item_id"] == "EFE0000200053"
        assert utag["property_price"] == "308000.00"

    def test_extract_drupal_settings(self):
        drupal = extract_drupal_settings(_read("diglo_sample_detail.html"))
        assert drupal["node_id"] == "43431"
        assert drupal["yera_producto_lat"] == "40.3993774335"


class TestDiscover:
    def test_filters_sitemap_to_residential_in_scope_province(self):
        connector = DigloConnector()
        with patch(
            "etl.connectors.diglo.requests.get",
            return_value=_mock_response(_read("diglo_sample_sitemap.xml")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        # Two Madrid residential (piso + casa); the Huelva casa is out of
        # scope, the garaje/local are non-residential, and the two
        # category/facet URLs have no refcode — all dropped.
        assert ids == sorted(
            [
                "venta-pisos/madrid/madrid/efe0000200053",
                "venta-casas/chalets-adosados/madrid/villaviciosa-odon/ib00100025555",
            ]
        )

    def test_out_of_province_and_nonresidential_excluded(self):
        connector = DigloConnector()
        with patch(
            "etl.connectors.diglo.requests.get",
            return_value=_mock_response(_read("diglo_sample_sitemap.xml")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert not any("huelva" in i for i in ids)
        assert not any("garaje" in i or "local" in i for i in ids)

    def test_scope_resolves_a_different_province(self):
        connector = DigloConnector()
        with patch(
            "etl.connectors.diglo.requests.get",
            return_value=_mock_response(_read("diglo_sample_sitemap.xml")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="huelva"), throttle=lambda: None
            )
        assert ids == ["venta-casas/casas-rurales/huelva/almonte/ib00100180146"]

    def test_unresolvable_scope_raises_rather_than_defaulting(self):
        """Issue #71: no hardcoded province fallback."""
        connector = DigloConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_empty_sitemap_raises_not_returns_empty(self):
        """discovers_full_inventory=True means an empty discover() reads as a
        mass withdrawal — guard against a fetch glitch producing it."""
        connector = DigloConnector()
        empty = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
        with (
            patch(
                "etl.connectors.diglo.requests.get",
                return_value=_mock_response(empty),
            ),
            pytest.raises(ConnectorError, match="zero <loc>"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )

    def test_sitemap_with_no_detail_urls_raises(self):
        """URL-scheme change (entries present, none match the detail shape)
        must raise, not silently report an empty catalogue."""
        connector = DigloConnector()
        nav_only = (
            '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            "<url><loc>https://digloservicer.com/venta-pisos/cualquiera</loc></url>"
            "<url><loc>https://digloservicer.com/blog</loc></url>"
            "</urlset>"
        )
        with (
            patch(
                "etl.connectors.diglo.requests.get",
                return_value=_mock_response(nav_only),
            ),
            pytest.raises(ConnectorError, match="none matched"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )


class TestScopeAndFlags:
    def test_discovers_full_inventory_is_true(self):
        assert DigloConnector.discovers_full_inventory is True

    def test_rate_limit_is_conservative(self):
        assert DigloConnector.rate_limit_per_minute <= 12

    def test_scope_key_is_the_resolved_province(self):
        connector = DigloConnector()
        assert connector.scope_key(ConnectorScope(geography="Madrid")) == "madrid"
        assert connector.scope_key(ConnectorScope()) is None

    def test_scope_key_uses_a_sentinel_for_an_unresolvable_center(self):
        connector = DigloConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5)  # Lisbon
        key = connector.scope_key(far)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_scope_key_resolves_a_non_capital_town_to_its_province(self):
        """A scope centered on a non-capital town resolves via its province
        slug (Estepona -> malaga), since the national sitemap covers every
        province."""
        connector = DigloConnector()
        estepona = ConnectorScope(center=(36.42764, -5.14589), radius_km=10)
        assert connector.scope_key(estepona) == "malaga"


class TestMapping:
    @pytest.mark.parametrize(
        "segment,expected",
        [
            ("pisos", "piso"),
            ("casas", "chalet"),
            ("garajes", "garaje"),
            ("locales", "local"),
            ("naves", "nave"),
            ("terrenos", "terreno"),
            ("trasteros", None),
            ("otros", None),
        ],
    )
    def test_property_type_mapping(self, segment, expected):
        assert map_property_type(segment) == expected

    def test_residential_segments(self):
        assert is_residential("pisos")
        assert is_residential("casas")
        assert not is_residential("garajes")
        assert not is_residential(None)

    @pytest.mark.parametrize(
        "province,slug",
        [("Madrid", "madrid"), ("Ciudad Real", "ciudad-real"), ("Malaga", "malaga")],
    )
    def test_province_slug(self, province, slug):
        assert province_slug(province) == slug

    @pytest.mark.parametrize(
        "seg,ok",
        [
            ("efe0000200053", True),
            ("ib00100025555", True),
            ("cualquiera", False),
            ("chalets-adosados", False),
            ("madrid", False),
        ],
    )
    def test_is_refcode(self, seg, ok):
        assert is_refcode(seg) is ok

    def test_parse_listing_path_piso_no_subtype(self):
        p = parse_listing_path("/venta-pisos/madrid/madrid/efe0000200053")
        assert p["type_segment"] == "pisos"
        assert p["subtype_segment"] is None
        assert p["province_slug"] == "madrid"
        assert p["municipality_slug"] == "madrid"
        assert p["refcode"] == "efe0000200053"

    def test_parse_listing_path_casa_with_subtype(self):
        p = parse_listing_path(
            "https://digloservicer.com/venta-casas/casas-rurales/huelva/almonte/ib00100180146"
        )
        assert p["type_segment"] == "casas"
        assert p["subtype_segment"] == "casas-rurales"
        assert p["province_slug"] == "huelva"
        assert p["municipality_slug"] == "almonte"
        assert p["refcode"] == "ib00100180146"

    def test_parse_listing_path_category_url_is_all_none(self):
        p = parse_listing_path("/venta-pisos/cualquiera")
        assert p["refcode"] is None
        assert p["type_segment"] is None


class TestSchemaRoundTrip:
    """Real-Postgres round trip (skips when no DB configured; runs in CI).

    Proves the normalized listing persists into property/listing without a
    CHECK/type violation — the exact class of bug a mocked-DB unit test
    misses (D-041 spirit)."""

    def test_normalized_listing_survives_the_schema(self, pg_conn):
        _apply_schema(pg_conn)
        n = _normalize_fixture()
        _upsert_canonical_listing(pg_conn, n)
        pg_conn.commit()
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT current_price, operation FROM listing WHERE external_id = %s",
                (SUBJECT_ID,),
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == Decimal("308000.00")
        assert row[1] == "sale"
