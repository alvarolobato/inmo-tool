"""Integration tests for the connector orchestrator (issue #11, Phase 1.3).

Real PostgreSQL via the pg_conn fixture (skipped if unavailable, per
conftest.py) — the orchestrator's job is entirely about what gets
persisted and how runs are recorded, so mocking the database would test
nothing meaningful.
"""

from __future__ import annotations

from pathlib import Path

import pytest

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


class TestConnectorNameFilter:
    """Backs `ps connector run <name>` (task 1.5, #13)."""

    def test_connector_name_restricts_run_to_one_connector(self, pg_conn):
        _apply_schema(pg_conn)
        connector_a = DummyConnector(name="filter-test-a", external_ids=("a-1",))
        connector_b = DummyConnector(name="filter-test-b", external_ids=("b-1",))
        orchestrator.CONNECTORS[:] = [connector_a, connector_b]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(
                pg_conn, trigger="test", connector_name="filter-test-a"
            )

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT total_connectors FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                (total,) = cur.fetchone()
            assert total == 1, "only the named connector should count toward this run"

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT connector_name FROM connector_run_results WHERE run_id = %s",
                    (run_id,),
                )
                names = [row[0] for row in cur.fetchall()]
            assert names == ["filter-test-a"]

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = %s", ("filter-test-b",)
                )
                (count,) = cur.fetchone()
            assert count == 0, "the non-named connector must not have run at all"
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector_a.name, run_id)
            _cleanup(pg_conn, connector_b.name, None)

    def test_unknown_connector_name_raises_before_creating_a_run(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="filter-test-known")
        orchestrator.CONNECTORS[:] = [connector]
        try:
            with pg_conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM connector_runs")
                (before,) = cur.fetchone()

            with pytest.raises(
                orchestrator.UnknownConnectorError, match="Unknown connector"
            ):
                orchestrator.run_all_connectors(
                    pg_conn, trigger="test", connector_name="does-not-exist"
                )

            with pg_conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM connector_runs")
                (after,) = cur.fetchone()
            assert after == before, "an unknown name must not leave a phantom run row"
        finally:
            orchestrator.CONNECTORS.clear()


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

    def test_price_change_appends_history_row_not_overwrite(self, pg_conn):
        """EC-4 (orchestrator half, task 1.4/#12): a real price change across
        two runs of the same connector appends a listing_price_history row
        rather than silently overwriting the prior price."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="price-history-test", external_ids=("p-1",), price=205000
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            connector.price = 195000
            run_id_2 = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT current_price FROM listing WHERE source = %s AND external_id = %s",
                    (connector.name, "p-1"),
                )
                assert cur.fetchone() == (195000,)

                cur.execute(
                    "SELECT h.price FROM listing_price_history h "
                    "JOIN listing l ON l.id = h.listing_id "
                    "WHERE l.source = %s AND l.external_id = %s ORDER BY h.observed_at",
                    (connector.name, "p-1"),
                )
                prices = [row[0] for row in cur.fetchall()]
            assert prices == [205000, 195000]  # both observations kept, not overwritten

            for r in (run_id, run_id_2):
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()
            run_id = None
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)

    def test_listing_withdrawn_after_n_consecutive_missed_discoveries(self, pg_conn):
        """EC-5 (task 1.4/#12): a listing absent from discover() for
        _WITHDRAWAL_THRESHOLD consecutive runs transitions to 'withdrawn'
        with a listing_status_event — but NOT before the threshold, since a
        single miss is treated as normal sweep noise, not a real signal."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="withdrawal-test", external_ids=("w-1", "w-2"))
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            def _status(external_id: str) -> str:
                with pg_conn.cursor() as cur:
                    cur.execute(
                        "SELECT status FROM listing WHERE source = %s AND external_id = %s",
                        (connector.name, external_id),
                    )
                    return cur.fetchone()[0]

            assert _status("w-1") == "active"
            assert _status("w-2") == "active"

            # w-2 stops appearing in discover() from here on.
            connector.external_ids = ("w-1",)

            assert orchestrator._WITHDRAWAL_THRESHOLD == 3, (
                "test assumes the documented threshold — update this test if "
                "the constant changes"
            )

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert _status("w-2") == "active", "one miss must not withdraw a listing"

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert _status("w-2") == "active", "two misses must not withdraw a listing"

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert _status("w-2") == "withdrawn", (
                "three consecutive misses must withdraw"
            )
            assert _status("w-1") == "active", (
                "still-discovered listing must be unaffected"
            )

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT ls.status FROM listing_status_event ls "
                    "JOIN listing l ON l.id = ls.listing_id "
                    "WHERE l.source = %s AND l.external_id = %s ORDER BY ls.observed_at",
                    (connector.name, "w-2"),
                )
                events = [row[0] for row in cur.fetchall()]
            assert events[-1] == "withdrawn"

            # A withdrawn listing that reappears resets the miss counter and
            # goes back to active on its next successful upsert (not tested
            # further here — dedup/relist semantics are a later-phase
            # concern per issue #1 §10 — this only proves the counter itself
            # doesn't get stuck permanently against a listing).
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT missed_discovery_count FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "w-2"),
                )
                assert cur.fetchone()[0] == 3

            for r in run_ids:
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()
            run_ids = []
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            for r in run_ids:
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
                pg_conn.commit()

    def test_withdrawn_listing_reappearing_resets_miss_counter(self, pg_conn):
        """PR #49 review finding: a withdrawn listing that reappears and is
        successfully re-fetched must have its miss counter reset — otherwise
        a single subsequent miss would immediately re-withdraw it, since
        _reconcile_missed_discoveries only resets counters for still-'active'
        rows and a withdrawn listing no longer qualifies."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="reappear-test", external_ids=("r-1", "r-2"))
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            connector.external_ids = ("r-1",)
            for _ in range(orchestrator._WITHDRAWAL_THRESHOLD):
                run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, missed_discovery_count FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "r-2"),
                )
                status, missed = cur.fetchone()
            assert status == "withdrawn"
            assert missed == orchestrator._WITHDRAWAL_THRESHOLD

            # r-2 reappears and is successfully re-fetched.
            connector.external_ids = ("r-1", "r-2")
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, missed_discovery_count FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "r-2"),
                )
                status, missed = cur.fetchone()
            assert status == "active", "a re-fetched listing must go back to active"
            assert missed == 0, "the miss counter must reset on a real reappearance"

            for r in run_ids:
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()
            run_ids = []
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            for r in run_ids:
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
                pg_conn.commit()

    def test_empty_discover_result_does_not_cascade_into_withdrawals(self, pg_conn):
        """PR #49 review finding: even a connector bug that returns [] from
        discover() (instead of raising, as a well-behaved connector should
        on a soft-block/interruption page — see fotocasa.py) must not be
        able to mass-withdraw a source's entire inventory. Second line of
        defense on top of fotocasa.py's own ConnectorError-on-block-page."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="empty-discover-test", external_ids=("e-1", "e-2")
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            connector.external_ids = ()  # simulates a buggy connector returning []
            for _ in range(orchestrator._WITHDRAWAL_THRESHOLD + 2):
                run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, missed_discovery_count FROM listing "
                    "WHERE source = %s ORDER BY external_id",
                    (connector.name,),
                )
                rows = cur.fetchall()
            assert rows == [("active", 0), ("active", 0)], (
                "an empty discover() result must never bump miss-counters or withdraw"
            )

            for r in run_ids:
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()
            run_ids = []
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            for r in run_ids:
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
                pg_conn.commit()

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
