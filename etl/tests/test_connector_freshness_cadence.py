"""Integration tests for the per-connector freshness cadence (issue #295, D-050).

Real PostgreSQL via the pg_conn fixture (skipped if unavailable, per
conftest.py). The whole feature is about what gets persisted in
connector_freshness_state / connector_scope_state and how the scheduler gates on
it, so mocking the database would test nothing meaningful — same posture as
test_orchestrator.py.

Decision matrix under test (see the #295 spec comment):
  - due-check: never-fresh → start; fresh + not elapsed → skip (no run row);
    cycle in progress → continue regardless of interval.
  - manual/CLI trigger (trigger != "scheduler") bypasses the gate entirely.
  - resume: scopes already discovered since cycle_started_at are skipped
    (reason "fresh_this_cycle"), never re-crawled.
  - completion: 100% of the live target scope set discovered since the cycle
    started → mark fresh, clear the cycle.
  - partial coverage leaves the cycle in progress; a stuck cycle is flagged, not
    force-completed.
  - a clean budget/soft-block partial stop stays 'ok' and resumes next tick.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from etl import orchestrator
from etl.connectors.base import SoftBlockError
from etl.tests.fixtures.dummy_connector import (
    DiscoverFailsConnector,
    DummyConnector,
)

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

_TEST_PROFILE_NAME = "freshness-cadence-test-fixture-profile"
# A second, geographically-distinct active profile — resolves to a different
# scope_key than the primary one, so the resume test has two target scopes.
_SECOND_PROFILE_NAME = "freshness-cadence-test-second-profile"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
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


def _add_second_profile(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM search_profile WHERE name = %s AND archived_at IS NULL",
            (_SECOND_PROFILE_NAME,),
        )
        if cur.fetchone() is None:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s)",
                (
                    _SECOND_PROFILE_NAME,
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [41.3874, 2.1686], "radius_km": 10}}'
                    ),
                ),
            )
    conn.commit()


def _remove_second_profile(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM search_profile WHERE name = %s", (_SECOND_PROFILE_NAME,)
        )
    conn.commit()


def _cleanup(conn, source: str, run_ids: list[int] | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM connector_run_results WHERE connector_name = %s", (source,)
        )
        for run_id in run_ids or []:
            cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
        cur.execute(
            "DELETE FROM connector_freshness_state WHERE connector_name = %s", (source,)
        )
        cur.execute(
            "DELETE FROM connector_scope_state WHERE connector_name = %s", (source,)
        )
        cur.execute("DELETE FROM connector_config WHERE connector_name = %s", (source,))
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


# --- freshness-state helpers ------------------------------------------------


def _seed_freshness(
    conn,
    connector_name: str,
    *,
    last_fresh_at: datetime | None,
    cycle_started_at: datetime | None,
    cycle_target_scope_count: int | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO connector_freshness_state "
            "(connector_name, last_fresh_at, cycle_started_at, "
            " cycle_target_scope_count) VALUES (%s, %s, %s, %s)",
            (connector_name, last_fresh_at, cycle_started_at, cycle_target_scope_count),
        )
    conn.commit()


def _read_freshness(conn, connector_name: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT last_fresh_at, cycle_started_at, cycle_target_scope_count "
            "FROM connector_freshness_state WHERE connector_name = %s",
            (connector_name,),
        )
        return cur.fetchone()


def _count_result_rows(conn, connector_name: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM connector_run_results WHERE connector_name = %s",
            (connector_name,),
        )
        return cur.fetchone()[0]


def _seed_scope_state(
    conn,
    connector_name: str,
    scope_key: str,
    *,
    last_attempted_at: datetime | None,
    last_discovered_at: datetime | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO connector_scope_state "
            "(connector_name, scope_key, last_attempted_at, last_discovered_at) "
            "VALUES (%s, %s, %s, %s)",
            (connector_name, scope_key, last_attempted_at, last_discovered_at),
        )
    conn.commit()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _primary_scope_key(conn, connector) -> str:
    """The scope_key the primary fixture profile resolves to for *connector*."""
    scopes = orchestrator._active_profile_scopes(conn)
    for scope in scopes:
        key = connector.scope_key(scope)
        if key is not None:
            return key
    raise AssertionError("no resolvable scope for the fixture profile")


# ===========================================================================
# Pure decision-function tests (no DB) — the due/start/continue matrix.
# ===========================================================================


class TestFreshnessDecision:
    _NOW = datetime(2026, 8, 5, 12, 0, 0, tzinfo=timezone.utc)

    def test_no_row_is_due_immediately(self):
        assert (
            orchestrator._freshness_decision(None, 24, "scheduler", self._NOW)
            == "start"
        )

    def test_null_last_fresh_at_is_due(self):
        row = orchestrator.FreshnessRow(
            last_fresh_at=None, cycle_started_at=None, cycle_target_scope_count=None
        )
        assert (
            orchestrator._freshness_decision(row, 24, "scheduler", self._NOW) == "start"
        )

    def test_fresh_within_interval_skips(self):
        row = orchestrator.FreshnessRow(
            last_fresh_at=self._NOW - timedelta(hours=1),
            cycle_started_at=None,
            cycle_target_scope_count=None,
        )
        assert (
            orchestrator._freshness_decision(row, 24, "scheduler", self._NOW) == "skip"
        )

    def test_interval_elapsed_starts(self):
        row = orchestrator.FreshnessRow(
            last_fresh_at=self._NOW - timedelta(hours=25),
            cycle_started_at=None,
            cycle_target_scope_count=None,
        )
        assert (
            orchestrator._freshness_decision(row, 24, "scheduler", self._NOW) == "start"
        )

    def test_exactly_at_interval_boundary_starts(self):
        row = orchestrator.FreshnessRow(
            last_fresh_at=self._NOW - timedelta(hours=24),
            cycle_started_at=None,
            cycle_target_scope_count=None,
        )
        assert (
            orchestrator._freshness_decision(row, 24, "scheduler", self._NOW) == "start"
        )

    def test_cycle_in_progress_always_continues_even_when_fresh(self):
        row = orchestrator.FreshnessRow(
            last_fresh_at=self._NOW,  # as fresh as possible
            cycle_started_at=self._NOW - timedelta(minutes=5),
            cycle_target_scope_count=3,
        )
        assert (
            orchestrator._freshness_decision(row, 24, "scheduler", self._NOW)
            == "continue"
        )

    def test_manual_trigger_bypasses_skip_and_starts(self):
        row = orchestrator.FreshnessRow(
            last_fresh_at=self._NOW,  # fresh — a scheduler tick would skip
            cycle_started_at=None,
            cycle_target_scope_count=None,
        )
        assert orchestrator._freshness_decision(row, 24, "manual", self._NOW) == "start"

    def test_manual_trigger_continues_an_in_progress_cycle(self):
        row = orchestrator.FreshnessRow(
            last_fresh_at=None,
            cycle_started_at=self._NOW - timedelta(hours=1),
            cycle_target_scope_count=2,
        )
        assert (
            orchestrator._freshness_decision(row, 24, "manual", self._NOW) == "continue"
        )


# ===========================================================================
# Integration tests against real Postgres.
# ===========================================================================


class TestDueGate:
    def test_never_fresh_connector_starts_and_completes_a_cycle(self, pg_conn):
        """EC-3 (and the start half of the matrix): a connector with no
        freshness row runs on a scheduler tick, and because the dummy covers its
        one scope fully in that tick, the cycle completes and last_fresh_at is
        set."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-freshness-never-fresh")
        orchestrator.CONNECTORS[:] = [connector]
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            # It actually ran (a real result row exists).
            assert _count_result_rows(pg_conn, connector.name) == 1
            # And the single-tick full sweep completed the cycle.
            last_fresh_at, cycle_started_at, _ = _read_freshness(
                pg_conn, connector.name
            )
            assert last_fresh_at is not None
            assert cycle_started_at is None
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)

    def test_fresh_and_not_due_is_skipped_with_no_run_row(self, pg_conn):
        """EC-1: a scheduler tick makes NO connector_run_results row for a
        connector whose data is fresh and inside its interval."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-freshness-fresh-skip")
        orchestrator.CONNECTORS[:] = [connector]
        _seed_freshness(
            pg_conn, connector.name, last_fresh_at=_now(), cycle_started_at=None
        )
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            # Skipped entirely — no result row, and discover() never called.
            assert _count_result_rows(pg_conn, connector.name) == 0
            assert connector.scopes_seen == []
            # Freshness state untouched — still fresh, still no cycle.
            _, cycle_started_at, _ = _read_freshness(pg_conn, connector.name)
            assert cycle_started_at is None
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)

    def test_manual_trigger_bypasses_the_due_check(self, pg_conn):
        """EC-4: the identical fresh state runs under a manual trigger — a human
        pressing 'Ejecutar ahora' / `ps connector run` never silently no-ops."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-freshness-manual-bypass")
        orchestrator.CONNECTORS[:] = [connector]
        _seed_freshness(
            pg_conn, connector.name, last_fresh_at=_now(), cycle_started_at=None
        )
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(
                pg_conn, trigger="manual", connector_name=connector.name
            )
            # A real result row exists despite being "fresh".
            assert _count_result_rows(pg_conn, connector.name) == 1
            assert connector.scopes_seen != []
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)

    def test_cycle_in_progress_continues_past_interval(self, pg_conn):
        """A cycle already in flight runs even when last_fresh_at is recent —
        the interval only gates STARTING, never abandoning a cycle partway."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-freshness-continue")
        orchestrator.CONNECTORS[:] = [connector]
        # Fresh (a scheduler tick would skip) BUT a cycle is in progress.
        _seed_freshness(
            pg_conn,
            connector.name,
            last_fresh_at=_now(),
            cycle_started_at=_now() - timedelta(minutes=5),
        )
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            # It continued the cycle (ran) despite being "fresh".
            assert _count_result_rows(pg_conn, connector.name) == 1
            assert connector.scopes_seen != []
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)

    def test_capture_only_disabled_connector_never_enters_the_gate(self, pg_conn):
        """A capture-only connector (enabled=false structurally) is skipped as
        disabled before the freshness machinery — no connector_freshness_state
        row is ever created for it."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-freshness-capture-only")
        orchestrator.CONNECTORS[:] = [connector]
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config (connector_name, enabled) "
                "VALUES (%s, false)",
                (connector.name,),
            )
        pg_conn.commit()
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            # Disabled → a 'skipped' result row, but NO freshness state at all.
            assert connector.scopes_seen == []
            assert _read_freshness(pg_conn, connector.name) is None
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)


class TestResume:
    def test_resume_skips_scopes_already_discovered_since_cycle_started(self, pg_conn):
        """EC-2: with two target scopes, one already discovered since the cycle
        started and one not, only the stale one reaches discover()."""
        _apply_schema(pg_conn)
        _add_second_profile(pg_conn)
        connector = DummyConnector(name="test-freshness-resume")
        orchestrator.CONNECTORS[:] = [connector]

        # Resolve the two distinct scope keys the two profiles produce.
        scopes = orchestrator._active_profile_scopes(pg_conn)
        keys = sorted(
            {connector.scope_key(s) for s in scopes if connector.scope_key(s)}
        )
        assert len(keys) == 2, f"expected two distinct scope keys, got {keys}"
        fresh_key, stale_key = keys[0], keys[1]

        cycle_start = _now() - timedelta(hours=1)
        _seed_freshness(
            pg_conn, connector.name, last_fresh_at=None, cycle_started_at=cycle_start
        )
        # fresh_key: discovered AFTER the cycle started → must be skipped.
        _seed_scope_state(
            pg_conn,
            connector.name,
            fresh_key,
            last_attempted_at=cycle_start + timedelta(minutes=1),
            last_discovered_at=cycle_start + timedelta(minutes=1),
        )
        # stale_key: discovered BEFORE the cycle started → must be re-crawled.
        _seed_scope_state(
            pg_conn,
            connector.name,
            stale_key,
            last_attempted_at=cycle_start - timedelta(hours=5),
            last_discovered_at=cycle_start - timedelta(hours=5),
        )
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            # Only the stale scope reached discover().
            seen_keys = {connector.scope_key(s) for s in connector.scopes_seen}
            assert seen_keys == {stale_key}
            # The fresh scope was recorded as skipped for the right reason.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT skipped_scopes FROM connector_run_results "
                    "WHERE connector_name = %s AND run_id = %s",
                    (connector.name, run_id),
                )
                (skipped_scopes,) = cur.fetchone()
            reasons = {
                entry["scope"]: entry["reason"] for entry in (skipped_scopes or [])
            }
            assert reasons.get(fresh_key) == "fresh_this_cycle"
            # Both scopes now discovered since cycle start → cycle completed.
            last_fresh_at, cycle_started_at, _ = _read_freshness(
                pg_conn, connector.name
            )
            assert last_fresh_at is not None
            assert cycle_started_at is None
        finally:
            orchestrator.CONNECTORS.clear()
            _remove_second_profile(pg_conn)
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)


class TestCompletion:
    def test_partial_coverage_leaves_cycle_in_progress(self, pg_conn):
        """A tick that discovers none of its target scopes (discover() fails)
        leaves cycle_started_at set and last_fresh_at NULL — the cycle continues
        next tick, never falsely fresh."""
        _apply_schema(pg_conn)
        connector = DiscoverFailsConnector()
        # Give it a stable, test-scoped name so cleanup/freshness key is unique.
        connector.name = "test-freshness-partial"
        orchestrator.CONNECTORS[:] = [connector]
        cycle_start = _now() - timedelta(hours=2)
        _seed_freshness(
            pg_conn, connector.name, last_fresh_at=None, cycle_started_at=cycle_start
        )
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            last_fresh_at, cycle_started_at, _ = _read_freshness(
                pg_conn, connector.name
            )
            assert last_fresh_at is None
            assert cycle_started_at is not None
            # Unchanged — same cycle, not restarted.
            assert abs((cycle_started_at - cycle_start).total_seconds()) < 1
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)

    def test_stuck_cycle_is_flagged_but_not_force_completed(self, pg_conn, caplog):
        """A cycle older than the stuck threshold with partial coverage logs a
        WARNING and is NOT force-completed — it stays honestly 'refreshing'."""
        _apply_schema(pg_conn)
        connector = DiscoverFailsConnector()
        connector.name = "test-freshness-stuck"
        orchestrator.CONNECTORS[:] = [connector]
        cycle_start = _now() - timedelta(days=8)  # older than the 168h default
        _seed_freshness(
            pg_conn, connector.name, last_fresh_at=None, cycle_started_at=cycle_start
        )
        run_id = None
        try:
            with caplog.at_level(logging.WARNING, logger="etl.orchestrator"):
                run_id = orchestrator.run_all_connectors(
                    pg_conn,
                    trigger="scheduler",
                    freshness_cycle_stuck_after_hours=168,
                )
            last_fresh_at, cycle_started_at, _ = _read_freshness(
                pg_conn, connector.name
            )
            # NOT force-completed.
            assert last_fresh_at is None
            assert cycle_started_at is not None
            # Flagged.
            assert any(
                "STUCK" in rec.message and connector.name in rec.message
                for rec in caplog.records
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)

    def test_budget_partial_stop_stays_clean_and_resumes_next_tick(self, pg_conn):
        """A soft-block partial (clean 'ok' outcome, #270) leaves the cycle in
        progress on tick 1, and tick 2 completes it — a partial 'will continue
        next run' is a CLEAN outcome, not an error."""
        _apply_schema(pg_conn)

        class _SoftBlockThenOk(DummyConnector):
            def __init__(self, name):
                super().__init__(name=name)
                self._soft_block_next = True

            def discover(self, scope, throttle):
                if self._soft_block_next:
                    self._soft_block_next = False
                    raise SoftBlockError("simulated soft-block on the first tick")
                return super().discover(scope, throttle)

        connector = _SoftBlockThenOk("test-freshness-budget-resume")
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            # Tick 1: never fresh → start a cycle; discover soft-blocks → clean
            # partial, cycle stays in progress.
            run_ids.append(
                orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            )
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM connector_run_results "
                    "WHERE connector_name = %s AND run_id = %s",
                    (connector.name, run_ids[-1]),
                )
                (status,) = cur.fetchone()
            # CLEAN outcome — a soft-block backoff is 'ok', not an error.
            assert status == "ok"
            last_fresh_at, cycle_started_at, _ = _read_freshness(
                pg_conn, connector.name
            )
            assert last_fresh_at is None
            assert cycle_started_at is not None
            first_cycle_start = cycle_started_at

            # Tick 2: continues the SAME cycle; discover now succeeds → complete.
            run_ids.append(
                orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            )
            last_fresh_at, cycle_started_at, _ = _read_freshness(
                pg_conn, connector.name
            )
            assert last_fresh_at is not None
            assert cycle_started_at is None
            # The completion belonged to the cycle tick 1 started (it continued,
            # not restarted): the primary scope was discovered after that anchor.
            key = _primary_scope_key(pg_conn, connector)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT last_discovered_at FROM connector_scope_state "
                    "WHERE connector_name = %s AND scope_key = %s",
                    (connector.name, key),
                )
                (last_discovered_at,) = cur.fetchone()
            assert last_discovered_at >= first_cycle_start
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, run_ids)


class TestIntervalOverride:
    def test_per_connector_override_gates_the_due_check(self, pg_conn):
        """A connector_config.freshness_interval_hours override changes when a
        connector is due: a 1h override with data 2h old is due (starts), while
        the 24h default would still skip."""
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-freshness-override")
        orchestrator.CONNECTORS[:] = [connector]
        with pg_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO connector_config "
                "(connector_name, freshness_interval_hours) VALUES (%s, 1)",
                (connector.name,),
            )
        pg_conn.commit()
        # Data is 2h old: skip under the 24h default, but DUE under the 1h override.
        _seed_freshness(
            pg_conn,
            connector.name,
            last_fresh_at=_now() - timedelta(hours=2),
            cycle_started_at=None,
        )
        run_id = None
        try:
            run_id = orchestrator.run_all_connectors(pg_conn, trigger="scheduler")
            # Ran (due under the override).
            assert _count_result_rows(pg_conn, connector.name) == 1
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup(pg_conn, connector.name, [run_id] if run_id else None)

    def test_resolve_interval_falls_back_to_default_for_null_or_invalid(self, pg_conn):
        _apply_schema(pg_conn)
        name = "test-freshness-resolve"
        try:
            # No config row at all → default.
            assert (
                orchestrator._resolve_freshness_interval_hours(pg_conn, name, 24) == 24
            )
            # NULL override → default.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO connector_config (connector_name) VALUES (%s)", (name,)
                )
            pg_conn.commit()
            assert (
                orchestrator._resolve_freshness_interval_hours(pg_conn, name, 24) == 24
            )
            # A valid positive override wins.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE connector_config SET freshness_interval_hours = 6 "
                    "WHERE connector_name = %s",
                    (name,),
                )
            pg_conn.commit()
            assert (
                orchestrator._resolve_freshness_interval_hours(pg_conn, name, 24) == 6
            )
            # A non-positive override falls back to the default.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE connector_config SET freshness_interval_hours = 0 "
                    "WHERE connector_name = %s",
                    (name,),
                )
            pg_conn.commit()
            assert (
                orchestrator._resolve_freshness_interval_hours(pg_conn, name, 24) == 24
            )
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_config WHERE connector_name = %s", (name,)
                )
            pg_conn.commit()
