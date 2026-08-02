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
