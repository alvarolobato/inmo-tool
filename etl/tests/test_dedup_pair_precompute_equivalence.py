"""Issue #618 (D-136): proof that packed-int photo-hash comparison and
per-run phone memoization produce BIT-FOR-BIT IDENTICAL `evaluate_pair`
verdicts to the pre-#618 algorithm — never asserted, always measured.

This module does NOT import `etl.dedup.engine.evaluate_pair`'s pre-#618
behaviour from anywhere (that code was changed in place, so no live
"old" implementation exists to import). Instead it pins a FROZEN,
independently-written copy of the pre-#618 `match_ratio`/
`hashes_share_any_match` (operating on raw `imagehash.ImageHash` objects,
exactly as they read before this issue's patch) — the ONE place this
codebase pins that reference; `scripts/dedup-microbench-pair-precompute.py`
imports it from here rather than carrying a second, driftable copy — plus a
hand-assembled `_frozen_evaluate_pair` that mirrors the CURRENT
`etl.dedup.engine.evaluate_pair`'s control flow step for step, substituting
only the photo-hash/phone internals for their frozen/uncached equivalents.
Every other signal (cadastral, the D-116 reference-code veto,
address_coords, reference_code) is exercised through the REAL, unchanged
modules — this issue never touched them, and running the pipeline for
real end to end (rather than just unit-testing the two changed functions
in isolation) is what actually proves a full pair evaluation, not just a
sub-function, comes out identical.

Three layers of proof, from the tightest identity to the full pipeline:

1. `TestPackHashRoundTripsHammingDistance` — for every hash pair,
   `(pack_hash(a) ^ pack_hash(b)).bit_count() == int(a - b)`
   (ImageHash's own Hamming distance). This is the one identity the whole
   optimization rests on; if it's ever false, everything downstream is
   compromised no matter what the other tests say.
2. `TestMatchRatioParity` / `TestHashesShareAnyMatchParity` — the two
   comparison functions, packed vs frozen-raw, across boundary Hamming
   distances (9/10/11 either side of `_HASH_HAMMING_THRESHOLD`) and
   boundary match ratios (either side of `MIN_MATCH_RATIO` = 0.60, and
   exactly at the #188 exact-match auto-merge boundary, 1.000).
3. `TestEvaluatePairEquivalence` — the full `evaluate_pair` pipeline,
   frozen vs real, over hand-crafted boundary cases AND a randomized fuzz
   corpus, asserting the ENTIRE `PairEvaluation` (basis, confidence,
   decision, and every key in `detail` — not just the verdict) is
   identical. A `detail["match_ratio"]` drift of even 0.001 would move a
   pair across `MIN_MATCH_RATIO`/1.000 silently; this is the layer that
   would catch that, since it compares the real production code path
   (`_PhotoHashCache.get_packed` + `_PhoneCache`) against a fully
   independent frozen implementation, not against itself.
"""

from __future__ import annotations

import random
from decimal import Decimal

import imagehash
import numpy
import pytest

from etl.dedup import engine
from etl.dedup.engine import _PhoneCache, _PhotoHashCache
from etl.dedup.signals import (
    address_coords,
    cadastral,
    phone_extract,
    price_gap,
    reference_code,
)
from etl.dedup.signals import photo_hash as photo_hash_signal
from etl.dedup.signals.floor import floors_conflict
from etl.dedup.types import ListingRecord, PairEvaluation

# Pinned independently of `etl.dedup.signals.photo_hash._HASH_HAMMING_THRESHOLD`:
# if a future change to the real module's threshold isn't mirrored here,
# this test starts failing rather than silently comparing against a
# threshold that no longer matches production, which is the point of a
# FROZEN reference (a copy that tracks the real value would stop being
# independent proof). This is the ONE place that independent pin lives —
# `scripts/dedup-microbench-pair-precompute.py` imports this constant
# rather than carrying its own second copy.
_HASH_HAMMING_THRESHOLD = 10


# ---------------------------------------------------------------------------
# Frozen pre-#618 reference algorithms (raw imagehash.ImageHash, no packing,
# no memoization) — hand-transcribed from the pre-patch source, never
# imported from etl.dedup.signals.photo_hash (which no longer has them in
# this form).
# ---------------------------------------------------------------------------


def _reference_match_ratio(
    hashes_a: list[imagehash.ImageHash], hashes_b: list[imagehash.ImageHash]
) -> float | None:
    if not hashes_a or not hashes_b:
        return None
    smaller, larger = (
        (hashes_a, hashes_b) if len(hashes_a) <= len(hashes_b) else (hashes_b, hashes_a)
    )
    matched = sum(
        1
        for h_small in smaller
        if any((h_small - h_large) <= _HASH_HAMMING_THRESHOLD for h_large in larger)
    )
    return matched / len(smaller)


def _reference_hashes_share_any_match(
    hashes_a: list[imagehash.ImageHash], hashes_b: list[imagehash.ImageHash]
) -> bool:
    return any(
        (h_a - h_b) <= _HASH_HAMMING_THRESHOLD for h_a in hashes_a for h_b in hashes_b
    )


def _synthetic_photo_url(listing_id: int, index: int) -> str:
    """Deterministic placeholder URL for a synthetic hash at
    (listing_id, index) — issue #615's `matched_photos` needs a
    (url, hash) pairing, not bare hashes, and this equivalence suite's
    fixtures only ever carry bare `imagehash.ImageHash` values (built by
    `_random_hash`/`_flip_bits`, no URLs). Shared by `_seeded_caches`
    (which pre-populates the REAL `_PhotoHashCache._cache`) and
    `_frozen_evaluate_pair` (which calls the real, unmodified
    `photo_hash.matched_pairs` directly) — as long as both sides build
    the IDENTICAL (url, hash) pairing from the same `raw_hashes_by_id`,
    in the same order, `matched_pairs` (a pure function, untouched by
    issue #618/#623's optimization) is guaranteed to return byte-identical
    output from both call sites. The URL text itself is never asserted
    on anywhere in this file — only that both sides agree.
    """
    return f"https://frozen.example/{listing_id}-{index}.jpg"


def _synthetic_photo_pairs(
    listing_id: int, hashes: list[imagehash.ImageHash]
) -> list[tuple[str, imagehash.ImageHash]]:
    return [(_synthetic_photo_url(listing_id, i), h) for i, h in enumerate(hashes)]


def _frozen_evaluate_pair(
    a: ListingRecord,
    b: ListingRecord,
    raw_hashes_by_id: dict[int, list[imagehash.ImageHash]],
) -> PairEvaluation | None:
    """Hand-assembled mirror of `etl.dedup.engine.evaluate_pair`'s CURRENT
    control flow, with only the photo-hash/phone internals swapped for
    their frozen (raw-ImageHash, uncached) pre-#618 equivalents. Every
    other signal call goes through the real, unmodified module — this
    issue never touched cadastral/reference_code/address_coords, so
    exercising them for real (rather than re-implementing them too) keeps
    this comparison honest about what actually changed.
    """
    cadastral_result = cadastral.evaluate(a, b)
    if cadastral_result is not None:
        return cadastral_result

    if reference_code.reference_codes_conflict(a, b):
        return None

    for evaluate_fn in (address_coords.evaluate, reference_code.evaluate):
        result = evaluate_fn(a, b)
        if result is not None:
            return result

    # Issue #627 (D-138): mirrors evaluate_pair's price-gap veto exactly —
    # this issue never touched price_gap.py either, so it's called for
    # real here too, same as cadastral/reference_code/address_coords
    # above. Without this, the fuzz corpus below (which randomizes
    # m2_built/current_price per pair) would diverge the moment a
    # randomly-generated pair happened to clear the rule.
    price_gap_reason = price_gap.price_gap_conflict(a, b)
    if price_gap_reason is not None:
        return PairEvaluation(
            basis="price_gap",
            confidence=Decimal("0.000"),
            decision="reject",
            detail=price_gap_reason,
        )

    hashes_a = raw_hashes_by_id.get(a.listing_id, [])
    hashes_b = raw_hashes_by_id.get(b.listing_id, [])
    ratio = _reference_match_ratio(hashes_a, hashes_b)
    if ratio is not None and Decimal(str(ratio)) >= photo_hash_signal.MIN_MATCH_RATIO:
        detail: dict = {"match_ratio": round(ratio, 3)}
        # Issue #602/D-137 (2026-08-20): floor_conflict is still computed
        # and surfaced in `detail` for a human reviewing a `suggest`
        # verdict, but no longer gates the merge decision below — mirrors
        # the CURRENT etl.dedup.engine.evaluate_pair exactly (this file
        # freezes the pre-#618 HASH REPRESENTATION, not the merge rule,
        # which must track production as it changes).
        floor_conflict = floors_conflict(a.floor, b.floor)
        if floor_conflict:
            detail["floor_conflict"] = True

        # Issue #615's matched_photos key — mirrors the REAL evaluate_pair
        # exactly (same control-flow position: right after floor_conflict,
        # before the exact-match auto-merge check), calling the real,
        # unmodified `photo_hash.matched_pairs` (issue #618/#623 never
        # touched it) against the SAME synthetic (url, hash) pairing
        # `_seeded_caches` pre-populated `_PhotoHashCache._cache` with, so
        # this can never silently drift from what the real path computes.
        matches = photo_hash_signal.matched_pairs(
            _synthetic_photo_pairs(a.listing_id, hashes_a),
            _synthetic_photo_pairs(b.listing_id, hashes_b),
        )
        if matches:
            detail["matched_photos"] = [
                {"url_a": m.url_a, "url_b": m.url_b, "distance": m.distance}
                for m in matches
            ]

        # D-137: m2_built must be EXACTLY equal (address_coords.sizes_equal,
        # no tolerance) — replacing the old sizes_close(..., 5%) band this
        # file used to freeze. Price band is PHOTO_MERGE_PRICE_RATIO (5%,
        # revised from an initial 2% same day).
        exact_match = Decimal(str(round(ratio, 3))) == Decimal("1.000")
        if (
            exact_match
            and address_coords.sizes_equal(a.m2_built, b.m2_built)
            and address_coords.prices_close(
                a.current_price,
                b.current_price,
                photo_hash_signal.PHOTO_MERGE_PRICE_RATIO,
            )
        ):
            return PairEvaluation(
                basis="photo_hash",
                confidence=photo_hash_signal.PHOTO_MERGE_CONFIDENCE,
                decision="merge",
                detail=detail,
            )

        return PairEvaluation(
            basis="photo_hash",
            confidence=photo_hash_signal.confidence_for_ratio(ratio),
            decision="suggest",
            detail=detail,
        )

    # Pre-#618 behaviour: extract phones fresh from each description on
    # every call, no cache.
    return phone_extract.evaluate(a, b)


# ---------------------------------------------------------------------------
# Synthetic hash / listing builders
# ---------------------------------------------------------------------------


def _random_hash(rng: random.Random) -> imagehash.ImageHash:
    bits = numpy.array([rng.random() < 0.5 for _ in range(64)], dtype=bool)
    return imagehash.ImageHash(bits.reshape(8, 8))


def _flip_bits(
    h: imagehash.ImageHash, distance: int, rng: random.Random
) -> imagehash.ImageHash:
    flat = h.hash.flatten().copy()
    for pos in rng.sample(range(64), distance):
        flat[pos] = not flat[pos]
    return imagehash.ImageHash(flat.reshape(8, 8))


def _controlled_ratio_sets(rng: random.Random, n_match: int, n_no_match: int):
    """Build (smaller, larger) hash sets where exactly *n_match* pairs are
    guaranteed to match (identical hash both sides, distance 0) and
    *n_no_match* pairs are guaranteed NOT to match — via the exact bitwise
    complement (flip all 64 bits, distance 64), an algorithmic guarantee
    rather than a probabilistic one from picking some smaller flip
    distance. `matched / len(smaller)` is therefore an EXACT fraction,
    never a value that merely happens to land near a boundary for one
    particular seed."""
    matching = [_random_hash(rng) for _ in range(n_match)]
    no_match_small = [_random_hash(rng) for _ in range(n_no_match)]
    no_match_large = [_flip_bits(h, 64, rng) for h in no_match_small]
    smaller = matching + no_match_small
    larger = matching + no_match_large
    return smaller, larger


def _record(listing_id: int, property_id: int, **overrides) -> ListingRecord:
    return ListingRecord(
        listing_id=listing_id,
        property_id=property_id,
        source=overrides.get("source", "idealista"),
        external_id=overrides.get("external_id", str(listing_id)),
        listing_kind=overrides.get("listing_kind"),
        description=overrides.get("description"),
        photo_urls=overrides.get("photo_urls", ()),
        cadastral_ref=overrides.get("cadastral_ref"),
        address=overrides.get("address"),
        lat=overrides.get("lat"),
        lon=overrides.get("lon"),
        m2_built=overrides.get("m2_built"),
        current_price=overrides.get("current_price"),
        contact_raw=overrides.get("contact_raw"),
        reference_code=overrides.get("reference_code"),
        floor=overrides.get("floor"),
        property_type=overrides.get("property_type"),
        rooms=overrides.get("rooms"),
    )


def _seeded_caches(
    raw_hashes_by_id: dict[int, list[imagehash.ImageHash]],
) -> tuple[_PhotoHashCache, _PhoneCache]:
    """Real `_PhotoHashCache`/`_PhoneCache`, pre-populated so `evaluate_pair`
    never hits the network — same pattern the engine's own test suite uses
    (`TestPhotoHashAutoMerge` et al., see `_PhotoHashCache.get_packed`'s
    docstring)."""
    hash_cache = _PhotoHashCache()
    for listing_id, hashes in raw_hashes_by_id.items():
        # Issue #615: _cache holds (url, hash) PAIRS now, not bare hashes
        # — `_synthetic_photo_pairs` is the SAME helper `_frozen_evaluate_pair`
        # uses to build its own matched_pairs input, so both sides compute
        # matched_photos from an identical (url, hash) correspondence.
        hash_cache._cache[listing_id] = _synthetic_photo_pairs(listing_id, hashes)
    return hash_cache, _PhoneCache()


def _assert_identical(
    frozen: PairEvaluation | None, real: PairEvaluation | None, *, case: str
) -> None:
    assert (frozen is None) == (real is None), (
        f"{case}: one side matched and the other didn't — "
        f"frozen={frozen!r} real={real!r}"
    )
    if frozen is None:
        return
    assert frozen.basis == real.basis, case
    assert frozen.decision == real.decision, case
    assert frozen.confidence == real.confidence, (
        f"{case}: confidence drifted — frozen={frozen.confidence!r} "
        f"real={real.confidence!r}"
    )
    assert frozen.detail == real.detail, (
        f"{case}: detail drifted — frozen={frozen.detail!r} real={real.detail!r}"
    )


# ---------------------------------------------------------------------------
# Layer 1: the packing identity itself
# ---------------------------------------------------------------------------


class TestPackHashRoundTripsHammingDistance:
    """`pack_hash(a) ^ pack_hash(b)` bit-counted must equal `int(a - b)` for
    every pair — the one identity the entire optimization depends on."""

    def test_random_pairs(self):
        rng = random.Random(1)
        for _ in range(2000):
            h_a = _random_hash(rng)
            distance = rng.randint(0, 64)
            h_b = _flip_bits(h_a, distance, rng)
            expected = int(h_a - h_b)
            packed_distance = (
                photo_hash_signal.pack_hash(h_a) ^ photo_hash_signal.pack_hash(h_b)
            ).bit_count()
            assert packed_distance == expected

    @pytest.mark.parametrize("distance", [0, 1, 9, 10, 11, 32, 63, 64])
    def test_boundary_distances(self, distance):
        rng = random.Random(distance)
        h_a = _random_hash(rng)
        h_b = _flip_bits(h_a, distance, rng)
        expected = int(h_a - h_b)
        assert expected == distance
        packed_distance = (
            photo_hash_signal.pack_hash(h_a) ^ photo_hash_signal.pack_hash(h_b)
        ).bit_count()
        assert packed_distance == distance

    def test_identical_hashes_pack_to_the_same_int(self):
        rng = random.Random(2)
        h = _random_hash(rng)
        assert photo_hash_signal.pack_hash(h) == photo_hash_signal.pack_hash(h)

    def test_rejects_a_non_64_bit_hash(self):
        # imagehash.ImageHash with a smaller hash_size (e.g. average_hash's
        # historical default) — never produced by this codebase's own
        # imagehash.phash(...) call sites, but pack_hash must fail loudly
        # rather than silently XOR-ing bits that don't correspond to the
        # same DCT coefficient on each side.
        small = imagehash.ImageHash(numpy.zeros((4, 4), dtype=bool))
        with pytest.raises(ValueError):
            photo_hash_signal.pack_hash(small)


# ---------------------------------------------------------------------------
# Layer 2: match_ratio / hashes_share_any_match parity
# ---------------------------------------------------------------------------


class TestMatchRatioParity:
    def _compare(self, hashes_a, hashes_b):
        expected = _reference_match_ratio(hashes_a, hashes_b)
        packed_a = [photo_hash_signal.pack_hash(h) for h in hashes_a]
        packed_b = [photo_hash_signal.pack_hash(h) for h in hashes_b]
        actual = photo_hash_signal.match_ratio(packed_a, packed_b)
        assert actual == expected, f"expected {expected!r}, got {actual!r}"
        return actual

    def test_both_empty_is_none(self):
        self._compare([], [])

    def test_one_side_empty_is_none(self):
        rng = random.Random(3)
        self._compare([], [_random_hash(rng)])
        self._compare([_random_hash(rng)], [])

    def test_random_sets_various_sizes(self):
        rng = random.Random(4)
        for size_a, size_b in [(1, 1), (3, 5), (15, 15), (1, 15), (15, 1), (0, 15)]:
            hashes_a = [_random_hash(rng) for _ in range(size_a)]
            hashes_b = [_random_hash(rng) for _ in range(size_b)]
            self._compare(hashes_a, hashes_b)

    def test_worst_case_15x15_no_match(self):
        rng = random.Random(618)
        hashes_a = [_random_hash(rng) for _ in range(15)]
        hashes_b = [_flip_bits(h, 32, rng) for h in hashes_a]
        ratio = self._compare(hashes_a, hashes_b)
        assert ratio == 0.0

    @pytest.mark.parametrize("distance", [9, 10, 11])
    def test_single_pair_at_hamming_boundary(self, distance):
        """A single-hash-per-side pair at exactly the Hamming cutoff (10):
        9 and 10 must match (ratio 1.0), 11 must not (ratio 0.0) — on BOTH
        the frozen ImageHash-subtraction path and the packed-int path."""
        rng = random.Random(100 + distance)
        h_a = _random_hash(rng)
        h_b = _flip_bits(h_a, distance, rng)
        ratio = self._compare([h_a], [h_b])
        assert ratio == (1.0 if distance <= _HASH_HAMMING_THRESHOLD else 0.0)

    def test_ratio_exactly_at_min_match_ratio_boundary(self):
        """3/5 = 0.6 exactly == MIN_MATCH_RATIO — the smallest denominator
        that lands precisely on the suggestion floor, both sides of it."""
        rng = random.Random(5)
        smaller, larger = _controlled_ratio_sets(rng, n_match=3, n_no_match=2)
        ratio = self._compare(smaller, larger)
        assert ratio == pytest.approx(0.6)
        assert Decimal(str(ratio)) >= photo_hash_signal.MIN_MATCH_RATIO

    def test_ratio_just_below_min_match_ratio(self):
        """59/100 = 0.59, just under the 0.60 floor — proves the boundary
        comparison (not just the ratio value) agrees on both paths."""
        rng = random.Random(6)
        smaller, larger = _controlled_ratio_sets(rng, n_match=59, n_no_match=41)
        ratio = self._compare(smaller, larger)
        assert ratio == pytest.approx(0.59)
        assert Decimal(str(ratio)) < photo_hash_signal.MIN_MATCH_RATIO

    def test_ratio_just_above_min_match_ratio(self):
        rng = random.Random(7)
        smaller, larger = _controlled_ratio_sets(rng, n_match=61, n_no_match=39)
        ratio = self._compare(smaller, larger)
        assert ratio == pytest.approx(0.61)
        assert Decimal(str(ratio)) >= photo_hash_signal.MIN_MATCH_RATIO

    def test_exact_full_match_ratio_is_1_000(self):
        """The #188 auto-merge boundary — ratio must land EXACTLY at
        1.000, not 0.999-ish, on both paths."""
        rng = random.Random(8)
        shared = [_random_hash(rng) for _ in range(5)]
        ratio = self._compare(shared, list(shared))
        assert ratio == 1.0


class TestHashesShareAnyMatchParity:
    def _compare(self, hashes_a, hashes_b):
        expected = _reference_hashes_share_any_match(hashes_a, hashes_b)
        packed_a = [photo_hash_signal.pack_hash(h) for h in hashes_a]
        packed_b = [photo_hash_signal.pack_hash(h) for h in hashes_b]
        actual = photo_hash_signal.hashes_share_any_match(packed_a, packed_b)
        assert actual == expected
        return actual

    def test_empty_sides(self):
        rng = random.Random(9)
        assert self._compare([], []) is False
        assert self._compare([], [_random_hash(rng)]) is False

    def test_random_sets(self):
        rng = random.Random(10)
        for size_a, size_b in [(1, 1), (5, 5), (15, 15)]:
            hashes_a = [_random_hash(rng) for _ in range(size_a)]
            hashes_b = [_random_hash(rng) for _ in range(size_b)]
            self._compare(hashes_a, hashes_b)

    @pytest.mark.parametrize("distance", [9, 10, 11])
    def test_boundary_distance(self, distance):
        rng = random.Random(200 + distance)
        h_a = _random_hash(rng)
        h_b = _flip_bits(h_a, distance, rng)
        result = self._compare([h_a], [h_b])
        assert result == (distance <= _HASH_HAMMING_THRESHOLD)


# ---------------------------------------------------------------------------
# Layer 3: full evaluate_pair pipeline, frozen vs real (production) code
# ---------------------------------------------------------------------------


class TestEvaluatePairEquivalence:
    """`etl.dedup.engine.evaluate_pair` (real, production code — packed
    hashes + `_PhoneCache`) vs `_frozen_evaluate_pair` (raw ImageHash,
    uncached extraction) over identical inputs. No DB, no network — every
    listing's photo hashes are pre-seeded into `_PhotoHashCache._cache`
    directly, exactly like the engine's own test suite does."""

    def _run_both(
        self,
        a: ListingRecord,
        b: ListingRecord,
        raw_hashes_by_id: dict[int, list[imagehash.ImageHash]],
        *,
        case: str,
    ) -> None:
        hash_cache, phone_cache = _seeded_caches(raw_hashes_by_id)
        real = engine.evaluate_pair(a, b, hash_cache, phone_cache)
        frozen = _frozen_evaluate_pair(a, b, raw_hashes_by_id)
        _assert_identical(frozen, real, case=case)

    def test_no_evidence_at_all_is_none(self):
        a = _record(1, 1)
        b = _record(2, 2)
        self._run_both(a, b, {}, case="no evidence")

    def test_exact_photo_match_corroborated_auto_merges(self):
        """Issue #602/D-137 (2026-08-20): the original fixture used
        m2_built=90 vs 91 (1.1% apart) — inside the OLD sizes_close(5%)
        band this file used to freeze, but D-137 requires m2_built to be
        EXACTLY equal, so 90-vs-91 would no longer clear the auto-merge
        gate (the review's own finding: "the 90-vs-91 m² case" would
        silently invert to 'suggest' after this file's frozen reference
        was updated to the D-137 rule, unless the fixture itself moved
        with it). Both sides now carry m2_built=90 so this case still
        actually exercises the MERGE branch, on both frozen and real —
        the point of this specific test."""
        rng = random.Random(11)
        shared = [_random_hash(rng) for _ in range(4)]
        a = _record(
            1, 1, m2_built=Decimal(90), current_price=Decimal(200000), floor="3"
        )
        b = _record(
            2, 2, m2_built=Decimal(90), current_price=Decimal(201000), floor="3"
        )
        hash_cache, phone_cache = _seeded_caches({1: shared, 2: list(shared)})
        real = engine.evaluate_pair(a, b, hash_cache, phone_cache)
        assert real is not None and real.decision == "merge", (
            "fixture must actually exercise the D-137 merge branch"
        )
        self._run_both(
            a, b, {1: shared, 2: list(shared)}, case="exact match, corroborated"
        )

    def test_exact_photo_match_floor_conflict_no_longer_downgrades(self):
        """Issue #602/D-137 (2026-08-20): this case used to prove a floor
        conflict downgrades an otherwise-qualifying exact-match auto-merge
        to a suggestion (issue #186's veto). D-137 dropped that veto from
        the gate — see photo_hash.PHOTO_MERGE_PRICE_RATIO's module comment
        for why — so this same fixture (m2_built exact, price exact,
        floors conflicting) now AUTO-MERGES on both frozen and real; the
        review's own finding: this is one of the two named cases that
        INVERT, not just drift, once the frozen reference is updated to
        match D-137. `floor_conflict` must still be True in `detail` —
        surfaced for suggestion review even on a pair that goes on to
        merge — just no longer blocking."""
        rng = random.Random(12)
        shared = [_random_hash(rng) for _ in range(4)]
        a = _record(
            1, 1, m2_built=Decimal(90), current_price=Decimal(200000), floor="3"
        )
        b = _record(
            2, 2, m2_built=Decimal(90), current_price=Decimal(200000), floor="5"
        )
        hash_cache, phone_cache = _seeded_caches({1: shared, 2: list(shared)})
        real = engine.evaluate_pair(a, b, hash_cache, phone_cache)
        assert real is not None
        assert real.decision == "merge"
        assert real.detail["floor_conflict"] is True
        self._run_both(
            a, b, {1: shared, 2: list(shared)}, case="exact match, floor conflict"
        )

    def test_exact_photo_match_uncorroborated_size_stays_a_suggestion(self):
        rng = random.Random(13)
        shared = [_random_hash(rng) for _ in range(4)]
        a = _record(1, 1, m2_built=Decimal(90), current_price=Decimal(200000))
        b = _record(2, 2, m2_built=Decimal(140), current_price=Decimal(200000))
        self._run_both(
            a, b, {1: shared, 2: list(shared)}, case="exact match, size mismatch"
        )

    def test_partial_photo_match_just_above_min_ratio_is_a_suggestion(self):
        rng = random.Random(14)
        hashes_a, hashes_b = _controlled_ratio_sets(rng, n_match=61, n_no_match=39)
        a = _record(1, 1)
        b = _record(2, 2)
        self._run_both(
            a, b, {1: hashes_a, 2: hashes_b}, case="partial match, just above 0.60"
        )

    def test_partial_photo_match_just_below_min_ratio_falls_through_to_phone(self):
        rng = random.Random(15)
        hashes_a, hashes_b = _controlled_ratio_sets(rng, n_match=59, n_no_match=41)
        a = _record(1, 1, description="Piso reformado, sin más datos.")
        b = _record(2, 2, description="Bonito piso, contactar agencia.")
        self._run_both(
            a, b, {1: hashes_a, 2: hashes_b}, case="partial match, just below 0.60"
        )

    def test_shared_phone_corroborated_particular_merges(self):
        a = _record(
            1,
            1,
            description="Vende particular, llamar al 611222333",
            listing_kind="particular",
            lat=Decimal("40.4000"),
            lon=Decimal("-3.7000"),
            m2_built=Decimal(80),
        )
        b = _record(
            2,
            2,
            description="Piso en venta, tel 611 222 333",
            listing_kind="particular",
            lat=Decimal("40.4001"),
            lon=Decimal("-3.7001"),
            m2_built=Decimal(81),
        )
        self._run_both(a, b, {}, case="phone corroborated particular/particular")

    def test_shared_phone_agency_never_suggests(self):
        a = _record(
            1,
            1,
            description="Consulte con nuestra inmobiliaria, tel 622333444",
            listing_kind="agency",
            m2_built=Decimal(80),
            current_price=Decimal(150000),
        )
        b = _record(
            2,
            2,
            description="Anuncio de agencia, 622 333 444",
            listing_kind="agency",
            m2_built=Decimal(81),
            current_price=Decimal(151000),
        )
        self._run_both(a, b, {}, case="phone shared, both agency")

    def test_shared_phone_uncorroborated_is_silent(self):
        a = _record(1, 1, description="Contactar 633444555")
        b = _record(2, 2, description="Tel: 633444555", m2_built=Decimal(500))
        self._run_both(a, b, {}, case="phone shared, uncorroborated")

    def test_shared_phone_unconfirmed_kind_suggests(self):
        a = _record(
            1,
            1,
            description="Piso, contacto 644555666",
            m2_built=Decimal(70),
            current_price=Decimal(120000),
        )
        b = _record(
            2,
            2,
            description="Se vende, tel 644 555 666",
            m2_built=Decimal(71),
            current_price=Decimal(121000),
        )
        self._run_both(a, b, {}, case="phone shared, unconfirmed listing_kind")

    def test_cadastral_match_short_circuits_before_photo_or_phone(self):
        a = _record(1, 1, cadastral_ref="1234567AB1234C0001XY")
        b = _record(2, 2, cadastral_ref="1234567AB1234C0001XY")
        self._run_both(a, b, {}, case="cadastral exact match")

    def test_reference_code_conflict_veto_short_circuits(self):
        a = _record(1, 1, contact_raw="Inmobiliaria Ejemplo", reference_code="REF-100")
        b = _record(2, 2, contact_raw="Inmobiliaria Ejemplo", reference_code="REF-200")
        self._run_both(a, b, {}, case="reference-code conflict veto")

    def test_randomized_fuzz_corpus(self):
        """Broad, unstructured coverage: many pairs with varied photo-hash
        counts (0-15, some overlapping, some not) and phones (shared or
        not), run through both paths.

        Price draw (review M4): prices used to be drawn INDEPENDENTLY per
        side from U[80k, 400k] — most pairs then differed by >=15% on
        price alone, so most of the 300 cases exited at `price_gap`
        before ever reaching the packed-hash/photo_hash code this harness
        exists to guard (measured: 230/300 hit price_gap, only 25/300
        reached photo_hash, vs. 112/300 with the rule neutralised — a
        4.5x drop in the coverage this class is actually FOR). Most
        pairs now get a price within a tight ~5% band of each other
        (`_close_price`) so they clear price_gap and exercise photo_hash/
        phone as before `price_gap` existed; a minority keep the old
        fully-independent draw so the corpus still exercises the
        price_gap-preempts-what-would-otherwise-match interaction
        (covered more precisely by TestPriceGapRule, but worth a fuzz
        pass here too since this file's whole job is catching drift no
        single hand-written case would)."""
        rng = random.Random(618618)
        phone_pool = ["611222333", "622333444", "633444555", "644555666"]

        def _close_price(base: Decimal) -> Decimal:
            # Comfortably inside price_gap's 15% soft-reject floor, so a
            # pair drawn this way never exits at price_gap regardless of
            # how far apart its independently-drawn m2_built happens to
            # land (rule 2 never even looks at size until price clears
            # 15%).
            return (base * Decimal(str(round(rng.uniform(0.95, 1.05), 4)))).quantize(
                Decimal(1)
            )

        for i in range(300):
            size_a = rng.randint(0, 15)
            size_b = rng.randint(0, 15)
            overlap = rng.randint(0, min(size_a, size_b))
            shared_hashes = [_random_hash(rng) for _ in range(overlap)]
            hashes_a = shared_hashes + [
                _random_hash(rng) for _ in range(size_a - overlap)
            ]
            hashes_b = list(shared_hashes) + [
                _random_hash(rng) for _ in range(size_b - overlap)
            ]
            rng.shuffle(hashes_a)
            rng.shuffle(hashes_b)

            share_phone = rng.random() < 0.3
            phone = rng.choice(phone_pool)
            desc_a = f"Piso en venta, referencia {i}."
            desc_b = f"Se vende piso, ref {i}."
            if share_phone:
                desc_a += f" Tel {phone}"
                desc_b += f" Tel {phone}"

            kind_choices = [None, "particular", "agency"]
            listing_id_a, listing_id_b = 1000 + i * 2, 1000 + i * 2 + 1
            price_a = Decimal(rng.randint(80000, 400000))
            # 85% close (clears price_gap, reaches photo_hash/phone as
            # before that rule existed), 15% fully independent (keeps
            # some price_gap-interaction coverage) — see this method's
            # own docstring, review M4.
            price_b = (
                _close_price(price_a)
                if rng.random() < 0.85
                else Decimal(rng.randint(80000, 400000))
            )
            a = _record(
                listing_id_a,
                listing_id_a,
                description=desc_a,
                listing_kind=rng.choice(kind_choices),
                m2_built=Decimal(rng.randint(40, 200)),
                current_price=price_a,
            )
            b = _record(
                listing_id_b,
                listing_id_b,
                description=desc_b,
                listing_kind=rng.choice(kind_choices),
                m2_built=Decimal(rng.randint(40, 200)),
                current_price=price_b,
            )
            raw_hashes_by_id = {listing_id_a: hashes_a, listing_id_b: hashes_b}
            self._run_both(a, b, raw_hashes_by_id, case=f"fuzz #{i}")
