"""Pytest fixtures for ETL tests."""

import os

import pytest

from etl.config import Config


def _postgres_available() -> bool:
    """Return True if PostgreSQL appears to be configured in the environment.

    Tests are skipped only when no PostgreSQL configuration is present.
    Misconfigured variables (e.g., an invalid POSTGRES_DSN) are allowed to
    fail the test rather than silently skip it.

    Aligns with etl.config._get_postgres_dsn() DSN resolution rules:
    - POSTGRES_DSN takes precedence.
    - Otherwise, POSTGRES_USER + POSTGRES_DB are the minimum required (password
      may be empty for local/passwordless auth).
    """
    if os.environ.get("POSTGRES_DSN", "").strip():
        return True

    user = os.environ.get("POSTGRES_USER", "")
    db = os.environ.get("POSTGRES_DB", "")
    return bool(user and db)


@pytest.fixture
def pg_conn():
    """Yield a psycopg2 connection; skip the test if no PostgreSQL config is present.

    If the configuration is present but incorrect (e.g., wrong password), the
    test will fail rather than skip — misconfiguration should surface as a failure.

    #156 review, must-fix 4 (source-side half): CI's `test` job currently sets
    `POSTGRES_DSN=""`, so every DB-backed test here (including
    TestAiAssessmentRekeyMigration) has been silently skipping and reporting
    green — the workflow-file fix for that is proposed separately (it can't be
    pushed from here, see D-004 / docs/pending-workflow-changes/). This is the
    part of the fix that *can* land in source: when `REQUIRE_DB=1` is set (CI
    should set it once the Postgres service is wired in), a missing DB config
    is a hard failure instead of a skip, so a future regression in the
    workflow file (a dropped `services:` block, a cleared `POSTGRES_DSN`) trips
    CI immediately instead of reverting to silent green.
    """
    if not _postgres_available():
        if os.environ.get("REQUIRE_DB") == "1":
            raise RuntimeError(
                "REQUIRE_DB=1 but no PostgreSQL configuration is present. "
                "Set POSTGRES_DSN (or POSTGRES_USER + POSTGRES_DB), or unset "
                "REQUIRE_DB to allow this test to skip."
            )
        pytest.skip(
            "PostgreSQL configuration not available — skipping PostgreSQL tests"
        )

    from etl.db import postgres

    config = Config()
    conn = postgres.get_connection(config)
    yield conn
    conn.close()
