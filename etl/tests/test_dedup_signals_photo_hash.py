"""Tests for the perceptual photo-hash signal (issue #61).

No network: `fetch_hashes` is the only part of photo_hash.py that does I/O,
and it's deliberately split from the pure comparison logic. These tests
generate images in-memory and hash them directly, so the matching behaviour
that actually matters is exercised without touching a real photo URL.

The point of issue #61 was that `average_hash` at Hamming<=8 false-positives
on flat/low-detail photos — an extremely common shape for property listings
(a white wall, an empty room, an over-exposed façade). These tests pin both
directions of the fix: genuinely-duplicate photos still match, and unrelated
flat photos no longer do.
"""

from __future__ import annotations

import io
import random

import imagehash
import pytest
from PIL import Image, ImageDraw, ImageFilter

from etl.dedup.signals import photo_hash


def _synthetic_room(seed: int, flat: bool = False) -> Image.Image:
    """A stand-in property photo.

    flat=True is the case issue #61 is about: a mostly-uniform image with
    very little structure, which is what makes average_hash collapse toward
    the same bit pattern for unrelated photos.
    """
    rng = random.Random(seed)
    background = (
        (rng.randint(200, 235),) * 3
        if flat
        else (rng.randint(60, 200), rng.randint(60, 200), rng.randint(60, 200))
    )
    image = Image.new("RGB", (640, 480), background)
    draw = ImageDraw.Draw(image)
    for _ in range(2 if flat else 14):
        x0, y0 = rng.randint(0, 600), rng.randint(0, 440)
        draw.rectangle(
            [x0, y0, x0 + rng.randint(20, 120), y0 + rng.randint(20, 120)],
            fill=(rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)),
        )
    return image


def _jpeg(image: Image.Image, quality: int) -> Image.Image:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=quality)
    buffer.seek(0)
    return Image.open(buffer)


def _watermarked(image: Image.Image, width: int = 300, height: int = 70) -> Image.Image:
    """Portal watermark bar — Idealista/Fotocasa stamp their own on photos,
    which is exactly why a cross-posted duplicate isn't byte-identical."""
    stamped = image.copy()
    ImageDraw.Draw(stamped).rectangle(
        [20, 480 - height - 20, 20 + width, 460], fill=(255, 255, 255)
    )
    return stamped


def _hash(image: Image.Image):
    """Hash exactly the way fetch_hashes does, so these tests track the
    production algorithm rather than a copy that could silently drift."""
    return imagehash.phash(image)


def _distance(a: Image.Image, b: Image.Image) -> int:
    return int(_hash(a) - _hash(b))


class TestRealDuplicatesStillMatch:
    """The threshold change must not break the case the signal exists for."""

    @pytest.mark.parametrize(
        "label,transform",
        [
            (
                "resized down and back",
                lambda im: im.resize((320, 240)).resize((640, 480)),
            ),
            ("re-encoded jpeg q60", lambda im: _jpeg(im, 60)),
            ("re-encoded jpeg q35", lambda im: _jpeg(im, 35)),
            ("cropped ~5%", lambda im: im.crop((16, 12, 624, 468)).resize((640, 480))),
            ("slight blur", lambda im: im.filter(ImageFilter.GaussianBlur(1.0))),
            (
                "brightness shift",
                lambda im: Image.eval(im, lambda p: min(255, int(p * 1.15))),
            ),
            (
                "crop + resize + jpeg",
                lambda im: _jpeg(im.crop((16, 12, 624, 468)).resize((640, 480)), 50),
            ),
        ],
    )
    @pytest.mark.parametrize("seed", [1, 2, 3])
    def test_same_photo_after_a_realistic_transform_is_within_threshold(
        self, label, transform, seed
    ):
        """Across several source images, not just one — a threshold tuned to
        a single lucky seed isn't a threshold."""
        original = _synthetic_room(seed)
        assert (
            _distance(original, transform(original))
            <= photo_hash._HASH_HAMMING_THRESHOLD
        ), (
            f"{label} (seed {seed}): a genuinely duplicate photo fell outside the threshold"
        )

    def test_match_ratio_reports_full_overlap_for_a_re_encoded_photo_set(self):
        base = [_synthetic_room(s) for s in (1, 2, 3)]
        hashes_a = [_hash(im) for im in base]
        hashes_b = [_hash(_jpeg(im, 60)) for im in base]
        assert photo_hash.match_ratio(hashes_a, hashes_b) == 1.0


class TestWatermarkLimitation:
    """A watermark bar is the one realistic transform phash does NOT absorb.

    Measured across three source images: a bar covering ~2% of the frame
    already sits at distance 8-10 (i.e. at the threshold), and anything
    larger runs to 12-22 — overlapping the distance range of genuinely
    *unrelated* flat photos (floor ~18). No single cutoff separates those
    two populations, so this isn't tunable away; raising the threshold to
    catch watermarked duplicates would re-admit exactly the false positives
    issue #61 was filed about.

    That trade is deliberately taken in the false-negative direction: this
    signal only ever files a *suggestion* (see _MAX_SUGGESTION_CONFIDENCE,
    and the engine never treats photo_hash as an auto-merge basis), so a
    miss costs one suggestion a human never sees, while a false positive
    costs a human reviewing a bogus pair — or, worse, confirming it.

    This test documents the limitation rather than asserting the behaviour
    we'd prefer, so that a future change to the algorithm or threshold has
    to consciously revisit it instead of silently inheriting it.
    """

    def test_a_large_watermark_pushes_a_true_duplicate_out_of_range(self):
        original = _synthetic_room(1)
        heavily_stamped = _watermarked(original, width=420, height=110)
        assert (
            _distance(original, heavily_stamped) > photo_hash._HASH_HAMMING_THRESHOLD
        ), (
            "a large watermark now falls within threshold — re-check the "
            "false-positive rate on flat photos before accepting this"
        )

    def test_a_small_watermark_is_borderline_not_reliably_matched(self):
        """Small bars hover right at the cutoff; recorded so the borderline
        is visible rather than surprising."""
        distances = [
            _distance(
                _synthetic_room(seed), _watermarked(_synthetic_room(seed), 150, 40)
            )
            for seed in (1, 2, 3)
        ]
        assert max(distances) >= 8, distances


class TestFlatPhotosNoLongerCollide:
    """Issue #61's actual complaint, pinned as a regression test."""

    def test_unrelated_flat_photos_are_outside_the_threshold(self):
        """Twenty unrelated low-detail pairs, none of which may match.

        Under the previous average_hash<=8 these landed at distances of
        9-13 — i.e. some genuinely did false-positive, and all of them sat
        close enough to the cutoff to be one tuning change away from it.
        """
        collisions = []
        for i in range(20):
            a = _synthetic_room(500 + i * 2, flat=True)
            b = _synthetic_room(501 + i * 2, flat=True)
            distance = _distance(a, b)
            if distance <= photo_hash._HASH_HAMMING_THRESHOLD:
                collisions.append((i, distance))
        assert not collisions, f"unrelated flat photos matched: {collisions}"

    def test_match_ratio_stays_below_the_suggestion_floor_for_flat_photos(self):
        hashes_a = [_hash(_synthetic_room(700 + i, flat=True)) for i in range(4)]
        hashes_b = [_hash(_synthetic_room(800 + i, flat=True)) for i in range(4)]
        ratio = photo_hash.match_ratio(hashes_a, hashes_b)
        assert ratio is not None
        assert ratio < float(photo_hash.MIN_MATCH_RATIO)


class TestMatchRatioSemantics:
    def test_returns_none_when_either_side_has_no_hashes(self):
        """None means "couldn't check", 0.0 would mean "checked, no match" —
        the engine needs to tell those apart."""
        some = [_hash(_synthetic_room(9))]
        assert photo_hash.match_ratio([], some) is None
        assert photo_hash.match_ratio(some, []) is None
        assert photo_hash.match_ratio([], []) is None

    def test_ratio_is_over_the_smaller_set(self):
        shared = _synthetic_room(11)
        smaller = [_hash(shared)]
        larger = [_hash(shared), _hash(_synthetic_room(12)), _hash(_synthetic_room(13))]
        assert photo_hash.match_ratio(smaller, larger) == 1.0

    def test_partial_overlap_is_reported_proportionally(self):
        shared = _synthetic_room(21)
        hashes_a = [_hash(shared), _hash(_synthetic_room(22))]
        hashes_b = [_hash(_jpeg(shared, 70)), _hash(_synthetic_room(23))]
        assert photo_hash.match_ratio(hashes_a, hashes_b) == 0.5


class TestNonImageUrlFiltering:
    """Issue: a live run fed video/virtual-tour URLs from `photo_urls` into
    `fetch_hashes`, wasting a fetch on every one and diluting `match_ratio`
    (a listing with 3 real photos + 2 unhashable links could never reach
    ratio 1.0 even when every real photo matched — see photo_hash.py's
    module-level comment for the full writeup and the exact log lines from
    the live corpus this reproduces).
    """

    @pytest.mark.parametrize(
        "url",
        [
            "https://www.youtube.com/watch?v=herOSioqMOc",
            "https://youtu.be/herOSioqMOc",
            "https://vimeo.com/1176257186",
            "https://floorfy.com/tour/2666901?play=no",
            "https://my.matterport.com/show/?m=abc123",
            "https://kuula.co/share/abc123",
        ],
    )
    def test_known_non_image_hosts_are_rejected(self, url):
        assert photo_hash._looks_like_photo_url(url) is False

    @pytest.mark.parametrize(
        "url",
        [
            "https://cdn.fotocasa.es/p1.jpg",
            "https://img.milanuncios.com/p1.JPG",
            "https://example.com/photos/foo.webp?w=800",
            # A thumbnail with a recognized extension on an otherwise
            # video-hosting domain: extension wins (see docstring).
            "https://vimeo.com/thumbnail.jpg",
            # No extension, unknown host — the permissive default: real
            # portal CDNs commonly serve photos from extensionless paths.
            "https://cdn.example-portal.com/listing/12345/photo",
        ],
    )
    def test_image_urls_and_unknown_hosts_are_kept(self, url):
        assert photo_hash._looks_like_photo_url(url) is True

    def test_fetch_hashes_never_calls_requests_get_for_a_filtered_url(
        self, monkeypatch
    ):
        calls: list[str] = []

        def _fake_get(url, **kwargs):
            calls.append(url)
            raise AssertionError("requests.get must not be called for a filtered URL")

        monkeypatch.setattr(photo_hash.requests, "get", _fake_get)
        result = photo_hash.fetch_hashes(
            (
                "https://www.youtube.com/watch?v=herOSioqMOc",
                "https://vimeo.com/1176257186",
                "https://floorfy.com/tour/2666901?play=no",
            )
        )
        assert result == []
        assert calls == []

    def test_fetch_hashes_still_attempts_real_image_urls(self, monkeypatch):
        """The filter must not become an accidental block-everything: a
        genuine image URL alongside filtered ones is still fetched (and, in
        this fake, successfully hashed)."""
        room = _synthetic_room(1)

        class _FakeResponse:
            def __init__(self, image):
                buffer = io.BytesIO()
                image.convert("RGB").save(buffer, "JPEG")
                buffer.seek(0)
                self.raw = buffer
                self.raw.decode_content = True

            def raise_for_status(self):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _fake_get(url, **kwargs):
            assert url == "https://cdn.example.com/real.jpg"
            return _FakeResponse(room)

        monkeypatch.setattr(photo_hash.requests, "get", _fake_get)
        result = photo_hash.fetch_hashes(
            (
                "https://vimeo.com/1176257186",
                "https://cdn.example.com/real.jpg",
            )
        )
        assert len(result) == 1
        # JPEG re-encoding in the fake response perturbs the hash slightly —
        # compare by Hamming distance (same tolerance the real signal uses),
        # not bit-for-bit equality.
        assert int(result[0] - _hash(room)) <= photo_hash._HASH_HAMMING_THRESHOLD


class TestRuleParameterCdnPattern:
    """Issue #206: encodes the real Milanuncios CDN behaviour discovered
    live (2026-08-04, evidence in the PR description) as an offline,
    network-free regression test — a fake `requests.get` that reproduces
    exactly the confirmed contract (404 "Rule parameter not Found" without
    a `?rule=` query param, 200 with one) rather than merely asserting
    against a canned response. This is the pattern the connector fix
    (`etl/connectors/milanuncios.py::normalize`'s `_to_photo_url`) exists
    to satisfy — see that module for the live curl evidence.
    """

    @staticmethod
    def _fake_milanuncios_cdn(image):
        """A `requests.get` stand-in for images.milanuncios.com/api/v1/
        ma-ad-media-pro/... : 404s any URL without a `rule` query param,
        200s (with a real image) otherwise. Mirrors the live response body
        ("404 Rule parameter not Found") closely enough to exercise
        `raise_for_status()` the same way the real `requests.HTTPError`
        does."""

        class _FakeResponse:
            def __init__(self, ok: bool):
                self._ok = ok
                if ok:
                    buffer = io.BytesIO()
                    image.convert("RGB").save(buffer, "JPEG")
                    buffer.seek(0)
                    self.raw = buffer
                    self.raw.decode_content = True

            def raise_for_status(self):
                if not self._ok:
                    import requests as _requests

                    raise _requests.exceptions.HTTPError(
                        "404 Client Error: Rule parameter not Found"
                    )

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _fake_get(url, **kwargs):
            has_rule = "rule=" in url.split("?", 1)[1] if "?" in url else False
            return _FakeResponse(ok=has_rule)

        return _fake_get

    def test_bare_url_without_rule_param_fails_exactly_like_production(
        self, monkeypatch
    ):
        """Pins the actual reported symptom: a bare `ad.images` URL (the
        pre-fix shape) fails against this CDN."""
        monkeypatch.setattr(
            photo_hash.requests, "get", self._fake_milanuncios_cdn(_synthetic_room(1))
        )
        bare_url = (
            "https://images.milanuncios.com/api/v1/ma-ad-media-pro/"
            "images/d2b83929-0000-0000-0000-000000000000"
        )
        result = photo_hash.fetch_hashes((bare_url,), source="milanuncios")
        assert result == []

    def test_connector_normalized_url_succeeds_against_the_same_cdn(self, monkeypatch):
        """The connector's fix (appending `?rule=detail_640x480`) produces
        a URL this same simulated CDN accepts — i.e. the fix in
        milanuncios.py and the CDN contract this test encodes actually
        line up, not just each in isolation."""
        from etl.connectors.base import RawListing
        from etl.connectors.milanuncios import MilanunciosConnector

        monkeypatch.setattr(
            photo_hash.requests, "get", self._fake_milanuncios_cdn(_synthetic_room(1))
        )
        raw = RawListing(
            external_id="1",
            source="milanuncios",
            raw={
                "url": "https://www.milanuncios.com/x",
                "props": {
                    "ad": {
                        "images": [
                            (
                                "images.milanuncios.com/api/v1/ma-ad-media-pro/"
                                "images/d2b83929-0000-0000-0000-000000000000"
                            )
                        ]
                    }
                },
            },
        )
        canonical = MilanunciosConnector().normalize(raw)
        result = photo_hash.fetch_hashes(canonical.photo_urls, source="milanuncios")
        assert len(result) == 1


class TestAggregatedFailureLogging:
    """Issue #206: a failed hash used to log its own WARNING per photo —
    dozens of near-identical lines per run for one systemic CDN failure.
    Individual failures now log at DEBUG; one aggregated WARNING per
    `fetch_hashes` call (i.e. per listing) reports the count.
    """

    def _fake_get_always_fails(self, url, **kwargs):
        raise ConnectionError("simulated network failure")

    def test_multiple_failures_produce_one_warning_not_one_per_photo(
        self, monkeypatch, caplog
    ):
        monkeypatch.setattr(photo_hash.requests, "get", self._fake_get_always_fails)
        urls = tuple(f"https://cdn.example.com/p{i}.jpg" for i in range(5))
        with caplog.at_level("DEBUG", logger="etl.dedup.signals.photo_hash"):
            result = photo_hash.fetch_hashes(urls, source="testsource")
        assert result == []
        warnings = [r for r in caplog.records if r.levelname == "WARNING"]
        debugs = [r for r in caplog.records if r.levelname == "DEBUG"]
        assert len(warnings) == 1, (
            f"expected exactly one aggregated WARNING for 5 failures, got "
            f"{len(warnings)}: {[w.message for w in warnings]}"
        )
        assert "5/5" in warnings[0].message
        assert "testsource" in warnings[0].message
        # The individual per-URL failures are still traceable, just at a
        # quieter level — not silently dropped.
        assert len(debugs) == 5

    def test_no_failures_means_no_warning(self, monkeypatch, caplog):
        room = _synthetic_room(1)

        class _FakeResponse:
            def __init__(self):
                buffer = io.BytesIO()
                room.convert("RGB").save(buffer, "JPEG")
                buffer.seek(0)
                self.raw = buffer
                self.raw.decode_content = True

            def raise_for_status(self):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        monkeypatch.setattr(
            photo_hash.requests, "get", lambda url, **kwargs: _FakeResponse()
        )
        with caplog.at_level("DEBUG", logger="etl.dedup.signals.photo_hash"):
            result = photo_hash.fetch_hashes(
                ("https://cdn.example.com/ok.jpg",), source="testsource"
            )
        assert len(result) == 1
        assert [r for r in caplog.records if r.levelname == "WARNING"] == []


class TestAttemptablePhotoCount:
    """Issue #206: the dedup engine's per-source health tracking needs to
    know how many URLs `fetch_hashes` will actually try, excluding the
    video/tour links `_looks_like_photo_url` filters out before any
    network call — otherwise a listing with photos + video links would
    make a perfectly healthy source look partially degraded."""

    def test_counts_only_urls_fetch_hashes_would_attempt(self):
        urls = (
            "https://cdn.example.com/real1.jpg",
            "https://www.youtube.com/watch?v=abc",
            "https://cdn.example.com/real2.jpg",
            "https://vimeo.com/12345",
        )
        assert photo_hash.attemptable_photo_count(urls) == 2

    def test_zero_for_an_all_video_photo_set(self):
        urls = ("https://youtu.be/abc", "https://vimeo.com/123")
        assert photo_hash.attemptable_photo_count(urls) == 0

    def test_zero_for_an_empty_tuple(self):
        assert photo_hash.attemptable_photo_count(()) == 0


class TestConfidenceScaling:
    def test_floor_ratio_maps_to_the_floor_confidence(self):
        assert (
            photo_hash.confidence_for_ratio(float(photo_hash.MIN_MATCH_RATIO))
            == photo_hash.MIN_MATCH_RATIO
        )

    def test_full_ratio_maps_to_the_capped_confidence(self):
        assert (
            photo_hash.confidence_for_ratio(1.0)
            == photo_hash._MAX_SUGGESTION_CONFIDENCE
        )

    def test_confidence_never_exceeds_the_suggestion_cap(self):
        """This signal is suggestion-only — it must never reach a confidence
        the engine would treat as an auto-merge."""
        for ratio in (0.6, 0.75, 0.9, 1.0):
            assert (
                photo_hash.confidence_for_ratio(ratio)
                <= photo_hash._MAX_SUGGESTION_CONFIDENCE
            )
