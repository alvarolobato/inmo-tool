"""Guided-worklist correlation tests (issue #237).

Two layers:

1. `worklist_match_key` unit tests — pure, no DB. The SAME (input -> expected)
   cases are asserted in dashboard/lib/__tests__/worklist.test.ts against the
   TypeScript `worklistMatchKey`, so the two implementations that must agree
   (Python correlates at capture time, TS canonicalises at seed time) are
   pinned to one shared truth table. Keep the two lists in step.

2. End-to-end correlation against real Postgres (pg_conn, skipped if
   unavailable): a worklist URL -> extension capture -> aliseda mapping ->
   property/listing row -> worklist row flips to 'captured'. Plus the failure
   path and the free-browse (not-on-worklist) path.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from etl import capture
from etl.capture import worklist_match_key

# ── Shared match-key truth table (mirror of worklist.test.ts) ──────────────
# (raw url, expected canonical match key). host lowercased + www stripped;
# path keeps its case (asset ids can be case-sensitive); trailing slash,
# scheme, query and fragment dropped.
MATCH_KEY_CASES = [
    (
        "https://www.alisedainmobiliaria.com/inmueble/ANT1",
        "alisedainmobiliaria.com/inmueble/ANT1",
    ),
    (
        "http://alisedainmobiliaria.com/inmueble/ANT1/",
        "alisedainmobiliaria.com/inmueble/ANT1",
    ),
    (
        "https://www.alisedainmobiliaria.com/inmueble/ANT1?utm_source=x#gallery",
        "alisedainmobiliaria.com/inmueble/ANT1",
    ),
    (
        "https://WWW.Idealista.com/inmueble/106387165/",
        "idealista.com/inmueble/106387165",
    ),
    (
        "  https://alisedainmobiliaria.com/inmueble/ANT2  ",
        "alisedainmobiliaria.com/inmueble/ANT2",
    ),
    ("not a url", ""),
]


class TestWorklistMatchKey:
    @pytest.mark.parametrize("url,expected", MATCH_KEY_CASES)
    def test_canonicalisation(self, url, expected):
        assert worklist_match_key(url) == expected


# ── End-to-end correlation ─────────────────────────────────────────────────

_FIXTURES = Path(__file__).parent / "fixtures"
_DETAIL_HTML = (_FIXTURES / "aliseda_sample_detail.html").read_text(encoding="utf-8")
_SHELL_HTML = (_FIXTURES / "aliseda_sample_shell.html").read_text(encoding="utf-8")
_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"
_URL = "https://www.alisedainmobiliaria.com/inmueble/ANT99900011122"
_EXTERNAL_ID = "ANT99900011122"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _cleanup(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM capture_worklist WHERE source_portal = 'aliseda'")
        cur.execute(
            "DELETE FROM extension_capture WHERE url LIKE %s",
            ("%alisedainmobiliaria%",),
        )
        cur.execute(
            "SELECT property_id FROM listing WHERE source = 'aliseda' AND external_id = %s",
            (_EXTERNAL_ID,),
        )
        row = cur.fetchone()
        cur.execute(
            "DELETE FROM listing WHERE source = 'aliseda' AND external_id = %s",
            (_EXTERNAL_ID,),
        )
        if row is not None:
            cur.execute("DELETE FROM property WHERE id = %s", (row[0],))
    conn.commit()


def _seed_worklist(conn, url: str, status: str = "pending") -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO capture_worklist (url, match_key, source_portal, status) "
            "VALUES (%s, %s, 'aliseda', %s) RETURNING id",
            (url, worklist_match_key(url), status),
        )
        wid = cur.fetchone()[0]
    conn.commit()
    return wid


def _insert_capture(conn, url: str, html: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO extension_capture (url, html) VALUES (%s, %s) RETURNING id",
            (url, html),
        )
        cid = cur.fetchone()[0]
    conn.commit()
    return cid


def _worklist_row(conn, wid: int):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, matched_capture_id FROM capture_worklist WHERE id = %s",
            (wid,),
        )
        return cur.fetchone()


class TestWorklistCorrelation:
    def test_successful_capture_marks_worklist_row_captured(self, pg_conn):
        """The whole point of #237: a worklist URL, once captured, flips to
        'captured' and points at the capture that satisfied it — AND the
        listing lands in property/listing through the normal path (an
        aliseda-source row, visible to dedup like any other)."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            # Seed the worklist with a cosmetically-different URL (trailing
            # slash) to prove match-key correlation tolerates it.
            wid = _seed_worklist(pg_conn, _URL + "/")
            cid = _insert_capture(pg_conn, _URL, _DETAIL_HTML)

            assert capture.process_pending_captures(pg_conn) == 1

            status, matched = _worklist_row(pg_conn, wid)
            assert status == "captured"
            assert matched == cid

            # Real aliseda listing exists, reachable exactly like any other.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT l.current_price, p.rooms, p.m2_built, p.city "
                    "FROM listing l JOIN property p ON p.id = l.property_id "
                    "WHERE l.source = 'aliseda' AND l.external_id = %s",
                    (_EXTERNAL_ID,),
                )
                lrow = cur.fetchone()
            assert lrow is not None
            assert lrow[1] == 2  # rooms
            assert lrow[3] == "Estepona"  # city
        finally:
            _cleanup(pg_conn)

    def test_failed_capture_marks_worklist_row_failed(self, pg_conn):
        """A capture that fails to parse (here: an unrecognised-host URL that
        still cosmetically matches a seeded worklist row) marks the worklist
        row 'failed', so the owner sees it needs another attempt."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        # A URL whose host is NOT a capture connector -> _process_one fails it.
        bad_url = "https://www.alisedainmobiliaria.com.evil.example/inmueble/ANTX"
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM capture_worklist WHERE url = %s", (bad_url,))
        pg_conn.commit()
        try:
            wid = _seed_worklist(pg_conn, bad_url)
            _insert_capture(pg_conn, bad_url, "<html></html>")
            capture.process_pending_captures(pg_conn)

            status, matched = _worklist_row(pg_conn, wid)
            assert status == "failed"
            assert matched is None
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM capture_worklist WHERE url = %s", (bad_url,))
            pg_conn.commit()
            _cleanup(pg_conn)

    def test_free_browse_capture_not_on_worklist_still_processes(self, pg_conn):
        """A capture whose URL is on NO worklist row processes normally — the
        worklist is a guide, not a gate (issue #237 §1). Nothing to correlate,
        no error."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            cid = _insert_capture(pg_conn, _URL, _DETAIL_HTML)
            assert capture.process_pending_captures(pg_conn) == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM extension_capture WHERE id = %s", (cid,)
                )
                assert cur.fetchone()[0] == "done"
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = 'aliseda' "
                    "AND external_id = %s",
                    (_EXTERNAL_ID,),
                )
                assert cur.fetchone()[0] == 1
        finally:
            _cleanup(pg_conn)

    def test_capture_does_not_downgrade_already_captured_worklist_row(self, pg_conn):
        """A later failed capture of the same listing must not flip an
        already-'captured' worklist row back to 'failed'."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            wid = _seed_worklist(pg_conn, _URL, status="captured")
            # A failing capture for the same match-key.
            _insert_capture(pg_conn, _URL, "<html>broken shell</html>")
            # The shell "parses" (aliseda normalize is lenient) so it actually
            # succeeds — to force a real 'failed', use an unrecognised host that
            # shares the match key is impossible; instead assert the guard via
            # a direct correlate call.
            capture._correlate_worklist(pg_conn, _URL, "failed", None)
            status, _ = _worklist_row(pg_conn, wid)
            assert status == "captured"  # unchanged — guard held
        finally:
            _cleanup(pg_conn)
