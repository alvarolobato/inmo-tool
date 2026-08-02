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
"""

from __future__ import annotations

import dataclasses
import json
import logging
from dataclasses import dataclass
from decimal import Decimal

from etl.dedup import reconcile
from etl.dedup.signals import (
    address_coords,
    cadastral,
    fuzzy,
    phone_extract,
    photo_hash,
)
from etl.dedup.types import ListingRecord, PairEvaluation

logger = logging.getLogger("etl.dedup.engine")


@dataclass
class DedupRunResult:
    pairs_compared: int = 0
    merged: int = 0
    suggested: int = 0
    conflicts: int = 0


def fetch_listing_records(conn) -> list[ListingRecord]:
    """Fetch every listing joined with its property row.

    No status filter — a withdrawn listing on one site duplicating an
    active one on another is still the same property and still worth
    merging (its price/status history has value regardless of its current
    status), so this intentionally doesn't restrict to status='active'.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT l.id, l.property_id, l.source, l.external_id, l.listing_kind,
                   l.description, l.photo_urls,
                   p.cadastral_ref, p.address, p.lat, p.lon, p.m2_built,
                   l.current_price
              FROM listing l
              JOIN property p ON p.id = l.property_id
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
        )
        for row in rows
    ]


class _PhotoHashCache:
    """Fetches and memoizes each listing's photo hashes at most once per run."""

    def __init__(self) -> None:
        self._cache: dict[int, list] = {}

    def get(self, listing: ListingRecord) -> list:
        if listing.listing_id not in self._cache:
            self._cache[listing.listing_id] = photo_hash.fetch_hashes(
                listing.photo_urls
            )
        return self._cache[listing.listing_id]


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
    ):
        result = evaluate_fn(a, b)
        if result is not None:
            return result

    hashes_a = hash_cache.get(a)
    hashes_b = hash_cache.get(b)
    ratio = photo_hash.match_ratio(hashes_a, hashes_b)
    if ratio is not None and Decimal(str(ratio)) >= photo_hash.MIN_MATCH_RATIO:
        return PairEvaluation(
            basis="photo_hash",
            confidence=photo_hash.confidence_for_ratio(ratio),
            decision="suggest",
            detail={"match_ratio": round(ratio, 3)},
        )

    return fuzzy.evaluate(a, b)


def _pair_already_recorded(cur, listing_id_a: int, listing_id_b: int) -> bool:
    lo, hi = sorted((listing_id_a, listing_id_b))
    cur.execute(
        "SELECT 1 FROM suggested_merge WHERE listing_id_a = %s AND listing_id_b = %s",
        (lo, hi),
    )
    return cur.fetchone() is not None


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


def run(conn) -> DedupRunResult:
    """Compare every not-yet-merged listing pair and act on the result.

    A listing's in-memory property_id is updated after every merge (not
    re-fetched from the DB) so that a third listing sharing a property with
    either side of an earlier merge in the *same run* is correctly treated
    as already-unified in later iterations, without a full re-query.
    """
    listings = fetch_listing_records(conn)
    hash_cache = _PhotoHashCache()
    result = DedupRunResult()

    with conn.cursor() as cur:
        for i in range(len(listings)):
            for j in range(i + 1, len(listings)):
                a, b = listings[i], listings[j]
                if a.property_id == b.property_id:
                    continue
                if _pair_already_recorded(cur, a.listing_id, b.listing_id):
                    continue

                result.pairs_compared += 1
                evaluation = evaluate_pair(a, b, hash_cache)
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

    return result


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
