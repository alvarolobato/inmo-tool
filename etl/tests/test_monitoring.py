"""Unit tests for ETL monitoring instrumentation.

Tests verify that run_full_sync correctly calls the monitoring helpers
(create_run, finish_run, record_table_sync) and that monitoring failures
never abort the data sync.
"""

from __future__ import annotations

from contextlib import ExitStack
from unittest.mock import MagicMock, patch

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
    "etl.sync.ccstock.sync_ccstock",
]
_N_SYNC_TABLES = len(_SYNC_TARGETS)  # tracked by record_table_sync
_N_RESULTS = _N_SYNC_TABLES + 1  # +1 for MA cleanup step tracked in _results


def _make_conn():
    return MagicMock()


def _base_patches(stack: ExitStack, run_id: int = 42) -> dict:
    mocks: dict[str, MagicMock] = {}
    for target in _SYNC_TARGETS:
        name = target.rsplit(".", 1)[-1]
        default = {} if name == "sync_catalogos" else 0
        mocks[name] = stack.enter_context(patch(target, return_value=default))
    mocks["get_watermark"] = stack.enter_context(
        patch(f"{_WM_MODULE}.get_watermark", return_value=None)
    )
    mocks["set_watermark"] = stack.enter_context(patch(f"{_WM_MODULE}.set_watermark"))
    mocks["create_run"] = stack.enter_context(
        patch(f"{_WM_MODULE}.create_run", return_value=run_id)
    )
    mocks["finish_run"] = stack.enter_context(patch(f"{_WM_MODULE}.finish_run"))
    mocks["record_table_sync"] = stack.enter_context(
        patch(f"{_WM_MODULE}.record_table_sync")
    )
    mocks["_get_rows_total"] = stack.enter_context(
        patch("etl.main._get_rows_total", return_value=None)
    )
    mocks["_cleanup_ma_linked_rows"] = stack.enter_context(
        patch("etl.main._cleanup_ma_linked_rows")
    )
    return mocks


def test_create_run_called_once():
    conn_4d, conn_pg = _make_conn(), _make_conn()
    with ExitStack() as stack:
        mocks = _base_patches(stack)
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)
    mocks["create_run"].assert_called_once_with(conn_pg, "scheduled", kind="full")


def test_finish_run_called_once_with_success():
    conn_4d, conn_pg = _make_conn(), _make_conn()
    with ExitStack() as stack:
        mocks = _base_patches(stack, run_id=7)
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)
    mocks["finish_run"].assert_called_once()
    args = mocks["finish_run"].call_args.args
    assert args[1] == 7, f"Expected run_id=7, got {args[1]}"
    assert args[2] == "success", f"Expected status=success, got {args[2]!r}"
    assert args[3] == _N_RESULTS, f"Expected tables_ok={_N_RESULTS}, got {args[3]}"
    assert args[4] == 0, f"Expected tables_failed=0, got {args[4]}"


def test_record_table_sync_called_per_table():
    conn_4d, conn_pg = _make_conn(), _make_conn()
    with ExitStack() as stack:
        mocks = _base_patches(stack)
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)
    assert mocks["record_table_sync"].call_count == _N_SYNC_TABLES, (
        f"Expected {_N_SYNC_TABLES} record_table_sync calls, "
        f"got {mocks['record_table_sync'].call_count}"
    )


def test_partial_status_on_one_table_failure():
    conn_4d, conn_pg = _make_conn(), _make_conn()

    def _ventas_boom(*args, **kwargs):
        raise RuntimeError("simulated ventas failure")

    with ExitStack() as stack:
        mocks = _base_patches(stack)
        stack.enter_context(
            patch("etl.sync.ventas.sync_ventas", side_effect=_ventas_boom)
        )
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    finish_args = mocks["finish_run"].call_args.args
    assert finish_args[2] == "partial", f"Expected partial, got {finish_args[2]!r}"
    assert finish_args[4] == 1, f"Expected tables_failed=1, got {finish_args[4]}"
    assert finish_args[3] == _N_RESULTS - 1, (
        f"Expected tables_ok={_N_RESULTS - 1}, got {finish_args[3]}"
    )


def test_create_run_failure_does_not_abort_sync():
    conn_4d, conn_pg = _make_conn(), _make_conn()
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
            patch(f"{_WM_MODULE}.create_run", side_effect=RuntimeError("db down"))
        )
        finish_run_mock = stack.enter_context(patch(f"{_WM_MODULE}.finish_run"))
        stack.enter_context(patch(f"{_WM_MODULE}.record_table_sync"))
        stack.enter_context(patch("etl.main._get_rows_total", return_value=None))
        stack.enter_context(patch("etl.main._cleanup_ma_linked_rows"))
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    assert "sync_articulos" in called
    assert "sync_ventas" in called
    assert "sync_traspasos" in called
    finish_run_mock.assert_not_called()


def test_record_table_sync_failure_does_not_abort_sync():
    conn_4d, conn_pg = _make_conn(), _make_conn()
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
        stack.enter_context(patch(f"{_WM_MODULE}.create_run", return_value=1))
        stack.enter_context(patch(f"{_WM_MODULE}.finish_run"))
        stack.enter_context(
            patch(
                f"{_WM_MODULE}.record_table_sync",
                side_effect=RuntimeError("monitoring db down"),
            )
        )
        stack.enter_context(patch("etl.main._get_rows_total", return_value=None))
        stack.enter_context(patch("etl.main._cleanup_ma_linked_rows"))
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    assert "sync_articulos" in called
    assert "sync_ventas" in called
    assert "sync_traspasos" in called


def test_record_table_sync_status_on_failure():
    conn_4d, conn_pg = _make_conn(), _make_conn()

    def _articulos_boom(*args, **kwargs):
        raise ValueError("simulated articulos error")

    with ExitStack() as stack:
        mocks = _base_patches(stack)
        stack.enter_context(
            patch("etl.sync.articulos.sync_articulos", side_effect=_articulos_boom)
        )
        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg)

    record_calls = mocks["record_table_sync"].call_args_list
    articulos_calls = [c for c in record_calls if c.args[2] == "articulos"]
    assert articulos_calls, "record_table_sync was not called for articulos"
    status_arg = articulos_calls[0].kwargs["status"]
    assert status_arg == "failed", f"Expected status=failed, got {status_arg!r}"
    error_msg_arg = articulos_calls[0].kwargs.get("error_msg")
    assert error_msg_arg is not None, "error_msg should not be None for failed sync"
    assert "simulated articulos error" in error_msg_arg, (
        f"Expected exception text in error_msg, got {error_msg_arg!r}"
    )
