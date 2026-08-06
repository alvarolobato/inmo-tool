"""PostgreSQL connection and run-monitoring helpers for the ETL pipeline.

Transaction policy
------------------
All write helpers (create_run, finish_run, record_table_sync, the manual-trigger
helpers) commit on success and roll back on failure so the connection is always
left in a clean state. The advisory-lock helpers (try_acquire_run_lock,
release_run_lock) follow the same pattern.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from etl.config import Config


def get_connection(config: Config):
    """Return a psycopg2 connection with autocommit=False."""
    try:
        import psycopg2  # type: ignore[import-untyped]
    except ImportError as exc:
        raise ImportError(
            "psycopg2 package is not installed. Run: pip install psycopg2-binary"
        ) from exc

    conn = psycopg2.connect(config.postgres_dsn)
    conn.autocommit = False
    return conn


# ---------------------------------------------------------------------------
# Run monitoring helpers
# ---------------------------------------------------------------------------


def fail_orphan_running_runs(conn) -> int:
    """Mark every ``running`` row as ``failed`` (previous worker died or was replaced).

    Safe only when a single ETL worker is expected. Call once at process startup
    before ``create_run`` so restarts do not leave multiple ``running`` rows.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE etl_sync_runs
                   SET finished_at = NOW(),
                       status = 'failed',
                       duration_ms = COALESCE(
                           duration_ms,
                           (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
                       ),
                       tables_ok = COALESCE(tables_ok, 0),
                       tables_failed = GREATEST(COALESCE(tables_failed, 0), 1),
                       total_tables = COALESCE(
                           total_tables,
                           COALESCE(tables_ok, 0) + GREATEST(COALESCE(tables_failed, 0), 1)
                       )
                 WHERE status = 'running'
                """
            )
            n = cur.rowcount
        conn.commit()
        return int(n)
    except Exception:
        conn.rollback()
        raise


# Stable lock-ids used by try_acquire_run_lock. PostgreSQL advisory locks
# take a single bigint; these constants are just project-scoped magic numbers
# (opaque values — what matters is that each stays consistent across processes
# and never collides with any other advisory-lock user in the database).
#
# Two *independent* locks, one per operation kind, so a connector sweep and a
# dedup pass never block each other (they are different work against different
# rows) while two runs of the *same* kind are mutually exclusive:
#   - RUN_ADVISORY_LOCK_ID   — the project-wide connector/ETL run lock.
#   - DEDUP_ADVISORY_LOCK_ID — the dedup engine's single-runner lock (D-036).
RUN_ADVISORY_LOCK_ID = 0x4554_4C53_524E_5F5F  # bigint, fits in PG's lock id
DEDUP_ADVISORY_LOCK_ID = 0x4445_4455_5052_554E  # "DEDUPRUN" — distinct from above


def try_acquire_run_lock(conn, lock_id: int = RUN_ADVISORY_LOCK_ID) -> bool:
    """Try to grab a session-scoped advisory lock (non-blocking).

    Returns True when the caller is now the sole owner of *lock_id* and is
    free to proceed; False when another process (another scheduler instance,
    a parallel manual trigger, or — for DEDUP_ADVISORY_LOCK_ID — a concurrent
    dedup pass) is already holding it.

    *lock_id* selects which operation kind is being guarded — default is the
    connector/ETL run lock; pass DEDUP_ADVISORY_LOCK_ID for the dedup
    single-runner guard (D-036). The two locks are independent bigints, so
    holding one never blocks acquisition of the other.

    The lock is session-scoped: it auto-releases when this PG connection
    closes, so a crashed ETL container (SIGKILL, OOM, host reboot) frees it on
    the connection teardown — no zombie locks across container restarts, which
    is exactly why an orphaned run row can outlive the lock that guarded it and
    must be reconciled separately (see orchestrator._reconcile_orphaned_dedup_runs).
    """
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (lock_id,))
            got: bool = bool(cur.fetchone()[0])
        conn.commit()
        return got
    except Exception:  # noqa: BLE001 — must never raise into the scheduler loop
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001, S110 — rollback on a dead conn is moot
            pass
        # If we cannot even check the lock, fail closed so we don't run
        # twice in parallel. The next scheduler tick will retry.
        return False


def release_run_lock(conn, lock_id: int = RUN_ADVISORY_LOCK_ID) -> None:
    """Release the advisory lock acquired by try_acquire_run_lock.

    Pass the same *lock_id* that was acquired (default: the connector/ETL run
    lock; DEDUP_ADVISORY_LOCK_ID for the dedup guard). Safe to call when the
    lock is not held — pg_advisory_unlock returns false in that case but does
    not raise. We swallow exceptions because failing to release is recoverable
    (the lock auto-frees on connection close).
    """
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s)", (lock_id,))
            cur.fetchone()
        conn.commit()
    except Exception:  # noqa: BLE001 — failing to release is recoverable, see docstring
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001, S110 — rollback on a dead conn is moot
            pass


def create_run(conn, trigger: str, kind: str = "full") -> int:
    """Insert an etl_sync_runs record with status='running' and return its id.

    `kind` is the run's mode — 'delta' for the hourly watermark-only sweep
    or 'full' for the nightly everything-pass. Stored as-is so the dashboard
    can render a Delta/Completa pill without recomputing it from per-table
    methods.
    """
    if kind not in ("delta", "full"):
        raise ValueError(f"Invalid run kind: {kind!r} (expected 'delta' or 'full')")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO etl_sync_runs (trigger, kind, status) "
                "VALUES (%s, %s, 'running') RETURNING id",
                (trigger, kind),
            )
            run_id: int = cur.fetchone()[0]
        conn.commit()
        return run_id
    except Exception:
        conn.rollback()
        raise


def finish_run(
    conn,
    run_id: int,
    status: str,
    tables_ok: int,
    tables_failed: int,
    total_rows_synced: int = 0,
) -> None:
    """Update etl_sync_runs with final status, counts, and duration."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE etl_sync_runs
                   SET finished_at       = NOW(),
                       status            = %s,
                       tables_ok         = %s,
                       tables_failed     = %s,
                       total_tables      = %s,
                       total_rows_synced = %s,
                       duration_ms       = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
                 WHERE id = %s
                """,
                (
                    status,
                    tables_ok,
                    tables_failed,
                    tables_ok + tables_failed,
                    total_rows_synced,
                    run_id,
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def record_table_sync(
    conn,
    run_id: int | None = None,
    table_name: str | None = None,
    rows_synced: int = 0,
    duration_ms: int = 0,
    *,
    status: str = "ok",
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
    sync_method: str | None = None,
    rows_total_after: int | None = None,
    watermark_from: datetime | None = None,
    watermark_to: datetime | None = None,
    error_msg: str | None = None,
    trace_id: str | None = None,
    span_id: str | None = None,
) -> None:
    """Insert a per-table sync record into etl_sync_run_tables."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO etl_sync_run_tables
                    (run_id, table_name, rows_synced, duration_ms, status,
                     started_at, finished_at, sync_method, rows_total_after,
                     watermark_from, watermark_to, error_msg, trace_id, span_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run_id,
                    table_name,
                    rows_synced,
                    duration_ms,
                    status,
                    started_at,
                    finished_at,
                    sync_method,
                    rows_total_after,
                    watermark_from,
                    watermark_to,
                    error_msg,
                    trace_id,
                    span_id,
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def update_run_trace_context(
    conn,
    run_id: int,
    trace_id: str | None,
    span_id: str | None,
) -> None:
    """Persist OTel trace_id and span_id on an etl_sync_runs row.

    Called immediately after create_run() once the parent span is active.
    Silently no-ops if both values are None (SDK not initialised).
    """
    if trace_id is None and span_id is None:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE etl_sync_runs SET trace_id = %s, span_id = %s WHERE id = %s",
                (trace_id, span_id, run_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def check_and_consume_trigger(conn) -> int | None:
    """Atomically pick up one pending trigger row.

    Returns the trigger row id if a trigger was found and picked up, None otherwise.
    Uses FOR UPDATE SKIP LOCKED so concurrent processes never double-pick.

    Note: the force-resync metadata (``force_full``, ``force_tables``) is not
    returned here; call :func:`get_trigger_force_flags` with the id to read
    those fields. Keeping this helper's return type stable preserves backward
    compatibility with callers that expect a plain int.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE etl_manual_trigger
                SET status = 'picked_up', picked_up_at = NOW()
                WHERE id = (
                    SELECT id FROM etl_manual_trigger
                    WHERE status = 'pending'
                    ORDER BY requested_at, id
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING id
                """
            )
            row = cur.fetchone()
            conn.commit()
            return row[0] if row is not None else None
    except Exception:
        conn.rollback()
        raise


def get_trigger_force_flags(
    conn, trigger_id: int
) -> tuple[bool, list[str], str | None]:
    """Return ``(force_full, force_tables, triggered_by)`` for *trigger_id*.

    Used by the scheduler after ``check_and_consume_trigger`` claims a row:
    the scheduler needs to know whether to reset watermarks before calling
    :func:`run_full_sync`. Missing/unknown ids return ``(False, [], None)`` so
    the scheduler treats them as a plain incremental sync.

    ``triggered_by`` is an audit string identifying who requested the sync (e.g.
    a client IP address, ``"dashboard"``, or ``"cli"``). May be ``None`` for
    legacy rows inserted before this column was added.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT force_full, force_tables, triggered_by"
                " FROM etl_manual_trigger WHERE id = %s",
                (trigger_id,),
            )
            row = cur.fetchone()
            conn.commit()
            if row is None:
                return (False, [], None)
            force_full, force_tables, triggered_by = row
            return (
                bool(force_full),
                list(force_tables) if force_tables else [],
                triggered_by,
            )
    except Exception:
        conn.rollback()
        raise


def create_manual_trigger(
    conn,
    *,
    force_full: bool = False,
    force_tables: Sequence[str] | None = None,
    triggered_by: str = "dashboard",
    connector_name: str | None = None,
) -> int:
    """Insert a pending manual trigger row and return its id.

    The partial unique index on ``status='pending'`` guarantees at most one
    pending row exists at a time; callers that race can catch the resulting
    ``UniqueViolation`` and fall back to fetching the existing pending row.

    Args:
        force_full: if ``True``, the ETL will reset all watermarks before the run.
            (Inherited PowerShop semantics — the inmo-tool connector orchestrator
            ignores this; use ``connector_name`` to scope a run.)
        force_tables: optional list of sync names whose watermarks should be
            cleared before the run. Ignored when ``force_full=True``. Caller is
            responsible for validating names against the known sync registry —
            this helper only ensures ``force_tables`` is serialised as a
            ``TEXT[]`` (never ``NULL``).
        triggered_by: audit string identifying the requester (e.g. client IP,
            ``"dashboard"``, ``"cli"``). Stored verbatim; no validation performed
            here — callers are responsible for sanitising untrusted input.
        connector_name: issue #244 — when set, the ad-hoc run
            (etl/manual_trigger.py) is restricted to this one connector; ``None``
            means run every enabled connector (a full sweep). Not validated here —
            the poll loop surfaces an unknown name as a ``failed`` trigger.
    """
    tables = list(force_tables) if force_tables else []
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO etl_manual_trigger
                    (status, force_full, force_tables, triggered_by, connector_name)
                VALUES ('pending', %s, %s, %s, %s)
                RETURNING id
                """,
                (bool(force_full), tables, triggered_by, connector_name),
            )
            trigger_id: int = cur.fetchone()[0]
        conn.commit()
        return int(trigger_id)
    except Exception:
        conn.rollback()
        raise


def update_trigger_run_id(conn, trigger_id: int, run_id: int) -> None:
    """Set run_id on the trigger row with the given trigger_id."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE etl_manual_trigger SET run_id = %s WHERE id = %s",
                (run_id, trigger_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
