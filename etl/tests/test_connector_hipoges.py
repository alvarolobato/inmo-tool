"""Unit tests for the Hipoges capture connector (issue #207, D-111).

UNLIKE test_connector_altamira.py / test_connector_aliseda.py, `normalize()`
here is exercised against a SYNTHETIC, entirely fabricated fixture
(etl/tests/fixtures/hipoges_detail_SYNTHETIC.html) — no real Hipoges capture
exists yet (D-075's walled enumeration + the Angular-shell chicken-and-egg
problem D-111 records). These tests prove the PARSER LOGIC behaves as
intended (reads the right node, degrades to None on a miss, never lets a
"similar properties" neighbour's figures leak into the subject property) —
they prove NOTHING about whether the selectors match the real site. Every
selector under test MUST be revalidated against the owner's first real
capture (the calibration issue linked from D-111), the same way issue #266
replaced Aliseda's originally-fabricated fixture with real ones.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors.base import ConnectorError, RawListing
from etl.connectors.hipoges import HipogesConnector

_FIXTURES = Path(__file__).parent / "fixtures"
_URL = "https://realestate.hipoges.com/es/detail/99001"


def _normalize(html: str, url: str = _URL, external_id: str = "99001"):
    connector = HipogesConnector()
    raw = RawListing(
        external_id=external_id, source=connector.name, raw={"url": url, "html": html}
    )
    return connector.normalize(raw)


def _fixture_html() -> str:
    return (_FIXTURES / "hipoges_detail_SYNTHETIC.html").read_text(encoding="utf-8")


class TestExternalIdFromUrl:
    @pytest.mark.parametrize(
        "url,expected",
        [
            ("https://realestate.hipoges.com/es/detail/99001", "99001"),
            (
                "https://realestate.hipoges.com/es/detail/99001/contact-received",
                "99001",
            ),
            ("https://realestate.hipoges.com/es/detail/99001/unavailable", "99001"),
            ("https://realestate.hipoges.com/es/npl/detail/ABC-123", "ABC-123"),
            ("https://realestate.hipoges.com/pt/detail/99001?utm=x#foto", "99001"),
            # Search/listing/home pages — no id.
            ("https://realestate.hipoges.com/es/sale/flat/spain/madrid", None),
            ("https://realestate.hipoges.com/", None),
            ("https://realestate.hipoges.com/es", None),
        ],
    )
    def test_extracts_id(self, url, expected):
        assert HipogesConnector.external_id_from_url(url) == expected


class TestNormalizeSyntheticFixture:
    """Every assertion here is pinned to the FABRICATED fixture, not a real
    page — see module docstring."""

    def test_core_fields_extracted(self):
        c = _normalize(_fixture_html())
        assert c.source == "hipoges"
        assert c.external_id == "99001"
        assert c.url == _URL
        assert c.listing_kind == "agency"
        assert c.status == "active"
        assert c.operation == "sale"
        assert c.property_type == "piso"
        assert c.current_price == Decimal(185000)
        assert c.m2_built == Decimal(90)
        assert c.rooms == 3
        assert c.bathrooms == 2
        assert c.reference_code == "HIP-99001-ES"
        assert c.contact_raw is None
        assert c.cadastral_ref is None
        assert c.address is None  # never guessed — see module docstring
        assert c.city is None
        assert c.province is None

    def test_contamination_guard_excludes_neighbour_figures(self):
        """The 'similar properties' carousel embeds a DIFFERENT property's
        price/m2/rooms/baths (999.999 €, 210 m2, 6 hab, 5 baños). None of
        those must leak into the subject property's fields — proving the
        contamination-drop guard actually does something, not just that it
        exists in the source."""
        c = _normalize(_fixture_html())
        assert c.current_price != Decimal(999999)
        assert c.current_price == Decimal(185000)
        assert c.m2_built != Decimal(210)
        assert c.rooms != 6
        assert c.bathrooms != 5

    def test_photos_exclude_neighbour_gallery(self):
        c = _normalize(_fixture_html())
        assert len(c.photo_urls) == 2
        assert all("hip-99001" in u for u in c.photo_urls)
        assert not any("neighbour" in u for u in c.photo_urls)
        assert all(
            u.startswith("https://realestate.hipoges.com/") for u in c.photo_urls
        )
        # Deduped, order preserved.
        assert len(set(c.photo_urls)) == len(c.photo_urls)

    def test_description_provenance_and_draft_flag(self):
        c = _normalize(_fixture_html())
        assert c.description and "reformado" in c.description
        assert c.raw_extra["capture_source"] == "browser-extension"
        assert c.raw_extra["capture_portal"] == "hipoges"
        assert c.raw_extra["selectors_calibrated"] is False

    def test_price_mutation_is_caught(self):
        """Revert-and-confirm-fail: corrupt the fixture's asset-price value
        and the extracted price must change — proving it is genuinely parsed,
        not hard-coded/coincidental."""
        html = _fixture_html()

        def price_of(h: str):
            return _normalize(h).current_price

        assert price_of(html) == Decimal(185000)
        mutated = html.replace(
            '<span class="asset-price">185.000 €</span>',
            '<span class="asset-price">222.500 €</span>',
        )
        assert mutated != html
        assert price_of(mutated) == Decimal(222500)


class TestHonestDegradation:
    """An un-hydrated / empty-shell capture (a plain GET, or a capture taken
    before Angular finished rendering) must degrade to Nones, never fabricate
    a value — the real shape realestate.hipoges.com returns to any
    non-browser fetch (see hipoges.py's module docstring)."""

    _EMPTY_SHELL = """<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Hipoges</title></head>
<body><app-root></app-root><script src="/main-x.js"></script></body></html>"""

    def test_empty_shell_degrades_to_nones(self):
        c = _normalize(self._EMPTY_SHELL, external_id="1")
        assert c.current_price is None
        assert c.m2_built is None
        assert c.rooms is None
        assert c.bathrooms is None
        assert c.reference_code is None
        assert c.photo_urls == ()
        assert c.property_type is None
        assert c.operation is None


class TestFeatureRegexParsers:
    """Best-effort text-mining parsers exercised directly against small
    hand-built strings (a parser unit test, not the full fabricated fixture)."""

    def test_m2_rooms_baths_patterns(self):
        from etl.connectors.hipoges import (
            _BATHS_RE,
            _M2_RE,
            _ROOMS_RE,
            _first_match_decimal,
            _first_match_int,
        )

        text = "Piso de 87 m2 con 2 hab. y 1 baño reformado"
        assert _first_match_decimal(_M2_RE, text) == Decimal(87)
        assert _first_match_int(_ROOMS_RE, text) == 2
        assert _first_match_int(_BATHS_RE, text) == 1

    def test_no_match_returns_none(self):
        from etl.connectors.hipoges import (
            _BATHS_RE,
            _M2_RE,
            _ROOMS_RE,
            _first_match_decimal,
            _first_match_int,
        )

        assert _first_match_decimal(_M2_RE, "sin datos") is None
        assert _first_match_int(_ROOMS_RE, "sin datos") is None
        assert _first_match_int(_BATHS_RE, "sin datos") is None


class TestDiscoveryIsRefused:
    def test_scope_key_always_none(self):
        assert HipogesConnector().scope_key(object()) is None

    def test_discover_raises(self):
        with pytest.raises(ConnectorError):
            HipogesConnector().discover(object(), lambda: None)

    def test_fetch_detail_raises(self):
        with pytest.raises(ConnectorError):
            HipogesConnector().fetch_detail("99001", lambda: None)
