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


# ── Reseed reconciliation (issue #273) ──────────────────────────────────────

# Three real ga-activo assets (verbatim ids/refs from the live-capture fixture),
# used as a small, controllable catalogue so a reseed can drop or restore one.
_ASSET_A = ("a0v3X00000eYxMdQAK", "207")
_ASSET_B = ("a0v3X00000eZ2b6QAC", "121")
_ASSET_C = ("a0v3X00000eYvmwQAC", "1263")


def _activo_xml(assets: list[tuple[str, str]]) -> str:
    """Build a minimal ga-activo child sitemap for the given (record_id, ref)
    assets — same shape iter_locs/parse_asset_url read, so the seed path treats
    it exactly like the real trimmed fixture."""
    locs = "\n".join(
        "  <url><loc>https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/"
        f"{rid}/{ref}</loc></url>"
        for rid, ref in assets
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{locs}\n</urlset>\n"
    )


def _asset_key(asset: tuple[str, str]) -> str:
    rid, ref = asset
    return worklist_match_key(
        f"https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/{rid}/{ref}"
    )


def _status_of(conn, asset: tuple[str, str]) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status FROM capture_worklist WHERE match_key = %s",
            (_asset_key(asset),),
        )
        row = cur.fetchone()
    return row[0] if row is not None else None


class TestReseedReconciliation:
    def test_reseed_marks_removed_url_stale(self, pg_conn):
        """EC-1: a listing that drops out of the sitemap between reseeds flips
        from 'pending' to 'stale' — the other still-present rows are untouched.

        Revert-and-confirm-fail guard: delete the reconciliation call in
        seed_cimenta2_worklist and the removed URL stays 'pending', so the
        `stale` assertion below fails.
        """
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            seed = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A, _ASSET_B, _ASSET_C]))
            assert worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=seed) == 3
            assert _status_of(pg_conn, _ASSET_C) == "pending"

            # Reseed with C removed from the sitemap.
            reseed = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A, _ASSET_B]))
            # No NEW rows on a reseed of an already-seeded subset.
            assert worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=reseed) == 0

            assert _status_of(pg_conn, _ASSET_C) == "stale"
            assert _status_of(pg_conn, _ASSET_A) == "pending"
            assert _status_of(pg_conn, _ASSET_B) == "pending"
            assert _worklist_count(pg_conn) == 3  # staled, never deleted
        finally:
            _cleanup(pg_conn)

    def test_reseed_is_idempotent_on_already_stale_rows(self, pg_conn):
        """Running the same reduced reseed twice leaves an already-'stale' row
        stale — reconciliation only touches 'pending' rows, so a second pass is
        a no-op, never an error or a status flip-flop."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            seed = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A, _ASSET_B, _ASSET_C]))
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=seed)
            reseed = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A, _ASSET_B]))
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=reseed)
            assert _status_of(pg_conn, _ASSET_C) == "stale"
            # Second identical reseed: C stays stale, no exception.
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=reseed)
            assert _status_of(pg_conn, _ASSET_C) == "stale"
        finally:
            _cleanup(pg_conn)

    def test_reappeared_stale_url_returns_to_pending(self, pg_conn):
        """A previously-'stale' listing that comes back into the sitemap is
        resurrected to 'pending' — a relisted property must re-enter the backlog
        rather than stay stuck stale forever."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            full = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A, _ASSET_B, _ASSET_C]))
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=full)
            reduced = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A, _ASSET_B]))
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=reduced)
            assert _status_of(pg_conn, _ASSET_C) == "stale"

            # C reappears in the sitemap.
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=full)
            assert _status_of(pg_conn, _ASSET_C) == "pending"
        finally:
            _cleanup(pg_conn)

    def test_reconcile_never_touches_captured_or_skipped_rows(self, pg_conn):
        """Only 'pending' rows go stale on removal. A 'captured' row keeps its
        capture history and a 'skipped' row keeps the owner's choice even when
        their listing has left the sitemap — those states are never rewritten to
        'stale'."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            full = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A, _ASSET_B, _ASSET_C]))
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=full)
            # A is captured, B is skipped by the owner.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE capture_worklist SET status = 'captured' WHERE match_key = %s",
                    (_asset_key(_ASSET_A),),
                )
                cur.execute(
                    "UPDATE capture_worklist SET status = 'skipped' WHERE match_key = %s",
                    (_asset_key(_ASSET_B),),
                )
            pg_conn.commit()

            # Reseed with ALL of A, B, C gone from the sitemap.
            empty_like = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_C]))
            # Only C was pending -> it goes stale; A/B keep their states.
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=empty_like)
            # Now drop C too.
            gone = _fake_fetch(_INDEX_XML, _activo_xml([_ASSET_A]))
            worklist_seed.seed_cimenta2_worklist(pg_conn, fetch=gone)

            assert _status_of(pg_conn, _ASSET_A) == "captured"
            assert _status_of(pg_conn, _ASSET_B) == "skipped"
            assert _status_of(pg_conn, _ASSET_C) == "stale"
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
