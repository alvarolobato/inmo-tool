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

Restoration snapshot (issue #16 EC-5's "revert" requirement, hardened after
Opus review of PR #55: the original version restored listing.property_id
pointers only, silently losing pre-merge profile_listing_state/feedback_event
data on every revert even with zero post-merge activity — an actual data-loss
bug on a revert operation, not a documented limitation worth accepting).
`reconcile_merge` returns a JSON-serializable snapshot describing exactly
what it changed, which the caller persists onto property_merge_log.detail;
etl.dedup.engine.revert reads it back to undo those changes specifically,
rather than reconstructing state by guesswork. Shape:

    {
        "profile_listing_state_ops": [
            {"profile_id": int, "kind": "rekeyed_no_prior_survivor_state"},
            {"profile_id": int, "kind": "identical_stage_dropped",
             "losing_row": {...}, "survivor_before": {...}},
            {"profile_id": int, "kind": "conflict_dropped",
             "losing_row": {...}, "survivor_before": {...}},
            {"profile_id": int, "kind": "stage_reconciled",
             "losing_row": {...}, "survivor_before": {...}},
        ],
        "rekeyed_feedback_event_ids": [int, ...],
    }

Every kind except `rekeyed_no_prior_survivor_state` carries `survivor_before`:
all three merge branches null the survivor's score/rank_explanation/
last_scored_at (its underlying property identity changed via merge, so a
stale score computed pre-merge is no longer trustworthy, regardless of
which branch handled the pipeline_stage side of reconciliation), so all
three need to restore it on revert.

Every "losing_row"/"survivor_before" dict has the same shape: score (str or
None — NUMERIC serialized as string to survive the JSON round-trip exactly,
not as a Python float), rank_explanation, pipeline_stage, notes,
last_scored_at (ISO string or None).

Documented limitation that *is* still real and worth stating plainly: this
snapshot captures the state reconcile_merge changed at merge time. If new
feedback/scoring activity happens on the *survivor* property after the merge
but before a revert, that new activity is not retroactively un-mixed — it
stays on the survivor. What this fixes is the previously-silent loss of
state that existed *before* the merge, with zero post-merge activity, which
is the common case revert should be reliable for.
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

_PLS_COLUMNS = (
    "score",
    "rank_explanation",
    "pipeline_stage",
    "notes",
    "last_scored_at",
)


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


def _serialize_pls_row(row: tuple) -> dict:
    """Snapshot a profile_listing_state row (score, rank_explanation,
    pipeline_stage, notes, last_scored_at, matched) into a JSON-safe dict.

    score is NUMERIC -> Decimal from psycopg2; stored as str so revert can
    round-trip it exactly via Decimal(str(...)) rather than through a lossy
    float. last_scored_at is a datetime -> isoformat string, or None.

    `matched` (task 2.4, issue #18) was added after this module was first
    written — included here so revert restores it correctly instead of
    leaving whatever value the merge's own reconciliation happened to set.
    """
    score, rank_explanation, pipeline_stage, notes, last_scored_at, matched = row
    return {
        "score": str(score) if score is not None else None,
        "rank_explanation": rank_explanation,
        "pipeline_stage": pipeline_stage,
        "notes": notes,
        "last_scored_at": last_scored_at.isoformat() if last_scored_at else None,
        "matched": matched,
    }


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
) -> tuple[bool, dict]:
    """Reconcile profile_listing_state/feedback_event after a property merge.

    Returns (had_conflict, snapshot) — had_conflict is True if a genuine
    conflict was found and flagged (for the caller to surface in
    connector_run_results / CLI output — a conflict doesn't fail the run, it
    just means a human needs to look at suggested_merge afterward). snapshot
    is the JSON-serializable restoration record described in this module's
    docstring, for the caller to persist onto property_merge_log.detail.
    """
    any_conflict = False
    pls_ops: list[dict] = []

    with conn.cursor() as cur:
        # feedback_event is append-only with no uniqueness constraint on
        # property_id — reassigning is always safe, no reconciliation logic
        # needed, regardless of whether profile_listing_state conflicts.
        # Snapshot which rows moved (by id) so revert can point them back.
        cur.execute(
            "SELECT id FROM feedback_event WHERE property_id = %s",
            (losing_property_id,),
        )
        rekeyed_feedback_event_ids = [row[0] for row in cur.fetchall()]
        cur.execute(
            "UPDATE feedback_event SET property_id = %s WHERE property_id = %s",
            (survivor_property_id, losing_property_id),
        )

        cur.execute(
            "SELECT profile_id, score, rank_explanation, pipeline_stage, notes, "
            "last_scored_at, matched FROM profile_listing_state WHERE property_id = %s",
            (losing_property_id,),
        )
        losing_rows = cur.fetchall()

        for losing_row in losing_rows:
            profile_id = losing_row[0]
            losing_stage = losing_row[3]
            losing_matched = losing_row[6]
            losing_snapshot = _serialize_pls_row(losing_row[1:])

            cur.execute(
                "SELECT score, rank_explanation, pipeline_stage, notes, last_scored_at, "
                "matched FROM profile_listing_state WHERE property_id = %s AND profile_id = %s",
                (survivor_property_id, profile_id),
            )
            survivor_row = cur.fetchone()

            if survivor_row is None:
                # No existing state on the surviving property for this
                # profile — simple re-key, nothing to reconcile. Revert
                # just needs to point property_id back at the losing side.
                cur.execute(
                    "UPDATE profile_listing_state SET property_id = %s "
                    "WHERE property_id = %s AND profile_id = %s",
                    (survivor_property_id, losing_property_id, profile_id),
                )
                pls_ops.append(
                    {
                        "profile_id": profile_id,
                        "kind": "rekeyed_no_prior_survivor_state",
                    }
                )
                continue

            survivor_stage = survivor_row[2]
            survivor_matched = survivor_row[5]
            # Combine matched with OR on merge: if either side currently
            # satisfies its profile's hard-filter scope, the merged property
            # should too — the properties being merged are, by definition,
            # the same real-world unit, so whichever side's data happened to
            # pass the filter is evidence the merged identity qualifies.
            merged_matched = bool(survivor_matched) or bool(losing_matched)

            if survivor_stage == losing_stage:
                # Identical stage on both sides — drop the now-redundant
                # losing row. Still null score/rank_explanation/
                # last_scored_at on the survivor: its underlying property
                # identity just changed via merge, so a stale score computed
                # against only the pre-merge property is no longer
                # trustworthy, regardless of which reconciliation branch
                # handled the stage. Consistent with the stage_reconciled
                # branch below (Opus review, PR #55 — previously only that
                # branch nulled the score, an inconsistency with no reason
                # behind it). Snapshot the survivor's pre-null values so
                # revert can restore them.
                survivor_snapshot = _serialize_pls_row(survivor_row)
                cur.execute(
                    "UPDATE profile_listing_state "
                    "SET score = NULL, rank_explanation = NULL, last_scored_at = NULL, "
                    "matched = %s "
                    "WHERE property_id = %s AND profile_id = %s",
                    (merged_matched, survivor_property_id, profile_id),
                )
                cur.execute(
                    "DELETE FROM profile_listing_state "
                    "WHERE property_id = %s AND profile_id = %s",
                    (losing_property_id, profile_id),
                )
                pls_ops.append(
                    {
                        "profile_id": profile_id,
                        "kind": "identical_stage_dropped",
                        "losing_row": losing_snapshot,
                        "survivor_before": survivor_snapshot,
                    }
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
                # leave the survivor's *stage* untouched (don't let either
                # side silently overwrite the other's pipeline progress) and
                # drop the losing row; both original stage values remain
                # inspectable via the conflict record above rather than as
                # two live table rows, which the schema has no way to
                # represent. Score/rank_explanation/last_scored_at ARE
                # nulled though, same reasoning as identical_stage_dropped
                # above — the property identity changed regardless of the
                # stage conflict. Revert re-inserts the losing row and
                # restores the survivor's pre-null score.
                survivor_snapshot = _serialize_pls_row(survivor_row)
                cur.execute(
                    "UPDATE profile_listing_state "
                    "SET score = NULL, rank_explanation = NULL, last_scored_at = NULL, "
                    "matched = %s "
                    "WHERE property_id = %s AND profile_id = %s",
                    (merged_matched, survivor_property_id, profile_id),
                )
                cur.execute(
                    "DELETE FROM profile_listing_state "
                    "WHERE property_id = %s AND profile_id = %s",
                    (losing_property_id, profile_id),
                )
                pls_ops.append(
                    {
                        "profile_id": profile_id,
                        "kind": "conflict_dropped",
                        "losing_row": losing_snapshot,
                        "survivor_before": survivor_snapshot,
                    }
                )
                continue

            # Not a genuine conflict: keep whichever stage is more advanced,
            # drop the losing row, and null out score/rank_explanation so a
            # future scoring pass recomputes fresh rather than either side's
            # stale value surviving by accident. Snapshot the survivor's
            # pre-reconciliation values so revert can restore them exactly
            # (its identity is what's changing here, via merge, so its
            # in-flight score/stage are as much "pre-merge state" as the
            # losing side's is).
            survivor_snapshot = _serialize_pls_row(survivor_row)
            if _STAGE_RANK[losing_stage] > _STAGE_RANK[survivor_stage]:
                cur.execute(
                    "UPDATE profile_listing_state SET pipeline_stage = %s "
                    "WHERE property_id = %s AND profile_id = %s",
                    (losing_stage, survivor_property_id, profile_id),
                )
            cur.execute(
                "UPDATE profile_listing_state "
                "SET score = NULL, rank_explanation = NULL, last_scored_at = NULL, "
                "matched = %s "
                "WHERE property_id = %s AND profile_id = %s",
                (merged_matched, survivor_property_id, profile_id),
            )
            cur.execute(
                "DELETE FROM profile_listing_state "
                "WHERE property_id = %s AND profile_id = %s",
                (losing_property_id, profile_id),
            )
            pls_ops.append(
                {
                    "profile_id": profile_id,
                    "kind": "stage_reconciled",
                    "losing_row": losing_snapshot,
                    "survivor_before": survivor_snapshot,
                }
            )

    snapshot = {
        "profile_listing_state_ops": pls_ops,
        "rekeyed_feedback_event_ids": rekeyed_feedback_event_ids,
    }
    return any_conflict, snapshot
