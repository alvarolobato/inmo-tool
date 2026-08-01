"""Integration tests for ETL sync run monitoring helpers.

Tests 1-4 use a real PostgreSQL connection (pg_conn fixture from conftest.py).
The etl_sync_runs and etl_sync_run_tables tables are created from init.sql
before each test to ensure the schema is present. Tests 1-4 are skipped
automatically when the monitoring helpers are not yet available (PR #164).

Test 5 verifies that a create_run failure does not abort the sync pipeline
by patching all sync functions and monitoring helpers with mock objects.
The monitoring function patches use create=True so this test passes even
before PR #164 is merged (those functions do not exist yet).
"""

from __future__ import annotations

from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from etl.db import postgres

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

_MONITORING_AVAILABLE = hasattr(postgres, "create_run")

_requires_monitoring = pytest.mark.skipif(
    not _MONITORING_AVAILABLE,
    reason="monitoring helpers not yet merged (PR #164)",
)


def _apply_monitoring_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _cleanup_run(conn, run_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM etl_sync_run_tables WHERE run_id = %s", (run_id,))
        cur.execute("DELETE FROM etl_sync_runs WHERE id = %s", (run_id,))
    conn.commit()


class TestCreateRun:
    @_requires_monitoring
    def test_create_run_returns_id(self, pg_conn):
        """create_run returns a positive integer run_id and inserts a running row."""
        _apply_monitoring_schema(pg_conn)
        run_id = postgres.create_run(pg_conn, "manual")
        try:
            assert isinstance(run_id, int), f"Expected int, got {type(run_id)}"
            assert run_id > 0
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, trigger FROM etl_sync_runs WHERE id = %s",
                    (run_id,),
                )
                row = cur.fetchone()
            assert row is not None
            assert row[0] == "running"
            assert row[1] == "manual"
        finally:
            _cleanup_run(pg_conn, run_id)


class TestFailOrphanRunningRuns:
    @_requires_monitoring
    def test_marks_all_running_rows_failed(self, pg_conn):
        """fail_orphan_running_runs closes stuck running rows (e.g. after a worker crash)."""
        _apply_monitoring_schema(pg_conn)
        run_id_a = postgres.create_run(pg_conn, "scheduled")
        run_id_b = postgres.create_run(pg_conn, "manual")
        try:
            n = postgres.fail_orphan_running_runs(pg_conn)
            assert n == 2
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT id, status, finished_at FROM etl_sync_runs WHERE id IN (%s, %s) ORDER BY id",
                    (run_id_a, run_id_b),
                )
                rows = cur.fetchall()
            assert len(rows) == 2
            for _rid, status, finished_at in rows:
                assert status == "failed"
                assert finished_at is not None
        finally:
            _cleanup_run(pg_conn, run_id_a)
            _cleanup_run(pg_conn, run_id_b)

    @_requires_monitoring
    def test_no_rows_updated_when_nothing_running(self, pg_conn):
        _apply_monitoring_schema(pg_conn)
        run_id = postgres.create_run(pg_conn, "scheduled")
        try:
            postgres.finish_run(
                pg_conn,
                run_id,
                "success",
                tables_ok=1,
                tables_failed=0,
                total_rows_synced=0,
            )
            n = postgres.fail_orphan_running_runs(pg_conn)
            assert n == 0
        finally:
            _cleanup_run(pg_conn, run_id)


class TestFinishRun:
    @_requires_monitoring
    def test_finish_run_updates_status(self, pg_conn):
        """finish_run sets status, finished_at, and duration_ms in the DB."""
        _apply_monitoring_schema(pg_conn)
        run_id = postgres.create_run(pg_conn, "scheduled")
        try:
            postgres.finish_run(
                pg_conn,
                run_id,
                "success",
                tables_ok=22,
                tables_failed=0,
                total_rows_synced=50000,
            )
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, finished_at, duration_ms, tables_ok, tables_failed, total_tables, total_rows_synced "
                    "FROM etl_sync_runs WHERE id = %s",
                    (run_id,),
                )
                row = cur.fetchone()
            assert row is not None
            (
                status,
                finished_at,
                duration_ms,
                tables_ok,
                tables_failed,
                total_tables,
                total_rows,
            ) = row
            assert status == "success"
            assert finished_at is not None
            assert duration_ms is not None and duration_ms >= 0
            assert tables_ok == 22
            assert tables_failed == 0
            assert total_tables == 22
            assert total_rows == 50000
        finally:
            _cleanup_run(pg_conn, run_id)


class TestRecordTableSync:
    @_requires_monitoring
    def test_record_table_sync_inserts_row(self, pg_conn):
        """record_table_sync inserts one row with correct fields in etl_sync_run_tables."""
        _apply_monitoring_schema(pg_conn)
        run_id = postgres.create_run(pg_conn, "scheduled")
        try:
            started = datetime.now(timezone.utc)
            finished = datetime.now(timezone.utc)
            postgres.record_table_sync(
                pg_conn,
                run_id=run_id,
                table_name="ps_ventas",
                started_at=started,
                finished_at=finished,
                duration_ms=1500,
                status="success",
                rows_synced=1234,
                sync_method="upsert_delta",
                rows_total_after=911000,
            )
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT table_name, status, rows_synced, sync_method, rows_total_after,"
                    " watermark_from, watermark_to, error_msg "
                    "FROM etl_sync_run_tables WHERE run_id = %s",
                    (run_id,),
                )
                rows = cur.fetchall()
            assert len(rows) == 1
            (
                table_name,
                status,
                rows_synced,
                sync_method,
                rows_total,
                wm_from,
                wm_to,
                error_msg,
            ) = rows[0]
            assert table_name == "ps_ventas"
            assert status == "success"
            assert rows_synced == 1234
            assert sync_method == "upsert_delta"
            assert rows_total == 911000
            assert wm_from is None
            assert wm_to is None
            assert error_msg is None
        finally:
            _cleanup_run(pg_conn, run_id)

    @_requires_monitoring
    def test_record_table_sync_failure_row_with_new_fields(self, pg_conn):
        """record_table_sync persists watermark_from, watermark_to, and error_msg for failed rows."""
        _apply_monitoring_schema(pg_conn)
        run_id = postgres.create_run(pg_conn, "scheduled")
        try:
            wm_from = datetime.now(timezone.utc)
            wm_to = datetime.now(timezone.utc)
            postgres.record_table_sync(
                pg_conn,
                run_id=run_id,
                table_name="ps_ventas",
                started_at=wm_from,
                finished_at=wm_to,
                duration_ms=500,
                status="failed",
                rows_synced=0,
                sync_method="upsert_delta",
                rows_total_after=None,
                watermark_from=wm_from,
                watermark_to=wm_to,
                error_msg="simulated failure",
            )
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT watermark_from, watermark_to, error_msg "
                    "FROM etl_sync_run_tables WHERE run_id = %s",
                    (run_id,),
                )
                rows = cur.fetchall()
            assert len(rows) == 1
            db_wm_from, db_wm_to, db_error_msg = rows[0]
            assert db_wm_from is not None
            assert db_wm_to is not None
            assert db_error_msg == "simulated failure"
        finally:
            _cleanup_run(pg_conn, run_id)


class TestPartialStatus:
    @_requires_monitoring
    def test_failed_run_sets_partial_status(self, pg_conn):
        """When tables_failed > 0, finish_run persists status=partial in the DB."""
        _apply_monitoring_schema(pg_conn)
        run_id = postgres.create_run(pg_conn, "scheduled")
        try:
            postgres.finish_run(
                pg_conn,
                run_id,
                "partial",
                tables_ok=21,
                tables_failed=1,
                total_rows_synced=45000,
            )
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, tables_ok, tables_failed FROM etl_sync_runs WHERE id = %s",
                    (run_id,),
                )
                row = cur.fetchone()
            assert row is not None
            status, tables_ok, tables_failed = row
            assert status == "partial", f"Expected partial, got {status!r}"
            assert tables_ok == 21
            assert tables_failed == 1
        finally:
            _cleanup_run(pg_conn, run_id)


# Keep in sync with run_full_sync in etl/main.py
_WM_MODULE = "etl.db.postgres"
_SYNC_TARGETS = [
    "etl.sync.articulos.sync_catalogos",
    "etl.sync.articulos.sync_articulos",
    "etl.sync.maestros.sync_tiendas",
    "etl.sync.maestros.sync_clientes",
    "etl.sync.maestros.sync_proveedores",
    "etl.sync.maestros.sync_gc_comerciales",
    "etl.sync.ventas.sync_ventas",
    "etl.sync.ventas.sync_lineas_ventas",
    "etl.sync.ventas.sync_pagos_ventas",
    "etl.sync.mayorista.sync_gc_albaranes",
    "etl.sync.mayorista.sync_gc_lin_albarane",
    "etl.sync.mayorista.sync_gc_facturas",
    "etl.sync.mayorista.sync_gc_lin_facturas",
    "etl.sync.mayorista.sync_gc_pedidos",
    "etl.sync.mayorista.sync_gc_lin_pedidos",
    "etl.sync.compras.sync_compras",
    "etl.sync.compras.sync_lineas_compras",
    "etl.sync.compras.sync_facturas",
    "etl.sync.compras.sync_albaranes",
    "etl.sync.compras.sync_facturas_compra",
    "etl.sync.stock.sync_stock",
    "etl.sync.stock.sync_traspasos",
]

_SYNC_FUNCTION_NAMES = {t.rsplit(".", 1)[-1] for t in _SYNC_TARGETS}


class TestMonitoringResilience:
    def test_monitoring_failure_does_not_abort_sync(self):
        """If create_run raises, run_full_sync continues and syncs all tables.

        Monitoring function patches use create=True so this test runs even before
        the PR #164 monitoring helpers are merged (functions may not exist yet).
        """
        conn_4d = MagicMock()
        conn_pg = MagicMock()
        called: list[str] = []

        def _track(name):
            def _fn(*args, **kwargs):
                called.append(name)
                return {} if name == "sync_catalogos" else 0

            return _fn

        with ExitStack() as stack:
            for target in _SYNC_TARGETS:
                name = target.rsplit(".", 1)[-1]
                stack.enter_context(patch(target, side_effect=_track(name)))
            stack.enter_context(patch(f"{_WM_MODULE}.get_watermark", return_value=None))
            stack.enter_context(patch(f"{_WM_MODULE}.set_watermark"))
            stack.enter_context(
                patch(
                    f"{_WM_MODULE}.create_run",
                    side_effect=RuntimeError("db down"),
                    create=True,
                )
            )
            stack.enter_context(patch(f"{_WM_MODULE}.finish_run", create=True))
            stack.enter_context(patch(f"{_WM_MODULE}.record_table_sync", create=True))
            stack.enter_context(
                patch("etl.main._get_rows_total", return_value=None, create=True)
            )
            stack.enter_context(patch("etl.main._cleanup_ma_linked_rows"))
            from etl.main import run_full_sync

            run_full_sync(conn_4d, conn_pg)

        assert _SYNC_FUNCTION_NAMES == set(called), (
            f"Not all sync functions were called. Missing: {_SYNC_FUNCTION_NAMES - set(called)}"
        )


class TestForceResyncFromTrigger:
    """Manual trigger's force_full / force_tables must clear watermarks before sync."""

    def _run_with_trigger(
        self,
        *,
        force_full: bool,
        force_tables: list[str],
    ):
        conn_4d = MagicMock()
        conn_pg = MagicMock()

        with ExitStack() as stack:
            for target in _SYNC_TARGETS:
                stack.enter_context(
                    patch(
                        target,
                        side_effect=lambda *a, _n=target, **kw: (
                            {"x": 1} if _n.endswith("sync_catalogos") else 1
                        ),
                    )
                )
            stack.enter_context(patch(f"{_WM_MODULE}.get_watermark", return_value=None))
            stack.enter_context(patch(f"{_WM_MODULE}.set_watermark"))
            stack.enter_context(
                patch(f"{_WM_MODULE}.create_run", return_value=1, create=True)
            )
            stack.enter_context(patch(f"{_WM_MODULE}.finish_run", create=True))
            stack.enter_context(patch(f"{_WM_MODULE}.record_table_sync", create=True))
            stack.enter_context(patch(f"{_WM_MODULE}.update_trigger_run_id"))
            stack.enter_context(
                patch(
                    f"{_WM_MODULE}.get_trigger_force_flags",
                    return_value=(force_full, force_tables, "dashboard"),
                    create=True,
                )
            )
            reset_mock = stack.enter_context(
                patch(f"{_WM_MODULE}.reset_watermarks", create=True)
            )
            reset_mock.return_value = 0
            stack.enter_context(
                patch("etl.main._get_rows_total", return_value=None, create=True)
            )
            stack.enter_context(patch("etl.main._cleanup_ma_linked_rows"))

            from etl.main import run_full_sync

            run_full_sync(conn_4d, conn_pg, trigger="manual", trigger_id=42)
            return reset_mock

    def test_force_full_resets_all_watermarked_syncs(self):
        from etl.main import SYNC_NAMES_WITH_WATERMARK

        reset_mock = self._run_with_trigger(force_full=True, force_tables=[])
        reset_mock.assert_called_once()
        names = reset_mock.call_args.args[1]
        assert set(names) == set(SYNC_NAMES_WITH_WATERMARK)

    def test_force_tables_resets_only_named(self):
        reset_mock = self._run_with_trigger(
            force_full=False, force_tables=["stock", "ventas"]
        )
        reset_mock.assert_called_once()
        names = reset_mock.call_args.args[1]
        assert sorted(names) == ["stock", "ventas"]

    def test_unknown_force_table_is_filtered(self):
        reset_mock = self._run_with_trigger(
            force_full=False, force_tables=["stock", "not_a_real_table"]
        )
        reset_mock.assert_called_once()
        names = reset_mock.call_args.args[1]
        assert names == ["stock"]

    def test_no_force_flags_does_not_call_reset(self):
        reset_mock = self._run_with_trigger(force_full=False, force_tables=[])
        reset_mock.assert_not_called()


class TestTotalRowsSyncedAccumulator:
    """run_full_sync must accumulate per-table rows and pass the sum to finish_run.

    Prior to issue #398 the call to finish_run omitted ``total_rows_synced`` so
    the Monitor ETL "Filas sincronizadas" KPI was always 0 despite
    etl_sync_run_tables.rows_synced being populated correctly.
    """

    def test_finish_run_receives_sum_of_table_rows(self):
        conn_4d = MagicMock()
        conn_pg = MagicMock()

        # Assign a deterministic row count per sync function so we can verify
        # the expected sum. Catalogos returns a dict (its helper sums values).
        per_fn_rows = 7
        num_fns = len(_SYNC_TARGETS)  # 22 sync fns exercised in run_full_sync
        # Catalogos returns {"x": 7, "y": 7} via the _run_sync_catalogos wrapper,
        # which will sum to 14. All others return 7. Expected total:
        #   (num_fns - 1) * 7  +  14
        expected_total = (num_fns - 1) * per_fn_rows + 2 * per_fn_rows

        def _rows(name):
            def _fn(*args, **kwargs):
                if name == "sync_catalogos":
                    return {"a": per_fn_rows, "b": per_fn_rows}
                return per_fn_rows

            return _fn

        with ExitStack() as stack:
            for target in _SYNC_TARGETS:
                name = target.rsplit(".", 1)[-1]
                stack.enter_context(patch(target, side_effect=_rows(name)))
            stack.enter_context(patch(f"{_WM_MODULE}.get_watermark", return_value=None))
            stack.enter_context(patch(f"{_WM_MODULE}.set_watermark"))
            create_run_mock = stack.enter_context(
                patch(f"{_WM_MODULE}.create_run", return_value=1, create=True)
            )
            finish_run_mock = stack.enter_context(
                patch(f"{_WM_MODULE}.finish_run", create=True)
            )
            stack.enter_context(patch(f"{_WM_MODULE}.record_table_sync", create=True))
            stack.enter_context(patch(f"{_WM_MODULE}.update_trigger_run_id"))
            stack.enter_context(
                patch("etl.main._get_rows_total", return_value=None, create=True)
            )
            stack.enter_context(patch("etl.main._cleanup_ma_linked_rows"))

            from etl.main import run_full_sync

            run_full_sync(conn_4d, conn_pg)

        assert create_run_mock.call_count == 1
        finish_run_mock.assert_called_once()
        kwargs = finish_run_mock.call_args.kwargs
        assert "total_rows_synced" in kwargs, (
            "finish_run must receive total_rows_synced so the KPI is populated"
        )
        assert kwargs["total_rows_synced"] == expected_total, (
            f"Expected {expected_total} total rows, got {kwargs['total_rows_synced']}"
        )

    def test_failed_sync_does_not_add_to_total(self):
        """If a sync function raises, _run_sync returns (0, False) so the
        total_rows_synced accumulator is unaffected by that table."""
        conn_4d = MagicMock()
        conn_pg = MagicMock()

        def _raise(*args, **kwargs):
            raise RuntimeError("simulated failure")

        def _make_fn(name):
            if name == "sync_stock":
                return _raise
            if name == "sync_catalogos":
                # Single-entry dict sums to 5.
                return lambda *a, **kw: {"x": 5}
            return lambda *a, **kw: 5

        with ExitStack() as stack:
            for target in _SYNC_TARGETS:
                short = target.rsplit(".", 1)[-1]
                stack.enter_context(patch(target, side_effect=_make_fn(short)))
            stack.enter_context(patch(f"{_WM_MODULE}.get_watermark", return_value=None))
            stack.enter_context(patch(f"{_WM_MODULE}.set_watermark"))
            stack.enter_context(
                patch(f"{_WM_MODULE}.create_run", return_value=1, create=True)
            )
            finish_run_mock = stack.enter_context(
                patch(f"{_WM_MODULE}.finish_run", create=True)
            )
            stack.enter_context(patch(f"{_WM_MODULE}.record_table_sync", create=True))
            stack.enter_context(patch(f"{_WM_MODULE}.update_trigger_run_id"))
            stack.enter_context(
                patch("etl.main._get_rows_total", return_value=None, create=True)
            )
            stack.enter_context(patch("etl.main._cleanup_ma_linked_rows"))

            from etl.main import run_full_sync

            run_full_sync(conn_4d, conn_pg)

        finish_run_mock.assert_called_once()
        kwargs = finish_run_mock.call_args.kwargs
        # 22 sync targets total; sync_stock raises (contributes 0). The other
        # 21 each contribute 5 rows. Expected = 21 * 5 = 105.
        expected = (len(_SYNC_TARGETS) - 1) * 5
        assert kwargs["total_rows_synced"] == expected, (
            f"Expected failed sync to contribute 0, got {kwargs['total_rows_synced']}"
        )
