"""Integration tests for etl/sync/maestros.py.

These tests require a live 4D SQL connection (P4D_HOST must be set) and a
PostgreSQL database (POSTGRES_DSN or POSTGRES_USER+POSTGRES_DB must be set).
They are skipped automatically when either is unavailable.

What is tested:
- sync_clientes: row count in ps_clientes matches 4D Clientes (~27K rows)
- sync_tiendas: row count in ps_tiendas matches 4D Tiendas (51 rows)
- sync_tiendas: every ps_tiendas row has a non-empty codigo field
- sync_proveedores: integration sync between 4D and PostgreSQL
- sync_gc_comerciales: integration sync between 4D and PostgreSQL
"""

from __future__ import annotations

import os

import pytest

from etl.config import Config
from etl.db import fourd as fourd_db
from etl.sync.maestros import (
    sync_clientes,
    sync_gc_comerciales,
    sync_proveedores,
    sync_tiendas,
)


# ---------------------------------------------------------------------------
# Skip conditions
# ---------------------------------------------------------------------------


def _p4d_available() -> bool:
    """Return True if P4D_HOST is configured in the environment."""
    return bool(os.environ.get("P4D_HOST", "").strip())


def _postgres_available() -> bool:
    """Return True if PostgreSQL appears to be configured."""
    if os.environ.get("POSTGRES_DSN", "").strip():
        return True
    user = os.environ.get("POSTGRES_USER", "")
    db = os.environ.get("POSTGRES_DB", "")
    return bool(user and db)


requires_both = pytest.mark.skipif(
    not (_p4d_available() and _postgres_available()),
    reason="Both P4D_HOST and PostgreSQL configuration are required for maestros integration tests",
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def fourd_conn():
    """Module-scoped 4D connection; skipped if P4D_HOST is not set."""
    if not _p4d_available():
        pytest.skip("P4D_HOST not set")
    config = Config()
    conn = fourd_db.get_connection(config)
    yield conn
    conn.close()


# ---------------------------------------------------------------------------
# Helper: count rows in a 4D table
# ---------------------------------------------------------------------------


def _count_4d(conn, table: str) -> int:
    from etl.db.fourd import safe_fetch

    rows = safe_fetch(conn, f"SELECT COUNT(*) AS cnt FROM {table}")
    return int(rows[0]["cnt"])


# ---------------------------------------------------------------------------
# Tests: sync_clientes
# ---------------------------------------------------------------------------


@requires_both
def test_sync_clientes_count(fourd_conn, pg_conn):
    """After sync, ps_clientes row count matches Clientes in 4D."""
    expected = _count_4d(fourd_conn, "Clientes")
    synced = sync_clientes(fourd_conn, pg_conn)

    # Verify against PostgreSQL directly.
    with pg_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM ps_clientes")
        pg_count = cur.fetchone()[0]

    assert synced == expected, (
        f"sync_clientes returned {synced} but 4D has {expected} rows"
    )
    assert pg_count == expected, (
        f"ps_clientes has {pg_count} rows but 4D has {expected} rows"
    )


# ---------------------------------------------------------------------------
# Tests: sync_tiendas
# ---------------------------------------------------------------------------


@requires_both
def test_sync_tiendas_count(fourd_conn, pg_conn):
    """After sync, ps_tiendas row count matches Tiendas in 4D (~51 rows)."""
    expected = _count_4d(fourd_conn, "Tiendas")
    synced = sync_tiendas(fourd_conn, pg_conn)

    with pg_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM ps_tiendas")
        pg_count = cur.fetchone()[0]

    assert synced == expected, (
        f"sync_tiendas returned {synced} but 4D has {expected} rows"
    )
    assert pg_count == expected, (
        f"ps_tiendas has {pg_count} rows but 4D has {expected} rows"
    )


@requires_both
def test_tiendas_has_codigo(fourd_conn, pg_conn):
    """Every ps_tiendas row must have a non-empty codigo after sync."""
    sync_tiendas(fourd_conn, pg_conn)

    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM ps_tiendas WHERE codigo IS NULL OR codigo = ''"
        )
        bad_count = cur.fetchone()[0]

    assert bad_count == 0, (
        f"{bad_count} ps_tiendas rows have a NULL or empty codigo after sync"
    )


# ---------------------------------------------------------------------------
# Tests: sync_proveedores
# ---------------------------------------------------------------------------


@requires_both
def test_sync_proveedores_count(fourd_conn, pg_conn):
    """After sync, ps_proveedores row count matches Proveedores in 4D (~519 rows)."""
    expected = _count_4d(fourd_conn, "Proveedores")
    synced = sync_proveedores(fourd_conn, pg_conn)

    with pg_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM ps_proveedores")
        pg_count = cur.fetchone()[0]

    assert synced == expected, (
        f"sync_proveedores returned {synced} but 4D has {expected} rows"
    )
    assert pg_count == expected, (
        f"ps_proveedores has {pg_count} rows but 4D has {expected} rows"
    )


# ---------------------------------------------------------------------------
# Tests: sync_gc_comerciales
# ---------------------------------------------------------------------------


@requires_both
def test_sync_gc_comerciales_count(fourd_conn, pg_conn):
    """After sync, ps_gc_comerciales row count matches GCComerciales in 4D (~5 rows)."""
    expected = _count_4d(fourd_conn, "GCComerciales")
    synced = sync_gc_comerciales(fourd_conn, pg_conn)

    with pg_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM ps_gc_comerciales")
        pg_count = cur.fetchone()[0]

    assert synced == expected, (
        f"sync_gc_comerciales returned {synced} but 4D has {expected} rows"
    )
    assert pg_count == expected, (
        f"ps_gc_comerciales has {pg_count} rows but 4D has {expected} rows"
    )
