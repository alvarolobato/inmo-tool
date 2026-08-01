"""PostgreSQL connection and DML helpers for the ETL pipeline.

Transaction policy
------------------
All DML helpers (upsert, bulk_insert, truncate_and_insert) commit on success
and rollback on failure so the connection is always in a clean state.
Watermark helpers (get_watermark, set_watermark) follow the same pattern.
_ensure_watermarks_table() does NOT commit — it is always called as part of a
surrounding operation that owns the commit/rollback.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

if TYPE_CHECKING:
    from etl.config import Config

# Single source of truth for the etl_watermarks DDL: loaded from init.sql so
# the in-memory definition never drifts from the file applied to the database.
_SCHEMA_SQL_PATH = Path(__file__).parent.parent / "schema" / "init.sql"


def _load_watermarks_ddl() -> str:
    """Extract the CREATE TABLE IF NOT EXISTS etl_watermarks statement from init.sql.

    This helper only reads and parses the file.
    Caching is handled by _get_watermarks_ddl() so repeated watermark calls
    do not hit disk.
    """
    sql = _SCHEMA_SQL_PATH.read_text(encoding="utf-8")
    start = sql.find("CREATE TABLE IF NOT EXISTS etl_watermarks")
    if start == -1:
        raise RuntimeError(
            f"etl_watermarks DDL not found in {_SCHEMA_SQL_PATH}. "
            "Ensure etl/schema/init.sql contains that CREATE TABLE statement."
        )
    end_idx = sql.find(";", start)
    if end_idx == -1:
        raise RuntimeError(
            f"etl_watermarks DDL in {_SCHEMA_SQL_PATH} is not terminated with a ';'. "
            "Ensure the CREATE TABLE statement for etl_watermarks ends with a semicolon."
        )
    return sql[start : end_idx + 1]


# Lazily cached DDL string — populated on first use by _ensure_watermarks_table().
# Loading lazily means a missing/unreadable schema file does not crash module
# import and prevents all Postgres helpers from being unusable at startup.
_WATERMARKS_DDL: str | None = None


def _get_watermarks_ddl() -> str:
    """Return the cached etl_watermarks DDL, loading it on first call."""
    global _WATERMARKS_DDL
    if _WATERMARKS_DDL is None:
        _WATERMARKS_DDL = _load_watermarks_ddl()
    return _WATERMARKS_DDL


def _validate_rows(rows: list[dict], operation: str) -> list[str]:
    """Return the column list; raise ValueError if rows have inconsistent or empty keys."""
    columns = list(rows[0].keys())
    if not columns:
        raise ValueError(
            f"{operation}: row dicts must not be empty — at least one column is required."
        )
    expected = set(columns)
    for idx, row in enumerate(rows[1:], start=1):
        if set(row.keys()) != expected:
            raise ValueError(
                f"{operation}: inconsistent keys in row {idx}. "
                f"Expected {sorted(expected)}, got {sorted(row.keys())}."
            )
    return columns


def get_connection(config: "Config"):
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
# DML helpers
# ---------------------------------------------------------------------------


def upsert(conn, table: str, rows: list[dict], pk_cols: list[str]) -> int:
    """Batch-upsert *rows* into *table* using ON CONFLICT DO UPDATE.

    Uses psycopg2.extras.execute_values for efficiency.
    Table and column names are quoted via psycopg2.sql.Identifier.
    Commits on success; rolls back and re-raises on failure.

    Returns the number of rows *attempted* (len(rows)).  This includes both
    inserted and updated rows.  Rows that were skipped by DO NOTHING are still
    counted.  If you need an exact inserted/updated count, use RETURNING 1 and
    execute_values with fetch=True.
    """
    if not rows:
        return 0

    from psycopg2 import sql as pgsql  # type: ignore[import-untyped]
    from psycopg2.extras import execute_values  # type: ignore[import-untyped]

    if not pk_cols:
        raise ValueError("upsert: pk_cols must not be empty.")
    columns = _validate_rows(rows, "upsert")
    missing_pks = [c for c in pk_cols if c not in columns]
    if missing_pks:
        raise ValueError(
            f"upsert: pk_cols {missing_pks} not found in row keys {columns}."
        )
    update_cols = [c for c in columns if c not in pk_cols]
    conflict_target = pgsql.SQL(", ").join(pgsql.Identifier(c) for c in pk_cols)
    col_ids = [pgsql.Identifier(c) for c in columns]
    tbl_id = pgsql.Identifier(table)

    if update_cols:
        set_clause = pgsql.SQL(", ").join(
            pgsql.SQL("{col} = EXCLUDED.{col}").format(col=pgsql.Identifier(c))
            for c in update_cols
        )
        on_conflict = pgsql.SQL("ON CONFLICT ({target}) DO UPDATE SET {sets}").format(
            target=conflict_target, sets=set_clause
        )
    else:
        on_conflict = pgsql.SQL("ON CONFLICT ({target}) DO NOTHING").format(
            target=conflict_target
        )

    stmt = pgsql.SQL("INSERT INTO {tbl} ({cols}) VALUES %s {on_conflict}").format(
        tbl=tbl_id,
        cols=pgsql.SQL(", ").join(col_ids),
        on_conflict=on_conflict,
    )

    try:
        with conn.cursor() as cur:
            execute_values(
                cur,
                stmt.as_string(cur),
                [tuple(row[c] for c in columns) for row in rows],
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    # Return len(rows) rather than cur.rowcount — execute_values paginates by
    # page_size (default 100) and rowcount only reflects the last page.
    return len(rows)


def bulk_insert(conn, table: str, rows: list[dict]) -> int:
    """Simple batch INSERT (for append-only tables like Traspasos).

    Commits on success; rolls back and re-raises on failure.
    Returns the number of rows inserted.
    """
    if not rows:
        return 0

    from psycopg2 import sql as pgsql  # type: ignore[import-untyped]
    from psycopg2.extras import execute_values  # type: ignore[import-untyped]

    columns = _validate_rows(rows, "bulk_insert")
    stmt = pgsql.SQL("INSERT INTO {tbl} ({cols}) VALUES %s").format(
        tbl=pgsql.Identifier(table),
        cols=pgsql.SQL(", ").join(pgsql.Identifier(c) for c in columns),
    )

    try:
        with conn.cursor() as cur:
            execute_values(
                cur,
                stmt.as_string(cur),
                [tuple(row[c] for c in columns) for row in rows],
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    # Return len(rows) — execute_values paginates and rowcount reflects last page only.
    return len(rows)


def insert_ignore(conn, table: str, rows: list[dict], pk_cols: list[str]) -> int:
    """Batch INSERT ... ON CONFLICT (pk_cols) DO NOTHING.

    Idempotent append: rows that already exist (by pk_cols) are silently skipped.
    Use for append-only tables where re-runs must not fail or modify existing rows.

    Returns the number of rows *attempted* (len(rows)), including skipped ones.
    Commits on success; rolls back and re-raises on failure.
    """
    if not rows:
        return 0

    from psycopg2 import sql as pgsql  # type: ignore[import-untyped]
    from psycopg2.extras import execute_values  # type: ignore[import-untyped]

    if not pk_cols:
        raise ValueError("insert_ignore: pk_cols must not be empty.")
    columns = _validate_rows(rows, "insert_ignore")
    missing_pks = [c for c in pk_cols if c not in columns]
    if missing_pks:
        raise ValueError(
            f"insert_ignore: pk_cols {missing_pks} not found in row keys {columns}."
        )

    conflict_target = pgsql.SQL(", ").join(pgsql.Identifier(c) for c in pk_cols)
    stmt = pgsql.SQL(
        "INSERT INTO {tbl} ({cols}) VALUES %s ON CONFLICT ({target}) DO NOTHING"
    ).format(
        tbl=pgsql.Identifier(table),
        cols=pgsql.SQL(", ").join(pgsql.Identifier(c) for c in columns),
        target=conflict_target,
    )

    try:
        with conn.cursor() as cur:
            execute_values(
                cur,
                stmt.as_string(cur),
                [tuple(row[c] for c in columns) for row in rows],
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    # Return len(rows) — execute_values paginates and rowcount reflects last page only.
    return len(rows)


def truncate_and_insert(
    conn,
    table: str,
    rows: list[dict],
    *,
    restart_identity: bool = False,
) -> int:
    """TRUNCATE *table* then INSERT *rows* in a single transaction.

    Used for full-refresh tables (catalogs, small dimension tables).

    Args:
        restart_identity: If True, use TRUNCATE ... RESTART IDENTITY to reset
            any GENERATED AS IDENTITY / SERIAL sequences.  Required for tables
            like ps_facturas_compra that use a surrogate identity key.

    Commits on success; rolls back and re-raises on failure.
    Returns the number of rows inserted.
    """
    from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

    tbl_id = pgsql.Identifier(table)
    restart_clause = (
        pgsql.SQL(" RESTART IDENTITY") if restart_identity else pgsql.SQL("")
    )
    truncate_stmt = pgsql.SQL("TRUNCATE {tbl}{restart} CASCADE").format(
        tbl=tbl_id, restart=restart_clause
    )

    if not rows:
        try:
            with conn.cursor() as cur:
                cur.execute(truncate_stmt)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return 0

    from psycopg2.extras import execute_values  # type: ignore[import-untyped]

    columns = _validate_rows(rows, "truncate_and_insert")
    insert_stmt = pgsql.SQL("INSERT INTO {tbl} ({cols}) VALUES %s").format(
        tbl=tbl_id,
        cols=pgsql.SQL(", ").join(pgsql.Identifier(c) for c in columns),
    )

    try:
        with conn.cursor() as cur:
            cur.execute(truncate_stmt)
            execute_values(
                cur,
                insert_stmt.as_string(cur),
                [tuple(row[c] for c in columns) for row in rows],
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    # Return len(rows) — execute_values paginates and rowcount reflects last page only.
    return len(rows)


# ---------------------------------------------------------------------------
# Watermark helpers
# ---------------------------------------------------------------------------


def _ensure_watermarks_table(conn) -> None:
    """Create the etl_watermarks table if it does not exist.

    DDL is sourced from etl/schema/init.sql (single source of truth) and cached
    after first successful load so repeated calls do not hit disk.
    Does NOT commit — callers own the transaction boundary.

    If etl/schema/init.sql is missing or the etl_watermarks statement is absent,
    a RuntimeError is raised from _load_watermarks_ddl() with context about what
    is wrong and how to fix it (e.g., missing file in a Docker image).
    """
    with conn.cursor() as cur:
        cur.execute(_get_watermarks_ddl())


def get_watermark(conn, table_name: str) -> datetime | None:
    """Return the last_sync_at timestamp for *table_name*, or None if not set.

    This helper does not manage transactions: it may perform DDL (via
    _ensure_watermarks_table) and then issues a SELECT, but it neither commits
    nor rolls back. Callers are responsible for transaction boundaries and it is
    safe to call inside a broader transaction.
    """
    _ensure_watermarks_table(conn)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT last_sync_at FROM etl_watermarks WHERE table_name = %s",
            (table_name,),
        )
        row = cur.fetchone()
    return row[0] if row else None


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


# Stable lock-id used by try_acquire_run_lock. PostgreSQL advisory locks
# take a single bigint; this constant is just a project-scoped magic number
# (chosen as a CRC32 of "etl_sync_runs" — value is opaque, what matters is
# that it stays consistent across processes and never collides with any
# other advisory-lock user in the database).
RUN_ADVISORY_LOCK_ID = 0x4554_4C53_524E_5F5F  # bigint, fits in PG's lock id


def try_acquire_run_lock(conn) -> bool:
    """Try to grab the project-wide ETL run advisory lock (non-blocking).

    Returns True when the caller is now the sole owner of the lock and is
    free to call run_full_sync; False when another scheduler instance (or
    a parallel manual trigger that escaped the _is_run_active check) is
    already holding it.

    The lock is session-scoped: it auto-releases when this PG connection
    closes, so a crashed ETL container will release it on its next
    reconnect — no zombie locks across container restarts.

    Why this exists: _is_run_active() reads etl_sync_runs.status, but
    create_run is best-effort and may have failed, leaving no row. In that
    edge case _is_run_active returns False and a second scheduler could
    start a concurrent run. The advisory lock is independent of the
    monitoring rows and survives such failures.
    """
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (RUN_ADVISORY_LOCK_ID,))
            got: bool = bool(cur.fetchone()[0])
        conn.commit()
        return got
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        # If we cannot even check the lock, fail closed so we don't run
        # twice in parallel. The next scheduler tick will retry.
        return False


def release_run_lock(conn) -> None:
    """Release the advisory lock acquired by try_acquire_run_lock.

    Safe to call when the lock is not held — pg_advisory_unlock returns
    false in that case but does not raise. We swallow exceptions because
    failing to release is recoverable (the lock auto-frees on connection
    close).
    """
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s)", (RUN_ADVISORY_LOCK_ID,))
            cur.fetchone()
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
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
) -> int:
    """Insert a pending manual trigger row and return its id.

    The partial unique index on ``status='pending'`` guarantees at most one
    pending row exists at a time; callers that race can catch the resulting
    ``UniqueViolation`` and fall back to fetching the existing pending row.

    Args:
        force_full: if ``True``, the ETL will reset all watermarks before the run.
        force_tables: optional list of sync names whose watermarks should be
            cleared before the run. Ignored when ``force_full=True``. Caller is
            responsible for validating names against the known sync registry —
            this helper only ensures ``force_tables`` is serialised as a
            ``TEXT[]`` (never ``NULL``).
        triggered_by: audit string identifying the requester (e.g. client IP,
            ``"dashboard"``, ``"cli"``). Stored verbatim; no validation performed
            here — callers are responsible for sanitising untrusted input.
    """
    tables = list(force_tables) if force_tables else []
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO etl_manual_trigger (status, force_full, force_tables, triggered_by)
                VALUES ('pending', %s, %s, %s)
                RETURNING id
                """,
                (bool(force_full), tables, triggered_by),
            )
            trigger_id: int = cur.fetchone()[0]
        conn.commit()
        return int(trigger_id)
    except Exception:
        conn.rollback()
        raise


def reset_watermarks(conn, table_names: Sequence[str]) -> int:
    """Delete watermark rows for *table_names* so the next run re-materialises them.

    Returns the number of deleted rows. A table name that has no watermark row
    (e.g. the first time the sync runs) is a silent no-op. Commits on success;
    rolls back and re-raises on failure.

    An empty ``table_names`` argument is a no-op and returns 0 — never deletes
    every watermark by accident. Use a separate explicit helper (or pass the
    full registry) to wipe all watermarks.
    """
    if not table_names:
        return 0

    names = list(table_names)
    try:
        _ensure_watermarks_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM etl_watermarks WHERE table_name = ANY(%s)",
                (names,),
            )
            deleted = cur.rowcount
        conn.commit()
        return int(deleted)
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


def set_watermark(
    conn,
    table_name: str,
    last_sync_at: datetime,
    rows_synced: int,
    status: str = "ok",
    error_msg: str | None = None,
) -> None:
    """Upsert the watermark record for *table_name*.

    *last_sync_at* must be timezone-aware.  Naive datetimes would be interpreted
    by PostgreSQL's TIMESTAMPTZ column using the session time zone, which can
    silently shift the watermark and break delta-sync logic.  A ValueError is
    raised to make the contract explicit.

    Commits on success; rolls back and re-raises on failure.
    """
    # A datetime is "naive" if tzinfo is None OR if utcoffset() returns None
    # (some tzinfo subclasses can be set but still return None for utcoffset).
    if last_sync_at.tzinfo is None or last_sync_at.utcoffset() is None:
        raise ValueError(
            "set_watermark: last_sync_at must be a fully timezone-aware datetime. "
            "Use datetime(..., tzinfo=timezone.utc) or .replace(tzinfo=timezone.utc)."
        )
    # Normalize to UTC before writing so the stored value is unambiguous.
    from datetime import timezone as _tz

    last_sync_at = last_sync_at.astimezone(_tz.utc)

    try:
        _ensure_watermarks_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO etl_watermarks
                    (table_name, last_sync_at, rows_synced, status, error_msg, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (table_name) DO UPDATE SET
                    last_sync_at = EXCLUDED.last_sync_at,
                    rows_synced  = EXCLUDED.rows_synced,
                    status       = EXCLUDED.status,
                    error_msg    = EXCLUDED.error_msg,
                    updated_at   = NOW()
                """,
                (table_name, last_sync_at, rows_synced, status, error_msg),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
