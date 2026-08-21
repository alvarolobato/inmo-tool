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
        # Issue #628: the primary contact box. Opus review (B3): the
        # fixture ALSO carries the competing "about advertiser" widget
        # ("Other Office Branch") right alongside it — this assertion is
        # what proves _advertiser_name selects the right one when BOTH
        # are present, not just that the wrong selector's class name
        # happens to be absent from a narrower fixture.
        assert canonical.contact_raw == "Inmobiliaria Ejemplo"
        # Full gallery from config.multimediaCarrousel.multimedias (issue
        # #282) — all 10 PICTUREs, in page order, NOT just the single
        # og:image thumbnail; the PLAN group is excluded.
        assert len(canonical.photo_urls) == 10
        assert canonical.photo_urls[0] == (
            "https://img4.idealista.com/blur/WEB_DETAIL/0/id.pro.es.image.master/c0/ac/cc/1382500227.jpg"
        )
        assert canonical.photo_urls[-1] == (
            "https://img4.idealista.com/blur/WEB_DETAIL/0/id.pro.es.image.master/c0/ac/cc/1382500236.jpg"
        )
        assert all(
            u.startswith("https://img4.idealista.com/blur/")
            for u in canonical.photo_urls
        )
        # No floor-plan image leaked into the photo gallery.
        assert not any("id.plan.es.image" in u for u in canonical.photo_urls)
        assert canonical.raw_extra["title"] == "Duplex for sale in Calle de Alcalá"
        # Real coordinates from the embedded Google Static Maps `center`
        # param (see _coordinates_from_staticmap) — an earlier version of
        # this connector incorrectly concluded no coordinates exist
        # anywhere in Idealista's page structure (Opus review, PR #87).
        assert canonical.lat == Decimal("40.42569080")
        assert canonical.lon == Decimal("-3.67632170")
        # Investigated-and-inconclusive fields (see idealista.py's inline
        # comments) — asserting None here is the point: a future change
        # that starts guessing these without real evidence should fail
        # this test, forcing a deliberate decision, not a silent drift.
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
        assert canonical.contact_raw is None
        assert canonical.photo_urls == ()
        assert canonical.lat is None
        assert canonical.lon is None

    def test_normalize_does_not_pick_up_the_about_advertiser_widget(self):
        """A real Idealista page also carries a SECOND, differently-classed
        "about the professional" widget (`.about-advertiser-name`, inside
        `.about-advertiser`) that can name a different office/branch of the
        same firm — see `_advertiser_name`'s docstring. Only the PRIMARY
        contact box's `.advertiser-info .advertiser-name` must be read."""
        html = """
        <html><body>
        <input type="hidden" name="adId" value="1">
        <div class="about-advertiser">
          <div class="advertiser-name-container">
            <a class="about-advertiser-name">Other Branch Office</a>
          </div>
        </div>
        </body></html>
        """
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.contact_raw is None

    def test_normalize_extracts_full_photo_gallery_not_just_thumbnail(self):
        """Issue #282: the connector stored only 1 of ~95 photos because it
        read the og:image thumbnail alone. Every photo lives in the inline
        `config.multimediaCarrousel.multimedias[].content[].src` array — the
        same object the coordinates come from. This locks in that the full
        set is extracted, in order, with the img host prefixed onto the
        partial paths, and that non-PICTURE (PLAN/MAP) entries are skipped."""
        html = _read_fixture()
        raw = RawListing(
            external_id="106387165",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/106387165/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert len(canonical.photo_urls) == 10  # full gallery, not 1
        # Partial `src` paths get the img host prefixed.
        assert canonical.photo_urls[0] == (
            "https://img4.idealista.com/blur/WEB_DETAIL/0/"
            "id.pro.es.image.master/c0/ac/cc/1382500227.jpg"
        )
        # Page order preserved.
        assert canonical.photo_urls[1].endswith("1382500228.jpg")
        # The floor-plan (PLAN group) is not a photo.
        assert all("id.plan.es.image" not in u for u in canonical.photo_urls)
        # No duplicates.
        assert len(set(canonical.photo_urls)) == len(canonical.photo_urls)
        # This fixture's multimediasTotalSlides PICTURE totalSlides is 10 —
        # matching the 10 embedded photos exactly — so nothing is truncated
        # and issue #625's detection signal must stay absent.
        assert "photo_gallery_truncated" not in canonical.raw_extra
        assert "photo_gallery_total_available" not in canonical.raw_extra

    def test_gallery_truncation_flagged_when_total_slides_exceeds_embedded(self):
        """Issue #625: production shows 100% of idealista listings landing
        at <=3 photos (avg 2.8) against fotocasa's 27 on the same corpus.
        Root cause, confirmed against a real captured Idealista page
        (production extension_capture id 10 — see
        docs/decisions/D-145-idealista-photo-gallery-truncation.md): the
        captured HTML's own `multimedias[type=PICTURE].content` is a fixed
        preview, while a sibling `multimediasTotalSlides` field reports the
        real count. This locks in that when the two disagree, `normalize()`
        surfaces it honestly instead of silently treating the preview as
        the whole gallery — and that `photo_urls` itself still only carries
        what's genuinely embedded (3 here), never fabricating more."""
        html = (
            "<html><body>"
            '<input type="hidden" name="adId" value="1">'
            "<script>var config = {multimediaCarrousel: "
            '{"multimediasTotalSlides":[{"type":"PICTURE","totalSlides":13},'
            '{"type":"PLAN","totalSlides":1}],'
            '"multimedias":[{"type":"PICTURE","content":['
            '{"src":"WEB_DETAIL/0/a/b/c/1.jpg"},'
            '{"src":"WEB_DETAIL/0/a/b/c/2.jpg"},'
            '{"src":"WEB_DETAIL/0/a/b/c/3.jpg"}]}]}};</script>'
            "</body></html>"
        )
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert len(canonical.photo_urls) == 3  # only what's really embedded
        assert canonical.raw_extra["photo_gallery_truncated"] is True
        assert canonical.raw_extra["photo_gallery_total_available"] == 13

    def test_gallery_not_flagged_truncated_when_total_slides_matches(self):
        """Defensive counterpart: when `totalSlides` agrees with what's
        embedded, no truncation flag — this must be able to fail, i.e. a
        connector that always flags truncation regardless of the numbers
        would be caught here."""
        html = (
            "<html><body>"
            '<input type="hidden" name="adId" value="1">'
            "<script>var config = {multimediaCarrousel: "
            '{"multimediasTotalSlides":[{"type":"PICTURE","totalSlides":2}],'
            '"multimedias":[{"type":"PICTURE","content":['
            '{"src":"WEB_DETAIL/0/a/b/c/1.jpg"},'
            '{"src":"WEB_DETAIL/0/a/b/c/2.jpg"}]}]}};</script>'
            "</body></html>"
        )
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert len(canonical.photo_urls) == 2
        assert "photo_gallery_truncated" not in canonical.raw_extra
        assert "photo_gallery_total_available" not in canonical.raw_extra

    def test_gallery_handles_absolute_src_and_dedups(self):
        """Defensive: a carousel whose `src` is already an absolute URL is
        kept verbatim (not double-prefixed), and a repeated src collapses to
        one entry (order-preserving)."""
        html = (
            "<html><body>"
            '<input type="hidden" name="adId" value="1">'
            "<script>var config = {multimediaCarrousel: "
            '{"multimedias":[{"type":"PICTURE","content":['
            '{"src":"https://img4.idealista.com/blur/WEB_DETAIL/0/a/b/c/1.jpg"},'
            '{"src":"WEB_DETAIL/0/a/b/c/2.jpg"},'
            '{"src":"WEB_DETAIL/0/a/b/c/2.jpg"}]}]}};</script>'
            "</body></html>"
        )
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.photo_urls == (
            "https://img4.idealista.com/blur/WEB_DETAIL/0/a/b/c/1.jpg",
            "https://img4.idealista.com/blur/WEB_DETAIL/0/a/b/c/2.jpg",
        )

    def test_gallery_falls_back_to_og_image_when_carousel_absent(self):
        """If a capture has no multimediaCarrousel object (older markup, or
        a soft-block page), the single og:image thumbnail is still used —
        the pre-#282 behaviour, now the explicit fallback."""
        html = """
        <html><head>
        <meta property="og:image" content="https://img4.idealista.com/blur/X/only.jpg">
        </head><body>
        <input type="hidden" name="adId" value="1">
        </body></html>
        """
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.photo_urls == ("https://img4.idealista.com/blur/X/only.jpg",)

    def test_normalize_extracts_coordinates_from_staticmap_center_param(self):
        """Real Google Static Maps `center` param, url-encoded comma
        (%2C) — the exact format Idealista's page actually embeds it in
        (see module docstring/_STATICMAP_CENTER_RE). An earlier version of
        this connector was built against a fixture with this region
        trimmed out and incorrectly concluded no coordinates exist
        anywhere on the page (Opus review, PR #87)."""
        html = (
            "<html><body>"
            '<input type="hidden" name="adId" value="1">'
            '<script>var config = {map:{"src":"https://maps.googleapis.com/'
            "maps/api/staticmap?size=720x492&center=40.12345000%2C-3.98765000"
            '&zoom=16"}};</script>'
            "</body></html>"
        )
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.lat == Decimal("40.12345000")
        assert canonical.lon == Decimal("-3.98765000")

    def test_normalize_area_with_decimal_comma_does_not_10x(self):
        """Regression: reusing a digit-only parser for area (correct for
        whole-euro prices) would turn "114,6 m²" into 1146 — a real 10x
        error (Opus review, PR #87), the same bug class already fixed for
        Fotocasa/Milanuncios but for a different reason (this connector
        can't assume es-ES locale — see _area_with_decimal's docstring)."""
        html = """
        <div class="details-property_features">
          <ul><li>114,6 m² built</li></ul>
        </div>
        <input type="hidden" name="adId" value="1">
        """
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.m2_built == Decimal("114.6")

    def test_normalize_area_thousands_separator_without_decimal(self):
        """A whole-number area with a thousands separator (implausibly
        large for a flat, but the parser must not misfire and treat the
        separator as a decimal point either) is preserved as a true
        thousands separator, not a false-positive decimal."""
        html = """
        <div class="details-property_features">
          <ul><li>1.234 m² built</li></ul>
        </div>
        <input type="hidden" name="adId" value="1">
        """
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        canonical = IdealistaConnector().normalize(raw)
        assert canonical.m2_built == Decimal(1234)
