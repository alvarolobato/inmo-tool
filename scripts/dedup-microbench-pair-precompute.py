#!/usr/bin/env python3
"""Issue #618 microbenchmark — NOT CI-gated, run by hand.

Lives in scripts/, not etl/dedup/: the ETL Docker image is built with
`COPY . etl/` (etl/Dockerfile) over the `./etl` build context, so anything
under etl/ ships into the running container. This is a dev-only
benchmarking tool, never imported at runtime — scripts/ is outside that
build context and never gets copied in.

Measures `photo_hash.match_ratio`'s per-pair cost before vs. after the
packed-int change, on the worst case the issue's own profile called out:
a 15x15 NON-matching pair (both sides have photos, nothing matches — the
case that can't short-circuit, since `match_ratio` must scan every
combination to conclude "no match").

Imports its frozen pre-#618 reference algorithm (`_reference_match_ratio`),
synthetic-hash builders (`_random_hash`/`_flip_bits`), and the pinned
`_HASH_HAMMING_THRESHOLD` (10) from
`etl/tests/test_dedup_pair_precompute_equivalence.py` rather than carrying
a second, independently-typed copy of any of them — that module is the
ONE place this codebase pins the pre-#618 algorithm, proven-correct by its
own equivalence suite. A second copy here could silently drift from it and
this benchmark would never notice.

Usage (from the repo root)::

    python scripts/dedup-microbench-pair-precompute.py

Acceptance criterion (issue #618, task 1): shows >= 3x on match_ratio
15x15. Fable's profile measured 155us -> 42us packed-int (~4x) locally,
9.5us numpy-vectorized (~16x) — either is acceptable; this repo took the
simpler packed-int diff. Actually measured here: 142.66us -> 8.36us,
17.1x (see D-136).
"""

from __future__ import annotations

import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from etl.dedup.signals import photo_hash
from etl.tests.test_dedup_pair_precompute_equivalence import (
    _HASH_HAMMING_THRESHOLD,
    _flip_bits,
    _random_hash,
    _reference_match_ratio,
)

_ITERATIONS = 20_000


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
