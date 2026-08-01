"""Unit and integration tests for etl/sync/stock.py.

Unit tests cover helpers such as _normalize_expo_row without any external connections.

Integration tests require both a 4D SQL connection (P4D_HOST must be set) and a
PostgreSQL connection (POSTGRES_DSN or POSTGRES_USER + POSTGRES_DB must be set).
All integration tests skip gracefully when the required environment variables are absent.
The 4D integration tests use a bounded date range to keep query time predictable.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from etl.sync.stock import (
    _build_expo_where,
    _build_traspasos_where,
    _count_expo,
    _count_traspasos,
    _normalize_expo_row,
    _validate_since,
    sync_stock,
    sync_traspasos,
)


# ---------------------------------------------------------------------------
# Skip helpers
# ---------------------------------------------------------------------------


def _p4d_available() -> bool:
    """Return True if a 4D SQL connection is configured."""
    return bool(os.environ.get("P4D_HOST", "").strip())


def _postgres_available() -> bool:
    """Return True if a PostgreSQL connection is configured."""
    if os.environ.get("POSTGRES_DSN", "").strip():
        return True
    user = os.environ.get("POSTGRES_USER", "")
    db = os.environ.get("POSTGRES_DB", "")
    return bool(user and db)


def _both_available() -> bool:
    """Return True only when both 4D and PostgreSQL are configured."""
    return _p4d_available() and _postgres_available()


# ---------------------------------------------------------------------------
# Unit tests (no external connections required)
# ---------------------------------------------------------------------------


class TestNormalizeExpoRow:
    """Unit tests for _normalize_expo_row — no real connection needed."""

    def _make_row(self, pairs: list[tuple[str | None, int | None]]) -> dict:
        """Build a minimal Exportaciones dict with up to 34 Talla/Stock pairs."""
        row: dict = {
            "codigo": "144880",
            "tiendacodigo": "104/169",
            "tienda": "TIENDA TEST",
            "ccstock": 10.0,
            "ststock": 25.0,
            "fechamodifica": None,
        }
        for i in range(1, 35):
            idx = i - 1
            if idx < len(pairs):
                talla, stock = pairs[idx]
                row[f"talla{i}"] = talla
                row[f"stock{i}"] = stock
            else:
                row[f"talla{i}"] = None
                row[f"stock{i}"] = None
        return row

    def test_single_pair_emits_one_row(self):
        row = self._make_row([("38", 2)])
        result = _normalize_expo_row(row)
        assert len(result) == 1
        assert result[0]["talla"] == "38"
        assert result[0]["stock"] == 2
        assert result[0]["codigo"] == "144880"
        assert result[0]["tienda_codigo"] == "104/169"

    def test_multiple_pairs_emits_multiple_rows(self):
        row = self._make_row([("36", 1), ("38", 3), ("40", 0)])
        result = _normalize_expo_row(row)
        assert len(result) == 3
        tallas = [r["talla"] for r in result]
        assert tallas == ["36", "38", "40"]

    def test_empty_talla_is_skipped(self):
        row = self._make_row([("36", 1), ("", 5), (None, 2)])
        result = _normalize_expo_row(row)
        # Only "36" should produce a row; "" and None are skipped.
        assert len(result) == 1
        assert result[0]["talla"] == "36"

    def test_whitespace_talla_is_skipped(self):
        row = self._make_row([("  ", 3), ("40", 1)])
        result = _normalize_expo_row(row)
        assert len(result) == 1
        assert result[0]["talla"] == "40"

    def test_all_tallas_none_emits_no_rows(self):
        row = self._make_row([])
        result = _normalize_expo_row(row)
        assert result == []

    def test_stock_none_defaults_to_zero(self):
        row = self._make_row([("38", None)])
        result = _normalize_expo_row(row)
        assert result[0]["stock"] == 0

    def test_cc_stock_and_st_stock_present(self):
        row = self._make_row([("38", 5)])
        result = _normalize_expo_row(row)
        from decimal import Decimal

        assert result[0]["cc_stock"] == Decimal("10.0")
        assert result[0]["st_stock"] == Decimal("25.0")

    def test_cc_stock_none_preserved(self):
        row = self._make_row([("38", 5)])
        row["ccstock"] = None
        row["ststock"] = None
        result = _normalize_expo_row(row)
        assert result[0]["cc_stock"] is None
        assert result[0]["st_stock"] is None

    def test_talla_whitespace_stripped(self):
        row = self._make_row([("  38  ", 2)])
        result = _normalize_expo_row(row)
        assert result[0]["talla"] == "38"

    def test_missing_codigo_raises(self):
        """Missing Codigo should raise ValueError instead of silently producing empty key."""
        row = self._make_row([("38", 1)])
        row["codigo"] = None
        with pytest.raises(ValueError, match="Codigo"):
            _normalize_expo_row(row)

    def test_missing_tienda_codigo_raises(self):
        """Missing TiendaCodigo should raise ValueError instead of silently producing empty key."""
        row = self._make_row([("38", 1)])
        row["tiendacodigo"] = None
        with pytest.raises(ValueError, match="TiendaCodigo"):
            _normalize_expo_row(row)

    def test_cc_stock_computed_once(self):
        """cc_stock value is identical across all emitted rows (computed once per source row)."""
        row = self._make_row([("36", 1), ("38", 2), ("40", 3)])
        result = _normalize_expo_row(row)
        assert len(result) == 3
        from decimal import Decimal

        expected = Decimal("10.0")
        for r in result:
            assert r["cc_stock"] == expected

    def test_stock_65535_decodes_to_negative_one(self):
        """WORD-style unsigned -1 (65535) must become -1 in ps_stock_tienda.stock."""
        row = self._make_row([("38", 65535)])
        result = _normalize_expo_row(row)
        assert len(result) == 1
        assert result[0]["stock"] == -1

    def test_stock_65534_decodes_to_negative_two(self):
        row = self._make_row([("44", 65534)])
        result = _normalize_expo_row(row)
        assert result[0]["stock"] == -2

    def test_mixed_unsigned_negatives_sum_like_powershop(self):
        """Five slots at -1, one at -2, one at 0 → total stock -7 (matches CC-style sums)."""
        row = self._make_row(
            [
                ("38", 65535),
                ("40", 65535),
                ("42", 65534),
                ("44", 65535),
                ("46", 65535),
                ("48", 65535),
                ("50", 0),
            ]
        )
        result = _normalize_expo_row(row)
        assert sum(r["stock"] for r in result) == -7


_STORE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9/_-]+$")


class TestStoreCodeValidation:
    """Verify the store code regex pattern used in sync_stock matches expected codes."""

    def test_numeric_code_valid(self):
        assert _STORE_CODE_PATTERN.match("104")

    def test_compound_code_with_slash_valid(self):
        assert _STORE_CODE_PATTERN.match("104/169")

    def test_alphanumeric_code_valid(self):
        assert _STORE_CODE_PATTERN.match("TIENDA01")

    def test_code_with_dash_valid(self):
        assert _STORE_CODE_PATTERN.match("104-A")

    def test_empty_code_invalid(self):
        assert not _STORE_CODE_PATTERN.match("")

    def test_code_with_single_quote_invalid(self):
        assert not _STORE_CODE_PATTERN.match("104'; DROP TABLE--")

    def test_code_with_space_invalid(self):
        assert not _STORE_CODE_PATTERN.match("104 169")

    def test_code_with_semicolon_invalid(self):
        assert not _STORE_CODE_PATTERN.match("104;1")

    def test_sync_stock_skips_invalid_store_code(self):
        """sync_stock should skip stores whose codes fail the format check."""
        conn_4d = MagicMock()
        conn_pg = MagicMock()

        with (
            patch("etl.sync.stock._count_expo", return_value=0),
            patch("etl.sync.stock._build_expo_where", return_value=""),
            patch(
                "etl.sync.stock._get_store_codes",
                return_value=["valid_104", "bad code!", "104/169"],
            ),
            patch("etl.sync.stock.safe_fetch", return_value=[]) as mock_fetch,
        ):
            sync_stock(conn_4d, conn_pg, since=None)

        # safe_fetch should only be called for valid store codes (valid_104, 104/169)
        call_sqls = [call.args[1] for call in mock_fetch.call_args_list]
        assert any("valid_104" in s for s in call_sqls)
        assert any("104/169" in s for s in call_sqls)
        assert not any("bad code!" in s for s in call_sqls)


class TestValidateSince:
    """Unit tests for _validate_since — no connections needed.

    _validate_since logs a warning (not raises) when a non-midnight datetime is
    passed, because watermarks from set_watermark() include a time component and
    raising would break all delta syncs.  The 4D SQL filter uses only the date
    portion ({d 'YYYY-MM-DD'}), so the behaviour is still correct.
    """

    def test_midnight_utc_passes(self):
        dt = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        _validate_since(dt)  # should not raise

    def test_non_midnight_does_not_raise(self):
        """Non-midnight datetimes log a warning but do not raise."""
        dt = datetime(2026, 1, 1, 12, 30, 0, tzinfo=timezone.utc)
        _validate_since(dt)  # should not raise

    def test_microseconds_does_not_raise(self):
        """Datetimes with microseconds log a warning but do not raise."""
        dt = datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc)
        _validate_since(dt)  # should not raise

    def test_name_param_accepted(self):
        """The name parameter is accepted without error."""
        dt = datetime(2026, 3, 15, 10, 0, 0, tzinfo=timezone.utc)
        _validate_since(dt, name="my_param")  # should not raise


class TestBuildExpoWhere:
    """Unit tests for _build_expo_where — ensures >= boundary fix (issue #459)."""

    def test_since_uses_gte_not_gt(self):
        """Delta WHERE clause must use >= so same-day FechaModifica rows are included."""
        result = _build_expo_where(datetime(2026, 4, 30))
        assert "FechaModifica >= {d '2026-04-30'}" in result
        assert "FechaModifica > {d '2026-04-30'}" not in result

    def test_since_none_returns_empty(self):
        assert _build_expo_where(None) == ""

    def test_since_with_include_nulls(self):
        result = _build_expo_where(datetime(2026, 4, 30), include_nulls=True)
        assert "FechaModifica >= {d '2026-04-30'}" in result
        assert "FechaModifica IS NULL" in result

    def test_where_keyword_present(self):
        result = _build_expo_where(datetime(2026, 1, 15))
        assert result.startswith("WHERE ")


class TestBuildTraspasosWhere:
    """Unit tests for _build_traspasos_where — ensures >= boundary fix (issue #459)."""

    def test_since_uses_gte_not_gt(self):
        """Delta WHERE clause must use >= so same-day FechaS rows are included."""
        result = _build_traspasos_where(datetime(2026, 4, 30))
        assert "FechaS >= {d '2026-04-30'}" in result
        assert "FechaS > {d '2026-04-30'}" not in result

    def test_since_none_returns_empty(self):
        assert _build_traspasos_where(None) == ""

    def test_where_keyword_present(self):
        result = _build_traspasos_where(datetime(2026, 3, 1))
        assert result.startswith("WHERE ")


class TestCountHelpers:
    """Unit tests for _count_expo / _count_traspasos — no real connection needed.

    Regression coverage for the ``int() argument ... not 'NoneType'`` crash that
    surfaced on stock/traspasos delta runs when the p4d driver returned a row
    whose first value was ``None``.  The helpers are used for progress logging
    only, so they must degrade to 0 instead of aborting the sync.
    """

    def test_count_expo_reads_cnt_alias(self):
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[{"cnt": 42}]) as mf:
            assert _count_expo(conn, "") == 42
        sql = mf.call_args.args[1]
        assert "COUNT(*) AS cnt" in sql
        assert "FROM Exportaciones" in sql

    def test_count_expo_none_value_returns_zero(self):
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[{"cnt": None}]):
            assert _count_expo(conn, "") == 0

    def test_count_expo_empty_result_returns_zero(self):
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[]):
            assert _count_expo(conn, "") == 0

    def test_count_expo_falls_back_to_first_value_when_alias_missing(self):
        """Driver quirk: if ``cnt`` key is absent, use the first value in the row."""
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[{"expr_1": 7}]):
            assert _count_expo(conn, "") == 7

    def test_count_traspasos_reads_cnt_alias(self):
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[{"cnt": 3}]) as mf:
            assert _count_traspasos(conn, "") == 3
        sql = mf.call_args.args[1]
        assert "COUNT(*) AS cnt" in sql
        assert "FROM Traspasos" in sql

    def test_count_traspasos_none_value_returns_zero(self):
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[{"cnt": None}]):
            assert _count_traspasos(conn, "") == 0

    def test_count_traspasos_empty_result_returns_zero(self):
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[]):
            assert _count_traspasos(conn, "") == 0

    def test_count_traspasos_falls_back_to_first_value_when_alias_missing(self):
        """Driver quirk: if ``cnt`` key is absent, use the first value in the row."""
        conn = MagicMock()
        with patch("etl.sync.stock.safe_fetch", return_value=[{"expr_1": 9}]):
            assert _count_traspasos(conn, "") == 9


# ---------------------------------------------------------------------------
# Integration tests (require P4D_HOST + PostgreSQL)
# ---------------------------------------------------------------------------


# Integration start date: configurable via ETL_TEST_SINCE_DAYS env var (default 90
# days back from now) to keep the sync window bounded and prevent tests from
# growing slower as more data accumulates.  Exportaciones rows are frequently
# touched, so a 90-day window reliably has rows.
def _integration_since() -> datetime:
    """Return a midnight-aligned UTC datetime N days back (default 90).

    Midnight-aligned because 4D SQL date filters only use the date portion —
    passing a datetime with a non-zero time component logs a warning (date portion is still used).
    """
    days = int(os.environ.get("ETL_TEST_SINCE_DAYS", "90"))
    today = datetime.now(tz=timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return today - timedelta(days=days)


_INTEGRATION_SINCE = _integration_since()


@pytest.fixture
def fourd_conn():
    """Yield a P4D connection; skip if either backend is absent.

    Both backends are required — guard with _both_available() to avoid
    constructing Config() (which validates PG env vars) when only P4D is set.
    Function scope (same as pg_conn) avoids pytest ScopeMismatch errors.
    """
    if not _both_available():
        pytest.skip(
            "P4D_HOST or PostgreSQL configuration not available — "
            "skipping integration tests"
        )
    from etl.config import Config
    from etl.db import fourd

    config = Config()
    conn = fourd.get_connection(config)
    yield conn
    conn.close()


def _require_integration_writes() -> None:
    """Skip if ALLOW_DESTRUCTIVE_TESTS=1 is not set.

    sync_stock() upserts into ps_stock_tienda (not a TRUNCATE, but it modifies
    real data).  Guard with an explicit opt-in so tests are not accidentally run
    against a non-test database.
    """
    if os.environ.get("ALLOW_DESTRUCTIVE_TESTS", "").strip() != "1":
        pytest.skip(
            "Set ALLOW_DESTRUCTIVE_TESTS=1 to run integration tests that write "
            "to ps_stock_tienda / ps_traspasos"
        )


class TestSyncStockIntegration:
    """Integration tests that require both 4D and PostgreSQL connections.

    All tests write to real schema tables (ps_stock_tienda, ps_traspasos).
    Set ALLOW_DESTRUCTIVE_TESTS=1 to enable.
    """

    def test_sync_stock_produces_rows(self, fourd_conn, pg_conn):
        """Verify that sync_stock processes rows and ps_stock_tienda is populated."""
        _require_integration_writes()
        attempted = sync_stock(fourd_conn, pg_conn, since=_INTEGRATION_SINCE)
        assert attempted > 0, (
            f"sync_stock returned 0 attempted rows for the {_INTEGRATION_SINCE.date()} window — "
            "no stock data was found or the query window is too narrow"
        )

        with pg_conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_stock_tienda")
            (count_after,) = cur.fetchone()

        assert count_after > 0, (
            "ps_stock_tienda is empty after sync_stock — "
            "rows were not written to PostgreSQL"
        )

    def test_stock_no_empty_tallas(self, fourd_conn, pg_conn):
        """After sync, no rows in ps_stock_tienda should have empty talla."""
        _require_integration_writes()
        attempted = sync_stock(fourd_conn, pg_conn, since=_INTEGRATION_SINCE)
        assert attempted > 0, (
            "sync_stock returned 0 rows — cannot validate talla filtering on empty table"
        )

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM ps_stock_tienda "
                "WHERE talla IS NULL OR TRIM(talla) = ''"
            )
            (bad_rows,) = cur.fetchone()

        assert bad_rows == 0, (
            f"{bad_rows} rows in ps_stock_tienda have empty/NULL talla — "
            "normalization is not filtering them correctly"
        )

    def test_traspasos_count(self, fourd_conn, pg_conn):
        """Full sync of Traspasos: row count in PostgreSQL matches 4D count.

        Requires ALLOW_DESTRUCTIVE_TESTS=1 to protect against accidentally
        running against a non-test database (this test truncates ps_traspasos).
        """
        allow = os.environ.get("ALLOW_DESTRUCTIVE_TESTS", "").strip()
        if allow != "1":
            pytest.skip(
                "Set ALLOW_DESTRUCTIVE_TESTS=1 to run tests that truncate "
                "production tables (test_traspasos_count)"
            )

        conn_pg = pg_conn

        # Truncate before full sync to avoid duplicates from previous test runs.
        with conn_pg.cursor() as cur:
            cur.execute("TRUNCATE ps_traspasos")
        conn_pg.commit()

        attempted = sync_traspasos(fourd_conn, conn_pg, since=None)

        # Verify row count matches source.
        from etl.db.fourd import safe_fetch

        source_rows = safe_fetch(fourd_conn, "SELECT COUNT(*) FROM Traspasos")
        source_count = int(next(iter(source_rows[0].values())))

        with conn_pg.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM ps_traspasos")
            (pg_count,) = cur.fetchone()

        assert attempted == pg_count
        assert pg_count == source_count, (
            f"Traspasos count mismatch: 4D has {source_count}, "
            f"PostgreSQL has {pg_count}"
        )


class TestMapTraspasoRowQuantization:
    """Issue #827: RegTraspaso must be quantized to 3 decimal places.

    ps_traspasos.reg_traspaso is NUMERIC(20,3) and real 4D PKs can differ only
    in the third decimal (e.g. 4.152 vs 4.153). The previous scale-2 quantize
    collided such pairs onto one key, silently losing rows via the append-only
    ON CONFLICT DO NOTHING insert.
    """

    @staticmethod
    def _src(reg: float) -> dict:
        return {
            "regtraspaso": reg,
            "codigo": "144880",
            "descripcion": "test",
            "talla": "38",
            "unidadess": 1,
            "unidadese": 1,
            "tiendasalida": "104",
            "tiendaentrada": "105",
            "fechas": None,
            "fechae": None,
            "tipo": None,
            "concepto": None,
            "entrada": None,
        }

    def test_three_decimal_pks_stay_distinct(self):
        from etl.sync.stock import _map_traspaso_row

        a = _map_traspaso_row(self._src(4.152))["reg_traspaso"]
        b = _map_traspaso_row(self._src(4.153))["reg_traspaso"]
        assert a != b, "scale-2 rounding would collide 4.152 and 4.153"
        assert str(a) == "4.152"
        assert str(b) == "4.153"

    def test_float_artifacts_still_normalised(self):
        from etl.sync.stock import _map_traspaso_row

        v = _map_traspaso_row(self._src(10.989999999999998))["reg_traspaso"]
        assert str(v) == "10.990"


class TestSyncStockSkipsInvalidRows:
    """Issue #820: a row with a missing PK component must be skipped with a
    warning — not abort the whole multi-store sync and stall the watermark."""

    @staticmethod
    def _expo_row(codigo: str | None, tienda_codigo: str | None) -> dict:
        row: dict = {
            "codigo": codigo,
            "tiendacodigo": tienda_codigo,
            "tienda": "104",
            "ccstock": 1.0,
            "ststock": 1.0,
            "fechamodifica": None,
        }
        for i in range(1, 35):
            row[f"talla{i}"] = "38" if i == 1 else None
            row[f"stock{i}"] = 2 if i == 1 else None
        return row

    def test_bad_row_is_skipped_and_good_rows_land(self, caplog):
        conn_4d, conn_pg = MagicMock(), MagicMock()
        rows = [
            self._expo_row("144880", "104/169"),  # good
            self._expo_row(None, "104/169"),  # corrupt: Codigo NULL
            self._expo_row("144881", "104/169"),  # good
        ]
        with (
            patch("etl.sync.stock._count_expo", return_value=3),
            patch("etl.sync.stock._build_expo_where", return_value=""),
            patch("etl.sync.stock._get_store_codes", return_value=["104"]),
            patch("etl.sync.stock.safe_fetch", return_value=rows),
            patch(
                "etl.sync.stock.upsert", side_effect=lambda c, t, rs, pk_cols: len(rs)
            ) as mock_upsert,
        ):
            import logging

            with caplog.at_level(logging.WARNING, logger="etl.sync.stock"):
                total = sync_stock(conn_4d, conn_pg, since=None)

        # The two good source rows (one talla pair each) were upserted.
        assert total == 2
        assert mock_upsert.call_count == 1
        upserted = mock_upsert.call_args[0][2]
        assert {r["codigo"] for r in upserted} == {"144880", "144881"}
        # The skip is loud: per-row warning + end-of-run summary.
        assert any("skipping invalid row" in r.message for r in caplog.records)
        assert any("skipped 1 invalid source row" in r.message for r in caplog.records)

    def test_all_rows_bad_completes_with_zero(self):
        conn_4d, conn_pg = MagicMock(), MagicMock()
        rows = [self._expo_row(None, None)]
        with (
            patch("etl.sync.stock._count_expo", return_value=1),
            patch("etl.sync.stock._build_expo_where", return_value=""),
            patch("etl.sync.stock._get_store_codes", return_value=["104"]),
            patch("etl.sync.stock.safe_fetch", return_value=rows),
            patch("etl.sync.stock.upsert") as mock_upsert,
        ):
            total = sync_stock(conn_4d, conn_pg, since=None)

        assert total == 0
        mock_upsert.assert_not_called()
