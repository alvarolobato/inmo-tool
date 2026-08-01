"""Tests for the OTel trace_id / span_id column additions in init.sql.

These tests run against the live PostgreSQL mirror when available,
and verify that the expected columns and indices exist after the migration.
"""

import os

import pytest


def _postgres_available() -> bool:
    if os.environ.get("POSTGRES_DSN", "").strip():
        return True
    return bool(
        os.environ.get("POSTGRES_USER", "") and os.environ.get("POSTGRES_DB", "")
    )


EXPECTED_COLUMNS = [
    ("etl_sync_runs", "trace_id"),
    ("etl_sync_runs", "span_id"),
    ("etl_sync_run_tables", "trace_id"),
    ("etl_sync_run_tables", "span_id"),
    ("llm_tool_calls", "trace_id"),
    ("llm_tool_calls", "span_id"),
    ("llm_errors", "trace_id"),
    ("llm_errors", "span_id"),
    ("llm_interactions", "trace_id"),
    ("llm_interactions", "span_id"),
]

EXPECTED_INDICES = [
    "idx_etl_sync_runs_trace_id",
    "idx_etl_sync_run_tables_trace_id",
    "idx_llm_tool_calls_trace_id",
    "idx_llm_errors_trace_id",
    "idx_llm_interactions_trace_id",
]


@pytest.mark.skipif(not _postgres_available(), reason="PostgreSQL not configured")
@pytest.mark.parametrize("table,column", EXPECTED_COLUMNS)
def test_trace_column_exists(pg_conn, table, column):
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = %s AND column_name = %s
            """,
            (table, column),
        )
        row = cur.fetchone()
    assert row is not None, (
        f"Column {table}.{column} is missing — run init.sql migration"
    )


@pytest.mark.skipif(not _postgres_available(), reason="PostgreSQL not configured")
@pytest.mark.parametrize("index_name", EXPECTED_INDICES)
def test_trace_index_exists(pg_conn, index_name):
    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE indexname = %s",
            (index_name,),
        )
        row = cur.fetchone()
    assert row is not None, f"Index {index_name} is missing — run init.sql migration"
