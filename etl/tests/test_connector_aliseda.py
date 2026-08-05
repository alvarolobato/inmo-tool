"""Unit tests for the Aliseda capture connector (issues #237, #266).

normalize() is exercised against THREE real captured Aliseda detail pages
(trimmed to the load-bearing markup — the two JSON-LD blocks, the feature
block, the description, and the photo gallery), preserved as
etl/tests/fixtures/aliseda_detail_*.html. This connector never makes a live
request (D-019: Aliseda's data host is robots.txt Disallow: /). The captures
were taken by a human viewing `/inmueble/<id>` in their own browser and are
the ground truth these selectors were calibrated against.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors.aliseda import AlisedaConnector
from etl.connectors.base import ConnectorError, RawListing

_FIXTURES = Path(__file__).parent / "fixtures"
_SHELL_HTML = (_FIXTURES / "aliseda_sample_shell.html").read_text(encoding="utf-8")

# (fixture, slug, expected price, m², rooms, baths, postal, city, province)
_CASES = {
    "vtr319552": (
        "aliseda_detail_vtr319552.html",
        "vtr0200319552",
        Decimal(445000),
        Decimal(87),
        2,
        2,
        "41010",
        "Sevilla",
        "Sevilla",
    ),
    "vtr319563": (
        "aliseda_detail_vtr319563.html",
        "vtr0200319563",
        Decimal(738000),
        Decimal(81),
        3,
        None,  # this capture exposes no "Baños" feature
        "41010",
        "Sevilla",
        "Sevilla",
    ),
    "vpa120399": (
        "aliseda_detail_vpa120399.html",
        "vpa41007120399",
        Decimal(189000),
        Decimal(75),
        3,
        1,
        "41007",
        "Sevilla",
        "Sevilla",
    ),
}


def _normalize(html: str, slug: str):
    connector = AlisedaConnector()
    url = f"https://www.alisedainmobiliaria.com/inmueble/{slug}"
    raw = RawListing(
        external_id=slug, source=connector.name, raw={"url": url, "html": html}
    )
    return connector.normalize(raw)


def _case(key: str):
    fixture = _CASES[key][0]
    return (_FIXTURES / fixture).read_text(encoding="utf-8"), _CASES[key][1]


class TestExternalIdFromUrl:
    @pytest.mark.parametrize(
        "url,expected",
        [
            (
                "https://www.alisedainmobiliaria.com/inmueble/vtr0200319552",
                "vtr0200319552",
            ),
            (
                "https://www.alisedainmobiliaria.com/inmueble/VPA41007120399/",
                "VPA41007120399",
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


class TestNormalizeRealCaptures:
    @pytest.mark.parametrize("key", list(_CASES))
    def test_core_fields_extracted(self, key):
        html, slug = _case(key)
        (_f, _slug, price, m2, rooms, baths, postal, city, province) = _CASES[key]
        c = _normalize(html, slug)

        assert c.source == "aliseda"
        assert c.external_id == slug
        assert c.reference_code == slug.upper()
        assert c.current_price == price
        assert c.m2_built == m2
        assert c.rooms == rooms
        assert c.bathrooms == baths
        assert c.postal_code == postal
        assert c.city == city
        assert c.province == province
        assert c.property_type == "piso"
        assert c.operation == "sale"
        assert c.status == "active"
        assert c.listing_kind == "agency"

    @pytest.mark.parametrize("key", list(_CASES))
    def test_photos_belong_to_this_listing_only(self, key):
        html, slug = _case(key)
        c = _normalize(html, slug)
        # The detail page also embeds a "también te puede interesar" carousel
        # with OTHER listings' photos — every extracted URL must carry THIS
        # listing's reference, and there must be a real gallery (>= 10).
        assert len(c.photo_urls) >= 10
        ref = slug.upper()
        assert all(f"/{ref}/" in u for u in c.photo_urls)
        assert all(
            u.startswith("https://storage.googleapis.com/aliseda/ImagenesActivos/")
            for u in c.photo_urls
        )
        # No site-chrome (FrontWeb logos/banners) leaks in.
        assert not any("FrontWeb" in u for u in c.photo_urls)
        # Deduped.
        assert len(set(c.photo_urls)) == len(c.photo_urls)

    def test_address_and_description(self):
        html, slug = _case("vtr319552")
        c = _normalize(html, slug)
        assert c.address == "calle Samuel Morse"
        assert c.description and "PRÍNCIPES" in c.description
        # The "Descripción" heading label is stripped from the body.
        assert not c.description.startswith("Descripción")

    def test_provenance(self):
        html, slug = _case("vpa120399")
        c = _normalize(html, slug)
        assert c.raw_extra["capture_source"] == "browser-extension"
        assert c.raw_extra["capture_portal"] == "aliseda"
        assert c.contact_raw is None  # no owner-contact PII persisted

    def test_price_mutation_is_caught(self):
        """Revert-and-confirm-fail: corrupt the JSON-LD price the parser reads
        and the extracted price must change — proving it is genuinely parsed
        from the fixture, not hard-coded/coincidental."""
        html, slug = _case("vtr319552")
        assert _normalize(html, slug).current_price == Decimal(445000)
        mutated = html.replace('"price": 445000', '"price": 999111')
        assert mutated != html  # the token we mutate really is in the fixture
        assert _normalize(mutated, slug).current_price == Decimal(999111)


class TestNormalizeEmptyShell:
    def test_unhydrated_shell_extracts_almost_nothing_honestly(self):
        """A capture taken before the Angular app hydrated (or a plain fetch)
        is a bare shell. The mapping must degrade to mostly-None rather than
        fabricate — the popup's completeness signal then nudges a re-capture.
        """
        connector = AlisedaConnector()
        raw = RawListing(
            external_id="ANT404",
            source=connector.name,
            raw={
                "url": "https://www.alisedainmobiliaria.com/inmueble/ANT404",
                "html": _SHELL_HTML,
            },
        )
        c = connector.normalize(raw)
        assert c.external_id == "ANT404"
        assert c.source == "aliseda"
        assert c.status == "active"
        assert c.current_price is None
        assert c.m2_built is None
        assert c.rooms is None
        assert c.city is None
        assert c.photo_urls == ()


class TestDiscoveryIsRefused:
    def test_discover_raises(self):
        with pytest.raises(ConnectorError):
            AlisedaConnector().discover(object(), lambda: None)

    def test_fetch_detail_raises(self):
        with pytest.raises(ConnectorError):
            AlisedaConnector().fetch_detail("ANT1", lambda: None)
