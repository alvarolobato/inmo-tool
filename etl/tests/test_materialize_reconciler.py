"""Tests for the profile-materialize staleness reconciler (issue #285, D-046).

The reconciler is the durable self-healing backstop for the Estepona class of
bug: a single best-effort `notify_materialize_all` skipped/failed on an ingest
path leaves an active profile stranded at stale data with nothing to retry it.
These tests prove, against a real Postgres, that one reconciler tick detects the
staleness and re-fires the materialize — and that the connector-path notify now
survives a raise in end-of-sweep bookkeeping (moved into a `finally`).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from etl import materialize_reconciler, orchestrator

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"

_VALID_SCOPE = (
    '{"geography": {"type": "radius", "center": [40.4168, -3.7038], '
    '"radius_km": 10}, "property_types": ["piso"]}'
)


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _make_profile(conn, name: str, *, materialized_offset_sql: str | None) -> int:
    """Insert an active profile. `materialized_offset_sql` is a SQL interval
    expression for `last_materialized_at = NOW() - <it>`, or None to leave it
    NULL (never materialized)."""
    with conn.cursor() as cur:
        if materialized_offset_sql is None:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s::jsonb) "
                "RETURNING id",
                (name, _VALID_SCOPE),
            )
        else:
            cur.execute(
                "INSERT INTO search_profile (name, scope, last_materialized_at) "
                f"VALUES (%s, %s::jsonb, NOW() - INTERVAL '{materialized_offset_sql}') "
                "RETURNING id",
                (name, _VALID_SCOPE),
            )
        pid = cur.fetchone()[0]
    conn.commit()
    return pid


def _ingest_listing(conn, source: str, external_id: str) -> int:
    """Directly insert a property + a freshly-seen listing (last_seen_at = NOW())
    WITHOUT firing any notify — i.e. simulate an ingest whose re-materialize
    notification was missed. Returns the property id."""
    with conn.cursor() as cur:
        cur.execute("INSERT INTO property (property_type) VALUES ('piso') RETURNING id")
        property_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO listing (property_id, source, external_id, status, "
            "first_seen_at, last_seen_at, last_fetched_at, current_price) "
            "VALUES (%s, %s, %s, 'active', NOW(), NOW(), NOW(), 150000) RETURNING id",
            (property_id, source, external_id),
        )
    conn.commit()
    return property_id


def _cleanup(conn, source: str) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT property_id FROM listing WHERE source = %s", (source,))
        property_ids = [r[0] for r in cur.fetchall()]
        cur.execute("DELETE FROM listing WHERE source = %s", (source,))
        if property_ids:
            cur.execute(
                "DELETE FROM profile_listing_state WHERE property_id = ANY(%s)",
                (property_ids,),
            )
            cur.execute("DELETE FROM property WHERE id = ANY(%s)", (property_ids,))
    conn.commit()


class TestStalenessDetection:
    """`_stale_profiles_exist` — the SQL predicate the whole self-heal rests on."""

    def test_never_materialized_active_profile_is_stale(self, pg_conn):
        _apply_schema(pg_conn)
        source = "reconciler-never-mat"
        pid = _make_profile(pg_conn, source, materialized_offset_sql=None)
        try:
            assert materialize_reconciler._stale_profiles_exist(pg_conn) is True
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()

    def test_listing_newer_than_last_materialized_is_stale(self, pg_conn):
        _apply_schema(pg_conn)
        source = "reconciler-stale"
        pid = _make_profile(pg_conn, source, materialized_offset_sql="1 hour")
        try:
            # No listings yet: an already-materialized profile with nothing
            # newer than it is NOT stale.
            assert materialize_reconciler._stale_profiles_exist(pg_conn) is False
            # Ingest a listing seen NOW — newer than last_materialized_at (1h ago).
            _ingest_listing(pg_conn, source, "L1")
            assert materialize_reconciler._stale_profiles_exist(pg_conn) is True
        finally:
            _cleanup(pg_conn, source)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()

    def test_freshly_materialized_profile_is_not_stale(self, pg_conn):
        _apply_schema(pg_conn)
        source = "reconciler-fresh"
        pid = _make_profile(pg_conn, source, materialized_offset_sql="1 hour")
        try:
            _ingest_listing(pg_conn, source, "L1")
            assert materialize_reconciler._stale_profiles_exist(pg_conn) is True
            # Materialize now: last_materialized_at = NOW() > every listing ts.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE search_profile SET last_materialized_at = NOW() "
                    "WHERE id = %s",
                    (pid,),
                )
            pg_conn.commit()
            assert materialize_reconciler._stale_profiles_exist(pg_conn) is False
        finally:
            _cleanup(pg_conn, source)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()

    def test_archived_profile_never_counts_as_stale(self, pg_conn):
        _apply_schema(pg_conn)
        source = "reconciler-archived"
        pid = _make_profile(pg_conn, source, materialized_offset_sql=None)
        try:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE search_profile SET archived_at = NOW() WHERE id = %s",
                    (pid,),
                )
            pg_conn.commit()
            _ingest_listing(pg_conn, source, "L1")
            # An archived profile is not active — materialize-all skips it, so
            # it must never keep the reconciler firing forever.
            assert materialize_reconciler._stale_profiles_exist(pg_conn) is False
        finally:
            _cleanup(pg_conn, source)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()


class TestReconcilerSelfHeal:
    """The core acceptance test (issue #285): a missed notify self-heals within
    one reconciler tick."""

    def _fake_materialize(self, conn, calls):
        """A real-Postgres stand-in for the dashboard's materialize-all HTTP
        endpoint: match every property to every active profile and stamp
        last_materialized_at — exactly the observable effect
        `materializeAllProfiles` has, without re-implementing the TS scope
        filter in Python (D-044). Records the trigger it was called with."""

        def _fn(trigger: str = "scheduler"):
            calls.append(trigger)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO profile_listing_state (profile_id, property_id, matched)
                    SELECT sp.id, p.id, true
                    FROM search_profile sp CROSS JOIN property p
                    WHERE sp.archived_at IS NULL
                    ON CONFLICT (profile_id, property_id) DO UPDATE SET matched = true
                    """
                )
                cur.execute(
                    "UPDATE search_profile SET last_materialized_at = NOW() "
                    "WHERE archived_at IS NULL"
                )
            conn.commit()
            return True

        return _fn

    def test_missed_notify_self_heals_in_one_tick(self, pg_conn):
        _apply_schema(pg_conn)
        source = "reconciler-selfheal"
        pid = _make_profile(pg_conn, source, materialized_offset_sql="1 hour")
        try:
            # An ingest whose notify was MISSED: the listing exists but the
            # profile's materialized state does not reflect it.
            property_id = _ingest_listing(pg_conn, source, "L1")
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM profile_listing_state "
                    "WHERE profile_id = %s AND property_id = %s AND matched = true",
                    (pid, property_id),
                )
                assert cur.fetchone()[0] == 0  # stranded / stale
            pg_conn.rollback()

            calls: list[str] = []
            fired = materialize_reconciler.reconcile_stale_profiles(
                pg_conn, materialize_all=self._fake_materialize(pg_conn, calls)
            )

            assert fired is True
            assert calls == ["reconciler"]
            # The profile now reflects the previously-missed listing.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT matched FROM profile_listing_state "
                    "WHERE profile_id = %s AND property_id = %s",
                    (pid, property_id),
                )
                row = cur.fetchone()
            assert row is not None and row[0] is True
            # And it is no longer stale — a second tick is a no-op.
            calls.clear()
            fired_again = materialize_reconciler.reconcile_stale_profiles(
                pg_conn, materialize_all=self._fake_materialize(pg_conn, calls)
            )
            assert fired_again is False
            assert calls == []
        finally:
            _cleanup(pg_conn, source)
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()

    def test_no_fire_when_nothing_is_stale(self, pg_conn):
        _apply_schema(pg_conn)
        source = "reconciler-nofire"
        pid = _make_profile(pg_conn, source, materialized_offset_sql="1 hour")
        try:
            calls: list[str] = []
            fired = materialize_reconciler.reconcile_stale_profiles(
                pg_conn, materialize_all=self._fake_materialize(pg_conn, calls)
            )
            assert fired is False
            assert calls == []
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()

    def test_skips_while_a_connector_sweep_is_running(self, pg_conn):
        """A sweep in progress fires its own end-of-sweep notify (now in a
        `finally`); the reconciler must defer to it and not race a redundant
        materialize while last_seen_at is bumped mid-sweep."""
        _apply_schema(pg_conn)
        source = "reconciler-sweepguard"
        pid = _make_profile(pg_conn, source, materialized_offset_sql="1 hour")
        run_id = None
        try:
            _ingest_listing(pg_conn, source, "L1")
            assert materialize_reconciler._stale_profiles_exist(pg_conn) is True

            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO connector_runs (trigger, status) "
                    "VALUES ('test', 'running') RETURNING id"
                )
                run_id = cur.fetchone()[0]
            pg_conn.commit()

            calls: list[str] = []
            fired = materialize_reconciler.reconcile_stale_profiles(
                pg_conn, materialize_all=self._fake_materialize(pg_conn, calls)
            )
            assert fired is False
            assert calls == []

            # Sweep finishes → the guard lifts and the backstop fires.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE connector_runs SET status = 'success', finished_at = NOW() "
                    "WHERE id = %s",
                    (run_id,),
                )
            pg_conn.commit()
            fired_after = materialize_reconciler.reconcile_stale_profiles(
                pg_conn, materialize_all=self._fake_materialize(pg_conn, calls)
            )
            assert fired_after is True
            assert calls == ["reconciler"]
        finally:
            _cleanup(pg_conn, source)
            with pg_conn.cursor() as cur:
                if run_id is not None:
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()


class TestNotifyMovedIntoFinally:
    """Issue #285: a raise in end-of-sweep bookkeeping must not skip the
    re-materialize notify — it now runs in a `finally`."""

    def test_notify_still_fires_when_finish_run_raises(self, pg_conn, monkeypatch):
        from etl.tests.fixtures.dummy_connector import DummyConnector
        from etl.tests.test_orchestrator import _apply_schema as _apply_orch_schema

        _apply_orch_schema(pg_conn)
        connector = DummyConnector(name="reconciler-finally-connector")
        orchestrator.CONNECTORS[:] = [connector]

        notified: list[str] = []

        def _spy_notify(trigger: str = "scheduler"):
            notified.append(trigger)
            return True

        def _boom(*_args, **_kwargs):
            raise RuntimeError("bookkeeping blew up between the loop and notify")

        monkeypatch.setattr(orchestrator, "notify_materialize_all", _spy_notify)
        monkeypatch.setattr(orchestrator, "_finish_connector_run", _boom)

        try:
            # The bookkeeping raise propagates (run_all_connectors does not
            # swallow it) — but the notify in the `finally` still fired.
            with pytest.raises(RuntimeError, match="bookkeeping blew up"):
                orchestrator.run_all_connectors(pg_conn, trigger="test")
            assert notified == ["test"]
        finally:
            orchestrator.CONNECTORS.clear()
            pg_conn.rollback()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT property_id FROM listing WHERE source = %s",
                    (connector.name,),
                )
                property_ids = [r[0] for r in cur.fetchall()]
                cur.execute("DELETE FROM listing WHERE source = %s", (connector.name,))
                if property_ids:
                    cur.execute(
                        "DELETE FROM property WHERE id = ANY(%s)", (property_ids,)
                    )
                cur.execute(
                    "DELETE FROM connector_run_results WHERE connector_name = %s",
                    (connector.name,),
                )
            pg_conn.commit()
