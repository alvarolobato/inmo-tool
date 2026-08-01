"""Unit tests for etl/main.py orchestrator.

No real database connections are needed — all sync functions and watermark
helpers are mocked via unittest.mock.

Test coverage:
- test_sync_order          : All sync functions are called in the correct
                             topological order (catalog → masters → ventas →
                             mayorista → compras → stock).
- test_error_continues     : A failure in one sync function does not prevent
                             subsequent functions from running.
- test_watermark_not_updated_on_error : When a sync function raises, set_watermark
                             is called with status='error' and rows_synced=0.
"""

from __future__ import annotations

from contextlib import ExitStack
from unittest.mock import MagicMock, patch

_WM_MODULE = "etl.db.postgres"

# All sync targets that must be patched in every test, keyed by dotted path.
# Order matches the pipeline in etl/main.py run_full_sync().
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

# Short name derived from the dotted path (last segment).
_SHORT_NAMES = [t.rsplit(".", 1)[-1] for t in _SYNC_TARGETS]


def _make_conn():
    return MagicMock()


def _apply_patches(stack: ExitStack, side_effects: dict) -> dict:
    """Enter all sync patches + watermark patches into *stack*.

    *side_effects* maps short function name to a callable side_effect or a
    return_value (int/dict).  Targets not in *side_effects* default to
    ``return_value=0`` (except sync_catalogos which defaults to ``return_value={}``).

    Returns a dict mapping short name → mock object.
    """
    mocks: dict[str, MagicMock] = {}
    for target, name in zip(_SYNC_TARGETS, _SHORT_NAMES):
        effect = side_effects.get(name)
        if callable(effect) and not isinstance(effect, MagicMock):
            m = stack.enter_context(patch(target, side_effect=effect))
        elif isinstance(effect, MagicMock):
            m = stack.enter_context(patch(target, effect))
        else:
            default = {} if name == "sync_catalogos" else 0
            rv = side_effects.get(name, default)
            m = stack.enter_context(patch(target, return_value=rv))
        mocks[name] = m

    mocks["get_watermark"] = stack.enter_context(
        patch(f"{_WM_MODULE}.get_watermark", return_value=None)
    )
    mocks["set_watermark"] = stack.enter_context(patch(f"{_WM_MODULE}.set_watermark"))
    return mocks


# ---------------------------------------------------------------------------
# Test: execution order
# ---------------------------------------------------------------------------


def test_sync_order():
    """All sync functions are invoked in the required topological order."""
    conn_4d = _make_conn()
    conn_pg = _make_conn()
    call_order: list[str] = []

    def _tracker(name):
        def _fn(*args, **kwargs):
            call_order.append(name)
            return {} if name == "sync_catalogos" else 0

        return _fn

    side_effects = {name: _tracker(name) for name in _SHORT_NAMES}

    with ExitStack() as stack:
        _apply_patches(stack, side_effects)
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    expected_order = [
        # Catalog — catalogos first so TRUNCATE CASCADE on catalog tables
        # doesn't wipe ps_articulos (which FKs into all five catalogs).
        "sync_catalogos",
        "sync_articulos",
        # Masters
        "sync_tiendas",
        "sync_clientes",
        "sync_proveedores",
        "sync_gc_comerciales",
        # Retail sales (run before stock — stock is slow)
        "sync_ventas",
        "sync_lineas_ventas",
        "sync_pagos_ventas",
        # Wholesale
        "sync_gc_albaranes",
        "sync_gc_lin_albarane",
        "sync_gc_facturas",
        "sync_gc_lin_facturas",
        "sync_gc_pedidos",
        "sync_gc_lin_pedidos",
        # Purchasing
        "sync_compras",
        "sync_lineas_compras",
        "sync_facturas",
        "sync_albaranes",
        "sync_facturas_compra",
        # Stock last (Exportaciones is very slow — ~2M rows)
        "sync_stock",
        "sync_traspasos",
    ]
    assert call_order == expected_order


# ---------------------------------------------------------------------------
# Test: error in one table does not stop the rest
# ---------------------------------------------------------------------------


def test_error_continues():
    """A failure in sync_ventas does not prevent subsequent tables from running."""
    conn_4d = _make_conn()
    conn_pg = _make_conn()
    called: list[str] = []

    def _tracker(name):
        def _fn(*args, **kwargs):
            called.append(name)
            return {} if name == "sync_catalogos" else 0

        return _fn

    def _ventas_boom(*args, **kwargs):
        called.append("sync_ventas")
        raise RuntimeError("simulated ventas failure")

    side_effects = {name: _tracker(name) for name in _SHORT_NAMES}
    side_effects["sync_ventas"] = _ventas_boom

    with ExitStack() as stack:
        _apply_patches(stack, side_effects)
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    # ventas failed, but everything after it should still have run
    assert "sync_ventas" in called
    assert "sync_lineas_ventas" in called
    assert "sync_pagos_ventas" in called
    assert "sync_gc_albaranes" in called
    assert "sync_compras" in called
    assert "sync_facturas_compra" in called


# ---------------------------------------------------------------------------
# Test: watermark written with status='error' on failure
# ---------------------------------------------------------------------------


def test_watermark_not_updated_on_error():
    """When a sync function raises, set_watermark is called with status='error' and rows_synced=0."""
    conn_4d = _make_conn()
    conn_pg = _make_conn()

    def _articulos_boom(*args, **kwargs):
        raise ValueError("simulated articulos error")

    side_effects = {"sync_articulos": _articulos_boom}

    with ExitStack() as stack:
        mocks = _apply_patches(stack, side_effects)
        mock_set_wm = mocks["set_watermark"]
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    # set_watermark(conn_pg, table_name, last_sync_at, rows_synced, status, error_msg)
    # args[0]=conn_pg, args[1]=table_name, args[2]=last_sync_at,
    # args[3]=rows_synced, args[4]=status, args[5]=error_msg
    articulos_calls = [
        c for c in mock_set_wm.call_args_list if c.args[1] == "articulos"
    ]
    assert articulos_calls, "set_watermark was not called for 'articulos'"

    error_call = articulos_calls[0]
    args = error_call.args
    assert args[3] == 0, f"Expected rows_synced=0, got {args[3]}"
    assert args[4] == "error", f"Expected status='error', got {args[4]!r}"
    assert len(args) > 5, "set_watermark was not called with error_msg"
    assert "simulated articulos error" in args[5]


# ---------------------------------------------------------------------------
# Test: MA cleanup is called after all syncs complete
# ---------------------------------------------------------------------------


def test_ma_cleanup_is_invoked():
    """_cleanup_ma_linked_rows is called after all sync steps in run_full_sync."""
    conn_4d = _make_conn()
    conn_pg = _make_conn()
    cleanup_called: list[bool] = []

    def _cleanup_mock(c4d, cpg):
        cleanup_called.append(True)

    with ExitStack() as stack:
        _apply_patches(stack, {})
        stack.enter_context(
            patch("etl.main._cleanup_ma_linked_rows", side_effect=_cleanup_mock)
        )
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    assert cleanup_called, "_cleanup_ma_linked_rows was not called by run_full_sync"


def test_ma_cleanup_failure_does_not_abort_pipeline():
    """A failure in _cleanup_ma_linked_rows is swallowed — the pipeline completes."""
    conn_4d = _make_conn()
    conn_pg = _make_conn()
    stock_called: list[bool] = []

    def _cleanup_boom(c4d, cpg):
        raise RuntimeError("simulated MA cleanup failure")

    def _track_stock(*args, **kwargs):
        stock_called.append(True)
        return 0

    with ExitStack() as stack:
        side_effects = {"sync_traspasos": _track_stock}
        _apply_patches(stack, side_effects)
        stack.enter_context(
            patch("etl.main._cleanup_ma_linked_rows", side_effect=_cleanup_boom)
        )
        from etl.main import run_full_sync

        # Must not raise
        run_full_sync(conn_4d, conn_pg)

    # sync_traspasos runs before cleanup — we verify the pipeline completed normally
    assert stock_called, "sync_traspasos was not called; pipeline may have aborted"


# ---------------------------------------------------------------------------
# Tests: ETL_CRON_HOUR validation (_parse_cron_hour helper)
# ---------------------------------------------------------------------------


def test_cron_hour_out_of_range_defaults_to_2(caplog):
    """ETL_CRON_HOUR outside [0, 23] defaults to 2 with a warning."""
    import logging

    from etl.main import _parse_cron_hour

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_cron_hour("99")

    assert result == 2
    assert "ETL_CRON_HOUR=99 out of range" in caplog.text


def test_cron_hour_negative_defaults_to_2(caplog):
    """Negative ETL_CRON_HOUR defaults to 2 with a warning."""
    import logging

    from etl.main import _parse_cron_hour

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_cron_hour("-1")

    assert result == 2
    assert "ETL_CRON_HOUR=-1 out of range" in caplog.text


def test_cron_hour_valid_values_unchanged():
    """ETL_CRON_HOUR within [0, 23] is returned as-is."""
    from etl.main import _parse_cron_hour

    assert _parse_cron_hour("0") == 0
    assert _parse_cron_hour("2") == 2
    assert _parse_cron_hour("23") == 23


def test_cron_hour_none_defaults_to_2():
    """None (env var not set) returns the default of 2."""
    from etl.main import _parse_cron_hour

    assert _parse_cron_hour(None) == 2


def test_cron_hour_non_integer_defaults_to_2(caplog):
    """Non-integer ETL_CRON_HOUR defaults to 2 with a warning."""
    import logging

    from etl.main import _parse_cron_hour

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_cron_hour("abc")

    assert result == 2
    assert "not an integer" in caplog.text


# Tests: ETL_DELTA_CRON_MINUTE validation (_parse_cron_minute helper)
# ---------------------------------------------------------------------------


def test_delta_cron_minute_non_integer_defaults_to_0(caplog):
    """Non-integer ETL_DELTA_CRON_MINUTE defaults to 0 with a warning."""
    import logging

    from etl.main import _parse_cron_minute

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_cron_minute("abc")

    assert result == 0
    assert "not an integer" in caplog.text


def test_delta_cron_minute_out_of_range_defaults_to_0(caplog):
    """ETL_DELTA_CRON_MINUTE outside [0, 59] defaults to 0 with a warning."""
    import logging

    from etl.main import _parse_cron_minute

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_cron_minute("99")

    assert result == 0
    assert "out of range" in caplog.text


def test_delta_cron_minute_negative_defaults_to_0(caplog):
    """Negative ETL_DELTA_CRON_MINUTE defaults to 0 with a warning."""
    import logging

    from etl.main import _parse_cron_minute

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_cron_minute("-1")

    assert result == 0
    assert "out of range" in caplog.text


def test_delta_cron_minute_valid_values_unchanged():
    """ETL_DELTA_CRON_MINUTE within [0, 59] is returned as-is."""
    from etl.main import _parse_cron_minute

    assert _parse_cron_minute("0") == 0
    assert _parse_cron_minute("30") == 30
    assert _parse_cron_minute("59") == 59


def test_delta_cron_minute_none_defaults_to_0():
    """None (env var not set) returns the default of 0."""
    from etl.main import _parse_cron_minute

    assert _parse_cron_minute(None) == 0


# ---------------------------------------------------------------------------
# Tests: ETL_DELTA_LOOKBACK_DAYS validation (_parse_lookback_days helper)
# ---------------------------------------------------------------------------


def test_lookback_days_none_defaults_to_1():
    """None (env var not set) returns the default of 1."""
    from etl.main import _parse_lookback_days

    assert _parse_lookback_days(None) == 1


def test_lookback_days_valid_values_unchanged():
    """Valid non-negative integer values are returned as-is."""
    from etl.main import _parse_lookback_days

    assert _parse_lookback_days("0") == 0
    assert _parse_lookback_days("1") == 1
    assert _parse_lookback_days("2") == 2
    assert _parse_lookback_days("7") == 7


def test_lookback_days_negative_defaults_to_1(caplog):
    """Negative ETL_DELTA_LOOKBACK_DAYS defaults to 1 with a warning."""
    import logging

    from etl.main import _parse_lookback_days

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_lookback_days("-1")

    assert result == 1
    assert "is negative" in caplog.text


def test_lookback_days_non_integer_defaults_to_1(caplog):
    """Non-integer ETL_DELTA_LOOKBACK_DAYS defaults to 1 with a warning."""
    import logging

    from etl.main import _parse_lookback_days

    with caplog.at_level(logging.WARNING, logger="etl"):
        result = _parse_lookback_days("abc")

    assert result == 1
    assert "not an integer" in caplog.text


# ---------------------------------------------------------------------------
# Tests: lookback window applied in delta runs
# ---------------------------------------------------------------------------


class TestDeltaLookbackWindow:
    """Integration test: delta runs subtract lookback_days from the watermark.

    Scenario: watermark advanced to 2026-05-03 (past the delayed rows), but
    ETL_DELTA_LOOKBACK_DAYS=1 means the next delta queries from 2026-05-02,
    catching rows that arrived with FechaModifica=2026-05-02 (H3 replication
    delay protection, issue #459).
    """

    def _run_delta_with_lookback(self, lookback_days: int) -> object:
        """Run a single delta sync and capture the `since` argument received by
        the sync function.  Returns the captured `since` value."""
        from contextlib import ExitStack
        from datetime import datetime, timezone
        from unittest.mock import MagicMock, patch

        from etl.main import _run_sync

        watermark = datetime(2026, 5, 3, tzinfo=timezone.utc)
        captured_since = []

        def fake_sync_fn(conn_4d, conn_pg, since):
            captured_since.append(since)
            return 0

        with ExitStack() as stack:
            stack.enter_context(
                patch("etl.db.postgres.get_watermark", return_value=watermark)
            )
            stack.enter_context(patch("etl.db.postgres.set_watermark"))
            stack.enter_context(patch("etl.db.postgres.record_table_sync"))

            conn_4d = MagicMock()
            conn_pg = MagicMock()
            _run_sync(
                "ventas",
                fake_sync_fn,
                conn_4d,
                conn_pg,
                uses_watermark=True,
                kind="delta",
                lookback_days=lookback_days,
            )

        assert len(captured_since) == 1, "sync function was not called exactly once"
        return captured_since[0]

    def test_lookback_days_1_subtracts_one_day(self):
        """lookback_days=1: since = watermark - 1 day (2026-05-03 → 2026-05-02)."""
        from datetime import datetime, timezone

        since = self._run_delta_with_lookback(lookback_days=1)
        expected = datetime(2026, 5, 2, tzinfo=timezone.utc)
        assert since == expected, f"Expected {expected!r}, got {since!r}"

    def test_lookback_days_0_passes_exact_watermark(self):
        """lookback_days=0: since = watermark exactly (no subtraction)."""
        from datetime import datetime, timezone

        since = self._run_delta_with_lookback(lookback_days=0)
        expected = datetime(2026, 5, 3, tzinfo=timezone.utc)
        assert since == expected, f"Expected {expected!r}, got {since!r}"

    def test_lookback_days_2_subtracts_two_days(self):
        """lookback_days=2: since = watermark - 2 days (2026-05-03 → 2026-05-01)."""
        from datetime import datetime, timezone

        since = self._run_delta_with_lookback(lookback_days=2)
        expected = datetime(2026, 5, 1, tzinfo=timezone.utc)
        assert since == expected, f"Expected {expected!r}, got {since!r}"

    def test_full_run_ignores_lookback(self):
        """Full runs pass since=None regardless of lookback_days."""
        from contextlib import ExitStack
        from unittest.mock import MagicMock, patch

        from etl.main import _run_sync

        captured_since = []

        def fake_sync_fn(conn_4d, conn_pg, since):
            captured_since.append(since)
            return 0

        with ExitStack() as stack:
            stack.enter_context(
                patch("etl.db.postgres.get_watermark", return_value=None)
            )
            stack.enter_context(patch("etl.db.postgres.set_watermark"))
            stack.enter_context(patch("etl.db.postgres.record_table_sync"))

            conn_4d = MagicMock()
            conn_pg = MagicMock()
            _run_sync(
                "ventas",
                fake_sync_fn,
                conn_4d,
                conn_pg,
                uses_watermark=True,
                kind="full",
                lookback_days=7,
            )

        assert captured_since[0] is None, (
            f"Full run should pass since=None, got {captured_since[0]!r}"
        )

    def test_null_watermark_skips_lookback(self):
        """When no watermark exists (first run), lookback is not applied and since=None."""
        from contextlib import ExitStack
        from unittest.mock import MagicMock, patch

        from etl.main import _run_sync

        captured_since = []

        def fake_sync_fn(conn_4d, conn_pg, since):
            captured_since.append(since)
            return 0

        with ExitStack() as stack:
            stack.enter_context(
                patch("etl.db.postgres.get_watermark", return_value=None)
            )
            stack.enter_context(patch("etl.db.postgres.set_watermark"))
            stack.enter_context(patch("etl.db.postgres.record_table_sync"))

            conn_4d = MagicMock()
            conn_pg = MagicMock()
            _run_sync(
                "ventas",
                fake_sync_fn,
                conn_4d,
                conn_pg,
                uses_watermark=True,
                kind="delta",
                lookback_days=1,
            )

        assert captured_since[0] is None, (
            f"With no watermark, since should remain None, got {captured_since[0]!r}"
        )
