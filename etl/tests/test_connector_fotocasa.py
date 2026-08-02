"""Fixture-based tests for the Fotocasa connector (issue #12, Phase 1.4).

No live network calls — discover()/fetch_detail() are exercised by
monkeypatching requests.get to return saved fixture HTML, so this suite
doesn't depend on network access and won't break the moment Fotocasa
changes its markup (only the fixtures + the parsing code need updating
together, deliberately, not silently via a flaky live test).
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope, RawListing
from etl.connectors.fotocasa import FotocasaConnector

_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.fotocasa.es/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def test_fotocasa_does_not_claim_full_inventory_coverage():
    """Phase 1 phase-level review finding: discover() only ever sees page 1
    of real search results (robots.txt disallows pagination) against a real
    inventory in the thousands — discovers_full_inventory=False is what
    stops the orchestrator from ever auto-marking a Fotocasa listing
    withdrawn just because one sweep didn't happen to surface it."""
    assert FotocasaConnector.discovers_full_inventory is False


class TestDiscover:
    def test_discover_finds_unique_external_ids_from_search_page(self):
        html = _read_fixture("fotocasa_sample_search.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # Three distinct listings in the fixture; one linked twice (main
        # card + similar-listings widget) and one gallery-thumbnail href
        # with a query string that must NOT match (see fixture comments).
        assert sorted(ids) == ["190011971", "190022222", "190033333"]

    def test_center_based_scope_requests_the_matching_city_slug_not_madrid(self):
        """Issue #71 review finding: nearest_city() itself was tested, but
        never end-to-end through a real connector's discover() — the actual
        request URL a center-based (not geography-string) scope produces
        was unverified. A Sevilla-centered profile must request Fotocasa's
        Sevilla slug, not silently default to Madrid."""
        html = _read_fixture("fotocasa_sample_search.html")
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(center=(37.3891, -5.9845), radius_km=15),
                throttle=lambda: None,
            )
        requested_url = mock_get.call_args.args[0]
        assert "sevilla-capital" in requested_url
        assert "madrid" not in requested_url

    def test_discover_raises_on_soft_block_page_not_empty_list(self):
        """PR #49 review finding: Fotocasa's interruption page returns HTTP
        200 with no __initial_props__ tag — discover() must raise, not
        return []. An empty list would be misread by the orchestrator's
        withdrawal reconciliation as "every listing just disappeared"."""
        html = _read_fixture("fotocasa_sample_block_page.html")
        connector = FotocasaConnector()
        with (
            patch(
                "etl.connectors.fotocasa.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__initial_props__"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )

    def test_rooms_filter_is_appended_to_the_request_url(self):
        """Issue #99: rooms-count filtering via URL path segment was
        confirmed live to genuinely narrow Fotocasa's results (an EXACT
        match — every result in the live sample had exactly N rooms, none
        more — hence `rooms`, not `min_rooms`), not just an SEO alias — a
        scope carrying `rooms` must produce a request URL with that
        segment, and a scope without it must not."""
        html = _read_fixture("fotocasa_sample_search.html")
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital", rooms=2),
                throttle=lambda: None,
            )
        requested_url = mock_get.call_args.args[0]
        assert "/2-habitaciones/" in requested_url

        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ) as mock_get_no_filter:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        unfiltered_url = mock_get_no_filter.call_args.args[0]
        assert "habitaciones" not in unfiltered_url

    def test_rooms_filter_discovers_a_genuinely_different_listing_set(self):
        """Stronger than the URL-shape assertion above: a real filtered
        response must parse into a different set of listing IDs than the
        unfiltered response, not just hit a URL with the right substring.
        Uses a dedicated fixture with non-overlapping IDs specifically so
        this can't pass by coincidence (e.g. a connector bug that ignores
        `rooms` entirely and always parses the same fixture-shaped page
        would still pass a URL-only assertion, but would fail this one)."""
        unfiltered_html = _read_fixture("fotocasa_sample_search.html")
        filtered_html = _read_fixture("fotocasa_sample_search_2_habitaciones.html")

        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(filtered_html),
        ):
            filtered_ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital", rooms=2),
                throttle=lambda: None,
            )
        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(unfiltered_html),
        ):
            unfiltered_ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )

        assert sorted(filtered_ids) == ["290044444", "290055555"]
        assert sorted(unfiltered_ids) == ["190011971", "190022222", "190033333"]
        assert set(filtered_ids).isdisjoint(unfiltered_ids)

    def test_scope_key_distinguishes_rooms_from_unfiltered(self):
        """Two scopes with the same geography but a different `rooms`
        filter must not be treated as the same crawl target by the
        orchestrator's seen_scope_keys dedup — they hit different URLs."""
        connector = FotocasaConnector()
        unfiltered = connector.scope_key(ConnectorScope(geography="madrid-capital"))
        filtered = connector.scope_key(
            ConnectorScope(geography="madrid-capital", rooms=2)
        )
        assert unfiltered != filtered
        assert unfiltered == connector.scope_key(
            ConnectorScope(geography="madrid-capital")
        )

    def test_discover_rejects_robots_txt_disallowed_bare_geography(self):
        """robots.txt disallows the literal "/madrid/" path segment (not the
        hyphenated "madrid-capital" this connector's default uses) — a
        caller passing the bare city name must be rejected before any
        request is made, not silently sent."""
        connector = FotocasaConnector()
        with (
            patch("etl.connectors.fotocasa.requests.get") as mock_get,
            pytest.raises(ConnectorError, match="robots.txt"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        mock_get.assert_not_called()


class TestNormalize:
    def test_normalize_matches_expected_fixture(self):
        """EC-3: fetch_detail + normalize on a saved fixture produce the exact expected output."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.external_id == "190011971"
        assert canonical.source == "fotocasa"
        assert canonical.current_price == Decimal(205000)
        assert canonical.property_type == "piso"
        assert canonical.rooms == 3
        assert canonical.bathrooms == 1
        assert canonical.m2_built == Decimal(74)
        # Human-readable value from featuresList, NOT the coded
        # features.floor=3 integer (that would be fabricated precision —
        # see docs/skills/connectors.md and the fixture's own comment).
        assert canonical.floor == "2ª planta"
        assert canonical.has_elevator is True
        assert canonical.energy_rating == "G"
        assert canonical.raw_extra["floor_code_raw"] == 3
        assert canonical.lat == Decimal("40.382233")
        assert canonical.lon == Decimal("-3.6102757")
        assert canonical.listing_kind == "agency"  # clientUrl contains /inmobiliaria-
        assert canonical.address == "Santa Eugenia, Villa de Vallecas, Madrid Capital"
        assert len(canonical.photo_urls) == 2
        assert canonical.raw_extra["buildingType_raw"] == "Flat"

    def test_normalize_leaves_listing_kind_none_without_a_positive_agency_signal(self):
        """PR #49 review finding: defaulting to 'particular' whenever a name/
        URL exists at all (but neither agency signal matched) was itself an
        unverified guess. Absence of an agency signal must yield None, not
        an inferred 'particular'."""
        raw = RawListing(
            external_id="999",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "clientName": "Juan Perez",
                        "clientUrl": None,
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.listing_kind is None

    def test_normalize_excludes_non_image_multimedia_from_photo_urls(self):
        """Fable phase-2 review finding: a real listing's multimedia array
        mixes real photos with other asset types (observed live:
        {"type": "tour-virtual", "src": "https://floorfy.com/..."}) — only
        type="image" entries belong in photo_urls, otherwise a virtual-tour
        link renders as a broken <img> on the property detail page and gets
        fed (uselessly) to the photo-hash dedup signal."""
        raw = RawListing(
            external_id="997",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [
                            {
                                "type": "tour-virtual",
                                "src": "https://floorfy.com/tour/abc",
                            },
                            {
                                "type": "image",
                                "src": "https://static.fotocasa.es/a.jpg",
                            },
                            {
                                "type": "image",
                                "src": "https://static.fotocasa.es/b.jpg",
                            },
                            {"src": "https://static.fotocasa.es/no-type.jpg"},
                        ],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.photo_urls == (
            "https://static.fotocasa.es/a.jpg",
            "https://static.fotocasa.es/b.jpg",
        )

    def test_normalize_still_infers_agency_from_client_url(self):
        raw = RawListing(
            external_id="998",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "clientName": "Some Agency SL",
                        "clientUrl": "/es/inmobiliaria-some-agency/comprar/l",
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.listing_kind == "agency"

    def test_normalize_has_elevator_none_when_featuresList_lacks_the_label(self):
        raw = RawListing(
            external_id="997",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "featuresList": [{"label": "floor", "value": "Bajo"}],
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.has_elevator is None
        assert canonical.floor == "Bajo"

    def test_normalize_does_not_fabricate_year_built_from_antiquity_bucket(self):
        """antiquity is a coded bucket, not a literal year — must stay None, not guessed."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.year_built is None
        assert canonical.raw_extra["antiquity"] == 7


class TestFallbackChain:
    """Issue #77: property_web_scraper's es_fotocasa.json mapping keeps a
    CSS-selector fallback for exactly these four fields (their embedded-JSON
    path is the fragile part most likely to shift on a redesign). Their own
    selectors no longer match the live site as of this connector's own
    live spot-check (2026-08-02) — Fotocasa migrated to a Tailwind-utility
    design system with no semantic BEM classes. These fallback selectors
    are freshly verified against a real listing instead (icon-anchored via
    `data-title`, not layout classes) — see fotocasa.py's
    `_icon_stat_text`/`_price_fallback_text` docstrings.
    """

    def test_falls_back_to_css_when_json_fields_are_null(self):
        html = _read_fixture("fotocasa_sample_detail_fallback.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190099999", throttle=lambda: None)
        canonical = connector.normalize(raw)

        # Values baked into the fixture's HTML match the real listing this
        # fixture is modeled on (external_id 189316512) — this is also a
        # live-data regression check, not just "some fallback fired".
        assert canonical.rooms == 2
        assert canonical.bathrooms == 2
        assert canonical.m2_built == Decimal(60)
        assert canonical.current_price == Decimal(379000)
        # reference_code (issue #72): absent from this fixture's JSON
        # (no "reference" key in realEstate), recovered from the
        # ".re-FormContactDetail-referenceAlias" CSS fallback.
        assert canonical.reference_code == "XY789"

    def test_json_path_wins_over_css_when_both_are_present(self):
        """The fallback chain must not override a perfectly good JSON
        value just because HTML markup also happens to be present.

        Uses genuinely different, non-empty values on both paths (JSON:
        3/1/74/205000; HTML: 9/9/999/999000) — a version of this test that
        only has real markup on the JSON side can't distinguish "JSON wins
        because it's tried first" from "JSON is the only side with a
        value" (Opus review, PR #84: the prior fixture had no icon markup
        at all).
        """
        raw = RawListing(
            external_id="993",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 205000,
                        "address": {},
                        "coordinates": {},
                        "features": {"rooms": 3, "bathrooms": 1, "surface": 74},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": (
                    '<div aria-label="Precio del inmueble"><span>999.000 €</span></div>'
                    '<ul aria-label="Características principales">'
                    '<li><svg data-title="double_bed"></svg>'
                    '<span class="text-body-1"><span class="font-bold">9</span> habs.</span></li>'
                    '<li><svg data-title="bathroom_tub"></svg>'
                    '<span class="text-body-1"><span class="font-bold">9</span> baños</span></li>'
                    '<li><svg data-title="dimensions_block"></svg>'
                    '<span class="text-body-1"><span class="font-bold">999</span> m²</span></li>'
                    "</ul>"
                ),
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.rooms == 3
        assert canonical.bathrooms == 1
        assert canonical.m2_built == Decimal(74)
        assert canonical.current_price == Decimal(205000)

    def test_css_fallback_also_returns_none_when_html_lacks_the_markup_too(self):
        """Belt-and-braces: a listing where both JSON and HTML are missing
        the field must not crash and must yield None, not a stray 0/False
        from a getter that partially matched."""
        raw = RawListing(
            external_id="996",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": None,
                        "address": {},
                        "coordinates": {},
                        "features": {"rooms": None, "bathrooms": None, "surface": None},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body>no markup here</body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.rooms is None
        assert canonical.bathrooms is None
        assert canonical.m2_built is None
        assert canonical.current_price is None


class TestReferenceCode:
    """Issue #72: seller/agency reference code — e.g. "Referencia: NS603"
    live-verified (2026-08-02) against the real Sevilla listing cited in
    that issue (`realEstate.reference` matches the rendered
    ".re-FormContactDetail-referenceAlias" text exactly on that listing).
    The CSS-fallback path is covered by
    TestFallbackChain.test_falls_back_to_css_when_json_fields_are_null.
    """

    def test_extracts_reference_from_json_primary_path(self):
        raw = RawListing(
            external_id="992",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "reference": "NS603",
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.reference_code == "NS603"

    def test_missing_reference_yields_none_not_empty_string(self):
        raw = RawListing(
            external_id="991",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body>no reference markup here</body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.reference_code is None


class TestSchemaSupersetFields:
    """Issue #77's AC: city/province/postal_code/m2_plot populated from data
    this connector already parses but previously flattened into `address`
    or dropped into `raw_extra` only."""

    def test_populates_city_province_postal_code_and_m2_plot(self):
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.city == "Madrid Capital"
        assert canonical.province == "Madrid"
        assert canonical.postal_code == "28031"
        # This fixture's surfaceLand is 0, which means "not a plot-having
        # property type", not "a real zero-m² plot" — treated as absent
        # (Opus review, PR #84; see the dedicated m2_plot test below for a
        # real non-zero value).
        assert canonical.m2_plot is None

    def test_m2_plot_nonzero_surface_land_is_preserved(self):
        raw = RawListing(
            external_id="994",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 500000,
                        "address": {},
                        "coordinates": {},
                        "features": {"surfaceLand": 850},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body></body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.m2_plot == Decimal(850)

    def test_operation_is_always_sale_for_this_connector(self):
        """This connector only ever requests Fotocasa's /comprar/ URLs —
        it has no rental discover()/fetch_detail() path at all, so
        operation='sale' reflects what the connector structurally is, not
        an unverified default masking missing data."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.operation == "sale"

    def test_missing_address_fields_yield_none_not_empty_string(self):
        raw = RawListing(
            external_id="995",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body></body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.city is None
        assert canonical.province is None
        assert canonical.postal_code is None
        assert canonical.m2_plot is None


class TestPriceChangeHistory:
    def test_price_change_between_fetches_produces_different_canonical_prices(self):
        """EC-4 (connector half): two fetches of the same external_id with a
        changed price normalize to two different current_price values — the
        orchestrator (tested separately in test_orchestrator.py against real
        Postgres) is what turns that into an appended listing_price_history
        row rather than an overwrite; this test only proves the connector
        surfaces the real change for the orchestrator to act on.
        """
        connector = FotocasaConnector()
        html_before = _read_fixture("fotocasa_sample_detail.html")
        html_after = _read_fixture("fotocasa_sample_detail_price_changed.html")

        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(html_before),
        ):
            price_before = connector.normalize(
                connector.fetch_detail("190011971", throttle=lambda: None)
            ).current_price
        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(html_after),
        ):
            price_after = connector.normalize(
                connector.fetch_detail("190011971", throttle=lambda: None)
            ).current_price

        assert price_before == Decimal(205000)
        assert price_after == Decimal(195000)
        assert price_before != price_after
