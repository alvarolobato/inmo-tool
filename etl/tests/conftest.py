"""Pytest fixtures for ETL tests."""

import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest

from etl.config import Config

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


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


def _unique_db_name() -> str:
    """A Postgres-identifier-safe, collision-resistant database name for one
    test session: lowercase letters/digits/underscores, starting with a
    letter (so it never needs quoting)."""
    return f"inmotool_test_{int(time.time())}_{secrets.token_hex(4)}"


def _dsn_with_db(dsn: str, db_name: str) -> str:
    """Return *dsn* with its path (database name) replaced by *db_name*,
    keeping host/port/user/password/query/fragment untouched."""
    parts = urlsplit(dsn)
    return urlunsplit(
        (parts.scheme, parts.netloc, f"/{db_name}", parts.query, parts.fragment)
    )


@pytest.fixture(scope="session", autouse=True)
def _isolated_test_database():
    """Give this pytest session its own throwaway PostgreSQL database.

    Issue #159: real-Postgres integration tests across etl/tests/ and
    dashboard/**/*.integration.test.ts used to share one database. Two
    suites running at once deadlocked and produced phantom failures; a
    crashed run could leave a stray row (e.g. in connector_config) that a
    later, unrelated run then failed against. Both symptoms were contention
    and stale state, not defects in the code under test — but they read
    exactly like defects.

    This fixture removes the shared resource rather than coordinating access
    to it: connect using whatever POSTGRES_* config is already present
    (pointing at some already-existing, reachable database), CREATE DATABASE
    for a fresh randomly-named database scoped to this one pytest session,
    point POSTGRES_DSN at it for the rest of the session (every `Config()`
    built after this fixture runs resolves to the isolated database — see
    etl/config.py's `_get_postgres_dsn`, which re-reads os.environ on every
    call, and etl/config_loader.py's `load_config`, which does the same),
    apply schema/init.sql once up front (most test files re-apply it
    idempotently themselves via their own `_apply_schema()` helper, but a
    few — test_otel_schema.py, the watermark test in test_connections.py —
    assume it already exists), then drop the database at teardown.
    Because the database is unique and freshly created, there is no
    pre-existing state to "detect and fail loudly on" — a fresh CREATE
    DATABASE *is* that guarantee, structurally, rather than a runtime check
    that could itself be skipped or get out of sync.

    A crashed/interrupted run simply leaves an orphaned, uniquely-named
    database behind — it is never read by (and cannot collide with) any
    subsequent run, satisfying the "interrupted run must not affect the next
    run" acceptance criterion without needing any cleanup-on-startup logic.

    Session-scoped + autouse: runs once per `pytest etl/tests/` invocation,
    before any test (including the first `pg_conn` use), and its teardown
    runs after the last test in the session.
    """
    if not _postgres_available():
        # No PostgreSQL configured at all — pg_conn's own skip/REQUIRE_DB
        # logic still applies per-test; nothing to isolate.
        yield
        return

    base_config = Config()
    admin_dsn = base_config.postgres_dsn
    db_name = _unique_db_name()

    import psycopg2  # local import: mirrors etl/db/postgres.py's lazy import

    try:
        admin_conn = psycopg2.connect(admin_dsn)
    except psycopg2.OperationalError as exc:
        # Base config present but unreachable/misconfigured — pg_conn's own
        # per-test connection attempt will raise the same failure (or
        # REQUIRE_DB will demand it does); nothing more to do here.
        if os.environ.get("REQUIRE_DB") == "1":
            raise RuntimeError(
                f"REQUIRE_DB=1 but could not reach PostgreSQL to create an "
                f"isolated test database: {exc}"
            ) from exc
        yield
        return

    admin_conn.autocommit = (
        True  # CREATE/DROP DATABASE cannot run in a transaction block
    )
    try:
        with admin_conn.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        admin_conn.close()

    test_dsn = _dsn_with_db(admin_dsn, db_name)

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("POSTGRES_DSN", test_dsn)

    schema_conn = psycopg2.connect(test_dsn)
    try:
        with schema_conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
        schema_conn.commit()
    finally:
        schema_conn.close()

    try:
        yield
    finally:
        monkeypatch.undo()

        admin_conn = psycopg2.connect(admin_dsn)
        admin_conn.autocommit = True
        try:
            with admin_conn.cursor() as cur:
                # Terminate any lingering backends (a connection pool that
                # didn't get closed cleanly) before dropping — DROP DATABASE
                # fails while sessions are still attached.
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = %s AND pid <> pg_backend_pid()",
                    (db_name,),
                )
                cur.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
        finally:
            admin_conn.close()


@pytest.fixture
def pg_conn():
    """Yield a psycopg2 connection; skip the test if no PostgreSQL config is present.

    If the configuration is present but incorrect (e.g., wrong password), the
    test will fail rather than skip — misconfiguration should surface as a failure.

    Connects to the per-session isolated database set up by
    `_isolated_test_database` (issue #159) — every test using this fixture
    within the same `pytest` invocation shares that one throwaway database,
    never the developer's/CI's persistent one.

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
