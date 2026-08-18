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

Opus review (PR #548, C2) added a hard gate: `hipoges._SELECTORS_CALIBRATED`
is False today, so `normalize()` forces every draft-derived field (price,
m2, rooms, bathrooms, reference code, photos, property_type, operation) to
None/() regardless of what the draft extractors would have found — only
external_id/url/status/listing_kind and the OpenGraph title/description are
ever populated. `TestNormalizeGatedByDefault` proves that gate holds against
the rich fixture; `TestCalibratedWiring` monkeypatches the gate on to prove
the wiring underneath it still works (so a future #547 calibration PR that
just flips the constant doesn't ALSO have to debug wiring that silently rotted);
`TestDraftExtractors` unit-tests the draft functions directly, independent of
either.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors import hipoges as hipoges_module
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


class TestNormalizeGatedByDefault:
    """`_SELECTORS_CALIBRATED` is False in this codebase today — proves the
    gate actually suppresses every draft-derived field even against a
    fixture that HAS all of them (price, m2, rooms, baths, reference,
    photos, property_type, operation), not just against an empty shell
    (that's `TestHonestDegradation` below, a weaker/different property)."""

    def test_gate_is_off_in_this_codebase(self):
        # If this ever flips, TestCalibratedWiring stops being the only path
        # that exercises the real extraction — see that class's docstring.
        assert hipoges_module._SELECTORS_CALIBRATED is False

    def test_draft_fields_all_none_despite_rich_fixture(self):
        c = _normalize(_fixture_html())
        assert c.current_price is None
        assert c.m2_built is None
        assert c.rooms is None
        assert c.bathrooms is None
        assert c.reference_code is None
        assert c.photo_urls == ()
        assert c.property_type is None
        assert c.operation is None

    def test_grounded_fields_still_populated(self):
        c = _normalize(_fixture_html())
        assert c.source == "hipoges"
        assert c.external_id == "99001"
        assert c.url == _URL
        assert c.listing_kind == "agency"
        assert c.status == "active"
        assert c.contact_raw is None
        assert c.cadastral_ref is None
        assert c.address is None
        assert c.city is None
        assert c.province is None

    def test_title_and_description_are_opengraph_only(self):
        """The fixture's h1 ("Piso en venta en Madrid") and its
        `.asset-description` div text both differ from the og:title/
        og:description meta tags — proving title/description come from
        OpenGraph meta ONLY (Opus review, PR #548, C2), not an h1/class-based
        DOM guess."""
        c = _normalize(_fixture_html())
        assert c.raw_extra["title"] == "Piso en venta en Madrid, Hipoges"
        assert c.description == (
            "Piso reformado con 3 habitaciones y 2 baños en el centro de Madrid."
        )
        # The h1/desc-div text is NOT what got picked.
        assert c.raw_extra["title"] != "Piso en venta en Madrid"
        assert "luminoso" not in (c.description or "")

    def test_raw_extra_provenance_and_draft_flag(self):
        c = _normalize(_fixture_html())
        assert c.raw_extra["capture_source"] == "browser-extension"
        assert c.raw_extra["capture_portal"] == "hipoges"
        assert c.raw_extra["selectors_calibrated"] is False


class TestCalibratedWiring:
    """Monkeypatches `_SELECTORS_CALIBRATED` True for the duration of each
    test (auto-reverted by pytest's monkeypatch fixture) to prove the
    extraction PIPELINE underneath the gate still genuinely works — the same
    assertions PR #548's original (pre-review) test suite made before the
    gate existed. This is what #547's calibration PR inherits once real
    selectors replace the draft ones; it must not have silently rotted."""

    def test_core_fields_extracted_once_calibrated(self, monkeypatch):
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", True)
        c = _normalize(_fixture_html())
        assert c.operation == "sale"
        assert c.property_type == "piso"
        assert c.current_price == Decimal(185000)
        assert c.m2_built == Decimal(90)
        assert c.rooms == 3
        assert c.bathrooms == 2
        assert c.reference_code == "HIP-99001-ES"
        assert c.raw_extra["selectors_calibrated"] is True

    def test_contamination_guard_excludes_neighbour_figures(self, monkeypatch):
        """The 'similar properties' carousel embeds a DIFFERENT property's
        price/m2/rooms/baths (999.999 €, 210 m2, 6 hab, 5 baños). None of
        those must leak into the subject property's fields — proving the
        contamination-drop guard actually does something, not just that it
        exists in the source."""
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", True)
        c = _normalize(_fixture_html())
        assert c.current_price != Decimal(999999)
        assert c.current_price == Decimal(185000)
        assert c.m2_built != Decimal(210)
        assert c.rooms != 6
        assert c.bathrooms != 5

    def test_photos_exclude_neighbour_gallery(self, monkeypatch):
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", True)
        c = _normalize(_fixture_html())
        assert len(c.photo_urls) == 2
        assert all("hip-99001" in u for u in c.photo_urls)
        assert not any("neighbour" in u for u in c.photo_urls)
        assert all(
            u.startswith("https://realestate.hipoges.com/") for u in c.photo_urls
        )
        # Deduped, order preserved.
        assert len(set(c.photo_urls)) == len(c.photo_urls)

    def test_price_mutation_is_caught(self, monkeypatch):
        """Revert-and-confirm-fail: corrupt the fixture's asset-price value
        and the extracted price must change — proving it is genuinely parsed,
        not hard-coded/coincidental."""
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", True)
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
    non-browser fetch (see hipoges.py's module docstring). True regardless of
    the calibration gate — an empty shell has nothing for even a calibrated
    selector to find."""

    _EMPTY_SHELL = """<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Hipoges</title></head>
<body><app-root></app-root><script src="/main-x.js"></script></body></html>"""

    def test_empty_shell_degrades_to_nones_gate_off(self):
        c = _normalize(self._EMPTY_SHELL, external_id="1")
        assert c.current_price is None
        assert c.m2_built is None
        assert c.rooms is None
        assert c.bathrooms is None
        assert c.reference_code is None
        assert c.photo_urls == ()
        assert c.property_type is None
        assert c.operation is None

    def test_empty_shell_degrades_to_nones_gate_on(self, monkeypatch):
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", True)
        c = _normalize(self._EMPTY_SHELL, external_id="1")
        assert c.current_price is None
        assert c.m2_built is None
        assert c.rooms is None
        assert c.bathrooms is None
        assert c.reference_code is None
        assert c.photo_urls == ()
        assert c.property_type is None
        assert c.operation is None


class TestDraftExtractors:
    """Direct unit tests of the DRAFT extractor functions, independent of
    `normalize()`/the calibration gate — this is the "clearly marked and
    unit-tested" half of the Opus review's C2 ask (PR #548): the guessed
    selectors stay exercised so they don't silently bit-rot while gated off,
    and flipping `_SELECTORS_CALIBRATED` later is a one-line change with a
    known-working pipeline underneath it."""

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

    def test_price_from_dom(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _price_from_dom

        soup = BeautifulSoup('<div class="asset-price">150.000 €</div>', "html.parser")
        assert _price_from_dom(soup) == Decimal(150000)

    def test_price_from_dom_no_match_returns_none(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _price_from_dom

        soup = BeautifulSoup("<div>nada aquí</div>", "html.parser")
        assert _price_from_dom(soup) is None

    def test_photos_harvests_carousel_named_gallery(self):
        """Opus review (PR #548, C1): a real Angular property page's MAIN
        gallery is very plausibly named `*-carousel` (the synthetic
        fixture's `asset-gallery` name was too convenient to catch this).
        Confirms the fix: `_photos()` must NOT come back empty for a
        carousel-named gallery once contamination-drop no longer treats
        "carousel" as contamination."""
        from bs4 import BeautifulSoup

        from etl.connectors.extraction import scoped_node
        from etl.connectors.hipoges import _CONTAMINATION_SELECTORS, _photos

        html = (
            '<div class="image-carousel">'
            '<img src="/assets/a.jpg"><img src="/assets/b.jpg">'
            "</div>"
        )
        soup = BeautifulSoup(html, "html.parser")
        scoped = scoped_node(soup, drop=_CONTAMINATION_SELECTORS)
        photos = _photos(scoped, "https://realestate.hipoges.com/es/detail/1")
        assert photos == (
            "https://realestate.hipoges.com/assets/a.jpg",
            "https://realestate.hipoges.com/assets/b.jpg",
        )

    def test_photos_still_excludes_similar_properties_carousel(self):
        """The contamination guard still drops a rail explicitly named
        "similar"/"related"/"recommend" — only the bare word "carousel" was
        removed from the contamination list (C1), not the guard itself."""
        from bs4 import BeautifulSoup

        from etl.connectors.extraction import scoped_node
        from etl.connectors.hipoges import _CONTAMINATION_SELECTORS, _photos

        html = (
            '<div class="main-gallery"><img src="/assets/subject.jpg"></div>'
            '<div class="similar-properties-carousel">'
            '<img src="/assets/neighbour.jpg"></div>'
        )
        soup = BeautifulSoup(html, "html.parser")
        scoped = scoped_node(soup, drop=_CONTAMINATION_SELECTORS)
        photos = _photos(scoped, "https://realestate.hipoges.com/es/detail/1")
        assert photos == ("https://realestate.hipoges.com/assets/subject.jpg",)

    def test_photos_no_page_url_returns_empty(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _photos

        soup = BeautifulSoup(
            '<div class="gallery"><img src="/a.jpg"></div>', "html.parser"
        )
        assert _photos(soup, None) == ()

    def test_map_property_type_and_operation(self):
        from etl.connectors.hipoges_mapping import map_operation, map_property_type

        assert map_property_type("Piso en venta en Madrid") == "piso"
        assert map_operation("Piso en venta en Madrid") == "sale"
        assert map_property_type(None) is None
        assert map_operation(None) is None

    def test_map_property_type_word_boundary_fix(self):
        """Opus review (PR #548, N2): a plain substring match misfiled any
        title whose LOCATION contains a type word — "Plaza de garaje en
        venta en Casares" contains "casa" inside "Casares" and was
        (pre-fix) bucketed "chalet" instead of "garaje". Word-boundary
        matching (`_TYPE_PATTERNS`) fixes it."""
        from etl.connectors.hipoges_mapping import map_property_type

        assert map_property_type("Plaza de garaje en venta en Casares") == "garaje"
        assert map_property_type("Casa en venta en Sevilla") == "chalet"


class TestDiscoveryIsRefused:
    def test_scope_key_always_none(self):
        assert HipogesConnector().scope_key(object()) is None

    def test_discover_raises(self):
        with pytest.raises(ConnectorError):
            HipogesConnector().discover(object(), lambda: None)

    def test_fetch_detail_raises(self):
        with pytest.raises(ConnectorError):
            HipogesConnector().fetch_detail("99001", lambda: None)
