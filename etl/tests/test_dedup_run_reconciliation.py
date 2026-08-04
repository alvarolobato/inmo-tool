"""Coverage for D-036: stuck/orphaned dedup-run monitoring + handling.

On the live instance, `dedup_runs` rows got stuck at status='running' with
finished_at=NULL *forever* whenever a dedup pass was killed mid-run (SIGKILL,
container restart, OOM) — three rows were orphaned (9h/10h/19h old) with no
mechanism to detect or clean them, and nothing stopped a second pass from
overlapping the first (the owner saw three concurrent 'running' rows).

Three mechanisms are exercised here, all against a real PostgreSQL in the
same style the rest of etl/tests/ uses (mocking the DB would test nothing —
the whole point is what gets persisted and how a stuck row is detected):

1. `TestOrphanReconciliation` — `_reconcile_orphaned_dedup_runs` marks a
   dead, past-max-runtime 'running' row as 'failed' with an explanatory
   `error_msg`, and never touches a genuinely-recent running row.
2. `TestRunDedupReconcilesOnStart` — `run_dedup` runs that reconciliation at
   the start of every pass, so an orphan never lingers.
3. `TestSingleRunnerGuard` — a second dedup pass is refused (returns None,
   creates no row) while another holds the advisory lock, and proceeds once
   the lock is free.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from etl import orchestrator
from etl.config import Config
from etl.db import postgres
from etl.dedup.cli import _cmd_run as dedup_cli_run

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _insert_dedup_run(conn, *, status: str, age_interval: str) -> int:
    """Insert a `dedup_runs` row with an explicit age, finished_at left NULL.

    `age_interval` is any PostgreSQL interval literal (e.g. '10 hours', '0
    seconds') applied to NOW() for `started_at`.
    """
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO dedup_runs (trigger, status, started_at) "
            f"VALUES ('test-d036', %s, NOW() - INTERVAL '{age_interval}') "
            "RETURNING id",
            (status,),
        )
        run_id = cur.fetchone()[0]
    conn.commit()
    return run_id


def _row(conn, run_id: int):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, finished_at, duration_ms, error_msg "
            "FROM dedup_runs WHERE id = %s",
            (run_id,),
        )
        return cur.fetchone()


def _count_dedup_runs(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM dedup_runs")
        return cur.fetchone()[0]


@pytest.fixture
def dedup_run_db(pg_conn):
    _apply_schema(pg_conn)
    with pg_conn.cursor() as cur:
        cur.execute("DELETE FROM dedup_runs")
    pg_conn.commit()
    yield pg_conn
    with pg_conn.cursor() as cur:
        cur.execute("DELETE FROM dedup_runs")
    pg_conn.commit()
    # Never leave the single-runner lock held across tests (the connection is
    # reused within a session; the finally in run_dedup should release it, but
    # be defensive so an assertion failure mid-run can't wedge later tests).
    postgres.release_run_lock(pg_conn, postgres.DEDUP_ADVISORY_LOCK_ID)


class TestOrphanReconciliation:
    """`_reconcile_orphaned_dedup_runs` distinguishes dead from alive by age."""

    def test_orphaned_running_row_past_max_runtime_is_marked_failed(self, dedup_run_db):
        conn = dedup_run_db
        # A pass killed 10h ago: still 'running', finished_at NULL — exactly
        # the live-incident shape.
        orphan_id = _insert_dedup_run(conn, status="running", age_interval="10 hours")

        reconciled = orchestrator._reconcile_orphaned_dedup_runs(
            conn, max_runtime_seconds=7200
        )
        assert reconciled == 1

        status, finished_at, duration_ms, error_msg = _row(conn, orphan_id)
        assert status == "failed", (
            "a 10h-old row still stuck at status='running' must be reconciled "
            "to 'failed' — this is the core D-036 fix, a stuck row must not linger"
        )
        assert finished_at is not None
        assert duration_ms is not None and duration_ms > 0
        assert error_msg is not None and "orphaned" in error_msg

    def test_recent_running_row_is_not_touched(self, dedup_run_db):
        conn = dedup_run_db
        # A pass that started "just now" is genuinely in progress — the
        # reconciler must never fail it out from under a live run.
        fresh_id = _insert_dedup_run(conn, status="running", age_interval="0 seconds")

        reconciled = orchestrator._reconcile_orphaned_dedup_runs(
            conn, max_runtime_seconds=7200
        )
        assert reconciled == 0

        status, finished_at, _duration_ms, error_msg = _row(conn, fresh_id)
        assert status == "running", (
            "a running row younger than the max-runtime is a genuinely-active "
            "pass and must be left untouched"
        )
        assert finished_at is None
        assert error_msg is None

    def test_only_running_rows_are_reconciled_not_finished_ones(self, dedup_run_db):
        conn = dedup_run_db
        # An old row that already finished (success) must never be rewritten,
        # even though it is well past the max-runtime age.
        old_success = _insert_dedup_run(conn, status="success", age_interval="20 hours")
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE dedup_runs SET finished_at = started_at WHERE id = %s",
                (old_success,),
            )
        conn.commit()

        reconciled = orchestrator._reconcile_orphaned_dedup_runs(
            conn, max_runtime_seconds=7200
        )
        assert reconciled == 0
        status, _finished, _duration, error_msg = _row(conn, old_success)
        assert status == "success"
        assert error_msg is None

    def test_reconcile_is_idempotent(self, dedup_run_db):
        conn = dedup_run_db
        _insert_dedup_run(conn, status="running", age_interval="10 hours")
        first = orchestrator._reconcile_orphaned_dedup_runs(
            conn, max_runtime_seconds=7200
        )
        second = orchestrator._reconcile_orphaned_dedup_runs(
            conn, max_runtime_seconds=7200
        )
        assert first == 1
        assert second == 0, "re-applying over already-reconciled rows changes nothing"


class TestRunDedupReconcilesOnStart:
    """`run_dedup` reconciles orphans before doing its own pass."""

    def test_run_dedup_reconciles_a_pre_existing_orphan(self, dedup_run_db):
        conn = dedup_run_db
        orphan_id = _insert_dedup_run(conn, status="running", age_interval="10 hours")

        # A normal manual pass (empty listing table → zero pairs) must, as a
        # side effect of starting, clean up the pre-existing orphan.
        result = orchestrator.run_dedup(
            conn, trigger="cli-manual", dedup_max_runtime_seconds=7200
        )
        assert result is not None, "no lock is held, so this pass must actually run"

        status, finished_at, _duration, error_msg = _row(conn, orphan_id)
        assert status == "failed", (
            "starting a dedup pass must reconcile the pre-existing 10h orphan — "
            "without the reconcile call in run_dedup, this row stays 'running'"
        )
        assert finished_at is not None
        assert "orphaned" in (error_msg or "")


class TestSingleRunnerGuard:
    """Two dedup passes never run concurrently against the same corpus."""

    def test_second_run_is_skipped_while_the_lock_is_held(self, dedup_run_db):
        conn = dedup_run_db

        # Simulate a pass already in flight in another process: acquire the
        # dedup advisory lock on a *separate* connection (a separate PG
        # session, so the lock is mutually exclusive with `conn`).
        other = postgres.get_connection(Config())
        try:
            got = postgres.try_acquire_run_lock(other, postgres.DEDUP_ADVISORY_LOCK_ID)
            assert got, "test setup: could not acquire the dedup lock on the holder"

            before = _count_dedup_runs(conn)
            result = orchestrator.run_dedup(
                conn, trigger="cli-manual", dedup_max_runtime_seconds=7200
            )
            after = _count_dedup_runs(conn)

            assert result is None, (
                "a second dedup pass must be refused while another holds the "
                "single-runner lock — not run in parallel"
            )
            assert after == before, (
                "the refused pass must not even create a dedup_runs row — it "
                "piled on nothing"
            )
        finally:
            postgres.release_run_lock(other, postgres.DEDUP_ADVISORY_LOCK_ID)
            other.close()

    def test_run_proceeds_once_the_lock_is_free(self, dedup_run_db):
        conn = dedup_run_db

        other = postgres.get_connection(Config())
        try:
            assert postgres.try_acquire_run_lock(other, postgres.DEDUP_ADVISORY_LOCK_ID)
            assert (
                orchestrator.run_dedup(
                    conn, trigger="cli-manual", dedup_max_runtime_seconds=7200
                )
                is None
            )
        finally:
            postgres.release_run_lock(other, postgres.DEDUP_ADVISORY_LOCK_ID)
            other.close()

        # Lock now free — the same pass must succeed and record a row.
        before = _count_dedup_runs(conn)
        result = orchestrator.run_dedup(
            conn, trigger="cli-manual", dedup_max_runtime_seconds=7200
        )
        assert result is not None
        assert _count_dedup_runs(conn) == before + 1

    def test_cli_run_reports_skip_and_records_nothing_when_lock_held(
        self, dedup_run_db, capsys
    ):
        conn = dedup_run_db
        other = postgres.get_connection(Config())
        try:
            assert postgres.try_acquire_run_lock(other, postgres.DEDUP_ADVISORY_LOCK_ID)
            before = _count_dedup_runs(conn)
            exit_code = dedup_cli_run(conn)
            after = _count_dedup_runs(conn)

            assert exit_code == 0, "a benign skip is not a CLI error"
            assert after == before
            out = capsys.readouterr().out.lower()
            assert "single-runner" in out or "already running" in out
        finally:
            postgres.release_run_lock(other, postgres.DEDUP_ADVISORY_LOCK_ID)
            other.close()
