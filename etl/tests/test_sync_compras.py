"""Integration tests for etl/sync/compras.py.

All tests require both a live 4D connection (P4D_HOST set) and a live
PostgreSQL connection.  They are skipped automatically when either is
unavailable so CI without external access passes cleanly.

What is tested:
- Row count in ps_compras matches 4D source after sync (~2,700).
- Row count in ps_lineas_compras matches 4D CCLineasCompr after sync (~44,000).
- FK integrity: all num_pedido values in ps_lineas_compras exist in ps_compras.
- Enriched lineas_compras columns (unidades, total_si) have non-null values.
- ps_albaranes.num_pedido and num_proveedor are populated (issue #429).
- ps_proveedores.nombre is non-empty after sync (Proveedor field fix, issue #429).
"""

from __future__ import annotations

import os

import pytest


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
def synced_compras(conn_4d, conn_pg):
    """Run sync_compras and sync_lineas_compras once; return (compras_count, lineas_count).

    Module-scoped so each full-refresh runs only once across all tests in this
    module.
    """
    from etl.sync.compras import (
        sync_albaranes,
        sync_compras,
        sync_facturas,
        sync_facturas_compra,
        sync_lineas_compras,
    )

    compras_count = sync_compras(conn_4d, conn_pg)
    lineas_count = sync_lineas_compras(conn_4d, conn_pg)

    # Exercise remaining sync functions to detect schema/mapping drift early.
    sync_facturas(conn_4d, conn_pg)
    sync_albaranes(conn_4d, conn_pg)
    sync_facturas_compra(conn_4d, conn_pg)

    return compras_count, lineas_count


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSyncCompras:
    def test_compras_count(self, conn_4d, conn_pg, synced_compras):
        """Row count in ps_compras must match 4D Compras source (~2,700 rows)."""
        from etl.db.fourd import safe_fetch

        rows = safe_fetch(conn_4d, "SELECT COUNT(*) AS cnt FROM Compras")
        source_count = int(rows[0]["cnt"])

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_compras")
            pg_count = cur.fetchone()[0]

        compras_count, _ = synced_compras
        assert compras_count == source_count, (
            f"sync_compras returned {compras_count} but 4D has {source_count} rows"
        )
        assert pg_count == source_count, (
            f"ps_compras has {pg_count} rows but 4D has {source_count} rows"
        )

    def test_lineas_compras_count(self, conn_4d, conn_pg, synced_compras):
        """Row count in ps_lineas_compras must match 4D CCLineasCompr (~44,000 rows).

        NOTE: The source table is CCLineasCompr, not LineasCompras.
        """
        from etl.db.fourd import safe_fetch

        rows = safe_fetch(conn_4d, "SELECT COUNT(*) AS cnt FROM CCLineasCompr")
        source_count = int(rows[0]["cnt"])

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_lineas_compras")
            pg_count = cur.fetchone()[0]

        _, lineas_count = synced_compras
        assert lineas_count == source_count, (
            f"sync_lineas_compras returned {lineas_count} but 4D has {source_count} rows"
        )
        assert pg_count == source_count, (
            f"ps_lineas_compras has {pg_count} rows but 4D has {source_count} rows"
        )

    def test_lineas_fk(self, conn_pg, synced_compras):
        """All num_pedido values in ps_lineas_compras must exist in ps_compras.

        Validates FK integrity: CCLineasCompr.NumPedido → Compras.RegPedido.
        Orphaned line items would indicate a data integrity problem or a sync
        ordering bug.
        """
        # Ensure both tables were synced before running FK check
        _ = synced_compras

        with conn_pg.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM ps_lineas_compras lc
                WHERE lc.num_pedido IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM ps_compras c
                      WHERE c.reg_pedido = lc.num_pedido
                  )
                """
            )
            orphan_count = cur.fetchone()[0]

        assert orphan_count == 0, (
            f"{orphan_count} rows in ps_lineas_compras have num_pedido that"
            " does not exist in ps_compras (reg_pedido)."
        )

    def test_lineas_compras_enriched_unidades(self, conn_pg, synced_compras):
        """ps_lineas_compras.unidades must be populated (issue #429 enrichment).

        We verify that at least 90% of rows have a non-NULL unidades value.
        """
        _ = synced_compras

        with conn_pg.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(unidades) AS with_unidades
                FROM ps_lineas_compras
                """
            )
            total, with_unidades = cur.fetchone()

        assert total > 0, "ps_lineas_compras is empty"
        fill_rate = with_unidades / total if total else 0
        assert fill_rate >= 0.9, (
            f"ps_lineas_compras.unidades fill rate is {fill_rate:.1%} "
            "(expected ≥ 90%) — enrichment may have failed"
        )

    def test_lineas_compras_enriched_total_si(self, conn_pg, synced_compras):
        """ps_lineas_compras.total_si must be populated (issue #429 enrichment)."""
        _ = synced_compras

        with conn_pg.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(total_si) AS with_total_si
                FROM ps_lineas_compras
                """
            )
            total, with_total_si = cur.fetchone()

        assert total > 0, "ps_lineas_compras is empty"
        fill_rate = with_total_si / total if total else 0
        assert fill_rate >= 0.9, (
            f"ps_lineas_compras.total_si fill rate is {fill_rate:.1%} (expected ≥ 90%)"
        )

    def test_albaranes_enriched_num_pedido(self, conn_pg, synced_compras):
        """ps_albaranes.num_pedido must be populated for most rows (issue #429).

        We check that the column is non-NULL for ≥ 90% of rows.
        """
        _ = synced_compras

        with conn_pg.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(num_pedido) AS with_num_pedido
                FROM ps_albaranes
                """
            )
            total, with_num_pedido = cur.fetchone()

        assert total > 0, "ps_albaranes is empty"
        fill_rate = with_num_pedido / total if total else 0
        assert fill_rate >= 0.9, (
            f"ps_albaranes.num_pedido fill rate is {fill_rate:.1%} (expected ≥ 90%)"
        )

    def test_proveedores_nombre_populated(self, conn_pg, synced_compras):
        """ps_proveedores.nombre must be non-empty for most rows (issue #429).

        The fix maps 4D Proveedores.Proveedor → ps_proveedores.nombre.
        Previously NombreComercial was mapped but it was empty in 4D.
        """
        _ = synced_compras

        with conn_pg.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(CASE WHEN nombre IS NOT NULL AND nombre <> '' THEN 1 END) AS with_nombre
                FROM ps_proveedores
                """
            )
            total, with_nombre = cur.fetchone()

        assert total > 0, "ps_proveedores is empty"
        fill_rate = with_nombre / total if total else 0
        assert fill_rate >= 0.9, (
            f"ps_proveedores.nombre fill rate is {fill_rate:.1%} "
            "(expected ≥ 90%) — Proveedor field mapping may have failed"
        )
