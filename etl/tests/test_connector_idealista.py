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

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from etl.connectors.base import (
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
)
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

    def test_normalize_refuses_a_completely_empty_page(self):
        """REVERSED by issue #690 / D-159 — this test previously asserted the
        opposite, and the behaviour it pinned turned out to be a live
        data-corruption path.

        It used to read: "an almost-empty page (e.g. a soft-block/error page
        that still got captured) should produce a listing with everything
        None/empty rather than raising". That reasoning is right about
        robustness and wrong about persistence: normalize() indeed must not
        CRASH, but returning a listing-shaped object full of Nones told
        etl/capture.py the capture SUCCEEDED, and it duly persisted it.
        Production measurement (D-159) found what that cost — 18 empty
        phantom listings created from non-advert pages, and 8 real adverts
        whose stored photo gallery was erased, because
        `_update_existing_listing` COALESCEs scalars but assigns
        `photo_urls` unconditionally.

        Raising ConnectorError is the honest outcome and the safe one: it
        means "I cannot tell what this page is", which under D-157 is no
        evidence, so the capture is recorded `failed` for the operator and
        NOTHING about any listing changes. Note it is deliberately NOT
        ListingUnavailableError — an empty page is the soft-block signature
        (D-047), never proof of absence."""
        html = "<html><head></head><body>Nothing here</body></html>"
        raw = RawListing(
            external_id="1",
            source="idealista",
            raw={"url": "https://www.idealista.com/inmueble/1/", "html": html},
        )
        with pytest.raises(ConnectorError) as excinfo:
            IdealistaConnector().normalize(raw)
        assert "no listing data at all" in str(excinfo.value)
        assert not isinstance(excinfo.value, ListingUnavailableError)

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


class TestFullScreenGallery:
    """Issue #654 — the connector stored exactly 3 photos for every idealista
    listing while the HTML it was parsing already carried the whole gallery.

    `config.multimediaCarrousel.multimedias[type=PICTURE].content` is only a
    3-item preview (its sibling `totalMultimedias` reports the real count);
    the complete set sits in a separate `fullScreenGalleryPics` array the
    connector never read. Measured on production extension_capture id 3627
    (437 KB of retained detail-page HTML, D-150): 3 photos parsed, 18
    genuinely present.

    Fixture: `idealista_sample_detail_full_gallery.html` — fully synthetic
    values, real schema shape transcribed from that capture; see its header
    comment for what is faithful and what is deliberately different.
    """

    FIXTURE = (
        Path(__file__).parent / "fixtures" / "idealista_sample_detail_full_gallery.html"
    )

    def _normalize(self, html: str):
        return IdealistaConnector().normalize(
            RawListing(
                external_id="900000001",
                source="idealista",
                raw={
                    "url": "https://www.idealista.com/inmueble/900000001/",
                    "html": html,
                },
            )
        )

    def test_full_gallery_extracted_not_just_carousel_preview(self):
        """The whole gallery, not the 3-item preview.

        19 = the fixture's 18 full-screen photos plus the one photo that
        exists only in the carousel preview (a deliberate fixture departure
        that exercises the fallback merge). The assertion is the exact
        count on purpose: `>= 3` would have passed against the bug.
        """
        canonical = self._normalize(self.FIXTURE.read_text(encoding="utf-8"))
        assert len(canonical.photo_urls) == 19

    def test_floor_plans_excluded_from_photos(self):
        """The two `isPlan: true` entries are floor plans, not photos. They
        sit on the same `id.pro.es.image.master` bucket as the photos, so
        only the flag distinguishes them — a URL-shape check would let them
        through."""
        canonical = self._normalize(self.FIXTURE.read_text(encoding="utf-8"))
        # The photo immediately before the first plan in array order IS a
        # photo (so this test can't pass vacuously on an empty/preview-only
        # gallery) ...
        assert any("9000000017" in u for u in canonical.photo_urls)
        # ... and neither plan came with it.
        assert not any("9000000018" in u for u in canonical.photo_urls)
        assert not any("9100000001" in u for u in canonical.photo_urls)

    def test_gallery_order_preserved_cover_shot_first(self):
        """Gallery order is meaningful — the first photo is the cover shot
        shown in the candidate feed. Array order is used, NOT the entries'
        own `absolutePosition`: the fixture's last photo (9100000002)
        carries its multimedia id there instead of a position, exactly as
        the real capture's late-added items do. On this sample an ascending
        sort would land on the same order anyway; the point is that the
        field is not a position for every entry, so no ordering may be
        derived from it."""
        canonical = self._normalize(self.FIXTURE.read_text(encoding="utf-8"))
        assert canonical.photo_urls[0].endswith("9000000001.jpg")
        assert canonical.photo_urls[1].endswith("9000000002.jpg")
        # 17 sanely-positioned photos, then the late-added one, in array
        # order — nothing was derived from its non-position
        # absolutePosition (9100000002).
        assert canonical.photo_urls[17].endswith("9100000002.jpg")
        # Then the carousel-only photo, appended by the fallback merge.
        assert canonical.photo_urls[18].endswith("9200000001.jpg")

    def test_size_variants_of_one_photo_dedup_to_one_entry(self):
        """The carousel preview carries the same first three photos as the
        gallery at a different rendition (`WEB_DETAIL-M-L` vs
        `WEB_DETAIL`). They must collapse to one photo each — dedup is
        keyed on the `id.*.image.master/xx/xx/xx/NNNN` path, not the full
        URL — and the kept URL is the gallery's `WEB_DETAIL` one."""
        canonical = self._normalize(self.FIXTURE.read_text(encoding="utf-8"))
        for photo_id in ("9000000001", "9000000002", "9000000003"):
            matching = [u for u in canonical.photo_urls if photo_id in u]
            assert len(matching) == 1, photo_id
            assert "/WEB_DETAIL/" in matching[0]
        # Rendition-independent identity, so no two stored URLs are the same
        # photo at different sizes.
        assert len(set(canonical.photo_urls)) == len(canonical.photo_urls)

    def test_stores_jpg_not_webp(self):
        """`imageDataService` (.jpg) is stored, not its `imageDataServiceWebp`
        sibling — see the size/format note in idealista.py."""
        canonical = self._normalize(self.FIXTURE.read_text(encoding="utf-8"))
        # A gallery-only photo is present, so `all(...)` below is not
        # vacuously true over the 3-item carousel preview alone.
        assert any("9000000017" in u for u in canonical.photo_urls)
        assert all(u.endswith(".jpg") for u in canonical.photo_urls)
        assert not any(".webp" in u for u in canonical.photo_urls)

    def test_unquoted_keys_and_colons_inside_strings(self):
        """`fullScreenGalleryPics` is a JS object literal with UNQUOTED
        identifier keys mixed among quoted ones, so it needs key-quoting
        before json.loads. That rewrite must not touch quoted values: a
        caption containing `https://` or a brace would otherwise be
        corrupted, or unbalance the array scan."""
        html = (
            "<html><body>"
            '<input type="hidden" name="adId" value="1">'
            "<script>var config = {fullScreenGalleryPics: ["
            '{"isPlan":false,hoverText:"see https://example.com/a?x=1 {ojo}",'
            'imageDataService:"https://img4.idealista.com/blur/WEB_DETAIL/0/'
            'id.pro.es.image.master/aa/bb/cc/11.jpg",'
            'imageDataServiceWebp:"https://img4.idealista.com/blur/WEB_DETAIL/0/'
            'id.pro.es.image.master/aa/bb/cc/11.webp",multimediaId:11},'
            '{"isPlan":false,hoverText:"]},{ not a delimiter",'
            'imageDataService:"WEB_DETAIL/0/id.pro.es.image.master/dd/ee/ff/22.jpg",'
            "multimediaId:22}]};</script></body></html>"
        )
        canonical = self._normalize(html)
        host = "https://img4.idealista.com/blur/WEB_DETAIL/0/"
        assert canonical.photo_urls == (
            host + "id.pro.es.image.master/aa/bb/cc/11.jpg",
            # Partial paths get the img host prefixed, same as the carousel.
            host + "id.pro.es.image.master/dd/ee/ff/22.jpg",
        )

    def test_falls_back_to_carousel_when_fullscreen_array_unparseable(self):
        """A malformed `fullScreenGalleryPics` must not lose the photos the
        carousel does carry — and must not be silently coerced into
        something wrong either."""
        html = (
            "<html><body>"
            '<input type="hidden" name="adId" value="1">'
            "<script>var config = {"
            "fullScreenGalleryPics: [{isPlan:false, imageDataService:}],"
            "multimediaCarrousel: "
            '{"multimedias":[{"type":"PICTURE","content":['
            '{"src":"WEB_DETAIL/0/id.pro.es.image.master/a1/b2/c3/7.jpg"}]}]}'
            "};</script></body></html>"
        )
        canonical = self._normalize(html)
        assert canonical.photo_urls == (
            "https://img4.idealista.com/blur/WEB_DETAIL/0/id.pro.es.image.master/a1/b2/c3/7.jpg",
        )


class TestGalleryTruncationFlag:
    """Issue #654 / D-155, Opus review of PR #678 — the full-gallery parse
    must not be able to degrade back to the 3-item carousel preview
    silently.

    Every failure mode of `_gallery_from_fullscreen` returns an empty tuple
    and falls through to the carousel, which is byte-for-byte the original
    bug: no exception, no log line, no flag, just three photos again. The
    reviewer reproduced five realistic page changes against production
    capture 3627 and all five produced exactly 3 photos with no signal.

    `normalize()` now compares the parsed count against the page's own
    declared photo total (`_declared_photo_total`, read from
    `multimediaCarrousel.totalMultimedias` and corroborated by
    `len(picturesWithoutPlans)`) and sets
    `raw_extra.photo_gallery_truncated`. The mutations below are those five
    degradations, applied to the synthetic fixture — the real capture they
    were first reproduced against carries scraped listing content and
    cannot live in this repo, so the fixture stands in for it, which is
    exactly what its faithful-schema-shape header is for.
    """

    FIXTURE = TestFullScreenGallery.FIXTURE

    def _normalize(self, html: str):
        return TestFullScreenGallery._normalize(self, html)

    def _mutate_line(self, marker: str, mutate):
        """Apply `mutate` to the single fixture line carrying `marker`."""
        lines = self.FIXTURE.read_text(encoding="utf-8").split("\n")
        matches = [i for i, line in enumerate(lines) if marker in line]
        assert len(matches) == 1, f"{marker}: expected 1 line, got {len(matches)}"
        index = matches[0]
        mutated = mutate(lines[index])
        assert mutated != lines[index], f"{marker}: mutation was a no-op"
        lines[index] = mutated
        return "\n".join(lines)

    def _mutate_gallery(self, mutate):
        return self._mutate_line("fullScreenGalleryPics:", mutate)

    # --- the healthy page ------------------------------------------------

    def test_intact_page_is_not_flagged_and_records_the_declared_total(self):
        """19 parsed against a declared 18 is NOT truncated.

        The fixture deliberately carries one photo that exists only in the
        carousel preview, so it parses one MORE than the page declares.
        That is the direction the flag must never misfire on — `truncated`
        means "we lost photos", not "the two numbers differ"."""
        canonical = self._normalize(self.FIXTURE.read_text(encoding="utf-8"))
        assert len(canonical.photo_urls) == 19
        assert canonical.raw_extra["photo_gallery_declared_total"] == 18
        assert canonical.raw_extra["photo_gallery_truncated"] is False

    # --- the five reproduced degradations --------------------------------

    def test_flagged_when_the_gallery_key_is_renamed(self):
        """Degradation 1: Idealista renames `fullScreenGalleryPics`."""
        html = self._mutate_gallery(
            lambda line: line.replace(
                "fullScreenGalleryPics:", "fullScreenGalleryPicsV2:", 1
            )
        )
        canonical = self._normalize(html)
        # Straight back to the carousel preview — the original bug.
        assert len(canonical.photo_urls) == 4
        assert canonical.raw_extra["photo_gallery_truncated"] is True
        assert canonical.raw_extra["photo_gallery_declared_total"] == 18

    def test_flagged_when_a_trailing_comma_breaks_the_literal(self):
        """Degradation 2: a trailing comma before the closing `]`.

        Legal JavaScript, rejected by `json.loads`."""
        html = self._mutate_gallery(
            lambda line: line[:-2] + ",]," if line.endswith("}],") else line
        )
        canonical = self._normalize(html)
        assert len(canonical.photo_urls) == 4
        assert canonical.raw_extra["photo_gallery_truncated"] is True

    def test_flagged_when_a_value_switches_to_single_quotes(self):
        """Degradation 3: one caption emitted with single quotes.

        Also legal JavaScript, also rejected by `json.loads`."""
        html = self._mutate_gallery(
            lambda line: line.replace('hoverText:"Cocina"', "hoverText:'Cocina'", 1)
        )
        canonical = self._normalize(html)
        assert len(canonical.photo_urls) == 4
        assert canonical.raw_extra["photo_gallery_truncated"] is True

    def test_flagged_when_is_plan_becomes_undefined(self):
        """Degradation 4: `isPlan: false` emitted as `isPlan: undefined`."""
        html = self._mutate_gallery(
            lambda line: line.replace('"isPlan":false', '"isPlan":undefined', 1)
        )
        canonical = self._normalize(html)
        assert len(canonical.photo_urls) == 4
        assert canonical.raw_extra["photo_gallery_truncated"] is True

    def test_flagged_when_the_url_field_is_renamed(self):
        """Degradation 5: `imageDataService` renamed.

        The array still parses — every entry is simply skipped for having
        no URL, which is the quietest failure of the five."""
        html = self._mutate_gallery(
            lambda line: line.replace("imageDataService:", "imageDataSvc:")
        )
        canonical = self._normalize(html)
        assert len(canonical.photo_urls) == 4
        assert canonical.raw_extra["photo_gallery_truncated"] is True

    # --- the two declared-total sources are independent ------------------

    def test_pictures_without_plans_keeps_the_check_armed(self):
        """`picturesWithoutPlans` is a second, independent declared total.

        If only `multimediaCarrousel` is renamed, `totalMultimedias` goes
        with it AND the carousel fallback disappears — but the sibling
        array still says 18, so a degraded gallery is still caught."""
        html = self._mutate_line(
            "multimediaCarrousel:",
            lambda line: line.replace("multimediaCarrousel:", "carrouselV2:", 1),
        )
        html = "\n".join(
            line.replace("fullScreenGalleryPics:", "fullScreenGalleryPicsV2:", 1)
            if "fullScreenGalleryPics:" in line
            else line
            for line in html.split("\n")
        )
        canonical = self._normalize(html)
        # Both photo sources gone: only the og:image thumbnail is left.
        assert len(canonical.photo_urls) == 1
        assert canonical.raw_extra["photo_gallery_declared_total"] == 18
        assert canonical.raw_extra["photo_gallery_truncated"] is True

    def test_no_flag_keys_when_the_page_declares_no_total(self):
        """A page that states no total leaves the check blind — say so by
        omitting both keys rather than asserting a clean bill of health."""
        html = (
            "<html><body>"
            '<input type="hidden" name="adId" value="1">'
            "<script>var config = {fullScreenGalleryPics: ["
            '{"isPlan":false,imageDataService:'
            '"WEB_DETAIL/0/id.pro.es.image.master/a1/b2/c3/7.jpg"}]};'
            "</script></body></html>"
        )
        canonical = self._normalize(html)
        assert len(canonical.photo_urls) == 1
        assert "photo_gallery_truncated" not in canonical.raw_extra
        assert "photo_gallery_declared_total" not in canonical.raw_extra

    # --- the operator-facing half ----------------------------------------

    def test_degradation_is_logged_not_only_flagged(self, caplog):
        """A flag nobody queries is not enough: the module had no logger at
        all, so a silent regression stayed silent in the logs too."""
        html = self._mutate_gallery(
            lambda line: line.replace(
                "fullScreenGalleryPics:", "fullScreenGalleryPicsV2:", 1
            )
        )
        with caplog.at_level(logging.WARNING, logger="etl.connectors.idealista"):
            self._normalize(html)
        assert any(
            "photo_gallery_truncated" in record.getMessage()
            for record in caplog.records
        )


# ─── Retired-advert notice detection (issue #690, D-159) ────────────────────

_RETIRED_FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "idealista_retired_notice.html"
)
# The obviously-fake reference and delisting date the synthetic fixture
# prints. Tests rewrite them to make the notice agree (or deliberately
# disagree) with the listing being captured.
_FIXTURE_REFERENCE = "900000001"
_FIXTURE_DELISTED = "03/08/2026"
# Substituted in by default so no test depends on wall-clock drift: the
# fixture's hardcoded date would eventually fall outside
# `_NOTICE_MAX_DELISTING_AGE_DAYS` and be (correctly) disbelieved.
_RECENT_DELISTED = (datetime.now(timezone.utc).date() - timedelta(days=12)).strftime(
    "%d/%m/%Y"
)


def _read_retired_fixture(
    reference: str = _FIXTURE_REFERENCE, delisted: str | None = _RECENT_DELISTED
) -> str:
    """The synthetic retired-notice page, with its reference and delisting
    date rewritten to whatever this test needs (issue #691)."""
    html = _RETIRED_FIXTURE_PATH.read_text(encoding="utf-8")
    html = html.replace(_FIXTURE_REFERENCE, reference)
    if delisted is not None:
        html = html.replace(_FIXTURE_DELISTED, delisted)
    return html


def _raw(html: str, external_id: str = _FIXTURE_REFERENCE) -> RawListing:
    return RawListing(
        external_id=external_id,
        source="idealista",
        raw={"url": f"https://www.idealista.com/inmueble/{external_id}/", "html": html},
    )


class TestRetiredPageSignature:
    """`retired_page_signature` must fire on the portal's own notice and on
    NOTHING else. Every negative case here is a page that today's production
    data shows can reach normalize() — the whole risk of this feature is a
    false positive marking a live advert withdrawn."""

    def test_the_notice_page_is_positively_identified(self):
        signature = IdealistaConnector().retired_page_signature(_read_retired_fixture())
        assert signature is not None
        # The evidence must QUOTE what the portal said, not just assert a
        # conclusion — this string is persisted to
        # listing_status_event.evidence and has to answer "evidence of what?"
        # on its own, years later (issue #643's rationale for the column).
        assert "ya no esta publicado" in signature.lower()
        assert "idealista" in signature.lower()

    def test_a_real_listing_page_is_not_a_retired_page(self):
        assert IdealistaConnector().retired_page_signature(_read_fixture()) is None

    def test_an_empty_page_is_not_a_retired_page(self):
        """The single most important negative. An empty/unparseable 200 is
        the SOFT-BLOCK signature (D-047), not absence — conflating them would
        let a rate-throttle wall withdraw a portal's whole inventory. This is
        the trap that made milanuncios.py carry no signature at all."""
        connector = IdealistaConnector()
        assert connector.retired_page_signature("") is None
        assert connector.retired_page_signature("<html><body></body></html>") is None

    def test_a_bot_wall_page_is_not_a_retired_page(self):
        """Idealista is known to serve a CAPTCHA/bot challenge (see the
        connector's module docstring). It carries no listing data either —
        and must still never be read as 'the listing is gone'."""
        wall = (
            "<html><head><title>idealista</title></head><body>"
            "<h1>Vaya, parece que eres un robot</h1>"
            "<p>Resuelve el captcha para continuar.</p>"
            "</body></html>"
        )
        assert IdealistaConnector().retired_page_signature(wall) is None

    def test_a_live_advert_quoting_the_phrase_is_not_retired(self):
        """The one false-positive route the notice sentence leaves open: a
        LIVE advert whose seller-written description quotes the phrase. The
        real listing fixture with the notice sentence spliced into its
        description must still be read as alive, because the page renders
        its own price/title/description markup."""
        live_with_phrase = _read_fixture().replace(
            "</body>",
            '<div class="adCommentsLanguage">Si ve que este anuncio ya no '
            "está publicado, llámenos igualmente.</div></body>",
        )
        assert IdealistaConnector().retired_page_signature(live_with_phrase) is None

    @pytest.mark.parametrize(
        "phrase",
        [
            "Lo sentimos, este anuncio ya no está publicado",
            "lo sentimos, este anuncio ya no esta publicado",  # accents dropped
            "Este inmueble ya no está disponible",
            "El anuncio que buscas ya no está activo",
        ],
    )
    def test_wording_and_accent_variants_all_match(self, phrase):
        """The owner reads the accented Spanish; the DOM may or may not carry
        the accents, and Idealista may reword. Matching is accent-folded and
        covers the publicado/disponible/activo family — each of which is a
        complete notice SENTENCE, never a fragment that could appear in prose
        about something else."""
        page = (
            "<html><head><title>Viviendas venta. Viviendas alquiler. Pisos. "
            f"Chalets — idealista</title></head><body><h1>{phrase}</h1>"
            "</body></html>"
        )
        assert IdealistaConnector().retired_page_signature(page) is not None

    def test_the_phrase_inside_a_script_tag_does_not_count(self):
        """Only text a human in front of the browser could have READ counts
        as the portal saying something. A JS string literal is not the portal
        telling the owner anything."""
        page = (
            "<html><body><script>"
            'var msg = "este anuncio ya no está publicado";'
            "</script><p>Piso en venta</p></body></html>"
        )
        assert IdealistaConnector().retired_page_signature(page) is None


class TestNormalizeRefusesNonAdvertPages:
    def test_the_notice_page_raises_listing_unavailable(self):
        """The retired notice must surface as ListingUnavailableError — the
        codebase's established 'the source says this listing is gone' signal
        (D-049) — so etl/capture.py can act on it, rather than as a generic
        failure or (as before this fix) a successful empty listing."""
        with pytest.raises(ListingUnavailableError) as excinfo:
            IdealistaConnector().normalize(_raw(_read_retired_fixture()))
        assert "retirado" in str(excinfo.value).lower()

    def test_a_bot_wall_raises_plain_connector_error_not_unavailable(self):
        """The distinction this whole design rests on. A page we cannot
        identify is NO EVIDENCE (D-157): ConnectorError, which leaves the
        listing untouched. It must NOT be a ListingUnavailableError, which
        would withdraw it."""
        wall = (
            "<html><head><title>idealista</title></head><body>"
            "<h1>Vaya, parece que eres un robot</h1></body></html>"
        )
        with pytest.raises(ConnectorError) as excinfo:
            IdealistaConnector().normalize(_raw(wall))
        assert not isinstance(excinfo.value, ListingUnavailableError)
        assert "no listing data at all" in str(excinfo.value)

    def test_the_pre_fix_corruption_shape_is_now_refused(self):
        """Regression pin for the bug D-159 documents.

        Before this fix, a page with the site-wide <title> and no listing
        markup normalized SUCCESSFULLY into a listing with every real field
        None and `property_type='piso'` fabricated from the word "Pisos" in
        that title — which is exactly what 26 production rows recorded. It
        must now raise instead of returning anything at all."""
        page = (
            "<html><head><title>Viviendas venta. Viviendas alquiler. Pisos. "
            "Chalets — idealista</title></head><body>"
            "<p>Busca tu nueva casa en idealista.</p></body></html>"
        )
        with pytest.raises(ConnectorError):
            IdealistaConnector().normalize(_raw(page))

    def test_a_real_listing_still_normalizes(self):
        """The guards must not cost a single real capture. The full fixture
        goes through untouched."""
        canonical = IdealistaConnector().normalize(_raw(_read_fixture(), "106387165"))
        assert canonical.status == "active"
        assert canonical.current_price is not None

    def test_a_page_with_only_one_substantive_field_still_normalizes(self):
        """The refusal threshold is ZERO substantive fields, not 'few'. A
        thin-but-real advert (production has captures extracting 9 of 26
        fields) must still be ingested — the measured gap between real pages
        and non-pages is 9-vs-3, so the guard has the whole gap to spare and
        must never encroach on it."""
        thin = (
            "<html><head><title>Viviendas venta. Viviendas alquiler. Pisos. "
            "Chalets — idealista</title></head><body>"
            '<div class="info-data-price"><span class="txt-bold">125.000</span>'
            "</div></body></html>"
        )
        canonical = IdealistaConnector().normalize(_raw(thin))
        assert canonical.current_price == Decimal(125000)


class TestRetiredNoticeFacts:
    """Issue #691. The notice does not just say an advert is gone — it prints
    which advert, when the advertiser pulled it, and what it was asking. All
    three are parsed; two of them decide whether a row may be changed."""

    def test_reference_date_and_stated_figures_are_all_parsed(self):
        facts = IdealistaConnector().retired_notice_facts(
            _read_retired_fixture(delisted="03/08/2026")
        )
        assert facts is not None
        assert facts.reference == _FIXTURE_REFERENCE
        assert facts.delisted_on == date(2026, 8, 3)
        assert facts.stated_price == Decimal(123000)
        assert facts.stated_m2 == Decimal(80)
        assert facts.stated_rooms == 3

    def test_the_citation_carries_the_parsed_facts(self):
        """`listing_status_event.evidence` is the only place anyone will ever
        be able to reconstruct this withdrawal from, so the numbers the page
        showed have to survive into it — including the final asking price,
        which nothing else in this project records."""
        facts = IdealistaConnector().retired_notice_facts(
            _read_retired_fixture(delisted="03/08/2026")
        )
        assert facts is not None
        citation = facts.citation
        assert "ya no esta publicado" in citation.lower()
        assert _FIXTURE_REFERENCE in citation
        assert "03/08/2026" in citation
        assert "123000 €" in citation
        assert "80 m²" in citation
        assert "3 hab." in citation

    def test_a_notice_without_the_extra_lines_is_still_a_notice(self):
        """A reworded notice that drops the reference/date/summary must still
        be RECOGNISED — the sentence is what identifies the page. It simply
        carries less evidence, and it is the caller that decides whether
        that is enough (here: it is not, see the normalize tests)."""
        bare = (
            "<html><head><title>Viviendas venta. Pisos. Chalets — idealista"
            "</title></head><body><h1>Lo sentimos, este anuncio ya no está "
            "publicado</h1></body></html>"
        )
        facts = IdealistaConnector().retired_notice_facts(bare)
        assert facts is not None
        assert facts.reference is None
        assert facts.delisted_on is None
        assert facts.stated_price is None
        assert "no imprime" in facts.citation

    def test_prices_and_areas_parse_under_both_locales(self):
        """idealista.com serves both "123.000 €" (es-ES) and "123,000 €"
        (en) — see `_strip_thousands_separators`. Both mean the same number
        and both must read as it, because a size misread by a factor of a
        thousand would veto every withdrawal it touched."""
        connector = IdealistaConnector()
        for figures in ("1.234.000 € 1.250 m² 5 hab.", "1,234,000 € 1,250 m² 5 hab."):
            html = _read_retired_fixture().replace("123.000 € 80 m² 3 hab.", figures)
            facts = connector.retired_notice_facts(html)
            assert facts is not None
            assert facts.stated_price == Decimal(1234000)
            assert facts.stated_m2 == Decimal(1250)
            assert facts.stated_rooms == 5

    def test_a_decimal_area_truncates_rather_than_inflating(self):
        """ "79,6 m²" must read as 79, never as 796. Truncation can only make
        the corroboration check stricter by a fraction of a metre, which the
        tolerance absorbs; reading it as 796 would veto a real withdrawal."""
        html = _read_retired_fixture().replace(
            "123.000 € 80 m² 3 hab.", "123.000 € 79,6 m² 3 hab."
        )
        facts = IdealistaConnector().retired_notice_facts(html)
        assert facts is not None
        assert facts.stated_m2 == Decimal(79)

    def test_figures_from_elsewhere_on_the_page_are_not_attributed(self):
        """The stated figures come from a bounded window right after the
        notice sentence. A price in the footer, a size in a promo strip or
        anything past the reference line belongs to some other advert and
        must never be recorded as this one's."""
        html = _read_retired_fixture().replace(
            "<footer>",
            '<div class="promo">Chalets desde 999.000 € y 500 m² en tu zona</div>'
            "<footer>",
        )
        facts = IdealistaConnector().retired_notice_facts(html)
        assert facts is not None
        assert facts.stated_price == Decimal(123000)
        assert facts.stated_m2 == Decimal(80)

    @pytest.mark.parametrize(
        "stated",
        [
            "31/02/2026",  # not a real date
            "01/01/1970",  # absurdly old
        ],
    )
    def test_an_unbelievable_date_is_discarded_and_said_so(self, stated):
        facts = IdealistaConnector().retired_notice_facts(
            _read_retired_fixture(delisted=stated)
        )
        assert facts is not None
        assert facts.delisted_on is None
        assert "no es verosímil" in facts.citation
        assert stated in facts.citation

    def test_a_future_date_is_discarded(self):
        """A page cannot report a withdrawal that has not happened yet, so a
        future date means the parse (or the locale's field order) is wrong."""
        future = (datetime.now(timezone.utc).date() + timedelta(days=30)).strftime(
            "%d/%m/%Y"
        )
        facts = IdealistaConnector().retired_notice_facts(
            _read_retired_fixture(delisted=future)
        )
        assert facts is not None
        assert facts.delisted_on is None

    def test_signature_and_facts_never_disagree(self):
        """`retired_page_signature` is a wrapper, and must stay one — two
        independent recognitions would eventually drift apart."""
        connector = IdealistaConnector()
        for html in (_read_retired_fixture(), _read_fixture(), ""):
            facts = connector.retired_notice_facts(html)
            signature = connector.retired_page_signature(html)
            assert signature == (facts.citation if facts is not None else None)

    def test_other_connectors_keep_the_unstructured_contract(self):
        """The base class gained an OPTIONAL structured hook. A connector
        that implements only `retired_page_signature` — fotocasa, pisos —
        must be completely unaffected."""
        from etl.connectors.fotocasa import FotocasaConnector

        connector = FotocasaConnector()
        assert connector.retired_notice_facts("<html></html>") is None
        assert (
            connector.retired_page_signature(
                "<html></html>", "https://www.fotocasa.es/es/?propertyNotFound"
            )
            is not None
        )


class TestRetiredNoticeReferenceCorroboration:
    """Issue #691. The notice page is generic chrome — the same shell for
    every dead advert — so the sentence alone only supports "SOME advert is
    gone". Only the printed reference ties it to the listing being captured,
    and without that tie nothing may be withdrawn."""

    def test_a_matching_reference_withdraws(self):
        with pytest.raises(ListingUnavailableError) as excinfo:
            IdealistaConnector().normalize(
                _raw(_read_retired_fixture(), _FIXTURE_REFERENCE)
            )
        assert "retirado" in str(excinfo.value).lower()
        assert _FIXTURE_REFERENCE in str(excinfo.value)

    def test_a_mismatched_reference_withdraws_nothing(self):
        """THE test this hardening exists for. A notice shell served at the
        wrong URL — a redirect, a stale tab, a mis-typed capture, a portal
        bug — would otherwise withdraw a listing the page was never about.
        ConnectorError, NOT ListingUnavailableError: same safe outcome as a
        bot wall, capture recorded failed, no listing touched."""
        with pytest.raises(ConnectorError) as excinfo:
            IdealistaConnector().normalize(
                _raw(_read_retired_fixture(reference="900000002"), "900000001")
            )
        assert not isinstance(excinfo.value, ListingUnavailableError)
        assert "DIFFERENT advert" in str(excinfo.value)
        assert "900000002" in str(excinfo.value)

    def test_a_notice_without_a_reference_withdraws_nothing(self):
        """Required, not preferred. An uncorroborated notice is still only
        "some advert is gone", and D-157 does not let that change a row."""
        html = _read_retired_fixture().replace(
            f"Referencia del anuncio: {_FIXTURE_REFERENCE}", "&nbsp;"
        )
        with pytest.raises(ConnectorError) as excinfo:
            IdealistaConnector().normalize(_raw(html, _FIXTURE_REFERENCE))
        assert not isinstance(excinfo.value, ListingUnavailableError)
        assert "no «Referencia del anuncio»" in str(excinfo.value)

    def test_a_missing_date_does_not_block_the_withdrawal(self):
        """The date is precision, not proof. Losing it costs the transition
        its true timestamp (it falls back to the capture time), never the
        transition itself."""
        html = _read_retired_fixture().replace(
            "El anunciante lo dio de baja el 03/08/2026", "&nbsp;"
        )
        with pytest.raises(ListingUnavailableError):
            IdealistaConnector().normalize(_raw(html, _FIXTURE_REFERENCE))

    def test_a_notice_with_no_stated_figures_still_withdraws(self):
        """Size/rooms corroborate when present; absent, the reference match
        stands alone. Absence is not a mismatch."""
        html = _read_retired_fixture().replace("123.000 € 80 m² 3 hab.", "&nbsp;")
        with pytest.raises(ListingUnavailableError):
            IdealistaConnector().normalize(_raw(html, _FIXTURE_REFERENCE))
