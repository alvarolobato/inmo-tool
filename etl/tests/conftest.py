"""Pytest fixtures for ETL tests."""

import os

import pytest

from etl.config import Config


def _postgres_available() -> bool:
    """Return True if PostgreSQL appears to be configured in the environment.

    Tests are skipped only when no PostgreSQL configuration is present.
    Misconfigured variables (e.g., invalid P4D_PORT) are allowed to fail the
    test rather than silently skip it.

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
    """
    if not _postgres_available():
        pytest.skip(
            "PostgreSQL configuration not available — skipping PostgreSQL tests"
        )

    from etl.db import postgres

    config = Config()
    conn = postgres.get_connection(config)
    yield conn
    conn.close()
