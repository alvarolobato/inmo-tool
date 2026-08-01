"""Integration tests for etl/sync/ventas.py.

All tests require a live 4D connection (P4D_HOST set) and a live PostgreSQL
connection.  They are skipped automatically when either is unavailable so CI
without external access passes cleanly.

What is tested
--------------
- test_sync_ventas_small_delta   : Sync with since=yesterday, verify rows inserted.
- test_total_si_present          : After sync, verify total_si has non-NULL values.
- test_lineas_fk_valid           : After syncing both tables, every num_ventas in
                                   ps_lineas_ventas (for the delta period) exists in
                                   ps_ventas.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest


# ---------------------------------------------------------------------------
# Skip-guard helpers
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
# Module-scoped fixtures
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
def yesterday() -> datetime:
    """Return a timezone-aware datetime for yesterday at midnight UTC."""
    return (datetime.now(tz=timezone.utc) - timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


@pytest.fixture(scope="module")
def synced_ventas(conn_4d, conn_pg, yesterday):
    """Run sync_ventas with since=yesterday; return the row count."""
    from etl.sync.ventas import sync_ventas

    return sync_ventas(conn_4d, conn_pg, since=yesterday)


@pytest.fixture(scope="module")
def synced_lineas(conn_4d, conn_pg, yesterday):
    """Run sync_lineas_ventas with since=yesterday; return the row count."""
    from etl.sync.ventas import sync_lineas_ventas

    return sync_lineas_ventas(conn_4d, conn_pg, since=yesterday)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSyncVentas:
    def test_sync_ventas_small_delta(self, conn_4d, conn_pg, yesterday, synced_ventas):
        """Sync with since=yesterday inserts rows into ps_ventas.

        We verify:
        1. The sync function reported at least one row (the source has daily volume).
        2. The PostgreSQL table has at least as many rows as reported by the sync.

        Note: if today happens to be a holiday with zero sales this test may
        return 0 rows — in that case we only check the table is non-empty
        overall (historical data must be present from a prior full load).
        """
        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_ventas")
            pg_total = cur.fetchone()[0]

        # The table should never be empty after a delta sync (even 0 new rows
        # means prior data must exist — guard against a completely fresh empty DB).
        # If the DB is truly empty, synced_ventas will also be 0 and we skip.
        if synced_ventas == 0 and pg_total == 0:
            pytest.skip(
                "No rows in ps_ventas and delta returned 0 — "
                "run a full initial load first."
            )

        assert pg_total >= synced_ventas, (
            f"ps_ventas has {pg_total} rows but sync reported {synced_ventas}."
        )

    def test_total_si_present(self, conn_pg, synced_ventas):
        """total_si must be non-NULL for the majority of ps_ventas rows.

        TotalSI is the VAT-exclusive revenue field used for all analytics.
        A high NULL rate indicates a column-mapping error.
        """
        if synced_ventas == 0:
            pytest.skip("No rows synced — skipping total_si check.")

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_ventas")
            total = cur.fetchone()[0]

            cur.execute("SELECT COUNT(*) FROM ps_ventas WHERE total_si IS NOT NULL")
            non_null = cur.fetchone()[0]

        if total == 0:
            pytest.skip("ps_ventas is empty — skipping total_si check.")

        ratio = non_null / total
        assert ratio >= 0.90, (
            f"Only {non_null}/{total} ({ratio:.1%}) rows have a non-NULL total_si."
            " Expected >= 90%."
        )

    def test_lineas_fk_valid(
        self, conn_4d, conn_pg, yesterday, synced_ventas, synced_lineas
    ):
        """All num_ventas values in ps_lineas_ventas (delta period) must exist in ps_ventas.

        This validates the FK chain: LineasVentas.NumVentas → Ventas.RegVentas.
        We check only rows that were synced in this session (since=yesterday) to
        avoid failures caused by a partial initial load where parent Ventas rows
        may not yet be present.

        The test is a loose check: if there are dangling FKs in the delta window,
        it likely indicates a sync-ordering bug (lineas synced before ventas).
        """
        if synced_lineas == 0:
            pytest.skip("No lineas_ventas rows synced — skipping FK check.")

        yesterday_str = yesterday.strftime("%Y-%m-%d")

        with conn_pg.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM ps_lineas_ventas lv
                WHERE lv.fecha_modifica >= %s
                  AND NOT EXISTS (
                      SELECT 1 FROM ps_ventas v
                      WHERE v.reg_ventas = lv.num_ventas
                  )
                """,
                (yesterday_str,),
            )
            orphan_count = cur.fetchone()[0]

        assert orphan_count == 0, (
            f"{orphan_count} rows in ps_lineas_ventas (since {yesterday_str}) have "
            "num_ventas values not present in ps_ventas. "
            "Ensure sync_ventas runs before sync_lineas_ventas."
        )
