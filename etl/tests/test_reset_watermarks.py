"""Tests for create_manual_trigger / get_trigger_force_flags / check_and_consume_trigger.

These helpers back the "Forzar re-sync completo" feature on the dashboard
Monitor ETL page (issue #398). They insert/read a pending row in the
``etl_manual_trigger`` table carrying force_full / force_tables.

The integration tests use the real pg_conn fixture so they exercise the DDL
applied from init.sql (force_full / force_tables columns) and the partial
unique index on status='pending'.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from etl.db import postgres

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

_MONITORING_AVAILABLE = hasattr(postgres, "create_manual_trigger")

_requires_feature = pytest.mark.skipif(
    not _MONITORING_AVAILABLE,
    reason="create_manual_trigger helper not available",
)


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _clear_trigger_rows(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM etl_manual_trigger")
    conn.commit()


class TestCreateManualTrigger:
    @_requires_feature
    def test_defaults_are_incremental(self, pg_conn):
        _apply_schema(pg_conn)
        _clear_trigger_rows(pg_conn)
        try:
            trigger_id = postgres.create_manual_trigger(pg_conn)
            force_full, force_tables, triggered_by = postgres.get_trigger_force_flags(
                pg_conn, trigger_id
            )
            assert force_full is False
            assert force_tables == []
            assert triggered_by == "dashboard"
        finally:
            _clear_trigger_rows(pg_conn)

    @_requires_feature
    def test_force_flags_persist(self, pg_conn):
        _apply_schema(pg_conn)
        _clear_trigger_rows(pg_conn)
        try:
            trigger_id = postgres.create_manual_trigger(
                pg_conn, force_full=True, force_tables=["stock", "ventas"]
            )
            force_full, force_tables, _triggered_by = postgres.get_trigger_force_flags(
                pg_conn, trigger_id
            )
            assert force_full is True
            assert sorted(force_tables) == ["stock", "ventas"]
        finally:
            _clear_trigger_rows(pg_conn)

    @_requires_feature
    def test_unknown_trigger_returns_defaults(self, pg_conn):
        _apply_schema(pg_conn)
        force_full, force_tables, triggered_by = postgres.get_trigger_force_flags(
            pg_conn, 10_000_000
        )
        assert force_full is False
        assert force_tables == []
        assert triggered_by is None

    @_requires_feature
    def test_triggered_by_persists(self, pg_conn):
        """triggered_by audit field is stored and returned correctly."""
        _apply_schema(pg_conn)
        _clear_trigger_rows(pg_conn)
        try:
            trigger_id = postgres.create_manual_trigger(
                pg_conn, triggered_by="192.168.1.10"
            )
            _, _, triggered_by = postgres.get_trigger_force_flags(pg_conn, trigger_id)
            assert triggered_by == "192.168.1.10"
        finally:
            _clear_trigger_rows(pg_conn)

    @_requires_feature
    def test_check_and_consume_returns_existing_id(self, pg_conn):
        """Forwards compat: check_and_consume_trigger still returns a plain int."""
        _apply_schema(pg_conn)
        _clear_trigger_rows(pg_conn)
        try:
            trigger_id = postgres.create_manual_trigger(
                pg_conn, force_full=False, force_tables=["stock"]
            )
            claimed = postgres.check_and_consume_trigger(pg_conn)
            assert claimed == trigger_id
            # After consume, the row exists as picked_up; force flags still readable.
            force_full, force_tables, _triggered_by = postgres.get_trigger_force_flags(
                pg_conn, trigger_id
            )
            assert force_full is False
            assert force_tables == ["stock"]
        finally:
            _clear_trigger_rows(pg_conn)
