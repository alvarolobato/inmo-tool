"""Tests for etl/sync/articulos.py.

Most tests require both a live 4D connection (P4D_HOST set) and a live
PostgreSQL connection.  They are skipped automatically when either is
unavailable so CI without external access passes cleanly.

TestDeltaSqlConstruction is a pure unit-test class and runs without any
external connections.

What is tested:
- Row count in ps_articulos matches 4D source after sync.
- No bytes values in ps_articulos (bytes-decoding regression guard).
- ccrefejofacm is populated for at least 90 % of rows (referencia present).
- SQL operator precedence: OR condition is parenthesised so delta filter applies correctly.
"""

from __future__ import annotations

import os
from decimal import Decimal

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
def synced_count(conn_4d, conn_pg):
    """Run sync_articulos once and return the reported row count.

    Module-scoped so the expensive full-refresh runs only once across all tests
    in this module.
    """
    from etl.sync.articulos import sync_articulos

    return sync_articulos(conn_4d, conn_pg)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSyncArticulos:
    def test_sync_articulos_count(self, conn_4d, conn_pg, synced_count):
        """Row count in ps_articulos should match the 4D source after MA exclusion.

        MA-prefix articles (CCRefeJOFACM starting with 'MA') are filtered at
        the source query level, so the expected count is the non-MA rows in 4D.
        Rows with a NULL CCRefeJOFACM are included (not MA-prefix articles).
        """
        from etl.db.fourd import safe_fetch

        rows = safe_fetch(
            conn_4d,
            "SELECT COUNT(*) AS cnt FROM Articulos"
            " WHERE CCRefeJOFACM IS NULL OR LEFT(CCRefeJOFACM, 2) <> 'MA'",
        )
        source_count = int(rows[0]["cnt"])

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_articulos")
            pg_count = cur.fetchone()[0]

        assert synced_count == source_count
        assert pg_count == source_count

    def test_no_ma_articles_in_mirror(self, conn_pg, synced_count):  # noqa: ARG002
        """ps_articulos must contain no MA-prefix articles after sync."""
        with conn_pg.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM ps_articulos WHERE LEFT(ccrefejofacm, 2) = 'MA'"
            )
            ma_count = cur.fetchone()[0]

        assert ma_count == 0, (
            f"Found {ma_count} MA-prefix articles in ps_articulos;"
            " they should be excluded at ETL level."
        )

    def test_no_bytes_in_articulos(self, conn_pg, synced_count):  # noqa: ARG002
        """No column in ps_articulos should contain raw bytes values.

        After safe_fetch decoding, all text fields must be str (or None).
        This guards against regressions where bytes sneak through to PostgreSQL.
        """
        with conn_pg.cursor() as cur:
            cur.execute("SELECT * FROM ps_articulos LIMIT 500")
            col_names = [desc[0] for desc in cur.description]
            rows = cur.fetchall()

        for row in rows:
            for col_name, value in zip(col_names, row):
                assert not isinstance(value, bytes), (
                    f"Column '{col_name}' contains raw bytes: {value!r}"
                )

    def test_referencia_not_empty(self, conn_pg, synced_count):  # noqa: ARG002
        """ccrefejofacm (Referencia) should be non-NULL for at least 90% of rows.

        Referencia is the primary business identifier displayed on labels and
        reports.  A high NULL rate would indicate a mapping error.
        """
        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_articulos")
            total = cur.fetchone()[0]

            cur.execute(
                "SELECT COUNT(*) FROM ps_articulos"
                " WHERE ccrefejofacm IS NOT NULL AND ccrefejofacm <> ''"
            )
            non_empty = cur.fetchone()[0]

        if total == 0:
            pytest.skip("ps_articulos is empty — skipping referencia check")

        ratio = non_empty / total
        assert ratio >= 0.90, (
            f"Only {non_empty}/{total} ({ratio:.1%}) rows have a non-empty"
            " ccrefejofacm.  Expected >= 90%."
        )


class TestDeltaSqlConstruction:
    """Unit tests for SQL operator precedence fix — no external connections needed."""

    def test_delta_sql_parenthesisation(self):
        from datetime import date

        from etl.sync.articulos import _SQL_ARTICULOS

        date_str = date(2025, 1, 15).strftime("%Y-%m-%d")
        delta_sql = f"{_SQL_ARTICULOS} AND FechaModifica >= {{d '{date_str}'}}"

        assert (
            "WHERE (CCRefeJOFACM IS NULL OR LEFT(CCRefeJOFACM, 2) <> 'MA')" in delta_sql
        ), (
            "OR condition must be parenthesised so AND FechaModifica applies to both branches"
        )
        assert ") AND FechaModifica" in delta_sql, (
            "AND clause must follow the closing parenthesis of the OR group"
        )

    def test_base_sql_has_ma_exclusion_and_no_delta_filter(self):
        from etl.sync.articulos import _SQL_ARTICULOS

        assert (
            "WHERE (CCRefeJOFACM IS NULL OR LEFT(CCRefeJOFACM, 2) <> 'MA')"
            in _SQL_ARTICULOS
        )
        assert "AND FechaModifica" not in _SQL_ARTICULOS


class TestNullifyZeroFks:
    """Unit tests for _nullify_zero_fks — no external connections needed.

    4D uses 0 to mean "no brand/family/etc assigned", but the catalog tables
    have no reg_* = 0 row, so those 0s must become NULL before insert or the
    FK constraint rejects the row.
    """

    def test_zero_int_fks_become_none(self):
        from etl.sync.articulos import _nullify_zero_fks

        row = {
            "reg_articulo": 123,
            "num_familia": 0,
            "num_departament": 0,
            "num_color": 0,
            "num_temporada": 0,
            "num_marca": 0,
            "num_proveedor": 0,
        }
        result = _nullify_zero_fks(row)
        assert result["num_familia"] is None
        assert result["num_departament"] is None
        assert result["num_color"] is None
        assert result["num_temporada"] is None
        assert result["num_marca"] is None
        # num_proveedor has no FK, must not be touched
        assert result["num_proveedor"] == 0
        # PK and unrelated fields untouched
        assert result["reg_articulo"] == 123

    def test_zero_decimal_fks_become_none(self):
        from etl.sync.articulos import _nullify_zero_fks

        row = {
            "num_familia": Decimal("0"),
            "num_marca": Decimal("0.000"),
        }
        result = _nullify_zero_fks(row)
        assert result["num_familia"] is None
        assert result["num_marca"] is None

    def test_nonzero_fks_preserved(self):
        from etl.sync.articulos import _nullify_zero_fks

        row = {
            "num_familia": Decimal("12.99"),
            "num_departament": Decimal("3.99"),
            "num_color": Decimal("45.99"),
            "num_temporada": Decimal("7.99"),
            "num_marca": Decimal("100.99"),
        }
        result = _nullify_zero_fks(row)
        assert result["num_familia"] == Decimal("12.99")
        assert result["num_departament"] == Decimal("3.99")
        assert result["num_color"] == Decimal("45.99")
        assert result["num_temporada"] == Decimal("7.99")
        assert result["num_marca"] == Decimal("100.99")

    def test_existing_none_preserved(self):
        from etl.sync.articulos import _nullify_zero_fks

        row = {"num_familia": None, "num_marca": None}
        result = _nullify_zero_fks(row)
        assert result["num_familia"] is None
        assert result["num_marca"] is None
