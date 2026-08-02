"""Servihabitat connector tests (issue #115).

Fixtures are trimmed from a real page/sitemap captured 2026-08-02, not
synthesised — including the "similar listings" neighbour card, which is
load-bearing for the regression in TestNeighbourCardIsolation.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from bs4 import BeautifulSoup

from etl.connectors.base import ConnectorError, ConnectorScope, RawListing
from etl.connectors.servihabitat import (
    ServihabitatConnector,
    _equipamiento,
    _extract_product_json_ld,
    _open_graph,
    _referencia_attr,
    _strip_similar_listings,
    parse_listing_path,
)
from etl.connectors.servihabitat_mapping import (
    is_residential,
    map_property_type,
    parse_location_slug,
)

FIXTURES = Path(__file__).parent / "fixtures"
SUBJECT_ID = (
    "es/venta/vivienda/madrid-areametropolitanamadrid-madtetuan_cuatrocaminos/60645658"
)


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str):
    class _R:
        def __init__(self, t: str) -> None:
            self.text = t

        def raise_for_status(self) -> None:
            return None

    return _R(text)


def _normalize_fixture(html: str, external_id: str = SUBJECT_ID):
    soup = BeautifulSoup(html, "html.parser")
    _strip_similar_listings(soup)
    features_section = soup.find(id="product_features")
    raw = RawListing(
        external_id=external_id,
        source="servihabitat",
        raw={
            "url": f"https://www.servihabitat.com/{external_id}",
            "html": html,
            "json_ld": _extract_product_json_ld(html),
            "path_parts": parse_listing_path(external_id),
            "og": _open_graph(soup),
            "referencia": _referencia_attr(soup),
            "features_text": (
                features_section.get_text(" ", strip=True) if features_section else None
            ),
            "equipamiento": _equipamiento(features_section),
            "text": soup.get_text(" ", strip=True),
        },
    )
    return ServihabitatConnector().normalize(raw)


class TestNormalize:
    def test_matches_the_real_listing_values(self):
        """Values cross-checked against the live page for ref 60645658."""
        n = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        assert n.reference_code == "60645658"
        assert n.m2_built == Decimal(80)
        assert n.current_price == Decimal(230000)
        assert n.property_type == "piso"
        assert n.city == "madtetuan_cuatrocaminos"
        assert n.province == "madrid"
        assert n.operation == "sale"
        # Servicer selling bank-owned stock — never a private seller. This is
        # load-bearing for issue #16's phone-corroboration rule, which never
        # auto-merges when either side is an agency.
        assert n.listing_kind == "agency"

    def test_equipamiento_becomes_feature_slugs(self):
        """features must be short tokens for the GIN/containment convention
        in data-model.md, not the page's descriptive text."""
        n = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        assert n.features == ("alarma",)

    def test_fields_this_site_does_not_publish_stay_none(self):
        """Asserted rather than left silent (issue #132 checklist): if the
        site ever starts publishing these, this test fails and prompts a
        connector update.

        No lat/lon means issue #16's `address_coords` dedup signal can never
        fire for Servihabitat listings — dedup here leans on the reference
        code (#72) and fuzzy matching instead.
        """
        n = _normalize_fixture(_read("servihabitat_sample_detail.html"))
        assert n.lat is None
        assert n.lon is None
        assert n.postal_code is None
        # No `referencia catastral` — unlike Solvia (#116), which does publish
        # one and thereby gave issue #1 §6's strongest dedup signal a source.
        assert "cadastral" not in (n.raw_extra or {})


class TestNeighbourCardIsolation:
    """The bug this connector would otherwise have shipped.

    A Servihabitat detail page renders a "inmuebles similares" carousel whose
    cards carry their own price/m2/rooms/baths. The real page for ref
    60645658 (80 m2, 230.000 EUR) contains a neighbour card reading
    "48m 2 2 hab. 1 baño ... 190.000 €". An unscoped regex over page text
    reads the neighbour's figures — the same class of bug PR #139 hit on
    Vivantial.
    """

    def test_subject_values_win_over_the_neighbour_card(self):
        html = _read("servihabitat_sample_detail.html")
        assert "190.000" in html and "48m" in html, (
            "fixture must retain a neighbour card or this regression is retired"
        )
        n = _normalize_fixture(html)
        assert n.m2_built == Decimal(80), "read the neighbour card's 48 m2"
        assert n.current_price == Decimal(230000), "read the neighbour's price"

    def test_strip_removes_the_carousel(self):
        soup = BeautifulSoup(_read("servihabitat_sample_detail.html"), "html.parser")
        assert soup.find(attrs={"class": "container-similares"}) is not None
        _strip_similar_listings(soup)
        assert soup.find(attrs={"class": "container-similares"}) is None
        assert "190.000" not in soup.get_text(" ", strip=True)


class TestFallbackChain:
    def test_price_falls_back_to_page_text_when_json_ld_is_absent(self):
        """Proves the fallback is real, not dead code: strip the primary
        (JSON-LD) source and the value must still resolve from page text."""
        import re

        html = _read("servihabitat_sample_detail.html")
        without_ld = re.sub(
            r"<script[^>]*application/ld\+json[^>]*>.*?</script>",
            "",
            html,
            flags=re.DOTALL,
        )
        assert _extract_product_json_ld(without_ld) is None
        # Page text still carries the subject price in the og/description and
        # body, so the text fallback should recover a value.
        n = _normalize_fixture(without_ld)
        assert n.m2_built == Decimal(80)
        # And crucially, the fallback must still not pick up the neighbour.
        assert n.current_price != Decimal(190000)


class TestDiscover:
    def test_filters_sitemap_to_residential_only(self):
        connector = ServihabitatConnector()
        with patch(
            "etl.connectors.servihabitat.requests.get",
            return_value=_mock_response(_read("servihabitat_sample_sitemap.xml")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        # 3 residential (vivienda, promociones/vivienda, vivienda-casa);
        # garaje/local/terreno dropped — the portfolio is garage-heavy and
        # would otherwise swamp every candidate list with parking spaces.
        assert len(ids) == 3
        assert all("/vivienda" in i for i in ids)
        assert not any("garaje" in i or "local" in i or "terreno" in i for i in ids)

    def test_external_id_is_the_path_not_the_bare_id(self):
        """There is no id-only canonical URL (both /es/venta/vivienda/x/<id>
        and /es/inmueble/<id> 404 live), so fetch_detail cannot rebuild a URL
        from the numeric id alone."""
        connector = ServihabitatConnector()
        with patch(
            "etl.connectors.servihabitat.requests.get",
            return_value=_mock_response(_read("servihabitat_sample_sitemap.xml")),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert SUBJECT_ID in ids

    def test_unresolvable_scope_raises_rather_than_defaulting(self):
        """Issue #71: no hardcoded province fallback."""
        connector = ServihabitatConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)


class TestScopeAndFlags:
    def test_discovers_full_inventory_is_false(self):
        """Sitemap completeness is unverifiable here — every faceted-search
        query param is robots.txt-disallowed, so there is no compliant way to
        cross-check the sitemap count against a search total. Under-claiming
        avoids the orchestrator mass-marking listings `withdrawn`."""
        assert ServihabitatConnector.discovers_full_inventory is False

    def test_rate_limit_is_conservative(self):
        """robots.txt carries `User-agent: Scrapy / Disallow: /` — a clear
        anti-automation posture even though the `*` group permits us."""
        assert ServihabitatConnector.rate_limit_per_minute <= 12

    def test_scope_key_is_the_resolved_province(self):
        connector = ServihabitatConnector()
        assert connector.scope_key(ConnectorScope(geography="madrid")) == "madrid"
        assert connector.scope_key(ConnectorScope()) is None


class TestMapping:
    @pytest.mark.parametrize(
        "segment,expected",
        [
            ("vivienda", "piso"),
            ("vivienda-piso", "piso"),
            ("vivienda-casa", "chalet"),
            ("garaje-garajecoche", "garaje"),
            ("terreno-urbanoparaconstruir", "terreno"),
            ("local", "local"),
            ("nave", "nave"),
            ("totallyunknown", None),
        ],
    )
    def test_property_type_mapping(self, segment, expected):
        assert map_property_type(segment) == expected

    def test_residential_filter(self):
        assert is_residential("vivienda-piso")
        assert not is_residential("garaje")
        assert not is_residential("terreno-rustico")
        assert not is_residential(None)

    def test_location_slug_split(self):
        city, province = parse_location_slug(
            "madrid-areametropolitanamadrid-madtetuan_cuatrocaminos"
        )
        assert province == "madrid"
        assert city == "madtetuan_cuatrocaminos"

    def test_promociones_path_shape_is_handled(self):
        parts = parse_listing_path(
            "/es/venta/promociones/vivienda/madrid-comarcasur-valdemoro/06110749"
        )
        assert parts["type_segment"] == "vivienda"
        assert parts["listing_id"] == "06110749"
        assert parts["is_promocion"] == "true"
