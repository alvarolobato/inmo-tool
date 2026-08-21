"""Tests for `sync_connector_registry` (issue #100).

The connector-management UI lists what it finds in `connector_registry`, so
this sync is the only thing standing between "a connector exists in Python"
and "an operator can see and configure it". Real PostgreSQL via the pg_conn
fixture — the whole point is what lands in the table.
"""

from __future__ import annotations

from pathlib import Path

from etl import orchestrator
from etl.connectors.base import (
    Connector,
    ConnectorScope,
    RawListing,
    SearchUrlGrammar,
)
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


class _OverrideConnector(DummyConnector):
    """A tunable HTTP connector that advertises an override host suffix
    (issue #478 P4) — the pin-a-URL affordance the dashboard validates against."""

    override_host_suffix = "example.com"
    supports_search_override = False


class _GrammarConnector(DummyConnector):
    """A connector that publishes a search-URL grammar (issue #491)."""

    search_url_grammar = SearchUrlGrammar(
        build_template="https://example.com/venta/{geography}/",
        parse_pattern=r"^https://example\.com/venta/(?<geography>[^/]+)/$",
        params={"geography": {"label": "Municipio", "source": "profile"}},
    )


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
        cur.execute(
            "DELETE FROM connector_config WHERE connector_name = ANY(%s)", (names,)
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

    def test_publishes_override_host_suffix_and_search_override(self, pg_conn):
        """Issue #478 P4: the pin-a-URL affordance must reach the dashboard —
        override_host_suffix (a tunable connector's host) and
        supports_search_override are mirrored into connector_registry, and a
        connector that declares neither leaves them at NULL/false."""
        _apply_schema(pg_conn)
        tunable = _OverrideConnector(name="test-registry-override")
        plain = DummyConnector(name="test-registry-plain")
        names = [tunable.name, plain.name]
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [tunable, plain]
        try:
            orchestrator.sync_connector_registry(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT connector_name, override_host_suffix, "
                    "       supports_search_override "
                    "  FROM connector_registry WHERE connector_name = ANY(%s)",
                    (names,),
                )
                rows = {r[0]: r for r in cur.fetchall()}
            assert rows[tunable.name][1] == "example.com"
            assert rows[tunable.name][2] is False
            # A connector that declares no override: NULL host, false override.
            assert rows[plain.name][1] is None
            assert rows[plain.name][2] is False
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, names)

    def test_publishes_search_url_grammar_and_leaves_others_null(self, pg_conn):
        """Issue #491: a connector with a grammar exposes it as JSONB in the
        registry (build_template + parse_pattern + params); a connector without
        one leaves the column NULL."""
        _apply_schema(pg_conn)
        with_grammar = _GrammarConnector(name="test-registry-grammar")
        without = DummyConnector(name="test-registry-nogrammar")
        names = [with_grammar.name, without.name]
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [with_grammar, without]
        try:
            orchestrator.sync_connector_registry(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT connector_name, search_url_grammar "
                    "  FROM connector_registry WHERE connector_name = ANY(%s)",
                    (names,),
                )
                rows = {r[0]: r[1] for r in cur.fetchall()}
            grammar = rows[with_grammar.name]
            assert grammar is not None
            # psycopg2 returns JSONB as a parsed dict.
            assert grammar["build_template"] == "https://example.com/venta/{geography}/"
            assert "(?<geography>" in grammar["parse_pattern"]
            assert grammar["params"]["geography"]["source"] == "profile"
            # A connector without a grammar: NULL.
            assert rows[without.name] is None
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, names)

    def test_publishes_home_url(self, pg_conn):
        """Issue #515: home_url reaches the registry. A connector with an
        override_host_suffix gets the derived https://www.{suffix}; one that sets
        an explicit home_url class attribute gets that verbatim; one with neither
        leaves the column NULL."""
        _apply_schema(pg_conn)

        class _ExplicitHome(DummyConnector):
            home_url = "https://inmuebles.example.com/inmuebles/s/"

        derived = _OverrideConnector(name="test-home-derived")  # override_host_suffix
        explicit = _ExplicitHome(name="test-home-explicit")
        none = DummyConnector(name="test-home-none")
        names = [derived.name, explicit.name, none.name]
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [derived, explicit, none]
        try:
            orchestrator.sync_connector_registry(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT connector_name, home_url "
                    "  FROM connector_registry WHERE connector_name = ANY(%s)",
                    (names,),
                )
                rows = {r[0]: r[1] for r in cur.fetchall()}
            assert rows[derived.name] == "https://www.example.com"
            assert rows[explicit.name] == "https://inmuebles.example.com/inmuebles/s/"
            assert rows[none.name] is None
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

    def test_new_connector_is_seeded_disabled_and_ingests_nothing(self, pg_conn):
        """Issue #100 review: a brand-new connector must be born DISABLED.

        Before this, the very first startup that published a connector to the
        management UI was also the run that downloaded a whole city, because
        `_scopes_for_connector` treats a missing connector_config row as
        enabled (issue #71's default). The owner's requirement is the
        opposite: "todos desactivados hasta que defina los filtros".
        """
        _apply_schema(pg_conn)
        connector = DummyConnector(name="test-registry-born-disabled")
        original = list(orchestrator.CONNECTORS)
        try:
            orchestrator.CONNECTORS[:] = [connector]
            orchestrator.sync_connector_registry(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT enabled FROM connector_config WHERE connector_name = %s",
                    (connector.name,),
                )
                row = cur.fetchone()
            assert row is not None, "sync must seed an explicit config row"
            assert row[0] is False, "a newly discovered connector must start disabled"

            # And it genuinely doesn't run: the scope resolver reports it
            # disabled, which is what makes run_all_connectors skip it.
            scopes, enabled, min_refetch_override = orchestrator._scopes_for_connector(
                pg_conn,
                connector.name,
                [ConnectorScope(center=(40.4168, -3.7038), radius_km=10)],
                {},
            )
            assert enabled is False
            assert scopes == []
            assert min_refetch_override is None

            # An operator's later choice is never clobbered by a restart.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE connector_config SET enabled = true WHERE connector_name = %s",
                    (connector.name,),
                )
            pg_conn.commit()
            orchestrator.sync_connector_registry(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT enabled FROM connector_config WHERE connector_name = %s",
                    (connector.name,),
                )
                assert cur.fetchone()[0] is True, (
                    "ON CONFLICT DO NOTHING must preserve an operator's choice"
                )
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, [connector.name])

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
