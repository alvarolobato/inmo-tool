"""`publish_search_previews` (issue #478 P4).

Real PostgreSQL via the pg_conn fixture — the whole point is what lands in
`connector_search_preview`. Covers: an idempotent per-(profile × connector)
upsert, a refresh after a profile's scope is edited, pruning when a profile is
archived (soft — which does NOT fire the FK cascade), and the FK cascade on a
hard profile delete.
"""

from __future__ import annotations

import json
from pathlib import Path

from etl import orchestrator
from etl.connectors.base import ConnectorScope, SearchPreview
from etl.tests.fixtures.dummy_connector import DummyConnector

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


class _PreviewConnector(DummyConnector):
    """A connector whose preview URL encodes the scope's center, so a test can
    prove the published preview reflects the CURRENT scope after an edit."""

    def search_previews(self, scope: ConnectorScope) -> list[SearchPreview]:
        return [
            SearchPreview(
                label=f"prev {scope.center}",
                url=f"https://example.com/{scope.center}",
                kind="search_page",
                tunable=True,
            )
        ]


def _make_profile(conn, name: str, center: list[float], radius_km: float) -> int:
    scope = {"geography": {"type": "radius", "center": center, "radius_km": radius_km}}
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO search_profile (name, scope, thesis_params) "
            "VALUES (%s, %s::jsonb, '{}'::jsonb) RETURNING id",
            (name, json.dumps(scope)),
        )
        pid = cur.fetchone()[0]
    conn.commit()
    return pid


def _rows_for(conn, profile_id: int) -> dict[str, tuple]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT connector, previews, computed_at "
            "  FROM connector_search_preview WHERE profile_id = %s",
            (profile_id,),
        )
        return {r[0]: r for r in cur.fetchall()}


def _cleanup(conn, profile_ids: list[int]) -> None:
    with conn.cursor() as cur:
        for pid in profile_ids:
            cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
    conn.commit()


class TestPublishSearchPreviews:
    def test_upserts_one_row_per_profile_connector_and_is_idempotent(self, pg_conn):
        _apply_schema(pg_conn)
        connector = _PreviewConnector(name="test-preview-a")
        pid = _make_profile(pg_conn, "p4-publish-idem", [37.3891, -5.9845], 5)
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [connector]
        try:
            orchestrator.publish_search_previews(pg_conn)
            rows = _rows_for(pg_conn, pid)
            assert set(rows) == {connector.name}
            previews = rows[connector.name][1]
            assert isinstance(previews, list) and len(previews) == 1
            assert previews[0]["url"] == "https://example.com/(37.3891, -5.9845)"
            first_computed = rows[connector.name][2]

            # Running again is an upsert: still one row, computed_at refreshed.
            orchestrator.publish_search_previews(pg_conn)
            rows2 = _rows_for(pg_conn, pid)
            assert set(rows2) == {connector.name}
            assert rows2[connector.name][2] >= first_computed
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, [pid])

    def test_refreshes_after_scope_edit(self, pg_conn):
        _apply_schema(pg_conn)
        connector = _PreviewConnector(name="test-preview-b")
        pid = _make_profile(pg_conn, "p4-publish-edit", [40.4168, -3.7038], 5)
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [connector]
        try:
            orchestrator.publish_search_previews(pg_conn)
            before = _rows_for(pg_conn, pid)[connector.name][1][0]["url"]
            assert before == "https://example.com/(40.4168, -3.7038)"

            # Owner edits the profile's scope → next publish reflects it.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE search_profile SET scope = %s::jsonb WHERE id = %s",
                    (
                        json.dumps(
                            {
                                "geography": {
                                    "type": "radius",
                                    "center": [37.3891, -5.9845],
                                    "radius_km": 8,
                                }
                            }
                        ),
                        pid,
                    ),
                )
            pg_conn.commit()

            orchestrator.publish_search_previews(pg_conn)
            after = _rows_for(pg_conn, pid)[connector.name][1][0]["url"]
            assert after == "https://example.com/(37.3891, -5.9845)"
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, [pid])

    def test_prunes_previews_when_profile_archived(self, pg_conn):
        _apply_schema(pg_conn)
        connector = _PreviewConnector(name="test-preview-c")
        pid = _make_profile(pg_conn, "p4-publish-archive", [37.3891, -5.9845], 5)
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [connector]
        try:
            orchestrator.publish_search_previews(pg_conn)
            assert _rows_for(pg_conn, pid)  # present

            # Soft-archive does NOT fire the FK cascade; the publish prune must.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE search_profile SET archived_at = NOW() WHERE id = %s",
                    (pid,),
                )
            pg_conn.commit()

            orchestrator.publish_search_previews(pg_conn)
            assert _rows_for(pg_conn, pid) == {}, (
                "archived profile's previews must be pruned"
            )
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, [pid])

    def test_fk_cascade_on_hard_delete(self, pg_conn):
        _apply_schema(pg_conn)
        connector = _PreviewConnector(name="test-preview-d")
        pid = _make_profile(pg_conn, "p4-publish-cascade", [37.3891, -5.9845], 5)
        original = list(orchestrator.CONNECTORS)
        orchestrator.CONNECTORS[:] = [connector]
        try:
            orchestrator.publish_search_previews(pg_conn)
            assert _rows_for(pg_conn, pid)

            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM search_profile WHERE id = %s", (pid,))
            pg_conn.commit()
            assert _rows_for(pg_conn, pid) == {}
        finally:
            orchestrator.CONNECTORS[:] = original
            _cleanup(pg_conn, [pid])
