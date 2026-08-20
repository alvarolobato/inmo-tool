---
id: D-136
title: Dedup pair-eval uses packed-int photo-hash comparison + per-run phone memoization
date: 2026-08-20
group: Data / connectors
rule: "`evaluate_pair` compares photo hashes as packed 64-bit ints (XOR+`bit_count()`, `photo_hash.pack_hash`/`_PhotoHashCache.get_packed`) and memoizes `phone_extract.extract_phones` per listing per run via `_PhoneCache` — never re-derive either per pair; verdicts stay bit-for-bit identical to the unpacked/unmemoized path."
---

# D-136: Dedup pair-eval uses packed-int photo-hash comparison + per-run phone memoization

*Decided: 2026-08-20*

**Context**: Issue #617's Fable profile found a 126-minute dedup pass is
~97% pure CPU inside `evaluate_pair`, split ~71% in
`photo_hash.match_ratio`'s O(|A|×|B|) `ImageHash.__sub__` calls (each a
numpy `flatten()` + `count_nonzero` for what is one 64-bit XOR+popcount —
~0.9us instead of ~0.02us) and ~26% in `phone_extract.extract_phones`
re-scanning both ~1.5KB descriptions on **every pair** (~112M regex scans
per pass for facts derivable in one scan per listing, 12,427 total).
Neither cost changes what merges/suggests — it's the same per-listing fact
recomputed once per PAIR instead of once per LISTING.

**Decision**: `_PhotoHashCache` packs each listing's `imagehash.ImageHash`
list into 64-bit Python ints (`photo_hash.pack_hash`, derived from
`int(str(h), 16)` — the same bit pattern `ImageHash.__str__`/the
`photo_hashes` store's hex column already trust) via a new `get_packed()`
method, memoized separately from the existing `get()`/`_cache` (which still
returns raw `ImageHash` objects, since several tests pre-populate `_cache`
directly and must keep working unchanged). `photo_hash.match_ratio`/
`hashes_share_any_match` now take packed ints and compare via
`(a ^ b).bit_count() <= _HASH_HAMMING_THRESHOLD`. `pack_hash` raises
`ValueError` on anything but a 64-bit hash — every call site in this
codebase uses `imagehash.phash(image)` at the library default
`hash_size=8`, so this should never fire, but a silent wrong-width XOR
would corrupt every ratio it touches without ever raising.

`phone_extract.evaluate` gained optional `phones_a`/`phones_b` keyword
params (default `None` → falls back to extracting fresh from the
description, the pre-#618 behaviour, so every direct test call keeps
working). `etl.dedup.engine._PhoneCache` — instantiated fresh inside `_run`
per pass, never a process-lifetime cache — memoizes
`extract_phones(listing.description)` once per listing per run and feeds
the precomputed sets into `evaluate_pair`'s only real hot-loop call site.

**Alternatives rejected**:
- A numpy-vectorized XOR-popcount over per-listing `uint64` arrays — Fable's
  spike measured it faster still (~9.5us vs ~42us for packed ints on a
  15×15 pair), but it's a bigger diff for the same correctness property;
  packed ints already clear the ≥3x acceptance bar by a wide margin
  (measured 17.3x on the same 15×15 worst case, see below).
- A module-level `functools.lru_cache` on `extract_phones` — rejected
  because the ETL scheduler runs dedup hourly in one long-lived process
  (`etl.orchestrator.run_dedup`); an unbounded process-lifetime cache would
  accumulate every unique description ever seen with no eviction, a slow
  memory leak over weeks of uptime. `_PhoneCache` dies with each `_run()`
  call instead.

**Rationale**: This is a representation/memoization change, not a rule
change — recall must stay bit-for-bit identical, and that property is
proven rather than asserted: `etl/tests/test_dedup_pair_precompute_equivalence.py`
runs a frozen copy of the pre-#618 `ImageHash.__sub__`-based algorithm
side-by-side with the packed-int one over thousands of synthetic pairs,
including hand-crafted pairs at exact Hamming distances straddling
`_HASH_HAMMING_THRESHOLD` (10) and match ratios straddling `MIN_MATCH_RATIO`
(0.60) and the #188 exact-match auto-merge boundary (1.000) — the specific
rounding-drift failure mode that would otherwise move pairs across a
decision line unnoticed. Measured on a synthetic 3,000-listing corpus (same
seed, same corpus, two codebases): 111.98us/pair → 5.02us/pair (22.3x),
extrapolating to production's measured 56.1M pairs: ~105 min → ~4.7 min —
in the same ballpark as issue #617's independent profile (110 min
extrapolated, 126 min measured) and comfortably inside the issue's
"well under 30 min" exit criterion. Isolated microbenchmark on the
worst-case 15×15 non-matching pair (`etl/dedup/microbench_pair_precompute.py`,
not CI-gated): 148us → 8.5us, 17.3x.

**See**: `etl/dedup/engine.py` (`_PhotoHashCache.get_packed`, `_PhoneCache`,
`evaluate_pair`), `etl/dedup/signals/photo_hash.py` (`pack_hash`,
`match_ratio`, `hashes_share_any_match`), `etl/dedup/signals/phone_extract.py`
(`evaluate`'s `phones_a`/`phones_b`), `etl/tests/test_dedup_pair_precompute_equivalence.py`,
`etl/dedup/microbench_pair_precompute.py`, issues #617/#618,
[D-025](D-025-photo-hash-store.md), [D-024](D-024-dedup-pending-reevaluation.md).
