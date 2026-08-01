"""ETL main orchestrator.

Wires all sync modules into a single nightly pipeline with:
- Topological execution order (catalog → masters → stock → ventas → mayorista → compras)
- Per-table error handling (one failure does not stop the rest)
- Watermark management (get/set via etl_watermarks table)
- Schema initialisation from etl/schema/init.sql on first run
- CLI: --once for a single run, or scheduler mode (daily at ETL_CRON_HOUR)

Usage:
    python -m etl.main --once       # run full sync once and exit
    python -m etl.main              # run scheduler (daily at ETL_CRON_HOUR, default 2)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from opentelemetry import trace as _otel_trace

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    level=logging.INFO,
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("etl")


# Number of consecutive _is_run_active failures before the process exits so
# Docker can restart it with a fresh postgres connection. At 10-second poll
# intervals this equals ~60 seconds of lost connectivity before giving up.
_IS_RUN_ACTIVE_MAX_FAILURES = 6
_is_run_active_failures = 0  # module-level counter reset on each success

# ---------------------------------------------------------------------------
# Cron-setting helpers
# ---------------------------------------------------------------------------


def _parse_cron_hour(raw: str | None) -> int:
    """Validate ETL_CRON_HOUR string; default to 2 when non-integer or outside [0, 23]."""
    try:
        value = int(raw or "2")
    except ValueError:
        logger.warning("ETL_CRON_HOUR=%r is not an integer; defaulting to 2", raw)
        return 2
    if not (0 <= value <= 23):
        logger.warning("ETL_CRON_HOUR=%d out of range; defaulting to 2", value)
        return 2
    return value


def _parse_cron_minute(raw: str | None) -> int:
    """Validate ETL_DELTA_CRON_MINUTE string; default to 0 when non-integer or outside [0, 59]."""
    try:
        value = int(raw or "0")
    except ValueError:
        logger.warning(
            "ETL_DELTA_CRON_MINUTE=%r is not an integer; defaulting to 0", raw
        )
        return 0
    if not (0 <= value <= 59):
        logger.warning("ETL_DELTA_CRON_MINUTE=%d out of range; defaulting to 0", value)
        return 0
    return value


def _parse_lookback_days(raw: str | None) -> int:
    """Validate ETL_DELTA_LOOKBACK_DAYS string; default to 1 when non-integer or negative."""
    try:
        value = int(raw or "1")
    except ValueError:
        logger.warning(
            "ETL_DELTA_LOOKBACK_DAYS=%r is not an integer; defaulting to 1", raw
        )
        return 1
    if value < 0:
        logger.warning("ETL_DELTA_LOOKBACK_DAYS=%d is negative; defaulting to 1", value)
        return 1
    return value


# ---------------------------------------------------------------------------
# Schema initialisation
# ---------------------------------------------------------------------------

_SCHEMA_SQL_PATH = Path(__file__).parent / "schema" / "init.sql"


def _init_schema(conn_pg) -> None:
    """Execute etl/schema/init.sql against PostgreSQL (idempotent — IF NOT EXISTS)."""
    sql = _SCHEMA_SQL_PATH.read_text(encoding="utf-8")
    with conn_pg.cursor() as cur:
        cur.execute(sql)
    conn_pg.commit()
    logger.info("Schema initialised (init.sql applied)")


# ---------------------------------------------------------------------------
# Per-table sync runner
# ---------------------------------------------------------------------------


def _get_table_row_estimate(conn_pg, table_name: str) -> int | None:
    """Return n_live_tup from pg_stat_user_tables for `table_name`.

    Used to populate etl_sync_run_tables.rows_total_after — the dashboard
    "Total est." column. Reads pg_stat_user_tables instead of COUNT(*) so
    it's O(1) and never holds a lock on the synced table. The estimate
    can lag the real total slightly (it's updated by autovacuum/ANALYZE
    and on pg_stat_get_xact_*), but the column is deliberately labelled
    "est." in the UI so a small lag is acceptable.
    """
    try:
        with conn_pg.cursor() as cur:
            cur.execute(
                "SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = %s",
                (table_name,),
            )
            row = cur.fetchone()
        conn_pg.rollback()
        if row is None or row[0] is None:
            return None
        return int(row[0])
    except Exception as exc:
        logger.debug("rows_total_after lookup failed for %s: %s", table_name, exc)
        try:
            conn_pg.rollback()
        except Exception:
            pass
        return None


def _run_sync(
    name: str,
    sync_fn,
    conn_4d,
    conn_pg,
    uses_watermark: bool = False,
    run_id: int | None = None,
    *,
    kind: str = "full",
    target_table: str | None = None,
    lookback_days: int = 1,
) -> tuple[int, bool]:
    """Run a single sync function with timing, watermark management, and error handling.

    Returns (rows_synced, ok).  Errors are logged but do not propagate — the
    caller continues with the next table.  When run_id is provided, calls
    record_table_sync after each table; failures there are also swallowed.

    `kind`:
      'delta' — pass the stored watermark to the sync fn so it only fetches
                rows modified since (cheap, no truncate).
      'full'  — ignore the stored watermark (since=None) so the sync fn
                does a full reload. The watermark is still updated on
                completion, so the next delta run picks up correctly.
      Non-watermark syncs ignore `kind`: they always full-refresh.

    `target_table` is the destination ps_* table; when set, the post-sync
    n_live_tup estimate is recorded as etl_sync_run_tables.rows_total_after.
    """
    from etl.db.postgres import get_watermark, set_watermark

    _tracer = _otel_trace.get_tracer("powershop.etl")

    start = time.time()
    started_at = datetime.now(timezone.utc)
    rows = 0
    ok = True
    duration_ms = 0
    err: str | None = None
    wm_from: datetime | None = None
    wm_to: datetime | None = None

    span_ctx: tuple[str | None, str | None] = (None, None)

    with _tracer.start_as_current_span(
        f"etl.sync.{name}",
        attributes={"table_name": name, "sync_kind": kind},
    ) as span:
        try:
            if uses_watermark:
                since = None if kind == "full" else get_watermark(conn_pg, name)
                if since is not None and kind == "delta" and lookback_days > 0:
                    since = since - timedelta(days=lookback_days)
                wm_from = since
                rows = sync_fn(conn_4d, conn_pg, since)
            else:
                rows = sync_fn(conn_4d, conn_pg)
            duration_ms = int((time.time() - start) * 1000)
            now = datetime.now(timezone.utc)
            if uses_watermark:
                wm_to = now
            set_watermark(conn_pg, name, now, rows, "ok")
            logger.info("%s rows=%d duration_ms=%d", name, rows, duration_ms)
            try:
                span.set_attribute("rows_synced", rows)
                span.set_attribute("duration_ms", duration_ms)
                span.set_attribute("status", "ok")
            except Exception:
                logger.debug("OTel span attribute write failed", exc_info=True)
        except Exception as exc:
            duration_ms = int((time.time() - start) * 1000)
            ok = False
            err = str(exc)[:2000]
            wm_to = datetime.now(timezone.utc)
            try:
                set_watermark(conn_pg, name, wm_to, 0, "error", err)
            except Exception as wm_exc:
                logger.error("Failed to write error watermark for %s: %s", name, wm_exc)
            logger.error("%s FAILED duration_ms=%d: %s", name, duration_ms, exc)
            try:
                span.set_attribute("status", "failed")
                span.set_attribute("error", err or "")
                span.record_exception(exc)
            except Exception:
                logger.debug("OTel span error recording failed", exc_info=True)

        # Capture span context for DB persistence after the span exits
        try:
            active_span = _otel_trace.get_current_span()
            ctx = active_span.get_span_context()
            if ctx and ctx.is_valid:
                span_ctx = (
                    format(ctx.trace_id, "032x"),
                    format(ctx.span_id, "016x"),
                )
        except Exception:
            logger.debug("OTel span context capture failed", exc_info=True)

    # In a "full" nightly run a watermark-backed sync still does truncate-
    # and-reinsert (since=None), so log it as full_refresh — not the
    # incremental upsert label.
    sync_method = (
        "upsert_delta" if uses_watermark and kind == "delta" else "full_refresh"
    )

    rows_total_after: int | None = None
    if ok and target_table:
        rows_total_after = _get_table_row_estimate(conn_pg, target_table)

    if run_id is not None:
        from etl.db.postgres import record_table_sync

        try:
            record_table_sync(
                conn_pg,
                run_id,
                name,
                rows,
                duration_ms,
                status="ok" if ok else "failed",
                started_at=started_at,
                finished_at=datetime.now(timezone.utc),
                sync_method=sync_method,
                rows_total_after=rows_total_after,
                watermark_from=wm_from,
                watermark_to=wm_to,
                error_msg=err,
                trace_id=span_ctx[0],
                span_id=span_ctx[1],
            )
        except Exception as mon_exc:
            logger.error(
                "Monitoring: record_table_sync failed for %s: %s", name, mon_exc
            )

    return rows, ok


# ---------------------------------------------------------------------------
# sync_catalogos returns dict[str, int] — sum the values for the watermark row count
# ---------------------------------------------------------------------------


def _run_sync_catalogos(conn_4d, conn_pg) -> int:
    """Wrap sync_catalogos (returns dict) so _run_sync can treat it uniformly."""
    from etl.sync.articulos import sync_catalogos

    result = sync_catalogos(conn_4d, conn_pg)
    if isinstance(result, dict):
        return sum(result.values())
    return int(result)


# ---------------------------------------------------------------------------
# MA cascade cleanup
# ---------------------------------------------------------------------------


def _cleanup_ma_linked_rows(conn_4d, conn_pg) -> None:
    """Delete rows from line-item tables that reference MA-prefix article codes.

    MA articles (CCRefeJOFACM starting with 'MA') are excluded from ps_articulos
    at the source query level.  However, line-item tables (lineas_ventas,
    stock_tienda, gc_lin_albarane, gc_lin_facturas) are synced independently and
    may still hold rows whose `codigo` belongs to an MA article.  This function
    removes those rows so that all tables are MA-free after each sync run.

    The cleanup is idempotent — safe to run multiple times; it is a no-op when
    no MA rows are present.

    Line tables covered:
        ps_lineas_ventas, ps_stock_tienda, ps_gc_lin_albarane, ps_gc_lin_facturas
    """
    from etl.sync.articulos import get_ma_article_codes

    ma_codes = get_ma_article_codes(conn_4d)
    if not ma_codes:
        logger.info("MA cleanup: no MA article codes found — nothing to clean up")
        return

    logger.info(
        "MA cleanup: %d MA article codes to remove from line tables", len(ma_codes)
    )

    _MA_LINE_TABLES = [
        "ps_lineas_ventas",
        "ps_stock_tienda",
        "ps_gc_lin_albarane",
        "ps_gc_lin_facturas",
    ]

    from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

    ma_codes_list = list(ma_codes)
    try:
        with conn_pg.cursor() as cur:
            for table in _MA_LINE_TABLES:
                stmt = pgsql.SQL("DELETE FROM {} WHERE codigo = ANY(%s)").format(
                    pgsql.Identifier(table)
                )
                cur.execute(stmt, (ma_codes_list,))
                deleted = cur.rowcount
                logger.info("MA cleanup: deleted %d rows from %s", deleted, table)
        conn_pg.commit()
    except Exception:
        conn_pg.rollback()
        raise


# ---------------------------------------------------------------------------
# Post-sync totals helper
# ---------------------------------------------------------------------------

_ROWS_TOTAL_TABLES = [
    "ps_ventas",
    "ps_lineas_ventas",
    "ps_stock_tienda",
    "ps_articulos",
    "ps_clientes",
]


def _get_rows_total(conn_pg) -> dict[str, int] | None:
    """Return row counts for key tables; returns None on any DB error."""
    try:
        totals: dict[str, int] = {}
        with conn_pg.cursor() as cur:
            for table in _ROWS_TOTAL_TABLES:
                cur.execute(f"SELECT COUNT(*) FROM {table}")  # noqa: S608
                totals[table] = cur.fetchone()[0]
        return totals
    except Exception as exc:
        logger.warning("Could not fetch row totals: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Sync registry (single source of truth for known sync names)
# ---------------------------------------------------------------------------
# Must stay in sync with the _s(...) calls in run_full_sync below. This
# registry is used for two things:
#   1. Validating `force_tables` names coming from the dashboard / API so we
#      never reset watermarks for a misspelled table.
#   2. Supporting `force_full=True` by expanding to every watermark-backed
#      sync. Non-watermark syncs (catalogos, tiendas, clientes, ...) always
#      full-refresh anyway, so they are excluded — resetting their watermark
#      (which does not exist) would be a no-op.
SYNC_NAMES_WITH_WATERMARK: tuple[str, ...] = (
    "articulos",
    "clientes",
    "ccstock",
    "facturas",
    "ventas",
    "lineas_ventas",
    "pagos_ventas",
    "gc_albaranes",
    "gc_lin_albarane",
    "gc_facturas",
    "gc_lin_facturas",
    "stock",
    "traspasos",
)

# Map sync name → primary destination ps_* table.  Used to populate
# etl_sync_run_tables.rows_total_after with a cheap n_live_tup estimate
# after each sync.  Multi-table syncs (catalogos, stock, traspasos write
# more than one ps_* table) are intentionally absent — the column would
# be ambiguous, so it stays NULL for those rows.
SYNC_TARGET_TABLE: dict[str, str] = {
    "articulos": "ps_articulos",
    "tiendas": "ps_tiendas",
    "clientes": "ps_clientes",
    "proveedores": "ps_proveedores",
    "gc_comerciales": "ps_gc_comerciales",
    "ventas": "ps_ventas",
    "lineas_ventas": "ps_lineas_ventas",
    "pagos_ventas": "ps_pagos_ventas",
    "gc_albaranes": "ps_gc_albaranes",
    "gc_lin_albarane": "ps_gc_lin_albarane",
    "gc_facturas": "ps_gc_facturas",
    "gc_lin_facturas": "ps_gc_lin_facturas",
    "gc_pedidos": "ps_gc_pedidos",
    "gc_lin_pedidos": "ps_gc_lin_pedidos",
    "compras": "ps_compras",
    "lineas_compras": "ps_lineas_compras",
    "facturas": "ps_facturas",
    "albaranes": "ps_albaranes",
    "facturas_compra": "ps_facturas_compra",
    "stock": "ps_stock_tienda",
    "ccstock": "ps_stock_central",
}

# All sync names, including full-refresh tables. Exposed for the dashboard
# whitelist so the UI can show every available option.
SYNC_NAMES: tuple[str, ...] = (
    "catalogos",
    "articulos",
    "tiendas",
    "clientes",
    "proveedores",
    "gc_comerciales",
    "ventas",
    "lineas_ventas",
    "pagos_ventas",
    "gc_albaranes",
    "gc_lin_albarane",
    "gc_facturas",
    "gc_lin_facturas",
    "gc_pedidos",
    "gc_lin_pedidos",
    "compras",
    "lineas_compras",
    "facturas",
    "albaranes",
    "facturas_compra",
    "stock",
    "ccstock",
    "traspasos",
)


# ---------------------------------------------------------------------------
# Full sync pipeline
# ---------------------------------------------------------------------------


def _is_run_active(conn_pg) -> bool:
    """Return True if a recent etl_sync_runs row with status='running' exists.

    Rows older than 12 hours are treated as stale (crashed runs) and ignored.

    On repeated connection failures the function increments a module-level
    counter. After _IS_RUN_ACTIVE_MAX_FAILURES consecutive failures it raises
    ``RuntimeError`` so the scheduler loop exits, Docker restarts the process,
    and the connection is re-established cleanly.
    """
    global _is_run_active_failures
    try:
        with conn_pg.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM etl_sync_runs WHERE status = 'running'"
                " AND started_at > NOW() - INTERVAL '12 hours' LIMIT 1"
            )
            is_active = cur.fetchone() is not None
        conn_pg.rollback()
        _is_run_active_failures = 0  # reset on success
        return is_active
    except Exception as exc:
        _is_run_active_failures += 1
        logger.warning(
            "_is_run_active query failed (%d/%d): %s",
            _is_run_active_failures,
            _IS_RUN_ACTIVE_MAX_FAILURES,
            exc,
        )
        try:
            conn_pg.rollback()
        except Exception:
            pass
        if _is_run_active_failures >= _IS_RUN_ACTIVE_MAX_FAILURES:
            raise RuntimeError(
                f"PostgreSQL connection lost for {_is_run_active_failures} consecutive "
                f"_is_run_active checks — restarting process to reconnect"
            ) from exc
        return True  # fail closed: assume active, retry next tick


def run_full_sync(
    conn_4d,
    conn_pg,
    trigger: str = "scheduled",
    trigger_id: int | None = None,
    kind: str = "full",
    *,
    force_flags: tuple[bool, list[str], str | None] | None = None,
    lookback_days: int = 1,
) -> None:
    """Execute all sync tasks in topological order.

    `kind`:
      'full'  — every module runs; watermark-backed syncs do truncate-and-
                reinsert (so hard-deletes in 4D are reflected). Used by the
                nightly cron and by manual triggers that opt in via the
                "Forzar resync" dialog (force_full=True, or force_tables
                non-empty — both reset watermarks before the run).
      'delta' — only watermark-backed syncs run; each fetches FechaModifica
                > stored_watermark and upserts. Cheap (~seconds), used by
                the hourly cron between nightly fulls AND by the default
                "Sincronizar ahora" button click.

    `force_flags` (optional, manual triggers only): a pre-read
    ``(force_full, force_tables, triggered_by)`` tuple from
    :func:`get_trigger_force_flags`. The scheduler loop now reads these flags
    once to pick `kind`, then passes the same tuple here so the watermark-
    reset block doesn't re-read them — guaranteeing kind selection and the
    reset decision come from a single source. Pass ``None`` (the default) to
    have :func:`run_full_sync` read the flags itself, used by the integration
    test path and by callers that don't pre-compute kind.

    Errors in individual tables are caught and logged; execution continues.
    Monitoring (create_run / record_table_sync / finish_run) is best-effort:
    failures there never abort the data sync.
    """
    if kind not in ("delta", "full"):
        raise ValueError(f"Invalid kind: {kind!r} (expected 'delta' or 'full')")
    from etl.db.postgres import (
        create_run,
        finish_run,
        get_trigger_force_flags,
        record_table_sync,
        release_run_lock,
        reset_watermarks,
        try_acquire_run_lock,
        update_run_trace_context,
        update_trigger_run_id,
    )

    # Cross-process exclusion. _is_run_active (row check) can race with
    # create_run when a manual trigger and a cron firing land close in
    # time, letting two runs proceed in parallel. The advisory lock is
    # held inside PG and is independent of any monitoring row, so it is
    # the authoritative gate. Session-scoped: auto-released on connection
    # close, so a crashed container leaves no zombie lock.
    if not try_acquire_run_lock(conn_pg):
        logger.warning(
            "Another ETL run is already in progress (advisory lock held) — skipping %s sync",
            kind,
        )
        return

    from etl.sync.articulos import sync_articulos
    from etl.sync.compras import (
        sync_albaranes,
        sync_compras,
        sync_facturas,
        sync_facturas_compra,
        sync_lineas_compras,
    )
    from etl.sync.maestros import (
        sync_clientes,
        sync_gc_comerciales,
        sync_proveedores,
        sync_tiendas,
    )
    from etl.sync.mayorista import (
        sync_gc_albaranes,
        sync_gc_facturas,
        sync_gc_lin_albarane,
        sync_gc_lin_facturas,
        sync_gc_lin_pedidos,
        sync_gc_pedidos,
    )
    from etl.sync.ccstock import sync_ccstock
    from etl.sync.stock import sync_stock, sync_traspasos
    from etl.sync.ventas import sync_lineas_ventas, sync_pagos_ventas, sync_ventas

    run_span_cm = _otel_trace.get_tracer("powershop.etl").start_as_current_span(
        "etl.run",
        attributes={"trigger": trigger, "kind": kind},
    )

    try:
        run_span_cm.__enter__()
        logger.info("=== %s sync started ===", "Delta" if kind == "delta" else "Full")
        pipeline_start = time.time()

        # ------------------------------------------------------------------
        # Honour manual trigger's force flags BEFORE creating the run, so the
        # watermark reset happens even if create_run fails downstream. Resetting
        # watermarks is idempotent and safe: the worst case is one extra pass over
        # incremental tables on the next sync.
        # ------------------------------------------------------------------
        def _abort_forced_run(scope: str, err_msg: str) -> None:
            """Record a FAILED run for an aborted force-resync (issue #828).

            The operator asked for a from-scratch resync precisely because the
            watermarks are suspect. If the reset fails, running anyway would
            execute a normal stale-watermark sync while the dashboard reports
            the requested force-resync as done — the data the operator wanted
            re-pulled would still be missing, silently. Recording a failed run
            (and linking it to the trigger row) surfaces the abort instead.

            A synthetic "(watermark_reset)" table row carries the error message
            so the dashboard details view shows WHY the run aborted, mirroring
            the "(4d_connection)" row written by _record_connection_failure.
            """
            try:
                aborted_run_id = create_run(conn_pg, trigger, kind=kind)
                now = datetime.now(timezone.utc)
                try:
                    record_table_sync(
                        conn_pg,
                        aborted_run_id,
                        "(watermark_reset)",
                        0,
                        0,
                        status="failed",
                        started_at=now,
                        finished_at=now,
                        error_msg=f"{scope}: {err_msg}"[:2000],
                    )
                except Exception:
                    logger.exception("Could not record watermark-reset failure row")
                finish_run(conn_pg, aborted_run_id, "failed", 0, 1, total_rows_synced=0)
                if trigger_id is not None:
                    update_trigger_run_id(conn_pg, trigger_id, aborted_run_id)
            except Exception:
                logger.exception(
                    "Could not record the aborted force-resync run (%s)", scope
                )

        if trigger == "manual" and trigger_id is not None:
            if force_flags is not None:
                # Pre-read by the scheduler loop (the normal path now). Using
                # the same tuple here guarantees the kind selection upstream
                # and the watermark-reset decision below see identical flag
                # values — they cannot diverge even if the underlying row
                # were somehow mutated between two SELECTs.
                force_full, force_tables, triggered_by = force_flags
            else:
                try:
                    force_full, force_tables, triggered_by = get_trigger_force_flags(
                        conn_pg, trigger_id
                    )
                except Exception:
                    logger.exception(
                        "Trigger %d: could not read force flags — running incrementally",
                        trigger_id,
                    )
                    force_full, force_tables, triggered_by = False, [], None

            logger.info(
                "Trigger %d: triggered_by=%r",
                trigger_id,
                triggered_by if triggered_by else "unknown",
            )

            if force_full:
                logger.warning(
                    "Trigger %d requested force_full=True — clearing ALL watermarks "
                    "for %d tables (this can dramatically increase sync duration)",
                    trigger_id,
                    len(SYNC_NAMES_WITH_WATERMARK),
                )
                try:
                    deleted = reset_watermarks(conn_pg, list(SYNC_NAMES_WITH_WATERMARK))
                    logger.info(
                        "Trigger %d: reset_watermarks(force_full) deleted %d rows",
                        trigger_id,
                        deleted,
                    )
                except Exception as reset_exc:
                    logger.exception(
                        "Trigger %d: force_full watermark reset FAILED — aborting "
                        "the run (a stale-watermark sync would silently skip the "
                        "data the operator asked to re-pull; issue #828)",
                        trigger_id,
                    )
                    _abort_forced_run("force_full", str(reset_exc))
                    return
            elif force_tables:
                # Filter to known watermark-backed syncs only. A name absent from
                # SYNC_NAMES_WITH_WATERMARK is dropped with a warning — API/UI
                # already validate, this is a defense-in-depth check.
                valid = [t for t in force_tables if t in SYNC_NAMES_WITH_WATERMARK]
                unknown = sorted(set(force_tables) - set(valid))
                if unknown:
                    logger.warning(
                        "Trigger %d: ignoring unknown force_tables %s (not in registry)",
                        trigger_id,
                        unknown,
                    )
                if valid:
                    logger.info(
                        "Trigger %d: force_tables=%s — resetting watermarks",
                        trigger_id,
                        valid,
                    )
                    try:
                        deleted = reset_watermarks(conn_pg, valid)
                        logger.info(
                            "Trigger %d: reset_watermarks deleted %d row(s)",
                            trigger_id,
                            deleted,
                        )
                    except Exception as reset_exc:
                        logger.exception(
                            "Trigger %d: force_tables watermark reset FAILED — "
                            "aborting the run (a stale-watermark sync would "
                            "silently skip the data the operator asked to "
                            "re-pull; issue #828)",
                            trigger_id,
                        )
                        _abort_forced_run("force_tables", str(reset_exc))
                        return

        run_id: int | None = None
        try:
            run_id = create_run(conn_pg, trigger, kind=kind)
        except Exception:
            logger.exception(
                "Monitoring: create_run failed; continuing without run tracking"
            )
            if trigger == "manual" and trigger_id is not None:
                logger.warning(
                    "Manual trigger %d will complete but run_id tracking is unavailable",
                    trigger_id,
                )

        # Persist parent span's trace context to etl_sync_runs so the dashboard
        # admin UI can click through to Kibana APM.
        if run_id is not None:
            try:
                _active = _otel_trace.get_current_span()
                _sctx = _active.get_span_context()
                if _sctx and _sctx.is_valid:
                    update_run_trace_context(
                        conn_pg,
                        run_id,
                        format(_sctx.trace_id, "032x"),
                        format(_sctx.span_id, "016x"),
                    )
            except Exception:
                logger.debug("OTel trace context write failed", exc_info=True)

        results: list[bool] = []
        total_rows = 0

        def _s(name, fn, *, wm=False):
            """Dispatch one sync. In delta runs, non-watermark modules are skipped
            — they cover catalog/master/full-refresh-only data that doesn't need
            per-hour refresh and would needlessly wipe + reinsert their tables."""
            nonlocal total_rows
            if kind == "delta" and not wm:
                return
            rows, ok = _run_sync(
                name,
                fn,
                conn_4d,
                conn_pg,
                uses_watermark=wm,
                run_id=run_id,
                kind=kind,
                target_table=SYNC_TARGET_TABLE.get(name),
                lookback_days=lookback_days,
            )
            results.append(ok)
            # Accumulate row counts for etl_sync_runs.total_rows_synced so the
            # Monitor ETL "Filas sincronizadas" KPI reflects the real sum across
            # all tables. Failures return rows=0, so they do not skew the total.
            total_rows += rows

        # ------------------------------------------------------------------
        # 1. Catalog (full refresh, no watermark) — full-runs only
        # ------------------------------------------------------------------
        # Load catalogos BEFORE articulos: truncate_and_insert uses TRUNCATE ...
        # CASCADE, and ps_articulos has FKs to all five catalog tables.  If
        # articulos ran first, the next catalog truncate would cascade-wipe it.
        _s("catalogos", _run_sync_catalogos)
        # articulos is delta-capable — runs every hour AND every full-refresh.
        _s("articulos", sync_articulos, wm=True)

        # ------------------------------------------------------------------
        # 2. Masters
        # ------------------------------------------------------------------
        _s("tiendas", sync_tiendas)  # full-only (51 rows)
        _s("clientes", sync_clientes, wm=True)  # delta-capable
        _s("proveedores", sync_proveedores)  # full-only (520 rows)
        _s("gc_comerciales", sync_gc_comerciales)  # full-only (5 rows)

        # ------------------------------------------------------------------
        # 3. Retail sales (delta by FechaModifica) — run before stock (stock is slow)
        # ------------------------------------------------------------------
        _s("ventas", sync_ventas, wm=True)
        _s("lineas_ventas", sync_lineas_ventas, wm=True)
        _s("pagos_ventas", sync_pagos_ventas, wm=True)

        # ------------------------------------------------------------------
        # 5. Wholesale (delta by Modifica for headers; full for pedidos lines)
        # ------------------------------------------------------------------
        _s("gc_albaranes", sync_gc_albaranes, wm=True)
        _s("gc_lin_albarane", sync_gc_lin_albarane, wm=True)
        _s("gc_facturas", sync_gc_facturas, wm=True)
        _s("gc_lin_facturas", sync_gc_lin_facturas, wm=True)
        _s("gc_pedidos", sync_gc_pedidos)  # full-only — workflow data, can shrink
        _s("gc_lin_pedidos", sync_gc_lin_pedidos)  # full-only — same reason

        # ------------------------------------------------------------------
        # 6. Purchasing — facturas is delta-capable; the rest stay full because
        # the 4D source tables don't expose a FechaModifica field.
        # ------------------------------------------------------------------
        _s("compras", sync_compras)  # full-only (no FechaModifica in Compras)
        _s(
            "lineas_compras", sync_lineas_compras
        )  # full-only (CCLineasCompr has only Fecha)
        _s("facturas", sync_facturas, wm=True)
        _s("albaranes", sync_albaranes)  # full-only (only FechaRecibido)
        _s("facturas_compra", sync_facturas_compra)  # full-only (only FechaFactura)

        # ------------------------------------------------------------------
        # 7. Stock (delta by FechaModifica) — last because Exportaciones is very slow (2M rows)
        # ------------------------------------------------------------------
        _s("stock", sync_stock, wm=True)
        _s("traspasos", sync_traspasos, wm=True)

        # ------------------------------------------------------------------
        # 7b. CCStock (central warehouse) — delta-capable
        # ------------------------------------------------------------------
        _s("ccstock", sync_ccstock, wm=True)

        # ------------------------------------------------------------------
        # 8. MA cascade cleanup — remove line-table rows referencing MA articles
        # ------------------------------------------------------------------
        # MA articles (CCRefeJOFACM starting with 'MA') are excluded from
        # ps_articulos at the source query level.  Here we cascade that exclusion
        # to line-item tables whose rows reference MA article codes via `codigo`.
        # This is necessary because line tables use delta/upsert strategies that
        # may have inserted MA-linked rows in previous sync runs before this filter.
        # Failures are logged but do not abort the pipeline (consistent with _run_sync).
        # Skipped on delta runs: it scans every line-item table and the MA set
        # only changes on full runs (when ps_articulos is fully reloaded).
        if kind == "full":
            ma_ok = True
            try:
                _cleanup_ma_linked_rows(conn_4d, conn_pg)
            except Exception:
                logger.exception(
                    "MA cleanup failed; continuing with pipeline completion"
                )
                ma_ok = False
            results.append(ma_ok)

        total_ms = int((time.time() - pipeline_start) * 1000)
        logger.info(
            "=== %s sync completed in %d ms ===",
            "Delta" if kind == "delta" else "Full",
            total_ms,
        )

        rows_total = _get_rows_total(conn_pg)
        if rows_total:
            logger.info("Post-sync row totals: %s", rows_total)

        if run_id is not None:
            tables_ok = sum(results)
            tables_failed = len(results) - tables_ok
            # Three buckets so the dashboard can distinguish "everything broke"
            # (typically a 4D-side outage or a stale connection) from a real
            # partial run where some tables landed and others didn't.
            if tables_failed == 0:
                status = "success"
            elif tables_ok == 0:
                status = "failed"
            else:
                status = "partial"
            try:
                finish_run(
                    conn_pg,
                    run_id,
                    status,
                    tables_ok,
                    tables_failed,
                    total_rows_synced=total_rows,
                )
            except Exception:
                logger.exception("Monitoring: finish_run failed")

            if trigger == "manual" and trigger_id is not None:
                try:
                    update_trigger_run_id(conn_pg, trigger_id, run_id)
                except Exception:
                    logger.warning("Could not update trigger run_id — non-fatal")
    finally:
        run_span_cm.__exit__(*sys.exc_info())
        release_run_lock(conn_pg)


# ---------------------------------------------------------------------------
# Scheduler loop (extracted for testability)
# ---------------------------------------------------------------------------


def _try_connect_4d(config) -> tuple[object, str | None]:
    """Open a 4D connection. Return (conn, None) on success, (None, error_msg) on failure.

    Used by the scheduler loop to reconnect lazily when 4D is unreachable at
    startup or has gone stale between runs. Logs the failure but does not raise.
    """
    from etl.db import fourd

    try:
        conn = fourd.get_connection(config)
        logger.info("4D connection established")
        return conn, None
    except Exception as exc:
        msg = f"Cannot connect to 4D: {exc}"
        logger.error(msg)
        return None, msg


def _refresh_4d_connection(conn_4d, config) -> tuple[object, str | None]:
    """Close any existing 4D connection and open a fresh one before each run.

    The scheduler loop sleeps for hours between firings, and the p4d socket
    held across that idle window often dies (server-side reset, firewall
    idle-timeout, network blip). When that happens the driver does not raise
    on send — it returns ``ProgrammingError(b'')`` for every query, so all
    24 syncs fail in 0 ms with an empty error and the run is logged as
    "todo falló". Reconnecting at the start of every scheduled job and
    every manual trigger is cheap and removes the stale-socket failure mode.
    """
    if conn_4d is not None:
        try:
            conn_4d.close()
        except Exception:
            pass  # best-effort; we're about to replace it anyway
    return _try_connect_4d(config)


def _record_connection_failure(
    conn_pg,
    trigger: str,
    trigger_id: int | None,
    err_msg: str,
) -> int | None:
    """Create a visible failed run when 4D could not be reached.

    Without this, manual triggers fired while 4D is down would silently sit
    in etl_manual_trigger and the dashboard's runs table would show nothing —
    the operator has no signal that the click did anything.

    Best-effort: every step is wrapped so a transient PG error doesn't abort
    the scheduler loop. Returns the run_id (or None if create_run failed).
    """
    from etl.db.postgres import (
        create_run,
        finish_run,
        record_table_sync,
        update_trigger_run_id,
    )

    try:
        run_id = create_run(conn_pg, trigger)
    except Exception:
        logger.exception(
            "Could not create failed-run row; trigger will not be visible in dashboard"
        )
        return None

    now = datetime.now(timezone.utc)
    try:
        record_table_sync(
            conn_pg,
            run_id,
            "(4d_connection)",
            0,
            0,
            status="failed",
            started_at=now,
            finished_at=now,
            error_msg=err_msg[:2000],
        )
    except Exception:
        logger.exception("Could not record connection-failure table row")

    try:
        finish_run(conn_pg, run_id, "failed", 0, 1, total_rows_synced=0)
    except Exception:
        logger.exception("Could not finish failed run row")

    if trigger == "manual" and trigger_id is not None:
        try:
            update_trigger_run_id(conn_pg, trigger_id, run_id)
        except Exception:
            logger.warning(
                "Could not link trigger %d to failed run %d", trigger_id, run_id
            )

    return run_id


def _run_scheduler_loop(
    config,
    conn_pg,
    conn_4d,
    cron_hour: int,
    *,
    delta_minute: int = 0,
    lookback_days: int = 1,
) -> None:
    """Blocking scheduler loop: registers the hourly delta + nightly full
    jobs, runs an initial sync on startup, then polls every 10 s for manual
    triggers.

    conn_4d may start as None (4D unreachable at process startup). Both the
    scheduled job and the manual-trigger branch reconnect lazily through this
    function's local `conn_4d`, so reconnects performed in one path are
    visible to the other. Any failure inside run_full_sync drops the
    connection so the next iteration reconnects from scratch.

    When 4D cannot be reached at trigger time, _record_connection_failure
    creates a visible failed run in the dashboard so the operator sees that
    "Sincronizar ahora" was acknowledged but couldn't complete.
    """
    import schedule

    from etl.db.postgres import check_and_consume_trigger, get_trigger_force_flags

    def _job(kind: str) -> None:
        """Scheduled job entry point. Updates the surrounding scope's conn_4d
        so the polling branch sees reconnects performed here.

        Always closes + reopens the 4D connection before the run: the cron
        may fire after a long idle wait and any socket held across that
        window is almost certainly stale (see _refresh_4d_connection)."""
        nonlocal conn_4d
        # Skip overlapping firings (a delta could land while the previous
        # full or delta is still running).
        if _is_run_active(conn_pg):
            logger.info(
                "Skipping scheduled %s sync — a run is already in progress", kind
            )
            return
        # Avoid the back-to-back full+delta pair at the nightly minute. Both
        # jobs are due at cron_hour:delta_minute; the daily full runs first
        # and finishes (clearing _is_run_active) BEFORE the delta job in the
        # same run_pending tick fires. The original "register full first"
        # comment was wrong — schedule.run_pending dispatches sequentially.
        # Drop the colliding delta explicitly.
        if kind == "delta":
            now = datetime.now(timezone.utc)
            if now.hour == cron_hour and now.minute == delta_minute:
                logger.info(
                    "Skipping delta at %02d:%02d — daily full just ran in this slot",
                    cron_hour,
                    delta_minute,
                )
                return
        conn_4d, err_msg = _refresh_4d_connection(conn_4d, config)
        if conn_4d is None:
            _record_connection_failure(
                conn_pg, "scheduled", None, err_msg or "4D unreachable"
            )
            return
        try:
            run_full_sync(
                conn_4d,
                conn_pg,
                trigger="scheduled",
                kind=kind,
                lookback_days=lookback_days,
            )
        except Exception:
            logger.exception(
                "Scheduled %s run_full_sync raised; dropping 4D connection for retry",
                kind,
            )
            try:
                conn_4d.close()
            except Exception:
                pass
            conn_4d = None

    # Nightly full — the heavy pass that catches hard-deletes by truncating
    # and reinserting the watermark-backed tables.
    schedule.every().day.at(f"{cron_hour:02d}:{delta_minute:02d}").do(_job, kind="full")
    # Hourly delta — at :MM past every hour. At the cron_hour:delta_minute
    # slot both jobs are due; the explicit wall-clock guard inside _job
    # drops this one so we don't get a full+delta pair in the same tick.
    schedule.every().hour.at(f":{delta_minute:02d}").do(_job, kind="delta")

    # Initial sync at startup so we don't wait an hour the first time. Use a
    # full sync so the operator gets a clean baseline immediately after deploy.
    logger.info("Running initial full sync on startup ...")
    _job(kind="full")

    while True:
        schedule.run_pending()
        if not _is_run_active(conn_pg):
            try:
                trigger_id = check_and_consume_trigger(conn_pg)
            except Exception:
                logger.exception(
                    "Failed to poll manual ETL trigger; will retry on next tick"
                )
                trigger_id = None

            if trigger_id is not None:
                # Manual triggers default to a delta sync — the "Sincronizar
                # ahora" button is meant to top up watermark-backed tables
                # (ventas, lineas_ventas, etc.) with a few seconds of work.
                # Only opt into the heavy full-refresh path when the operator
                # explicitly checked "force_full" in the dashboard dialog
                # (or set force_tables, which also resets watermarks). The
                # nightly cron at cron_hour:delta_minute keeps doing a full
                # to catch hard-deletes — see _job(kind="full").
                #
                # If reading the force flags fails, we DON'T silently fall
                # back to delta: the operator might have clicked "Forzar
                # resync completo" and degrading to delta with no UI signal
                # is misleading. Instead we record a failed run (visible in
                # the dashboard) and skip — the user retries, the next
                # attempt almost certainly succeeds since this read is a
                # single SELECT on the just-claimed trigger row.
                try:
                    flags = get_trigger_force_flags(conn_pg, trigger_id)
                except Exception as exc:
                    logger.exception(
                        "Failed to read force flags for trigger %d — "
                        "recording failed run instead of guessing kind",
                        trigger_id,
                    )
                    _record_connection_failure(
                        conn_pg,
                        "manual",
                        trigger_id,
                        f"Could not read trigger force flags: {exc}"[:2000],
                    )
                    time.sleep(10)
                    continue
                force_full, force_tables, _triggered_by = flags
                manual_kind = "full" if (force_full or bool(force_tables)) else "delta"
                logger.info(
                    "Manual trigger %d detected — starting %s sync "
                    "(force_full=%s, force_tables=%s)",
                    trigger_id,
                    manual_kind,
                    force_full,
                    force_tables,
                )
                # Same rationale as _job(): the polling loop may have been
                # idle for hours since the last run, so always refresh.
                conn_4d, err_msg = _refresh_4d_connection(conn_4d, config)
                if conn_4d is None:
                    _record_connection_failure(
                        conn_pg, "manual", trigger_id, err_msg or "4D unreachable"
                    )
                else:
                    try:
                        # Pass the already-read flags through so the watermark-
                        # reset block uses the SAME tuple that drove the kind
                        # selection — single source of truth, single DB read.
                        run_full_sync(
                            conn_4d,
                            conn_pg,
                            trigger="manual",
                            trigger_id=trigger_id,
                            kind=manual_kind,
                            force_flags=flags,
                            lookback_days=lookback_days,
                        )
                    except Exception:
                        logger.exception(
                            "run_full_sync raised; dropping 4D connection for retry"
                        )
                        try:
                            conn_4d.close()
                        except Exception:
                            pass
                        conn_4d = None
        time.sleep(10)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="PowerShop ETL orchestrator")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single full sync and exit (default: run scheduler)",
    )
    args = parser.parse_args()

    from etl.config import Config

    try:
        config = Config()
    except ValueError as exc:
        logger.error("Configuration error: %s", exc)
        sys.exit(1)

    # ETL_CRON_HOUR / ETL_DELTA_CRON_MINUTE are env-only; cron schedule
    # changes require container restart. cron_hour controls the nightly full;
    # delta_cron_minute controls the minute-of-hour for the hourly delta
    # (and also the minute the nightly full fires on cron_hour).
    cron_hour = _parse_cron_hour(os.environ.get("ETL_CRON_HOUR"))
    delta_cron_minute = _parse_cron_minute(os.environ.get("ETL_DELTA_CRON_MINUTE"))
    delta_lookback_days = _parse_lookback_days(
        os.environ.get("ETL_DELTA_LOOKBACK_DAYS")
    )

    from etl.db import postgres

    logger.info("Connecting to PostgreSQL ...")
    try:
        conn_pg = postgres.get_connection(config)
        logger.info("PostgreSQL connection OK")
    except Exception as exc:
        logger.error("Cannot connect to PostgreSQL: %s", exc)
        sys.exit(1)

    try:
        _init_schema(conn_pg)
    except Exception:
        logger.exception("Schema initialisation failed")
        try:
            conn_pg.close()
        except Exception:
            pass
        sys.exit(1)

    from etl.db.postgres import fail_orphan_running_runs

    try:
        n_orphan = fail_orphan_running_runs(conn_pg)
        if n_orphan:
            logger.warning(
                "Reconciled %d orphan etl_sync_runs row(s) stuck in running — "
                "likely a previous ETL process exited before finish_run",
                n_orphan,
            )
    except Exception:
        logger.exception(
            "Could not reconcile orphan etl_sync_runs rows; continuing anyway"
        )

    logger.info("Testing 4D connection to %s:%d ...", config.p4d_host, config.p4d_port)
    conn_4d, conn_err = _try_connect_4d(config)
    if conn_4d is None:
        if args.once:
            # --once is for CI / manual one-shots; without 4D it cannot do anything useful.
            logger.error("--once requires a working 4D connection; %s", conn_err)
            try:
                conn_pg.close()
            except Exception:
                pass
            sys.exit(1)
        # Scheduler mode: continue with conn_4d=None. The polling loop will
        # reconnect lazily and record visible failed runs for any manual
        # triggers that fire while 4D is unreachable. This avoids the
        # crash-loop pattern where Docker restarts the container every 20s
        # and pending triggers in etl_manual_trigger never get consumed.
        logger.warning(
            "Entering scheduler loop without 4D — manual triggers will produce "
            "visible failed runs in the dashboard until 4D becomes reachable."
        )

    try:
        if args.once:
            run_full_sync(conn_4d, conn_pg, trigger="cli", kind="full")
        else:
            logger.info(
                "Scheduler mode: hourly delta at :%02d, nightly full at %02d:%02d, lookback_days=%d",
                delta_cron_minute,
                cron_hour,
                delta_cron_minute,
                delta_lookback_days,
            )
            _run_scheduler_loop(
                config,
                conn_pg,
                conn_4d,
                cron_hour,
                delta_minute=delta_cron_minute,
                lookback_days=delta_lookback_days,
            )
    finally:
        if conn_4d is not None:
            try:
                conn_4d.close()
            except Exception:
                pass
        try:
            conn_pg.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
