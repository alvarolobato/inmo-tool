"""Unit tests for the Hipoges capture connector (issue #207/#547, D-111/D-146).

Exercised against a REAL fixture (`etl/tests/fixtures/hipoges_detail_RARE-
04347.html`) — trimmed from a real Hipoges capture (`extension_capture` ids
3614-3617, pulled read-only from production Postgres) rather than the
synthetic, hand-fabricated one this file used before #547 (removed — see
D-146). `_SELECTORS_CALIBRATED` is now `True`: `normalize()` writes
price/m2/rooms/bathrooms/reference_code/photo_urls/property_type/operation/
city/province from real, capture-grounded selectors.

**This is SINGLE-OBSERVATION confidence** — one property (RARE-04347), one
servicer template. `TestCalibratedExtraction` proves each field's real
value; `TestSelectorMutationBreaksExtraction` proves each assertion can
actually fail (breaks the underlying markup and confirms the extracted
value changes — a fixture that only matches the selector it was built
against is circular, per the #632 review finding this task was warned
about); `TestContaminationGuard` proves the real "similar properties" rail
(a custom element, `init-asset-detail-related-assets id="others"` — NOT a
similar/related/recommend CSS class, which is what the pre-#547 draft
guessed and which matches nothing on the real page) never bleeds into the
subject property's fields; `TestGateOffFallsBackToDraftBehavior` proves the
gate itself still works if a future regression flips `_SELECTORS_CALIBRATED`
back to `False`; `TestHonestDegradation` proves an empty/un-hydrated shell
still degrades to `None` regardless of the gate; `TestUnitExtractors`
exercises the extractor functions directly.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors import hipoges as hipoges_module
from etl.connectors.base import ConnectorError, RawListing
from etl.connectors.hipoges import HipogesConnector

_FIXTURES = Path(__file__).parent / "fixtures"
_URL = "https://realestate.hipoges.com/es/detail/RARE-04347"


def _normalize(html: str, url: str = _URL, external_id: str = "RARE-04347"):
    connector = HipogesConnector()
    raw = RawListing(
        external_id=external_id, source=connector.name, raw={"url": url, "html": html}
    )
    return connector.normalize(raw)


def _fixture_html() -> str:
    return (_FIXTURES / "hipoges_detail_RARE-04347.html").read_text(encoding="utf-8")


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
            # The real 2026-08-21 captures (issue #547) all matched this
            # base-case shape — real confirmation, not just the route-table
            # grounding D-111 originally had.
            ("https://realestate.hipoges.com/es/detail/RARE-04347", "RARE-04347"),
            # Search/listing/home pages — no id.
            ("https://realestate.hipoges.com/es/sale/flat/spain/madrid", None),
            ("https://realestate.hipoges.com/", None),
            ("https://realestate.hipoges.com/es", None),
        ],
    )
    def test_extracts_id(self, url, expected):
        assert HipogesConnector.external_id_from_url(url) == expected


class TestCalibratedExtraction:
    """Every field's real value, read from the real RARE-04347 capture."""

    def test_grounded_fields(self):
        c = _normalize(_fixture_html())
        assert c.source == "hipoges"
        assert c.external_id == "RARE-04347"
        assert c.url == _URL
        assert c.listing_kind == "agency"
        assert c.status == "active"
        assert c.contact_raw is None

    def test_title_is_dom_h1_not_generic_og_meta(self):
        """The real page's og:title is generic site branding ("Venta y
        alquiler de inmuebles al mejor precio | Hipoges") — proven by the
        production DB's own extension_capture.title column carrying that
        exact string. The real per-listing title only exists in the <h1>."""
        c = _normalize(_fixture_html())
        assert c.raw_extra["title"] == "Piso en venta en urbanización Maria Teresa Leon"
        assert (
            c.raw_extra["title"]
            != "Venta y alquiler de inmuebles al mejor precio | Hipoges"
        )

    def test_description_is_dom_not_generic_og_meta(self):
        c = _normalize(_fixture_html())
        assert "Estepona" in c.description
        assert "alquilada" in c.description
        assert c.description != (
            "Encuentra aquí las mejores oportunidades de apartamentos, "
            "pisos, locales, naves y oficinas."
        )

    def test_price(self):
        c = _normalize(_fixture_html())
        assert c.current_price == Decimal(266000)

    def test_surface_rooms_baths(self):
        c = _normalize(_fixture_html())
        assert c.m2_built == Decimal(84)
        assert c.rooms == 3
        assert c.bathrooms == 2

    def test_reference_code(self):
        c = _normalize(_fixture_html())
        assert c.reference_code == "RARE-04347"

    def test_property_type_and_operation(self):
        c = _normalize(_fixture_html())
        assert c.property_type == "piso"
        assert c.operation == "sale"

    def test_city_and_province(self):
        """Previously hardcoded None ("not extractable without a real
        capture") — the real page proves otherwise."""
        c = _normalize(_fixture_html())
        assert c.city == "Estepona"
        assert c.province == "Málaga"

    def test_photos_are_only_the_subject_gallery(self):
        c = _normalize(_fixture_html())
        assert len(c.photo_urls) == 3
        assert all("rare-04347" in u for u in c.photo_urls)
        assert all(u.startswith("https://hipoges.azureedge.net/") for u in c.photo_urls)
        # The gallery's own photo-count badge icon must not appear.
        assert not any("/assets/" in u for u in c.photo_urls)

    def test_uncalibrated_fields_stay_none(self):
        """Fields observed on the real page but deliberately left
        uncalibrated (floor, energy rating) or genuinely absent (address,
        lat/lon, postal code, cadastral ref) — see D-146 for why."""
        c = _normalize(_fixture_html())
        assert c.floor is None
        assert c.energy_rating is None
        assert c.address is None
        assert c.lat is None
        assert c.lon is None
        assert c.postal_code is None
        assert c.cadastral_ref is None
        assert c.has_elevator is None
        assert c.year_built is None

    def test_raw_extra_provenance_and_calibration_flag(self):
        c = _normalize(_fixture_html())
        assert c.raw_extra["capture_source"] == "browser-extension"
        assert c.raw_extra["capture_portal"] == "hipoges"
        assert c.raw_extra["selectors_calibrated"] is True


class TestContaminationGuard:
    """The real "similar properties" rail (`init-asset-detail-related-assets
    id="others"`, containing `init-similar-card`) embeds a DIFFERENT
    property's own price/m2/photo. None of it must leak into the subject
    property's fields."""

    def test_price_excludes_neighbour(self):
        c = _normalize(_fixture_html())
        assert c.current_price != Decimal(251000)
        assert c.current_price == Decimal(266000)

    def test_m2_excludes_neighbour(self):
        c = _normalize(_fixture_html())
        assert c.m2_built != Decimal(119)
        assert c.m2_built == Decimal(84)

    def test_photos_exclude_neighbour(self):
        c = _normalize(_fixture_html())
        assert not any("gtre-01073" in u for u in c.photo_urls)
        assert not any("gentauro" in u for u in c.photo_urls)


class TestSelectorMutationBreaksExtraction:
    """Revert-and-confirm-fail: corrupt the specific fixture markup each
    selector reads and confirm the extracted value actually changes. A
    fixture that only matches the selector it was written against proves
    nothing (the #632 review finding this task was explicitly warned
    about) — these tests fail if the corresponding selector is deleted or
    stops reading real markup."""

    def test_price_mutation_is_caught(self):
        html = _fixture_html()
        assert _normalize(html).current_price == Decimal(266000)
        mutated = html.replace(">266.000&nbsp;€</span>", ">310.000&nbsp;€</span>")
        assert mutated != html
        assert _normalize(mutated).current_price == Decimal(310000)

    def test_m2_mutation_is_caught(self):
        html = _fixture_html()
        assert _normalize(html).m2_built == Decimal(84)
        mutated = html.replace(">84 <", ">120 <")
        assert mutated != html
        assert _normalize(mutated).m2_built == Decimal(120)

    def test_rooms_mutation_is_caught(self):
        html = _fixture_html()
        assert _normalize(html).rooms == 3
        mutated = html.replace(">3 <", ">5 <")
        assert mutated != html
        assert _normalize(mutated).rooms == 5

    def test_bathrooms_mutation_is_caught(self):
        html = _fixture_html()
        assert _normalize(html).bathrooms == 2
        mutated = html.replace(">2 <", ">4 <")
        assert mutated != html
        assert _normalize(mutated).bathrooms == 4

    def test_reference_code_mutation_is_caught(self):
        html = _fixture_html()
        assert _normalize(html).reference_code == "RARE-04347"
        mutated = html.replace("Referencia: RARE-04347", "Referencia: RARE-99999")
        assert mutated != html
        assert _normalize(mutated).reference_code == "RARE-99999"

    def test_property_type_mutation_is_caught(self):
        html = _fixture_html()
        assert _normalize(html).property_type == "piso"
        mutated = html.replace(">Piso</span>", ">Chalet</span>")
        assert mutated != html
        assert _normalize(mutated).property_type == "chalet"

    def test_operation_mutation_is_caught(self):
        html = _fixture_html()
        assert _normalize(html).operation == "sale"
        mutated = html.replace(" en venta ", " en alquiler ")
        assert mutated != html
        assert _normalize(mutated).operation == "rent"

    def test_city_province_mutation_is_caught(self):
        html = _fixture_html()
        c = _normalize(html)
        assert c.city == "Estepona"
        assert c.province == "Málaga"
        mutated = html.replace(
            '<span class="text-hp-gray-2 text-hp-xsmall">Estepona, Málaga</span>',
            '<span class="text-hp-gray-2 text-hp-xsmall">Sevilla, Sevilla</span>',
        )
        assert mutated != html
        mutated_c = _normalize(mutated)
        assert mutated_c.city == "Sevilla"
        assert mutated_c.province == "Sevilla"

    def test_photos_mutation_is_caught(self):
        html = _fixture_html()
        assert len(_normalize(html).photo_urls) == 3
        mutated = html.replace(
            '<img loading="lazy" alt="Third image" '
            'src="https://hipoges.azureedge.net/imageshams/hams_es_rand/'
            'rran01399/rare-04347/59180391_e063a3e750da99ede97f6ec256547606fdb47ff6.png">',
            "",
        )
        assert mutated != html
        assert len(_normalize(mutated).photo_urls) == 2

    def test_title_mutation_is_caught(self):
        html = _fixture_html()
        assert (
            _normalize(html).raw_extra["title"]
            == "Piso en venta en urbanización Maria Teresa Leon"
        )
        mutated = html.replace(
            "Piso en venta en urbanización Maria Teresa Leon",
            "Piso en venta en urbanización Otra Direccion",
        )
        assert mutated != html
        assert (
            _normalize(mutated).raw_extra["title"]
            == "Piso en venta en urbanización Otra Direccion"
        )

    def test_description_mutation_is_caught(self):
        html = _fixture_html()
        assert "alquilada" in _normalize(html).description
        mutated = html.replace("alquilada", "vacía")
        assert mutated != html
        assert "vacía" in _normalize(mutated).description
        assert "alquilada" not in _normalize(mutated).description


class TestOgMetaNeverCorruptsCalibratedFields:
    """Opus review (PR #657): the real og:title/og:description are generic
    site branding ("Venta y alquiler de inmuebles al mejor precio |
    Hipoges") — and that generic title's own word "alquiler" made
    map_operation() return "rent" for a real SALE listing whenever the
    real <h1> hadn't rendered yet, which browser-extension/detect.js's
    `readySelectors` gate (satisfied by `main` alone) does not prevent.
    Proves the fix: when calibrated but the DOM node is missing, title and
    description degrade straight to None — never to OG content — so
    operation/property_type (derived from title) degrade to None too,
    never to a wrong-but-plausible value."""

    # An Angular page that rendered <main> (satisfying detect.js's
    # readySelectors gate) but not yet the async listing content below it —
    # a real, reachable capture state, not a hypothetical. Carries the same
    # generic OG meta every real Hipoges page carries.
    _UNRENDERED_MAIN_HTML = """<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta property="og:title" content="Venta y alquiler de inmuebles al mejor precio | Hipoges">
<meta property="og:description" content="Encuentra aquí las mejores oportunidades de apartamentos, pisos, locales, naves y oficinas.">
</head><body><app-root><main></main></app-root></body></html>"""

    def test_operation_does_not_become_rent_for_a_sale_listing(self):
        c = _normalize(self._UNRENDERED_MAIN_HTML, external_id="RARE-04347")
        assert c.operation is None
        assert c.operation != "rent"

    def test_property_type_stays_none(self):
        c = _normalize(self._UNRENDERED_MAIN_HTML, external_id="RARE-04347")
        assert c.property_type is None

    def test_title_and_description_stay_none_not_og_content(self):
        c = _normalize(self._UNRENDERED_MAIN_HTML, external_id="RARE-04347")
        assert c.raw_extra["title"] is None
        assert c.description is None
        assert c.raw_extra["title"] != (
            "Venta y alquiler de inmuebles al mejor precio | Hipoges"
        )


class TestGateOffFallsBackToDraftBehavior:
    """Proves the calibration gate itself still works — if a future
    regression flips `_SELECTORS_CALIBRATED` back to False (e.g. a
    suspected site redesign), every DOM-derived field must degrade to
    None/OG-meta-only again, exactly like the pre-#547 shipped behaviour."""

    def test_draft_fields_all_none_when_gate_off(self, monkeypatch):
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", False)
        c = _normalize(_fixture_html())
        assert c.current_price is None
        assert c.m2_built is None
        assert c.rooms is None
        assert c.bathrooms is None
        assert c.reference_code is None
        assert c.photo_urls == ()
        assert c.property_type is None
        assert c.operation is None
        assert c.city is None
        assert c.province is None

    def test_title_description_fall_back_to_og_meta_when_gate_off(self, monkeypatch):
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", False)
        c = _normalize(_fixture_html())
        assert c.raw_extra["title"] == (
            "Venta y alquiler de inmuebles al mejor precio | Hipoges"
        )
        assert c.description == (
            "Encuentra aquí las mejores oportunidades de apartamentos, "
            "pisos, locales, naves y oficinas."
        )

    def test_raw_extra_flag_tracks_the_gate(self, monkeypatch):
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", False)
        c = _normalize(_fixture_html())
        assert c.raw_extra["selectors_calibrated"] is False

    def test_gate_is_on_in_this_codebase(self):
        """If this ever flips back to False, the test above proves the
        fallback path still works — this just documents current state."""
        assert hipoges_module._SELECTORS_CALIBRATED is True


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
        assert c.city is None
        assert c.province is None
        assert c.raw_extra["title"] is None
        assert c.description is None


class TestUnitExtractors:
    """Direct unit tests of the calibrated extractor functions, independent
    of `normalize()`/the gate."""

    def test_feature_card_value_matches_by_label_not_position(self):
        """The real page's energy-grade card renders value/label spans in
        the OPPOSITE order between mobile/desktop variants (both present at
        once) — proves `_feature_card_value` matches by label keyword, not
        a fixed span index."""
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _M2_LABEL_RE, _feature_card_value

        value_first = BeautifulSoup(
            "<init-feature-card><span>84 </span>"
            "<span>Metros cuadrados</span></init-feature-card>",
            "html.parser",
        )
        label_first = BeautifulSoup(
            "<init-feature-card><span>Metros cuadrados</span>"
            "<span>84 </span></init-feature-card>",
            "html.parser",
        )
        assert _feature_card_value(value_first, _M2_LABEL_RE) == 84
        assert _feature_card_value(label_first, _M2_LABEL_RE) == 84

    def test_feature_card_value_no_match_returns_none(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _M2_LABEL_RE, _feature_card_value

        soup = BeautifulSoup(
            "<init-feature-card><span>Trastero</span></init-feature-card>",
            "html.parser",
        )
        assert _feature_card_value(soup, _M2_LABEL_RE) is None

    def test_price_from_dom_label_sibling_pattern(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _price_from_dom

        soup = BeautifulSoup(
            "<div><span>Precio</span><span>150.000 €</span></div>", "html.parser"
        )
        assert _price_from_dom(soup) == Decimal(150000)

    def test_price_from_dom_no_label_falls_back_to_class_guess(self):
        """Never observed on the real page (0 matches) — kept only as a
        best-effort fallback for a possible different template."""
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _price_from_dom

        soup = BeautifulSoup('<div class="precio">150.000 €</div>', "html.parser")
        assert _price_from_dom(soup) == Decimal(150000)

    def test_price_from_dom_no_match_returns_none(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _price_from_dom

        soup = BeautifulSoup("<div>nada aquí</div>", "html.parser")
        assert _price_from_dom(soup) is None

    def test_detail_row_value(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _detail_row_value

        soup = BeautifulSoup(
            "<init-asset-detail-details>"
            '<div class="grid grid-cols-2"><span>Tipo de propiedad</span>'
            "<span>Piso</span></div>"
            "</init-asset-detail-details>",
            "html.parser",
        )
        assert _detail_row_value(soup, "Tipo de propiedad") == "Piso"
        assert _detail_row_value(soup, "Planta") is None

    def test_location_from_dom_splits_city_province(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _location_from_dom

        soup = BeautifulSoup(
            "<init-asset-detail-main-info>"
            '<img alt="Location icon"><span>Estepona, Málaga</span>'
            "</init-asset-detail-main-info>",
            "html.parser",
        )
        assert _location_from_dom(soup) == ("Estepona", "Málaga")

    def test_location_from_dom_no_comma(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _location_from_dom

        soup = BeautifulSoup(
            "<init-asset-detail-main-info>"
            '<img alt="Location icon"><span>Madrid</span>'
            "</init-asset-detail-main-info>",
            "html.parser",
        )
        assert _location_from_dom(soup) == ("Madrid", None)

    def test_location_from_dom_missing_returns_none_none(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _location_from_dom

        soup = BeautifulSoup(
            "<init-asset-detail-main-info></init-asset-detail-main-info>", "html.parser"
        )
        assert _location_from_dom(soup) == (None, None)

    def test_photos_harvests_only_gallery_container(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _photos

        html = (
            "<init-asset-detail-gallery>"
            '<img src="/assets/icons/camera.webp">'
            '<img src="/photos/a.jpg"><img src="/photos/b.jpg">'
            "</init-asset-detail-gallery>"
            '<init-asset-detail-related-assets id="others">'
            '<img src="/photos/neighbour.jpg">'
            "</init-asset-detail-related-assets>"
        )
        soup = BeautifulSoup(html, "html.parser")
        photos = _photos(soup, "https://realestate.hipoges.com/es/detail/1")
        assert photos == (
            "https://realestate.hipoges.com/photos/a.jpg",
            "https://realestate.hipoges.com/photos/b.jpg",
        )

    def test_photos_falls_back_to_class_guess_when_container_missing(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _photos

        html = '<div class="gallery"><img src="/photos/a.jpg"></div>'
        soup = BeautifulSoup(html, "html.parser")
        photos = _photos(soup, "https://realestate.hipoges.com/es/detail/1")
        assert photos == ("https://realestate.hipoges.com/photos/a.jpg",)

    def test_photos_no_page_url_returns_empty(self):
        from bs4 import BeautifulSoup

        from etl.connectors.hipoges import _photos

        soup = BeautifulSoup(
            '<init-asset-detail-gallery><img src="/a.jpg"></init-asset-detail-gallery>',
            "html.parser",
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
