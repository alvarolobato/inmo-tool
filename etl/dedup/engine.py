"""The dedup matching pipeline (issue #16) — `ps dedup run` / `ps dedup revert`.

Compares every pair of listings that don't already share a property_id,
in the signal priority order from issue #1 §6 (cadastral -> address+coords
-> phone -> photo hash -> fuzzy fallback), auto-merging confident matches
and filing the rest as suggestions for human review.

Scale note: this is an O(n^2) pairwise comparison over every listing in the
table, deliberately — the right scale-up (blocking by geography/price
bucket before comparing, an index-backed candidate-generation step) is a
real piece of engineering that isn't worth building against a database with
a few dozen listings from two connectors. Revisit once real connector
volume makes a full pairwise scan slow.

Measured (issue #185, pure in-memory `evaluate_pair` cost across the first
four signals + fuzzy, `photo_urls=()` so `photo_hash.fetch_hashes` never
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

from etl.dedup import photo_hash_store, reconcile
from etl.dedup.signals import (
    address_coords,
    cadastral,
    fuzzy,
    phone_extract,
    photo_hash,
    reference_code,
)
from etl.dedup.signals.floor import floors_conflict
from etl.dedup.types import ListingRecord, PairEvaluation

logger = logging.getLogger("etl.dedup.engine")


@dataclass
class DedupRunResult:
    pairs_compared: int = 0
    merged: int = 0
    suggested: int = 0
    conflicts: int = 0
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
                   l.current_price, l.contact_raw, l.reference_code, p.floor
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

    def get(self, listing: ListingRecord) -> list:
        if listing.listing_id not in self._cache:
            hashes, stats = photo_hash.fetch_hashes_with_stats(
                listing.photo_urls, source=listing.source, store_conn=self._store_conn
            )
            self._cache[listing.listing_id] = hashes
            if stats.live_attempted:
                self._live_attempted_by_source[listing.source] = (
                    self._live_attempted_by_source.get(listing.source, 0)
                    + stats.live_attempted
                )
                self._live_hashed_by_source[listing.source] = (
                    self._live_hashed_by_source.get(listing.source, 0)
                    + stats.live_hashed
                )
        return self._cache[listing.listing_id]

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


def evaluate_pair(
    a: ListingRecord, b: ListingRecord, hash_cache: _PhotoHashCache
) -> PairEvaluation | None:
    """Run every signal in priority order; return the first that fires.

    Photo-hash fetching only happens once every cheaper, non-network signal
    has already come back empty — it's the one signal in this pipeline with
    real network cost, so it's deliberately last even though issue #16 lists
    it before fuzzy (signal 4 vs 5) rather than being evaluated eagerly for
    every pair regardless of whether a cheaper signal would have resolved it.
    """
    for evaluate_fn in (
        cadastral.evaluate,
        address_coords.evaluate,
        phone_extract.evaluate,
        reference_code.evaluate,
    ):
        result = evaluate_fn(a, b)
        if result is not None:
            return result

    hashes_a = hash_cache.get(a)
    hashes_b = hash_cache.get(b)
    ratio = photo_hash.match_ratio(hashes_a, hashes_b)
    if ratio is not None and Decimal(str(ratio)) >= photo_hash.MIN_MATCH_RATIO:
        detail: dict = {"match_ratio": round(ratio, 3)}
        # Issue #186: a floor present on both sides that disagrees is
        # direct evidence of "different unit, same building" — the owner's
        # own example (suggestion 197: floors "10º" vs "A partir de la 15ª
        # planta", identical photos and price, 6m² apart) came through this
        # exact signal. Computed once, used two ways below: it vetoes the
        # issue #188 auto-merge outright, and — even when it doesn't (ratio
        # < 1.0, or size/price don't corroborate) — it's still surfaced in
        # `detail` so a human reviewing the suggestion sees the
        # discriminating data point rather than an unexplained
        # perfect-looking match.
        floor_conflict = floors_conflict(a.floor, b.floor)
        if floor_conflict:
            detail["floor_conflict"] = True

        # Issue #188 (approved once #197 removed same-source pairing — see
        # photo_hash.PHOTO_MERGE_SIZE_RATIO's module-level comment for the
        # full reasoning and the measured tolerances): a *full* photo
        # overlap between two different sources (guaranteed here — #197
        # never hands evaluate_pair a same-source pair in the first place),
        # corroborated by size/price proximity and not vetoed by a
        # conflicting floor, auto-merges rather than sitting in the review
        # queue as a suggestion.
        exact_match = Decimal(str(round(ratio, 3))) == Decimal("1.000")
        if (
            exact_match
            and not floor_conflict
            and address_coords.sizes_close(
                a.m2_built, b.m2_built, photo_hash.PHOTO_MERGE_SIZE_RATIO
            )
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

    return fuzzy.evaluate(a, b)


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
    if had_conflict:
        result.conflicts += 1
    return survivor_id, losing_id


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

    with conn.cursor() as cur:
        skip_pairs, pending_by_pair = _load_recorded_pairs(cur)
        for i in range(len(listings)):
            for j in range(i + 1, len(listings)):
                a, b = listings[i], listings[j]
                if a.property_id == b.property_id:
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
                evaluation = evaluate_pair(a, b, hash_cache)

                if pending is not None:
                    merge_ids = _reevaluate_pending_suggestion(
                        conn, a, b, pending, evaluation, result
                    )
                    if merge_ids is not None:
                        survivor_id, losing_id = merge_ids
                        listings = [
                            dataclasses.replace(rec, property_id=survivor_id)
                            if rec.property_id == losing_id
                            else rec
                            for rec in listings
                        ]
                    continue

                if evaluation is None:
                    continue

                if evaluation.decision == "merge":
                    survivor_id, losing_id, had_conflict = perform_merge(
                        conn, a, b, evaluation
                    )
                    result.merged += 1
                    if had_conflict:
                        result.conflicts += 1
                    listings = [
                        dataclasses.replace(rec, property_id=survivor_id)
                        if rec.property_id == losing_id
                        else rec
                        for rec in listings
                    ]
                else:
                    file_suggestion(conn, a, b, evaluation)
                    result.suggested += 1

    if result.reevaluated_total:
        logger.info(
            "dedup: re-evaluated %d pending suggestion(s) against current "
            "rules (issue #214) — %d merged, %d rejected, %d still pending "
            "(refreshed in place)",
            result.reevaluated_total,
            result.reevaluated_merged,
            result.reevaluated_rejected,
            result.reevaluated_updated,
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
