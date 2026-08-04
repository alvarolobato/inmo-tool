"""Integration tests for ad-hoc manual-trigger execution (issue #244).

Real PostgreSQL via the pg_conn fixture (skipped if unavailable, per
conftest.py). The whole point of this feature is what actually gets run and
recorded when a dashboard-written `etl_manual_trigger` row is picked up, so
mocking the database would test nothing meaningful — same posture as
test_orchestrator.py / test_capture.py.
"""

from __future__ import annotations

from pathlib import Path

from etl import manual_trigger, orchestrator
from etl.db import postgres
from etl.tests.fixtures.dummy_connector import DummyConnector

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"
_TEST_PROFILE_NAME = "manual-trigger-test-fixture-profile"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
        # An active profile so DummyConnector has a scope to discover (issue
        # #71: run_all_connectors does nothing with zero active profiles).
        # `_reset` archives this profile after every test (see below), so
        # re-activate any archived one first, then insert only if none exists
        # at all — this keeps exactly one row and never accumulates duplicates.
        cur.execute(
            "UPDATE search_profile SET archived_at = NULL WHERE name = %s",
            (_TEST_PROFILE_NAME,),
        )
        cur.execute(
            "SELECT 1 FROM search_profile WHERE name = %s",
            (_TEST_PROFILE_NAME,),
        )
        if cur.fetchone() is None:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s)",
                (
                    _TEST_PROFILE_NAME,
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [40.4168, -3.7038], "radius_km": 10}}'
                    ),
                ),
            )
    conn.commit()


def _insert_pending(conn, connector_name: str | None = None) -> int:
    return postgres.create_manual_trigger(
        conn, triggered_by="test", connector_name=connector_name
    )


def _trigger_row(conn, trigger_id: int) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, connector_name, connector_run_id, error_msg, "
            "       picked_up_at, finished_at "
            "FROM etl_manual_trigger WHERE id = %s",
            (trigger_id,),
        )
        row = cur.fetchone()
    return {
        "status": row[0],
        "connector_name": row[1],
        "connector_run_id": row[2],
        "error_msg": row[3],
        "picked_up_at": row[4],
        "finished_at": row[5],
    }


def _cleanup_sources(conn, sources: list[str]) -> None:
    with conn.cursor() as cur:
        for source in sources:
            cur.execute(
                "DELETE FROM connector_run_results WHERE connector_name = %s",
                (source,),
            )
            cur.execute(
                "DELETE FROM listing_price_history WHERE listing_id IN "
                "(SELECT id FROM listing WHERE source = %s)",
                (source,),
            )
            cur.execute(
                "DELETE FROM listing_status_event WHERE listing_id IN "
                "(SELECT id FROM listing WHERE source = %s)",
                (source,),
            )
            cur.execute("SELECT property_id FROM listing WHERE source = %s", (source,))
            property_ids = [r[0] for r in cur.fetchall()]
            cur.execute("DELETE FROM listing WHERE source = %s", (source,))
            if property_ids:
                cur.execute("DELETE FROM property WHERE id = ANY(%s)", (property_ids,))
    conn.commit()


def _reset(conn, sources: list[str]) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM etl_manual_trigger")
        cur.execute("DELETE FROM connector_runs")
        # Archive the fixture profile so it can never leak into another test
        # file's "zero active profiles → no crawl" invariant. Every DB-backed
        # test here shares one session-scoped database (conftest, issue #159),
        # and this file sorts before test_orchestrator.py — an *active* profile
        # left behind would make its zero-profile no-op tests derive a scope
        # they must not (matches test_orchestrator.py's own archive/restore
        # discipline for its fixture profile). Archive (not delete): FK-safe.
        cur.execute(
            "UPDATE search_profile SET archived_at = NOW() "
            "WHERE name = %s AND archived_at IS NULL",
            (_TEST_PROFILE_NAME,),
        )
    conn.commit()
    _cleanup_sources(conn, sources)
    orchestrator.CONNECTORS.clear()


class TestProcessPendingTrigger:
    def test_pending_full_sweep_is_claimed_and_runs_all_connectors(self, pg_conn):
        """A pending trigger with NULL connector_name runs every enabled
        connector, links the resulting connector_runs row, and lands 'done'."""
        _apply_schema(pg_conn)
        a = DummyConnector(name="mt-sweep-a", external_ids=("a-1",))
        b = DummyConnector(name="mt-sweep-b", external_ids=("b-1",))
        orchestrator.CONNECTORS[:] = [a, b]
        try:
            trigger_id = _insert_pending(pg_conn, connector_name=None)

            processed = manual_trigger.process_pending_trigger(pg_conn)

            assert processed == trigger_id
            row = _trigger_row(pg_conn, trigger_id)
            assert row["status"] == "done"
            assert row["connector_run_id"] is not None
            assert row["error_msg"] is None
            assert row["finished_at"] is not None
            # Both connectors actually ran (full sweep).
            assert len(a.scopes_seen) == 1
            assert len(b.scopes_seen) == 1
            # The linked run row is a real connector_runs row for this trigger.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT trigger FROM connector_runs WHERE id = %s",
                    (row["connector_run_id"],),
                )
                assert cur.fetchone()[0] == "manual"
        finally:
            _reset(pg_conn, ["mt-sweep-a", "mt-sweep-b"])

    def test_connector_scoped_trigger_runs_only_that_connector(self, pg_conn):
        """A connector_name-scoped trigger runs ONLY the named connector — the
        load-bearing scoping assertion: the other registered connector's
        discover() is never called and it gets no run-result row."""
        _apply_schema(pg_conn)
        wanted = DummyConnector(name="mt-only-wanted", external_ids=("w-1",))
        other = DummyConnector(name="mt-only-other", external_ids=("o-1",))
        orchestrator.CONNECTORS[:] = [wanted, other]
        try:
            trigger_id = _insert_pending(pg_conn, connector_name="mt-only-wanted")

            processed = manual_trigger.process_pending_trigger(pg_conn)

            assert processed == trigger_id
            assert _trigger_row(pg_conn, trigger_id)["status"] == "done"
            # Only the named connector ran.
            assert len(wanted.scopes_seen) == 1
            assert len(other.scopes_seen) == 0
            # And only it got a connector_run_results row.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT connector_name FROM connector_run_results "
                    "WHERE run_id = (SELECT connector_run_id FROM "
                    "etl_manual_trigger WHERE id = %s)",
                    (trigger_id,),
                )
                names = [r[0] for r in cur.fetchall()]
            assert names == ["mt-only-wanted"]
        finally:
            _reset(pg_conn, ["mt-only-wanted", "mt-only-other"])

    def test_unknown_connector_name_marks_trigger_failed(self, pg_conn):
        """A trigger naming a connector that isn't registered is recorded as
        'failed' with a human-readable reason, not left stuck at 'running'."""
        _apply_schema(pg_conn)
        orchestrator.CONNECTORS[:] = [DummyConnector(name="mt-real")]
        try:
            trigger_id = _insert_pending(pg_conn, connector_name="does-not-exist")

            processed = manual_trigger.process_pending_trigger(pg_conn)

            assert processed == trigger_id
            row = _trigger_row(pg_conn, trigger_id)
            assert row["status"] == "failed"
            assert row["connector_run_id"] is None
            assert "does-not-exist" in row["error_msg"]
            assert row["finished_at"] is not None
        finally:
            _reset(pg_conn, ["mt-real"])

    def test_no_pending_trigger_is_a_noop(self, pg_conn):
        """Nothing pending -> returns None and doesn't create a run."""
        _apply_schema(pg_conn)
        orchestrator.CONNECTORS[:] = [DummyConnector(name="mt-idle")]
        try:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM etl_manual_trigger")
                cur.execute("DELETE FROM connector_runs")
            pg_conn.commit()

            assert manual_trigger.process_pending_trigger(pg_conn) is None

            with pg_conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM connector_runs")
                assert cur.fetchone()[0] == 0
        finally:
            _reset(pg_conn, ["mt-idle"])


class TestManualTriggerConcurrency:
    def test_run_lock_held_leaves_trigger_pending(self, pg_conn):
        """When a connector run already holds the run lock (a scheduled sweep
        in progress), process_pending_trigger must NOT run a second sweep — it
        leaves the row pending for the next poll (queue, don't pile on)."""
        _apply_schema(pg_conn)
        orchestrator.CONNECTORS[:] = [DummyConnector(name="mt-locked")]
        # A second, independent connection stands in for the scheduler holding
        # the run lock for the duration of its sweep.
        holder = postgres.get_connection(postgres_dsn_config())
        try:
            assert postgres.try_acquire_run_lock(holder) is True

            trigger_id = _insert_pending(pg_conn, connector_name=None)
            processed = manual_trigger.process_pending_trigger(pg_conn)

            assert processed is None
            # Untouched: still pending, never flipped to running, no run created.
            row = _trigger_row(pg_conn, trigger_id)
            assert row["status"] == "pending"
            assert row["picked_up_at"] is None
            with pg_conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM connector_runs")
                assert cur.fetchone()[0] == 0

            # Release the lock; the very next poll now claims and runs it.
            postgres.release_run_lock(holder)
            holder.close()

            assert manual_trigger.process_pending_trigger(pg_conn) == trigger_id
            assert _trigger_row(pg_conn, trigger_id)["status"] == "done"
        finally:
            if not holder.closed:
                postgres.release_run_lock(holder)
                holder.close()
            _reset(pg_conn, ["mt-locked"])

    def test_two_pollers_do_not_both_claim_the_same_row(self, pg_conn):
        """`FOR UPDATE SKIP LOCKED`: with one pending row and two claimers on
        separate connections, exactly one wins and the other sees nothing —
        never a double-claim (which would run the same trigger twice)."""
        _apply_schema(pg_conn)
        try:
            trigger_id = _insert_pending(pg_conn, connector_name=None)

            # First claimer opens a transaction and locks the row, but does
            # NOT commit yet, so its FOR UPDATE lock is still held when the
            # second claimer runs.
            c1 = postgres.get_connection(postgres_dsn_config())
            c2 = postgres.get_connection(postgres_dsn_config())
            try:
                with c1.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE etl_manual_trigger
                        SET status = 'running', picked_up_at = NOW()
                        WHERE id = (
                            SELECT id FROM etl_manual_trigger
                            WHERE status = 'pending'
                            ORDER BY requested_at, id
                            LIMIT 1 FOR UPDATE SKIP LOCKED
                        )
                        RETURNING id
                        """
                    )
                    first = cur.fetchone()
                assert first is not None and first[0] == trigger_id

                # Second claimer, while c1's row lock is still open, must skip
                # the locked row and find nothing pending.
                second = manual_trigger._claim_pending_trigger(c2)
                assert second is None

                c1.commit()
            finally:
                c1.close()
                c2.close()
        finally:
            _reset(pg_conn, [])


def postgres_dsn_config():
    """A minimal object exposing the DSN the way get_connection expects.

    conftest's _isolated_test_database points POSTGRES_DSN at the throwaway
    per-session DB, and Config() re-reads os.environ on every construction —
    so a fresh Config() here connects to that same isolated DB.
    """
    from etl.config import Config

    return Config()
