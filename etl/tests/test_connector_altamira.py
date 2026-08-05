"""Unit tests for the Altamira capture connector (issue #271).

normalize() is exercised against TWO real captured Altamira detail pages
(trimmed to the load-bearing markup — the og/meta tags, title, breadcrumb,
price, reference, characteristics, description, and the photo gallery),
preserved as etl/tests/fixtures/altamira_detail_*.html. This connector never
makes a live request (D-027: Altamira returns an Akamai WAF 403 on every path).
The captures were taken by a human viewing a listing in their own browser
(2026-08-05 GO test) and are the ground truth these selectors were calibrated
against.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors.altamira import (
    AltamiraConnector,
    _clean_ws,
    _es_price_to_decimal,
)
from etl.connectors.base import ConnectorError, RawListing

_FIXTURES = Path(__file__).parent / "fixtures"
_BASE = "https://www.altamirainmuebles.com"

_URL_375859 = (
    f"{_BASE}/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1"
)
_URL_375864 = f"{_BASE}/venta-de-casa/murcia/alhama-de-murcia/segunda-mano/9186_1004_PE0001/375864/1"

# (fixture, url, external_id, ref, price, m², type, city, province, photo count)
_CASES = {
    "375859": (
        "altamira_detail_375859.html",
        _URL_375859,
        "375859",
        "9186_1001_PE0001",
        Decimal("216724.25"),
        Decimal(97),
        "atico",
        "Sanxenxo",
        "Pontevedra",
        6,
    ),
    "375864": (
        "altamira_detail_375864.html",
        _URL_375864,
        "375864",
        "9186_1004_PE0001",
        Decimal(50400),
        Decimal(128),
        "chalet",  # "casa" maps to the canonical 'chalet' bucket
        "Alhama De Murcia",
        "Murcia",
        7,
    ),
}


def _normalize(key: str):
    (fixture, url, ext_id, *_rest) = _CASES[key]
    html = (_FIXTURES / fixture).read_text(encoding="utf-8")
    connector = AltamiraConnector()
    raw = RawListing(
        external_id=ext_id, source=connector.name, raw={"url": url, "html": html}
    )
    return connector.normalize(raw)


class TestExternalIdFromUrl:
    @pytest.mark.parametrize(
        "url,expected",
        [
            (_URL_375859, "375859"),
            # Dashed reference slug variant (as seen in og:url).
            (
                f"{_BASE}/venta-de-casa/murcia/alhama-de-murcia/segunda-mano/9186-1004-pe0001/375864/1",
                "375864",
            ),
            # No trailing photo-index segment.
            (
                f"{_BASE}/venta-de-piso/madrid/madrid/segunda-mano/9186_2002_PE0001/400111",
                "400111",
            ),
            # Search/listing page — no numeric id.
            (f"{_BASE}/venta-viviendas/cualquier-provincia", None),
        ],
    )
    def test_extracts_numeric_id(self, url, expected):
        assert AltamiraConnector.external_id_from_url(url) == expected


class TestNormalizeRealCaptures:
    @pytest.mark.parametrize("key", list(_CASES))
    def test_core_fields_extracted(self, key):
        (
            _f,
            _url,
            ext_id,
            ref,
            price,
            m2,
            ptype,
            city,
            province,
            _photos,
        ) = _CASES[key]
        c = _normalize(key)

        assert c.source == "altamira"
        assert c.external_id == ext_id
        assert c.reference_code == ref
        assert c.current_price == price
        assert c.m2_built == m2
        assert c.property_type == ptype
        assert c.city == city
        assert c.province == province
        assert c.operation == "sale"
        assert c.status == "active"
        assert c.listing_kind == "agency"
        # These auction listings do not publish rooms/baths — honest None, not a
        # fabricated value (see the connector's module docstring).
        assert c.rooms is None
        assert c.bathrooms is None

    def test_address_lifted_from_title(self):
        assert "Progreso" in (_normalize("375859").address or "")
        assert "Portillas" in (_normalize("375864").address or "")

    @pytest.mark.parametrize("key", list(_CASES))
    def test_photo_urls_extracts_full_gallery(self, key):
        """EC-2 / EC-3: the full gallery (not just og:image), scoped to THIS
        listing only — the 'también te puede interesar' carousel embeds other
        listings' photos, which must never leak in."""
        ext_id = _CASES[key][2]
        expected_count = _CASES[key][9]
        c = _normalize(key)

        assert len(c.photo_urls) == expected_count
        assert len(c.photo_urls) >= 5
        # Absolute URLs on Altamira's asset host.
        assert all(
            u.startswith(
                "https://www.altamirainmuebles.com/estaticos/activos/inmuebles/fotos/"
            )
            for u in c.photo_urls
        )
        # Every photo belongs to THIS listing (filename starts with its id).
        assert all(f"/{ext_id}_" in u for u in c.photo_urls)
        # No foreign carousel photo leaked in.
        assert not any(f"/{ext_id}_" not in u for u in c.photo_urls)
        # Deduped, order preserved.
        assert len(set(c.photo_urls)) == len(c.photo_urls)

    def test_description_and_provenance(self):
        c = _normalize("375859")
        assert c.description and "REMATE" in c.description
        # The "Descripción" heading label is stripped from the body.
        assert not c.description.startswith("Descripción")
        assert c.raw_extra["capture_source"] == "browser-extension"
        assert c.raw_extra["capture_portal"] == "altamira"
        assert c.contact_raw is None  # no owner-contact PII persisted

    def test_price_mutation_is_caught(self):
        """Revert-and-confirm-fail: corrupt the #soloPrecio value the parser
        reads and the extracted price must change — proving it is genuinely
        parsed from the fixture, not hard-coded/coincidental."""
        fixture = _CASES["375859"][0]
        html = (_FIXTURES / fixture).read_text(encoding="utf-8")
        connector = AltamiraConnector()
        url = _CASES["375859"][1]

        def price_of(h: str):
            raw = RawListing(
                external_id="375859",
                source=connector.name,
                raw={"url": url, "html": h},
            )
            return connector.normalize(raw).current_price

        assert price_of(html) == Decimal("216724.25")
        mutated = html.replace(
            '<span id="soloPrecio">216.724,25</span>',
            '<span id="soloPrecio">99.111,00</span>',
        )
        assert mutated != html  # the token we mutate really is in the fixture
        assert price_of(mutated) == Decimal("99111.00")


class TestFeatureParsers:
    """The rooms/baths parsers return None on the auction fixtures because those
    pages don't publish the feature — but they DO extract when a listing carries
    it. Proven against a small hand-built caracteristics block (a parser unit
    test, not a fabricated full-page fixture)."""

    def test_rooms_and_baths_extracted_when_present(self):
        html = """<section class="caracteristicas"><ul>
          <li class="icono superficie"><span class="valor">90 m<sup>2</sup></span></li>
          <li class="icono habitaciones"><span class="valor">3</span></li>
          <li class="icono banos"><span class="valor">2</span></li>
        </ul></section>"""
        connector = AltamiraConnector()
        raw = RawListing(
            external_id="1",
            source=connector.name,
            raw={
                "url": "https://www.altamirainmuebles.com/venta-de-piso/x/y/"
                "segunda-mano/R/1/1",
                "html": html,
            },
        )
        c = connector.normalize(raw)
        assert c.m2_built == Decimal(90)
        assert c.rooms == 3
        assert c.bathrooms == 2


class TestHelpers:
    def test_clean_ws_undoes_escaped_capture_whitespace(self):
        assert _clean_ws("\\n\\t\\tHola  mundo\\n\\t") == "Hola mundo"
        assert _clean_ws("   ") is None
        assert _clean_ws(None) is None

    @pytest.mark.parametrize(
        "text,expected",
        [
            ("216.724,25", Decimal("216724.25")),
            ("50.400", Decimal(50400)),
            ("1.234.567", Decimal(1234567)),
            ("no digits", None),
        ],
    )
    def test_es_price_parsing(self, text, expected):
        assert _es_price_to_decimal(text) == expected


class TestDiscoveryIsRefused:
    def test_discover_raises(self):
        with pytest.raises(ConnectorError):
            AltamiraConnector().discover(object(), lambda: None)

    def test_fetch_detail_raises(self):
        with pytest.raises(ConnectorError):
            AltamiraConnector().fetch_detail("375859", lambda: None)
