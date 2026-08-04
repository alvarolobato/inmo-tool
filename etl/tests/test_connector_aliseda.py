"""Unit tests for the Aliseda capture connector (issue #237).

Pure normalize() tests against a FABRICATED fixture — this connector never
makes a live request (D-019: Aliseda's data host is robots.txt Disallow: /,
and the public page is a JS shell). Every value asserted below is invented in
etl/tests/fixtures/aliseda_sample_detail.html, not scraped. These tests pin
the CURRENT best-effort mapping so that refining the selectors against a real
owner capture (see aliseda.py's validation checklist) is a deliberate,
test-visible change — they are not evidence the selectors match the real site.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors.aliseda import AlisedaConnector
from etl.connectors.base import ConnectorError, RawListing

_FIXTURES = Path(__file__).parent / "fixtures"
_DETAIL_HTML = (_FIXTURES / "aliseda_sample_detail.html").read_text(encoding="utf-8")
_SHELL_HTML = (_FIXTURES / "aliseda_sample_shell.html").read_text(encoding="utf-8")
_DETAIL_URL = "https://www.alisedainmobiliaria.com/inmueble/ANT99900011122"


def _normalize(html: str, url: str = _DETAIL_URL, external_id: str = "ANT99900011122"):
    connector = AlisedaConnector()
    raw = RawListing(
        external_id=external_id, source=connector.name, raw={"url": url, "html": html}
    )
    return connector.normalize(raw)


class TestExternalIdFromUrl:
    @pytest.mark.parametrize(
        "url,expected",
        [
            (
                "https://www.alisedainmobiliaria.com/inmueble/ant00030657045",
                "ant00030657045",
            ),
            (
                "https://www.alisedainmobiliaria.com/inmueble/ANT99900011122/",
                "ANT99900011122",
            ),
            (
                "https://www.alisedainmobiliaria.com/inmueble/ANT1?utm=x",
                "ANT1",
            ),
            ("https://www.alisedainmobiliaria.com/comprar-viviendas/andalucia", None),
        ],
    )
    def test_extracts_asset_id(self, url, expected):
        assert AlisedaConnector.external_id_from_url(url) == expected


class TestNormalizeDetailPage:
    def test_maps_the_grounded_analytics_fields(self):
        c = _normalize(_DETAIL_HTML)
        assert c.external_id == "ANT99900011122"
        assert c.source == "aliseda"
        assert c.url == _DETAIL_URL
        # Grounded (D-019 observed these analytics keys on the real page).
        assert c.current_price == Decimal(148000)
        assert c.m2_built == Decimal(78)
        assert c.rooms == 2
        assert c.bathrooms == 1
        assert c.city == "Estepona"  # title-cased from shouty "ESTEPONA"
        assert c.province == "Málaga"
        assert c.postal_code == "29680"
        assert c.address == "Calle Ejemplo 12"
        assert c.lat == Decimal("36.427540")
        assert c.lon == Decimal("-5.145680")
        assert c.property_type == "piso"
        assert c.operation == "sale"
        assert c.reference_code == "ANT99900011122"
        assert c.floor == "2"
        assert c.has_elevator is True

    def test_captures_photos_and_description(self):
        c = _normalize(_DETAIL_HTML)
        assert len(c.photo_urls) == 3
        assert all(
            u.startswith("https://cdn.alisedainmobiliaria.com/") for u in c.photo_urls
        )
        assert c.description and "Estepona" in c.description

    def test_provenance_and_status(self):
        c = _normalize(_DETAIL_HTML)
        assert c.status == "active"  # capture connector can only assert active
        assert c.listing_kind == "agency"  # REO portal
        assert c.raw_extra["capture_source"] == "browser-extension"
        assert c.raw_extra["capture_portal"] == "aliseda"
        assert c.raw_extra["aliseda_datalayer"]["referencia"] == "ANT99900011122"

    def test_dom_fallback_when_datalayer_absent(self):
        """Strip the analytics blob: the DOM-selector fallback path must still
        recover the core fields, since a real capture might not carry the
        dataLayer push in the shape we guessed."""
        html_no_dl = _DETAIL_HTML.replace("dataLayer.push", "notADataLayer.push")
        c = _normalize(html_no_dl)
        # Recovered purely from labelled DOM elements now.
        assert c.current_price == Decimal(148000)
        assert c.m2_built == Decimal(78)
        assert c.rooms == 2
        assert c.bathrooms == 1
        assert c.reference_code == "ANT99900011122"
        assert c.city == "Estepona"
        assert c.province == "Málaga"
        assert c.property_type == "piso"


class TestNormalizeEmptyShell:
    def test_unhydrated_shell_extracts_almost_nothing_honestly(self):
        """A capture taken before the Angular app hydrated (or a plain fetch)
        is a bare shell. The mapping must degrade to mostly-None rather than
        fabricate — the popup's completeness signal then nudges a re-capture.
        """
        c = _normalize(_SHELL_HTML, external_id="ANT404")
        assert c.external_id == "ANT404"
        assert c.source == "aliseda"
        assert c.status == "active"
        assert c.current_price is None
        assert c.m2_built is None
        assert c.rooms is None
        assert c.city is None
        assert c.reference_code is None
        assert c.photo_urls == ()


class TestDiscoveryIsRefused:
    def test_discover_raises(self):
        with pytest.raises(ConnectorError):
            AlisedaConnector().discover(object(), lambda: None)

    def test_fetch_detail_raises(self):
        with pytest.raises(ConnectorError):
            AlisedaConnector().fetch_detail("ANT1", lambda: None)
