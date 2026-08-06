"""Integration tests for the connector orchestrator (issue #11, Phase 1.3).

Real PostgreSQL via the pg_conn fixture (skipped if unavailable, per
conftest.py) — the orchestrator's job is entirely about what gets
persisted and how runs are recorded, so mocking the database would test
nothing meaningful.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import ClassVar

import psycopg2
import pytest

from etl import orchestrator
from etl.connectors.base import CanonicalListingVersion, ConnectorError
from etl.connectors.fotocasa import FotocasaConnector
from etl.connectors.geography import (
    UnresolvableGeographyError,
    resolve_place,
    unresolvable_scope_key,
)
from etl.tests.fixtures.dummy_connector import (
    DiscoverFailsConnector,
    DiscoverSoftBlocksConnector,
    DummyConnector,
)

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


class TestConnectorSkipIfSeenDefaults:
    """Issue #143: every connector must inherit safe (no-op) defaults for
    the skip-if-seen machinery unless it explicitly opts in — verified
    against a real Connector subclass that does neither
    (DiscoverFailsConnector never overrides min_refetch_interval_seconds
    or discovered_prices())."""

    def test_min_refetch_interval_seconds_defaults_to_zero(self):
        assert DiscoverFailsConnector.min_refetch_interval_seconds == 0

    def test_discovered_prices_defaults_to_empty_dict(self):
        assert DiscoverFailsConnector().discovered_prices() == {}


class TestShouldSkipFetch:
    """Pure-function tests for the skip-if-seen decision (issue #143) — no
    DB needed, since `_should_skip_fetch` takes every input as a plain
    argument. `_NOW`/helpers keep each case's intent readable without
    hand-computing timedeltas everywhere."""

    _NOW = datetime(2026, 8, 3, 12, 0, 0, tzinfo=timezone.utc)

    def _ago(self, seconds: int) -> datetime:
        return self._NOW - timedelta(seconds=seconds)

    def test_never_fetched_is_never_skipped(self):
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=None,
            stored_price=Decimal(100000),
            stored_status="active",
            discovery_price=Decimal(100000),
            min_refetch_interval_seconds=3600,
            now=self._NOW,
        )
        assert skip is False
        assert "never fetched" in reason

    def test_disabled_for_this_connector_is_never_skipped_even_if_fresh(self):
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(1),  # as fresh as it gets
            stored_price=Decimal(100000),
            stored_status="active",
            discovery_price=None,
            min_refetch_interval_seconds=0,
            now=self._NOW,
        )
        assert skip is False
        assert "disabled" in reason

    def test_missing_stored_price_is_never_skipped(self):
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(1),
            stored_price=None,
            stored_status="active",
            discovery_price=None,
            min_refetch_interval_seconds=3600,
            now=self._NOW,
        )
        assert skip is False
        assert "missing" in reason

    def test_discovery_price_delta_forces_a_fetch_despite_freshness(self):
        """The core guarantee (issue #143's acceptance criteria): a price
        change detected at discovery time is never silently absorbed by
        the staleness window, however fresh the listing otherwise is."""
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(1),  # 1 second ago — as fresh as possible
            stored_price=Decimal(200000),
            stored_status="active",
            discovery_price=Decimal(190000),  # a real drop just seen at discovery
            min_refetch_interval_seconds=86400,
            now=self._NOW,
        )
        assert skip is False
        assert "differs" in reason

    def test_discovery_price_matching_stored_price_is_not_a_reason_to_fetch(self):
        """The mirror case: a discovery price that agrees with what's
        stored is NOT itself a signal to skip (that's the age check's job)
        — it just doesn't force anything."""
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(1),
            stored_price=Decimal(200000),
            stored_status="active",
            discovery_price=Decimal(200000),
            min_refetch_interval_seconds=86400,
            now=self._NOW,
        )
        assert skip is True
        assert "no discovery-time price delta" in reason

    def test_no_discovery_price_signal_falls_through_to_age(self):
        skip, _reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(1),
            stored_price=Decimal(200000),
            stored_status="active",
            discovery_price=None,
            min_refetch_interval_seconds=86400,
            now=self._NOW,
        )
        assert skip is True

    def test_stale_listing_is_fetched_not_skipped(self):
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(90000),  # older than the window below
            stored_price=Decimal(200000),
            stored_status="active",
            discovery_price=None,
            min_refetch_interval_seconds=86400,
            now=self._NOW,
        )
        assert skip is False
        assert "stale" in reason

    def test_exactly_at_the_window_boundary_is_fetched_not_skipped(self):
        """>= , not >, at the boundary — a listing fetched exactly
        min_refetch_interval_seconds ago is due, not still fresh."""
        skip, _reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(3600),
            stored_price=Decimal(200000),
            stored_status="active",
            discovery_price=None,
            min_refetch_interval_seconds=3600,
            now=self._NOW,
        )
        assert skip is False

    def test_fresh_unchanged_listing_is_skipped(self):
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(60),
            stored_price=Decimal(200000),
            stored_status="active",
            discovery_price=None,
            min_refetch_interval_seconds=3600,
            now=self._NOW,
        )
        assert skip is True
        assert "fetched" in reason

    def test_withdrawn_status_forces_a_fetch_despite_freshness_and_matching_price(
        self,
    ):
        """Must-fix (Opus review, PR #175): a listing stored as anything
        other than 'active' must always be forced to re-fetch, however
        fresh it looks and however much its discovery-time price agrees
        with what's stored — otherwise a withdrawn listing that reappears
        in discover() at an unchanged price is skipped exactly like a
        normal active listing, and self-heals only once the staleness
        window happens to expire (up to 24h for Fotocasa) instead of on
        the very next sweep."""
        skip, reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(1),  # as fresh as possible
            stored_price=Decimal(200000),
            stored_status="withdrawn",
            discovery_price=Decimal(200000),  # unchanged — no price signal either
            min_refetch_interval_seconds=86400,
            now=self._NOW,
        )
        assert skip is False
        assert "withdrawn" in reason
        assert "not 'active'" in reason

    def test_active_status_does_not_force_a_fetch_on_its_own(self):
        """Mirror case: an 'active' stored status is not itself a reason
        to fetch — it just doesn't block the normal staleness logic from
        skipping, same as a matching discovery price."""
        skip, _reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(60),
            stored_price=Decimal(200000),
            stored_status="active",
            discovery_price=None,
            min_refetch_interval_seconds=3600,
            now=self._NOW,
        )
        assert skip is True

    def test_none_stored_status_does_not_force_a_fetch(self):
        """A NULL `listing.status` (schema allows it) must not be treated
        as 'not active' — only an explicit non-'active' value should force
        a fetch. `last_fetched_at is not None` here means this isn't the
        'never fetched' branch either, so the status check is what's
        actually being isolated."""
        skip, _reason = orchestrator._should_skip_fetch(
            last_fetched_at=self._ago(60),
            stored_price=Decimal(200000),
            stored_status=None,
            discovery_price=None,
            min_refetch_interval_seconds=3600,
            now=self._NOW,
        )
        assert skip is True


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
            # A disabled connector is counted in the per-run summary
            # (total_connectors + connectors_skipped), never toward ok/failed —
            # "told not to run" is neither a success nor a failure.
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
                row = cur.fetchone()
            # Issue #292: a deliberately-disabled connector no longer writes a
            # per-sweep 'skipped' result row (that flooded the health surface).
            # Only the lightweight connectors_skipped summary above records it;
            # there is NO connector_run_results row for it.
            assert row is None
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

    def test_unresolvable_geography_reaches_connector_run_results_as_failed(
        self, pg_conn
    ):
        """Issue #169's core bug, proven end-to-end through a REAL connector
        (not a fake DiscoverFailsConnector, and not a per-connector unit
        test): a profile centered somewhere the gazetteer cannot identify at
        all used to read as "connector ran fine, found nothing" —
        indistinguishable from a real zero-listings day. It must instead
        surface as a genuine `connector_run_results` row with
        status='failed' and an error_msg an operator can actually act on.

        Lisbon (a real center point, just not a Spanish municipality the
        gazetteer covers) is the same unresolvable center
        `test_geography.py::TestResolvePlace::test_unresolvable_center_raises_not_returns_none`
        uses — this test proves the same failure survives the full
        orchestrator round-trip into Postgres, not just the in-process
        exception.
        """
        _apply_schema(pg_conn)
        # Replace the fixture's Madrid-scoped (resolvable) profile with one
        # whose only active profile is genuinely unresolvable — otherwise
        # Fotocasa would also see the fixture's Madrid scope and this run's
        # status would be a mix, not a clean assertion of the failure path.
        # PR #177 round 3, N8: scoped to `_TEST_PROFILE_NAME` specifically
        # (not `WHERE archived_at IS NULL`, which archived EVERY active
        # profile in the shared test DB, including ones seeded by other
        # test classes in this same module — e.g.
        # TestMultiScopeWithdrawalReconciliation's "multiscope-*" profiles —
        # and only ever restored `_TEST_PROFILE_NAME` in `finally`,
        # permanently archiving those other real fixtures).
        with pg_conn.cursor() as cur:
            cur.execute(
                "UPDATE search_profile SET archived_at = NOW() "
                "WHERE name = %s AND archived_at IS NULL",
                (_TEST_PROFILE_NAME,),
            )
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    "unresolvable-geography-test-profile",
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [38.7223, -9.1393], "radius_km": 10}}'
                    ),
                ),
            )
            (profile_id,) = cur.fetchone()
        pg_conn.commit()

        connector = FotocasaConnector()
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, discovered_count, fetched_count, error_msg "
                    "FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                row = cur.fetchone()
            assert row is not None, (
                "an unresolvable scope must still produce a "
                "connector_run_results row — not silence"
            )
            status, discovered_count, fetched_count, error_msg = row
            # The bug this guards against: status='ok' with discovered=0
            # reads identically to "genuinely searched Lisbon and found
            # nothing there" — an operator has no way to tell the two
            # apart. It must be 'failed' instead.
            assert status == "failed"
            assert discovered_count == 0
            assert fetched_count == 0
            assert error_msg is not None
            assert "gazetteer" in error_msg.lower() or "resolve" in error_msg.lower()

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT connectors_failed FROM connector_runs WHERE id = %s",
                    (run_id,),
                )
                (connectors_failed,) = cur.fetchone()
            assert connectors_failed == 1
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
                cur.execute(
                    "UPDATE search_profile SET archived_at = NULL WHERE name = %s",
                    (_TEST_PROFILE_NAME,),
                )
            pg_conn.commit()


class TestSkipIfSeenIntegration:
    """Issue #143: end-to-end orchestrator wiring for the skip-if-seen
    policy — connector_config override, last_seen_at/last_fetched_at
    bookkeeping, skipped_count reporting, and the price-change guarantee.
    `_should_skip_fetch` itself is unit-tested in isolation above
    (TestShouldSkipFetch); this class proves run_all_connectors actually
    calls it with the right inputs and acts on the result correctly."""

    def _cleanup_config(self, conn, *names: str) -> None:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM connector_config WHERE connector_name = ANY(%s)",
                (list(names),),
            )
        conn.commit()

    def _listing_row(self, conn, source: str, external_id: str):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT current_price, last_seen_at, last_fetched_at "
                "FROM listing WHERE source = %s AND external_id = %s",
                (source, external_id),
            )
            return cur.fetchone()

    def test_second_run_within_window_skips_the_unchanged_listing(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-unchanged",
            external_ids=("s-1",),
            min_refetch_interval_seconds=3600,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["s-1"], "first run: never seen before"

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["s-1"], (
                "second run must NOT call fetch_detail again — fresh, "
                "unchanged, price present"
            )

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT skipped_count, fetched_count FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_ids[1], connector.name),
                )
                skipped_count, fetched_count = cur.fetchone()
            assert skipped_count == 1
            assert fetched_count == 0
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_a_reappearing_withdrawn_listing_is_refetched_not_skipped(self, pg_conn):
        """Must-fix (Opus review, PR #175): reproduces the exact bug report
        end-to-end. A listing forced to status='withdrawn' with
        missed_discovery_count=3 (as if `_reconcile_missed_discoveries` had
        genuinely withdrawn it after 3 misses) reappears in discover() at
        the SAME price, well within the freshness window — before this
        fix, `_should_skip_fetch` had no way to see `status` at all, so
        this was treated exactly like a normal fresh/unchanged listing and
        skipped. That leaves the listing invisible to candidates/scoring
        (which filter withdrawn listings out), `missed_discovery_count`
        frozen (`_reconcile_missed_discoveries` only scans `WHERE status =
        'active'`, so a withdrawn row's own counter can never reset), and
        `last_seen_at` freshly bumped by `_update_last_seen_for_discovered`
        regardless of the skip — every staleness signal says "healthy"
        while the one field that says "we think this is gone" never
        changes, for up to the full staleness window (24h for Fotocasa).

        With the fix: fetch_detail() runs despite the skip-if-seen
        conditions otherwise being satisfied, DummyConnector.normalize()
        always returns status="active" (a real re-fetch confirms the
        listing IS there), and _update_existing_listing's plain
        `status = COALESCE(%s, status)` write reverts it — proving the
        listing self-heals on the very next sweep, not after the window
        expires.
        """
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-reappearing-withdrawn",
            external_ids=("w-1",),
            price=200000,
            min_refetch_interval_seconds=24 * 60 * 60,  # Fotocasa's real window
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            # First run: creates the listing, active, price 200000.
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["w-1"]

            # Simulate _reconcile_missed_discoveries having genuinely
            # withdrawn it after 3 consecutive misses — recent
            # last_fetched_at (well within the 24h window) so only the
            # status check, not staleness, can be what forces the next
            # fetch.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE listing SET status = 'withdrawn', "
                    "missed_discovery_count = 3 "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "w-1"),
                )
            pg_conn.commit()

            # Second sweep: discover() finds it again at the SAME price —
            # no discovery-time price delta, nowhere near stale. Only the
            # stored status disagreeing with 'active' should force this.
            connector.discovery_price_overrides = {"w-1": 200000}
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            assert connector.fetch_calls == ["w-1", "w-1"], (
                "a reappearing withdrawn listing must be re-fetched on the "
                "very next sweep, not skipped like a normal active listing"
            )

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, missed_discovery_count FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "w-1"),
                )
                status, missed_count = cur.fetchone()
            assert status == "active", (
                "the real re-fetch must revert status back to 'active' — "
                "otherwise the listing stays invisible to candidates/"
                "scoring even though it was just re-confirmed present"
            )
            assert missed_count == 0, (
                "a real re-fetch resets missed_discovery_count via "
                "_update_existing_listing, same as any other revisit"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_discovery_time_price_change_forces_a_refetch_despite_freshness(
        self, pg_conn
    ):
        """The mutation-critical proof: skip-if-seen must not be able to
        silently stop detecting a real price change. A large
        min_refetch_interval_seconds (far longer than this test could ever
        run) proves the price delta — not elapsed time — is what triggers
        the second fetch."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-price-change",
            external_ids=("p-1",),
            price=205000,
            min_refetch_interval_seconds=24 * 60 * 60,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["p-1"]

            # A real price drop, seen at discovery time (Fotocasa's
            # rawPrice-equivalent) — the fetched price hasn't changed yet
            # in the connector's own fetch_detail() response, only the
            # discovery-time signal has, which is exactly what must be
            # enough to force the re-fetch.
            connector.discovery_price_overrides = {"p-1": 195000}
            connector.price = 195000
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            assert connector.fetch_calls == ["p-1", "p-1"], (
                "a discovery-time price delta must force a re-fetch even "
                "though the listing is nowhere near stale"
            )

            current_price, _last_seen, _last_fetched = self._listing_row(
                pg_conn, connector.name, "p-1"
            )
            assert current_price == Decimal(195000)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT h.price FROM listing_price_history h "
                    "JOIN listing l ON l.id = h.listing_id "
                    "WHERE l.source = %s AND l.external_id = %s ORDER BY h.observed_at",
                    (connector.name, "p-1"),
                )
                prices = [row[0] for row in cur.fetchall()]
            assert prices == [205000, 195000], (
                "the price-history append behaviour must survive skip-if-seen"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_stale_listing_is_refetched_after_the_window_elapses(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-stale",
            external_ids=("st-1",),
            min_refetch_interval_seconds=3600,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["st-1"]

            # Backdate last_fetched_at past the window — simulates a
            # genuine gap since the last real fetch without needing the
            # test to actually sleep an hour.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE listing SET last_fetched_at = NOW() - INTERVAL '2 hours' "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "st-1"),
                )
            pg_conn.commit()

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["st-1", "st-1"], (
                "a listing older than min_refetch_interval_seconds must be "
                "re-fetched, not skipped"
            )

            # The real re-fetch must also bring last_fetched_at back to
            # "now" — otherwise every subsequent run would see the same
            # stale timestamp and re-fetch again forever, defeating the
            # whole point of tracking it.
            _price, _last_seen, last_fetched = self._listing_row(
                pg_conn, connector.name, "st-1"
            )
            assert last_fetched > datetime.now(timezone.utc) - timedelta(minutes=5), (
                "a real re-fetch must advance last_fetched_at to now, not "
                "leave it at the backdated value"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_last_seen_at_advances_even_when_the_fetch_is_skipped(self, pg_conn):
        """Acceptance criterion: listing.last_seen_at must stay current for
        a listing discover() re-confirms but skip-if-seen declines to
        re-fetch — otherwise "skipped, still there" becomes
        indistinguishable from "nobody has looked at this in weeks"."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-last-seen-at",
            external_ids=("ls-1",),
            min_refetch_interval_seconds=3600,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            _price_1, _last_seen_1, last_fetched_1 = self._listing_row(
                pg_conn, connector.name, "ls-1"
            )

            # Force last_seen_at to an unambiguously stale value first —
            # asserting a strict `>` against a same-millisecond timestamp
            # from two back-to-back run_all_connectors() calls would be a
            # flaky, weak proxy for "did this actually get updated". A
            # backdated value makes the healthy-vs-broken outcomes
            # unambiguous instead: NOW() during run 2 is always far more
            # recent than 1 day ago (healthy), or it stays exactly at the
            # backdated value if nothing touches it this run (broken).
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE listing SET last_seen_at = NOW() - INTERVAL '1 day' "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "ls-1"),
                )
            pg_conn.commit()

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["ls-1"], "second run must be skipped"

            _price_2, last_seen_2, last_fetched_2 = self._listing_row(
                pg_conn, connector.name, "ls-1"
            )
            assert last_seen_2 > datetime.now(timezone.utc) - timedelta(hours=1), (
                "last_seen_at must advance from the discover()-only sighting "
                "even though fetch_detail() was skipped — it must not still "
                "be sitting at the artificially backdated value"
            )
            assert last_fetched_2 == last_fetched_1, (
                "last_fetched_at must NOT advance — no real fetch happened "
                "on the second run"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_missing_stored_price_backfills_despite_freshness(self, pg_conn):
        """A listing whose current_price is NULL (e.g. ingested via a path
        that never captured it) must be re-fetched regardless of how
        recently it was touched — never left permanently unpopulated
        behind a staleness window."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-missing-price",
            external_ids=("mp-1",),
            min_refetch_interval_seconds=3600,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE listing SET current_price = NULL "
                    "WHERE source = %s AND external_id = %s",
                    (connector.name, "mp-1"),
                )
            pg_conn.commit()

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["mp-1", "mp-1"], (
                "a missing stored price must force a re-fetch even though "
                "the listing is fresh by age"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_new_listing_appearing_mid_window_is_fetched_promptly(self, pg_conn):
        """Acceptance criterion: newly-appearing listings must not be
        starved behind a refresh backlog — a brand-new id discovered
        alongside an already-fresh, skipped one must still be fetched."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-new-listing",
            external_ids=("nl-1",),
            min_refetch_interval_seconds=3600,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["nl-1"]

            connector.external_ids = ("nl-1", "nl-2")
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            assert connector.fetch_calls == ["nl-1", "nl-2"], (
                "nl-1 (fresh, unchanged) must be skipped; nl-2 (brand new) "
                "must be fetched in the same run"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_connector_config_override_takes_precedence_over_class_default(
        self, pg_conn
    ):
        """Issue #143: min_refetch_interval_seconds is operator-overridable
        per connector via connector_config, same override-vs-class-default
        pattern issue #99 established for filters.rooms."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-config-override",
            external_ids=("co-1",),
            min_refetch_interval_seconds=0,  # class default: always fetch
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO connector_config "
                    "(connector_name, min_refetch_interval_seconds) VALUES (%s, %s)",
                    (connector.name, 3600),
                )
            pg_conn.commit()

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["co-1"]

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["co-1"], (
                "the connector_config override (3600s) must win over this "
                "connector's own class-attribute default (0 = always fetch)"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, connector.name)
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_negative_config_override_is_ignored_falls_back_to_class_default(
        self, pg_conn
    ):
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="skip-seen-negative-override",
            external_ids=("neg-1",),
            min_refetch_interval_seconds=0,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO connector_config "
                    "(connector_name, min_refetch_interval_seconds) VALUES (%s, %s)",
                    (connector.name, -5),
                )
            pg_conn.commit()

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["neg-1", "neg-1"], (
                "a negative override is nonsensical and must be ignored, "
                "falling back to this connector's own default (0 = always "
                "fetch), not silently coerced to 0 or crashing the run"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            self._cleanup_config(pg_conn, connector.name)
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()


class _GeographyAwareConnector(DummyConnector):
    """Mimics a real connector's geography-resolution contract — `scope_key`
    delegating to the shared gazetteer and returning the
    `unresolvable_scope_key` sentinel (not None) for a scope
    `resolve_place` can't identify, `discover()` calling `resolve_place`
    and letting `UnresolvableGeographyError` propagate uncaught — without
    any network dependency. Every real connector follows this exact shape
    (see e.g. fotocasa.py's `scope_key`/`discover`); this is the minimal
    version needed to drive the real sentinel path through the orchestrator
    for issue #177's M4 tests below.

    `discovers_full_inventory=True` (unlike Fotocasa, which is
    permanently False and so is EXCLUDED from withdrawal reconciliation
    regardless of this bug — see run_connector's `reconcilable` gate) is
    load-bearing here: it's what lets these tests actually exercise
    reconciliation, which is the specific behaviour M4 is about.
    """

    def __init__(self, **kwargs):
        kwargs.setdefault("discovers_full_inventory", True)
        super().__init__(**kwargs)

    def scope_key(self, scope):
        try:
            place = resolve_place(scope)
        except UnresolvableGeographyError:
            return unresolvable_scope_key(scope)
        if place is None:
            return None
        return place.name

    def discover(self, scope, throttle):
        self.scopes_seen.append(scope)
        resolve_place(scope)  # raises UnresolvableGeographyError, left uncaught
        return list(self.external_ids)


class TestUnresolvableScopeReconciliationIsolation:
    """Issue #177 (Opus review of #169), M4: a scope whose center resolves
    to nowhere in the gazetteer at all must not poison this run's handling
    of every OTHER, perfectly resolvable scope for the same connector.

    Before this fix, `etl/orchestrator.py`'s per-scope loop treated
    `UnresolvableGeographyError` (raised by the sentinel `scope_key()` path
    — see geography.py's `unresolvable_scope_key` docstring) identically to
    any other `discover()` failure: it set `reconcilable_union = False` for
    the WHOLE connector run (skipping withdrawal reconciliation even for
    scopes that resolved and crawled fine) and `any_scope_failed = True`
    (permanently marking the connector 'failed' on every run for as long
    as the one bad profile stayed active) — directly contradicting this
    same function's own documented intent ("an unresolvable-for-everyone
    connector must not end up permanently 'failed'").
    """

    def test_mixed_resolvable_and_unresolvable_scopes_stays_ok_and_reconciles(
        self, pg_conn
    ):
        _apply_schema(pg_conn)
        # Two active profiles: the fixture's Madrid one (resolvable,
        # `_apply_schema` already seeded it) plus a genuinely unresolvable
        # Lisbon one, active for the whole test.
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    "m4-unresolvable-profile",
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [38.7223, -9.1393], "radius_km": 10}}'
                    ),
                ),
            )
            (profile_id,) = cur.fetchone()
        pg_conn.commit()

        connector = _GeographyAwareConnector(
            name="m4-isolation-test", external_ids=("w-1", "w-2")
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, discovered_count, error_msg "
                    "FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_ids[-1], connector.name),
                )
                status, discovered_count, error_msg = cur.fetchone()
            assert status == "ok", (
                "one unrelated unresolvable-geography profile (Lisbon) must "
                "not flip the WHOLE connector to 'failed' when its other "
                "scope (the Madrid fixture profile) resolved and crawled "
                "fine this same run"
            )
            assert discovered_count == 2
            assert error_msg is not None and "unresolvable" in error_msg.lower(), (
                "the unresolvable scope must still be a VISIBLE outcome in "
                "error_msg, not silently dropped just because the "
                "connector's overall status ended up 'ok'"
            )

            # w-2 stops appearing from here on. The Lisbon scope keeps
            # failing (with UnresolvableGeographyError) on every single one
            # of these runs too — that's the whole point.
            connector.external_ids = ("w-1",)
            for _ in range(orchestrator._WITHDRAWAL_THRESHOLD):
                run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM listing WHERE source = %s AND external_id = %s",
                    (connector.name, "w-2"),
                )
                (w2_status,) = cur.fetchone()
            assert w2_status == "withdrawn", (
                "a genuinely gone listing under the resolvable Madrid scope "
                "must still withdraw via reconciliation — proving the "
                "unresolvable Lisbon scope (present in every one of these "
                "runs) did not disable reconciliation for this connector"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
                cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
            pg_conn.commit()

    def test_only_unresolvable_scopes_still_reports_failed(self, pg_conn):
        """The other half of the fix: when NOTHING this run ever resolved
        (every active scope is unresolvable, or otherwise never reached a
        successful `run_connector` call), the connector must still report
        'failed' — the fix narrows WHEN 'failed' applies, it does not make
        an all-bad run silently look healthy. Mirrors
        `TestCircuitBreakerIntegration.test_unresolvable_geography_reaches_
        connector_run_results_as_failed` (a real FotocasaConnector), using
        the lightweight `_GeographyAwareConnector` instead so this stays
        independent of Fotocasa's own `discovers_full_inventory=False`
        quirk."""
        _apply_schema(pg_conn)
        # PR #177 round 3, N8: scoped to `_TEST_PROFILE_NAME` — see the
        # identical fix (and its rationale) in
        # test_unresolvable_geography_reaches_connector_run_results_as_failed
        # above. A blanket `WHERE archived_at IS NULL` here archived every
        # active profile in the shared test DB, not just the fixture one
        # this test means to suppress.
        with pg_conn.cursor() as cur:
            cur.execute(
                "UPDATE search_profile SET archived_at = NOW() "
                "WHERE name = %s AND archived_at IS NULL",
                (_TEST_PROFILE_NAME,),
            )
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    "m4-only-unresolvable-profile",
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [38.7223, -9.1393], "radius_km": 10}}'
                    ),
                ),
            )
            (profile_id,) = cur.fetchone()
        pg_conn.commit()

        connector = _GeographyAwareConnector(name="m4-all-bad-test")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
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
            assert error_msg is not None and "unresolvable" in error_msg.lower()
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
                cur.execute(
                    "UPDATE search_profile SET archived_at = NULL WHERE name = %s",
                    (_TEST_PROFILE_NAME,),
                )
            pg_conn.commit()


class TestResolvedButUncoveredVisibility:
    """PR #177 round 3 (also-fix): the "resolved but uncovered" path
    (`etl/orchestrator.py`'s `run_all_connectors`, the `place is not None`
    branch right after `scope_key() is None`) had ZERO test coverage before
    this — `grep -rn "uncovered" etl/tests/` matched nothing. It is a real,
    useful, distinct signal (a scope centered on a REAL gazetteer
    municipality this connector's own coverage table just doesn't list —
    different from "no geography info at all", per that branch's own
    docstring) that reaches `connector_run_results.error_msg` with a
    `"resolved but uncovered: "` prefix an operator (or a future alert
    query) can filter on. But the row's `status` stays `'ok'` — correct
    semantics (this is explicitly documented as "not a failure"), yet it
    means the signal is invisible to anyone who only looks at `status`,
    only surfacing to someone who thinks to read `error_msg` on a green
    row. Getafe is a real, correct choice for this: an actual gazetteer
    municipality (used throughout test_geography.py) that is deliberately
    NOT in Fotocasa's own `_CITY_SLUGS` table.
    """

    def test_resolved_but_uncovered_scope_stays_ok_with_a_visible_error_msg(
        self, pg_conn
    ):
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            # Scoped to `_TEST_PROFILE_NAME` by name (PR #177 round 3, N8) —
            # not a blanket `WHERE archived_at IS NULL`, which would archive
            # every active profile in the shared test DB, not just this
            # fixture's.
            cur.execute(
                "UPDATE search_profile SET archived_at = NOW() "
                "WHERE name = %s AND archived_at IS NULL",
                (_TEST_PROFILE_NAME,),
            )
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    "resolved-but-uncovered-test-profile",
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [40.30472, -3.73111], "radius_km": 5}}'
                    ),
                ),
            )
            (profile_id,) = cur.fetchone()
        pg_conn.commit()

        connector = FotocasaConnector()
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, discovered_count, error_msg "
                    "FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                row = cur.fetchone()
            assert row is not None, (
                "a resolved-but-uncovered-only scope must still produce a "
                "connector_run_results row"
            )
            status, discovered_count, error_msg = row
            # Not a failure — Getafe resolved fine, this connector just has
            # no slug for it. Confirms the "ok" contract this whole path is
            # explicitly designed around.
            assert status == "ok"
            assert discovered_count == 0
            # The actual coverage assertion: the signal must be present and
            # distinguishable in error_msg, per orchestrator.py's own
            # `f"resolved but uncovered: {scope} -> {place.name}/..."` — this
            # is what "zero test coverage" meant nobody had verified.
            assert error_msg is not None
            assert "resolved but uncovered" in error_msg.lower()
            assert "getafe" in error_msg.lower()
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
                cur.execute(
                    "UPDATE search_profile SET archived_at = NULL WHERE name = %s",
                    (_TEST_PROFILE_NAME,),
                )
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
        # This test's own premise genuinely needs zero active profiles
        # (unlike the other tests in this module, which only need to
        # suppress `_TEST_PROFILE_NAME` specifically), so it can't scope the
        # archive by name the way those do. PR #177 round 3, N8: instead of
        # assuming only `_TEST_PROFILE_NAME` was active (the bug — any OTHER
        # profile active in the shared test DB at this moment, e.g. from a
        # different test class's fixture, got archived here and never
        # restored), capture exactly which rows this statement archived via
        # RETURNING and restore precisely those in `finally`.
        with pg_conn.cursor() as cur:
            cur.execute(
                "UPDATE search_profile SET archived_at = NOW() "
                "WHERE archived_at IS NULL RETURNING id"
            )
            archived_ids = [row[0] for row in cur.fetchall()]
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
                # Restore exactly the rows this test archived (PR #177
                # round 3, N8) — not just `_TEST_PROFILE_NAME` by name,
                # which would silently leave any OTHER profile this test
                # happened to archive (e.g. a different test class's
                # fixture, still active in the shared test DB when this
                # test ran) permanently archived.
                if archived_ids:
                    cur.execute(
                        "UPDATE search_profile SET archived_at = NULL "
                        "WHERE id = ANY(%s)",
                        (archived_ids,),
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


class TestUniqueViolationHandling:
    """Issue #140 narrowed the UniqueViolation handler by constraint name.

    The listing-level recovery it guards had no test at all before that
    change, so a regression in the one path that *should* recover would
    have been silent. These cover both directions: the recoverable
    collision still recovers, and anything else propagates honestly instead
    of dying on a tuple-unpack TypeError inside the wrong handler.
    """

    def test_listing_collision_still_recovers_by_updating_in_place(self, pg_conn):
        """Simulates the concurrent-run race the handler exists for.

        A competing run inserts the same (source, external_id) between our
        SELECT and our INSERT. Reproduced by blinding the initial lookup so
        the code takes the INSERT path against a row that already exists.
        """
        _apply_schema(pg_conn)
        source = "unique-violation-recovery-test"
        try:
            orchestrator._upsert_canonical_listing(
                pg_conn,
                _minimal_canonical("race-1", source, current_price=Decimal(100000)),
            )

            class _BlindFirstLookup:
                """Returns None once, so the caller believes the row is new."""

                def __init__(self, conn):
                    self._conn = conn
                    self._blinded = False

                def cursor(self):
                    inner = self._conn.cursor()
                    outer = self

                    class _Cur:
                        def __enter__(self_inner):
                            inner.__enter__()
                            return self_inner

                        def __exit__(self_inner, *exc):
                            return inner.__exit__(*exc)

                        def execute(self_inner, *a, **kw):
                            return inner.execute(*a, **kw)

                        def fetchone(self_inner):
                            row = inner.fetchone()
                            if not outer._blinded:
                                outer._blinded = True
                                return None
                            return row

                        def __getattr__(self_inner, name):
                            return getattr(inner, name)

                    return _Cur()

                def __getattr__(self, name):
                    return getattr(self._conn, name)

            orchestrator._upsert_canonical_listing(
                _BlindFirstLookup(pg_conn),
                _minimal_canonical("race-1", source, current_price=Decimal(175000)),
            )

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*), MAX(current_price) FROM listing "
                    "WHERE source = %s AND external_id = %s",
                    (source, "race-1"),
                )
                count, price = cur.fetchone()
            assert count == 1, "the race must update in place, not duplicate"
            assert price == Decimal(175000), "the losing run's data must still land"
        finally:
            _cleanup(pg_conn, source)

    def test_property_level_violation_propagates_instead_of_being_swallowed(
        self, pg_conn
    ):
        """The narrowing itself: a *non*-listing violation must escape.

        `property` has no unique constraint of its own in the shipped
        schema (#140 dropped the one on `cadastral_ref`), so one is added
        for the duration of this test — the point is the handler's
        behaviour on any constraint that isn't
        `listing_source_external_id_key`, not this particular column.

        Without the narrowing the handler swallows this, re-queries
        `listing` by (source, external_id), finds nothing because the
        listing INSERT was never reached, and dies unpacking `None` into
        four names — a TypeError naming neither the constraint nor the
        column. Asserting on the constraint name is what makes this test
        fail if the narrowing is removed; asserting merely "it raises"
        would pass either way, since the TypeError is also a raise.
        """
        # Lazy, like orchestrator.py's own import: psycopg2 is an optional
        # dependency and a module-level import here would break collection
        # for anyone running the non-DB tests without it.
        from psycopg2.errors import UniqueViolation

        _apply_schema(pg_conn)
        source = "property-level-violation-test"
        shared_address = "Calle Colisión 1"
        with pg_conn.cursor() as cur:
            cur.execute(
                "ALTER TABLE property ADD CONSTRAINT tmp_property_address_key "
                "UNIQUE (address)"
            )
        pg_conn.commit()
        try:
            orchestrator._upsert_canonical_listing(
                pg_conn, _minimal_canonical("prop-1", source, address=shared_address)
            )

            # Different listing, same address: the listing INSERT is fine,
            # the property INSERT that precedes it inside the same try is not.
            with pytest.raises(UniqueViolation) as excinfo:
                orchestrator._upsert_canonical_listing(
                    pg_conn,
                    _minimal_canonical("prop-2", source, address=shared_address),
                )
            assert excinfo.value.diag.constraint_name == "tmp_property_address_key", (
                "the real constraint must reach the caller, not be recast as "
                "a listing-race recovery"
            )
        finally:
            pg_conn.rollback()  # the failed INSERT aborted the transaction
            _cleanup(pg_conn, source)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "ALTER TABLE property DROP CONSTRAINT IF EXISTS "
                    "tmp_property_address_key"
                )
            pg_conn.commit()

    def test_constraint_name_degrades_to_none_without_diag(self):
        """A synthesised exception must not crash the handler while handling."""
        assert orchestrator._constraint_name(ValueError("no diag here")) is None


class TestCadastralRefPersistence:
    """Issue #140: the dedup engine's definitive signal needs the column written."""

    def test_cadastral_ref_persists_and_survives_a_revisit_that_omits_it(self, pg_conn):
        _apply_schema(pg_conn)
        source = "cadastral-persistence-test"
        try:
            first = _minimal_canonical(
                "cad-1", source, cadastral_ref="9872023VH5797S0001WX"
            )
            orchestrator._upsert_canonical_listing(pg_conn, first)

            # A source that doesn't publish the reference must not blank it —
            # matters once dedup points two listings at one property row.
            second = _minimal_canonical("cad-1", source)
            orchestrator._upsert_canonical_listing(pg_conn, second)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT p.cadastral_ref FROM listing l "
                    "JOIN property p ON p.id = l.property_id "
                    "WHERE l.source = %s AND l.external_id = %s",
                    (source, "cad-1"),
                )
                (cadastral_ref,) = cur.fetchone()
            assert cadastral_ref == "9872023VH5797S0001WX"
        finally:
            _cleanup(pg_conn, source)

    def test_two_sources_may_persist_the_same_cadastral_ref(self, pg_conn):
        """The UNIQUE constraint that made signal 1 unreachable is gone.

        Before #140 the second ingest raised a property-level
        UniqueViolation, which the listing-level handler then mis-attributed
        and turned into a confusing TypeError.
        """
        _apply_schema(pg_conn)
        source_a = "cadastral-shared-a"
        source_b = "cadastral-shared-b"
        ref = "1234567AB1234C0001AB"
        try:
            orchestrator._upsert_canonical_listing(
                pg_conn, _minimal_canonical("shared-1", source_a, cadastral_ref=ref)
            )
            orchestrator._upsert_canonical_listing(
                pg_conn, _minimal_canonical("shared-1", source_b, cadastral_ref=ref)
            )

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(DISTINCT p.id) FROM listing l "
                    "JOIN property p ON p.id = l.property_id "
                    "WHERE p.cadastral_ref = %s",
                    (ref,),
                )
                assert cur.fetchone()[0] == 2, (
                    "two distinct property rows must be able to share a "
                    "cadastral_ref — that state is what signal 1 detects"
                )
        finally:
            _cleanup(pg_conn, source_a)
            _cleanup(pg_conn, source_b)


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


class TestRestartBurstGuard:
    """Issue #172: a minimum-inter-run-interval guard against restart-
    triggered scrape bursts. `docs/skills/connectors.md` used to document
    "every container restart sweeps immediately" as an operator-discipline
    concern only ("be deliberate about it") — this proves the actual guard
    that replaces that framing."""

    def _cleanup_runs(self, conn, run_ids: list[int]) -> None:
        with conn.cursor() as cur:
            for r in run_ids:
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
        conn.commit()

    def test_no_prior_completed_run_never_skips(self, pg_conn):
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM connector_runs")
        pg_conn.commit()

        skip, last_finished = orchestrator.should_skip_immediate_sweep(
            pg_conn, min_restart_sweep_interval_seconds=900
        )
        assert skip is False
        assert last_finished is None

    def test_threshold_zero_disables_the_guard_outright(self, pg_conn):
        """0 is the documented, explicit opt-out — not a special-cased
        'never happens in practice' value."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at, finished_at) "
                "VALUES ('test', 'success', NOW(), NOW()) RETURNING id"
            )
            run_id = cur.fetchone()[0]
        pg_conn.commit()
        try:
            skip, _last_finished = orchestrator.should_skip_immediate_sweep(
                pg_conn, min_restart_sweep_interval_seconds=0
            )
            assert skip is False
        finally:
            self._cleanup_runs(pg_conn, [run_id])

    def test_recently_completed_run_is_skipped(self, pg_conn):
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at, finished_at) "
                "VALUES ('test', 'success', NOW(), NOW()) RETURNING id"
            )
            run_id = cur.fetchone()[0]
        pg_conn.commit()
        try:
            skip, last_finished = orchestrator.should_skip_immediate_sweep(
                pg_conn, min_restart_sweep_interval_seconds=900
            )
            assert skip is True
            assert last_finished is not None
        finally:
            self._cleanup_runs(pg_conn, [run_id])

    def test_old_completed_run_is_not_skipped(self, pg_conn):
        """A genuine multi-hour gap must still sweep immediately — the
        guard's whole point is distinguishing a crash-loop from this."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at, finished_at) "
                "VALUES ('test', 'success', NOW() - INTERVAL '3 hours', "
                "NOW() - INTERVAL '3 hours') RETURNING id"
            )
            run_id = cur.fetchone()[0]
        pg_conn.commit()
        try:
            skip, _last_finished = orchestrator.should_skip_immediate_sweep(
                pg_conn, min_restart_sweep_interval_seconds=900
            )
            assert skip is False
        finally:
            self._cleanup_runs(pg_conn, [run_id])

    def test_a_running_row_is_not_treated_as_a_completion(self, pg_conn):
        """A still-in-progress run (or one _reconcile_stale_runs hasn't
        reconciled yet) must not count as "just completed" — only
        success/partial/failed rows are a real completion signal. Clears
        the table first for a deterministic "no completed row exists"
        baseline, independent of what earlier tests in the suite left
        behind."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM connector_runs")
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at) "
                "VALUES ('test', 'running', NOW()) RETURNING id"
            )
            run_id = cur.fetchone()[0]
        pg_conn.commit()
        try:
            last_finished = orchestrator.last_completed_run_finished_at(pg_conn)
            assert last_finished is None
        finally:
            self._cleanup_runs(pg_conn, [run_id])

    def test_crash_loop_scenario_skips_after_the_first_sweep(self, pg_conn):
        """Acceptance criterion: a container restarting every few seconds
        must sweep once, then skip every subsequent attempt until the
        threshold elapses — not re-sweep every connector's site on every
        restart."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            # Deterministic "nothing has run yet" baseline — otherwise a
            # very recently completed row left by an unrelated test could
            # make run_id_1 itself skip, which isn't what this test means
            # to exercise.
            cur.execute("DELETE FROM connector_runs")
        pg_conn.commit()
        connector = DummyConnector(name="restart-guard-crash-loop")
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            # "Restart" #1: nothing has ever run — sweeps for real.
            run_id_1 = orchestrator.run_all_connectors_respecting_restart_guard(
                pg_conn, trigger="scheduler", min_restart_sweep_interval_seconds=900
            )
            assert run_id_1 is not None
            run_ids.append(run_id_1)
            assert len(connector.scopes_seen) == 1

            # "Restart" #2 and #3, immediately after: this is the crash
            # loop — each simulates a fresh process attempting its
            # startup sweep milliseconds after the last one finished.
            run_id_2 = orchestrator.run_all_connectors_respecting_restart_guard(
                pg_conn, trigger="scheduler", min_restart_sweep_interval_seconds=900
            )
            run_id_3 = orchestrator.run_all_connectors_respecting_restart_guard(
                pg_conn, trigger="scheduler", min_restart_sweep_interval_seconds=900
            )
            assert run_id_2 is None
            assert run_id_3 is None
            # No new discover() calls — the connector's own site was never
            # touched again by either skipped attempt.
            assert len(connector.scopes_seen) == 1

            with pg_conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM connector_runs")
                (total_runs,) = cur.fetchone()
            assert total_runs == 1, (
                "only the first sweep should have created a connector_runs row"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            self._cleanup_runs(pg_conn, run_ids)

    def test_genuine_gap_after_a_crash_loop_sweeps_again(self, pg_conn):
        """Once the threshold genuinely elapses (backdated here rather than
        actually sleeping), the next attempt must sweep — the guard delays,
        it doesn't permanently wedge ingestion."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM connector_runs")
        pg_conn.commit()
        connector = DummyConnector(name="restart-guard-genuine-gap")
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            # Issue #295 (D-050): this test isolates the restart-burst guard,
            # not the freshness cadence — a second scheduler sweep seconds after
            # the first would otherwise be freshness-skipped (the connector is
            # fresh, well inside its default 24h interval). default_freshness_
            # interval_hours=0 makes it always-due, so both genuine sweeps run
            # and the assertion tests the guard alone.
            run_id_1 = orchestrator.run_all_connectors_respecting_restart_guard(
                pg_conn,
                trigger="scheduler",
                min_restart_sweep_interval_seconds=1,
                default_freshness_interval_hours=0,
            )
            assert run_id_1 is not None
            run_ids.append(run_id_1)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE connector_runs SET finished_at = NOW() - INTERVAL '10 seconds' "
                    "WHERE id = %s",
                    (run_id_1,),
                )
            pg_conn.commit()

            run_id_2 = orchestrator.run_all_connectors_respecting_restart_guard(
                pg_conn,
                trigger="scheduler",
                min_restart_sweep_interval_seconds=1,
                default_freshness_interval_hours=0,
            )
            assert run_id_2 is not None
            run_ids.append(run_id_2)
            assert len(connector.scopes_seen) == 2
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            self._cleanup_runs(pg_conn, run_ids)

    def test_named_connector_run_is_never_gated_by_the_guard(self, pg_conn):
        """`ps connector run <name>` is a deliberate, targeted operator
        action, not the unattended-restart scenario this guard exists for
        — etl/main.py never routes it through the guard at all, so
        run_all_connectors (the plain function) stays completely
        unaffected regardless of how recently a run finished."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="restart-guard-named-bypass")
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            run_ids.append(
                orchestrator.run_all_connectors(
                    pg_conn, trigger="cli", connector_name=connector.name
                )
            )
            assert len(connector.scopes_seen) == 2
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            self._cleanup_runs(pg_conn, run_ids)

    def test_future_finished_at_clock_skew_does_not_wedge_the_guard(self, pg_conn):
        """Also-fix (Opus review, PR #175): `elapsed` compares this
        process' `datetime.now(timezone.utc)` against a `finished_at`
        written by Postgres' own `NOW()` — two different clocks. If the
        DB server's clock is ever ahead, `finished_at` lands in this
        process' future and `elapsed` goes negative, which is always
        `< min_restart_sweep_interval_seconds` for any non-negative
        threshold — unclamped, that reads as "a sweep juuust finished"
        and skips, wedging the guard for the duration of the skew. Must
        be clamped to "run" instead, the same safe direction as "no prior
        run"/"guard disabled"."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM connector_runs")
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at, finished_at) "
                "VALUES ('test', 'success', NOW(), NOW() + INTERVAL '1 hour') "
                "RETURNING id"
            )
            run_id = cur.fetchone()[0]
        pg_conn.commit()
        try:
            skip, last_finished = orchestrator.should_skip_immediate_sweep(
                pg_conn, min_restart_sweep_interval_seconds=900
            )
            assert skip is False
            assert last_finished is not None
        finally:
            self._cleanup_runs(pg_conn, [run_id])

    def test_null_finished_at_on_completed_status_does_not_mask_real_completions(
        self, pg_conn
    ):
        """Also-fix (Opus review, PR #175): Postgres\' default `ORDER BY
        ... DESC` sorts NULLs FIRST, not last. A completed-status row
        with a NULL `finished_at` must not outrank a real completion\'s
        actual timestamp and make `last_completed_run_finished_at` return
        None forever — which would permanently disable the guard rather
        than merely miscount one row."""
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM connector_runs")
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at, finished_at) "
                "VALUES ('test', 'success', NOW(), NULL) RETURNING id"
            )
            null_run_id = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at, finished_at) "
                "VALUES ('test', 'success', NOW() - INTERVAL '3 hours', "
                "NOW() - INTERVAL '3 hours') RETURNING id"
            )
            real_run_id = cur.fetchone()[0]
        pg_conn.commit()
        try:
            last_finished = orchestrator.last_completed_run_finished_at(pg_conn)
            assert last_finished is not None, (
                "a NULL finished_at on a completed-status row must not "
                "mask every genuinely completed run"
            )
        finally:
            self._cleanup_runs(pg_conn, [null_run_id, real_run_id])

    def test_wedge_threshold_ge_interval_still_sweeps_on_the_second_iteration(
        self, pg_conn, monkeypatch
    ):
        """Must-fix (Opus review, PR #175): threshold >= interval_seconds
        must not wedge run_scheduler_loop forever. Nothing prevents an
        operator from setting
        etl.min_restart_sweep_interval_seconds >= the hard-coded
        _RUN_INTERVAL_SECONDS=3600 in etl/main.py (config/schema.yaml
        declares no maximum) — measured scenario: threshold=7200 (2h),
        last real completion 1800s ago. Before this fix (guard applied
        every iteration), the first iteration correctly skips, but every
        iteration afterward ALSO sees "last completed run" under the 2h
        threshold forever, since each iteration only advances the clock
        by interval_seconds=1h < 2h — permanently wedging ingestion with
        one WARNING log per hour, exactly what an operator picking "2h to
        be extra safe" would not expect.

        Verifies the fix (guard applies to the first iteration only): the
        first iteration is genuinely skipped, but the second iteration —
        under the identical threshold/elapsed relationship, if it were
        re-evaluated — must sweep for real anyway, because the guard is
        never re-applied past iteration 1. Uses a real second connection
        (not `pg_conn` itself) since `run_scheduler_loop` closes its
        connection every iteration; `time.sleep` is mocked to advance
        exactly two iterations before breaking out via a sentinel
        exception — no real hour-long wait, no infinite loop in the test.
        """
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM connector_runs")
            cur.execute(
                "INSERT INTO connector_runs (trigger, status, started_at, finished_at) "
                "VALUES ('test', 'success', NOW() - INTERVAL '1800 seconds', "
                "NOW() - INTERVAL '1800 seconds')"
            )
        pg_conn.commit()

        connector = DummyConnector(name="restart-guard-wedge")
        orchestrator.CONNECTORS[:] = [connector]

        from etl.config import Config
        from etl.db import postgres

        def _conn_factory():
            return postgres.get_connection(Config())

        class _StopLoop(Exception):
            pass

        sleep_calls: list[int] = []

        def fake_sleep(seconds: int) -> None:
            sleep_calls.append(seconds)
            if len(sleep_calls) >= 2:
                raise _StopLoop()

        monkeypatch.setattr(orchestrator.time, "sleep", fake_sleep)

        try:
            with pytest.raises(_StopLoop):
                orchestrator.run_scheduler_loop(
                    _conn_factory,
                    interval_seconds=3600,
                    min_restart_sweep_interval_seconds=7200,  # >= interval: the wedge
                )
            # Iteration 1: guarded, skipped (elapsed 1800s < 7200s threshold)
            #   -> zero discover() calls.
            # Iteration 2: the guard must NOT reapply -> exactly one real
            #   sweep, proving the loop doesn\'t wedge forever.
            assert len(connector.scopes_seen) == 1, (
                "the second iteration must actually run the connector "
                "sweep — a threshold >= interval_seconds must not wedge "
                "ingestion for the life of the process"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, None)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM connector_runs")
            pg_conn.commit()


class _NamedScopeConnector(DummyConnector):
    """A DummyConnector whose `scope_key` is a readable city name derived
    from the scope's latitude, so a fairness test can assert on *which*
    geography was crawled rather than on an opaque `raw:(40.4, -3.7):10`
    string. Issue #217/D-030.

    Latitude is the discriminator purely because the fixture profiles these
    tests use (Madrid 40.41, Barcelona 41.38, Estepona 36.42) differ there;
    nothing about the fairness mechanism depends on how a real connector
    resolves geography, only that `scope_key()` returns a stable string per
    area and `None` for one it doesn't cover.
    """

    def scope_key(self, scope):
        if scope.center is None:
            return None
        lat = scope.center[0]
        if 40.0 <= lat < 41.0:
            return "madrid"
        if 41.0 <= lat < 42.0:
            return "barcelona"
        if 36.0 <= lat < 37.0:
            return "estepona"
        if 37.0 <= lat < 38.0:
            return "dos-hermanas"
        return None


class _SentinelScopeConnector(_NamedScopeConnector):
    """A `_NamedScopeConnector` that returns issue #177's
    `unresolvable-geography:` SENTINEL — not `None` — for a scope it cannot
    place, which is what every real connector does (see
    `geography.unresolvable_scope_key`).

    `_NamedScopeConnector` returns `None` there, which exercises only the
    "resolved to nothing / no coverage" path. The sentinel is a genuinely
    different third case and the one PR #228's review finding 3 is about.
    """

    def scope_key(self, scope):
        key = super().scope_key(scope)
        if key is None and scope.center is not None:
            return unresolvable_scope_key(scope)
        return key


class _ScopeDiscoverFailsConnector(_NamedScopeConnector):
    """A `_NamedScopeConnector` whose `discover()` raises for the scopes
    whose key is in *broken_keys* and succeeds for every other scope.

    Models the real thing PR #228's review finding 1 is about: a scope that
    is attempted on every run and fails on every run (a soft-block page, a
    parse failure after a site redesign), while its neighbours crawl fine.
    """

    def __init__(self, *, broken_keys: frozenset[str], **kwargs) -> None:
        super().__init__(**kwargs)
        self._broken_keys = broken_keys

    def discover(self, scope, throttle):
        key = self.scope_key(scope)
        if key in self._broken_keys:
            raise ConnectorError(f"simulated permanent discover failure for {key}")
        return super().discover(scope, throttle)


def _scope_state(conn, connector_name: str) -> dict[str, tuple]:
    """{scope_key: (last_attempted_at, last_skipped_for_budget_at)} for one
    connector — the fairness/coverage bookkeeping issue #217 added."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT scope_key, last_attempted_at, last_skipped_for_budget_at "
            "FROM connector_scope_state WHERE connector_name = %s",
            (connector_name,),
        )
        return {row[0]: (row[1], row[2]) for row in cur.fetchall()}


def _result_row(conn, run_id: int, connector_name: str) -> tuple:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, error_msg, skipped_scopes FROM connector_run_results "
            "WHERE run_id = %s AND connector_name = %s",
            (run_id, connector_name),
        )
        return cur.fetchone()


def _scope_row(conn, connector_name: str, scope_key: str) -> dict:
    """Every PR #228-relevant column of one `connector_scope_state` row, as a
    dict — `_scope_state`'s 2-tuple predates `last_discovered_at` and the
    renamed coverage columns and is kept as-is for the tests already using
    it."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT last_attempted_at, last_discovered_at, "
            "last_skipped_for_budget_at, coverage_center_lat, "
            "coverage_center_lon, coverage_radius_km "
            "FROM connector_scope_state "
            "WHERE connector_name = %s AND scope_key = %s",
            (connector_name, scope_key),
        )
        row = cur.fetchone()
    assert row is not None, (
        f"no connector_scope_state row for {connector_name}/{scope_key}"
    )
    return dict(
        zip(
            (
                "last_attempted_at",
                "last_discovered_at",
                "last_skipped_for_budget_at",
                "coverage_center_lat",
                "coverage_center_lon",
                "coverage_radius_km",
            ),
            row,
        )
    )


# The EXACT containment predicate `getAreaCoverage()` runs
# (dashboard/lib/profile-diagnostics.ts). Duplicated here on purpose: the
# whole question PR #228's review finding 2 raises is whether the rows the
# ETL writes make that specific query answer "crawled" for an area nobody
# crawled, and only running the real predicate against the real rows can
# settle it. A Python-side re-implementation of "is it inside the circle"
# would be testing my arithmetic, not the shipped query's.
_COVERAGE_CONTAINMENT_SQL = """
    SELECT connector_name, last_attempted_at, last_discovered_at
      FROM connector_scope_state
     WHERE connector_name = %s
       AND coverage_center_lat IS NOT NULL AND coverage_center_lon IS NOT NULL
       AND (6371 * acos(least(1, greatest(-1,
             cos(radians(%s)) * cos(radians(coverage_center_lat)) *
             cos(radians(coverage_center_lon) - radians(%s)) +
             sin(radians(%s)) * sin(radians(coverage_center_lat))
           )))) <= COALESCE(coverage_radius_km, 0)
"""


def _covering_rows(conn, connector_name: str, lat: float, lon: float) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(_COVERAGE_CONTAINMENT_SQL, (connector_name, lat, lon, lat))
        return cur.fetchall()


def _cleanup_scope_state(conn, connector_name: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM connector_scope_state WHERE connector_name = %s",
            (connector_name,),
        )
    conn.commit()


class TestScopeFairnessRotation:
    """Issue #217 / D-030: the circuit breaker's error budget is shared
    across every scope in a connector's run (issue #71, deliberate), and a
    soft-blocking connector reliably exhausts it during the FIRST scope. With
    `scopes` in a fixed order, every later scope was skipped on every run —
    not "rarely reached", never. The owner's "Pisos en Estepona" profile sat
    at 0 candidates indefinitely, nearest property 112.5 km away, while the
    run reported `circuit_open` (which reads as a connector problem, not "we
    never looked at your area").
    """

    def _add_profile(
        self, conn, name: str, lat: float, lon: float, radius_km: float = 10
    ) -> int:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    name,
                    json.dumps(
                        {
                            "geography": {
                                "type": "radius",
                                "center": [lat, lon],
                                "radius_km": radius_km,
                            }
                        }
                    ),
                ),
            )
            (profile_id,) = cur.fetchone()
        conn.commit()
        return profile_id

    def _drop_profile(self, conn, profile_id: int) -> None:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
        conn.commit()

    def test_scope_starved_by_an_open_breaker_is_attempted_on_the_following_run(
        self, pg_conn
    ):
        """THE acceptance criterion (#217, first bullet): with the breaker
        opening during scope 1, scope 2 must be attempted on the FOLLOWING
        run, with no manual intervention.

        Before D-030 this test's second `run_all_connectors` call crawled
        madrid again — exactly as the first did, and as every run forever
        would — because `scopes` came back in the same fixed order and the
        breaker tripped in the same place every time. Barcelona's
        `discover()` was never called, ever.
        """
        _apply_schema(pg_conn)
        # Fixture profile is Madrid (40.4168); add Barcelona so the
        # connector has two distinct scopes to be fair between.
        barcelona_id = self._add_profile(pg_conn, "fairness-barcelona", 41.3851, 2.1734)

        # 10 ids, every other one failing (50% > the 30% threshold) with
        # min_attempts=2 — trips the shared breaker well inside the FIRST
        # scope's own fetch loop, which is precisely Fotocasa's real
        # volume-cumulative soft-block behaviour.
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = _NamedScopeConnector(
            name="test-fairness-rotation",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            first_run_keys = [connector.scope_key(s) for s in connector.scopes_seen]
            # Exactly one scope reached discover(); the breaker ate the rest.
            assert first_run_keys == ["madrid"], (
                "run 1 should crawl exactly the first-ordered scope before "
                f"the breaker trips, got {first_run_keys}"
            )

            connector.scopes_seen.clear()
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            second_run_keys = [connector.scope_key(s) for s in connector.scopes_seen]

            # The whole fix: barcelona — starved on run 1 — goes FIRST on
            # run 2, without anyone touching anything.
            assert second_run_keys == ["barcelona"], (
                "the scope starved by run 1's open breaker must be the one "
                f"attempted on run 2, got {second_run_keys}"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            for rid in run_ids:
                _cleanup(pg_conn, connector.name, rid)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, barcelona_id)

    def test_a_new_profiles_geography_is_crawled_within_the_stated_bound(self, pg_conn):
        """#217's second bullet: a newly-created profile in an uncrawled
        geography gets data within a BOUNDED number of runs — D-030 states
        that bound as U + 1, where U is the number of *other* never-attempted
        scopes for that connector at creation time.

        This is the reported incident's exact shape: one connector already
        crawling one city, owner adds a profile for a genuinely covered new
        market (estepona), U = 0, so the bound is exactly 1 run. Asserted as
        a hard upper bound, not as "eventually".
        """
        _apply_schema(pg_conn)
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = _NamedScopeConnector(
            name="test-fairness-bound",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids = []
        estepona_id = None
        try:
            # Run 0: only the Madrid fixture profile exists — it gets crawled,
            # so every scope this connector knows about has now had a turn.
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert [connector.scope_key(s) for s in connector.scopes_seen] == ["madrid"]

            # The owner now creates the new-market profile. U = 0.
            estepona_id = self._add_profile(
                pg_conn, "fairness-estepona", 36.4253, -5.1453
            )
            connector.scopes_seen.clear()

            # Bound = U + 1 = 1 run.
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            crawled = [connector.scope_key(s) for s in connector.scopes_seen]
            assert "estepona" in crawled, (
                "a new profile in a covered geography must be crawled within "
                f"U+1 = 1 run of creation; run crawled {crawled}"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            for rid in run_ids:
                _cleanup(pg_conn, connector.name, rid)
            _cleanup_scope_state(pg_conn, connector.name)
            if estepona_id is not None:
                self._drop_profile(pg_conn, estepona_id)

    def test_skipped_for_budget_is_distinguishable_from_uncovered_geography(
        self, pg_conn
    ):
        """#217's third bullet: `connector_run_results` must let a consumer
        tell "we ran out of budget before reaching your geography" from "this
        connector doesn't cover your geography at all". Both used to produce
        simply no data and no message.

        Asserted on the STRUCTURED column, not the prose: a consumer that has
        to string-match `error_msg` to answer this hasn't really been given
        the distinction.
        """
        _apply_schema(pg_conn)
        barcelona_id = self._add_profile(pg_conn, "fairness-bcn-2", 41.3851, 2.1734)
        # lat 50.1 -> _NamedScopeConnector.scope_key returns None: genuinely
        # uncovered, the issue #177 case this must NOT be confused with.
        uncovered_id = self._add_profile(pg_conn, "fairness-uncovered", 50.1, 8.6)

        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = _NamedScopeConnector(
            name="test-fairness-reasons",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            status, error_msg, skipped_scopes = _result_row(
                pg_conn, run_id, connector.name
            )
            assert status == "circuit_open"

            by_reason: dict[str, list[str]] = {}
            for entry in skipped_scopes or []:
                by_reason.setdefault(entry["reason"], []).append(entry["scope"])

            # Barcelona IS covered — it just never got its turn.
            assert by_reason.get("budget") == ["barcelona"], (
                "a covered geography that never got its turn must be "
                f"recorded as reason=budget, got {skipped_scopes}"
            )
            # The lat=50 profile is a different animal entirely and must not
            # be blamed on the budget — more budget would not have helped it.
            uncovered = by_reason.get("uncovered", [])
            assert len(uncovered) == 1, (
                f"the uncovered scope must be recorded separately, got {skipped_scopes}"
            )
            assert "barcelona" not in uncovered
            # The prose stays too — an operator reading logs still gets it.
            # Issue #270 (D-047): budget skips are now surfaced as a clean
            # informational NOTE (prefixed "nota:") rather than error prose,
            # in Spanish to match the operator-facing UI ("no se cargaron más
            # ... por presupuesto"). The structured skipped_scopes above is the
            # real contract; this just confirms the human-readable note is there.
            assert "presupuesto" in error_msg
            assert "nota:" in error_msg
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, barcelona_id)
            self._drop_profile(pg_conn, uncovered_id)

    def test_budget_skipped_scope_is_recorded_as_covered_but_never_attempted(
        self, pg_conn
    ):
        """#217's fourth bullet needs a DATA source, not just a log line: the
        zero-candidate diagnostic (#194) asks "has this area been crawled?"
        from the dashboard, which cannot run any connector's Python-side
        geography resolution.

        `connector_scope_state` answers it: a row with a NULL
        `last_attempted_at` means "covered, but has never had its turn"; no
        row at all means "no connector covers this". The scope's own
        center/radius is stored so a lat/lon-only consumer can do the
        containment test.
        """
        _apply_schema(pg_conn)
        barcelona_id = self._add_profile(pg_conn, "fairness-bcn-3", 41.3851, 2.1734)
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = _NamedScopeConnector(
            name="test-fairness-coverage-row",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            state = _scope_state(pg_conn, connector.name)

            assert "madrid" in state and state["madrid"][0] is not None, (
                "the scope that was actually crawled must carry a real "
                f"last_attempted_at, got {state}"
            )
            assert "barcelona" in state, (
                "a covered-but-starved scope must still get a row — without "
                "one it is indistinguishable from an uncovered geography"
            )
            attempted_at, skipped_at = state["barcelona"]
            assert attempted_at is None, (
                "a scope that never reached discover() must NOT claim to "
                "have been attempted"
            )
            assert skipped_at is not None, (
                "a scope passed over because the breaker was open must "
                "record when that happened"
            )

            # The coverage columns the dashboard's containment query needs.
            # PR #228 review, finding 2: these describe what the connector
            # CRAWLS (the resolved municipality's own centroid, plus a
            # conservative extent), not the profile's search circle — see
            # `_scope_coverage_columns`. Barcelona's gazetteer centroid is
            # (41.38879, 2.15899), a little off the profile's (41.3851,
            # 2.1734), which is exactly the point: the profile's numbers are
            # no longer what gets stored.
            row = _scope_row(pg_conn, connector.name, "barcelona")
            assert row["coverage_center_lat"] == pytest.approx(41.38879)
            assert row["coverage_center_lon"] == pytest.approx(2.15899)
            assert row["coverage_radius_km"] == pytest.approx(
                orchestrator._MUNICIPAL_COVERAGE_RADIUS_KM
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, barcelona_id)

    def test_a_null_last_attempted_at_row_does_not_break_scope_ordering(self, pg_conn):
        """Regression guard for the specific crash the covered-but-skipped
        row introduces if `_order_scopes_by_fairness` reads it naively: a
        NULL `last_attempted_at` coming back from the DB puts `None` in the
        sort dict, and `sorted()` raises TypeError comparing None to a
        datetime — taking down the whole sweep for every connector.

        The scope must also KEEP its never-attempted priority (a NULL is
        semantically "never attempted", not "attempted at the epoch").
        """
        _apply_schema(pg_conn)
        connector = _NamedScopeConnector(name="test-fairness-null-row")
        # TWO scopes are essential here, not one: `sorted()` on a
        # single-element list never compares anything, so a one-scope
        # version of this test passes even with the NULL guard removed.
        # Barcelona carries the covered-but-skipped row (NULL
        # last_attempted_at); Madrid carries a real timestamp — so the sort
        # is forced to compare the two.
        barcelona_id = self._add_profile(pg_conn, "fairness-bcn-null", 41.3851, 2.1734)
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_scope_state (connector_name, scope_key, "
                "last_attempted_at, last_skipped_for_budget_at) "
                "VALUES (%s, %s, NULL, NOW())",
                (connector.name, "barcelona"),
            )
            cur.execute(
                "INSERT INTO connector_scope_state (connector_name, scope_key, "
                "last_attempted_at) VALUES (%s, %s, NOW())",
                (connector.name, "madrid"),
            )
        pg_conn.commit()
        try:
            scopes = orchestrator._active_profile_scopes(pg_conn)
            ordered = orchestrator._order_scopes_by_fairness(pg_conn, connector, scopes)
            # Barcelona (NULL = never attempted) must sort AHEAD of Madrid
            # (genuinely attempted just now).
            assert [connector.scope_key(s) for s in ordered] == [
                "barcelona",
                "madrid",
            ], (
                "a NULL last_attempted_at must be treated as never-attempted "
                "(front of the queue), not crash the sort"
            )
        finally:
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, barcelona_id)

    def test_budget_skipped_scopes_block_withdrawal_reconciliation(self, pg_conn):
        """A scope skipped for budget was never attempted at ALL — not even a
        failed discover(), which at least tries. Reconciling withdrawal
        against a union missing its listings would withdraw live inventory,
        exactly the hazard `_reconcile_missed_discoveries` already documents
        for a genuinely failed scope.

        Latent before D-030 (the breaker-tripped branch set
        `any_circuit_open` but never touched `reconcilable_union`), and
        masked only because Fotocasa sets `discovers_full_inventory=False`.
        Rotation makes "some scope gets skipped for budget" the NORMAL
        outcome of every run, so this stops being theoretical.
        """
        _apply_schema(pg_conn)
        barcelona_id = self._add_profile(pg_conn, "fairness-bcn-4", 41.3851, 2.1734)
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = _NamedScopeConnector(
            name="test-fairness-reconcile",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
            discovers_full_inventory=True,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        calls = []
        real = orchestrator._reconcile_missed_discoveries
        orchestrator._reconcile_missed_discoveries = lambda *a, **k: calls.append(a)
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert calls == [], (
                "withdrawal reconciliation must not run against a union "
                "missing every skipped-for-budget scope's listings"
            )
        finally:
            orchestrator._reconcile_missed_discoveries = real
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, barcelona_id)


class TestScopeCoverageClaims:
    """PR #228 review, findings 1-3 and nits 5-6.

    Issue #217's fairness rotation is sound; what these tests pin down is
    the DIAGNOSTIC layer built on top of it, which asserted things the
    stored data does not support. In its worst form it told the user "esta
    zona se rastreo por ultima vez el <fecha>" about an area no connector
    had ever successfully crawled — the exact misdiagnosis #217 was filed
    about, re-introduced through the feature meant to cure it.

    Everything here follows one rule: a coverage claim shown to a user must
    be one the ETL can actually vouch for, and every uncertainty resolves
    toward claiming LESS coverage, never more.
    """

    _add_profile = TestScopeFairnessRotation._add_profile
    _drop_profile = TestScopeFairnessRotation._drop_profile

    def test_an_always_failing_scope_is_attempted_but_never_recorded_as_crawled(
        self, pg_conn
    ):
        """Finding 1. `last_attempted_at` is written BEFORE `run_connector`
        and UNCONDITIONALLY — correct for fairness (a permanently-failing
        scope must not keep winning the front of the queue), and precisely
        why it cannot also carry the coverage claim.

        A scope whose `discover()` raises on every run must therefore end up
        with a real `last_attempted_at` (so rotation still works) and a NULL
        `last_discovered_at` (so nothing can report it as crawled). Its
        healthy neighbour in the same run must get both.
        """
        _apply_schema(pg_conn)
        barcelona_id = self._add_profile(pg_conn, "cov-bcn-fail", 41.3851, 2.1734)
        connector = _ScopeDiscoverFailsConnector(
            name="test-coverage-failing-scope",
            broken_keys=frozenset({"madrid"}),
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            broken = _scope_row(pg_conn, connector.name, "madrid")
            assert broken["last_attempted_at"] is not None, (
                "a failing scope must still count as attempted, or it wins "
                "the front of the fairness queue forever (the U+1 bound "
                "depends on this)"
            )
            assert broken["last_discovered_at"] is None, (
                "discover() raised for this scope — nothing may record it "
                "as successfully crawled, because the dashboard renders "
                "that as 'esta zona se rastreo el <fecha>' and 'no hay "
                "resultados' is then read as a real statement about real "
                "inventory"
            )

            healthy = _scope_row(pg_conn, connector.name, "barcelona")
            assert healthy["last_attempted_at"] is not None
            assert healthy["last_discovered_at"] is not None, (
                "a scope whose discover() genuinely succeeded MUST be "
                "recorded as crawled — otherwise the fix just suppresses "
                "the signal instead of making it truthful"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, barcelona_id)

    def test_a_far_away_area_is_not_claimed_covered_by_a_wide_radius_profile(
        self, pg_conn
    ):
        """Finding 2, reproducing the reviewer's exact scenario.

        A Dos Hermanas profile at `radius_km=120` (well inside the 200 km
        the profile schema allows) used to store a 120 km disc as its
        coverage circle, because the row recorded the PROFILE's search
        radius. `radius_km` never widens what is crawled — `resolve_place`
        -> `nearest_place` only uses it to TIGHTEN the match ceiling — so
        the connector crawled exactly one municipality while the row claimed
        a disc reaching 120 km in every direction.

        `getAreaCoverage(Estepona)` therefore answered "crawled" for
        Estepona: 117.8 km away, never crawled by anyone, and the very
        profile issue #217 was filed about. The user was told their area had
        been crawled and was genuinely empty.

        Asserted by running the shipped containment predicate itself
        (`_COVERAGE_CONTAINMENT_SQL`) against the rows a real run writes.
        """
        _apply_schema(pg_conn)
        # The incident's own geography, at the incident's own radius.
        dh_id = self._add_profile(
            pg_conn, "cov-dos-hermanas", 37.28287, -5.92088, radius_km=120
        )
        connector = _NamedScopeConnector(name="test-coverage-wide-radius")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            row = _scope_row(pg_conn, connector.name, "dos-hermanas")
            assert row["last_discovered_at"] is not None, (
                "precondition: this scope really was crawled this run"
            )
            # Positive control first: the predicate does find the area that
            # WAS crawled. Without it, the assertion below would also pass
            # if coverage were broken outright.
            assert _covering_rows(pg_conn, connector.name, 37.28287, -5.92088), (
                "the containment predicate must still report the "
                "municipality that was actually crawled"
            )

            # The regression itself: Estepona, 117.8 km from Dos Hermanas.
            # Asserted BEFORE the column-level checks below so a regression
            # surfaces as the user-visible claim it is, not as a number.
            assert _covering_rows(pg_conn, connector.name, 36.42764, -5.14589) == [], (
                "Estepona is 117.8 km from the only municipality crawled and "
                "was never looked at — no row may let the diagnostic claim "
                "it was covered"
            )

            assert row["coverage_radius_km"] != pytest.approx(120.0), (
                "the profile's 120 km search radius must never be stored as "
                "a coverage circle — it describes which listings MATCH, not "
                "what was crawled"
            )
            assert row["coverage_radius_km"] == pytest.approx(
                orchestrator._MUNICIPAL_COVERAGE_RADIUS_KM
            )
            # The resolved municipality's own centroid, not the profile's
            # center (identical here because the profile was pinned on the
            # gazetteer entry — the radius is what discriminates).
            assert row["coverage_center_lat"] == pytest.approx(37.28287)
            assert row["coverage_center_lon"] == pytest.approx(-5.92088)
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, dh_id)

    def test_unresolvable_scope_behind_the_breaker_cut_is_not_called_a_budget_skip(
        self, pg_conn
    ):
        """Finding 3. The classify loop branched only on `scope_key() is
        None`, so a scope returning issue #177's `unresolvable-geography:`
        sentinel fell through to `budget`.

        Two things went wrong from there. `skipped_scopes` said "budget",
        i.e. "more budget would have helped" — it never will, `discover()`
        raises for this scope on every run by construction. And the
        `connector_scope_state` row it wrote (NULL `last_attempted_at`) made
        the dashboard promise the user "esta zona si esta cubierta, todavia
        no le ha tocado el turno" for a profile centre matching no place in
        the gazetteer at all — burying the one thing #177's sentinel exists
        to surface.
        """
        _apply_schema(pg_conn)
        # (50.1, 8.6) is Frankfurt — no Spanish gazetteer entry within
        # range, so a real connector's scope_key() returns the sentinel.
        bad_id = self._add_profile(pg_conn, "cov-unresolvable", 50.1, 8.6)
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = _SentinelScopeConnector(
            name="test-coverage-sentinel",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            _status, error_msg, skipped_scopes = _result_row(
                pg_conn, run_id, connector.name
            )
            sentinel_entries = [
                entry
                for entry in (skipped_scopes or [])
                if entry["scope"].startswith("unresolvable-geography:")
            ]
            assert sentinel_entries, (
                "precondition: the unresolvable scope sat behind the "
                f"breaker cut and was classified — got {skipped_scopes!r}, "
                f"error_msg={error_msg!r}"
            )
            assert [e["reason"] for e in sentinel_entries] == ["unresolvable"], (
                "an unresolvable geography is not a budget casualty: more "
                "budget would never have helped it, and calling it one "
                "sends the operator chasing a crawl that will never run"
            )

            state = _scope_state(pg_conn, connector.name)
            assert not [k for k in state if k.startswith("unresolvable-geography:")], (
                "an unresolvable scope must get NO connector_scope_state "
                "row — a row with a NULL last_attempted_at is precisely how "
                "the dashboard says 'covered, awaiting its turn', which is "
                "the opposite of true here"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, bad_id)

    def test_two_starved_scopes_sharing_a_key_are_reported_once(self, pg_conn):
        """Nit 5. The classify loop read `seen_scope_keys` but never added
        to it, so two un-reached scopes resolving to the same key were each
        appended — duplicated in `skipped_scopes`, duplicated in the
        `error_msg` prose, and `_record_scope_covered_but_skipped` called
        twice for one target.
        """
        _apply_schema(pg_conn)
        # Two distinct profiles (they survive `_active_profile_scopes`' 4dp
        # dedup) that both resolve to the same connector scope_key.
        bcn_a = self._add_profile(pg_conn, "cov-dup-a", 41.3851, 2.1734)
        bcn_b = self._add_profile(pg_conn, "cov-dup-b", 41.3901, 2.1801)
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = _NamedScopeConnector(
            name="test-coverage-dup-key",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            _status, error_msg, skipped_scopes = _result_row(
                pg_conn, run_id, connector.name
            )
            budget = [
                e["scope"]
                for e in (skipped_scopes or [])
                if e["reason"] == "budget" and e["scope"] == "barcelona"
            ]
            assert budget == ["barcelona"], (
                "two starved scopes resolving to one key are one starved "
                f"target, reported once — got {skipped_scopes!r}"
            )
            assert (error_msg or "").count("barcelona") == 1, (
                f"the prose must not repeat it either — got {error_msg!r}"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, bcn_a)
            self._drop_profile(pg_conn, bcn_b)

    def test_a_failing_scope_attempt_write_does_not_kill_the_whole_sweep(
        self, pg_conn, monkeypatch
    ):
        """Nit 6. `_record_scope_attempt` is a DB write that used to sit
        OUTSIDE the per-scope `try`. If it raised — e.g. the connection left
        in a failed-transaction state by an earlier scope's DB error, which
        the generic handler did not roll back — it propagated out of the
        per-connector loop and killed the sweep for EVERY connector.

        That is strictly wider than the blast radius before this call
        existed, when the first DB touch after that handler was inside
        `run_connector` and therefore contained per scope. A second,
        entirely healthy connector must still run.
        """
        _apply_schema(pg_conn)
        broken = _NamedScopeConnector(name="test-coverage-blast-broken")
        healthy = _NamedScopeConnector(name="test-coverage-blast-healthy")
        orchestrator.CONNECTORS[:] = [broken, healthy]

        real_record = orchestrator._record_scope_attempt

        def _explode(conn, connector_name, *args, **kwargs):
            if connector_name == broken.name:
                raise RuntimeError("simulated failed-transaction state")
            return real_record(conn, connector_name, *args, **kwargs)

        monkeypatch.setattr(orchestrator, "_record_scope_attempt", _explode)
        run_id = None
        try:
            # Must not raise: the failure belongs to one scope of one
            # connector, not to the sweep.
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert _result_row(pg_conn, run_id, healthy.name) is not None, (
                "a DB failure while recording one connector's scope attempt "
                "must not stop every LATER connector from running at all"
            )
            broken_row = _result_row(pg_conn, run_id, broken.name)
            assert broken_row is not None and broken_row[0] == "failed", (
                "the connector whose write failed must still be recorded, "
                f"and recorded as failed — got {broken_row!r}"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, broken.name, run_id)
            _cleanup(pg_conn, healthy.name, None)
            _cleanup_scope_state(pg_conn, broken.name)
            _cleanup_scope_state(pg_conn, healthy.name)


def _result_full_row(conn, run_id: int, connector_name: str) -> dict:
    """status / error_count / fetched_count / error_msg / skipped_scopes for one
    connector_run_results row (issue #270, D-047 status-reclassification tests)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, error_count, fetched_count, error_msg, skipped_scopes "
            "FROM connector_run_results WHERE run_id = %s AND connector_name = %s",
            (run_id, connector_name),
        )
        status, error_count, fetched_count, error_msg, skipped_scopes = cur.fetchone()
    return {
        "status": status,
        "error_count": error_count,
        "fetched_count": fetched_count,
        "error_msg": error_msg,
        "skipped_scopes": skipped_scopes,
    }


def _run_counts(conn, run_id: int) -> tuple[int, int, int]:
    """(connectors_ok, connectors_failed, connectors_skipped) for a run — the
    run-level rollup a budget stop must NOT inflate as a failure."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT connectors_ok, connectors_failed, connectors_skipped "
            "FROM connector_runs WHERE id = %s",
            (run_id,),
        )
        return cur.fetchone()


class _UncoveredConnector(DummyConnector):
    """A connector with NO coverage anywhere — `scope_key` always returns None,
    modelling Milanuncios on a Costa del Sol center it resolves but cannot
    serve (issue #270's "resolved but uncovered"). Every scope must be a clean
    skip with a reason, never a failure."""

    def scope_key(self, scope):
        return None


class TestSoftBlockCleanOutcomes:
    """Issue #270 (D-047): the owner's principle — "waiting for budget is NOT
    an error, it's a clean run outcome". A connector that ingested fine but
    stopped because it hit a soft-block / rate cap, or skipped scopes it could
    not serve, must record a CLEAN status with an informational notice — not
    'failed'/'circuit_open', and not inflate error/failed counts. Only genuine
    FATAL fetch/parse failures surface as errors (their root cause is #291)."""

    def _add_profile(self, conn, name, lat, lon, radius_km=10):
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s) RETURNING id",
                (
                    name,
                    json.dumps(
                        {
                            "geography": {
                                "type": "radius",
                                "center": [lat, lon],
                                "radius_km": radius_km,
                            }
                        }
                    ),
                ),
            )
            (profile_id,) = cur.fetchone()
        conn.commit()
        return profile_id

    def _drop_profile(self, conn, profile_id):
        with conn.cursor() as cur:
            cur.execute("DELETE FROM search_profile WHERE id = %s", (profile_id,))
        conn.commit()

    def test_soft_block_breaker_trip_is_a_clean_ok_run_not_an_error(self, pg_conn):
        """THE owner-requested test: a run that ingested fine and then stopped
        because the site rate-throttled it (soft-block breaker trip) is CLEAN.

        - status is 'ok' (NOT 'circuit_open'/'failed')
        - the run's connectors_failed count does not include it
        - error_count STILL counts the soft-block fetch failures (they are
          genuine failed fetches, tracked for #291) — a clean status and a
          non-zero error_count coexist by design
        - an informational budget notice is present

        Revert-and-confirm-fail: before D-047 a breaker trip always produced
        status 'circuit_open', so the `status == "ok"` assertion pins the new
        behaviour — reverting the classification flips it straight back.
        """
        _apply_schema(pg_conn)
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = DummyConnector(
            name="test-softblock-clean",
            external_ids=external_ids,
            # Odd ids soft-block; with min_attempts=2 the breaker trips on a
            # soft-block early in the single (madrid) scope after real fetches.
            soft_block_ids=frozenset(external_ids[1::2]),
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _result_full_row(pg_conn, run_id, connector.name)
            assert row["status"] == "ok", (
                "a soft-block (rate-throttle) stop is a clean budget outcome, "
                f"not an error state — got {row['status']}"
            )
            assert row["fetched_count"] >= 1, (
                "it should have ingested before backing off"
            )
            assert row["error_count"] >= 1, (
                "soft-block fetch failures are still genuine failed fetches and "
                "must be counted in error_count (tracked for #291)"
            )
            assert row["error_msg"] and "nota:" in row["error_msg"], (
                f"a budget notice must be present, got {row['error_msg']!r}"
            )
            ok, failed, _skipped = _run_counts(pg_conn, run_id)
            assert failed == 0, "a budget stop must not count as a failed connector"
            assert ok == 1
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)

    def test_fatal_breaker_trip_still_surfaces_as_circuit_open(self, pg_conn):
        """Contrast/guard: a breaker trip driven by GENUINE fatal fetch failures
        is a real problem and MUST still surface as 'circuit_open' — the clean
        soft-block reclassification must not silence genuine failures."""
        _apply_schema(pg_conn)
        external_ids = tuple(f"dummy-{i}" for i in range(10))
        connector = DummyConnector(
            name="test-fatal-trip",
            external_ids=external_ids,
            failing_ids=frozenset(external_ids[1::2]),  # fatal ConnectorError
            circuit_breaker_min_attempts=2,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _result_full_row(pg_conn, run_id, connector.name)
            assert row["status"] == "circuit_open", (
                f"a fatal-error breaker trip must surface, got {row['status']}"
            )
            _ok, failed, _sk = _run_counts(pg_conn, run_id)
            assert failed == 1
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)

    def test_soft_block_at_discover_is_clean_not_failed(self, pg_conn):
        """Milanuncios' discover-time GeeTest wall: a SoftBlockError raised by
        discover() is the site rate-throttling us — a clean 'waited for budget'
        backoff, NOT a connector failure. Must be status 'ok' with a
        soft_block-reason skipped scope, never 'failed'."""
        _apply_schema(pg_conn)
        connector = DiscoverSoftBlocksConnector()
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _result_full_row(pg_conn, run_id, connector.name)
            assert row["status"] == "ok", (
                "a discover() soft-block is a clean backoff, not a failure — "
                f"got {row['status']}"
            )
            assert row["error_count"] == 0
            reasons = {e["reason"] for e in (row["skipped_scopes"] or [])}
            assert "soft_block" in reasons, (
                f"the soft-blocked scope must be recorded with a soft_block "
                f"reason, got {row['skipped_scopes']}"
            )
            assert row["error_msg"] and "nota:" in row["error_msg"]
            _ok, failed, _sk = _run_counts(pg_conn, run_id)
            assert failed == 0
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)

    def test_resolved_but_uncovered_scope_is_a_clean_skip_not_failed(self, pg_conn):
        """Issue #270 point 4: a scope a connector genuinely cannot serve
        (Milanuncios on a Costa del Sol center) is a clean skip with a reason,
        NOT 'failed'. `discover()` is never called; the run stays 'ok'."""
        _apply_schema(pg_conn)
        estepona_id = self._add_profile(pg_conn, "softblock-estepona", 36.4268, -5.1468)
        connector = _UncoveredConnector(name="test-uncovered-clean")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _result_full_row(pg_conn, run_id, connector.name)
            assert row["status"] == "ok", (
                f"a genuinely uncovered scope is a clean skip, not a failure — "
                f"got {row['status']}"
            )
            assert row["error_count"] == 0
            assert connector.fetch_calls == [], "discover/fetch must never run"
            reasons = {e["reason"] for e in (row["skipped_scopes"] or [])}
            assert reasons == {"uncovered"}, (
                f"every scope must be recorded uncovered, got {row['skipped_scopes']}"
            )
            _ok, failed, _sk = _run_counts(pg_conn, run_id)
            assert failed == 0
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)
            self._drop_profile(pg_conn, estepona_id)


class TestListingGoneReclassification:
    """Issue #291: a discovered listing whose detail fetch returns HTTP
    404/410 (removed at the source between discovery and fetch) is normal
    inventory churn — the orchestrator must count it as a clean skip, NOT as
    one of the persistent per-scope `errors` the issue reports. A genuine
    fetch/parse failure still counts as an error, and a WHOLESALE break
    (every fetch 404s) must still trip the shared circuit breaker so the run
    doesn't silently fetch nothing while reporting error_count=0.
    """

    def test_gone_listing_is_a_clean_skip_not_an_error(self, pg_conn):
        _apply_schema(pg_conn)
        # 3 discovered: one is gone (HTTP 404), two fetch fine.
        connector = DummyConnector(
            name="test-gone-connector",
            external_ids=("keep-0", "gone-1", "keep-2"),
            gone_ids=frozenset({"gone-1"}),
            circuit_breaker_min_attempts=10,  # don't trip; isolate the reclassification
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, discovered_count, fetched_count, error_count "
                    "FROM connector_run_results WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                result_row = cur.fetchone()
            # error_count is 0 — the gone listing did NOT inflate it. This is
            # the exact regression the issue is about (errors=7..10 on every
            # otherwise-healthy scope).
            assert result_row == ("ok", 3, 2, 0)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_runs WHERE id = %s", (run_id,)
                )
                (run_status,) = cur.fetchone()
            assert run_status == "success"

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT external_id FROM listing WHERE source = %s ORDER BY external_id",
                    (connector.name,),
                )
                persisted = [row[0] for row in cur.fetchall()]
            # The gone listing was never persisted; the other two were.
            assert persisted == ["keep-0", "keep-2"]
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)

    def test_gone_and_genuine_error_are_counted_separately(self, pg_conn):
        """A gone listing (404) and a genuine fetch failure in the same scope
        must not be conflated: only the genuine one shows up in error_count.
        """
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="test-gone-plus-error",
            external_ids=("ok-0", "gone-1", "fail-2"),
            gone_ids=frozenset({"gone-1"}),
            failing_ids=frozenset({"fail-2"}),
            circuit_breaker_min_attempts=10,  # don't trip
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, discovered_count, fetched_count, error_count "
                    "FROM connector_run_results WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                result_row = cur.fetchone()
            # discovered=3, fetched=1 (ok-0), gone=1 (not counted), error=1 (fail-2).
            assert result_row == ("ok", 3, 1, 1)
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)

    def test_run_connector_reports_gone_count_and_omits_it_from_errors(self, pg_conn):
        """Unit-level: run_connector's summary dict exposes gone_count so the
        distinction is testable and loggable, and error_count excludes it."""
        _apply_schema(pg_conn)
        connector = DummyConnector(
            name="test-gone-summary",
            external_ids=("g-0", "g-1", "ok-2"),
            gone_ids=frozenset({"g-0", "g-1"}),
            circuit_breaker_min_attempts=10,
        )
        limiter = orchestrator.RateLimiter(connector.rate_limit_per_minute)
        breaker = orchestrator.CircuitBreaker(
            connector.circuit_breaker_error_rate,
            connector.circuit_breaker_min_attempts,
            window=connector.circuit_breaker_window,
        )
        try:
            result = orchestrator.run_connector(
                pg_conn,
                connector,
                orchestrator.ConnectorScope(geography="x"),
                limiter,
                breaker,
            )
            assert result["gone_count"] == 2
            assert result["error_count"] == 0
            assert result["fetched_count"] == 1
        finally:
            _cleanup(pg_conn, connector.name)

    def test_wholesale_gone_still_trips_the_circuit_breaker(self, pg_conn):
        """A total detail-path break (every fetch 404s) must NOT silently
        report a clean run: because 'gone' still records a breaker error, the
        shared circuit breaker trips exactly as it would for any other
        site-wide failure — the run's status is circuit_open, not ok. This is
        the safety net that keeps reclassifying 404s from masking a genuine
        outage."""
        _apply_schema(pg_conn)
        external_ids = tuple(f"gone-{i}" for i in range(10))
        connector = DummyConnector(
            name="test-all-gone",
            external_ids=external_ids,
            gone_ids=frozenset(external_ids),
            circuit_breaker_min_attempts=2,  # trip quickly once the rate is high
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
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


def _classification_row(conn, run_id: int, connector_name: str) -> dict:
    """failure_classification + geography_scope for one connector_run_results
    row (issues #242 + #109, D-079)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT failure_classification, geography_scope, status "
            "FROM connector_run_results "
            "WHERE run_id = %s AND connector_name = %s",
            (run_id, connector_name),
        )
        failure_classification, geography_scope, status = cur.fetchone()
    return {
        "failure_classification": failure_classification,
        "geography_scope": geography_scope,
        "status": status,
    }


class _RaisingDiscoverConnector(DummyConnector):
    """A connector whose discover() raises a caller-chosen exception on every
    scope — lets one test parametrise the fatal-classification taxonomy
    (network / structure_change / other) end-to-end through the orchestrator."""

    def __init__(self, name: str, exc: Exception) -> None:
        super().__init__(name=name)
        self._exc = exc

    def discover(self, scope, throttle):
        self.scopes_seen.append(scope)
        raise self._exc


class TestFailureClassificationAndGeographyScope:
    """Issues #242 (typed failure_classification) + #109 (geography_scope),
    D-079 — proven end-to-end into Postgres, since both are written at the
    _record_connector_result call site and only a real round-trip catches a
    wrong column order / bad JSON / missing value."""

    def test_clean_run_with_data_has_null_classification_and_crawled_scope(
        self, pg_conn
    ):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-clean-classify")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _classification_row(pg_conn, run_id, connector.name)
            assert row["status"] == "ok"
            # A clean run that ingested data carries NO failure signal.
            assert row["failure_classification"] is None
            # #109: the geography it actually ran against is auditable, with the
            # exact center/radius from the fixture profile and a 'crawled'
            # outcome (it discovered 3 dummy listings).
            geo = row["geography_scope"]
            assert geo and isinstance(geo, list)
            crawled = [g for g in geo if g["outcome"] == "crawled"]
            assert crawled, f"expected a crawled scope, got {geo}"
            assert crawled[0]["center"] == [40.4168, -3.7038]
            assert crawled[0]["radius_km"] == 10
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)

    def test_empty_result_run_is_classified_empty_result(self, pg_conn):
        _apply_schema(pg_conn)
        # Discovers nothing, but the scope resolved and discover() ran cleanly.
        connector = DummyConnector(name="test-empty-classify", external_ids=())
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _classification_row(pg_conn, run_id, connector.name)
            assert row["status"] == "ok"
            assert row["failure_classification"] == "empty_result"
            outcomes = {g["outcome"] for g in (row["geography_scope"] or [])}
            assert outcomes == {"empty"}, row["geography_scope"]
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)

    @pytest.mark.parametrize(
        "message, expected_kind",
        [
            ("Connection timeout after 60s", "network"),
            ("failed to parse listing HTML", "structure_change"),
            ("kaboom, something odd", "other"),
        ],
    )
    def test_fatal_discover_failure_is_typed(self, pg_conn, message, expected_kind):
        _apply_schema(pg_conn)
        connector = _RaisingDiscoverConnector(
            f"test-fatal-{expected_kind}", ConnectorError(message)
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _classification_row(pg_conn, run_id, connector.name)
            assert row["status"] == "failed"
            assert row["failure_classification"] == expected_kind
            outcomes = {g["outcome"] for g in (row["geography_scope"] or [])}
            assert outcomes == {"failed"}, row["geography_scope"]
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)

    def test_soft_block_at_discover_is_classified_soft_block(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DiscoverSoftBlocksConnector()
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            row = _classification_row(pg_conn, run_id, connector.name)
            # A soft-block is a clean 'ok' status but STILL classified so it is
            # trend-analyzable (#242) even though it is not a failure.
            assert row["status"] == "ok"
            assert row["failure_classification"] == "soft_block"
            outcomes = {g["outcome"] for g in (row["geography_scope"] or [])}
            assert outcomes == {"soft_block"}, row["geography_scope"]
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_id)
            _cleanup_scope_state(pg_conn, connector.name)

    def test_check_constraint_rejects_an_unknown_classification(self, pg_conn):
        _apply_schema(pg_conn)
        run_id = orchestrator._create_connector_run(pg_conn, "test")
        try:
            with pytest.raises(psycopg2.errors.CheckViolation):
                with pg_conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO connector_run_results "
                        "(run_id, connector_name, status, failure_classification) "
                        "VALUES (%s, %s, 'failed', 'not-a-real-kind')",
                        (run_id, "test-bad-kind"),
                    )
                pg_conn.commit()
            pg_conn.rollback()
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_run_results WHERE connector_name = %s",
                    ("test-bad-kind",),
                )
                cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
class TestDiscoveryPriceHistory:
    """Issue #183: a connector's discovery-time prices (Connector.
    discovered_prices() — Fotocasa's verified per-listing rawPrice, read for
    free from the same search payload discover() already fetches) are written
    straight to listing_price_history, **decoupled from the fetch budget**, so
    price-drop detection (issue #34) is complete for the whole discovered
    inventory rather than only the subset a run's circuit-breaker/rate-limit/
    min_refetch budget re-fetches.

    Idempotent: an observation is appended only when the discovery price
    differs from the listing's most recent recorded price, and
    `listing.current_price` stays exclusively fetch-path-owned (D-070).
    """

    def _history_prices(self, conn, source: str, external_id: str) -> list:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT h.price FROM listing_price_history h "
                "JOIN listing l ON l.id = h.listing_id "
                "WHERE l.source = %s AND l.external_id = %s "
                "ORDER BY h.observed_at, h.id",
                (source, external_id),
            )
            return [row[0] for row in cur.fetchall()]

    def _current_price(self, conn, source: str, external_id: str):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT current_price FROM listing "
                "WHERE source = %s AND external_id = %s",
                (source, external_id),
            )
            return cur.fetchone()[0]

    def test_empty_discovery_prices_is_a_pure_no_op(self):
        """No discovery-time price signal (every connector but Fotocasa today,
        whose discovered_prices() returns {}) -> the helper returns 0 without
        ever touching the database."""

        class _ExplodingConn:
            def cursor(self, *args, **kwargs):
                raise AssertionError("must not open a cursor for an empty dict")

        assert (
            orchestrator._record_discovery_price_observations(
                _ExplodingConn(), "any-source", {}
            )
            == 0
        )

    def test_discovery_price_for_unknown_listing_is_ignored(self, pg_conn):
        """A discovered id with no `listing` row yet (never fetched) gets its
        first price on its first real fetch, exactly as before — the helper
        FK-safely records nothing for it and never raises."""
        _apply_schema(pg_conn)
        recorded = orchestrator._record_discovery_price_observations(
            pg_conn, "ghost-source-183", {"never-existed-1": Decimal(123456)}
        )
        assert recorded == 0

    def test_discovery_price_recorded_without_a_detail_fetch(self, pg_conn):
        """The core proof: a listing the fetch budget never reaches this run
        (its turn comes after the circuit breaker has tripped) still gets its
        discovery-time price appended to the timeline."""
        _apply_schema(pg_conn)
        source = "disc-price-no-fetch"

        seed = DummyConnector(name=source, external_ids=("t-1",), price=205000)
        orchestrator.CONNECTORS[:] = [seed]
        run_ids: list[int] = []
        try:
            # Run 1: a normal fetch seeds the listing row (the price-history FK
            # target) plus its baseline observation.
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert seed.fetch_calls == ["t-1"]
            assert self._history_prices(pg_conn, source, "t-1") == [Decimal(205000)]

            # Run 2: a failing id FIRST trips the shared circuit breaker, so the
            # loop aborts before ever reaching t-1 — exactly the fetch-budget
            # exhaustion issue #183 is about. t-1's discovery-time price has
            # dropped and must still land in the timeline.
            budget_bound = DummyConnector(
                name=source,
                external_ids=("bad-1", "t-1"),
                failing_ids=frozenset({"bad-1"}),
                circuit_breaker_min_attempts=1,
                circuit_breaker_error_rate=0.5,
            )
            budget_bound.discovery_price_overrides = {"t-1": 195000}
            orchestrator.CONNECTORS[:] = [budget_bound]

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            assert "t-1" not in budget_bound.fetch_calls, (
                "the circuit breaker must have aborted the loop before t-1 was "
                "fetched — this is what makes the observation decoupled from "
                "the fetch budget"
            )
            assert self._history_prices(pg_conn, source, "t-1") == [
                Decimal(205000),
                Decimal(195000),
            ], "the discovery-time price drop must be appended to the timeline"
            assert self._current_price(pg_conn, source, "t-1") == Decimal(205000), (
                "current_price stays fetch-path-owned (D-070): a discovery-time "
                "observation must not touch it, or _should_skip_fetch's "
                "price-change re-fetch trigger would stop firing"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, source, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()

    def test_helper_dedups_repeated_and_matching_observations(self, pg_conn):
        """Idempotency, directly on the write helper: the same price is never
        double-inserted across re-runs, a discovery price matching the latest
        recorded row is a no-op, and a further genuine drop IS recorded."""
        _apply_schema(pg_conn)
        source = "disc-price-helper-idem"
        connector = DummyConnector(name=source, external_ids=("h-1",), price=250000)
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert self._history_prices(pg_conn, source, "h-1") == [Decimal(250000)]

            drop = {"h-1": Decimal(240000)}
            first = orchestrator._record_discovery_price_observations(
                pg_conn, source, drop
            )
            second = orchestrator._record_discovery_price_observations(
                pg_conn, source, drop
            )
            assert first == 1, "a newly-seen discovery price is recorded once"
            assert second == 0, (
                "the identical observation on the next sweep is deduped against "
                "the latest recorded price, not inserted a second time"
            )
            assert self._history_prices(pg_conn, source, "h-1") == [
                Decimal(250000),
                Decimal(240000),
            ]

            matching = orchestrator._record_discovery_price_observations(
                pg_conn, source, {"h-1": Decimal(240000)}
            )
            assert matching == 0, "a discovery price equal to the latest row is a no-op"

            further = orchestrator._record_discovery_price_observations(
                pg_conn, source, {"h-1": Decimal(230000)}
            )
            assert further == 1, "a further genuine drop is recorded"
            assert self._history_prices(pg_conn, source, "h-1") == [
                Decimal(250000),
                Decimal(240000),
                Decimal(230000),
            ]
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, source, run_id)

    def test_refetched_price_change_is_not_double_recorded(self, pg_conn):
        """When a discovery-time delta forces a real re-fetch (skip-if-seen
        reason #5), the fetch path already appends the authoritative price;
        the discovery recorder must dedup against that row, not stack a second
        identical observation on top in the same run."""
        _apply_schema(pg_conn)
        source = "disc-price-refetch-dedup"
        connector = DummyConnector(
            name=source,
            external_ids=("r-1",),
            price=400000,
            min_refetch_interval_seconds=24 * 60 * 60,
        )
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["r-1"]

            connector.discovery_price_overrides = {"r-1": 380000}
            connector.price = 380000
            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            assert connector.fetch_calls == ["r-1", "r-1"], (
                "a discovery-time delta must force the re-fetch"
            )

            assert self._history_prices(pg_conn, source, "r-1") == [
                Decimal(400000),
                Decimal(380000),
            ], (
                "exactly one new observation for the change — the fetch path's, "
                "not a discovery-time duplicate stacked on top the same run"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, source, None)
            with pg_conn.cursor() as cur:
                for r in run_ids:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (r,))
            pg_conn.commit()
