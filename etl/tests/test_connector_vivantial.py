"""Fixture-based tests for the Vivantial connector (issue #120).

Fixtures are trimmed from real pages fetched during the 2026-08-02
feasibility spike, keeping the markup that matters (meta description, the
two `precio` divs, the reference element, a CDN photo) plus a real
"similar properties" card — that card is load-bearing for the
regression test below, not decoration.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.vivantial import VivantialConnector, _resolve_geography
from etl.connectors.vivantial_mapping import (
    external_id_from_url,
    extract_bathrooms,
    extract_city_province,
    extract_m2_built,
    extract_photo_urls,
    extract_price,
    extract_reference_code,
    extract_rooms,
)

FIXTURES = Path(__file__).parent / "fixtures"
MADRID_URL = (
    "https://www.vivantial.es/Inmuebles/vivienda_en_venta_en_madrid_en_madrid_5336"
)


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, status: int = 200):
    class _R:
        def __init__(self) -> None:
            self.text = text
            self.status_code = status

        def raise_for_status(self) -> None:
            return None

    return _R()


class TestFieldExtraction:
    """Values asserted here are the real ones from the live Madrid listing."""

    def test_extracts_every_field_from_a_real_listing(self):
        page = _fixture("vivantial_sample_detail.html")
        assert extract_price(page) == Decimal(288000)
        assert extract_m2_built(page) == Decimal(67)
        assert extract_rooms(page) == 4
        assert extract_bathrooms(page) == 1
        assert extract_reference_code(page) == "VIVANTIAL-5336"

    def test_price_ignores_the_similar_properties_card(self):
        """Regression: the body renders neighbouring listings with their own
        prices. An earlier version fell through to a page-wide euro-amount
        search and reported this fixture's neighbour (310.000 €) as the
        listing's own price (288.000 €). The similar-properties card in the
        fixture is what makes this test meaningful."""
        page = _fixture("vivantial_sample_detail.html")
        assert "310.000" in page, "fixture must retain the neighbour card"
        assert extract_price(page) == Decimal(288000)

    def test_price_falls_back_to_precio_rojo_when_meta_is_absent(self):
        """EC: a field with a working fallback chain, proven with the primary
        path removed. The fallback must still avoid the neighbour's price."""
        page = _fixture("vivantial_sample_detail_no_meta.html")
        assert 'name="description"' not in page
        assert "310.000" in page
        assert extract_price(page) == Decimal(288000)

    def test_photo_urls_are_absolute_and_exclude_site_chrome(self):
        """`//cdn.vivantial.es/...` is protocol-relative — the same shape
        that produced a `https:////host` double-slash bug in Milanuncios."""
        urls = extract_photo_urls(_fixture("vivantial_sample_detail.html"))
        assert urls == (
            "https://cdn.vivantial.es/photos/ES5336_INV09-FINSO-CENRE-047_5677.png",
        )
        assert all(u.startswith("https://cdn.vivantial.es/") for u in urls)
        assert not any("logoHead" in u or "favicon" in u for u in urls)

    def test_optional_fields_are_none_not_zero_when_absent(self):
        """Some listings genuinely publish no room/bath count; the meta
        description renders an empty slot ("... con  por 12.000 €")."""
        page = _fixture("vivantial_sample_detail.html").replace(
            "con 4 hab. y 1 ba&#241;o por", "con  por"
        )
        assert extract_rooms(page) is None
        assert extract_bathrooms(page) is None
        assert extract_price(page) == Decimal(288000)


class TestUrlParsing:
    @pytest.mark.parametrize(
        "url,city,province",
        [
            (MADRID_URL, "Madrid", "Madrid"),
            (
                (
                    "https://www.vivantial.es/Inmuebles/"
                    "vivienda_en_venta_en_rabade_en_lugo_6896"
                ),
                "Rabade",
                "Lugo",
            ),
            (
                (
                    "https://www.vivantial.es/Inmuebles/"
                    "vivienda_en_venta_en_saguntosagunt_en_valencia_18529"
                ),
                "Saguntosagunt",
                "Valencia",
            ),
        ],
    )
    def test_city_province_come_from_the_slug(self, url, city, province):
        """Regression: the slug prefix contains its own `_en_`
        ("vivienda_en_venta_en_"), so anchoring on the first occurrence
        yielded "Venta/Madrid En Madrid" instead of "Madrid"/"Madrid"."""
        assert extract_city_province(url) == (city, province)

    def test_external_id_is_the_trailing_number(self):
        assert external_id_from_url(MADRID_URL) == "5336"


class TestGeographyResolution:
    def test_free_text_geography_wins(self):
        assert _resolve_geography(ConnectorScope(geography="madrid")) == "madrid"

    def test_center_resolves_to_a_city_slug(self):
        scope = ConnectorScope(center=(40.4168, -3.7038), radius_km=10.0)
        assert _resolve_geography(scope) == "madrid"

    def test_unresolvable_scope_returns_none_not_a_default(self):
        """Issue #71: never silently fall back to a hardcoded city."""
        assert _resolve_geography(ConnectorScope()) is None
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5.0)  # Lisbon
        assert _resolve_geography(far) is None


class TestDiscover:
    def test_filters_the_national_sitemap_by_city(self):
        connector = VivantialConnector()
        sitemap = _fixture("vivantial_sample_sitemap.xml")
        with patch(
            "etl.connectors.vivantial.requests.get",
            return_value=_mock_response(sitemap),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert ids == ["5336", "9001"], "only Madrid listings, sorted, deduped"

    def test_unresolvable_scope_raises_rather_than_returning_empty(self):
        """An empty discover() would read as 'everything was withdrawn' to the
        orchestrator — and this connector claims full inventory, so that
        would mass-withdraw real listings."""
        connector = VivantialConnector()
        with pytest.raises(ConnectorError, match="not defaulting to a hardcoded"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_a_sitemap_with_no_loc_entries_raises(self):
        """A WAF interstitial or error page must not be read as an empty
        inventory — same guard as the other connectors' marker checks."""
        connector = VivantialConnector()
        with (
            patch(
                "etl.connectors.vivantial.requests.get",
                return_value=_mock_response("<html>Access Denied</html>"),
            ),
            pytest.raises(ConnectorError, match="no <loc> entries"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )


class TestFetchDetailAndNormalize:
    def test_normalize_produces_a_canonical_listing(self):
        connector = VivantialConnector()
        page = _fixture("vivantial_sample_detail.html")
        connector._url_cache["5336"] = MADRID_URL
        with patch(
            "etl.connectors.vivantial.requests.get",
            return_value=_mock_response(page),
        ):
            raw = connector.fetch_detail("5336", throttle=lambda: None)
        listing = connector.normalize(raw)

        assert listing.source == "vivantial"
        assert listing.external_id == "5336"
        assert listing.current_price == Decimal(288000)
        assert listing.m2_built == Decimal(67)
        assert listing.rooms == 4
        assert listing.reference_code == "VIVANTIAL-5336"
        assert listing.city == "Madrid"
        assert listing.province == "Madrid"
        assert listing.operation == "sale"
        assert listing.listing_kind == "agency"
        assert listing.status == "active"
        # The site publishes no coordinates at all — a permanent limitation
        # that excludes Vivantial from the address_coords dedup signal.
        assert listing.lat is None
        assert listing.lon is None

    def test_a_page_without_the_reference_marker_raises(self):
        connector = VivantialConnector()
        with (
            patch(
                "etl.connectors.vivantial.requests.get",
                return_value=_mock_response("<html><body>gone</body></html>"),
            ),
            pytest.raises(ConnectorError, match="no reference marker"),
        ):
            connector.fetch_detail("5336", throttle=lambda: None)


class TestRegistration:
    def test_registered_and_claims_full_inventory(self):
        from etl.connectors import register_all
        from etl.orchestrator import CONNECTORS

        register_all()
        by_name = {c.name: c for c in CONNECTORS}
        assert "vivantial" in by_name
        # Justified: the sitemap is the site's complete published inventory
        # and discover() reads all of it, so absence really does mean removed
        # (unlike Fotocasa's page-1 slice).
        assert by_name["vivantial"].discovers_full_inventory is True
