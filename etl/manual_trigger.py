"""Runs ad-hoc connector sweeps requested from the dashboard (issue #244).

The owner wants to click "Ejecutar ahora" — after fixing a connector, after
tweaking a filter, or just to check something — without a shell on the
machine running the stack. `POST /api/etl/run` writes an `etl_manual_trigger`
row; this module polls that table and runs the requested work.

Same "why a queue table, not a synchronous HTTP call" reasoning as
`etl/capture.py` and `etl/dedup/actions.py` (see their module docstrings):
the dashboard (Node/TypeScript) and this orchestrator (Python) run in
separate containers with no shared filesystem or RPC channel, so the
dashboard can only ever *signal* a run — never call `run_all_connectors`
in-process. `run_manual_trigger_poll_loop` is polled on a short interval by
`etl/main.py` — separate from the hourly connector sweep
(etl.orchestrator.run_scheduler_loop), since an operator waiting on a button
shouldn't wait up to an hour for the next scheduled sweep.

Concurrency (issue #244). Two guards compose, in this order:

  1. **Run lock** — before claiming anything, this acquires the project-wide
     connector-run advisory lock (etl.db.postgres.RUN_ADVISORY_LOCK_ID). The
     scheduler loop holds the same lock for the duration of its sweep, so a
     manual trigger that arrives mid-sweep simply leaves the pending row
     untouched and retries on the next poll — it never runs a second sweep
     concurrently with the scheduled one (which would double-write the same
     listings). This is the lock the source project's
     `try_acquire_run_lock` docstring already anticipated ("another scheduler
     instance, a parallel manual trigger").
  2. **Row claim** — `FOR UPDATE SKIP LOCKED` on the oldest pending row, so
     two poll processes (a theoretical second ETL container) never both
     claim the same trigger. The run lock already serialises them, but the
     SKIP LOCKED claim is correct independently and is the layer issue #244
     asks to prove.

A UI-triggered ad-hoc run is a deliberate operator action, so — like
`ps connector run <name>` — it calls `run_all_connectors` **directly**, never
`run_all_connectors_respecting_restart_guard` (D-009's restart-burst guard is
for unattended crash-loops, not a human pressing a button).
"""

from __future__ import annotations

import logging
import time

from etl.db import postgres

logger = logging.getLogger("etl.manual_trigger")

# Default bounded lifetime of an ad-hoc manual-trigger run, in seconds (D-068).
# Mirrors etl.config._get_manual_trigger_max_runtime_seconds' default so the
# reconciler has a sane threshold even on the direct call paths (tests, the
# --once drain) that don't thread a Config value through. Matches D-036's dedup
# threshold: a manual trigger runs a full run_all_connectors sweep that itself
# includes a dedup pass, so 2h sits comfortably above the longest realistic run.
_DEFAULT_MANUAL_TRIGGER_MAX_RUNTIME_SECONDS = 7200


def reconcile_orphaned_manual_triggers(
    conn, max_runtime_seconds: int = _DEFAULT_MANUAL_TRIGGER_MAX_RUNTIME_SECONDS
) -> int:
    """Mark dead `etl_manual_trigger` rows stuck at status='running' as failed (D-068).

    A manual trigger whose process is SIGKILLed / restarted / OOM-killed
    *between* claiming the row (the commit to status='running' in
    `_claim_pending_trigger`) and marking it done never gets its finishing
    UPDATE, so the row stays at status='running' with finished_at=NULL
    *forever* — nothing else transitions it, and `GET /api/etl/run?id=` reports
    a phantom "still running" run from a process that no longer exists. The
    single-pending partial index (`WHERE status='pending'`) means the orphan
    never re-runs, so this is non-breaking, but it misreports status
    indefinitely — the same gap D-036 closed for `dedup_runs`.

    **Age-based**, using `picked_up_at` (set to NOW() the instant the row flips
    to 'running') as the start marker — a natural, already-persisted heartbeat,
    so no new column is needed. Only rows whose `picked_up_at` is older than
    *max_runtime_seconds* are reconciled. This is the not-stomp-a-live-run
    safety: on the single-worker deployment the poll loop is single-threaded
    and runs one trigger to completion before polling again, so a genuinely
    in-flight run is never concurrently reconciled by the same thread; the age
    threshold is the belt-and-suspenders that also protects against a
    theoretical second poller. (Assumption noted: there is no per-run heartbeat
    column beyond `picked_up_at`, so a run that legitimately exceeds
    *max_runtime_seconds* while still alive is the residual exposure — the
    threshold is set well above the longest realistic sweep+dedup to avoid it,
    exactly as D-036 does for dedup.) `COALESCE(picked_up_at, requested_at)`
    guards the (never-observed) case of a 'running' row with a NULL
    `picked_up_at`.

    Idempotent — re-applied at ETL startup and at the start of every poll; a
    second pass over already-reconciled rows updates nothing. Returns the
    number of rows reconciled.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE etl_manual_trigger
               SET status = 'failed',
                   finished_at = NOW(),
                   error_msg = COALESCE(
                       error_msg,
                       'orphaned: still ''running'' after ' || %s ||
                       's (max manual-trigger runtime) with no active run — '
                       'reconciled as failed on startup/next-poll (D-068)'
                   )
             WHERE status = 'running'
               AND COALESCE(picked_up_at, requested_at)
                   < NOW() - make_interval(secs => %s)
            """,
            (max_runtime_seconds, max_runtime_seconds),
        )
        reconciled = cur.rowcount
    conn.commit()
    if reconciled:
        logger.warning(
            "Reconciled %d orphaned etl_manual_trigger row(s) stuck at "
            "status='running' past the %ds max-runtime (likely a crashed/killed "
            "prior process) — marked 'failed' with an explanatory error_msg (D-068)",
            reconciled,
            max_runtime_seconds,
        )
    return reconciled


def _claim_pending_trigger(conn) -> tuple[int, str | None] | None:
    """Claim the oldest pending trigger, flipping it to 'running'.

    Returns `(trigger_id, connector_name)` — `connector_name` is None for a
    full sweep (every enabled connector) — or None when nothing is pending.
    `FOR UPDATE SKIP LOCKED` means two concurrent pollers never claim the
    same row: the loser's subquery skips the locked row and finds nothing.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE etl_manual_trigger
                SET status = 'running', picked_up_at = NOW()
                WHERE id = (
                    SELECT id FROM etl_manual_trigger
                    WHERE status = 'pending'
                    ORDER BY requested_at, id
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING id, connector_name
                """
            )
            row = cur.fetchone()
        conn.commit()
        if row is None:
            return None
        return int(row[0]), row[1]
    except Exception:
        conn.rollback()
        raise


def _mark_done(conn, trigger_id: int, connector_run_id: int | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE etl_manual_trigger "
            "SET status = 'done', connector_run_id = %s, finished_at = NOW(), "
            "    error_msg = NULL "
            "WHERE id = %s",
            (connector_run_id, trigger_id),
        )
    conn.commit()


def _mark_failed(conn, trigger_id: int, error_msg: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE etl_manual_trigger "
            "SET status = 'failed', error_msg = %s, finished_at = NOW() "
            "WHERE id = %s",
            (error_msg, trigger_id),
        )
    conn.commit()
    logger.warning("etl_manual_trigger id=%s: failed — %s", trigger_id, error_msg)


def process_pending_trigger(
    conn,
    max_runtime_seconds: int = _DEFAULT_MANUAL_TRIGGER_MAX_RUNTIME_SECONDS,
) -> int | None:
    """Claim and run one pending manual trigger, if any and if free to run.

    Returns the processed trigger id (done or failed), or None when there was
    nothing to do OR a connector run already holds the run lock (in which case
    the pending row is deliberately left untouched for the next poll — see the
    module docstring's concurrency note).

    Lazy import of `etl.orchestrator` (matching etl/capture.py): the
    orchestrator imports etl.connectors, which imports the orchestrator back
    inside register_all(), so a top-level import here risks that cycle.
    """
    # Orphan reconciliation (D-068): before doing anything, clean up any dead
    # 'running' row left behind by a crashed/killed prior process, so a wedged
    # orphan never misreports "still running" to the dashboard. Age-based, and
    # this thread is the single poller, so a genuinely in-flight run is never
    # touched. Best-effort: a reconcile failure must not block the poll.
    try:
        reconcile_orphaned_manual_triggers(conn, max_runtime_seconds)
    except Exception:
        logger.exception(
            "Orphaned manual-trigger reconciliation failed — continuing this "
            "poll; the next poll reconciles again (D-068)"
        )
        conn.rollback()

    # Guard 1: never overlap a scheduled/other sweep. Acquire BEFORE claiming
    # so a trigger that can't run right now stays pending rather than getting
    # stuck at 'running' behind a sweep we're not allowed to start.
    if not postgres.try_acquire_run_lock(conn):
        logger.info(
            "Manual trigger poll: a connector run already holds the run lock — "
            "leaving any pending trigger for the next poll rather than running a "
            "second sweep concurrently."
        )
        return None
    try:
        claimed = _claim_pending_trigger(conn)
        if claimed is None:
            return None
        trigger_id, connector_name = claimed

        from etl import orchestrator

        try:
            run_id = orchestrator.run_all_connectors(
                conn, trigger="manual", connector_name=connector_name
            )
        except orchestrator.UnknownConnectorError as exc:
            # An operator/UI naming a connector that isn't registered (a typo,
            # or a connector removed since the trigger was queued). Expected,
            # human-readable — recorded so the dashboard can show *why*.
            conn.rollback()
            _mark_failed(conn, trigger_id, str(exc))
            return trigger_id
        except Exception as exc:
            # Any other failure inside the sweep. Caught so one bad run can't
            # wedge this poll loop; recorded with the message and logged with a
            # traceback since it is NOT an expected outcome.
            conn.rollback()
            logger.exception(
                "etl_manual_trigger id=%s: unexpected error during sweep",
                trigger_id,
            )
            _mark_failed(conn, trigger_id, f"Unexpected internal error: {exc}")
            return trigger_id

        _mark_done(conn, trigger_id, run_id)
        logger.info(
            "etl_manual_trigger id=%s: ran %s -> connector_run_id=%s",
            trigger_id,
            f"connector {connector_name!r}" if connector_name else "full sweep",
            run_id,
        )
        return trigger_id
    finally:
        postgres.release_run_lock(conn)


def run_manual_trigger_poll_loop(
    conn_factory,
    interval_seconds: int = 10,
    max_runtime_seconds: int = _DEFAULT_MANUAL_TRIGGER_MAX_RUNTIME_SECONDS,
) -> None:
    """Poll `etl_manual_trigger` on a short interval, forever.

    Its own thread (see etl/main.py), on a much shorter interval than the
    hourly scheduler, with the same "one bad iteration shouldn't kill the
    loop" isolation as etl.capture.run_capture_poll_loop. Each poll first
    reconciles any orphaned 'running' row older than *max_runtime_seconds*
    (D-068).
    """
    while True:
        conn = conn_factory()
        try:
            trigger_id = process_pending_trigger(conn, max_runtime_seconds)
            if trigger_id is not None:
                logger.info("Processed manual trigger id=%s", trigger_id)
        except Exception:
            logger.exception(
                "process_pending_trigger failed for this poll iteration — "
                "will retry next interval rather than exit"
            )
        finally:
            conn.close()
        time.sleep(interval_seconds)
