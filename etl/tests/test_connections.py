"""Integration tests for PostgreSQL helpers.

Tests use the pg_conn fixture for database connectivity. They require either:
- POSTGRES_DSN to be set, or
- POSTGRES_USER + POSTGRES_DB (+ optionally POSTGRES_PASSWORD, POSTGRES_HOST,
  POSTGRES_PORT) matching the split variables in .env.example.
Tests skip gracefully when no supported configuration is available.

Most tests create TEMPORARY tables to avoid polluting the real schema; these
tables are cleaned up automatically when the test connection closes, even on
test failures.
test_restart_identity is an exception: GENERATED ALWAYS AS IDENTITY requires a
real (non-temp) table, so it creates and drops a permanent table and cleans up
in a finally block.
The watermark test intentionally operates on the real etl_watermarks table to
exercise end-to-end behavior and cleans up after itself.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from etl.db import postgres


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_temp_table(conn, table: str, col_defs: str) -> None:
    """Create a session-scoped temporary table, replacing any existing one.

    The DROP is qualified with pg_temp to avoid accidentally dropping a
    permanent table that happens to share the same name.
    The table name is quoted via psycopg2.sql.Identifier to handle edge cases.
    """
    from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

    tbl_id = pgsql.Identifier(table)
    with conn.cursor() as cur:
        cur.execute(pgsql.SQL("DROP TABLE IF EXISTS pg_temp.{tbl}").format(tbl=tbl_id))
        # col_defs is a literal string written in this test module — safe to interpolate.
        cur.execute(
            pgsql.SQL("CREATE TEMP TABLE {tbl} ({col_defs})").format(
                tbl=tbl_id,
                col_defs=pgsql.SQL(col_defs),
            )
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestUpsert:
    TABLE = "etl_test_upsert"

    def test_upsert(self, pg_conn):
        """Upsert 3 rows, update 1, verify 3 rows with updated value."""
        conn = pg_conn
        _create_temp_table(
            conn,
            self.TABLE,
            "id INTEGER PRIMARY KEY, name TEXT, value INTEGER",
        )

        rows = [
            {"id": 1, "name": "alpha", "value": 10},
            {"id": 2, "name": "beta", "value": 20},
            {"id": 3, "name": "gamma", "value": 30},
        ]
        affected = postgres.upsert(conn, self.TABLE, rows, pk_cols=["id"])
        assert affected == 3

        # Update row id=2
        updated = [{"id": 2, "name": "beta_updated", "value": 99}]
        postgres.upsert(conn, self.TABLE, updated, pk_cols=["id"])

        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn.cursor() as cur:
            cur.execute(
                pgsql.SQL("SELECT id, name, value FROM {tbl} ORDER BY id").format(
                    tbl=pgsql.Identifier(self.TABLE)
                )
            )
            result = cur.fetchall()

        assert len(result) == 3
        assert result[1] == (2, "beta_updated", 99)


class TestTruncateAndInsert:
    TABLE = "etl_test_truncate"
    TABLE_IDENTITY = "etl_test_truncate_identity"

    def test_truncate_and_insert(self, pg_conn):
        """Insert 3 rows, then truncate+insert 2, verify only 2 remain."""
        conn = pg_conn
        _create_temp_table(
            conn,
            self.TABLE,
            "id INTEGER PRIMARY KEY, val TEXT",
        )

        rows3 = [{"id": i, "val": f"v{i}"} for i in range(1, 4)]
        postgres.truncate_and_insert(conn, self.TABLE, rows3)

        rows2 = [{"id": i, "val": f"v{i}"} for i in range(10, 12)]
        count = postgres.truncate_and_insert(conn, self.TABLE, rows2)

        assert count == 2
        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn.cursor() as cur:
            cur.execute(
                pgsql.SQL("SELECT COUNT(*) FROM {tbl}").format(
                    tbl=pgsql.Identifier(self.TABLE)
                )
            )
            (n,) = cur.fetchone()
        assert n == 2

    def test_truncate_empty_rows(self, pg_conn):
        """truncate_and_insert with empty rows truncates the table and returns 0."""
        conn = pg_conn
        _create_temp_table(conn, self.TABLE, "id INTEGER PRIMARY KEY, val TEXT")

        # Seed 2 rows, then truncate to empty
        rows = [{"id": i, "val": f"v{i}"} for i in range(1, 3)]
        postgres.truncate_and_insert(conn, self.TABLE, rows)
        count = postgres.truncate_and_insert(conn, self.TABLE, [])

        assert count == 0
        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn.cursor() as cur:
            cur.execute(
                pgsql.SQL("SELECT COUNT(*) FROM {tbl}").format(
                    tbl=pgsql.Identifier(self.TABLE)
                )
            )
            (n,) = cur.fetchone()
        assert n == 0

    def test_restart_identity(self, pg_conn):
        """truncate_and_insert with restart_identity=True resets the identity sequence."""
        conn = pg_conn
        # TEMP tables with GENERATED ALWAYS AS IDENTITY require a real table in postgres
        # — use a regular table and clean up in finally.
        table = self.TABLE_IDENTITY
        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        tbl_id = pgsql.Identifier(table)
        with conn.cursor() as cur:
            cur.execute(pgsql.SQL("DROP TABLE IF EXISTS {tbl}").format(tbl=tbl_id))
            cur.execute(
                pgsql.SQL(
                    "CREATE TABLE {tbl} "
                    "(id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, val TEXT)"
                ).format(tbl=tbl_id)
            )
        conn.commit()
        try:
            rows1 = [{"val": "a"}, {"val": "b"}]
            postgres.bulk_insert(conn, table, rows1)

            # Truncate + restart identity, then insert 1 row
            postgres.truncate_and_insert(
                conn, table, [{"val": "c"}], restart_identity=True
            )

            with conn.cursor() as cur:
                cur.execute(pgsql.SQL("SELECT id, val FROM {tbl}").format(tbl=tbl_id))
                result = cur.fetchall()

            assert len(result) == 1
            # After RESTART IDENTITY the first id should be 1 (not 3)
            assert result[0][0] == 1
        finally:
            with conn.cursor() as cur:
                cur.execute(pgsql.SQL("DROP TABLE IF EXISTS {tbl}").format(tbl=tbl_id))
            conn.commit()


class TestWatermark:
    TABLE_NAME = "_etl_test_watermark_tbl"

    def test_watermark(self, pg_conn):
        """Set a watermark, get it back, verify the value matches."""
        conn = pg_conn

        def _cleanup() -> None:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM etl_watermarks WHERE table_name = %s",
                    (self.TABLE_NAME,),
                )
            conn.commit()

        # Drive table creation through the public API (creates table if missing).
        _ = postgres.get_watermark(conn, self.TABLE_NAME)

        # Clean up any leftover entry before assertions
        _cleanup()

        try:
            # Should be None before setting
            wm = postgres.get_watermark(conn, self.TABLE_NAME)
            assert wm is None

            ts = datetime(2026, 1, 15, 3, 0, 0, tzinfo=timezone.utc)
            postgres.set_watermark(conn, self.TABLE_NAME, ts, rows_synced=42)

            wm = postgres.get_watermark(conn, self.TABLE_NAME)
            assert wm is not None
            # Normalize both to UTC to avoid mismatches from PostgreSQL session TZ.
            assert wm.astimezone(timezone.utc) == ts.astimezone(timezone.utc)
        finally:
            # Always clean up, even if assertions fail
            _cleanup()


class TestBulkInsert:
    TABLE = "etl_test_bulk"

    def test_bulk_insert(self, pg_conn):
        """Bulk-insert 3 rows and verify count."""
        conn = pg_conn
        _create_temp_table(
            conn,
            self.TABLE,
            "id SERIAL PRIMARY KEY, msg TEXT",
        )

        rows = [{"msg": f"msg{i}"} for i in range(3)]
        count = postgres.bulk_insert(conn, self.TABLE, rows)
        assert count == 3

        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn.cursor() as cur:
            cur.execute(
                pgsql.SQL("SELECT COUNT(*) FROM {tbl}").format(
                    tbl=pgsql.Identifier(self.TABLE)
                )
            )
            (n,) = cur.fetchone()
        assert n == 3


class TestInsertIgnore:
    TABLE = "etl_test_insert_ignore"

    def test_insert_ignore_new_rows(self, pg_conn):
        """insert_ignore inserts new rows successfully."""
        conn = pg_conn
        _create_temp_table(
            conn,
            self.TABLE,
            "id INTEGER PRIMARY KEY, val TEXT",
        )

        rows = [{"id": 1, "val": "a"}, {"id": 2, "val": "b"}]
        count = postgres.insert_ignore(conn, self.TABLE, rows, pk_cols=["id"])
        assert count == 2

        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn.cursor() as cur:
            cur.execute(
                pgsql.SQL("SELECT COUNT(*) FROM {tbl}").format(
                    tbl=pgsql.Identifier(self.TABLE)
                )
            )
            (n,) = cur.fetchone()
        assert n == 2

    def test_insert_ignore_skips_duplicates(self, pg_conn):
        """insert_ignore silently skips rows that conflict on pk_cols."""
        conn = pg_conn
        _create_temp_table(
            conn,
            self.TABLE,
            "id INTEGER PRIMARY KEY, val TEXT",
        )

        # First insert
        rows = [{"id": 1, "val": "original"}]
        postgres.insert_ignore(conn, self.TABLE, rows, pk_cols=["id"])

        # Second insert with same PK but different value — must not update the row.
        rows_dup = [{"id": 1, "val": "should_be_ignored"}, {"id": 2, "val": "new"}]
        count = postgres.insert_ignore(conn, self.TABLE, rows_dup, pk_cols=["id"])
        assert count == 2  # attempted (not inserted count)

        from psycopg2 import sql as pgsql  # type: ignore[import-untyped]

        with conn.cursor() as cur:
            cur.execute(
                pgsql.SQL("SELECT id, val FROM {tbl} ORDER BY id").format(
                    tbl=pgsql.Identifier(self.TABLE)
                )
            )
            result = cur.fetchall()

        assert len(result) == 2
        # Row id=1 must still have the original value — not overwritten.
        assert result[0] == (1, "original")
        assert result[1] == (2, "new")


class TestSetWatermarkNaiveDatetime:
    def test_naive_datetime_raises(self, pg_conn):
        """set_watermark must reject a naive datetime to prevent session-TZ ambiguity."""
        conn = pg_conn
        naive_ts = datetime(2026, 1, 15, 3, 0, 0)  # no tzinfo
        with pytest.raises(ValueError, match="timezone-aware"):
            postgres.set_watermark(conn, "_test_naive_ts", naive_ts, rows_synced=0)
