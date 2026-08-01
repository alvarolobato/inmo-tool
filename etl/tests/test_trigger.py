"""Unit tests for the manual ETL trigger mechanism.

Covers:
  RISK-TRIG-1  check_and_consume_trigger returns trigger id (int) when a pending row exists
  RISK-TRIG-2  check_and_consume_trigger returns None when no pending row exists
  RISK-TRIG-3  Manual trigger fires run_full_sync with trigger='manual'
  RISK-TRIG-4  A second trigger while a run is active does NOT start a second run
  RISK-TRIG-5  run_full_sync passes trigger param to create_run
  RISK-TRIG-6  Scheduled runs still use trigger='scheduled'
  RISK-TRIG-7  check_and_consume_trigger marks row status='picked_up'
  RISK-TRIG-8  Transient poll error is logged and loop continues; run_full_sync not called
  RISK-TRIG-9  Integration: real PG trigger row → check_and_consume_trigger → manual run
"""

from __future__ import annotations

import sys
import types
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Stub out the `schedule` third-party library so these unit tests run without
# it being installed in the local dev environment (it IS listed in
# etl/requirements.txt and is always present in the Docker image).
# ---------------------------------------------------------------------------
if "schedule" not in sys.modules:
    _schedule_stub = types.ModuleType("schedule")
    _schedule_stub.run_pending = MagicMock()  # type: ignore[attr-defined]
    _schedule_stub.every = MagicMock()  # type: ignore[attr-defined]
    sys.modules["schedule"] = _schedule_stub


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_pg_conn(fetchone_result=None):
    """Return a mock psycopg2 connection whose cursor().fetchone() returns *fetchone_result*."""
    conn = MagicMock(name="conn_pg")
    cursor = MagicMock()
    cursor.__enter__.return_value = cursor
    cursor.__exit__.return_value = False
    cursor.fetchone.return_value = fetchone_result
    conn.cursor.return_value = cursor
    return conn


# ---------------------------------------------------------------------------
# RISK-TRIG-1/2/7: check_and_consume_trigger unit tests
# ---------------------------------------------------------------------------


class TestCheckAndConsumeTrigger:
    def test_returns_trigger_id_when_pending_row(self):
        from etl.db.postgres import check_and_consume_trigger

        conn = _make_pg_conn(fetchone_result=(42,))
        assert check_and_consume_trigger(conn) == 42
        conn.commit.assert_called_once()

    def test_returns_none_when_no_pending_row(self):
        from etl.db.postgres import check_and_consume_trigger

        conn = _make_pg_conn(fetchone_result=None)
        assert check_and_consume_trigger(conn) is None
        conn.commit.assert_called_once()

    def test_marks_status_picked_up(self):
        """The UPDATE must set status='picked_up' — verify the SQL sent to the cursor."""
        from etl.db.postgres import check_and_consume_trigger

        conn = _make_pg_conn(fetchone_result=(1,))
        check_and_consume_trigger(conn)

        cursor = conn.cursor.return_value
        executed_sql: str = cursor.execute.call_args.args[0]
        assert "picked_up" in executed_sql.lower(), (
            f"Expected 'picked_up' in executed SQL, got:\n{executed_sql}"
        )

    def test_rolls_back_on_exception(self):
        from etl.db.postgres import check_and_consume_trigger

        conn = MagicMock(name="conn_pg")
        conn.cursor.side_effect = RuntimeError("DB error")
        try:
            check_and_consume_trigger(conn)
        except RuntimeError:
            pass
        conn.rollback.assert_called_once()


# ---------------------------------------------------------------------------
# Shared constants used by unit and integration tests below
# ---------------------------------------------------------------------------

_SYNC_FN_PATHS = [
    "etl.sync.articulos.sync_articulos",
    "etl.sync.articulos.sync_catalogos",
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
    "etl.sync.ccstock.sync_ccstock",
]

_POSTGRES_HELPER_PATHS = [
    "etl.db.postgres.create_run",
    "etl.db.postgres.finish_run",
    "etl.db.postgres.get_watermark",
    "etl.db.postgres.set_watermark",
    "etl.db.postgres.record_table_sync",
    "etl.db.postgres.update_trigger_run_id",
]


def _run_full_sync_mocked(
    trigger: str = "scheduled", trigger_id: int | None = None
) -> dict:
    """Run run_full_sync with all external calls mocked; return captured mocks."""
    from etl.main import run_full_sync

    captured: dict = {}
    with ExitStack() as stack:
        for path in _SYNC_FN_PATHS:
            m = stack.enter_context(patch(path, return_value=100))
            captured[path.rsplit(".", 1)[-1]] = m

        for path in _POSTGRES_HELPER_PATHS:
            short = path.rsplit(".", 1)[-1]
            m = stack.enter_context(patch(path))
            captured[short] = m

        captured["create_run"].return_value = 99
        stack.enter_context(
            patch("etl.sync.articulos.get_ma_article_codes", return_value=[])
        )
        stack.enter_context(patch("etl.main._get_rows_total", return_value=None))

        conn_4d, conn_pg = MagicMock(), MagicMock()
        run_full_sync(conn_4d, conn_pg, trigger=trigger, trigger_id=trigger_id)

    return captured


# ---------------------------------------------------------------------------
# RISK-TRIG-5: run_full_sync passes trigger to create_run
# ---------------------------------------------------------------------------


class TestRunFullSyncTriggerParam:
    def test_manual_trigger_passed_to_create_run(self):
        mocks = _run_full_sync_mocked(trigger="manual")
        mocks["create_run"].assert_called_once()
        args = mocks["create_run"].call_args.args
        assert args[1] == "manual", f"Expected trigger='manual', got {args[1]!r}"

    def test_scheduled_trigger_passed_to_create_run(self):
        mocks = _run_full_sync_mocked(trigger="scheduled")
        mocks["create_run"].assert_called_once()
        args = mocks["create_run"].call_args.args
        assert args[1] == "scheduled", f"Expected trigger='scheduled', got {args[1]!r}"

    def test_default_trigger_is_scheduled(self):
        """run_full_sync() with no trigger arg defaults to 'scheduled'."""
        from etl.main import run_full_sync

        captured_trigger: list[str] = []

        def _capture_create_run(conn_pg, trigger, kind="full"):
            captured_trigger.append(trigger)
            return 1

        with ExitStack() as stack:
            for path in _SYNC_FN_PATHS:
                stack.enter_context(patch(path, return_value=0))
            for path in _POSTGRES_HELPER_PATHS:
                stack.enter_context(patch(path))
            stack.enter_context(
                patch("etl.db.postgres.create_run", _capture_create_run)
            )
            stack.enter_context(
                patch("etl.sync.articulos.get_ma_article_codes", return_value=[])
            )
            stack.enter_context(patch("etl.main._get_rows_total", return_value=None))
            run_full_sync(MagicMock(), MagicMock())

        assert captured_trigger == ["scheduled"]

    def test_update_trigger_run_id_called_for_manual(self):
        mocks = _run_full_sync_mocked(trigger="manual", trigger_id=1)
        mocks["update_trigger_run_id"].assert_called_once()
        args = mocks["update_trigger_run_id"].call_args.args
        assert args[1] == 1, f"Expected trigger_id=1, got {args[1]!r}"
        assert args[2] == 99, f"Expected run_id=99, got {args[2]!r}"

    def test_update_trigger_run_id_not_called_for_scheduled(self):
        mocks = _run_full_sync_mocked(trigger="scheduled")
        mocks["update_trigger_run_id"].assert_not_called()


# ---------------------------------------------------------------------------
# RISK-TRIG-3 & RISK-TRIG-4: scheduler loop behaviour
# ---------------------------------------------------------------------------


class TestSchedulerLoopTriggerCheck:
    def test_manual_trigger_fires_run_full_sync(self):
        """When a trigger is pending and no run is active, run_full_sync is called
        with trigger='manual' and the trigger_id. The default kind for manual
        triggers (force_full=False, force_tables=[]) is 'delta' — see the
        TestManualTriggerKind class below for the full kind matrix.

        Note: each scheduler firing closes + reopens the 4D connection (see
        _refresh_4d_connection), so run_full_sync is invoked with the *fresh*
        connection, not the one originally handed to the scheduler loop."""
        fresh_conn_4d = MagicMock(name="fresh_conn_4d")
        with (
            patch("etl.db.postgres.check_and_consume_trigger", return_value=7),
            patch(
                "etl.db.postgres.get_trigger_force_flags",
                return_value=(False, [], "dashboard"),
            ),
            patch("etl.main._is_run_active", return_value=False),
            patch("etl.main.run_full_sync") as mock_sync,
            patch("etl.main._try_connect_4d", return_value=(fresh_conn_4d, None)),
            patch("schedule.run_pending"),
            patch("time.sleep", side_effect=StopIteration),
        ):
            import etl.main as main_mod

            config = MagicMock()
            conn_4d, conn_pg = MagicMock(), MagicMock()
            try:
                main_mod._run_scheduler_loop(config, conn_pg, conn_4d, 2)
            except StopIteration:
                pass

            mock_sync.assert_any_call(
                fresh_conn_4d,
                conn_pg,
                trigger="manual",
                trigger_id=7,
                kind="delta",
                force_flags=(False, [], "dashboard"),
                lookback_days=1,
            )

    def test_second_trigger_while_active_is_not_consumed(self):
        """When a run is already active, check_and_consume_trigger is never called
        so the pending trigger row is preserved for the next poll tick.
        The startup _job() may call run_full_sync(trigger='scheduled'), but
        no manual-trigger call should occur."""
        with (
            patch("etl.db.postgres.check_and_consume_trigger") as mock_consume,
            patch("etl.main._is_run_active", return_value=True),
            patch("etl.main.run_full_sync") as mock_sync,
            patch("schedule.run_pending"),
            patch("time.sleep", side_effect=StopIteration),
        ):
            import etl.main as main_mod

            config = MagicMock()
            conn_4d, conn_pg = MagicMock(), MagicMock()
            try:
                main_mod._run_scheduler_loop(config, conn_pg, conn_4d, 2)
            except StopIteration:
                pass

            mock_consume.assert_not_called()
            # The loop skips the manual-trigger path while a run is active.
            # (The startup _job may have fired a scheduled call, but no manual trigger.)
            for call_args in mock_sync.call_args_list:
                assert call_args.kwargs.get("trigger") != "manual", (
                    f"run_full_sync should not be called with trigger='manual', got {call_args}"
                )

    def test_no_trigger_no_manual_run(self):
        """When check_and_consume_trigger returns None, run_full_sync is not called
        with a manual trigger (the startup _job may fire a scheduled call)."""
        with (
            patch("etl.db.postgres.check_and_consume_trigger", return_value=None),
            patch("etl.main._is_run_active", return_value=False),
            patch("etl.main.run_full_sync") as mock_sync,
            patch("schedule.run_pending"),
            patch("time.sleep", side_effect=StopIteration),
        ):
            import etl.main as main_mod

            config = MagicMock()
            conn_4d, conn_pg = MagicMock(), MagicMock()
            try:
                main_mod._run_scheduler_loop(config, conn_pg, conn_4d, 2)
            except StopIteration:
                pass

            for call_args in mock_sync.call_args_list:
                assert call_args.kwargs.get("trigger") != "manual", (
                    f"run_full_sync should not be called with trigger='manual', got {call_args}"
                )

    def test_poll_exception_does_not_crash_loop(self):
        """RISK-TRIG-7: transient DB error in check_and_consume_trigger is logged;
        the loop continues and run_full_sync is not called with a manual trigger."""
        with (
            patch(
                "etl.db.postgres.check_and_consume_trigger",
                side_effect=RuntimeError("transient"),
            ),
            patch("etl.main._is_run_active", return_value=False),
            patch("etl.main.run_full_sync") as mock_sync,
            patch("schedule.run_pending"),
            patch("time.sleep", side_effect=StopIteration),
        ):
            import etl.main as main_mod

            config = MagicMock()
            conn_4d, conn_pg = MagicMock(), MagicMock()
            try:
                main_mod._run_scheduler_loop(config, conn_pg, conn_4d, 2)
            except StopIteration:
                pass

            for call_args in mock_sync.call_args_list:
                assert call_args.kwargs.get("trigger") != "manual", (
                    f"run_full_sync should not be called with trigger='manual', got {call_args}"
                )


# ---------------------------------------------------------------------------
# Manual-trigger kind selection: default delta, opt-in to full
# ---------------------------------------------------------------------------


class TestManualTriggerKind:
    """The "Sincronizar ahora" button should default to a cheap delta and only
    escalate to a full when the operator opts in via force_full or force_tables.
    Before this change every manual click ran a full (~1h47m on prod), wasting
    cycles when the operator just wanted the freshest watermark-backed deltas.
    """

    def _run_loop_with_flags(
        self,
        force_full: bool,
        force_tables: list[str],
    ) -> dict:
        """Drive _run_scheduler_loop one tick with a fake trigger row whose
        force flags are (`force_full`, `force_tables`). Returns the kwargs of
        the (single) manual run_full_sync call observed."""
        fresh_conn_4d = MagicMock(name="fresh_conn_4d")
        with (
            patch("etl.db.postgres.check_and_consume_trigger", return_value=11),
            patch(
                "etl.db.postgres.get_trigger_force_flags",
                return_value=(force_full, force_tables, "dashboard"),
            ),
            patch("etl.main._is_run_active", return_value=False),
            patch("etl.main.run_full_sync") as mock_sync,
            patch("etl.main._try_connect_4d", return_value=(fresh_conn_4d, None)),
            patch("schedule.run_pending"),
            patch("time.sleep", side_effect=StopIteration),
        ):
            import etl.main as main_mod

            config = MagicMock()
            conn_4d, conn_pg = MagicMock(), MagicMock()
            try:
                main_mod._run_scheduler_loop(config, conn_pg, conn_4d, 2)
            except StopIteration:
                pass

            manual_calls = [
                c
                for c in mock_sync.call_args_list
                if c.kwargs.get("trigger") == "manual"
            ]
            assert len(manual_calls) == 1, (
                f"Expected exactly 1 manual run_full_sync call, got {manual_calls!r}"
            )
            return dict(manual_calls[0].kwargs)

    def test_default_trigger_is_delta(self):
        """force_full=False, force_tables=[] → kind='delta'. The base case for
        a plain "Sincronizar ahora" click."""
        kwargs = self._run_loop_with_flags(force_full=False, force_tables=[])
        assert kwargs["kind"] == "delta", (
            f"Expected kind='delta' for plain manual trigger, got {kwargs['kind']!r}"
        )

    def test_force_full_escalates_to_full(self):
        """force_full=True → kind='full'. The "Forzar resync completo"
        dialog opt-in must bypass the delta default."""
        kwargs = self._run_loop_with_flags(force_full=True, force_tables=[])
        assert kwargs["kind"] == "full", (
            f"Expected kind='full' for force_full=True, got {kwargs['kind']!r}"
        )

    def test_force_tables_escalates_to_full(self):
        """force_tables=['ventas'] → kind='full'. Resetting watermarks for
        a subset of tables only makes sense paired with the truncate-and-
        reinsert pass that 'full' provides; otherwise the watermark reset
        does nothing useful in delta mode."""
        kwargs = self._run_loop_with_flags(force_full=False, force_tables=["ventas"])
        assert kwargs["kind"] == "full", (
            f"Expected kind='full' for force_tables non-empty, got {kwargs['kind']!r}"
        )

    def test_flags_forwarded_to_run_full_sync(self):
        """The polling loop reads get_trigger_force_flags ONCE and passes the
        same tuple to run_full_sync via force_flags=. This avoids a second
        read inside run_full_sync and guarantees the kind selection upstream
        and the watermark-reset block downstream see identical flag values
        (Copilot + Opus review on PR #465). Verify the tuple is plumbed."""
        kwargs = self._run_loop_with_flags(force_full=True, force_tables=["ventas"])
        assert kwargs.get("force_flags") == (True, ["ventas"], "dashboard"), (
            "force_flags tuple should be forwarded to run_full_sync verbatim; "
            f"got {kwargs.get('force_flags')!r}"
        )

    def test_get_force_flags_failure_records_failed_run_and_skips_sync(self):
        """If reading the trigger row fails (e.g. transient DB error), we
        DON'T silently fall back to delta — the operator might have clicked
        "Forzar resync completo" and degrading to delta with no UI signal
        is misleading. Instead we record a visible failed run via
        _record_connection_failure and skip. The user retries; the next
        attempt almost certainly succeeds."""
        fresh_conn_4d = MagicMock(name="fresh_conn_4d")
        with (
            patch("etl.db.postgres.check_and_consume_trigger", return_value=12),
            patch(
                "etl.db.postgres.get_trigger_force_flags",
                side_effect=RuntimeError("transient DB error"),
            ),
            patch("etl.main._is_run_active", return_value=False),
            patch("etl.main.run_full_sync") as mock_sync,
            patch("etl.main._record_connection_failure") as mock_fail,
            patch("etl.main._try_connect_4d", return_value=(fresh_conn_4d, None)),
            patch("schedule.run_pending"),
            patch("time.sleep", side_effect=StopIteration),
        ):
            import etl.main as main_mod

            config = MagicMock()
            conn_4d, conn_pg = MagicMock(), MagicMock()
            try:
                main_mod._run_scheduler_loop(config, conn_pg, conn_4d, 2)
            except StopIteration:
                pass

            manual_calls = [
                c
                for c in mock_sync.call_args_list
                if c.kwargs.get("trigger") == "manual"
            ]
            assert manual_calls == [], (
                "run_full_sync must NOT be called when force-flags read fails — "
                f"got {manual_calls!r}"
            )
            mock_fail.assert_called_once()
            args = mock_fail.call_args.args
            assert args[1] == "manual" and args[2] == 12, (
                f"_record_connection_failure should be called with "
                f"(conn_pg, 'manual', 12, err_msg); got args={args!r}"
            )
            assert "transient DB error" in args[3], (
                f"err_msg should include the underlying exception text, got {args[3]!r}"
            )


# ---------------------------------------------------------------------------
# RISK-TRIG-9: Integration test (real PostgreSQL via pg_conn fixture)
# ---------------------------------------------------------------------------


class TestIntegrationTrigger:
    def test_integration_trigger_creates_manual_run(self, pg_conn):
        """Insert a trigger row, consume it, then run a mocked sync.

        Asserts check_and_consume_trigger marks status='picked_up' and that
        run_full_sync is called with trigger='manual'.
        Skipped automatically when no PostgreSQL config is present.
        """
        from etl.db.postgres import check_and_consume_trigger

        # Insert a pending trigger row
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO etl_manual_trigger (status) VALUES ('pending') RETURNING id"
            )
            trigger_id = cur.fetchone()[0]
        pg_conn.commit()

        try:
            found = check_and_consume_trigger(pg_conn)
            assert found == trigger_id, (
                f"check_and_consume_trigger should return trigger id {trigger_id}, got {found!r}"
            )

            # Row must be marked picked_up in the DB
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM etl_manual_trigger WHERE id = %s", (trigger_id,)
                )
                row = cur.fetchone()
            assert row is not None and row[0] == "picked_up", (
                f"Expected status='picked_up', got {row}"
            )

            # run_full_sync with mocked 4D — verify trigger='manual' reaches create_run
            with ExitStack() as stack:
                for path in _SYNC_FN_PATHS:
                    stack.enter_context(patch(path, return_value=0))

                mock_create_run = stack.enter_context(
                    patch("etl.db.postgres.create_run")
                )
                mock_create_run.return_value = 9999
                stack.enter_context(patch("etl.db.postgres.finish_run"))
                stack.enter_context(
                    patch("etl.db.postgres.get_watermark", return_value=None)
                )
                stack.enter_context(patch("etl.db.postgres.set_watermark"))
                stack.enter_context(patch("etl.db.postgres.record_table_sync"))
                stack.enter_context(patch("etl.db.postgres.update_trigger_run_id"))
                stack.enter_context(
                    patch("etl.sync.articulos.get_ma_article_codes", return_value=[])
                )
                stack.enter_context(
                    patch("etl.main._get_rows_total", return_value=None)
                )

                from etl.main import run_full_sync

                conn_4d = MagicMock()
                run_full_sync(conn_4d, pg_conn, trigger="manual", trigger_id=trigger_id)

                mock_create_run.assert_called_once()
                call_trigger = mock_create_run.call_args.args[1]
                assert call_trigger == "manual", (
                    f"Expected trigger='manual' passed to create_run, got {call_trigger!r}"
                )
        finally:
            # Always clean up the trigger row
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM etl_manual_trigger WHERE id = %s", (trigger_id,)
                )
            pg_conn.commit()
