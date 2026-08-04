"""Cimenta2 sitemap worklist-seeding tests (issue #260).

Two layers, matching the house pattern (test_capture_worklist.py):

1. `parse_worklist_rows` unit tests — pure, no DB, no network. Driven by the
   same real-capture sitemap fixtures the connector tests use, so the parse is
   pinned independently of the HTTP and upsert layers.
2. End-to-end seeding against real Postgres (pg_conn, skipped if unavailable):
   an injected fetch returns fixture XML; `seed_cimenta2_worklist` upserts
   pending `sitemap` rows, is idempotent on a second run, and the seed-trigger
   poll path (`process_pending_seed_trigger`) records done/failed correctly.

Discovery-only by construction: the fetch is injected, so no test here makes a
network request, and nothing touches a detail page or the guest RPC.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from etl import worklist_seed
from etl.capture import worklist_match_key

_FIXTURES = Path(__file__).parent / "fixtures"
_INDEX_XML = (_FIXTURES / "cimenta2_sample_sitemap_index.xml").read_text(
    encoding="utf-8"
)
_ACTIVO_XML = (_FIXTURES / "cimenta2_sample_sitemap_activo.xml").read_text(
    encoding="utf-8"
)
_INTERSTITIAL = (_FIXTURES / "cimenta2_sample_interstitial.html").read_text(
    encoding="utf-8"
)
_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _fake_fetch(index_xml: str, child_xml: str):
    """A fetcher that serves `index_xml` for the sitemap index URL and
    `child_xml` for anything else (the child sitemap)."""

    def fetch(url: str) -> str:
        return index_xml if url == worklist_seed._SITEMAP_INDEX_URL else child_xml

    return fetch


# ── Pure parse ─────────────────────────────────────────────────────────────


class TestParseWorklistRows:
    def test_parses_every_asset_url(self):
        rows = worklist_seed.parse_worklist_rows(_ACTIVO_XML)
        # The trimmed real fixture carries 14 ga-activo asset entries.
        assert len(rows) == 14
        first = rows[0]
        assert first["url"] == (
            "https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/"
            "a0v3X00000eYxMdQAK/207"
        )
        assert first["external_id"] == "a0v3X00000eYxMdQAK"
        assert first["match_key"] == worklist_match_key(first["url"])
        # match_key drops scheme; host has no www to strip here.
        assert first["match_key"] == (
            "inmuebles.cimenta2.com/inmuebles/s/ga-activo/a0v3X00000eYxMdQAK/207"
        )

    def test_every_row_has_the_three_expected_keys(self):
        rows = worklist_seed.parse_worklist_rows(_ACTIVO_XML)
        for r in rows:
            assert set(r) == {"url", "match_key", "external_id"}
            assert r["url"] and r["match_key"] and r["external_id"]

    def test_non_asset_document_yields_nothing(self):
        # An error/interstitial page has no recognisable ga-activo <loc>s.
        assert worklist_seed.parse_worklist_rows(_INTERSTITIAL) == []


# ── End-to-end seeding against real Postgres ────────────────────────────────


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _cleanup(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM capture_worklist WHERE source_portal = 'cimenta2'")
        cur.execute(
            "DELETE FROM capture_worklist_seed_trigger WHERE source_portal = 'cimenta2'"
        )
        cur.execute(
            "DELETE FROM capture_worklist_seed_trigger WHERE source_portal = 'nope'"
        )
    conn.commit()


def _worklist_count(conn) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM capture_worklist WHERE source_portal = 'cimenta2'"
        )
        return cur.fetchone()[0]


class TestSeedCimenta2Worklist:
    def test_seeds_pending_sitemap_rows_and_is_idempotent(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            fetch = _fake_fetch(_INDEX_XML, _ACTIVO_XML)

            added = worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=fetch)
            assert added == 14
            assert _worklist_count(pg_conn) == 14

            # Every seeded row is a pending, sitemap-sourced cimenta2 row with a
            # non-null external_id (the Salesforce record id from the slug).
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, added_via, external_id FROM capture_worklist "
                    "WHERE source_portal = 'cimenta2'"
                )
                for status, added_via, external_id in cur.fetchall():
                    assert status == "pending"
                    assert added_via == "sitemap"
                    assert external_id and external_id.startswith("a0v")

            # Re-seeding the same catalogue adds nothing and does not duplicate.
            again = worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=fetch)
            assert again == 0
            assert _worklist_count(pg_conn) == 14
        finally:
            _cleanup(pg_conn)

    def test_unusable_sitemap_raises_rather_than_seeding_empty(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            # Child sitemap comes back as an interstitial: no asset URLs.
            fetch = _fake_fetch(_INDEX_XML, _INTERSTITIAL)
            with pytest.raises(ValueError):
                worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=fetch)
            assert _worklist_count(pg_conn) == 0
        finally:
            _cleanup(pg_conn)


class TestProcessSeedTrigger:
    def _insert_trigger(self, conn, portal: str) -> int:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO capture_worklist_seed_trigger (source_portal) "
                "VALUES (%s) RETURNING id",
                (portal,),
            )
            tid = cur.fetchone()[0]
        conn.commit()
        return tid

    def _trigger_row(self, conn, tid: int):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status, added_count, error_msg FROM "
                "capture_worklist_seed_trigger WHERE id = %s",
                (tid,),
            )
            return cur.fetchone()

    def test_pending_trigger_runs_seed_and_marks_done(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            tid = self._insert_trigger(pg_conn, "cimenta2")
            fetch = _fake_fetch(_INDEX_XML, _ACTIVO_XML)

            processed = worklist_seed.process_pending_seed_trigger(pg_conn, fetch=fetch)
            assert processed == tid

            status, added_count, error_msg = self._trigger_row(pg_conn, tid)
            assert status == "done"
            assert added_count == 14
            assert error_msg is None
            assert _worklist_count(pg_conn) == 14

            # Nothing pending now.
            assert (
                worklist_seed.process_pending_seed_trigger(pg_conn, fetch=fetch) is None
            )
        finally:
            _cleanup(pg_conn)

    def test_unknown_portal_marks_trigger_failed(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            tid = self._insert_trigger(pg_conn, "nope")
            processed = worklist_seed.process_pending_seed_trigger(pg_conn)
            assert processed == tid
            status, _added, error_msg = self._trigger_row(pg_conn, tid)
            assert status == "failed"
            assert error_msg is not None
        finally:
            _cleanup(pg_conn)
