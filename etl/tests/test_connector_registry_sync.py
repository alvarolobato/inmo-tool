"""Tests for `sync_connector_registry` (issue #100).

The connector-management UI lists what it finds in `connector_registry`, so
this sync is the only thing standing between "a connector exists in Python"
and "an operator can see and configure it". Real PostgreSQL via the pg_conn
fixture — the whole point is what lands in the table.
"""

from __future__ import annotations

from pathlib import Path

from etl import orchestrator
from etl.connectors.base import Connector, ConnectorScope, RawListing
from etl.tests.fixtures.dummy_connector import DummyConnector

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


class _CaptureOnlyConnector(Connector):
    """Stands in for Idealista: registered, but never discovers anything."""

    name = "test-capture-only"
    supports_discovery = False
    supported_filters = ()

    def scope_key(self, scope: ConnectorScope) -> str | None:
        return None

    def discover(self, scope, throttle):  # pragma: no cover - never called
        return []

    def fetch_detail(self, external_id, throttle):  # pragma: no cover
        raise NotImplementedError

    def normalize(self, raw: RawListing):  # pragma: no cover
        raise NotImplementedError


class _FilteredConnector(DummyConnector):
    """A connector declaring a real native filter, like Fotocasa's rooms."""

    supported_filters = ("rooms",)


def _registry_rows(conn, names: list[str]) -> dict[str, tuple]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT connector_name, registered, rate_limit_per_minute, "
            "       discovers_full_inventory, supports_discovery, supported_filters "
            "  FROM connector_registry WHERE connector_name = ANY(%s)",
            (names,),
        )
        return {row[0]: row for row in cur.fetchall()}


def _cleanup(conn, names: list[str]) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM connector_registry WHERE connector_name = ANY(%s)", (names,)
        )
    conn.commit()


class TestSyncConnectorRegistry:
    def test_publishes_registered_connectors_with_their_metadata(self, pg_conn):
        _apply_schema(pg_conn)
        filtered = _FilteredConnector(name="test-registry-filtered")
        capture_only = _CaptureOnlyConnector()
        names = [filtered.name, capture_only.name]
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [filtered, capture_only]
        try:
            orchestrator.sync_connector_registry(pg_conn)

            rows = _registry_rows(pg_conn, names)
            assert set(rows) == set(names)

            f = rows[filtered.name]
            assert f[1] is True  # registered
            assert f[4] is True  # supports_discovery
            assert f[5] == ["rooms"]  # supported_filters, as JSONB -> list

            c = rows[capture_only.name]
            assert c[1] is True
            # A capture-only connector must be published as such: the UI
            # renders geography/filter controls off this flag, and offering
            # them for a connector that never discovers would be offering
            # controls that silently do nothing (issue #100).
            assert c[4] is False
            assert c[5] == []
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, names)

    def test_is_idempotent_and_refreshes_changed_metadata(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-registry-idempotent")
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [connector]
        try:
            orchestrator.sync_connector_registry(pg_conn)
            orchestrator.sync_connector_registry(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM connector_registry WHERE connector_name = %s",
                    (connector.name,),
                )
                # Upsert, not blind insert — a restarting container must not
                # accumulate duplicate rows.
                assert cur.fetchone()[0] == 1

            # A metadata change in Python propagates on the next sync.
            connector.supported_filters = ("rooms",)
            orchestrator.sync_connector_registry(pg_conn)
            rows = _registry_rows(pg_conn, [connector.name])
            assert rows[connector.name][5] == ["rooms"]
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, [connector.name])

    def test_deregisters_a_connector_that_left_the_registry(self, pg_conn):
        _apply_schema(pg_conn)
        gone = DummyConnector(name="test-registry-retired")
        kept = DummyConnector(name="test-registry-kept")
        names = [gone.name, kept.name]
        original = list(orchestrator.CONNECTORS)
        try:
            orchestrator.CONNECTORS[:] = [gone, kept]
            orchestrator.sync_connector_registry(pg_conn)

            # `gone` disappears from Python (renamed/retired).
            orchestrator.CONNECTORS[:] = [kept]
            orchestrator.sync_connector_registry(pg_conn)

            rows = _registry_rows(pg_conn, names)
            # The row survives — historical connector_run_results still need
            # to resolve to a name — but is flagged as no longer registered,
            # which is distinct from an operator disabling it.
            assert rows[gone.name][1] is False
            assert rows[kept.name][1] is True
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, names)

    def test_empty_registry_deregisters_everything(self, pg_conn):
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-registry-emptied")
        original = list(orchestrator.CONNECTORS)
        try:
            orchestrator.CONNECTORS[:] = [connector]
            orchestrator.sync_connector_registry(pg_conn)

            orchestrator.CONNECTORS[:] = []
            orchestrator.sync_connector_registry(pg_conn)

            rows = _registry_rows(pg_conn, [connector.name])
            assert rows[connector.name][1] is False
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, [connector.name])
