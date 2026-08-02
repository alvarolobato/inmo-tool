"""Merge-time reconciliation of per-profile state (issue #16 item 6, EC-6/EC-7).

Called by etl.dedup.engine.perform_merge, inside the same transaction as the
listing.property_id reassignment — a merge and its reconciliation commit
together or not at all.

Schema constraint driving this module's design: profile_listing_state's
PRIMARY KEY (profile_id, property_id) means there can never be two live rows
for the same (profile, property) pair. When two properties that each had
their own state for the same profile get merged, *something* has to give —
this module's job is making sure that's a deliberate, documented choice
(reassign / keep-more-advanced / flag-and-park-in-suggested_merge) rather
than an ON CONFLICT clause silently picking whichever row happened to write
last.
"""

from __future__ import annotations

import json
from decimal import Decimal

_STAGE_RANK = {
    "new": 0,
    "reviewing": 1,
    "interested": 2,
    "contacted": 3,
    "visited": 4,
    "offer_made": 5,
    "closed": 6,
    "rejected": 6,  # terminal, treated as equally "most advanced" as closed
}


def _is_genuine_conflict(stage_a: str, stage_b: str) -> bool:
    """True only for the case issue #16 actually calls out: a 'rejected'
    decision on one side against *real engagement* on the other.

    'rejected' vs 'new' isn't a genuine conflict — 'new' means no human has
    acted on that side at all yet, so there's nothing to contradict. Any
    other stage paired with 'rejected' (reviewing through closed) means a
    human explicitly passed on one side while the other shows real
    progress — that contradiction is exactly EC-7's "accepted in one,
    rejected in the other" example, generalized.
    """
    stages = {stage_a, stage_b}
    if "rejected" not in stages:
        return False
    other = stages - {"rejected"}
    if not other:
        return False  # both sides rejected — not a conflict
    return next(iter(other)) != "new"


def _read_detail(row_detail) -> dict:
    if row_detail is None:
        return {}
    if isinstance(row_detail, dict):
        return row_detail
    return json.loads(row_detail)


def _record_conflict(
    cur,
    listing_id_a: int,
    listing_id_b: int,
    basis: str,
    confidence: Decimal,
    conflict_detail: dict,
) -> None:
    """Insert or append-and-update a status='conflict' suggested_merge row.

    Appends to an existing row's detail (rather than overwriting) so that if
    more than one profile conflicts for the same merged pair, earlier
    conflicts aren't silently lost — see module docstring.
    """
    lo, hi = sorted((listing_id_a, listing_id_b))
    cur.execute(
        "SELECT detail FROM suggested_merge WHERE listing_id_a = %s AND listing_id_b = %s",
        (lo, hi),
    )
    row = cur.fetchone()
    if row is None:
        detail = {"conflicts": [conflict_detail]}
        cur.execute(
            """
            INSERT INTO suggested_merge
                (listing_id_a, listing_id_b, match_basis, confidence, status, detail)
            VALUES (%s, %s, %s, %s, 'conflict', %s)
            """,
            (lo, hi, basis, confidence, json.dumps(detail)),
        )
        return

    existing = _read_detail(row[0])
    conflicts = existing.get("conflicts", [])
    conflicts.append(conflict_detail)
    cur.execute(
        "UPDATE suggested_merge SET status = 'conflict', detail = %s "
        "WHERE listing_id_a = %s AND listing_id_b = %s",
        (json.dumps({**existing, "conflicts": conflicts}), lo, hi),
    )


def reconcile_merge(
    conn,
    survivor_property_id: int,
    losing_property_id: int,
    *,
    listing_id_a: int,
    listing_id_b: int,
    match_basis: str,
    match_confidence: Decimal,
) -> bool:
    """Reconcile profile_listing_state/feedback_event after a property merge.

    Returns True if a genuine conflict was found and flagged (for the
    caller to surface in connector_run_results / CLI output — a conflict
    doesn't fail the run, it just means a human needs to look at
    suggested_merge afterward).
    """
    any_conflict = False

    with conn.cursor() as cur:
        # feedback_event is append-only with no uniqueness constraint on
        # property_id — reassigning is always safe, no reconciliation logic
        # needed, regardless of whether profile_listing_state conflicts.
        cur.execute(
            "UPDATE feedback_event SET property_id = %s WHERE property_id = %s",
            (survivor_property_id, losing_property_id),
        )

        cur.execute(
            "SELECT profile_id, pipeline_stage FROM profile_listing_state "
            "WHERE property_id = %s",
            (losing_property_id,),
        )
        losing_rows = cur.fetchall()

        for profile_id, losing_stage in losing_rows:
            cur.execute(
                "SELECT pipeline_stage FROM profile_listing_state "
                "WHERE property_id = %s AND profile_id = %s",
                (survivor_property_id, profile_id),
            )
            survivor_row = cur.fetchone()

            if survivor_row is None:
                # No existing state on the surviving property for this
                # profile — simple re-key, nothing to reconcile.
                cur.execute(
                    "UPDATE profile_listing_state SET property_id = %s "
                    "WHERE property_id = %s AND profile_id = %s",
                    (survivor_property_id, losing_property_id, profile_id),
                )
                continue

            survivor_stage = survivor_row[0]

            if survivor_stage == losing_stage:
                # Identical stage on both sides — drop the now-redundant
                # losing row, nothing else to do.
                cur.execute(
                    "DELETE FROM profile_listing_state "
                    "WHERE property_id = %s AND profile_id = %s",
                    (losing_property_id, profile_id),
                )
                continue

            if _is_genuine_conflict(survivor_stage, losing_stage):
                any_conflict = True
                _record_conflict(
                    cur,
                    listing_id_a,
                    listing_id_b,
                    match_basis,
                    match_confidence,
                    {
                        "profile_id": profile_id,
                        "survivor_property_id": survivor_property_id,
                        "survivor_stage": survivor_stage,
                        "losing_property_id": losing_property_id,
                        "losing_stage": losing_stage,
                    },
                )
                # The PK can't hold two rows for (profile_id, survivor_id) —
                # leave the survivor's row untouched (don't let either side
                # silently overwrite the other) and drop the losing row; both
                # original stage values remain inspectable via the conflict
                # record above rather than as two live table rows, which the
                # schema has no way to represent.
                cur.execute(
                    "DELETE FROM profile_listing_state "
                    "WHERE property_id = %s AND profile_id = %s",
                    (losing_property_id, profile_id),
                )
                continue

            # Not a genuine conflict: keep whichever stage is more advanced,
            # drop the losing row, and null out score/rank_explanation so a
            # future scoring pass recomputes fresh rather than either side's
            # stale value surviving by accident.
            if _STAGE_RANK[losing_stage] > _STAGE_RANK[survivor_stage]:
                cur.execute(
                    "UPDATE profile_listing_state SET pipeline_stage = %s "
                    "WHERE property_id = %s AND profile_id = %s",
                    (losing_stage, survivor_property_id, profile_id),
                )
            cur.execute(
                "UPDATE profile_listing_state "
                "SET score = NULL, rank_explanation = NULL, last_scored_at = NULL "
                "WHERE property_id = %s AND profile_id = %s",
                (survivor_property_id, profile_id),
            )
            cur.execute(
                "DELETE FROM profile_listing_state "
                "WHERE property_id = %s AND profile_id = %s",
                (losing_property_id, profile_id),
            )

    return any_conflict
