"""Self-healing staleness backstop for profile re-materialization (issue #285).

Every listing-ingest path is *supposed* to trigger a dashboard re-materialize
of all active profiles after it commits (D-044): the connector sweep
(`etl.orchestrator.run_all_connectors`, issue #94) and the browser-extension
capture drain (`etl.capture.process_pending_captures`, D-044/#269) both call
`etl.orchestrator.notify_materialize_all()`. But that notify is **best-effort
and swallowed** — a transient dashboard outage, or an unexpected raise in the
end-of-sweep bookkeeping *before* the notify runs, silently skips the
re-materialize, and nothing retries until the *next* ingest happens to succeed.
That is the likely real cause of the live "Pisos en Estepona" incident
(2026-08-05): a profile stranded at stale/0 data despite qualifying listings
sitting in the mirror, because a single notify was missed and never retried.

This module is the durable backstop. A sweep-independent poll loop
(`run_materialize_reconciler_poll_loop`, started as its own thread from
`etl/main.py`, same pattern as the capture / manual-trigger / worklist-seed
loops) periodically checks — cheaply, one SQL query — whether any active
profile is *stale*: its `search_profile.last_materialized_at` is older than the
newest listing ingest/seen timestamp in the mirror (or it has never been
materialized at all). If so, it fires the very same
`notify_materialize_all()` the ingest paths use — never re-implementing the
TypeScript materializer in Python (D-044). A missed notify therefore
self-heals within one tick.

Why "any listing newer than last_materialized_at" is the right staleness
signal, and why it's safe to check globally rather than per-profile scope:

  - `materializeAllProfiles` (the endpoint this fires) is idempotent and cheap
    (~30-70ms for every active profile at current scale — D-044), so a coarse
    "some listing is newer than some profile's last materialize" trigger that
    occasionally re-materializes a profile the newest listing didn't actually
    match costs almost nothing and is always correct. Re-implementing the
    profile's scope filter in Python to target only truly-affected profiles is
    exactly the cross-service duplication D-044 forbids.
  - The newest listing timestamp is `MAX(GREATEST(last_seen_at,
    last_fetched_at, first_seen_at))`. `last_seen_at` is bumped on every
    ingest AND every discover() (etl.orchestrator._update_last_seen_for_
    discovered), `first_seen_at` marks a brand-new listing, `last_fetched_at`
    a real detail re-fetch — GREATEST across the three catches every path a
    listing's data can change, and Postgres' GREATEST ignores NULLs.
  - In steady state (notify NOT missed) this never fires spuriously: after a
    successful ingest the notify runs and `materializeProfile` sets
    `last_materialized_at = NOW()`, which is >= every listing timestamp at
    that moment, so the next tick sees nothing stale. It only fires when a
    notify was genuinely skipped — precisely the failure it exists to heal.

Skip-while-a-sweep-is-running: a `connector_runs` row at status='running'
means a sweep is mid-flight and WILL fire its own end-of-sweep notify (now
hardened into a `finally` in `run_all_connectors`, issue #285). During a long
sweep `last_seen_at` is bumped incrementally while `last_materialized_at`
hasn't advanced yet, so an unguarded reconciler would fire a redundant
materialize on every tick for the whole sweep. Skipping while a sweep runs
leaves the reconciler as a pure *backstop* for the after-the-fact missed
notify (and for the capture path, which records no connector_runs row) without
racing the sweep's own notify. This is not sweep-*dependence* in the fragile
sense — it only ever defers to a mechanism that is itself firing.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

logger = logging.getLogger("etl.materialize_reconciler")

# Default poll cadence for the staleness reconciler, in seconds. A few minutes
# is the right order of magnitude: the check is a single indexed aggregate, and
# firing only happens when a notify was actually missed, so a short interval
# costs almost nothing yet bounds how long a stranded profile stays stale
# (the Estepona incident sat stale for ~13h before a human noticed). Overridable
# via ETL_MATERIALIZE_RECONCILER_INTERVAL_SECONDS / config
# etl.materialize_reconciler_interval_seconds.
_DEFAULT_INTERVAL_SECONDS = 120


def _sweep_in_progress(conn) -> bool:
    """True if a connector sweep is currently running (a connector_runs row at
    status='running').

    Such a sweep will fire its own end-of-sweep `notify_materialize_all` (in a
    `finally`, issue #285), so the reconciler defers to it rather than racing a
    redundant materialize every tick while `last_seen_at` is bumped mid-sweep.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM connector_runs WHERE status = 'running' LIMIT 1")
        return cur.fetchone() is not None


def _stale_profiles_exist(conn) -> bool:
    """True if any active profile's materialized state is behind the mirror.

    A profile is stale when it has never been materialized
    (`last_materialized_at IS NULL`) or when some listing's newest
    ingest/seen timestamp is more recent than its `last_materialized_at`.
    The newest listing timestamp is a single aggregate over `listing`
    (`MAX(GREATEST(last_seen_at, last_fetched_at, first_seen_at))`), so this is
    one cheap query regardless of profile count. Returns False when the mirror
    holds no listings AND every active profile has already been materialized —
    the true steady state where there is nothing to heal.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT EXISTS (
                SELECT 1
                FROM search_profile sp
                WHERE sp.archived_at IS NULL
                  AND (
                      sp.last_materialized_at IS NULL
                      OR sp.last_materialized_at < (
                          SELECT MAX(GREATEST(
                              l.last_seen_at, l.last_fetched_at, l.first_seen_at
                          ))
                          FROM listing l
                      )
                  )
            )
            """
        )
        row = cur.fetchone()
    return bool(row and row[0])


def reconcile_stale_profiles(
    conn,
    *,
    materialize_all: Callable[..., object] | None = None,
) -> bool:
    """One reconciler tick: if any active profile is stale, fire a
    materialize-all backstop. Returns True iff it fired.

    Deliberately does NOT run while a connector sweep is in progress (see
    `_sweep_in_progress`) — that sweep fires its own notify at completion.

    `materialize_all` defaults to `etl.orchestrator.notify_materialize_all`
    (the same HTTP POST every ingest path uses; lazily imported to avoid the
    orchestrator<->connectors import cycle and to keep this module importable
    without `requests`/a valid Config). It is injectable purely so tests can
    substitute a real-Postgres materialize stand-in for the cross-container
    HTTP call. Never re-implements the TypeScript materializer (D-044).

    Best-effort throughout: only SELECTs happen here, and the fired
    `notify_materialize_all` never raises. The read transaction is rolled back
    before firing so the (potentially slow) outbound HTTP call doesn't sit
    inside an idle-in-transaction snapshot.
    """
    if _sweep_in_progress(conn):
        conn.rollback()
        return False

    stale = _stale_profiles_exist(conn)
    # End the read transaction before the outbound call regardless — these were
    # read-only SELECTs, so rollback simply releases the snapshot.
    conn.rollback()
    if not stale:
        return False

    logger.info(
        "materialize reconciler: at least one active profile is stale "
        "(last_materialized_at behind the newest listing, or never "
        "materialized) — firing a materialize-all backstop. A notify was "
        "likely missed/failed on an ingest path (issue #285, D-046)."
    )
    if materialize_all is None:
        # Lazy import: etl.orchestrator imports etl.connectors, which imports
        # etl.orchestrator back inside register_all() — a top-level import here
        # risks that cycle (same reasoning as etl/capture.py's lazy import).
        from etl.orchestrator import notify_materialize_all

        materialize_all = notify_materialize_all

    materialize_all(trigger="reconciler")
    return True


def run_materialize_reconciler_poll_loop(
    conn_factory,
    interval_seconds: int = _DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Poll for stale profiles on a fixed interval, forever (issue #285).

    Its own thread (see etl/main.py), sweep-independent, with the same "one bad
    iteration must not kill the loop" isolation as
    etl.capture.run_capture_poll_loop and the other short-interval poll loops:
    a fresh connection per tick, every exception logged and swallowed so a
    transient DB blip just retries next interval instead of taking the thread
    (and its self-heal guarantee) down.
    """
    while True:
        conn = conn_factory()
        try:
            reconcile_stale_profiles(conn)
        except Exception:
            logger.exception(
                "materialize reconciler tick failed — will retry next interval "
                "rather than exit"
            )
        finally:
            # A fresh connection per tick (like the other poll loops), so
            # closing here discards any half-open transaction from a failed
            # tick — no explicit rollback needed.
            conn.close()
        time.sleep(interval_seconds)
