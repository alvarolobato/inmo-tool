"""Processes dashboard-originated review-queue actions on `suggested_merge`.

The missing half of the dedup workflow: `engine.confirm_suggestion()` and
`engine.reject_suggestion()` existed and were CLI-callable (`ps dedup
confirm/reject <id>`) well before this module, but nothing in the dashboard
could reach them — a real run filed 585 `suggested_merge` rows for human
review and there was no UI anywhere that could act on one.

Same "why a queue table, not a synchronous call" reasoning as
`etl/capture.py` (see its module docstring): the dashboard (Node/TypeScript)
and this engine (Python) run in separate containers with no shared
filesystem or RPC channel, so the dashboard can only ever *signal* a
confirm/reject — never call `confirm_suggestion`/`reject_suggestion`
in-process. `dashboard/app/api/dedup/suggestions/[id]/confirm|reject` insert
a `suggested_merge_action` row; `process_pending_actions` (polled on a short
interval by `run_action_poll_loop`, started in etl/main.py alongside the
extension-capture poll thread) drains it by calling the *real*
`engine.confirm_suggestion`/`reject_suggestion` — never a second,
reimplemented merge path in TypeScript.
"""

from __future__ import annotations

import json
import logging
import time

from etl.dedup import engine

logger = logging.getLogger("etl.dedup.actions")

_BATCH_LIMIT = 20


def _mark_done(conn, action_id: int, result: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE suggested_merge_action "
            "SET status = 'done', result = %s::jsonb, processed_at = NOW() "
            "WHERE id = %s",
            (json.dumps(result), action_id),
        )
    conn.commit()


def _mark_failed(conn, action_id: int, error_msg: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE suggested_merge_action "
            "SET status = 'failed', error_msg = %s, processed_at = NOW() "
            "WHERE id = %s",
            (error_msg, action_id),
        )
    conn.commit()
    logger.warning("suggested_merge_action id=%s: failed — %s", action_id, error_msg)


def _process_one(conn, action_id: int, suggestion_id: int, action: str) -> None:
    if action == "confirm":
        survivor_id, losing_id, had_conflict = engine.confirm_suggestion(
            conn, suggestion_id
        )
        _mark_done(
            conn,
            action_id,
            {
                "survivor_property_id": survivor_id,
                "losing_property_id": losing_id,
                "had_conflict": had_conflict,
            },
        )
    elif action == "reject":
        engine.reject_suggestion(conn, suggestion_id)
        _mark_done(conn, action_id, {})
    elif action == "reject_pair":
        rejected_count = engine.reject_property_pair(conn, suggestion_id)
        _mark_done(conn, action_id, {"rejected_count": rejected_count})
    else:  # pragma: no cover — the action CHECK constraint already excludes this
        raise ValueError(
            f"Unknown action {action!r} for suggested_merge_action id={action_id}"
        )


def process_pending_actions(conn, limit: int = _BATCH_LIMIT) -> int:
    """Process every pending `suggested_merge_action` row, oldest first.

    Returns the count processed (done + failed). Each row is its own
    try/except — one bad request (a suggestion already resolved by a
    concurrent CLI `ps dedup confirm`, a stale/deleted listing) must not
    block the rest of the batch or wedge this poll loop, same isolation
    discipline as `etl.capture.process_pending_captures`.

    A `ValueError` from `confirm_suggestion`/`reject_suggestion` is a real,
    expected business-rule refusal (already confirmed, already rejected, a
    'conflict' row that needs `resolve-conflict` instead) — recorded as
    `status='failed'` with the human-readable message so the dashboard can
    show *why*, not a bug. Any other exception is also caught (so it can't
    take down the poll loop) but logged with a full traceback, since it is
    NOT an expected outcome.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, suggestion_id, action FROM suggested_merge_action "
            "WHERE status = 'pending' ORDER BY created_at LIMIT %s",
            (limit,),
        )
        pending = cur.fetchall()

    processed = 0
    for action_id, suggestion_id, action in pending:
        try:
            _process_one(conn, action_id, suggestion_id, action)
        except ValueError as exc:
            conn.rollback()
            _mark_failed(conn, action_id, str(exc))
        except Exception as exc:
            conn.rollback()
            logger.exception(
                "suggested_merge_action id=%s: unexpected error, marking failed",
                action_id,
            )
            _mark_failed(conn, action_id, f"Unexpected internal error: {exc}")
        processed += 1
    return processed


def run_action_poll_loop(conn_factory, interval_seconds: int = 3) -> None:
    """Poll `suggested_merge_action` on a short interval, forever.

    An operator sitting in the review-queue UI clicking "Confirmar"/
    "Rechazar" should not wait up to an hour for the next connector sweep
    (etl.orchestrator.run_scheduler_loop) — this runs on its own much
    shorter interval, in its own thread (see etl/main.py), with the same
    "one bad iteration shouldn't kill the loop" isolation as
    etl.capture.run_capture_poll_loop.
    """
    while True:
        conn = conn_factory()
        try:
            count = process_pending_actions(conn)
            if count:
                logger.info("Processed %d pending suggested_merge_action(s)", count)
        except Exception:
            logger.exception(
                "process_pending_actions failed for this poll iteration — "
                "will retry next interval rather than exit"
            )
        finally:
            conn.close()
        time.sleep(interval_seconds)
