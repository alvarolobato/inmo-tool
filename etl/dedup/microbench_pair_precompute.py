"""Issue #618 microbenchmark — NOT CI-gated, run by hand.

Measures `photo_hash.match_ratio`'s per-pair cost before vs. after the
packed-int change, on the worst case the issue's own profile called out:
a 15x15 NON-matching pair (both sides have photos, nothing matches — the
case that can't short-circuit, since `match_ratio` must scan every
combination to conclude "no match").

Usage::

    python -m etl.dedup.microbench_pair_precompute

Acceptance criterion (issue #618, task 1): shows >= 3x on match_ratio
15x15. Fable's profile measured 155us -> 42us packed-int (~4x) locally,
9.5us numpy-vectorized (~16x) — either is acceptable; this repo took the
simpler packed-int diff.
"""

from __future__ import annotations

import random
import time

import imagehash
import numpy

from etl.dedup.signals import photo_hash

_HASH_HAMMING_THRESHOLD = 10  # pinned independently — see the equivalence
# test module's identical comment for why.

_ITERATIONS = 20_000


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


def _reference_match_ratio(hashes_a, hashes_b):
    """Frozen pre-#618 algorithm — see test_dedup_pair_precompute_equivalence.py."""
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


def main() -> None:
    rng = random.Random(618)
    # 15x15, deliberately NON-matching (every pairwise distance > threshold)
    # — the worst case: match_ratio can't short-circuit on a hit, it has to
    # scan all 225 combinations to conclude "nothing matches".
    hashes_a = [_random_hash(rng) for _ in range(15)]
    hashes_b = [_flip_bits(h, 32, rng) for h in hashes_a]
    for h_a in hashes_a:
        for h_b in hashes_b:
            assert int(h_a - h_b) > _HASH_HAMMING_THRESHOLD, (
                "corpus generator produced an accidental match — rerun with "
                "a different seed"
            )

    packed_a = [photo_hash.pack_hash(h) for h in hashes_a]
    packed_b = [photo_hash.pack_hash(h) for h in hashes_b]

    # Sanity: both implementations agree before timing them.
    assert _reference_match_ratio(hashes_a, hashes_b) == photo_hash.match_ratio(
        packed_a, packed_b
    )

    start = time.perf_counter()
    for _ in range(_ITERATIONS):
        _reference_match_ratio(hashes_a, hashes_b)
    old_elapsed = time.perf_counter() - start
    old_per_pair_us = old_elapsed / _ITERATIONS * 1_000_000

    start = time.perf_counter()
    for _ in range(_ITERATIONS):
        photo_hash.match_ratio(packed_a, packed_b)
    new_elapsed = time.perf_counter() - start
    new_per_pair_us = new_elapsed / _ITERATIONS * 1_000_000

    speedup = old_per_pair_us / new_per_pair_us
    print(f"iterations:        {_ITERATIONS}")
    print(f"pre-#618 (ImageHash.__sub__): {old_per_pair_us:.2f} us/pair")
    print(f"post-#618 (packed int):       {new_per_pair_us:.2f} us/pair")
    print(f"speedup:                      {speedup:.1f}x")
    assert speedup >= 3.0, (
        f"expected >= 3x speedup on a 15x15 non-matching pair, measured "
        f"{speedup:.1f}x — see issue #618's acceptance criteria"
    )
    print("OK: >= 3x speedup confirmed")


if __name__ == "__main__":
    main()
