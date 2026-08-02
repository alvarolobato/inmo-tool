"""Integration tests for the connector orchestrator (issue #11, Phase 1.3).

Real PostgreSQL via the pg_conn fixture (skipped if unavailable, per
conftest.py) — the orchestrator's job is entirely about what gets
persisted and how runs are recorded, so mocking the database would test
nothing meaningful.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import ClassVar

import pytest

from etl import orchestrator
from etl.connectors.base import CanonicalListingVersion
from etl.tests.fixtures.dummy_connector import DiscoverFailsConnector, DummyConnector

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


_TEST_PROFILE_NAME = "orchestrator-test-fixture-profile"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    # Issue #71: run_all_connectors() now derives discovery scope from active
    # search_profile rows and does nothing at all with zero of them. Every
    # test in this file exercises the dummy connector, which ignores
    # `scope` entirely (see fixtures/dummy_connector.py) — so the exact
    # geography here is irrelevant, only that at least one active profile
    # exists. Idempotent (checks by name first) so re-running this against
    # a DB that already has the fixture profile from a prior test doesn't
    # accumulate duplicates.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM search_profile WHERE name = %s AND archived_at IS NULL",
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


class TestConnectorConfig:
    """Issue #99: connector_config's disable/override layer on top of #71's
    union-of-active-profiles default."""

    def _cleanup_config(self, conn, *names: str) -> None:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM connector_config WHERE connector_name = ANY(%s)",
                (list(names),),
            )
        conn.commit()

    def test_disabled_connector_never_runs_despite_matching_active_profile(
        self, pg_conn
    ):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-disabled-connector")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config (connector_name, enabled) "
                "VALUES (%s, false)",
                (connector.name,),
            )
        pg_conn.commit()
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            # The disabled connector must never even reach discover().
            assert connector.scopes_seen == []

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT total_connectors, connectors_ok, connectors_failed, "
                    "connectors_skipped FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                total, ok, failed, run_skipped = cur.fetchone()
            # Issue #99 hardening: a disabled connector is now visibly
            # skipped, not silently absent from every count — it's counted
            # in total_connectors and connectors_skipped, but not toward
            # ok/failed, since "told not to run" is neither a success nor
            # a failure.
            assert total == 1
            assert ok == 0
            assert failed == 0
            assert run_skipped == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                (status,) = cur.fetchone()
            # A real result row exists now — 'skipped', not absent — so a
            # fully-disabled run is distinguishable from a fully-healthy
            # empty one by inspection, not just by the total_connectors
            # count.
            assert status == "skipped"
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, connector.name)
            _cleanup(pg_conn, connector.name, run_id)

    def test_geography_override_ignores_active_profile_scope(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-override-connector")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        override_center = [37.3891, -5.9845]  # Sevilla — the fixture profile is Madrid
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config "
                "(connector_name, geography_override) VALUES (%s, %s)",
                (connector.name, '{"center": [37.3891, -5.9845], "radius_km": 8}'),
            )
        pg_conn.commit()
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            assert len(connector.scopes_seen) == 1
            seen = connector.scopes_seen[0]
            assert seen.center == (override_center[0], override_center[1])
            assert seen.radius_km == 8.0
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, connector.name)
            _cleanup(pg_conn, connector.name, run_id)

    @pytest.mark.parametrize(
        ("case_name", "geography_override_json", "filters_json"),
        [
            (
                "string-override-array-filters",
                '"not-an-object"',
                "[1, 2, 3]",
            ),
            (
                "array-override",
                "[1, 2, 3]",
                "{}",
            ),
            (
                "dict-override-non-numeric-coords",
                '{"center": ["abc", "def"], "radius_km": 5}',
                "{}",
            ),
            (
                "array-filters-only",
                None,
                "[1, 2, 3]",
            ),
        ],
    )
    def test_malformed_geography_override_falls_back_without_crashing_the_run(
        self, pg_conn, case_name, geography_override_json, filters_json
    ):
        """Issue #99 hardening: geography_override/filters are JSONB, so a hand-edited
        or buggily-written row can hold a JSON string/list/int instead of an object,
        or a well-shaped dict with non-numeric values inside it. Before the
        isinstance(..., dict) guards and the try/except around the float()
        conversions, any of these raised uncaught (AttributeError or ValueError)
        and aborted the entire run — not just this connector — for every
        connector in the registry. Parametrized (issue #99 review, round 2) to
        cover all four malformed shapes verified to actually reach this code
        path, since a future connector-management UI (#100) can produce any of
        them from a human's typo, not just the one shape the first pass tested."""
        _apply_schema(pg_conn)
        malformed = DummyConnector(name=f"test-malformed-override-{case_name}")
        healthy = DummyConnector(name=f"test-malformed-sibling-{case_name}")
        orchestrator.CONNECTORS[:] = [malformed, healthy]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config "
                "(connector_name, geography_override, filters) VALUES (%s, %s, %s)",
                (malformed.name, geography_override_json, filters_json),
            )
        pg_conn.commit()
        try:
            # Must not raise — this is the crash this test exists to rule out.
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, connectors_ok, connectors_failed, total_connectors "
                    "FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                status, ok, failed, total = cur.fetchone()
            assert status == "success"
            assert total == 2
            assert failed == 0
            assert ok == 2

            # The malformed connector still ran — falling back to the
            # profile-derived default scope rather than being skipped.
            assert len(malformed.scopes_seen) == 1
            # The sibling connector (no config row at all) is unaffected.
            assert len(healthy.scopes_seen) == 1
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, malformed.name, healthy.name)
            _cleanup(pg_conn, malformed.name, run_id)
            _cleanup(pg_conn, healthy.name)

    def test_malformed_profile_coordinates_fall_back_without_crashing_the_run(
        self, pg_conn
    ):
        """Issue #99 review, round 2: _active_profile_scopes had the identical
        unguarded float() conversion as _scopes_for_connector's
        geography_override handling, one call earlier in the same run path.
        A search_profile with a 2-element center list of non-numeric strings
        passes the isinstance(list)/len==2 guard, then raised an uncaught
        ValueError on float(center[0]) — aborting the run for every
        connector, not just skipping that one profile's contribution. This
        proves the malformed profile is skipped with a warning while a
        sibling valid profile's scope still reaches the connector."""
        _apply_schema(pg_conn)
        malformed_profile_name = "orchestrator-test-malformed-coords-profile"
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s)",
                (
                    malformed_profile_name,
                    (
                        '{"geography": {"type": "radius", '
                        '"center": ["abc", "def"], "radius_km": 10}}'
                    ),
                ),
            )
        pg_conn.commit()
        connector = DummyConnector(name="test-malformed-profile-coords")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            # Must not raise — this is the crash this test exists to rule out.
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, connectors_ok, connectors_failed, total_connectors "
                    "FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                status, ok, failed, total = cur.fetchone()
            assert status == "success"
            assert total == 1
            assert failed == 0
            assert ok == 1

            # Exactly one scope reached the connector: the valid Madrid
            # fixture profile from _apply_schema. The malformed profile's
            # scope was skipped, not substituted with garbage and not
            # allowed to abort discovery for the valid profile alongside it.
            assert connector.scopes_seen == [
                orchestrator.ConnectorScope(center=(40.4168, -3.7038), radius_km=10.0)
            ]
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM search_profile WHERE name = %s",
                    (malformed_profile_name,),
                )
            pg_conn.commit()

    def test_override_on_one_connector_does_not_affect_another(self, pg_conn):
        _apply_schema(pg_conn)
        overridden = DummyConnector(name="test-override-a")
        default_connector = DummyConnector(name="test-override-b")
        orchestrator.CONNECTORS[:] = [overridden, default_connector]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config "
                "(connector_name, geography_override) VALUES (%s, %s)",
                (overridden.name, '{"center": [37.3891, -5.9845], "radius_km": 8}'),
            )
        pg_conn.commit()
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            assert len(overridden.scopes_seen) == 1
            assert overridden.scopes_seen[0].center == (37.3891, -5.9845)

            # default_connector has no config row — must still use the
            # fixture profile's Madrid-centered geography, #71's default,
            # completely unaffected by the other connector's override.
            assert len(default_connector.scopes_seen) == 1
            assert default_connector.scopes_seen[0].center == (40.4168, -3.7038)
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, overridden.name)
            _cleanup(pg_conn, overridden.name, run_id)
            _cleanup(pg_conn, default_connector.name, run_id)

    def test_no_config_row_keeps_issue_71_default_behavior(self, pg_conn):
        """A row with both fields null is equivalent to no row at all."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-null-config-connector")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config (connector_name) VALUES (%s)",
                (connector.name,),
            )
        pg_conn.commit()
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert len(connector.scopes_seen) == 1
            assert connector.scopes_seen[0].center == (40.4168, -3.7038)
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, connector.name)
            _cleanup(pg_conn, connector.name, run_id)

    def test_filters_rooms_flows_through_to_scope(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-filters-connector")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config (connector_name, filters) "
                "VALUES (%s, %s)",
                (connector.name, '{"rooms": 2}'),
            )
        pg_conn.commit()
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert len(connector.scopes_seen) == 1
            assert connector.scopes_seen[0].rooms == 2
            # The profile-derived geography is still applied underneath —
            # filters augment the base scope, they don't replace it.
            assert connector.scopes_seen[0].center == (40.4168, -3.7038)
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, connector.name)
            _cleanup(pg_conn, connector.name, run_id)

    def test_zero_profiles_with_override_still_runs(self, pg_conn):
        """Issue #99's headline claim: an explicit override can have real
        work to do even when no search profile exists at all — this is the
        whole reason "no profiles -> skip everything" moved from a
        whole-run early-return to a per-connector decision."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "UPDATE search_profile SET archived_at = NOW() "
                "WHERE name = %s AND archived_at IS NULL",
                (_TEST_PROFILE_NAME,),
            )
        pg_conn.commit()
        connector = DummyConnector(name="test-zero-profiles-override")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config "
                "(connector_name, geography_override) VALUES (%s, %s)",
                (connector.name, '{"center": [37.3891, -5.9845], "radius_km": 8}'),
            )
        pg_conn.commit()
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert len(connector.scopes_seen) == 1
            assert connector.scopes_seen[0].center == (37.3891, -5.9845)
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, connector.name)
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE search_profile SET archived_at = NULL WHERE name = %s",
                    (_TEST_PROFILE_NAME,),
                )
            pg_conn.commit()

    def test_zero_profiles_no_override_still_noops(self, pg_conn):
        """The other half of issue #71's original guarantee: a connector
        with no override and zero active profiles must still do nothing —
        moving the early-return to per-connector must not have quietly
        broken the no-op path for connectors that never asked for an
        override."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "UPDATE search_profile SET archived_at = NOW() "
                "WHERE name = %s AND archived_at IS NULL",
                (_TEST_PROFILE_NAME,),
            )
        pg_conn.commit()
        connector = DummyConnector(name="test-zero-profiles-no-override")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert connector.scopes_seen == []
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE search_profile SET archived_at = NULL WHERE name = %s",
                    (_TEST_PROFILE_NAME,),
                )
            pg_conn.commit()

    def test_disable_isolation_does_not_affect_other_connector(self, pg_conn):
        """Disabling connector A must not affect connector B's independent
        profile-derived-default behavior in the same run — the existing
        override-isolation test proves this for overrides, this proves it
        for disable specifically."""
        _apply_schema(pg_conn)
        disabled = DummyConnector(name="test-disable-isolation-a")
        default_connector = DummyConnector(name="test-disable-isolation-b")
        orchestrator.CONNECTORS[:] = [disabled, default_connector]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config (connector_name, enabled) "
                "VALUES (%s, false)",
                (disabled.name,),
            )
        pg_conn.commit()
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            assert disabled.scopes_seen == []
            assert len(default_connector.scopes_seen) == 1
            assert default_connector.scopes_seen[0].center == (40.4168, -3.7038)
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, disabled.name)
            _cleanup(pg_conn, disabled.name, run_id)
            _cleanup(pg_conn, default_connector.name, run_id)

    def test_unrecognized_connector_config_name_logs_a_warning(self, pg_conn, caplog):
        """Issue #99 review, round 2: a connector_config row naming a
        connector that isn't registered currently just silently does
        nothing — _scopes_for_connector looks it up by exact name and finds
        no row, indistinguishable from "never configured". Once #100's
        connector-management UI lets an operator type/pick a name directly,
        a typo needs to be visible, not a quiet no-op."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-name-filter-known")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config (connector_name) VALUES (%s)",
                ("test-name-filter-typo",),
            )
        pg_conn.commit()
        try:
            with caplog.at_level("WARNING", logger="etl.orchestrator"):
                run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            assert any(
                "test-name-filter-typo" in record.message for record in caplog.records
            ), "an unrecognized connector_config row must be logged, not silent"
            # The typo'd row has no effect on the actually-registered connector.
            assert len(connector.scopes_seen) == 1
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, "test-name-filter-typo")
            _cleanup(pg_conn, connector.name, run_id)


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

    def test_partial_inventory_connector_never_marks_withdrawn(self, pg_conn):
        """Phase 1 phase-level review finding: a connector whose discover()
        only sees a subset of its real inventory (Fotocasa: page 1 of
        11,361+ real listings, relevance-sorted) must never have absences
        counted against it at all — not even a bounded miss-counter — since
        an absence from a partial sweep proves nothing about whether the
        listing is still active. discovers_full_inventory=False must
        disable reconciliation entirely, not just raise the threshold."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="partial-inventory-test",
            external_ids=("p-1", "p-2"),
            discovers_full_inventory=False,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            # p-2 "disappears" for many sweeps — far more than
            # _WITHDRAWAL_THRESHOLD would tolerate for a full-inventory
            # connector.
            connector.external_ids = ("p-1",)
            for _ in range(orchestrator._WITHDRAWAL_THRESHOLD + 5):
                run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, missed_discovery_count FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "p-2"),
                )
                status, missed = cur.fetchone()
            assert status == "active", (
                "a partial-coverage connector must never auto-withdraw"
            )
            assert missed == 0, (
                "miss-counting itself must be skipped, not just the threshold"
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

    def test_rooms_filtered_scope_never_marks_withdrawn(self, pg_conn):
        """Issue #99 review, round 2: the same false-positive-withdrawal risk
        `discovers_full_inventory=False` guards against also applies when a
        connector that DOES discover its full unfiltered inventory has a
        `rooms` filter applied via connector_config — the filter narrows
        what THIS run's discover() call returns, so an absence means "didn't
        match the filter" just as easily as "genuinely gone". A listing that
        stops matching a newly-applied filter must never be auto-withdrawn,
        and the miss-counter itself must not even accumulate (matching the
        partial-inventory guarantee immediately above)."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="rooms-filtered-test",
            external_ids=("r-1", "r-2"),
            discovers_full_inventory=True,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM listing WHERE source = %s AND external_id = %s",
                    (connector.name, "r-2"),
                )
                assert cur.fetchone()[0] == "active"

            # A rooms filter narrows this connector's scope from here on —
            # r-2 stops matching (or the connector simply stops returning
            # it, indistinguishable from the connector's own perspective).
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO connector_config (connector_name, filters) "
                    "VALUES (%s, %s)",
                    (connector.name, '{"rooms": 2}'),
                )
            pg_conn.commit()
            connector.external_ids = ("r-1",)

            for _ in range(orchestrator._WITHDRAWAL_THRESHOLD + 5):
                run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, missed_discovery_count FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "r-2"),
                )
                status, missed = cur.fetchone()
            assert status == "active", (
                "a rooms-filtered scope must never auto-withdraw a listing "
                "that simply no longer matches the filter"
            )
            assert missed == 0, (
                "miss-counting itself must be skipped for a filtered scope, "
                "not just the withdrawal threshold"
            )

            for r in run_ids:
                with pg_conn.cursor() as cur:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()
            run_ids = []
        finally:
            orchestrator.CONNECTORS.clear()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_config WHERE connector_name = %s",
                    (connector.name,),
                )
            pg_conn.commit()
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


class TestMultiScopeWithdrawalReconciliation:
    """PR #139 review: reconciliation must run once per connector per run,
    against the UNION of every scope's ids — never once per scope."""

    # name -> (center, the ids this city's discover() returns). Mutable on
    # purpose: test_a_genuinely_gone_listing... swaps one city's ids
    # mid-test to simulate a listing disappearing between sweeps, then
    # restores them in a finally.
    _CITIES: ClassVar[dict[str, tuple[tuple[float, float], tuple[str, ...]]]] = {
        "madrid": ((40.4168, -3.7038), ("m-1",)),
        "sevilla": ((37.3891, -5.9845), ("s-1",)),
        "barcelona": ((41.3851, 2.1734), ("b-1",)),
        "valencia": ((39.4699, -0.3763), ("v-1",)),
    }

    def _seed_profiles(self, conn) -> None:
        with conn.cursor() as cur:
            for name, (center, _ids) in self._CITIES.items():
                cur.execute(
                    "SELECT 1 FROM search_profile WHERE name = %s "
                    "AND archived_at IS NULL",
                    (f"multiscope-{name}",),
                )
                if cur.fetchone() is None:
                    cur.execute(
                        "INSERT INTO search_profile (name, scope) VALUES (%s, %s)",
                        (
                            f"multiscope-{name}",
                            json.dumps(
                                {
                                    "geography": {
                                        "type": "radius",
                                        "center": [center[0], center[1]],
                                        "radius_km": 10,
                                    }
                                }
                            ),
                        ),
                    )
        conn.commit()

    def _per_scope_connector(self):
        """A connector whose discover() returns DIFFERENT ids per scope —
        which is the realistic shape (each city sweep sees its own city's
        listings) and the one that exposes the bug. DummyConnector returns
        the same ids for every scope, so it cannot reproduce this.
        """
        cities = self._CITIES

        class PerScopeConnector(DummyConnector):
            def discover(self, scope, throttle):
                self.scopes_seen.append(scope)
                if scope.center is None:
                    return []
                nearest = min(
                    cities.items(),
                    key=lambda kv: (
                        (kv[1][0][0] - scope.center[0]) ** 2
                        + (kv[1][0][1] - scope.center[1]) ** 2
                    ),
                )
                return list(nearest[1][1])

            def scope_key(self, scope):
                if scope.center is None:
                    return None
                return min(
                    cities.items(),
                    key=lambda kv: (
                        (kv[1][0][0] - scope.center[0]) ** 2
                        + (kv[1][0][1] - scope.center[1]) ** 2
                    ),
                )[0]

        return PerScopeConnector(
            name="multiscope-test",
            external_ids=(),
            discovers_full_inventory=True,
        )

    def test_listing_present_in_one_scope_is_not_withdrawn_by_the_others(self, pg_conn):
        """The bug: `_reconcile_missed_discoveries` sweeps every active row
        for the source with no scope predicate, so reconciling per scope
        counted a Madrid listing as "missed" during the Sevilla, Barcelona
        and Valencia sweeps. With _WITHDRAWAL_THRESHOLD == 3, four scopes
        withdrew live inventory inside a SINGLE run.

        Vivantial (#120) is the first connector to set
        discovers_full_inventory=True, which is what made this reachable —
        while every connector was False, reconciliation never ran at all.
        """
        _apply_schema(pg_conn)
        self._seed_profiles(pg_conn)
        connector = self._per_scope_connector()
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            assert orchestrator._WITHDRAWAL_THRESHOLD == 3, (
                "this test is calibrated against a threshold of 3 vs 4 scopes"
            )

            # One run. Four scopes, each discovering only its own city's id.
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert len(connector.scopes_seen) == 4, (
                f"expected 4 scopes, saw {len(connector.scopes_seen)}"
            )

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT external_id, status, missed_discovery_count "
                    "FROM listing WHERE source = %s ORDER BY external_id",
                    (connector.name,),
                )
                rows = cur.fetchall()

            assert len(rows) == 4, f"expected all 4 cities ingested, got {rows}"
            for external_id, status, missed in rows:
                assert status == "active", (
                    f"{external_id} withdrawn after a single run — per-scope "
                    "reconciliation counted the other 3 scopes as misses"
                )
                assert missed == 0, (
                    f"{external_id} accumulated {missed} misses in one run; "
                    "the union of all scopes' ids contains it"
                )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
                cur.execute(
                    "DELETE FROM search_profile WHERE name LIKE 'multiscope-%%'"
                )
            pg_conn.commit()

    def test_a_genuinely_gone_listing_still_withdraws_across_scopes(self, pg_conn):
        """The fix must not disable reconciliation — a listing absent from
        the whole union, for THRESHOLD consecutive runs, must still
        withdraw. Otherwise the multi-scope fix would silently trade one
        bug for another."""
        _apply_schema(pg_conn)
        self._seed_profiles(pg_conn)
        connector = self._per_scope_connector()
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            # m-1 genuinely disappears, but the Madrid sweep still returns
            # listings (m-2 replaces it). Modelling this as an *empty*
            # Madrid result would instead trip the empty-discover
            # fail-safe, which deliberately disables reconciliation
            # run-wide — a different code path, and not what's under test.
            self._CITIES["madrid"] = ((40.4168, -3.7038), ("m-2",))
            try:
                for _ in range(orchestrator._WITHDRAWAL_THRESHOLD):
                    run_ids.append(
                        orchestrator.run_all_connectors(pg_conn, trigger="test")
                    )

                with pg_conn.cursor() as cur:
                    cur.execute(
                        "SELECT status FROM listing WHERE source = %s "
                        "AND external_id = %s",
                        (connector.name, "m-1"),
                    )
                    (status,) = cur.fetchone()
                assert status == "withdrawn", (
                    "a listing absent from the full union for THRESHOLD runs "
                    "must still withdraw — the fix must not disable "
                    "reconciliation outright"
                )

                with pg_conn.cursor() as cur:
                    cur.execute(
                        "SELECT status FROM listing WHERE source = %s "
                        "AND external_id = %s",
                        (connector.name, "s-1"),
                    )
                    (sevilla_status,) = cur.fetchone()
                assert sevilla_status == "active", "other cities unaffected"
            finally:
                self._CITIES["madrid"] = ((40.4168, -3.7038), ("m-1",))
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
                cur.execute(
                    "DELETE FROM search_profile WHERE name LIKE 'multiscope-%%'"
                )
            pg_conn.commit()


class TestProfileDrivenScope:
    """Issue #71: discovery scope comes from active search_profile rows,
    not a hardcoded default."""

    def test_active_profile_geography_reaches_the_connector_not_madrid(self, pg_conn):
        _apply_schema(pg_conn)
        # A second, Sevilla-scoped profile alongside _apply_schema's
        # Madrid-centered fixture profile — proves the orchestrator unions
        # scopes across *all* active profiles, not just the first one found.
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    "sevilla-test-profile",
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [37.3891, -5.9845], "radius_km": 15}}'
                    ),
                ),
            )
            (sevilla_profile_id,) = cur.fetchone()
        pg_conn.commit()

        connector = DummyConnector(name="scope-probe")
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            # Two active profiles (the Madrid fixture from _apply_schema +
            # the Sevilla one just inserted) with distinct geographies ->
            # the connector must have been asked to discover() twice, once
            # per scope, and one of those calls must carry Sevilla's
            # center — not silently collapsed to a single Madrid-only call.
            assert len(connector.scopes_seen) == 2
            centers = {s.center for s in connector.scopes_seen}
            assert (37.3891, -5.9845) in centers
            assert (40.4168, -3.7038) in centers

            # discovered_count/fetched_count are summed across both scopes
            # (3 dummy listings x 2 scopes) in the single aggregated
            # connector_run_results row (issue #71 — one row per connector
            # per run, not one per scope; see run_all_connectors).
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT discovered_count, fetched_count FROM "
                    "connector_run_results WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                discovered, fetched = cur.fetchone()
            assert discovered == 6
            assert fetched == 6
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM search_profile WHERE id = %s", (sevilla_profile_id,)
                )
            pg_conn.commit()

    def test_zero_active_profiles_runs_no_connector_at_all(self, pg_conn):
        _apply_schema(pg_conn)
        # Archive (not delete) every active profile, including
        # _apply_schema's fixture one — archived_at IS NOT NULL must be
        # excluded from scope derivation just like a genuinely empty table.
        with pg_conn.cursor() as cur:
            cur.execute(
                "UPDATE search_profile SET archived_at = NOW() "
                "WHERE archived_at IS NULL"
            )
        pg_conn.commit()

        connector = DummyConnector(name="should-not-run")
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            assert connector.scopes_seen == []

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, total_connectors, connectors_ok, "
                    "connectors_failed FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                status, total, ok, failed = cur.fetchone()
            assert (status, total, ok, failed) == ("success", 0, 0, 0)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM connector_run_results WHERE run_id = %s",
                    (run_id,),
                )
                (result_row_count,) = cur.fetchone()
            assert result_row_count == 0
        finally:
            orchestrator.CONNECTORS.clear()
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                # Restore the fixture profile other tests in this module
                # depend on _apply_schema having (re-)created as active.
                cur.execute(
                    "UPDATE search_profile SET archived_at = NULL WHERE name = %s",
                    (_TEST_PROFILE_NAME,),
                )
            pg_conn.commit()

    def test_two_scopes_resolving_to_the_same_target_are_not_crawled_twice(
        self, pg_conn
    ):
        """Issue #71 review finding: two active profiles with different exact
        centers/radii can still resolve to the identical real-world crawl
        target (e.g. both land on Madrid). Before this fix, each got its
        own full run_connector() pass — double the real traffic against the
        target site for zero benefit, a direct regression of issue #1
        §15's good-neighbor crawling discipline. A connector whose
        `scope_key()` collapses both scopes to the same key must only be
        crawled once."""

        class _FixedKeyConnector(DummyConnector):
            """Every scope resolves to the same real-world target, however
            different the raw (center, radius_km) values look — simulates
            two profiles that are geographically distinct but both land on
            the same city per a real connector's own resolution logic."""

            def scope_key(self, scope):
                return "same-target-regardless-of-raw-scope"

        _apply_schema(pg_conn)
        # Deliberately far enough apart in raw terms to survive
        # _active_profile_scopes' own raw-coordinate-rounding dedup (which
        # only catches near-identical centers) — this profile must reach
        # the per-connector loop as a genuinely distinct scope, so the
        # resolved-key dedup being tested here is the thing actually
        # doing the work, not the earlier raw-level pass.
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    "second-profile-same-resolved-target",
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [41.0, -4.0], "radius_km": 25}}'
                    ),
                ),
            )
            (second_profile_id,) = cur.fetchone()
        pg_conn.commit()

        connector = _FixedKeyConnector(name="fixed-key-dummy")
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            # Two active profiles, both resolving to the same key -> only
            # the first should have actually reached discover().
            assert len(connector.scopes_seen) == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT discovered_count, fetched_count FROM "
                    "connector_run_results WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                discovered, fetched = cur.fetchone()
            # 3 dummy listings from exactly one discover() call, not 6 from two.
            assert discovered == 3
            assert fetched == 3
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM search_profile WHERE id = %s", (second_profile_id,)
                )
            pg_conn.commit()

    def test_circuit_trip_during_one_scope_stops_remaining_scopes_this_run(
        self, pg_conn
    ):
        """Issue #71 review finding: the limiter/breaker used to be built
        fresh per scope, so a circuit trip while processing one
        profile-geography did nothing to protect the next one in the same
        run — a blocking/misbehaving site got N times the intended error
        budget. With a breaker shared across scopes for one connector's
        run, a trip during the first scope must skip the second entirely
        (never even call discover() for it), not just aggressively fail
        fast within the scope that actually tripped it."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    "second-profile-should-never-be-reached",
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [41.3851, 2.1734], "radius_km": 10}}'
                    ),
                ),
            )
            (second_profile_id,) = cur.fetchone()
        pg_conn.commit()

        # 10 ids, 5 failing (50% > default 30% threshold), min_attempts=2 —
        # trips well within the first scope's own fetch loop, before the
        # second scope (Barcelona, above) is ever reached.
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        failing = frozenset(external_ids[1::2])
        connector = DummyConnector(
            name="test-cross-scope-breaker-connector",
            external_ids=external_ids,
            failing_ids=failing,
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            # Exactly one discover() call — the Madrid fixture profile's
            # scope. The Barcelona scope must never have reached discover()
            # at all, since the breaker was already open by the time the
            # per-connector loop got to it.
            assert len(connector.scopes_seen) == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                (status,) = cur.fetchone()
            assert status == "circuit_open"
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM search_profile WHERE id = %s", (second_profile_id,)
                )
            pg_conn.commit()


def _minimal_canonical(
    external_id: str, source: str, **overrides
) -> CanonicalListingVersion:
    """A CanonicalListingVersion with every required field filled and every
    schema-superset field (issue #76) left at its dataclass default, so a
    test only has to name the fields it actually cares about."""
    defaults: dict = {
        "external_id": external_id,
        "source": source,
        "url": f"https://example.test/{external_id}",
        "listing_kind": "particular",
        "status": "active",
        "current_price": Decimal(200000),
        "description": "test listing",
        "photo_urls": (),
        "contact_raw": None,
        "address": "Calle Falsa 123",
        "lat": None,
        "lon": None,
        "property_type": "piso",
        "m2_built": None,
        "m2_useful": None,
        "rooms": None,
        "bathrooms": None,
        "floor": None,
        "has_elevator": None,
        "year_built": None,
        "energy_rating": None,
    }
    defaults.update(overrides)
    return CanonicalListingVersion(**defaults)


class TestSchemaSupersetFieldsPersistAcrossRevisit:
    """Issue #76's schema-superset fields (city/province/postal_code/m2_plot/
    features/operation) must survive a re-visit where the connector doesn't
    set them — the same COALESCE-preserves-prior-value discipline every
    other optional field in this table already gets. `operation` is the one
    Opus's review of PR #83 found actually broken: its dataclass default of
    'sale' (not None) meant COALESCE never saw a real NULL to fall through
    on, so a real 'rent' value silently reverted to 'sale' on every revisit.
    """

    def test_fields_set_on_insert_survive_a_revisit_that_omits_them(self, pg_conn):
        _apply_schema(pg_conn)
        source = "schema-superset-revisit-test"
        try:
            first = _minimal_canonical(
                "ss-1",
                source,
                city="Sevilla",
                province="Sevilla",
                postal_code="41001",
                m2_plot=Decimal("850.00"),
                features=("terraza", "trastero"),
                operation="rent",
            )
            orchestrator._upsert_canonical_listing(pg_conn, first)

            # Re-visit: a connector that doesn't (re-)report these fields —
            # exactly what every real connector does today, since none of
            # them populate city/province/postal_code/m2_plot/features yet
            # (#77/#78's job), and a connector simply not re-asserting
            # `operation` on a subsequent fetch is the realistic case this
            # bug actually hit.
            second = _minimal_canonical(
                "ss-1",
                source,
                current_price=Decimal(205000),  # a real, unrelated change
            )
            orchestrator._upsert_canonical_listing(pg_conn, second)

            with pg_conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT p.city, p.province, p.postal_code, p.m2_plot, p.features,
                           l.operation, l.current_price
                    FROM listing l JOIN property p ON p.id = l.property_id
                    WHERE l.source = %s AND l.external_id = %s
                    """,
                    (source, "ss-1"),
                )
                row = cur.fetchone()

            assert row is not None
            city, province, postal_code, m2_plot, features, operation, price = row
            assert city == "Sevilla"
            assert province == "Sevilla"
            assert postal_code == "41001"
            assert m2_plot == Decimal("850.00")
            assert set(features) == {"terraza", "trastero"}
            assert operation == "rent", (
                "operation must survive a revisit that doesn't re-set it — "
                "this is the exact bug Opus's review of PR #83 found"
            )
            assert price == Decimal(205000), (
                "a real change on revisit must still take effect"
            )
        finally:
            _cleanup(pg_conn, source)

    def test_operation_defaults_to_sale_when_never_set(self, pg_conn):
        _apply_schema(pg_conn)
        source = "schema-superset-default-operation-test"
        try:
            canonical = _minimal_canonical(
                "ss-2", source
            )  # operation left unset (None)
            orchestrator._upsert_canonical_listing(pg_conn, canonical)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT operation FROM listing WHERE source = %s AND external_id = %s",
                    (source, "ss-2"),
                )
                (operation,) = cur.fetchone()
            assert operation == "sale"
        finally:
            _cleanup(pg_conn, source)


class TestMaterializeAllNotification:
    """Issue #94: a completed connector run must trigger materialization +
    scoring in the dashboard, instead of leaving fresh listings unscored
    until a human clicks something.

    These tests target `notify_materialize_all` directly with a stubbed
    `requests.post` — the real cross-container HTTP round trip is covered by
    the live end-to-end verification recorded in the PR, which is the only
    way to prove the two services actually agree on the credential.
    """

    @staticmethod
    def _stub_requests(monkeypatch, *, calls, response=None, raises=None):
        """Install a fake `requests` module capturing POSTs into `calls`."""
        import sys
        import types

        def fake_post(url, **kwargs):
            calls.append({"url": url, **kwargs})
            if raises is not None:
                raise raises
            return response

        fake_requests = types.ModuleType("requests")
        fake_requests.post = fake_post  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "requests", fake_requests)

    @staticmethod
    def _response(status_code: int):
        class _Resp:
            def __init__(self, code: int) -> None:
                self.status_code = code
                self.ok = 200 <= code < 300

        return _Resp(status_code)

    def test_posts_to_dashboard_with_admin_key(self, monkeypatch):
        """The happy path: correct URL, and the shared admin key attached.

        The key must actually be sent — the endpoint fails closed, so a
        notification without it would 401 and silently leave listings
        unscored, which is the exact bug #94 exists to fix.
        """
        calls: list[dict] = []
        self._stub_requests(monkeypatch, calls=calls, response=self._response(200))
        monkeypatch.setenv("ETL_DASHBOARD_BASE_URL", "http://dashboard:4000")
        monkeypatch.setenv("ADMIN_API_KEY", "s3cret")
        monkeypatch.setenv("POSTGRES_DSN", "postgresql://u@localhost:5432/d")

        assert orchestrator.notify_materialize_all(trigger="test") is True
        assert len(calls) == 1
        assert calls[0]["url"] == "http://dashboard:4000/api/profiles/materialize-all"
        assert calls[0]["headers"]["x-admin-key"] == "s3cret"

    def test_trailing_slash_in_base_url_does_not_double_up(self, monkeypatch):
        calls: list[dict] = []
        self._stub_requests(monkeypatch, calls=calls, response=self._response(200))
        monkeypatch.setenv("ETL_DASHBOARD_BASE_URL", "http://dashboard:4000/")
        monkeypatch.setenv("ADMIN_API_KEY", "s3cret")
        monkeypatch.setenv("POSTGRES_DSN", "postgresql://u@localhost:5432/d")

        orchestrator.notify_materialize_all()
        assert calls[0]["url"] == "http://dashboard:4000/api/profiles/materialize-all"

    def test_empty_base_url_disables_the_call(self, monkeypatch):
        """Running the ETL with no dashboard is a supported setup, not an error."""
        calls: list[dict] = []
        self._stub_requests(monkeypatch, calls=calls, response=self._response(200))
        monkeypatch.setenv("ETL_DASHBOARD_BASE_URL", "")
        monkeypatch.setenv("POSTGRES_DSN", "postgresql://u@localhost:5432/d")

        assert orchestrator.notify_materialize_all() is False
        assert calls == []

    def test_connection_error_is_swallowed(self, monkeypatch):
        """A dashboard that is down must not fail the connector run.

        Ingest is already committed by the time this runs; losing the
        notification only means candidates stay unscored until the next run
        (materialization is idempotent, so it self-heals).
        """
        calls: list[dict] = []
        self._stub_requests(
            monkeypatch, calls=calls, raises=OSError("connection refused")
        )
        monkeypatch.setenv("ETL_DASHBOARD_BASE_URL", "http://dashboard:4000")
        monkeypatch.setenv("ADMIN_API_KEY", "s3cret")
        monkeypatch.setenv("POSTGRES_DSN", "postgresql://u@localhost:5432/d")

        assert orchestrator.notify_materialize_all() is False

    def test_401_is_reported_as_a_distinct_warning(self, monkeypatch, caplog):
        """A key mismatch is an operator error worth naming explicitly.

        Without this, a misconfigured shared secret would look identical to
        "the dashboard is briefly down" and nobody would find out why
        scoring silently stopped.
        """
        calls: list[dict] = []
        self._stub_requests(monkeypatch, calls=calls, response=self._response(401))
        monkeypatch.setenv("ETL_DASHBOARD_BASE_URL", "http://dashboard:4000")
        monkeypatch.setenv("ADMIN_API_KEY", "wrong-key")
        monkeypatch.setenv("POSTGRES_DSN", "postgresql://u@localhost:5432/d")

        with caplog.at_level("WARNING", logger="etl.orchestrator"):
            assert orchestrator.notify_materialize_all() is False
        assert any(
            "401" in r.message or "unauthorized" in r.message.lower()
            for r in caplog.records
        )

    def test_missing_admin_key_warns_instead_of_silently_no_opping(
        self, monkeypatch, caplog
    ):
        calls: list[dict] = []
        self._stub_requests(monkeypatch, calls=calls, response=self._response(401))
        monkeypatch.setenv("ETL_DASHBOARD_BASE_URL", "http://dashboard:4000")
        monkeypatch.delenv("ADMIN_API_KEY", raising=False)
        monkeypatch.setenv("POSTGRES_DSN", "postgresql://u@localhost:5432/d")

        with caplog.at_level("WARNING", logger="etl.orchestrator"):
            orchestrator.notify_materialize_all()
        assert any("ADMIN_API_KEY" in r.message for r in caplog.records)
        # Still attempted (so the 401 surfaces in logs) rather than skipped.
        assert len(calls) == 1
        assert "x-admin-key" not in calls[0]["headers"]

    def test_run_all_connectors_notifies_after_finishing(self, pg_conn, monkeypatch):
        """The wiring itself: a completed run calls the notifier.

        Asserts it fires AFTER the run row is finalized — the run's own
        bookkeeping must be durable before an outbound call that can hang.
        """
        _apply_schema(pg_conn)
        monkeypatch.setattr(orchestrator, "CONNECTORS", [])

        seen: list[str] = []

        def fake_notify(trigger: str = "scheduler") -> bool:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_runs ORDER BY id DESC LIMIT 1"
                )
                (status,) = cur.fetchone()
            seen.append(status)
            return True

        monkeypatch.setattr(orchestrator, "notify_materialize_all", fake_notify)
        run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
        try:
            assert seen == ["success"], (
                "notification must fire after the run row is finalized"
            )
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
            pg_conn.commit()

    def test_notification_failure_does_not_fail_the_run(self, pg_conn, monkeypatch):
        """Even an unexpected exception in the notifier must not lose the run."""
        _apply_schema(pg_conn)
        monkeypatch.setattr(orchestrator, "CONNECTORS", [])

        def boom(trigger: str = "scheduler") -> bool:
            raise RuntimeError("notifier exploded")

        monkeypatch.setattr(orchestrator, "notify_materialize_all", boom)
        run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_runs WHERE id = %s", (run_id,)
                )
                (status,) = cur.fetchone()
            assert status == "success"
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
            pg_conn.commit()
