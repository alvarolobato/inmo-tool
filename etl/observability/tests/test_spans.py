"""Tests for OTel span instrumentation in etl/main.py.

Verifies:
- _run_sync creates a child span etl.sync.<name> with expected attributes
- run_full_sync creates a parent span etl.run with trigger/kind attributes
- child spans from _run_sync nest under the parent etl.run span
- span context (trace_id, span_id) is passed through to record_table_sync
- error path sets status=failed and records the exception on the span
"""

from __future__ import annotations

from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import pytest

opentelemetry = pytest.importorskip(
    "opentelemetry", reason="opentelemetry not installed"
)

from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)

# Use a module-level provider + exporter so the global is set only once.
_EXPORTER = InMemorySpanExporter()
_PROVIDER = TracerProvider()
_PROVIDER.add_span_processor(SimpleSpanProcessor(_EXPORTER))
trace.set_tracer_provider(_PROVIDER)


@pytest.fixture(autouse=True)
def clear_spans():
    """Reset the exporter before each test."""
    _EXPORTER.clear()
    yield


# ---------------------------------------------------------------------------
# _run_sync span shape
# ---------------------------------------------------------------------------


def test_run_sync_emits_child_span():
    conn_4d = MagicMock()
    conn_pg = MagicMock()
    sync_fn = MagicMock(return_value=42)

    with (
        patch("etl.db.postgres.get_watermark", return_value=None),
        patch("etl.db.postgres.set_watermark"),
    ):
        from etl.main import _run_sync

        rows, ok = _run_sync("articulos", sync_fn, conn_4d, conn_pg)

    assert ok is True
    assert rows == 42

    spans = _EXPORTER.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "etl.sync.articulos"
    assert span.attributes.get("table_name") == "articulos"
    assert span.attributes.get("rows_synced") == 42
    assert span.attributes.get("status") == "ok"


def test_run_sync_error_sets_failed_status():
    conn_4d = MagicMock()
    conn_pg = MagicMock()

    def boom(conn_4d, conn_pg):
        raise RuntimeError("4D connection lost")

    with (
        patch("etl.db.postgres.get_watermark", return_value=None),
        patch("etl.db.postgres.set_watermark"),
    ):
        from etl.main import _run_sync

        rows, ok = _run_sync("ventas", boom, conn_4d, conn_pg)

    assert ok is False
    spans = _EXPORTER.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "etl.sync.ventas"
    assert span.attributes.get("status") == "failed"
    assert any(e.name == "exception" for e in span.events)


def test_run_sync_passes_trace_context_to_record_table_sync():
    conn_4d = MagicMock()
    conn_pg = MagicMock()
    sync_fn = MagicMock(return_value=10)
    captured_kwargs: dict = {}

    def fake_record(conn, run_id, name, *args, **kwargs):
        captured_kwargs.update(kwargs)

    with (
        patch("etl.db.postgres.get_watermark", return_value=None),
        patch("etl.db.postgres.set_watermark"),
        patch("etl.db.postgres.record_table_sync", side_effect=fake_record),
    ):
        from etl.main import _run_sync

        _run_sync("tiendas", sync_fn, conn_4d, conn_pg, run_id=99)

    tid = captured_kwargs.get("trace_id")
    sid = captured_kwargs.get("span_id")
    assert tid is not None and len(tid) == 32, f"trace_id={tid!r}"
    assert sid is not None and len(sid) == 16, f"span_id={sid!r}"


# ---------------------------------------------------------------------------
# run_full_sync parent span
# ---------------------------------------------------------------------------

# All sync targets patched in run_full_sync to avoid real I/O
_SYNC_PATCHES = [
    ("etl.db.postgres.try_acquire_run_lock", True),
    ("etl.db.postgres.release_run_lock", None),
    ("etl.db.postgres.create_run", 1),
    ("etl.db.postgres.finish_run", None),
    ("etl.db.postgres.update_run_trace_context", None),
    ("etl.db.postgres.get_watermark", None),
    ("etl.db.postgres.set_watermark", None),
    ("etl.db.postgres.get_trigger_force_flags", None),
    ("etl.db.postgres.reset_watermarks", 0),
    ("etl.db.postgres.record_table_sync", None),
    ("etl.sync.articulos.sync_catalogos", {}),
    ("etl.sync.articulos.sync_articulos", 0),
    ("etl.sync.maestros.sync_tiendas", 0),
    ("etl.sync.maestros.sync_clientes", 0),
    ("etl.sync.maestros.sync_proveedores", 0),
    ("etl.sync.maestros.sync_gc_comerciales", 0),
    ("etl.sync.ventas.sync_ventas", 0),
    ("etl.sync.ventas.sync_lineas_ventas", 0),
    ("etl.sync.ventas.sync_pagos_ventas", 0),
    ("etl.sync.mayorista.sync_gc_pedidos", 0),
    ("etl.sync.mayorista.sync_gc_lin_pedidos", 0),
    ("etl.sync.mayorista.sync_gc_albaranes", 0),
    ("etl.sync.mayorista.sync_gc_lin_albarane", 0),
    ("etl.sync.mayorista.sync_gc_facturas", 0),
    ("etl.sync.mayorista.sync_gc_lin_facturas", 0),
    ("etl.sync.compras.sync_compras", 0),
    ("etl.sync.compras.sync_lineas_compras", 0),
    ("etl.sync.compras.sync_albaranes", 0),
    ("etl.sync.compras.sync_facturas_compra", 0),
    ("etl.sync.compras.sync_facturas", 0),
    ("etl.sync.stock.sync_stock", 0),
    ("etl.sync.stock.sync_traspasos", 0),
    ("etl.sync.ccstock.sync_ccstock", 0),
    ("etl.main._cleanup_ma_linked_rows", None),
]


def test_run_full_sync_emits_parent_span():
    conn_4d = MagicMock()
    conn_pg = MagicMock()

    with ExitStack() as stack:
        for target, retval in _SYNC_PATCHES:
            mock = stack.enter_context(patch(target))
            if retval is not None:
                mock.return_value = retval

        from etl.main import run_full_sync

        run_full_sync(conn_4d, conn_pg, trigger="test", kind="full")

    spans = _EXPORTER.get_finished_spans()
    parent_spans = [s for s in spans if s.name == "etl.run"]
    assert len(parent_spans) == 1, (
        f"Expected one etl.run span; got: {[s.name for s in spans]}"
    )
    parent = parent_spans[0]
    assert parent.attributes.get("trigger") == "test"
    assert parent.attributes.get("kind") == "full"

    child_spans = [s for s in spans if s.name.startswith("etl.sync.")]
    assert len(child_spans) > 0, "Expected child etl.sync.* spans"
    for child in child_spans:
        assert child.context.trace_id == parent.context.trace_id, (
            f"Child {child.name} must share trace_id with parent"
        )
