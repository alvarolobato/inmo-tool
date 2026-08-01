"""Integration tests for etl/sync/mayorista.py.

All tests require both a live 4D connection (P4D_HOST set) and a live
PostgreSQL connection.  They are skipped automatically when either is
unavailable so CI without external access passes cleanly.

What is tested:
- TestMayoristaGteFix: Unit tests asserting all delta SQL templates use >= (issue #459).
- test_gc_albaranes_count: Row count in ps_gc_albaranes matches 4D source.
- test_gc_facturas_count:  Row count in ps_gc_facturas matches 4D source.
- test_gc_lin_albarane_fk: All n_albaran values in ps_gc_lin_albarane exist
                           in ps_gc_albaranes (FK integrity check).
- test_gc_pedidos_count:   Row count in ps_gc_pedidos is approximately 101.
"""

from __future__ import annotations

import os

import pytest


# ---------------------------------------------------------------------------
# Unit tests (no external connections required)
# ---------------------------------------------------------------------------


class TestMayoristaGteFix:
    """Ensure all mayorista delta SQL templates use >= not > (issue #459).

    Strict `>` silently skips rows with Modifica == today once the watermark
    advances to today. `>=` re-fetches those rows; upsert/delete-reinsert is
    idempotent so there is no correctness risk.
    """

    def test_albaranes_delta_uses_gte(self):
        from etl.sync.mayorista import _SQL_ALBARANES_DELTA

        assert "Modifica >= {since}" in _SQL_ALBARANES_DELTA
        assert "Modifica > {since}" not in _SQL_ALBARANES_DELTA

    def test_lin_albarane_parent_ids_uses_gte(self):
        from etl.sync.mayorista import _SQL_LIN_ALBARANE_PARENT_IDS

        assert "Modifica >= {since}" in _SQL_LIN_ALBARANE_PARENT_IDS
        assert "Modifica > {since}" not in _SQL_LIN_ALBARANE_PARENT_IDS

    def test_facturas_delta_uses_gte(self):
        from etl.sync.mayorista import _SQL_FACTURAS_DELTA

        assert "Modifica >= {since}" in _SQL_FACTURAS_DELTA
        assert "Modifica > {since}" not in _SQL_FACTURAS_DELTA

    def test_lin_facturas_parent_ids_uses_gte(self):
        from etl.sync.mayorista import _SQL_LIN_FACTURAS_PARENT_IDS

        assert "Modifica >= {since}" in _SQL_LIN_FACTURAS_PARENT_IDS
        assert "Modifica > {since}" not in _SQL_LIN_FACTURAS_PARENT_IDS


# ---------------------------------------------------------------------------
# Skip guards
# ---------------------------------------------------------------------------


def _p4d_available() -> bool:
    return bool(os.environ.get("P4D_HOST", "").strip())


def _postgres_available() -> bool:
    if os.environ.get("POSTGRES_DSN", "").strip():
        return True
    return bool(
        os.environ.get("POSTGRES_USER", "").strip()
        and os.environ.get("POSTGRES_DB", "").strip()
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def conn_4d():
    """Yield a p4d connection; skip if P4D_HOST is not configured."""
    if not _p4d_available():
        pytest.skip("P4D_HOST not set — skipping 4D integration tests")

    from etl.config import Config
    from etl.db.fourd import get_connection

    config = Config()
    conn = get_connection(config)
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def conn_pg():
    """Yield a psycopg2 connection; skip if PostgreSQL is not configured."""
    if not _postgres_available():
        pytest.skip(
            "PostgreSQL configuration not available — skipping PostgreSQL tests"
        )

    from etl.config import Config
    from etl.db import postgres

    config = Config()
    conn = postgres.get_connection(config)
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def synced_mayorista(conn_4d, conn_pg):
    """Run all six GC sync functions (initial load) and return row counts.

    Module-scoped so the expensive full loads run only once across all tests.

    Returns a dict mapping table name to synced row count.
    """
    from etl.sync.mayorista import (
        sync_gc_albaranes,
        sync_gc_facturas,
        sync_gc_lin_albarane,
        sync_gc_lin_facturas,
        sync_gc_lin_pedidos,
        sync_gc_pedidos,
    )

    counts: dict[str, int] = {}
    # Headers first (lines depend on them for FK check)
    counts["ps_gc_albaranes"] = sync_gc_albaranes(conn_4d, conn_pg, since=None)
    counts["ps_gc_facturas"] = sync_gc_facturas(conn_4d, conn_pg, since=None)
    counts["ps_gc_lin_albarane"] = sync_gc_lin_albarane(conn_4d, conn_pg, since=None)
    counts["ps_gc_lin_facturas"] = sync_gc_lin_facturas(conn_4d, conn_pg, since=None)
    counts["ps_gc_pedidos"] = sync_gc_pedidos(conn_4d, conn_pg)
    counts["ps_gc_lin_pedidos"] = sync_gc_lin_pedidos(conn_4d, conn_pg)
    return counts


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSyncMayorista:
    def test_gc_albaranes_count(self, conn_4d, conn_pg, synced_mayorista):
        """Row count in ps_gc_albaranes must match the 4D GCAlbaranes table."""
        from etl.db.fourd import safe_fetch

        rows = safe_fetch(conn_4d, "SELECT COUNT(*) AS cnt FROM GCAlbaranes")
        source_count = int(rows[0]["cnt"])

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_gc_albaranes")
            pg_count = cur.fetchone()[0]

        assert pg_count == source_count, (
            f"ps_gc_albaranes has {pg_count} rows but 4D GCAlbaranes has {source_count}"
        )
        assert synced_mayorista["ps_gc_albaranes"] == source_count

    def test_gc_facturas_count(self, conn_4d, conn_pg, synced_mayorista):
        """Row count in ps_gc_facturas must match the 4D GCFacturas table."""
        from etl.db.fourd import safe_fetch

        rows = safe_fetch(conn_4d, "SELECT COUNT(*) AS cnt FROM GCFacturas")
        source_count = int(rows[0]["cnt"])

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_gc_facturas")
            pg_count = cur.fetchone()[0]

        assert pg_count == source_count, (
            f"ps_gc_facturas has {pg_count} rows but 4D GCFacturas has {source_count}"
        )
        assert synced_mayorista["ps_gc_facturas"] == source_count

    def test_gc_lin_albarane_fk(self, conn_pg, synced_mayorista):  # noqa: ARG002
        """Every n_albaran in ps_gc_lin_albarane must exist in ps_gc_albaranes.

        This validates the FK: GCLinAlbarane.NAlbaran → GCAlbaranes.NAlbaran.
        Orphan lines would indicate a data integrity problem or wrong join key.
        """
        with conn_pg.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*)
                FROM ps_gc_lin_albarane la
                WHERE la.n_albaran IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM ps_gc_albaranes a
                      WHERE a.n_albaran = la.n_albaran
                  )
                """
            )
            orphan_count = cur.fetchone()[0]

        assert orphan_count == 0, (
            f"{orphan_count} rows in ps_gc_lin_albarane have n_albaran values "
            "not found in ps_gc_albaranes.  Check the FK mapping."
        )

    def test_gc_pedidos_count(self, conn_4d, conn_pg, synced_mayorista):
        """Row count in ps_gc_pedidos should approximately match 4D (expected ~101)."""
        from etl.db.fourd import safe_fetch

        rows = safe_fetch(conn_4d, "SELECT COUNT(*) AS cnt FROM GCPedidos")
        source_count = int(rows[0]["cnt"])

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_gc_pedidos")
            pg_count = cur.fetchone()[0]

        assert pg_count == source_count, (
            f"ps_gc_pedidos has {pg_count} rows but 4D GCPedidos has {source_count}"
        )
        assert synced_mayorista["ps_gc_pedidos"] == source_count
        # Sanity-check the known approximate size (101 rows as of 2026-03-30)
        assert source_count <= 500, (
            f"GCPedidos has {source_count} rows — far more than the expected ~101. "
            "Verify the table is still a small orders table."
        )
