"""Tests for etl/sync/ccstock.py.

Unit tests cover _map_ccstock_row without any external connections.
Integration tests require both 4D and PostgreSQL connections and skip
when those are unavailable.
"""

from __future__ import annotations

import os
from decimal import Decimal

import pytest

from etl.sync.ccstock import _map_ccstock_row


# ---------------------------------------------------------------------------
# Skip helpers
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


def _both_available() -> bool:
    return _p4d_available() and _postgres_available()


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------


class TestMapCcstockRow:
    """Unit tests for _map_ccstock_row (no external connections required)."""

    def _make_src(self, num_articulo=1042.99, stock_vals=None):
        """Build a minimal CCStock source row (safe_fetch lowercase keys)."""
        row = {"numarticulo": num_articulo, "fechamodifica": "2026-01-15"}
        # Default: all zeros
        for i in range(1, 35):
            key = f"stock{i}"
            row[key] = stock_vals.get(i, 0) if stock_vals else 0
        return row

    def test_basic_mapping(self):
        """num_articulo is converted to Decimal with 3 decimal places."""
        row = self._make_src(num_articulo=1042.99)
        result = _map_ccstock_row(row)
        assert result is not None
        assert result["num_articulo"] == Decimal("1042.990")
        assert result["stock"] == 0

    def test_stock_sum(self):
        """Stock slots are summed into a single integer."""
        row = self._make_src(stock_vals={1: 3, 2: 5, 3: 10})
        result = _map_ccstock_row(row)
        assert result is not None
        assert result["stock"] == 18

    def test_signed_int16_decode_negative(self):
        """65535 (unsigned wire representation of -1) is decoded to -1."""
        row = self._make_src(stock_vals={1: 65535})
        result = _map_ccstock_row(row)
        assert result is not None
        assert result["stock"] == -1

    def test_signed_int16_decode_boundary(self):
        """32767 is the max positive value; 32768 decodes to -32768."""
        row_max = self._make_src(stock_vals={1: 32767})
        row_neg = self._make_src(stock_vals={1: 32768})
        result_max = _map_ccstock_row(row_max)
        result_neg = _map_ccstock_row(row_neg)
        assert result_max is not None
        assert result_max["stock"] == 32767
        assert result_neg is not None
        assert result_neg["stock"] == -32768

    def test_multiple_negative_slots(self):
        """Multiple unsigned-negative slots sum correctly."""
        # Three slots each -1 (wire value 65535)
        row = self._make_src(stock_vals={1: 65535, 2: 65535, 3: 65535})
        result = _map_ccstock_row(row)
        assert result is not None
        assert result["stock"] == -3

    def test_missing_numarticulo_returns_none(self):
        """Row with missing NumArticulo is skipped (returns None)."""
        row = self._make_src()
        row["numarticulo"] = None
        assert _map_ccstock_row(row) is None

    def test_zero_numarticulo_returns_none(self):
        """Row with NumArticulo=0 is treated as missing (returns None)."""
        row = self._make_src(num_articulo=0)
        assert _map_ccstock_row(row) is None

    def test_none_stock_slot_treated_as_zero(self):
        """None stock slot values are treated as 0 (not summed as a fault)."""
        row = self._make_src(stock_vals={1: 5})
        row["stock2"] = None  # explicit None
        result = _map_ccstock_row(row)
        assert result is not None
        assert result["stock"] == 5

    def test_fecha_modifica_preserved(self):
        """fecha_modifica from source row is preserved unchanged."""
        row = self._make_src()
        row["fechamodifica"] = "2026-03-15"
        result = _map_ccstock_row(row)
        assert result is not None
        assert result["fecha_modifica"] == "2026-03-15"

    def test_all_34_slots_summed(self):
        """All 34 slots contribute to the total."""
        stock_vals = {i: i for i in range(1, 35)}  # 1+2+...+34 = 595
        row = self._make_src(stock_vals=stock_vals)
        result = _map_ccstock_row(row)
        assert result is not None
        assert result["stock"] == sum(range(1, 35))


# ---------------------------------------------------------------------------
# Integration tests
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def conn_4d():
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
def synced_ccstock(conn_4d, conn_pg):
    """Run sync_ccstock once; return the row count."""
    from etl.sync.ccstock import sync_ccstock

    count = sync_ccstock(conn_4d, conn_pg)
    return count


@pytest.mark.skipif(
    not _both_available(), reason="Requires 4D and PostgreSQL connections"
)
class TestSyncCcstockIntegration:
    def test_row_count_matches_source(self, conn_4d, conn_pg, synced_ccstock):
        """ps_stock_central row count must match 4D CCStock source (~41,500 rows)."""
        from etl.db.fourd import safe_fetch

        rows = safe_fetch(conn_4d, "SELECT COUNT(*) AS cnt FROM CCStock")
        source_count = int(rows[0]["cnt"])

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_stock_central")
            pg_count = cur.fetchone()[0]

        assert synced_ccstock == pg_count, (
            f"sync_ccstock returned {synced_ccstock} but pg has {pg_count} rows"
        )
        # Allow for rows filtered out due to missing NumArticulo (defensive)
        assert pg_count >= source_count * 0.99, (
            f"ps_stock_central has {pg_count} rows but 4D CCStock has {source_count}"
        )

    def test_no_unsigned_overflow(self, conn_pg, synced_ccstock):
        """No rows in ps_stock_central should have an implausibly large stock.

        The old assertion (stock >= 32768) was wrong: ps_stock_central.stock is the
        SUM of up to 34 signed-int16 slots, so legitimate positive totals can easily
        exceed 32767 (e.g. a busy SKU with many size slots).

        Instead we check for implausibly large values that would only appear if an
        undecoded WORD value (65535 max per slot × 34 slots = 2,227,090) slipped
        through without decoding. A threshold of 1,000,000 units is generous for a
        real SKU total yet safely below the undecoded-WORD explosion.
        """
        _ = synced_ccstock
        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_stock_central WHERE stock > 1000000")
            overflow_count = cur.fetchone()[0]

        assert overflow_count == 0, (
            f"{overflow_count} rows in ps_stock_central have stock > 1,000,000 "
            "— likely caused by undecoded WORD values from the p4d driver"
        )

    def test_total_stock_plausible(self, conn_pg, synced_ccstock):
        """SUM(stock) must be non-negative and less than 10M (sanity check)."""
        _ = synced_ccstock
        with conn_pg.cursor() as cur:
            cur.execute("SELECT COALESCE(SUM(stock), 0) FROM ps_stock_central")
            total = cur.fetchone()[0]

        assert total >= 0, f"Total central stock is negative: {total}"
        assert total < 10_000_000, f"Total central stock suspiciously large: {total}"
