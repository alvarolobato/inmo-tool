"""The dedup matching pipeline (issue #16) — `ps dedup run` / `ps dedup revert`.

Compares every pair of listings that don't already share a property_id,
in signal priority order: cadastral -> address+coords -> photo hash ->
phone, auto-merging confident matches and filing the rest as suggestions
for human review. Issue #1 §6's original order also listed a `fuzzy`
text-similarity fallback last and phone ahead of photo hash — issue #603
(D-131) reordered photo hash ahead of phone, and issue #601 (D-130)
retired fuzzy entirely: see `evaluate_pair`'s docstring for the reasoning
on both, and `purge_pending_fuzzy` for the one-off cleanup of fuzzy's
pending backlog. `etl.dedup.signals.fuzzy` still exists — only for
`normalize_address`, which `address_coords.py` imports — but no longer
has an `evaluate` this module calls.

Scale note: this is an O(n^2) pairwise comparison over every listing in the
table, deliberately — the right scale-up (blocking by geography/price
bucket before comparing, an index-backed candidate-generation step) is a
real piece of engineering that isn't worth building against a database with
a few dozen listings from two connectors. Revisit once real connector
volume makes a full pairwise scan slow.

Measured (issue #185, pure in-memory `evaluate_pair` cost across every
signal then active, `photo_urls=()` so `photo_hash.fetch_hashes` never
does real network I/O — i.e. a lower bound, real runs with photos will be
slower): ~13.3us/pair, consistent from n=419 (0.42M pairs -> ~1.1s) through
n=5,000 (12.5M pairs -> ~168s). At n=10,000 (~50M pairs) that extrapolates
to ~11 minutes of pure CPU time, growing quadratically — before #185, this
only ran when an operator remembered to type `ps dedup run`; now it runs
automatically after every connector sweep (`etl.orchestrator.run_dedup`,
default hourly), so a multi-minute run is no longer a curiosity, it's
recurring cost on every cycle. `photo_hash.fetch_hashes` is only reached
per *listing* (memoized by `_PhotoHashCache`, not per pair — see that
class), so its network cost stays O(n), not O(n^2); but with real photos
that O(n) cost is still real (every listing not resolved by a cheaper
signal against *any* other listing ends up fetched) and unbounded by a
timeout budget at the run level. Blocking/bucketing (by geography + price
band, say) should land before real listing volume approaches ~15-20k, per
this measurement — not yet built, deliberately, per the note above.
"""

from __future__ import annotations

import dataclasses
import json
import logging
from dataclasses import dataclass
from decimal import Decimal

from rapidfuzz import fuzz

from etl.dedup import photo_hash_store, reconcile
from etl.dedup.signals import (
    address_coords,
    cadastral,
    phone_extract,
    photo_hash,
    price_gap,
    reference_code,
)
from etl.dedup.signals.floor import floors_conflict
from etl.dedup.types import ListingRecord, PairEvaluation

logger = logging.getLogger("etl.dedup.engine")


class PhotoHashStoreUnavailableError(RuntimeError):
    """Issue #607 (B2): raised by `purge_pending_fuzzy` (and its
    `preview_purge_pending_fuzzy` dry-run twin) when
    `photo_hash_store.open_connection()` returns `None`.

    `open_connection()` returning `None` is the correct, silent-by-design
    behaviour for the dedup *scoring* path (`_PhotoHashCache`) — a run
    without a reachable store just falls back to fetching every photo live,
    exactly as it did before issue #221. It is NOT correct for this
    destructive migration: `_fuzzy_rescue_shares_a_photo` degrades to
    `False` for every pair when `store_conn is None`, so the rescue set
    silently collapses to description-only corroboration (measured: 19 of
    51 on production's numbers) and the `DELETE ... AND NOT (id = ANY(...))`
    takes everything else — no error, no non-zero exit, just an oversized
    delete. Refuse instead."""


def _photo_hash_store_or_raise():
    store_conn = photo_hash_store.open_connection()
    if store_conn is None:
        raise PhotoHashStoreUnavailableError(
            "the persistent photo-hash store is unreachable "
            "(photo_hash_store.open_connection() returned None) — refusing "
            "to purge/preview. Every pair that should have been rescued via "
            "a shared photo hash would silently look unrescued, widening "
            "this destructive delete far beyond the intended rescue set. "
            "Retry once the store is reachable."
        )
    return store_conn


@dataclass
class DedupRunResult:
    pairs_compared: int = 0
    merged: int = 0
    suggested: int = 0
    conflicts: int = 0
    # Issue #602, D-137: how many of `merged` above fired on the photo_hash
    # exact-match auto-merge path specifically (basis == "photo_hash") —
    # counted separately so an operator can see how many corroborated
    # photo-hash auto-merges happened this run without a SQL query against
    # property_merge_log, per D-137's "auto-merges must be visible"
    # requirement. Incremented at both sites `merged` itself is (`_run`'s
    # main loop and `_reevaluate_pending_suggestion`) — a merge is still a
    # merge regardless of which path triggered it, same precedent as
    # `reevaluated_merged` above.
    photo_hash_auto_merged: int = 0
    # Issue #197: candidate pairs skipped at pair-generation because both
    # listings share a `source` — never handed to evaluate_pair at all, so
    # this is *not* counted in pairs_compared above. "Same-source" pairs
    # would be "really strange" per the owner (a re-listed expired advert
    # is the plausible case), so this is a visibility counter, not silence:
    # a nonzero value here is exactly the operator-facing signal issue
    # #197's acceptance criteria ask for ("counted/logged somewhere an
    # operator can find"). See run()'s docstring for why persisting it into
    # the `dedup_runs` table itself is a follow-up, not done here.
    same_source_skipped: int = 0
    # Sub-count of the above: same-source pairs that additionally share a
    # non-null cadastral_ref. Issue #197 calls this out specifically — two
    # listings on *one* portal claiming the same land-registry reference is
    # a data-quality problem worth an operator's attention (a scraping bug,
    # a portal listing the same unit twice), not something to silently
    # drop just because same-source pairs are never merged.
    same_source_cadastral_collisions: int = 0
    # Issue #206: sources whose photos never hash successfully this run —
    # `{source: live_attempted}` for every source that fetched at least one
    # photo over the network and got zero usable images back. Store hits
    # (issue #221) are excluded on purpose: a cached hash says nothing about
    # whether the CDN is serving *now*, and counting it as a success silences
    # this detector for good once the store is warm. A source in this
    # degraded state contributes no photo_hash evidence to ANY pair it's
    # in, and does so invisibly (match_ratio is only computed over
    # successfully-hashed photos, so a listing with zero hashes just looks
    # like "no photo evidence either way", indistinguishable from a
    # healthy source that simply doesn't match). Same shape as issue #171
    # (a connector degrading silently while runs still report success) and
    # the same "visibility counter, not a schema change" precedent as
    # same_source_skipped above — see run()'s docstring and
    # _PhotoHashCache.zero_success_sources().
    photo_hash_zero_success_sources: dict[str, int] = dataclasses.field(
        default_factory=dict
    )
    # Issue #214: `pending` suggestions are re-scored every run instead of
    # being frozen at whatever rules were live when they were first filed.
    # These three count what a pending row turned into this run — *not*
    # counted in `suggested` above (that stays "brand-new pairs filed for
    # the first time") or `merged` (see below, it IS still folded into
    # `merged` since a merge is a merge regardless of which path triggered
    # it — but `reevaluated_merged` isolates the reevaluation-triggered
    # subset for reporting).
    reevaluated_total: int = 0
    reevaluated_merged: int = 0
    reevaluated_rejected: int = 0
    reevaluated_updated: int = 0
    # Issue #607 (B1): a `pending` row `purge_pending_fuzzy` rescued (its
    # `detail` carries a `rescued_reason`) is corroborated by evidence
    # `evaluate_pair`'s live signals were never going to independently
    # re-derive — that is precisely WHY it was `fuzzy`-only in the first
    # place. Without this exemption, `_reevaluate_pending_suggestion`'s
    # `evaluation is None` branch auto-rejects every one of them on their
    # very first post-purge run, since nothing else has ever fired for
    # them. Counted separately from `reevaluated_rejected` — this is a
    # "not rejected, deliberately kept pending" outcome.
    reevaluated_preserved_rescued: int = 0
    # Issue #604: a `pending` suggested_merge row whose two listings
    # already share a property_id — because a DIFFERENT pair's merge
    # unified them, not because this exact pair was ever itself confirmed
    # — used to be invisible to reevaluation forever: `_run`'s
    # `a.property_id == b.property_id` skip ran BEFORE `pending_by_pair`
    # was ever consulted, so D-024's reevaluation guarantee never actually
    # reached these rows (71 stale rows measured on the live corpus: 56
    # photo_hash + 15 fuzzy). Counts how many such rows this run resolved
    # to `confirmed` via `_resolve_pending_same_property` — kept separate
    # from `reevaluated_*` above, all of which assume a fresh
    # `evaluate_pair` call happened; this path never calls it (there is
    # nothing left to score, the listings are already unified).
    same_property_pending_resolved: int = 0
    # Issue #605 Part 2 revision (PR #611 review, B1): a `pending`
    # suggested_merge row whose two PROPERTIES are covered by a
    # `property_merge_veto` (a human rejected the property pair through
    # the grouped review queue) — resolved to `rejected` via
    # `_resolve_pending_vetoed_property` without ever calling
    # evaluate_pair, same "nothing left to score" reasoning as
    # same_property_pending_resolved above, opposite verdict.
    vetoed_pending_resolved: int = 0
    # Issue #605 Part 2 revision (PR #611 second review, M-3): every
    # listing pair `_run` skips outright because its two properties are
    # covered by a `property_merge_veto` — the ordinary case (no pending
    # row for this exact listing combination, nothing to resolve, just a
    # silent `continue` before this counter existed). Without this, veto
    # suppression was completely invisible: no counter, no log line, and
    # nothing in the CLI or dashboard reads `property_merge_veto` at all.
    vetoed_pairs_skipped: int = 0
    # Issue #605 Part 2 revision (PR #611 second review, M-1 — promoted to
    # blocker): `perform_merge`'s veto guard (see that function) refusing
    # a merge MID-RUN — a genuine race where a concurrent `reject_pair`
    # action commits a veto for this exact pair between when
    # `vetoed_property_pairs` was loaded and this comparison. `_run`
    # catches the `ValueError` here and keeps going rather than letting it
    # kill the whole ~84-minute pass (a correct refusal is a business
    # outcome, not a run-killer — contrast `confirm_suggestion`, where the
    # SAME raise correctly becomes one `failed` action row).
    vetoed_merge_refused: int = 0
    # Issue #627 (D-138): a pair `evaluate_pair` rejected outright on the
    # price/size/rooms heuristic (`price_gap.price_gap_conflict`) — for a
    # brand-new pair this is never filed as a `suggested_merge` row at all
    # (the "don't file the suggestion" design, D-138), so without this
    # counter the rejection would be completely invisible: not in
    # `suggested`, not in `merged`, not in any table. Also incremented for
    # an existing `pending` row the rule now rejects on reevaluation (see
    # `_reevaluate_pending_suggestion`) — that branch DOES write a
    # `resolved_reason` to `suggested_merge.detail`, distinguishing it
    # from the generic "no signal matched" auto-reject, but still never
    # creates a `property_merge_veto` (that only ever happens via the
    # human-only `reject_property_pair`). Surfaced in both `ps dedup run`
    # and the `etl.orchestrator.run_dedup` log line — production
    # visibility was missing for the #624 auto-merge counter precisely
    # because only the CLI printed it; this one ships in both from the
    # start.
    price_gap_rejected: int = 0


def fetch_listing_records(conn) -> list[ListingRecord]:
    """Fetch every SALE listing joined with its property row.

    No status filter — a withdrawn listing on one site duplicating an
    active one on another is still the same property and still worth
    merging (its price/status history has value regardless of its current
    status), so this intentionally doesn't restrict to status='active'.

    `WHERE l.operation = 'sale'` (issue #31): before rental ingestion
    existed, every row here was implicitly a sale listing (the schema
    default), so this filter was a no-op and absent. Issue #31's own
    Context section is explicit that rental listings "does not need
    property_id/dedup linkage at the same rigor as sale listings — rentals
    are used in aggregate for comps, not tracked as individual investment
    candidates": they're read in bulk by rent-estimate.ts's own geography+
    size query, never resolved to a canonical `property.id` the way two
    sale listings for the same real unit are. Feeding rent listings into
    this pairwise matcher would risk a spurious merge across operations
    (e.g. a for-sale flat and a for-rent flat at the same address/coords
    getting unioned onto one property_id) purely on a corroborating-signal
    coincidence that has nothing to do with whether they're the same
    listing — cadastral_ref/address+coords/phone signals were all designed
    and tuned against sale-vs-sale duplicates, not sale-vs-rent.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT l.id, l.property_id, l.source, l.external_id, l.listing_kind,
                   l.description, l.photo_urls,
                   p.cadastral_ref, p.address, p.lat, p.lon, p.m2_built,
                   l.current_price, l.contact_raw, l.reference_code, p.floor,
                   p.property_type, p.rooms
              FROM listing l
              JOIN property p ON p.id = l.property_id
             WHERE l.operation = 'sale'
            """
        )
        rows = cur.fetchall()
    return [
        ListingRecord(
            listing_id=row[0],
            property_id=row[1],
            source=row[2],
            external_id=row[3],
            listing_kind=row[4],
            description=row[5],
            photo_urls=tuple(row[6] or ()),
            cadastral_ref=row[7],
            address=row[8],
            lat=row[9],
            lon=row[10],
            m2_built=row[11],
            current_price=row[12],
            contact_raw=row[13],
            reference_code=row[14],
            floor=row[15],
            property_type=row[16],
            rooms=row[17],
        )
        for row in rows
    ]


class _PhotoHashCache:
    """Fetches and memoizes each listing's photo hashes at most once per run.

    Issue #206: also tracks attempted/hashed photo counts per `source`
    while it's already touching every listing exactly once, so a run can
    report which sources (if any) had a 0% photo-hash success rate —
    without that, a source whose CDN silently 404s every photo just looks
    like "no photo evidence" for every pair it's in, indistinguishable
    from a healthy source that legitimately doesn't match. See
    `zero_success_sources` and `DedupRunResult.photo_hash_zero_success_sources`.

    Those counters track **live network attempts only**, never store hits —
    see `zero_success_sources`.
    """

    def __init__(self, store_conn=None) -> None:
        self._cache: dict[int, list] = {}
        # Issue #618: packed-int (see `photo_hash.pack_hash`) form of
        # `_cache`'s `imagehash.ImageHash` lists, memoized SEPARATELY rather
        # than replacing `_cache`'s contents in place — several tests
        # (`TestPhotoHashAutoMerge`, `TestPhoneOrderingRescue`, et al.)
        # construct a cache and poke `imagehash.ImageHash` values directly
        # into `_cache[listing_id]` to avoid a network fetch, and
        # `get_packed` below packs whatever it finds there lazily, so those
        # tests keep working unchanged. The packing itself still only
        # happens once per listing per run (memoized here), which is the
        # whole point: `evaluate_pair` calls `get_packed`, never `get`,
        # for the actual `match_ratio`/`hashes_share_any_match` comparison.
        self._packed_cache: dict[int, list[int]] = {}
        self._live_attempted_by_source: dict[str, int] = {}
        self._live_hashed_by_source: dict[str, int] = {}
        # Issue #221: the per-listing memo above still earns its keep (one
        # listing appears in many pairs), but it dies with the run.
        # `store_conn` threads the persistent per-URL store underneath it so
        # the network cost is paid once ever, not once per run. It is the
        # store's OWN connection (`photo_hash_store.open_connection`), never
        # the dedup run's — see that module's docstring. None keeps the old
        # fetch-everything behaviour for tests that don't want a database.
        self._store_conn = store_conn

    def _ensure_fetched(self, listing: ListingRecord) -> None:
        if listing.listing_id in self._cache:
            return
        # Issue #615: fetches (url, hash) PAIRS now, not bare hashes — the
        # one fetch this cache already made per listing is also the one
        # place a photo's URL and its hash exist together, so `get_pairs`
        # below can report exactly which photo matched which without a
        # second, re-derived fetch. `get()`'s own return shape is
        # unchanged (still `list[ImageHash]`, backward compatible with
        # every existing `match_ratio`/health-stats caller) — it's simply
        # derived from the same cached pairs.
        pairs, stats = photo_hash.fetch_hash_pairs_with_stats(
            listing.photo_urls, source=listing.source, store_conn=self._store_conn
        )
        self._cache[listing.listing_id] = pairs
        if stats.live_attempted:
            self._live_attempted_by_source[listing.source] = (
                self._live_attempted_by_source.get(listing.source, 0)
                + stats.live_attempted
            )
            self._live_hashed_by_source[listing.source] = (
                self._live_hashed_by_source.get(listing.source, 0) + stats.live_hashed
            )

    def get(self, listing: ListingRecord) -> list:
        self._ensure_fetched(listing)
        return [h for _url, h in self._cache[listing.listing_id]]

    def get_pairs(self, listing: ListingRecord) -> list:
        """Same fetch as `get()` (memoized together — never a second fetch),
        but with each hash's source URL attached. Issue #615: lets
        `evaluate_pair` report WHICH photos matched, not just the aggregate
        ratio `get()`'s plain hashes already fed `match_ratio`."""
        self._ensure_fetched(listing)
        return self._cache[listing.listing_id]

    def get_packed(self, listing: ListingRecord) -> list[int]:
        """Packed-int form of `get(listing)`'s hashes (issue #618),
        memoized once per listing per run so the O(1) `pack_hash` cost is
        paid once no matter how many pairs this listing appears in — the
        comparison cost itself (`photo_hash.match_ratio`/
        `hashes_share_any_match`) drops from numpy `ImageHash.__sub__` to a
        plain int XOR+`bit_count()`, which is the actual per-pair win.
        """
        if listing.listing_id not in self._packed_cache:
            self._packed_cache[listing.listing_id] = [
                photo_hash.pack_hash(h) for h in self.get(listing)
            ]
        return self._packed_cache[listing.listing_id]

    def zero_success_sources(self) -> dict[str, int]:
        """`{source: live_attempted}` for every source that made at least one
        network fetch this run and got zero usable images back.

        Deliberately counts only photos fetched **live** this run. The
        question this answers is "is this source's photo CDN serving?", and a
        hash read out of the `photo_hashes` store (issue #221) is not evidence
        about the CDN's state now — it was recorded on some earlier run, quite
        possibly before the breakage. Counting store hits as successes (the
        first cut of #221 did) silences this detector permanently the moment
        the store is warm: the #209/#213 Milanuncios shape — every photo
        404ing, including a brand-new listing whose URLs have never worked —
        reported a perfectly healthy source.

        The trade is deliberate. A source with no live attempts at all (fully
        warm, nothing new ingested) is reported as nothing rather than as
        healthy: "we did not check" is the honest answer, and it is never
        wrong the way "healthy" was. Any source still ingesting new listings
        has live attempts every run to be judged on, which is exactly the
        population where a dead CDN needs catching.
        """
        return {
            source: attempted
            for source, attempted in self._live_attempted_by_source.items()
            if attempted > 0 and self._live_hashed_by_source.get(source, 0) == 0
        }


class _PhoneCache:
    """Memoizes `phone_extract.extract_phones(listing.description)` once per
    listing per run (issue #618).

    `extract_phones` re-scans a listing's whole description (avg ~1.5KB)
    with a regex every time it's called; before this cache, `evaluate_pair`
    called it on BOTH sides of nearly every pair that reached the phone
    signal — since D-131 put phone last and photo_hash rarely fires, that
    was ~112M scans/pass for facts derivable in one scan per listing
    (~12.4k). A plain per-run dict, not `functools.lru_cache` on the
    module-level function: this class is instantiated fresh inside `_run`
    for each dedup pass and discarded at the end of it, so it never
    accumulates descriptions across runs the way a process-lifetime
    `lru_cache` would in the long-running scheduler process (`etl.
    orchestrator.run_dedup`, hourly) — see issue #618's PR description for
    why an unbounded process-lifetime cache was rejected.
    """

    def __init__(self) -> None:
        self._cache: dict[int, set[str]] = {}

    def get(self, listing: ListingRecord) -> set[str]:
        if listing.listing_id not in self._cache:
            self._cache[listing.listing_id] = phone_extract.extract_phones(
                listing.description
            )
        return self._cache[listing.listing_id]


def evaluate_pair(
    a: ListingRecord,
    b: ListingRecord,
    hash_cache: _PhotoHashCache,
    phone_cache: _PhoneCache | None = None,
) -> PairEvaluation | None:
    """Run every signal in priority order; return the first that fires.

    *phone_cache* is optional (defaults to None, which makes the phone
    signal fall back to extracting phones fresh from the description on
    every call — the pre-#618 behaviour) so every existing direct
    `evaluate_pair(a, b, hash_cache)` call site — mostly tests exercising a
    single pair, where memoization buys nothing — keeps working unchanged.
    The one caller that actually runs the O(n^2) sweep (`_run`, below)
    passes a real `_PhoneCache` shared across the whole pass.

    Photo-hash fetching only happens once address_coords/reference_code
    have already come back empty — those two are cheaper (no network) and
    would resolve a pair without ever needing a photo fetch. Phone, by
    contrast, now runs AFTER photo_hash (issue #603/D-131): its
    corroborated-but-not-`particular` tiers turned out to actively SHADOW
    stronger evidence, not just add weaker evidence ahead of it — see
    below for the measurement.

    Issue #603 (D-131): photo_hash was moved ahead of phone in this
    priority order — a real reversal of issue #16's original listing
    (cadastral -> address+coords -> phone -> photo hash -> fuzzy), not
    just a cost optimization. #600 measured all 320 pending `phone`
    suggestions as agency noise (19 distinct numbers, 9 of them shared
    across 6-50 listings each, 100% with a confirmed-agency side), but
    found a sharper problem than noise: because phone ran first, 19 of
    those 320 pairs were actually photo-ratio >= 0.6 (mostly 1.0,
    identical price/m2/description) true duplicates, permanently stuck at
    phone's 0.500 uncorroborated-or-agency tier because `evaluate_pair`
    returned on the phone match before photo_hash ever got a chance to
    look. Reordering lets photo_hash claim those pairs on its own,
    stronger evidence (see `etl.dedup.signals.phone_extract`'s module
    docstring for the tier changes that go with this). The photo-hash
    store (D-025) makes a warm re-fetch here ~free — see the PR for the
    measured cost delta.

    Issue #564 (D-116): a same-agency reference-code conflict is checked
    right after `cadastral` and before every other signal — see the inline
    comment below for why it outranks address/coords/phone/photo/fuzzy but
    not cadastral.

    Issue #566: `property_type`/`rooms` contradiction is NOT checked here.
    `structured_fields_conflict` (D-117) was scoped to veto ONLY the now-
    retired `fuzzy` signal's suggestion (issue #601), never placed here
    ahead of every signal the way the reference-code veto (D-116) is — the
    live-DB blast radius measurement found `property_type`/`rooms` are
    noisy per-connector metadata that regularly disagree even on definite,
    strongly-corroborated duplicates (identical photos, price, and size)
    matched by address_coords/reference_code/photo_hash; vetoing at this
    level would have broken ~80 already-correct merges (13.6% of 590 —
    PR #567's review). With `fuzzy` retired, D-117's veto has lost its only
    call site (still deliberately kept, not retired — see D-117's own
    file) and `structured_fields_conflict` is currently unreferenced from
    `evaluate_pair`'s pipeline entirely.

    Issue #602/D-137 (2026-08-20): the photo_hash exact-match auto-merge
    below no longer gates on the issue #186 floor-conflict veto — see the
    inline comment at that branch and `photo_hash.PHOTO_MERGE_PRICE_RATIO`'s
    module comment for the full replay-against-real-decisions evidence.
    D-116/D-117/`property_merge_veto` are unaffected: D-116 still vetoes
    above (unconditionally, before photo_hash is ever reached), D-117 was
    never wired in here to begin with, and `_run`'s pairwise loop still
    skips a vetoed property pair before `evaluate_pair` is ever called.
    Issue #627 (D-138): a price-gap veto runs right after the
    address_coords/reference_code loop below, before photo_hash ever
    fetches a single hash. It is NOT placed ahead of cadastral or the
    D-116 reference-code veto/positive-match (those are checked first,
    unconditionally, above) — a government registry ID or an agency's own
    bookkeeping outranks a price/size/rooms heuristic. It DOES run ahead
    of photo_hash and phone, on purpose: those are exactly the signals a
    same-development "promotion" (many nearly-identical flats, near-
    identical photos, genuinely different prices/sizes/room counts) fools,
    and letting it run first also saves the one signal with real network
    cost from ever fetching hashes for a pair it's about to reject anyway.
    Returns a `decision='reject'` verdict (never `None` directly) so
    `_run`/`_reevaluate_pending_suggestion` can count it distinctly from
    "no signal matched" — see `price_gap.py`'s module docstring for the
    rule itself and its measured impact, and this repo's D-138 for why a
    rule-based rejection here never creates a `property_merge_veto`.
    """
    cadastral_result = cadastral.evaluate(a, b)
    if cadastral_result is not None:
        return cadastral_result

    # Issue #564 (D-116): a same-agency pair carrying two different, both
    # real (non-placeholder) reference codes is that agency's own
    # bookkeeping saying these are two different properties — a hard veto
    # that outranks every remaining signal (address/coords, phone, the
    # reference_code signal's own weaker paths, photo hash, fuzzy), no
    # matter how well they'd otherwise agree. Deliberately placed AFTER
    # cadastral: a cadastral reference is a government registry ID, not
    # agency bookkeeping, and cadastral.evaluate's own docstring calls an
    # exact match "conclusive"/"never wrong" — an agency's internal ref
    # mismatch doesn't get to override that. Short-circuits to "no match at
    # all" (None): unlike the #186 floor veto (which only downgrades a
    # merge some other signal still supports to a weaker suggestion), this
    # is direct evidence the pair is NOT a duplicate, so nothing downstream
    # gets a chance to suggest it either.
    if reference_code.reference_codes_conflict(a, b):
        return None

    for evaluate_fn in (
        address_coords.evaluate,
        reference_code.evaluate,
    ):
        result = evaluate_fn(a, b)
        if result is not None:
            return result

    # Issue #627 (D-138): price/size/rooms gap too large to plausibly be
    # the same unit — see price_gap.py's module docstring for the rule and
    # its measured contradiction rate against the owner's own decision
    # history. A `decision='reject'` verdict, not `None` directly: the
    # caller (`_run`/`_reevaluate_pending_suggestion`) needs to tell "the
    # rule said no" apart from "nothing matched" so it can count it
    # separately (`DedupRunResult.price_gap_rejected`) without ever filing
    # a `suggested_merge` row or a `property_merge_veto` for it.
    price_gap_reason = price_gap.price_gap_conflict(a, b)
    if price_gap_reason is not None:
        return PairEvaluation(
            basis="price_gap",
            confidence=Decimal("0.000"),
            decision="reject",
            detail=price_gap_reason,
        )

    hashes_a = hash_cache.get_packed(a)
    hashes_b = hash_cache.get_packed(b)
    ratio = photo_hash.match_ratio(hashes_a, hashes_b)
    if ratio is not None and Decimal(str(ratio)) >= photo_hash.MIN_MATCH_RATIO:
        detail: dict = {"match_ratio": round(ratio, 3)}
        # Issue #186: a floor present on both sides that disagrees is
        # direct evidence of "different unit, same building" — the owner's
        # own example (suggestion 197: floors "10º" vs "A partir de la 15ª
        # planta", identical photos and price, 6m² apart) came through this
        # exact signal. Still computed and surfaced in `detail` so a human
        # reviewing a `suggest` verdict sees the discriminating data point
        # rather than an unexplained near-perfect match — but issue #602/
        # D-137 (2026-08-20, revised same day after a review caught the
        # ORIGINAL "already separates every merge from every rejection"
        # claim was a tautology — see photo_hash.PHOTO_MERGE_PRICE_RATIO's
        # module comment for the corrected evidence) stopped this from
        # gating the merge decision below. The narrower, correct basis:
        # floor_conflict is present on a meaningful share of the owner's
        # legitimate confirmed merges too (not a clean discriminator on its
        # own), while m2_built exact-equality already accounts for every
        # rejection in the replayed sample without it — so keeping
        # floor_conflict as an additional required gate would cost real
        # recall without preventing any false merge this sample
        # demonstrates.
        floor_conflict = floors_conflict(a.floor, b.floor)
        if floor_conflict:
            detail["floor_conflict"] = True

        # Issue #615: WHICH specific photo on each side matched, not just
        # the aggregate ratio above — the owner could not evaluate a
        # photo-hash suggestion at all when the card only showed a
        # percentage and (before this) the wrong photos (the first N in
        # storage order, frequently unrelated rooms). `hashes_a`/`hashes_b`
        # above are `get_packed`'s PACKED-int form (issue #618/#623) —
        # `matched_pairs` needs real `imagehash.ImageHash` objects (its own
        # `-` subtraction is what stores a per-pair Hamming distance), so
        # it calls `get_pairs` instead. That's still not a second network
        # round trip: `get_packed`/`get`/`get_pairs` all key off the SAME
        # `_ensure_fetched` memo (one fetch per listing per run) — `get_pairs`
        # just returns a different projection (url, hash) of the identical
        # cached fetch `get_packed` already triggered. `photo_hash.matched_pairs`
        # is the ONLY place this pairing is computed — the dashboard must
        # render it, never re-derive a match from raw photo_urls itself.
        # Ratio can legitimately clear the threshold with only 1 of the
        # smaller side's photos not producing a match record here (a fetch
        # failure between the packed and pairs projections is not possible
        # since both come from the same cached fetch — this can only be
        # empty when the underlying fetch found zero usable photos on one
        # side, which `match_ratio` already guards against returning a
        # ratio for).
        matches = photo_hash.matched_pairs(
            hash_cache.get_pairs(a), hash_cache.get_pairs(b)
        )
        if matches:
            detail["matched_photos"] = [
                {"url_a": m.url_a, "url_b": m.url_b, "distance": m.distance}
                for m in matches
            ]

        # Issue #188/#602, D-137 (approved once #197 removed same-source
        # pairing — see photo_hash.PHOTO_MERGE_PRICE_RATIO's module-level
        # comment for the full reasoning and the measured tolerances): a
        # *full* photo overlap between two different sources (guaranteed
        # here — #197 never hands evaluate_pair a same-source pair in the
        # first place), corroborated by an EXACT m2_built match and price
        # proximity, auto-merges rather than sitting in the review queue as
        # a suggestion. `sizes_equal` (exact equality), not `sizes_close`
        # (a tolerance band): D-137's corrected replay found m2_built
        # exact-equality never contradicted a rejection in the owner's
        # sample (a narrower, specific claim — NOT that every real merge
        # has identical m2_built, and NOT evidence the old 5% band caused
        # a specific false merge; see the module comment for what the
        # data actually supports).
        exact_match = Decimal(str(round(ratio, 3))) == Decimal("1.000")
        if (
            exact_match
            and address_coords.sizes_equal(a.m2_built, b.m2_built)
            and address_coords.prices_close(
                a.current_price, b.current_price, photo_hash.PHOTO_MERGE_PRICE_RATIO
            )
        ):
            return PairEvaluation(
                basis="photo_hash",
                confidence=photo_hash.PHOTO_MERGE_CONFIDENCE,
                decision="merge",
                detail=detail,
            )

        return PairEvaluation(
            basis="photo_hash",
            confidence=photo_hash.confidence_for_ratio(ratio),
            decision="suggest",
            detail=detail,
        )

    # Issue #603 (D-131): phone is now evaluated AFTER photo_hash — see
    # this function's docstring for the shadowed-duplicate measurement
    # that motivated the reorder. Issue #601 (D-130) retired the `fuzzy`
    # fallback that used to run after phone — nothing replaces it; a pair
    # that clears none of the signals above is simply not a match.
    #
    # Issue #618: phone sets come from *phone_cache* (memoized once per
    # listing per run) when the caller passed one, else `evaluate` falls
    # back to extracting them fresh — see `_PhoneCache`'s docstring.
    return phone_extract.evaluate(
        a,
        b,
        phones_a=phone_cache.get(a) if phone_cache is not None else None,
        phones_b=phone_cache.get(b) if phone_cache is not None else None,
    )


@dataclass
class _PendingSuggestion:
    """Enough of an existing `pending` `suggested_merge` row to reconcile it
    with a fresh `evaluate_pair` call — see `_reevaluate_pending_suggestion`."""

    suggestion_id: int
    match_basis: str
    confidence: Decimal | None
    detail: dict


def _load_recorded_pairs(
    cur,
) -> tuple[set[tuple[int, int]], dict[tuple[int, int], _PendingSuggestion]]:
    """Preload every already-recorded suggestion pair once per run (issue #61).

    Previously one `SELECT 1` per candidate pair, layered on top of the
    O(n^2) pairwise scan — i.e. O(n^2) round-trips. One query up front
    instead: the table only ever holds pairs a previous run already
    suggested, so it's bounded by suggestions filed, not by n^2. Still a
    single query after issue #214's change below (see
    TestRecordedPairBatching.test_skip_check_costs_one_query_per_run_not_one_per_pair,
    which pins "exactly one preload query" as a regression guard) — the
    extra columns/subquery just ride along on the same round-trip.

    Returns `(skip_pairs, pending_by_pair)`:

    - `skip_pairs`: pairs this run must never touch — `status='rejected'`
      (a human said "not the same property") or `status='conflict'` (needs
      `dedup resolve-conflict`, an explicit human decision, not a silent
      re-evaluation), OR a `status='pending'` row that already has an
      unprocessed `suggested_merge_action` queued (`status='pending'` on
      that table). That last case is issue #214's answer to "what about a
      suggestion a human is mid-decision on": a human clicking
      confirm/reject in the dashboard enqueues a `suggested_merge_action`
      row that `etl.dedup.actions.run_action_poll_loop` drains every few
      seconds — a dedup `run()` firing in that same window must not
      re-score (and potentially reject) a suggestion whose resolution is
      already in flight. Skipping it here just means this run leaves it
      alone; if the action fails for an unrelated reason (e.g. a stale
      listing) the row stays 'pending' and gets reevaluated on the *next*
      run once the action has been fully processed either way. This does
      not (and structurally cannot) protect a human who is looking at a
      suggestion but hasn't clicked yet — there is no "someone has this
      open" signal anywhere in this schema. See `run()`'s docstring and
      issue #214's PR description for why that residual race is accepted
      rather than solved with new state.

    - `pending_by_pair`: every remaining `status='pending'` row, keyed by
      the normalized `(listing_id_a, listing_id_b)` pair, carrying its
      `suggested_merge.id`/`match_basis`/`confidence`/`detail` so
      `run()` can hand it to `_reevaluate_pending_suggestion` instead of
      silently skipping it forever — issue #214's core fix. Previously
      this project treated `pending` exactly like `rejected`/`conflict`: a
      pair scored once, under whatever rules were live that day, was never
      looked at again no matter how much `evaluate_pair` changed
      underneath it. Concretely, 193 suggestions were scored while
      Milanuncios photos were entirely unhashable (`match_ratio` computed
      from missing data, not just "old" data) and stayed `pending` forever
      even after the CDN fix (#209/#213) made those same photos hashable.

    `status='confirmed'` rows are in neither set, unchanged from before
    issue #214: a confirmed suggestion is a pair a human has approved,
    already merged synchronously by `confirm_suggestion` — its listings
    already share a `property_id`, so `run()`'s own
    `a.property_id == b.property_id` check skips it before ever consulting
    either of these structures. Excluding it here (rather than adding it to
    `skip_pairs`) is what makes that check reachable at all: if this pair's
    listings were ever *not* unified for some reason, leaving 'confirmed'
    out lets a normal `run()` re-evaluate and merge it, alongside the
    explicit `dedup confirm` path — a pre-issue-#214 behaviour this change
    doesn't touch.
    """
    cur.execute(
        """
        SELECT sm.listing_id_a, sm.listing_id_b, sm.status, sm.id,
               sm.match_basis, sm.confidence, sm.detail,
               EXISTS (
                   SELECT 1 FROM suggested_merge_action sma
                    WHERE sma.suggestion_id = sm.id AND sma.status = 'pending'
               ) AS action_in_flight
          FROM suggested_merge sm
         WHERE sm.status <> 'confirmed'
        """
    )
    skip_pairs: set[tuple[int, int]] = set()
    pending_by_pair: dict[tuple[int, int], _PendingSuggestion] = {}
    for (
        listing_id_a,
        listing_id_b,
        status,
        suggestion_id,
        match_basis,
        confidence,
        detail,
        action_in_flight,
    ) in cur.fetchall():
        pair = (listing_id_a, listing_id_b)
        if status != "pending" or action_in_flight:
            skip_pairs.add(pair)
            continue
        pending_by_pair[pair] = _PendingSuggestion(
            suggestion_id=suggestion_id,
            match_basis=match_basis,
            confidence=confidence,
            detail=detail if isinstance(detail, dict) else json.loads(detail or "{}"),
        )
    return skip_pairs, pending_by_pair


def _load_vetoed_property_pairs(cur) -> set[tuple[int, int]]:
    """Preload every persisted property-pair veto once per run — same
    one-query-per-run discipline as `_load_recorded_pairs` (issue #605
    Part 2 revision, PR #611 review B1).

    A veto is PROPERTY-level (`property_merge_veto`), not listing-level
    like `skip_pairs` above: a human rejecting a property-pair group in
    the grouped review queue must block every current AND future listing
    combination between those two properties, not just the specific
    listing pair(s) the UI happened to show. See that table's schema
    comment in etl/schema/init.sql for the full incident this fixes
    (reproduced live in PR #611's review — a rejected property pair came
    right back, and in one case the very next run auto-merged the two
    properties a human had just rejected).
    """
    cur.execute("SELECT property_lo_id, property_hi_id FROM property_merge_veto")
    return {(lo, hi) for lo, hi in cur.fetchall()}


def file_suggestion(
    conn, a: ListingRecord, b: ListingRecord, result: PairEvaluation
) -> None:
    lo, hi = sorted((a.listing_id, b.listing_id))
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO suggested_merge
                (listing_id_a, listing_id_b, match_basis, confidence, status, detail)
            VALUES (%s, %s, %s, %s, 'pending', %s)
            ON CONFLICT (listing_id_a, listing_id_b) DO NOTHING
            """,
            (lo, hi, result.basis, result.confidence, json.dumps(result.detail or {})),
        )
    conn.commit()


def perform_merge(
    conn, a: ListingRecord, b: ListingRecord, result: PairEvaluation
) -> tuple[int, int, bool]:
    """Reassign listings to a single surviving property, log it, reconcile
    per-profile state. Returns (survivor_property_id, losing_property_id, had_conflict).

    Survivor is deterministically the lower property_id (the earlier-created
    one) — arbitrary but stable, so re-running the engine never flip-flops
    which id survives a given pair.
    """
    survivor_id, losing_id = sorted((a.property_id, b.property_id))

    with conn.cursor() as cur:
        # Last-line defense (issue #605 Part 2 revision, PR #611 review
        # B1): every merge path funnels through this function, so this is
        # the one place that can refuse outright regardless of which
        # caller reached it. `_run`'s pairwise loop already skips a
        # vetoed property pair before evaluate_pair is ever called (the
        # normal path), but confirm_suggestion calls this directly against
        # a specific suggestion_id a human clicked — a stale row from
        # before the veto existed, still 'pending' in a race window before
        # the next `_run` sweeps it, must not be allowed to merge the
        # exact two properties a human already said are not the same.
        cur.execute(
            "SELECT 1 FROM property_merge_veto "
            "WHERE property_lo_id = %s AND property_hi_id = %s",
            (survivor_id, losing_id),
        )
        if cur.fetchone() is not None:
            raise ValueError(
                f"Properties {survivor_id} and {losing_id} were already "
                "vetoed by an earlier property-pair rejection — refusing "
                "to merge them."
            )

        # Every listing currently on the losing side moves, not just a/b —
        # losing_id may already carry more than one listing from an earlier
        # merge in this same run (e.g. a third source's listing already
        # unioned onto it). Recording the full set (not just [a, b]) is what
        # makes revert() correct for a losing side with 2+ listings.
        cur.execute("SELECT id FROM listing WHERE property_id = %s", (losing_id,))
        moved_listing_ids = [row[0] for row in cur.fetchall()]

        cur.execute(
            "UPDATE listing SET property_id = %s WHERE property_id = %s",
            (survivor_id, losing_id),
        )

        # Repoint (never orphan) any veto involving the LOSING property
        # onto the survivor (issue #605 Part 2 revision, PR #611 review
        # B1) — mirrors the reassignment discipline reconcile.reconcile_merge
        # already applies to profile_listing_state/feedback_event below.
        # If the losing property was itself vetoed against a THIRD
        # property, that veto must keep applying to the merged identity
        # (the two properties being merged are, by definition, the same
        # real-world unit — reconcile.py's own reasoning for combining
        # `matched` on merge). ON CONFLICT DO NOTHING naturally dedupes a
        # repoint that collides with a veto the survivor already had.
        cur.execute(
            "SELECT id, property_lo_id, property_hi_id FROM property_merge_veto "
            "WHERE property_lo_id = %s OR property_hi_id = %s",
            (losing_id, losing_id),
        )
        for veto_id, veto_lo, veto_hi in cur.fetchall():
            new_lo = survivor_id if veto_lo == losing_id else veto_lo
            new_hi = survivor_id if veto_hi == losing_id else veto_hi
            if new_lo == new_hi:
                # The vetoed counterpart IS the survivor — i.e. a veto
                # existed for exactly (survivor_id, losing_id). The guard
                # above already refuses this merge before reaching here;
                # this branch is unreachable defense, not a real path.
                continue
            new_lo, new_hi = sorted((new_lo, new_hi))
            cur.execute("DELETE FROM property_merge_veto WHERE id = %s", (veto_id,))
            cur.execute(
                "INSERT INTO property_merge_veto (property_lo_id, property_hi_id) "
                "VALUES (%s, %s) ON CONFLICT (property_lo_id, property_hi_id) DO NOTHING",
                (new_lo, new_hi),
            )
        # Deliberately not copying the loser's cadastral_ref onto the
        # survivor here. If the merge fired on `cadastral` the two already
        # match, so there is nothing to copy; if it fired on another signal
        # and only the loser carried a reference, the next sweep's
        # COALESCE(new, old) in _upsert_canonical_listing writes it onto the
        # survivor when that listing is re-fetched — the listing now points
        # at survivor_id, so it lands in the right place. Adding a copy here
        # would need its own conflict rule for the case where both sides
        # carry *different* references (a signal that the merge was wrong,
        # not something to silently overwrite), so leave the self-healing
        # path to do it.

    had_conflict, snapshot = reconcile.reconcile_merge(
        conn,
        survivor_id,
        losing_id,
        listing_id_a=a.listing_id,
        listing_id_b=b.listing_id,
        match_basis=result.basis,
        match_confidence=result.confidence,
    )

    # Issue #602, D-137 (MAJOR review finding): property_merge_log could
    # only distinguish an automatic merge from a human confirm_suggestion
    # click by the IMPLICIT, undocumented confidence value (0.900 vs
    # <=0.800, since a suggestion can never be filed above
    # photo_hash._MAX_SUGGESTION_CONFIDENCE) -- no explicit record. Stamp
    # it explicitly instead: confidence == PHOTO_MERGE_CONFIDENCE (0.900)
    # on basis == "photo_hash" is reached ONLY by evaluate_pair's own
    # merge branch (directly in `_run`, or via a fresh re-evaluation in
    # `_reevaluate_pending_suggestion`) -- confirm_suggestion always
    # preserves the ORIGINAL suggestion's confidence, which for photo_hash
    # tops out at 0.800. This makes "was this specific merge auto-decided
    # by the D-137 rule, or a human's explicit confirm" queryable from
    # property_merge_log.detail alone, without relying on that implicit
    # confidence-value convention.
    if (
        result.basis == "photo_hash"
        and result.confidence == photo_hash.PHOTO_MERGE_CONFIDENCE
    ):
        snapshot = {**snapshot, "auto_merge_rule": "photo_hash_exact_d137"}

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO property_merge_log "
            "(property_id, losing_property_id, merged_listing_ids, match_basis, "
            "confidence, detail) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (
                survivor_id,
                losing_id,
                moved_listing_ids,
                result.basis,
                result.confidence,
                json.dumps(snapshot),
            ),
        )

    conn.commit()
    return survivor_id, losing_id, had_conflict


def _reevaluate_pending_suggestion(
    conn,
    a: ListingRecord,
    b: ListingRecord,
    pending: _PendingSuggestion,
    evaluation: PairEvaluation | None,
    result: DedupRunResult,
) -> tuple[int, int] | None:
    """Reconcile an existing `pending` `suggested_merge` row with a fresh
    `evaluate_pair` verdict (issue #214).

    `_load_recorded_pairs` no longer freezes a `pending` verdict forever —
    every pending pair goes back through `evaluate_pair` exactly like a
    brand-new pair on every run, and this is where that fresh verdict is
    reconciled against the row that already exists for it:

    - `evaluation is None` (no signal fires at all any more): nothing
      supports this pair under current rules. The direct analogue of a
      human looking at the same evidence today and saying "no" — moved to
      `rejected`. This is the concrete shape of the #186 floor-veto
      acceptance case: a pair that used to clear `address_coords` now gets
      vetoed by a floor conflict there, falls through every other signal,
      and finds nothing to catch it — under the old code this pair would
      sit at `pending` forever with a `match_ratio`/basis nobody currently
      stands behind; now it explicitly leaves the queue.

      EXCEPT a row `purge_pending_fuzzy` rescued (`detail` carries a
      `rescued_reason` — issue #607/B1): that row is corroborated by
      evidence (exact m2_built+current_price AND a shared photo hash or a
      near-identical description) that no *live* signal in `evaluate_pair`
      was ever going to independently re-derive — `photo_hash`'s own
      `MIN_MATCH_RATIO` gate is stricter than the rescue's permissive
      `hashes_share_any_match`, and a description match isn't corroboration
      any live signal even looks at. `evaluation is None` for one of these
      rows is not new information the pair is bad; it is the exact,
      expected, permanent shape of "this is fuzzy's rescue set" restated.
      Auto-rejecting it here would have made the rescue self-defeating —
      the 51 survivors of a 24,981-row purge would have all flipped to
      `rejected` (worse than deleted: `_load_recorded_pairs` freezes
      `rejected` forever) on the very first post-deploy run. These rows
      stay `pending` instead, so a human still decides; see
      `reevaluated_preserved_rescued`.
    - `decision == "suggest"`: still not confident enough to auto-merge,
      but under current rules, not the rules that were live when this row
      was filed — refresh `match_basis`/`confidence`/`detail` in place and
      leave `status='pending'`. This is the fix for the sharpest case in
      #214: 193 rows scored while Milanuncios photos were entirely
      unhashable keep a stale `match_ratio` computed from missing data
      forever otherwise.
    - `decision == "merge"`: perform the merge (the same `perform_merge`
      path a brand-new pair takes) and resolve the *existing* row as
      `confirmed` rather than leaving a suggestion dangling at `pending`
      for a pair whose listings are already unified.

    Every branch preserves the row's pre-reevaluation state under a
    `reevaluated_from` key in `detail` — an operator (or a human reviewing
    a `rejected` row wondering why) can see exactly what this row used to
    say and why it changed, rather than the history being silently
    overwritten. `reevaluated_from` never appears on a row a human touched
    via `confirm_suggestion`/`reject_suggestion`, so its presence alone
    distinguishes "the engine changed its mind" from "a human decided".

    Returns `(survivor_property_id, losing_property_id)` when this call
    performed a merge, so `run()`'s caller can fix up its in-memory
    `listings` list the same way it already does for a brand-new merge.
    Returns `None` otherwise.
    """
    previous = {
        "status": "pending",
        "match_basis": pending.match_basis,
        "confidence": (
            float(pending.confidence) if pending.confidence is not None else None
        ),
        "detail": pending.detail,
    }
    result.reevaluated_total += 1

    if evaluation is None:
        # Issue #607 (B1): a rescued row must never fall into the
        # auto-reject branch below — see this function's own docstring for
        # why "nothing else fires" is expected, permanent, and not new
        # information for these rows.
        is_rescued = (
            isinstance(pending.detail, dict) and "rescued_reason" in pending.detail
        )
        if is_rescued:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE suggested_merge
                       SET detail = detail || %s::jsonb
                     WHERE id = %s
                    """,
                    (
                        json.dumps(
                            {
                                "reevaluated_from": previous,
                                "reevaluated_reason": (
                                    "no live signal matched this pair, but it "
                                    "carries a rescued_reason (issue #601's "
                                    "fuzzy-purge rescue set) — exempt from "
                                    "auto-reject, stays pending for a human"
                                ),
                            }
                        ),
                        pending.suggestion_id,
                    ),
                )
            conn.commit()
            result.reevaluated_preserved_rescued += 1
            return None

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE suggested_merge
                   SET status = 'rejected',
                       resolved_at = NOW(),
                       detail = detail || %s::jsonb
                 WHERE id = %s
                """,
                (
                    json.dumps(
                        {
                            "reevaluated_from": previous,
                            "reevaluated_reason": (
                                "no signal matched this pair under current rules"
                            ),
                        }
                    ),
                    pending.suggestion_id,
                ),
            )
        conn.commit()
        result.reevaluated_rejected += 1
        return None

    if evaluation.decision == "reject":
        # Issue #627 (D-138): the price-gap rule now rejects a pair that
        # was already sitting `pending` under an older `evaluate_pair`
        # verdict (e.g. photo_hash filed it before this rule existed, or
        # a later fetch changed the price/size on one side). Unlike a
        # brand-new pair (never filed at all, see `_run`), an EXISTING
        # row can't just be silently dropped — it has to land somewhere,
        # so it's moved to `rejected` with a `resolved_reason` that
        # distinguishes "the rule said no" from the generic "no signal
        # matched this pair under current rules" a few lines up. This
        # does NOT go through the `is_rescued` exemption above:
        # `price_gap`'s evidence (a real price/size/rooms contradiction)
        # is new counter-evidence the fuzzy-purge rescue heuristic never
        # considered, not "nothing fired" restated. Never creates a
        # `property_merge_veto` — that table is written only by the
        # human-only `reject_property_pair`, never from this reevaluation
        # path, rule-based or otherwise (D-138).
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE suggested_merge
                   SET status = 'rejected',
                       resolved_at = NOW(),
                       detail = detail || %s::jsonb
                 WHERE id = %s
                """,
                (
                    json.dumps(
                        {
                            "reevaluated_from": previous,
                            "resolved_reason": "price_gap_rule",
                            **(evaluation.detail or {}),
                        }
                    ),
                    pending.suggestion_id,
                ),
            )
        conn.commit()
        result.price_gap_rejected += 1
        return None

    if evaluation.decision == "suggest":
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE suggested_merge
                   SET match_basis = %s,
                       confidence = %s,
                       detail = %s::jsonb
                 WHERE id = %s
                """,
                (
                    evaluation.basis,
                    evaluation.confidence,
                    json.dumps(
                        {**(evaluation.detail or {}), "reevaluated_from": previous}
                    ),
                    pending.suggestion_id,
                ),
            )
        conn.commit()
        result.reevaluated_updated += 1
        return None

    # decision == "merge"
    survivor_id, losing_id, had_conflict = perform_merge(conn, a, b, evaluation)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE suggested_merge
               SET status = 'confirmed',
                   match_basis = %s,
                   confidence = %s,
                   resolved_at = NOW(),
                   detail = %s::jsonb
             WHERE id = %s
            """,
            (
                evaluation.basis,
                evaluation.confidence,
                json.dumps(
                    {
                        **(evaluation.detail or {}),
                        "reevaluated_from": previous,
                        "auto_confirmed_merge": {
                            "survivor_property_id": survivor_id,
                            "losing_property_id": losing_id,
                            "had_conflict": had_conflict,
                        },
                    }
                ),
                pending.suggestion_id,
            ),
        )
    conn.commit()
    result.reevaluated_merged += 1
    result.merged += 1
    if evaluation.basis == "photo_hash":
        result.photo_hash_auto_merged += 1
    if had_conflict:
        result.conflicts += 1
    return survivor_id, losing_id


def _resolve_pending_same_property(
    conn, pending: _PendingSuggestion, result: DedupRunResult
) -> None:
    """Resolve a `pending` suggested_merge row whose two listings already
    share a property_id — issue #604.

    Mirrors `confirm_suggestion`'s own "already unified by another pair"
    branch (see that function's docstring): the intent behind this
    suggestion — these are the same property — is already satisfied by
    whatever merge unified them, so this marks the row `confirmed` without
    calling `perform_merge` again. There is nothing left to merge: both
    listings already point at the same property, and re-running the merge
    machinery would try to move listings off a losing property that no
    longer has anything on it.

    Every branch of `_reevaluate_pending_suggestion` preserves the row's
    pre-resolution state under `reevaluated_from` in `detail` for the same
    auditability reason — this does too, plus a `resolved_reason` so a
    human (or a future debugging session) can tell this apart from a fresh
    `evaluate_pair` verdict.
    """
    previous = {
        "status": "pending",
        "match_basis": pending.match_basis,
        "confidence": (
            float(pending.confidence) if pending.confidence is not None else None
        ),
        "detail": pending.detail,
    }
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE suggested_merge
               SET status = 'confirmed',
                   resolved_at = NOW(),
                   detail = detail || %s::jsonb
             WHERE id = %s
            """,
            (
                json.dumps(
                    {
                        "reevaluated_from": previous,
                        "resolved_reason": "listings already unified",
                    }
                ),
                pending.suggestion_id,
            ),
        )
    conn.commit()
    result.same_property_pending_resolved += 1


def _resolve_pending_vetoed_property(
    conn, pending: _PendingSuggestion, result: DedupRunResult
) -> None:
    """Resolve a `pending` suggested_merge row whose two PROPERTIES are
    now covered by a `property_merge_veto` — issue #605 Part 2 revision
    (PR #611 review, B1).

    Mirrors `_resolve_pending_same_property`'s shape but the OPPOSITE
    verdict: marks the row 'rejected', not 'confirmed' — a human said
    these two properties are NOT the same, so a row that predates the
    veto (a different listing combination between the same two
    properties, filed before the veto existed) must land on the same
    answer, not sit there confirmable via a stale open tab. There is
    nothing left to score: the property pair is permanently vetoed
    regardless of what evaluate_pair would say about these two specific
    listings.
    """
    previous = {
        "status": "pending",
        "match_basis": pending.match_basis,
        "confidence": (
            float(pending.confidence) if pending.confidence is not None else None
        ),
        "detail": pending.detail,
    }
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE suggested_merge
               SET status = 'rejected',
                   resolved_at = NOW(),
                   detail = detail || %s::jsonb
             WHERE id = %s
            """,
            (
                json.dumps(
                    {
                        "reevaluated_from": previous,
                        "resolved_reason": "property pair vetoed",
                    }
                ),
                pending.suggestion_id,
            ),
        )
    conn.commit()
    result.vetoed_pending_resolved += 1


def run(conn) -> DedupRunResult:
    """Compare every not-yet-merged listing pair and act on the result.

    A listing's in-memory property_id is updated after every merge (not
    re-fetched from the DB) so that a third listing sharing a property with
    either side of an earlier merge in the *same run* is correctly treated
    as already-unified in later iterations, without a full re-query.

    Issue #197 — same-source pairs are never generated at all: "in the same
    connector they wouldn't be duplicates, only if they come from different
    connectors ... a duplicate in the same connector would be really
    strange" (owner). Measured against the live corpus, 456 of 585 (78%)
    pending suggestions were same-source — the `fuzzy` signal (90% of the
    queue's volume) was 81% same-source noise. The skip happens *before*
    `evaluate_pair` (i.e. before scoring, not filtered out of the
    suggestions afterward): it's the actual per-pair CPU cost this loop
    exists to bound (see this module's own docstring on the ~13.3us/pair
    measurement and why blocking/bucketing will eventually be needed), so
    filtering post-hoc would keep paying that cost for nothing. This is
    also why `same_source_skipped`/`same_source_cadastral_collisions` are
    *not* persisted into the `dedup_runs` table here: doing so needs a
    schema change (new columns) plus a couple-line change in
    orchestrator.py's `_finish_dedup_run`/`run_dedup`, both outside
    etl/dedup/**'s surface for this change — see the PR description for the
    exact diff to land in a follow-up. For now the counts are logged
    (operator-visible via container/CLI logs) and returned on
    `DedupRunResult` (surfaced by `ps dedup run`'s own print).

    "Really strange" is not "impossible" (owner's own wording) — a
    re-listed expired advert on the same portal is the plausible real case
    — so this never silently drops a same-source cadastral_ref collision
    specifically: that's a data-quality signal (two rows on one portal
    claiming the same land-registry parcel) worth an operator's attention
    regardless of the no-merge rule, so it's counted and logged separately
    even though it's still never merged or suggested.

    Issue #214 — `pending` suggestions are re-evaluated, not skipped
    forever. `_load_recorded_pairs` now splits recorded pairs into
    `skip_pairs` (permanent: `rejected`/`conflict`, plus any `pending` row
    with an in-flight `suggested_merge_action`) and `pending_by_pair`
    (every other `pending` row). A pair found in `pending_by_pair` still
    goes through `evaluate_pair` exactly like a brand-new pair — see
    `_reevaluate_pending_suggestion` for how the fresh verdict is
    reconciled against the existing row (refresh in place / reject / merge
    and mark confirmed).

    Issue #221 — the photo-hash store runs on its own connection, opened and
    closed here. It must not share *conn*: riding the dedup run's transaction
    meant hashes were only ever committed when a merge happened to fire (so an
    interrupted cold pass threw away ~46 minutes of fetching and the next run
    started cold again), and every saved row stayed locked until the run
    ended, blocking any concurrent run that touched a shared URL. A store the
    engine can't open is not an error: `open_connection` returns None and the
    run just fetches every photo, exactly as it did before #221.
    """
    store_conn = photo_hash_store.open_connection()
    try:
        return _run(conn, _PhotoHashCache(store_conn))
    finally:
        photo_hash_store.close_connection(store_conn)


def _run(conn, hash_cache: _PhotoHashCache) -> DedupRunResult:
    """The run proper, with the photo-hash cache injected.

    Split from `run` so the store connection's lifetime is owned in exactly
    one place (`run`'s try/finally) rather than threaded through this
    function's several exit paths.
    """
    listings = fetch_listing_records(conn)
    result = DedupRunResult()
    # Issue #618: per-run only (see _PhoneCache's docstring) — created fresh
    # for this pass and discarded when `_run` returns.
    phone_cache = _PhoneCache()

    with conn.cursor() as cur:
        skip_pairs, pending_by_pair = _load_recorded_pairs(cur)
        vetoed_property_pairs = _load_vetoed_property_pairs(cur)
        for i in range(len(listings)):
            for j in range(i + 1, len(listings)):
                a, b = listings[i], listings[j]
                if a.property_id == b.property_id:
                    # Issue #604: don't skip silently — a pending
                    # suggestion for THIS pair may still be sitting in the
                    # queue because a DIFFERENT pair's merge is what
                    # unified them, not a confirm of this one. Checked
                    # before the `continue` (not after, which is exactly
                    # the bug) so it's never bypassed.
                    same_property_pair_key = tuple(sorted((a.listing_id, b.listing_id)))
                    pending_same_property = pending_by_pair.get(same_property_pair_key)
                    if pending_same_property is not None:
                        _resolve_pending_same_property(
                            conn, pending_same_property, result
                        )
                    continue

                property_pair_key = tuple(sorted((a.property_id, b.property_id)))
                if property_pair_key in vetoed_property_pairs:
                    # Issue #605 Part 2 revision (PR #611 review, B1): a
                    # human rejected this PROPERTY pair — never evaluate,
                    # suggest, or auto-merge ANY listing combination
                    # between them again, not just the exact listing
                    # pair(s) that were rejected. Checked BEFORE
                    # evaluate_pair (unlike the old listing-keyed
                    # skip_pairs check below, which only ever stopped
                    # re-suggestion of the one pair it recorded) — this is
                    # what stops a fresh listing combination between the
                    # same two properties from auto-merging outright, the
                    # failure mode the review reproduced live twice. A
                    # pending row that predates the veto (a different
                    # listing combination, not yet resolved) is swept to
                    # 'rejected' here too, so it can't be confirmed later
                    # via a stale open tab.
                    pair_key = tuple(sorted((a.listing_id, b.listing_id)))
                    pending_vetoed = pending_by_pair.get(pair_key)
                    if pending_vetoed is not None:
                        _resolve_pending_vetoed_property(conn, pending_vetoed, result)
                    result.vetoed_pairs_skipped += 1
                    continue

                if a.source == b.source:
                    result.same_source_skipped += 1
                    if a.cadastral_ref and a.cadastral_ref == b.cadastral_ref:
                        result.same_source_cadastral_collisions += 1
                        logger.warning(
                            "dedup: same-source cadastral collision — "
                            "listings %s/%s (source=%s) share cadastral_ref "
                            "%s but will never be paired for merge/"
                            "suggestion (issue #197); a data-quality issue "
                            "worth checking on that portal, not a dedup "
                            "target",
                            a.listing_id,
                            b.listing_id,
                            a.source,
                            a.cadastral_ref,
                        )
                    continue
                pair_key = tuple(sorted((a.listing_id, b.listing_id)))
                if pair_key in skip_pairs:
                    continue
                pending = pending_by_pair.get(pair_key)

                result.pairs_compared += 1
                evaluation = evaluate_pair(a, b, hash_cache, phone_cache)

                if pending is not None:
                    try:
                        merge_ids = _reevaluate_pending_suggestion(
                            conn, a, b, pending, evaluation, result
                        )
                    except ValueError as exc:
                        # Issue #605 Part 2 revision (PR #611 second
                        # review, M-1 — promoted to blocker): the SAME
                        # race `perform_merge`'s veto guard exists for
                        # (see below) can fire here too, inside a
                        # reevaluation's own merge branch. A correct
                        # refusal must not kill the whole run.
                        result.vetoed_merge_refused += 1
                        logger.warning(
                            "dedup: reevaluation merge refused mid-run by "
                            "property_merge_veto (listings %s/%s) — %s",
                            a.listing_id,
                            b.listing_id,
                            exc,
                        )
                        continue
                    if merge_ids is not None:
                        survivor_id, losing_id = merge_ids
                        listings = [
                            dataclasses.replace(rec, property_id=survivor_id)
                            if rec.property_id == losing_id
                            else rec
                            for rec in listings
                        ]
                        # Re-read (issue #605 Part 2 revision, PR #611
                        # review B1): perform_merge may have repointed a
                        # veto involving the losing property onto the
                        # survivor — reloading keeps THIS run's in-memory
                        # set consistent with what a fresh run would see,
                        # for every pair compared after this one.
                        vetoed_property_pairs = _load_vetoed_property_pairs(cur)
                    continue

                if evaluation is None:
                    continue

                if evaluation.decision == "reject":
                    # Issue #627 (D-138): the price-gap rule fired for a
                    # brand-new pair — per the design, never file a
                    # suggested_merge row for it (the pair never enters
                    # the review queue, nothing is recorded as a
                    # decision, and a later data change re-opens it
                    # naturally next run). Counted so the rejection is
                    # still visible — see DedupRunResult.price_gap_rejected.
                    result.price_gap_rejected += 1
                    continue

                if evaluation.decision == "merge":
                    try:
                        survivor_id, losing_id, had_conflict = perform_merge(
                            conn, a, b, evaluation
                        )
                    except ValueError as exc:
                        # Issue #605 Part 2 revision (PR #611 second
                        # review, M-1 — promoted to blocker): a correct
                        # veto refusal is a business outcome, not a
                        # run-killer. `_run`'s own pairwise loop already
                        # skips a vetoed pair before ever reaching
                        # evaluate_pair (the normal path) — this only
                        # fires on the genuine race where a concurrent
                        # `reject_pair` action commits a veto for this
                        # EXACT pair between when `vetoed_property_pairs`
                        # was loaded and this comparison. Without this
                        # catch the ValueError propagated out of
                        # `engine.run()`, `run_dedup` recorded the whole
                        # `dedup_runs` row as failed, and every pair after
                        # this point in an ~84-minute pass went
                        # uncompared — reproduced live: the owner tapping
                        # "Rechazar" on his phone mid-run killed the pass.
                        # Contrast `confirm_suggestion`, where the SAME
                        # raise correctly becomes one `failed` action row
                        # for one human's one click — that raise is left
                        # alone.
                        result.vetoed_merge_refused += 1
                        logger.warning(
                            "dedup: merge refused mid-run by "
                            "property_merge_veto (listings %s/%s) — %s",
                            a.listing_id,
                            b.listing_id,
                            exc,
                        )
                        continue
                    result.merged += 1
                    if evaluation.basis == "photo_hash":
                        result.photo_hash_auto_merged += 1
                    if had_conflict:
                        result.conflicts += 1
                    listings = [
                        dataclasses.replace(rec, property_id=survivor_id)
                        if rec.property_id == losing_id
                        else rec
                        for rec in listings
                    ]
                    vetoed_property_pairs = _load_vetoed_property_pairs(cur)
                else:
                    file_suggestion(conn, a, b, evaluation)
                    result.suggested += 1

    if result.reevaluated_total:
        logger.info(
            "dedup: re-evaluated %d pending suggestion(s) against current "
            "rules (issue #214) — %d merged, %d rejected, %d still pending "
            "(refreshed in place), %d preserved as fuzzy-purge rescues "
            "(issue #607)",
            result.reevaluated_total,
            result.reevaluated_merged,
            result.reevaluated_rejected,
            result.reevaluated_updated,
            result.reevaluated_preserved_rescued,
        )

    if result.same_property_pending_resolved:
        logger.info(
            "dedup: resolved %d pending suggestion(s) whose listings were "
            "already unified by a different merge (issue #604) — marked "
            "confirmed, no new merge performed",
            result.same_property_pending_resolved,
        )

    if result.same_source_skipped:
        logger.info(
            "dedup: skipped %d same-source pair(s) at pair-generation "
            "(issue #197 — duplicates within one connector are not paired "
            "for merge/suggestion); %d of those shared a cadastral_ref "
            "(data-quality flag, not auto-merged)",
            result.same_source_skipped,
            result.same_source_cadastral_collisions,
        )

    result.photo_hash_zero_success_sources = hash_cache.zero_success_sources()
    for source, attempted in sorted(result.photo_hash_zero_success_sources.items()):
        logger.warning(
            "dedup: source=%s had 0/%d freshly-fetched photo(s) hash "
            "successfully this run — "
            "photo_hash contributes no evidence to ANY pair involving this "
            "source (issue #206); check the connector's photo URLs are "
            "actually fetchable (CDN auth/params, expired links, ...)",
            source,
            attempted,
        )

    return result


def purge_same_source_pending(conn) -> int:
    """One-off migration (issue #197): delete existing `pending`
    `suggested_merge` rows whose two listings share a `source`.

    Issue #197 measured 456 of 585 pending suggestions (78%) as same-source
    on the live corpus before this filter existed. Those rows were filed by
    runs that predate the pair-generation filter in `run()` above and will
    never be re-created by a future run (the filter stops them at
    generation), but existing rows need an explicit purge — `run()` itself
    deliberately does not delete pre-existing suggestions on every pass
    (that would be a surprising, unrequested side effect of an unrelated
    code path), so this is exposed as its own callable/CLI subcommand
    (`ps dedup purge-same-source`) to run once after deploying this change.

    Scoped to `status = 'pending'` only, matching `_load_recorded_pairs`'s
    own reasoning: a 'confirmed' same-source suggestion already went
    through a human decision and its merge (if any) is a real
    `property_merge_log` row now, not something this purge should touch;
    'rejected'/'conflict' rows are already-resolved history. Only 'pending'
    rows are the ones issue #197 says should never have been filed at all.

    Returns the number of rows deleted.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM suggested_merge sm
                  USING listing la, listing lb
                  WHERE sm.listing_id_a = la.id
                    AND sm.listing_id_b = lb.id
                    AND la.source = lb.source
                    AND sm.status = 'pending'
            """
        )
        deleted = cur.rowcount
    conn.commit()
    return deleted


def preview_purge_pending_phone(conn) -> tuple[int, int]:
    """Dry-run twin of `purge_pending_phone` (issue #607/S1): returns
    `(would_delete, would_keep)` without deleting anything. `would_keep` is
    the pending `phone` rows this purge deliberately never touches — the
    0.750 corroborated-unconfirmed-kind tier D-131 kept filing suggestions
    on."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT "
            "  COUNT(*) FILTER (WHERE confidence = 0.500), "
            "  COUNT(*) FILTER (WHERE confidence <> 0.500) "
            "FROM suggested_merge WHERE status = 'pending' AND match_basis = 'phone'"
        )
        would_delete, would_keep = cur.fetchone()
    return would_delete, would_keep


def purge_pending_phone(conn) -> int:
    """One-off migration companion (issue #603): delete remaining
    `pending` `suggested_merge` rows with `match_basis = 'phone'` AND
    `confidence = 0.500` — the uncorroborated/agency tier D-131 silenced.

    Meant to run AFTER at least one full `ps dedup run` since #603's
    `evaluate_pair` reorder + `phone_extract` silencing deployed — that
    run's normal D-024 reevaluation pass already resolves every
    pre-existing `phone`-pending row on its own (every pair is
    reevaluated every run, not just a sampled subset): a pair with real
    corroborating evidence either merges outright (photo_hash's exact
    match, or phone's own surviving 0.900 particular/particular tier),
    gets refreshed onto whatever basis now explains it (photo_hash's
    partial-overlap suggestion, or phone's surviving 0.750
    unconfirmed-kind tier), or — the measured common case, #600's 320
    pending phone rows were 100% agency-sided, which both silenced tiers
    (uncorroborated, corroborated-with-an-agency-side) now return `None`
    for — gets auto-rejected by `_reevaluate_pending_suggestion`'s
    `evaluation is None` branch. In the ideal case this purge finds
    nothing left to delete; it exists as the same explicit, reviewable,
    idempotent cleanup step as `purge_same_source_pending` (issue #197)
    for whatever a still-in-flight reevaluation sweep hasn't caught up to
    yet, not as a substitute for letting that reevaluation run.

    Issue #607 (B3): scoped to `confidence = 0.500` — NOT every pending
    `phone` row. D-131 deliberately kept phone's 0.750
    corroborated-unconfirmed-kind tier filing suggestions (see
    `phone_extract.evaluate`); an unconditional `match_basis = 'phone'`
    delete would take any 0.750 row filed between deploy and this command
    running along with the 0.500 noise it's meant to clean up. And by the
    time an operator runs this (after a reevaluation pass, per the
    docstring above), every remaining 0.500 row has typically already been
    auto-rejected on its own — so an unscoped delete's only REMAINING
    effect in practice would be deleting rows it should keep, not rows it
    should purge.

    Scoped to `status = 'pending'` only, same reasoning as
    `purge_same_source_pending`: a `confirmed` phone suggestion already
    went through a real merge (or a human's confirm) and is a
    `property_merge_log` row now; `rejected`/`conflict` rows are already
    resolved history. Only a `pending` phone row is the shape #600 found
    to be pure noise.

    Returns the number of rows deleted.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM suggested_merge "
            "WHERE status = 'pending' AND match_basis = 'phone' "
            "AND confidence = 0.500"
        )
        deleted = cur.rowcount
    conn.commit()
    return deleted


# Issue #601's rescue set, second half of the "exact m2+price" gate: how
# similar two descriptions must read to count as "near-identical" —
# rapidfuzz's token_sort_ratio is 0-100, compared here as a 0-1 ratio, same
# convention as fuzzy.py used before its retirement. 0.90 is deliberately
# stricter than fuzzy's old 0.55 address-similarity bar — this is a
# same-listing-republished check (the whole description essentially
# copy-pasted across portals), not a same-neighbourhood check.
_FUZZY_RESCUE_DESCRIPTION_SIMILARITY = 0.90


def _fuzzy_rescue_exact_price_and_size(
    price_a: Decimal | None,
    price_b: Decimal | None,
    m2_a: Decimal | None,
    m2_b: Decimal | None,
) -> bool:
    if price_a is None or price_b is None or m2_a is None or m2_b is None:
        return False
    return price_a == price_b and m2_a == m2_b


def _fuzzy_rescue_shares_a_photo(
    store_conn, urls_a: tuple[str, ...], urls_b: tuple[str, ...]
) -> bool:
    """Read-only against the persistent photo_hashes store (D-025) — never
    a live fetch. A URL this store has no opinion on (never hashed, or
    hashed by a run predating this migration) is simply unknown, not
    evidence either way, matching this codebase's usual permissive
    handling of missing photo evidence elsewhere in the engine.
    """
    if store_conn is None or not urls_a or not urls_b:
        return False
    known_a = photo_hash_store.load(store_conn, urls_a)
    known_b = photo_hash_store.load(store_conn, urls_b)
    # Issue #618: hashes_share_any_match takes packed ints, not
    # imagehash.ImageHash — see photo_hash.pack_hash's docstring.
    hashes_a = [
        photo_hash.pack_hash(h.phash)
        for h in known_a.values()
        if h.ok and h.phash is not None
    ]
    hashes_b = [
        photo_hash.pack_hash(h.phash)
        for h in known_b.values()
        if h.ok and h.phash is not None
    ]
    return photo_hash.hashes_share_any_match(hashes_a, hashes_b)


def _fuzzy_rescue_descriptions_near_identical(
    desc_a: str | None, desc_b: str | None
) -> bool:
    if not desc_a or not desc_b:
        return False
    similarity = fuzz.token_sort_ratio(desc_a, desc_b) / 100
    return similarity >= _FUZZY_RESCUE_DESCRIPTION_SIMILARITY


def _select_pending_fuzzy_rows(conn) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT sm.id,
                   la.current_price, lb.current_price,
                   pa.m2_built, pb.m2_built,
                   la.description, lb.description,
                   la.photo_urls, lb.photo_urls
              FROM suggested_merge sm
              JOIN listing la ON la.id = sm.listing_id_a
              JOIN listing lb ON lb.id = sm.listing_id_b
              JOIN property pa ON pa.id = la.property_id
              JOIN property pb ON pb.id = lb.property_id
             WHERE sm.status = 'pending' AND sm.match_basis = 'fuzzy'
            """
        )
        return cur.fetchall()


def _compute_fuzzy_rescue_ids(rows: list[tuple]) -> list[int]:
    """Shared by `purge_pending_fuzzy` and `preview_purge_pending_fuzzy` so
    a dry-run and the real purge can never disagree about which rows
    qualify. Raises `PhotoHashStoreUnavailableError` (issue #607/B2) rather
    than silently degrading — see that class's docstring — for BOTH
    callers: a dry run that silently under-counted rescues would give an
    operator false confidence right before the real, destructive run.
    """
    store_conn = _photo_hash_store_or_raise()
    try:
        rescue_ids: list[int] = []
        for (
            suggestion_id,
            price_a,
            price_b,
            m2_a,
            m2_b,
            desc_a,
            desc_b,
            photos_a,
            photos_b,
        ) in rows:
            if not _fuzzy_rescue_exact_price_and_size(price_a, price_b, m2_a, m2_b):
                continue
            has_photo_match = _fuzzy_rescue_shares_a_photo(
                store_conn, tuple(photos_a or ()), tuple(photos_b or ())
            )
            has_description_match = _fuzzy_rescue_descriptions_near_identical(
                desc_a, desc_b
            )
            if has_photo_match or has_description_match:
                rescue_ids.append(suggestion_id)
        return rescue_ids
    finally:
        photo_hash_store.close_connection(store_conn)


def preview_purge_pending_fuzzy(conn) -> tuple[int, int]:
    """Dry-run twin of `purge_pending_fuzzy` (issue #607/S1): returns
    `(would_delete, would_rescue)` without writing anything. Raises
    `PhotoHashStoreUnavailableError` under the same condition the real
    purge aborts on (issue #607/B2) — a dry run must fail exactly the same
    way the real run would, or it's lying about what a real run will do.
    """
    rows = _select_pending_fuzzy_rows(conn)
    rescue_ids = _compute_fuzzy_rescue_ids(rows)
    return len(rows) - len(rescue_ids), len(rescue_ids)


def purge_pending_fuzzy(conn) -> tuple[int, int]:
    """One-off migration (issue #601): delete `pending` `match_basis='fuzzy'`
    suggested_merge rows, EXCEPT a rescue set corroborated well enough to
    still be real duplicates despite fuzzy's near-zero measured precision
    (~0.4-0.7% on a stratified hand check — see D-130 and issue #600).

    Rescue set: a pending fuzzy pair whose two listings have EXACTLY equal
    `m2_built` AND `current_price` cross-listing, AND EITHER share at
    least one photo (`photo_hash.hashes_share_any_match`, read from the
    persistent store — never a live fetch) OR have near-identical
    descriptions (`_fuzzy_rescue_descriptions_near_identical`). Both
    conjuncts matter: exact price+size alone is common in a dense market
    (many similar flats coincidentally share a price/size band — the
    percolation issue #600 diagnosed) and is not corroboration by itself;
    photo/description agreement alone (without exact price+size) is
    exactly what a same-neighbourhood, different-unit pair could also
    show.

    Rescued rows are kept `pending` with `match_basis` left at 'fuzzy' —
    no other signal fired for them, that is WHY they were only ever fuzzy
    — and their `detail` stamped with a `rescued_reason` so a human
    reviewing the queue understands why this one fuzzy row survived when
    the rest were purged. This does not reactivate fuzzy as a live signal:
    `evaluate_pair` no longer calls it at all (see this module's own
    change); it only decides which of fuzzy's PAST suggestions still
    deserve a human's attention. See `_reevaluate_pending_suggestion` for
    the companion fix (issue #607/B1) that stops the very next `run()`
    from immediately auto-rejecting every rescued row.

    Issue #607 (B2): raises `PhotoHashStoreUnavailableError` instead of
    proceeding when `photo_hash_store.open_connection()` returns `None`.
    Without this guard, `_fuzzy_rescue_shares_a_photo` degrades to `False`
    for every pair (an unreachable store looks identical to "no photo
    evidence"), the rescue set silently collapses to description-only
    matches (measured: 19 of 51 on production's numbers — the other 32
    would have been deleted), and the DELETE below takes the rest with no
    error and no non-zero exit. A destructive migration must fail loudly
    on a degraded optimisation it depends on, not fail open.

    Returns (deleted_count, rescued_count).
    """
    rows = _select_pending_fuzzy_rows(conn)
    rescue_ids = _compute_fuzzy_rescue_ids(rows)

    with conn.cursor() as cur:
        if rescue_ids:
            cur.execute(
                """
                UPDATE suggested_merge
                   SET detail = detail || %s::jsonb
                 WHERE id = ANY(%s)
                """,
                (
                    json.dumps(
                        {
                            "rescued_reason": (
                                "issue #601 fuzzy purge: exact m2_built+"
                                "current_price, corroborated by shared "
                                "photo evidence and/or a near-identical "
                                "description"
                            )
                        }
                    ),
                    rescue_ids,
                ),
            )
        cur.execute(
            """
            DELETE FROM suggested_merge
             WHERE status = 'pending' AND match_basis = 'fuzzy'
               AND NOT (id = ANY(%s))
            """,
            (rescue_ids,),
        )
        deleted = cur.rowcount
    conn.commit()
    return deleted, len(rescue_ids)


def _select_pending_photo_hash_rows_missing_matched_photos(conn) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT sm.id, la.photo_urls, lb.photo_urls
              FROM suggested_merge sm
              JOIN listing la ON la.id = sm.listing_id_a
              JOIN listing lb ON lb.id = sm.listing_id_b
             WHERE sm.status = 'pending' AND sm.match_basis = 'photo_hash'
               AND NOT (sm.detail ? 'matched_photos')
            """
        )
        return cur.fetchall()


def _compute_backfill_matched_photos(
    rows: list[tuple], store_conn
) -> dict[int, list[dict]]:
    """`suggestion_id -> matched_photos` payload for every row where the
    PERSISTENT store already has enough hash coverage to identify at
    least one matched pair. Read-only against `photo_hashes` (D-025) —
    issue #615/#622's backfill NEVER performs a live fetch. A row whose
    store coverage is incomplete on either side (a URL never hashed, or
    hashed with `ok=False`) is simply left out of the returned dict — it
    stays eligible for a future run of this same command, or for the
    dedup engine's own next successful `evaluate_pair` pass, once
    coverage improves.

    Shared by `preview_backfill_matched_photos` and
    `backfill_matched_photos` so a dry run can never disagree with what
    the real run would do — same discipline as
    `_compute_fuzzy_rescue_ids`.
    """
    result: dict[int, list[dict]] = {}
    for suggestion_id, urls_a, urls_b in rows:
        urls_a = tuple(urls_a or ())
        urls_b = tuple(urls_b or ())
        if not urls_a or not urls_b:
            continue
        known_a = photo_hash_store.load(store_conn, urls_a)
        known_b = photo_hash_store.load(store_conn, urls_b)
        pairs_a = [
            (url, entry.phash)
            for url, entry in known_a.items()
            if entry.ok and entry.phash is not None
        ]
        pairs_b = [
            (url, entry.phash)
            for url, entry in known_b.items()
            if entry.ok and entry.phash is not None
        ]
        matches = photo_hash.matched_pairs(pairs_a, pairs_b)
        if not matches:
            continue
        result[suggestion_id] = [
            {"url_a": m.url_a, "url_b": m.url_b, "distance": m.distance}
            for m in matches
        ]
    return result


def preview_backfill_matched_photos(conn) -> tuple[int, int]:
    """Dry-run twin of `backfill_matched_photos` — returns
    `(scanned, would_update)` without writing anything. Raises
    `PhotoHashStoreUnavailableError` under the same condition the real
    backfill aborts on (same discipline as `preview_purge_pending_fuzzy`)
    — a dry run must fail exactly the way the real run would, not report
    a false zero.
    """
    rows = _select_pending_photo_hash_rows_missing_matched_photos(conn)
    store_conn = _photo_hash_store_or_raise()
    try:
        updates = _compute_backfill_matched_photos(rows, store_conn)
    finally:
        photo_hash_store.close_connection(store_conn)
    return len(rows), len(updates)


def backfill_matched_photos(conn) -> tuple[int, int]:
    """One-off migration (issue #615, superseding the separately-filed
    #622): populate `detail.matched_photos` on PENDING `photo_hash`
    `suggested_merge` rows filed BEFORE #615's `matched_pairs` landed, so
    `PropertyPairCard` can show the true matching photos immediately
    instead of waiting for the next successful `ps dedup run` — which is
    not imminent on production (`dedup_runs` 123-126 all failed to the
    D-036 orphan guard, last success 02:49, #614) and, even once it
    succeeds, `evaluate_pair` only re-derives `matched_photos` for a row
    it actually re-evaluates.

    Read-only against the persistent `photo_hashes` store (D-025) — NEVER
    a live fetch, so this is cheap and safe to run at any time; the owner
    verified all 447 production rows already have `ok` hashes on both
    sides. A row whose store coverage is still incomplete is simply left
    alone (see `_compute_backfill_matched_photos`) — `NOT (detail ?
    'matched_photos')` keeps it eligible for a later run of this same
    command, or the engine's own next pass, once coverage improves.

    Deliberately narrow, on TWO axes:

    1. Only ever ADDS the `matched_photos` key via `detail || jsonb`
       (Postgres's jsonb concat operator) — every other key already in
       `detail` (`match_ratio`, `floor_conflict`, ...) survives untouched.
    2. Never touches `status`, `confidence`, or `match_basis`. A row the
       owner has already confirmed/rejected must not be reopened or have
       its verdict altered by a backfill — the UPDATE's own `WHERE`
       clause re-checks `status = 'pending'` at WRITE time (not just the
       initial SELECT), closing the race where a human decides a row
       between this command's read and its write.

    Raises `PhotoHashStoreUnavailableError` (same guard as
    `purge_pending_fuzzy`) rather than silently writing nothing when the
    store is unreachable — issue #607's exact prior failure mode, which a
    destructive-adjacent bulk write must not repeat even though this
    migration is additive-only.

    Returns `(scanned, updated)`.
    """
    rows = _select_pending_photo_hash_rows_missing_matched_photos(conn)
    store_conn = _photo_hash_store_or_raise()
    try:
        updates = _compute_backfill_matched_photos(rows, store_conn)
    finally:
        photo_hash_store.close_connection(store_conn)

    # `actually_updated` counts real UPDATE rowcounts, not len(updates) —
    # a row the WHERE guard refused (status changed to confirmed/rejected
    # between the SELECT above and this write) computed a match but wrote
    # nothing, and the returned count must say so honestly rather than
    # claiming a write that didn't happen.
    actually_updated = 0
    if updates:
        with conn.cursor() as cur:
            for suggestion_id, matched_photos in updates.items():
                cur.execute(
                    """
                    UPDATE suggested_merge
                       SET detail = detail || %s::jsonb
                     WHERE id = %s AND status = 'pending'
                    """,
                    (json.dumps({"matched_photos": matched_photos}), suggestion_id),
                )
                actually_updated += cur.rowcount
        conn.commit()
    return len(rows), actually_updated


def _fetch_listing_record(conn, listing_id: int) -> ListingRecord | None:
    """Fetch one listing by id in the same shape `fetch_listing_records` yields."""
    for record in fetch_listing_records(conn):
        if record.listing_id == listing_id:
            return record
    return None


def confirm_suggestion(conn, suggestion_id: int) -> tuple[int, int, bool]:
    """Merge the pair behind a `suggested_merge` row (issue #60).

    This is the missing half of the suggestion queue: `run` files
    medium-confidence pairs for human review, and until now nothing could
    ever act on that review — the pair was skipped forever on subsequent
    runs, so approving a suggestion had no effect whatsoever.

    Reuses `perform_merge` rather than reimplementing the merge, so a
    human-confirmed merge is recorded in `property_merge_log` identically
    to an auto-merge and is revertable by the same `revert` path. The
    original suggestion's `match_basis`/`confidence` carry through, so the
    log records *why* the pair was originally flagged, not a synthetic
    "because a human said so".

    Returns (survivor_property_id, losing_property_id, had_conflict).
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT listing_id_a, listing_id_b, match_basis, confidence, status, detail "
            "FROM suggested_merge WHERE id = %s",
            (suggestion_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"No suggested_merge row with id={suggestion_id}")
        listing_id_a, listing_id_b, match_basis, confidence, status, detail = row
        if status in ("confirmed", "rejected"):
            raise ValueError(
                f"Suggestion {suggestion_id} is already {status} — nothing to do"
            )
        if status == "conflict":
            raise ValueError(
                f"Suggestion {suggestion_id} is flagged 'conflict' (a merge-time "
                "state clash needing a human decision). Use "
                "`ps dedup resolve-conflict` to record that decision instead."
            )

    a = _fetch_listing_record(conn, listing_id_a)
    b = _fetch_listing_record(conn, listing_id_b)
    if a is None or b is None:
        raise ValueError(
            f"Suggestion {suggestion_id} references a listing that no longer "
            f"exists (a={listing_id_a}, b={listing_id_b})"
        )
    if a.property_id == b.property_id:
        # Already unified by some other merge since the suggestion was filed.
        # Mark it resolved rather than raising: the human's intent (these are
        # the same property) is already satisfied.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE suggested_merge SET status = 'confirmed', resolved_at = NOW() "
                "WHERE id = %s",
                (suggestion_id,),
            )
        conn.commit()
        raise ValueError(
            f"Suggestion {suggestion_id}'s listings already share property "
            f"{a.property_id} (merged by another pair since it was filed) — "
            "marked confirmed, no new merge needed"
        )

    evaluation = PairEvaluation(
        basis=match_basis,
        confidence=confidence,
        decision="merge",
        detail=detail if isinstance(detail, dict) else json.loads(detail or "{}"),
    )
    survivor_id, losing_id, had_conflict = perform_merge(conn, a, b, evaluation)

    # Provenance goes on the suggestion row, not property_merge_log.detail —
    # that column holds reconcile_merge's revert snapshot, and `revert` reads
    # it structurally, so mixing unrelated keys into it would be writing into
    # someone else's payload. The link is recoverable from this side: the
    # suggestion records which merge resolved it.
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE suggested_merge
               SET status = 'confirmed',
                   resolved_at = NOW(),
                   detail = detail || %s::jsonb
             WHERE id = %s
            """,
            (
                json.dumps(
                    {
                        "confirmed_merge": {
                            "survivor_property_id": survivor_id,
                            "losing_property_id": losing_id,
                            "had_conflict": had_conflict,
                        }
                    }
                ),
                suggestion_id,
            ),
        )
    conn.commit()
    return survivor_id, losing_id, had_conflict


def reject_suggestion(conn, suggestion_id: int) -> None:
    """Mark a suggestion as "these are not the same property" (issue #60).

    The pair stays in the skip set (see `_load_recorded_pairs`), so the
    engine won't re-suggest it on every future run — which is the whole
    point of recording the human's "no".
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status FROM suggested_merge WHERE id = %s", (suggestion_id,)
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"No suggested_merge row with id={suggestion_id}")
        if row[0] == "confirmed":
            raise ValueError(
                f"Suggestion {suggestion_id} was already confirmed and merged — "
                "use `ps dedup revert <merge_log_id>` to undo that merge instead"
            )
        cur.execute(
            "UPDATE suggested_merge SET status = 'rejected', resolved_at = NOW() "
            "WHERE id = %s",
            (suggestion_id,),
        )
    conn.commit()


def reject_property_pair(conn, suggestion_id: int) -> int:
    """Reject an entire PROPERTY pair (issue #605 Part 2 revision — PR
    #611 review, B1) — not just the one listing pair `suggestion_id`
    names.

    The grouped review queue asks "is property A the same as property
    B?", but `reject_suggestion` above only ever bound the exact LISTING
    pair it was filed against, via `suggested_merge`'s listing-keyed skip
    set. Two multi-listing properties can have several listing-pair
    combinations the queue never showed, so a human's rejection left
    those free to be freshly suggested — or auto-merged outright —
    moments later. Reproduced live in PR #611's review: rejecting a 2-row
    property-pair card through the dashboard, then running `ps dedup
    run`, brought the identical question straight back; in a second case
    the very next run auto-merged the two properties the human had just
    rejected.

    Derives the property pair from `suggestion_id`'s own listings (the
    dashboard's representative row — the same one `confirm_suggestion`
    acts on), then, in one transaction:
      1. Marks EVERY currently-pending suggested_merge row between the two
         properties as 'rejected' — not just the ones the dashboard's
         snapshot showed, so a concurrently-filed or stale-relative-to-
         the-UI row is caught too.
      2. Persists a `property_merge_veto` row so `_run`'s pairwise loop
         never evaluates, suggests, or auto-merges ANY listing
         combination between these two PROPERTY IDS again — including
         combinations not yet compared. This does NOT extend to a
         brand-new listing ingested later as its own new property row
         until/unless it later merges onto one of these two ids, which
         isn't guaranteed to land on the correct side — see issue #612.

    Returns how many suggested_merge rows were marked rejected (the
    dashboard/CLI caller doesn't need this for correctness — the veto is
    what actually binds — but it's useful confirmation that something
    concrete happened). Raises ValueError if `suggestion_id` doesn't
    exist, was already confirmed (use `ps dedup revert` instead), or its
    listings already share a property (nothing to veto).
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT listing_id_a, listing_id_b, status FROM suggested_merge WHERE id = %s",
            (suggestion_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"No suggested_merge row with id={suggestion_id}")
        listing_id_a, listing_id_b, status = row
        if status == "confirmed":
            raise ValueError(
                f"Suggestion {suggestion_id} was already confirmed and merged — "
                "use `ps dedup revert <merge_log_id>` to undo that merge instead"
            )

    a = _fetch_listing_record(conn, listing_id_a)
    b = _fetch_listing_record(conn, listing_id_b)
    if a is None or b is None:
        raise ValueError(
            f"Suggestion {suggestion_id} references a listing that no longer "
            f"exists (a={listing_id_a}, b={listing_id_b})"
        )
    if a.property_id == b.property_id:
        raise ValueError(
            f"Suggestion {suggestion_id}'s listings already share property "
            f"{a.property_id} — nothing to veto"
        )

    property_lo_id, property_hi_id = sorted((a.property_id, b.property_id))

    with conn.cursor() as cur:
        # Every still-pending suggested_merge row between these two
        # properties, resolved live against CURRENT listing.property_id —
        # not from the dashboard's possibly-stale snapshot. Same
        # normalization as the grouped queue's own query
        # (dashboard/lib/dedup.ts's PENDING_PAIR_CTE).
        cur.execute(
            """
            SELECT sm.id
              FROM suggested_merge sm
              JOIN listing la ON la.id = sm.listing_id_a
              JOIN listing lb ON lb.id = sm.listing_id_b
             WHERE sm.status = 'pending'
               AND LEAST(la.property_id, lb.property_id) = %s
               AND GREATEST(la.property_id, lb.property_id) = %s
            """,
            (property_lo_id, property_hi_id),
        )
        rejected_ids = [r[0] for r in cur.fetchall()]

        if rejected_ids:
            cur.execute(
                "UPDATE suggested_merge SET status = 'rejected', resolved_at = NOW() "
                "WHERE id = ANY(%s)",
                (rejected_ids,),
            )

        cur.execute(
            """
            INSERT INTO property_merge_veto (property_lo_id, property_hi_id, source_suggestion_ids)
            VALUES (%s, %s, %s)
            ON CONFLICT (property_lo_id, property_hi_id)
            DO UPDATE SET source_suggestion_ids = (
                SELECT ARRAY(SELECT DISTINCT unnest(
                    property_merge_veto.source_suggestion_ids || EXCLUDED.source_suggestion_ids
                ))
            )
            """,
            (property_lo_id, property_hi_id, rejected_ids or [suggestion_id]),
        )
    conn.commit()
    return len(rejected_ids)


def remove_property_veto(conn, property_id_a: int, property_id_b: int) -> bool:
    """Undo a `property_merge_veto` (issue #605 Part 2 revision — PR #611
    second review, M-2).

    Nothing else can clear one: `ps dedup revert` undoes a MERGE by its
    `property_merge_log` id, and `ps db query` is SELECT-only (see
    `cli/lib/sql_guard.py`). Sticky-by-default is the right call for a
    human's explicit "these are not the same property" — same permanence
    D-024 already established for a plain listing-pair reject — but a
    veto that widens onto property ids a human never actually looked at
    (via `perform_merge`'s repoint step, when one of the two vetoed
    properties later loses an unrelated merge) needs a real undo path,
    not just a theoretical "it's sticky, ask the owner to file a bug."

    Accepts the two ids in EITHER order — normalizes to
    (property_lo_id, property_hi_id) itself, mirroring every other
    property-pair function in this module, so a caller never has to know
    or guess which one is `LEAST`.

    Returns whether a row was actually deleted (False if no veto existed
    for this pair — not an error, since a human double-running `ps dedup
    unveto` on an already-cleared pair should get a clear "already gone"
    answer, not a crash).
    """
    property_lo_id, property_hi_id = sorted((property_id_a, property_id_b))
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM property_merge_veto "
            "WHERE property_lo_id = %s AND property_hi_id = %s",
            (property_lo_id, property_hi_id),
        )
        deleted = cur.rowcount > 0
    conn.commit()
    return deleted


def resolve_conflict(conn, suggestion_id: int) -> None:
    """Clear a 'conflict' flag once a human has dealt with it (issue #60).

    A `conflict` row is filed by `reconcile.reconcile_merge` when a merge
    unions two properties whose per-profile state genuinely disagrees (e.g.
    accepted in one profile, rejected in the other) — the merge itself
    already happened; what's flagged is that a human should look at the
    resulting state. Without this, such a row sat in permanent limbo:
    surfaced by `ps dedup suggestions` forever, with nothing able to clear it.

    This only records that the human has resolved it — it deliberately
    doesn't try to auto-repair the profile state, because the whole reason
    it was flagged is that the correct resolution isn't mechanically
    derivable.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status FROM suggested_merge WHERE id = %s", (suggestion_id,)
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"No suggested_merge row with id={suggestion_id}")
        if row[0] != "conflict":
            raise ValueError(
                f"Suggestion {suggestion_id} has status '{row[0]}', not 'conflict' "
                "— resolve-conflict only applies to merge-time state clashes"
            )
        cur.execute(
            "UPDATE suggested_merge SET status = 'rejected', resolved_at = NOW() "
            "WHERE id = %s",
            (suggestion_id,),
        )
    conn.commit()


def _restore_profile_listing_state(
    cur, survivor_id: int, losing_id: int, op: dict
) -> None:
    """Undo one entry from reconcile.reconcile_merge's snapshot (see that
    module's docstring for the four `kind` shapes)."""
    profile_id = op["profile_id"]
    kind = op["kind"]

    if kind == "rekeyed_no_prior_survivor_state":
        cur.execute(
            "UPDATE profile_listing_state SET property_id = %s "
            "WHERE property_id = %s AND profile_id = %s",
            (losing_id, survivor_id, profile_id),
        )
        return

    losing_row = op["losing_row"]
    cur.execute(
        """
        INSERT INTO profile_listing_state
            (profile_id, property_id, score, rank_explanation, pipeline_stage,
             notes, last_scored_at, matched)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (profile_id, property_id) DO UPDATE SET
            score = EXCLUDED.score,
            rank_explanation = EXCLUDED.rank_explanation,
            pipeline_stage = EXCLUDED.pipeline_stage,
            notes = EXCLUDED.notes,
            last_scored_at = EXCLUDED.last_scored_at,
            matched = EXCLUDED.matched
        """,
        (
            profile_id,
            losing_id,
            Decimal(losing_row["score"]) if losing_row["score"] is not None else None,
            losing_row["rank_explanation"],
            losing_row["pipeline_stage"],
            losing_row["notes"],
            losing_row["last_scored_at"],
            # Older snapshots (taken before task 2.4 added `matched`) won't
            # have this key — default to True rather than silently reverting
            # a row to "excluded from every candidate feed" on a merge that
            # predates the column's existence.
            losing_row.get("matched", True),
        ),
    )

    if "survivor_before" in op:
        # This branch also mutated the survivor's own row in place (stage
        # possibly bumped, score/rank_explanation/last_scored_at/matched
        # nulled or recomputed) — restore it to what it was immediately
        # before the merge. Every kind except rekeyed_no_prior_survivor_state
        # carries this now (reconcile.py nulls the survivor's score in all
        # three merge branches, not just stage_reconciled — Opus review,
        # PR #55; matched follows the same all-three-branches treatment,
        # Opus review, PR #57).
        before = op["survivor_before"]
        cur.execute(
            """
            UPDATE profile_listing_state
            SET score = %s, rank_explanation = %s, pipeline_stage = %s,
                notes = %s, last_scored_at = %s, matched = %s
            WHERE property_id = %s AND profile_id = %s
            """,
            (
                Decimal(before["score"]) if before["score"] is not None else None,
                before["rank_explanation"],
                before["pipeline_stage"],
                before["notes"],
                before["last_scored_at"],
                before.get("matched", True),
                survivor_id,
                profile_id,
            ),
        )


def revert(conn, merge_log_id: int) -> None:
    """Undo an auto-merge: point the moved listings back at the losing
    property, and restore the pre-merge profile_listing_state/feedback_event
    state that reconcile.reconcile_merge changed (see its module docstring
    for exactly what's captured and what isn't).

    The losing side's `property` row is never deleted (RESTRICT + engine.py
    only ever reassigns listing.property_id, never issues a DELETE) — it
    just stops having any listing pointing at it once merged away, which is
    what makes pointer restoration possible at all: point every listing this
    merge moved back at `losing_property_id`, which still physically exists
    with its original field values untouched.

    Documented limitation (still real, after the PR #55 review round fixed
    the bigger data-loss bug this function used to have): if *new* feedback
    or scoring activity happened on the surviving property after the merge
    but before this revert, that new activity isn't retroactively un-mixed —
    it stays on the survivor. What this function does restore, exactly, is
    whatever reconcile_merge changed at merge time (profile_listing_state
    rows it deleted/modified, feedback_event rows it re-keyed) — the
    previously-silent state loss that existed even with zero post-merge
    activity, which is the common case.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT losing_property_id, merged_listing_ids, reverted_at, detail, property_id "
            "FROM property_merge_log WHERE id = %s",
            (merge_log_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"No property_merge_log row with id={merge_log_id}")
        (
            losing_property_id,
            merged_listing_ids,
            reverted_at,
            detail,
            survivor_property_id,
        ) = row
        if reverted_at is not None:
            raise ValueError(
                f"Merge {merge_log_id} was already reverted at {reverted_at}"
            )
        if losing_property_id is None:
            # Defensive only: every merge this engine performs sets it.
            # Could only be None for a hand-inserted row predating this
            # column, which shouldn't exist outside a test fixture.
            raise ValueError(
                f"Merge {merge_log_id} has no losing_property_id recorded — cannot revert safely"
            )

        cur.execute(
            "UPDATE listing SET property_id = %s WHERE id = ANY(%s)",
            (losing_property_id, merged_listing_ids),
        )

        snapshot = detail if isinstance(detail, dict) else json.loads(detail or "{}")
        for feedback_event_id in snapshot.get("rekeyed_feedback_event_ids", ()):
            cur.execute(
                "UPDATE feedback_event SET property_id = %s WHERE id = %s",
                (losing_property_id, feedback_event_id),
            )
        for op in snapshot.get("profile_listing_state_ops", ()):
            _restore_profile_listing_state(
                cur, survivor_property_id, losing_property_id, op
            )

        cur.execute(
            "UPDATE property_merge_log SET reverted_at = NOW() WHERE id = %s",
            (merge_log_id,),
        )
    conn.commit()
