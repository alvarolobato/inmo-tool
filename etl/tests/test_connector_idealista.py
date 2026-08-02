"""Tests for the Idealista connector (issue #75).

The fixture (etl/tests/fixtures/idealista_sample_detail.html) is trimmed
from a real captured Idealista page in RealEstateWebTools/property_web_scraper
— see browser-extension/NOTICE.md for attribution and idealista_mapping.py's
module docstring for what's real vs. best-effort in the field mapping. This
suite tests normalize() against that fixture; it does NOT make any live
network request (there is none to make — see idealista.py's module
docstring for why this connector never fetches Idealista directly).
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope, RawListing
from etl.connectors.idealista import IdealistaConnector

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "idealista_sample_detail.html"


def _read_fixture() -> str:
    return _FIXTURE_PATH.read_text(encoding="utf-8")


class TestScopeKeyNeverResolves:
    def test_scope_key_always_none(self):
        connector = IdealistaConnector()
        # A real (center, radius_km) scope, a bare geography string, and a
        # totally empty scope should all resolve to None — this connector
        # never participates in the orchestrator's automated sweep,
        # regardless of what a profile asks for.
        assert (
            connector.scope_key(ConnectorScope(center=(40.4168, -3.7038), radius_km=15))
            is None
        )
        assert connector.scope_key(ConnectorScope(geography="madrid-capital")) is None
        assert connector.scope_key(ConnectorScope()) is None


class TestDiscoverAndFetchDetailRaise:
    def test_discover_raises(self):
        connector = IdealistaConnector()
        with pytest.raises(ConnectorError, match="capture-only"):
            connector.discover(ConnectorScope(), throttle=lambda: None)

    def test_fetch_detail_raises(self):
        connector = IdealistaConnector()
        with pytest.raises(ConnectorError, match="never makes a live network request"):
            connector.fetch_detail("106387165", throttle=lambda: None)


class TestExternalIdFromUrl:
    def test_extracts_id_from_real_url_shape(self):
        url = "https://www.idealista.com/inmueble/106387165/"
        assert IdealistaConnector.external_id_from_url(url) == "106387165"

    def test_returns_none_for_unrecognized_url(self):
        assert (
            IdealistaConnector.external_id_from_url("https://www.idealista.com/")
            is None
        )


class TestNormalize:
    def test_normalize_matches_expected_fixture(self):
        """EC-1 style: fetch_detail's would-be output (here, a RawListing
        built directly from the fixture, since fetch_detail() never runs)
        -> normalize() produces the real, verified values from the
        trimmed real page (see module docstring)."""
        html = _read_fixture()
        raw = RawListing(
            external_id="106387165",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/106387165/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)

        assert canonical.external_id == "106387165"
        assert canonical.source == "idealista"
        assert canonical.status == "active"
        assert canonical.operation == "sale"
        assert canonical.current_price == Decimal(3600000)
        assert canonical.m2_built == Decimal(273)
        assert canonical.rooms == 4
        assert canonical.bathrooms == 5
        assert canonical.year_built == 1889
        assert canonical.has_elevator is True
        assert canonical.floor is not None and "5th floor" in canonical.floor
        assert canonical.property_type == "piso"  # "Duplex" keyword match
        assert canonical.city == "Madrid"
        assert canonical.address == "Goya, Madrid"
        assert canonical.reference_code == "106387165"
        assert canonical.photo_urls == (
            "https://img4.idealista.com/blur/WEB_DETAIL/0/id.pro.es.image.master/c0/ac/cc/1382500227.jpg",
        )
        assert canonical.raw_extra["title"] == "Duplex for sale in Calle de Alcalá"
        # Investigated-and-inconclusive fields (see idealista.py's inline
        # comments) — asserting None here is the point: a future change
        # that starts guessing these without real evidence should fail
        # this test, forcing a deliberate decision, not a silent drift.
        assert canonical.lat is None
        assert canonical.lon is None
        assert canonical.energy_rating is None
        assert canonical.listing_kind is None

    def test_normalize_falls_back_to_og_tags_when_primary_selectors_missing(self):
        """If Idealista's markup changes and the primary CSS selectors
        (.main-info__title-main, .adCommentsLanguage) go missing, the og:*
        meta-tag fallbacks should still recover a title/description — the
        one fallback chain this connector has, since (unlike Fotocasa/
        Milanuncios) there's no embedded-JSON primary path to fall back
        *from* here; og:* tags are themselves the fallback layer."""
        html = """
        <html><head>
        <meta property="og:title" content="Fallback title from og:title">
        <meta property="og:description" content="Fallback description from og:description">
        </head><body>
        <input type="hidden" name="adId" value="999">
        </body></html>
        """
        raw = RawListing(
            external_id="999",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/999/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.raw_extra["title"] == "Fallback title from og:title"
        assert canonical.description == "Fallback description from og:description"
        assert canonical.reference_code == "999"

    def test_normalize_handles_spanish_locale_price_format(self):
        """Regression test: an earlier version of this connector reused
        etl.connectors.extraction's es-ES-specific price parser on this
        English-locale fixture's "3,600,000" (comma-thousands), which
        misparsed it as Decimal("3") — a real bug, caught by
        test_normalize_matches_expected_fixture before it shipped. This
        test locks in that the fix handles BOTH plausible locales
        idealista.com could render in for the owner's browser: Spanish
        ("3.600.000", dot-thousands) must parse identically to the
        English fixture's "3,600,000"."""
        html = """
        <html><body>
        <span class="main-info__title-main">Piso en venta</span>
        <div class="info-data-price"><span class="txt-bold">3.600.000</span> €</div>
        <input type="hidden" name="adId" value="1">
        </body></html>
        """
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.current_price == Decimal(3600000)

    def test_normalize_handles_completely_empty_page_without_crashing(self):
        """An almost-empty page (e.g. a soft-block/error page that still
        got captured) should produce a listing with everything None/empty
        rather than raising — normalize() must never crash on missing
        data; ConnectorError is reserved for discover()/fetch_detail(),
        which this connector never actually calls."""
        html = "<html><head></head><body>Nothing here</body></html>"
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.current_price is None
        assert canonical.rooms is None
        assert canonical.reference_code is None
        assert canonical.photo_urls == ()
