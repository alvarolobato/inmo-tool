"""Integration tests for the connector orchestrator (issue #11, Phase 1.3).

Real PostgreSQL via the pg_conn fixture (skipped if unavailable, per
conftest.py) — the orchestrator's job is entirely about what gets
persisted and how runs are recorded, so mocking the database would test
nothing meaningful.
"""

from __future__ import annotations

from pathlib import Path

from etl import orchestrator
from etl.tests.fixtures.dummy_connector import DiscoverFailsConnector, DummyConnector

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _cleanup(conn, source: str, run_id: int | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM connector_run_results WHERE connector_name = %s", (source,)
        )
        if run_id is not None:
            cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
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
        property_ids = [row[0] for row in cur.fetchall()]
        cur.execute("DELETE FROM listing WHERE source = %s", (source,))
        if property_ids:
            cur.execute("DELETE FROM property WHERE id = ANY(%s)", (property_ids,))
    conn.commit()


class TestOrchestratorEndToEnd:
    def test_orchestrator_runs_dummy_connector_end_to_end(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-e2e-connector")
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, connectors_ok, connectors_failed, total_connectors "
                    "FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                status, ok, failed, total = cur.fetchone()
            assert status == "success"
            assert ok == 1
            assert failed == 0
            assert total == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, discovered_count, fetched_count, error_count "
                    "FROM connector_run_results WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                result_row = cur.fetchone()
            assert result_row == ("ok", 3, 3, 0)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = %s", (connector.name,)
                )
                (listing_count,) = cur.fetchone()
            assert listing_count == 3
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)

    def test_orchestrator_handles_empty_registry(self, pg_conn, monkeypatch):
        """EC-4: the orchestrator loop itself must not hard-depend on any connector existing.

        Explicitly forces the registry empty for this test via monkeypatch
        rather than asserting the module-level CONNECTORS list happens to
        be empty right now — that assumption breaks the moment task 1.4
        registers a real connector permanently.
        """
        _apply_schema(pg_conn)
        monkeypatch.setattr(orchestrator, "CONNECTORS", [])
        run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, total_connectors FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                status, total = cur.fetchone()
            assert status == "success"
            assert total == 0
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
            pg_conn.commit()


class TestCircuitBreakerIntegration:
    def test_circuit_breaker_trips_on_high_error_rate(self, pg_conn):
        _apply_schema(pg_conn)
        # 10 ids, 5 failing (50% > default 30% threshold), min_attempts=2 so it
        # trips well before exhausting the list.
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        failing = frozenset(external_ids[1::2])  # every other one fails
        connector = DummyConnector(
            name="test-circuit-connector",
            external_ids=external_ids,
            failing_ids=failing,
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_run_results WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                (status,) = cur.fetchone()
            assert status == "circuit_open"

            # Proves it stopped early rather than burning through all 10.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = %s", (connector.name,)
                )
                (listing_count,) = cur.fetchone()
            assert listing_count < 5  # succeeded on fewer than half before tripping
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)

    def test_mid_run_db_error_does_not_wedge_subsequent_listings(self, pg_conn):
        """A DB-constraint violation on one listing must not abort the whole
        connector run or corrupt the connection for listings after it.

        Listing 1 of 3 fails at persist time (invalid property_type, a real
        CHECK-constraint violation — not a connector-side failure). Listings
        0 and 2 must still persist, proving `_upsert_canonical_listing`'s
        `conn.rollback()` on failure actually resets connection state rather
        than leaving the transaction aborted for later statements.

        Note there is no 'partial' status in `connector_run_results` (only
        ok/failed/circuit_open, per the schema's CHECK constraint) — a
        connector that recorded some per-listing errors but didn't trip the
        circuit breaker is legitimately 'ok' at the connector level, with
        `error_count` carrying the partial-failure signal.
        """
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="test-db-error-connector",
            external_ids=("db-err-0", "db-err-1", "db-err-2"),
            db_error_ids=frozenset({"db-err-1"}),
            circuit_breaker_min_attempts=10,  # don't trip; isolate the rollback behavior
        )
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, discovered_count, fetched_count, error_count "
                    "FROM connector_run_results WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                result_row = cur.fetchone()
            assert result_row == ("ok", 3, 2, 1)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_runs WHERE id = %s", (run_id,)
                )
                (run_status,) = cur.fetchone()
            assert (
                run_status == "success"
            )  # the connector itself didn't fail/circuit-open

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT external_id FROM listing WHERE source = %s ORDER BY external_id",
                    (connector.name,),
                )
                persisted = [row[0] for row in cur.fetchall()]
            assert persisted == ["db-err-0", "db-err-2"]  # the bad one never persisted

            # The connection itself must still be usable after the mid-run
            # rollback — prove it with a completely unrelated statement.
            with pg_conn.cursor() as cur:
                cur.execute("SELECT 1")
                assert cur.fetchone() == (1,)
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)

    def test_discover_failure_is_recorded_as_failed_not_a_crash(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DiscoverFailsConnector()
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, error_msg FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                status, error_msg = cur.fetchone()
            assert status == "failed"
            assert error_msg and "discover" in error_msg.lower()
        finally:
            orchestrator.CONNECTORS.clear()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_run_results WHERE connector_name = %s",
                    (connector.name,),
                )
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
            pg_conn.commit()
