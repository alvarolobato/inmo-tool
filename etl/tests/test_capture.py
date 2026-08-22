"""Integration tests for extension-capture processing (issue #75).

Real PostgreSQL via the pg_conn fixture (skipped if unavailable, per
conftest.py). The point of this suite is proving EC-2 from issue #75: a
captured listing must land in `property`/`listing` through the exact same
persistence path (etl.orchestrator._upsert_canonical_listing) an automated
connector's fetch would use — no special-cased bypass — so it's
automatically visible to dedup/hard-filtering/the dashboard exactly like
any other listing.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg2
import pytest

from etl import capture
from etl.connectors import hipoges as hipoges_module

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"
_FIXTURE_HTML = (
    Path(__file__).parent / "fixtures" / "idealista_sample_detail.html"
).read_text(encoding="utf-8")
_FIXTURE_URL = "https://www.idealista.com/inmueble/106387165/"


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _cleanup(conn, external_id: str = "106387165") -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM extension_capture WHERE url = %s", (_FIXTURE_URL,))
        cur.execute(
            "SELECT property_id FROM listing WHERE source = 'idealista' AND external_id = %s",
            (external_id,),
        )
        row = cur.fetchone()
        cur.execute(
            "DELETE FROM listing WHERE source = 'idealista' AND external_id = %s",
            (external_id,),
        )
        if row is not None:
            cur.execute("DELETE FROM property WHERE id = %s", (row[0],))
    conn.commit()


def _insert_pending(conn, url: str, html: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO extension_capture (url, html) VALUES (%s, %s) RETURNING id",
            (url, html),
        )
        capture_id = cur.fetchone()[0]
    conn.commit()
    return capture_id


def _cleanup_url(conn, url: str, external_id: str) -> None:
    """Scoped teardown for issue #690's tests. The module-level `_cleanup`
    only deletes `extension_capture` rows for the shared `_FIXTURE_URL`, so
    it hits `extension_capture_listing_id_fkey` for any test using its own
    URL — the withdrawal path deliberately links the capture row to the
    listing it withdrew. Delete captures (and the worklist row) first, then
    the listing, then its property."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
        cur.execute("DELETE FROM capture_worklist WHERE url = %s", (url,))
        cur.execute(
            "SELECT property_id FROM listing "
            "WHERE source = 'idealista' AND external_id = %s",
            (external_id,),
        )
        row = cur.fetchone()
        cur.execute(
            "DELETE FROM listing WHERE source = 'idealista' AND external_id = %s",
            (external_id,),
        )
        if row is not None:
            cur.execute("DELETE FROM property WHERE id = %s", (row[0],))
    conn.commit()


class TestCaptureConnectorRegistration:
    """DB-free: the capture registry recognises each supported portal's detail
    URL and hands it to the right connector with the right external_id. This is
    the check that fails with "No capture-capable connector recognizes this URL"
    when a portal is captured before its connector is registered (issue #271)."""

    def test_altamira_detail_url_resolves(self):
        url = (
            "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/"
            "segunda-mano/9186_1001_PE0001/375859/1"
        )
        resolved = capture._connector_for_url(url)
        assert resolved is not None
        connector, external_id = resolved
        assert connector.name == "altamira"
        assert external_id == "375859"

    def test_hipoges_detail_url_resolves(self):
        url = "https://realestate.hipoges.com/es/detail/99001"
        resolved = capture._connector_for_url(url)
        assert resolved is not None
        connector, external_id = resolved
        assert connector.name == "hipoges"
        assert external_id == "99001"

    def test_all_expected_capture_hosts_registered(self):
        assert set(capture._CAPTURE_CONNECTORS) == {
            "idealista.com",
            "alisedainmobiliaria.com",
            "altamirainmuebles.com",
            "realestate.hipoges.com",
        }


class TestCapturePortalListsStayInSync:
    """PR #548 review (B1): a Hipoges pass updated etl.capture.EXTENSION_CAPTURE_PORTALS
    and dashboard/lib/worklist.ts CAPTURE_PORTALS but missed init.sql's one-time
    cleanup DELETE — which re-applies on EVERY ETL boot — so every Hipoges
    capture_worklist row was silently deleted on the next restart (issue #454's
    "0/N pending forever" bug, reintroduced). The comment above that DELETE has
    said "keep the three [lists] in step" since #454 and drifted anyway the first
    time a fourth portal was added — so this test checks it mechanically instead
    of trusting the comment."""

    def test_delete_list_matches_capture_portal_lists(self):
        sql = _SCHEMA_SQL.read_text(encoding="utf-8")
        m = re.search(
            r"DELETE FROM capture_worklist\s+WHERE source_portal NOT IN \(([^)]+)\)",
            sql,
        )
        assert m is not None, "capture_worklist cleanup DELETE not found in init.sql"
        sql_portals = {p.strip().strip("'") for p in m.group(1).split(",")}

        ts_path = (
            Path(__file__).parent.parent.parent / "dashboard" / "lib" / "worklist.ts"
        )
        ts_source = ts_path.read_text(encoding="utf-8")
        block_match = re.search(
            r"CAPTURE_PORTALS:[^=]*=\s*\[(.*?)\];", ts_source, re.DOTALL
        )
        assert block_match is not None, "CAPTURE_PORTALS array not found in worklist.ts"
        ts_portals = set(re.findall(r'portal:\s*"([a-z0-9_]+)"', block_match.group(1)))

        assert sql_portals == set(capture.EXTENSION_CAPTURE_PORTALS), (
            "init.sql's capture_worklist cleanup DELETE has drifted from "
            f"etl.capture.EXTENSION_CAPTURE_PORTALS: sql={sql_portals} "
            f"python={set(capture.EXTENSION_CAPTURE_PORTALS)}"
        )
        assert sql_portals == ts_portals, (
            "init.sql's capture_worklist cleanup DELETE has drifted from "
            f"dashboard/lib/worklist.ts CAPTURE_PORTALS: sql={sql_portals} "
            f"ts={ts_portals}"
        )
        assert set(capture.EXTENSION_CAPTURE_PORTALS) == ts_portals, (
            "etl.capture.EXTENSION_CAPTURE_PORTALS has drifted from "
            f"dashboard/lib/worklist.ts CAPTURE_PORTALS: python="
            f"{set(capture.EXTENSION_CAPTURE_PORTALS)} ts={ts_portals}"
        )


_SIGHTING_ID_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "sighting_ids.json"
_SIGHTING_ID_CASES = json.loads(_SIGHTING_ID_FIXTURE_PATH.read_text(encoding="utf-8"))


class TestSightingIdExtraction:
    """Issue #639 task 1's own acceptance criterion (unmet by the first pass,
    per the Opus review's C4 finding): a DB-free unit test on URL -> id
    extraction across idealista/aliseda/altamira/hipoges shapes, including
    the query-string / fragment / missing-trailing-slash variance a scraped
    `<a href>` can carry that the connectors' own `external_id_from_url`
    (calibrated for a real browser's `location.href`) does not tolerate on
    its own -- `_sighting_id_from_url` normalizes for exactly this
    (`_normalize_detail_path`) before calling it.

    Issue #639 review's own follow-up (a second Opus pass, post-merge of the
    C1-C4 fixes): this id-extraction RULE exists in TWO languages --
    `etl.capture._sighting_id_from_url` here and
    `dashboard/lib/capture-sightings.ts`'s `sightingIdFromUrl`, the one the
    REAL production write (`dashboard/lib/db/worklist.ts` `addWorklistUrls`)
    actually calls. A rule this important (it feeds #643/#645's expiry
    signal) drifting silently between two hand-maintained case lists is
    exactly the failure mode this project has already been bitten by twice
    in one week -- so both languages' suites read the SAME
    `etl/tests/fixtures/sighting_ids.json`, rather than each hard-coding its
    own copy of the cases. A shape one language accepts and the other
    rejects now fails a test instead of aging into a wrong expiry."""

    @pytest.mark.parametrize(
        "case",
        _SIGHTING_ID_CASES,
        ids=[c["case"] for c in _SIGHTING_ID_CASES],
    )
    def test_fixture_case(self, case):
        assert (
            capture._sighting_id_from_url(case["portal"], case["url"])
            == case["expected"]
        )

    def test_fixture_is_nonempty_and_covers_every_capture_portal(self):
        """A guard against the fixture itself silently losing coverage (e.g.
        a bad merge truncating the file) -- every capture-supported portal
        must have at least one case."""
        portals = {c["portal"] for c in _SIGHTING_ID_CASES}
        assert portals >= set(capture.EXTENSION_CAPTURE_PORTALS)
        assert len(_SIGHTING_ID_CASES) >= len(capture.EXTENSION_CAPTURE_PORTALS)

    def test_batch_extraction_dedupes_and_preserves_order(self):
        """`_sighting_ids_from_detail_urls` (the batch/list form
        `_record_sightings` actually calls) is a thin wrapper over
        `_sighting_id_from_url` per URL -- this is the ONE thing the fixture
        above can't cover (it's single-URL), so it gets its own small test:
        de-dupe across two different URL forms resolving to the same id, a
        dropped id doesn't break the ones around it, order is preserved."""
        urls = [
            "https://www.idealista.com/inmueble/11111/",
            # A different form of the SAME id -- must not double-count.
            "https://www.idealista.com/inmueble/11111?searchQueryId=x",
            # A hipoges 'gone' route mixed into an idealista list resolves to
            # nothing for the wrong portal anyway (no connector match) --
            # included to prove a dropped entry doesn't disturb order.
            "https://realestate.hipoges.com/es/detail/1/unavailable",
            "https://www.idealista.com/inmueble/22222/",
        ]
        assert capture._sighting_ids_from_detail_urls("idealista", urls) == [
            "11111",
            "22222",
        ]

    def test_unknown_portal_yields_nothing(self):
        assert capture._sighting_ids_from_detail_urls("cimenta2", ["/whatever"]) == []


class TestProcessPendingCaptures:
    def test_real_idealista_capture_flows_through_normal_persistence_path(
        self, pg_conn
    ):
        """EC-2: the captured listing must be a real row in `property`/
        `listing`, reachable the exact same way a Fotocasa/Milanuncios
        listing is — not a parallel/side-channel table only the extension
        UI can see."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)

            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, connector_name, property_id, listing_id, "
                    "fields_extracted, fields_available, title, price_display, "
                    "error_msg FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                row = cur.fetchone()
            (
                status,
                connector_name,
                property_id,
                listing_id,
                fields_extracted,
                fields_available,
                title,
                price_display,
                error_msg,
            ) = row

            assert status == "done", f"expected done, got {status} ({error_msg})"
            assert connector_name == "idealista"
            assert property_id is not None
            assert listing_id is not None
            assert fields_extracted > 0
            assert fields_available > fields_extracted  # some fields genuinely absent
            assert title == "Duplex for sale in Calle de Alcalá"
            assert price_display == "3,600,000 €"

            # The real proof: query property/listing directly, exactly as
            # the dashboard's candidate list (dashboard/lib/candidates.ts)
            # or the dedup engine would — no extension_capture join needed
            # to find this listing.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT l.id, l.source, l.external_id, l.current_price, "
                    "p.id, p.m2_built, p.rooms "
                    "FROM listing l JOIN property p ON p.id = l.property_id "
                    "WHERE l.source = 'idealista' AND l.external_id = %s",
                    ("106387165",),
                )
                listing_row = cur.fetchone()
            assert listing_row is not None
            assert listing_row[0] == listing_id
            assert listing_row[1] == "idealista"
            assert listing_row[4] == property_id
            assert listing_row[5] == 273  # m2_built
            assert listing_row[6] == 4  # rooms

            # Real coordinates from the embedded staticmap `center` param —
            # an earlier version of this connector incorrectly concluded no
            # coordinates exist anywhere on an Idealista page (Opus review,
            # PR #87); confirm the fix actually reaches the persisted row,
            # not just the connector's own unit tests.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT lat, lon FROM property WHERE id = %s", (property_id,)
                )
                lat, lon = cur.fetchone()
            assert lat is not None and lon is not None

            # Retention: the raw captured HTML is only useful transiently
            # (debugging a failed parse) — a 'done' row must not keep it
            # forever (Opus review, PR #87).
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT html FROM extension_capture WHERE id = %s", (capture_id,)
                )
                (stored_html,) = cur.fetchone()
            assert stored_html is None
        finally:
            _cleanup(pg_conn)

    def test_failed_capture_keeps_html_for_debugging(self, pg_conn):
        """Unlike a 'done' row, a 'failed' row's html is NOT nulled — it's
        the only diagnostic available for why parsing failed."""
        _apply_schema(pg_conn)
        url = "https://www.some-unsupported-portal.example/listing/1"
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
        pg_conn.commit()
        try:
            capture_id = _insert_pending(pg_conn, url, "<html>diagnostic</html>")
            capture.process_pending_captures(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, html FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, html = cur.fetchone()
            assert status == "failed"
            assert html == "<html>diagnostic</html>"
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
            pg_conn.commit()

    def test_javascript_scheme_url_rejected_defense_in_depth(self, pg_conn):
        """The dashboard's capture route already rejects a non-http(s)
        scheme at submission time, but etl/capture.py must not trust that
        it always will — a `javascript:` URL with a legitimate-looking
        hostname was verified end-to-end exploitable via a stored-XSS path
        if it ever reached `listing.url` (Opus review, PR #87)."""
        _apply_schema(pg_conn)
        url = "javascript://idealista.com/inmueble/1/%0aalert(1)"
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
        pg_conn.commit()
        try:
            capture_id = _insert_pending(pg_conn, url, "<html></html>")
            capture.process_pending_captures(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, error_msg FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, error_msg = cur.fetchone()
            assert status == "failed"
            assert error_msg is not None
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
            pg_conn.commit()

    def test_unrecognized_url_marks_failed_not_crashed(self, pg_conn):
        _apply_schema(pg_conn)
        url = "https://www.some-unsupported-portal.example/listing/1"
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
        pg_conn.commit()
        try:
            capture_id = _insert_pending(pg_conn, url, "<html></html>")
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, error_msg FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, error_msg = cur.fetchone()
            assert status == "failed"
            assert error_msg is not None
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
            pg_conn.commit()

    def test_reprocessing_pending_rows_is_idempotent_on_reinsert(self, pg_conn):
        """Capturing the same URL twice (the owner re-opens the same
        listing and clicks capture again) should update the existing
        listing in place, not create a duplicate property — same
        (source, external_id) UNIQUE constraint an automated connector
        revisit relies on."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            capture.process_pending_captures(pg_conn)
            _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = 'idealista' "
                    "AND external_id = %s",
                    ("106387165",),
                )
                count = cur.fetchone()[0]
            assert count == 1
        finally:
            _cleanup(pg_conn)

    def test_recapture_updates_in_place(self, pg_conn):
        """EC-3 (issue #273): re-capturing a URL already ingested with a CHANGED
        price updates the existing property/listing in place — it does NOT
        create a second property row. The second capture's price wins (COALESCE
        prefers the new non-None value), both extension_capture rows land 'done',
        and both point at the same listing_id.

        This locks down the capture→_upsert_canonical_listing correlation that
        was only correct-by-inspection before: reverting
        `_upsert_canonical_listing` to an unconditional INSERT (dropping its
        (source, external_id) lookup) would duplicate the property and flip the
        second capture's price assertion — every assertion below then fails.
        """
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        # Same listing, a later capture with a different asking price.
        second_html = _FIXTURE_HTML.replace(
            '<span class="txt-bold">3,600,000</span>',
            '<span class="txt-bold">3,750,000</span>',
        )
        assert second_html != _FIXTURE_HTML, "price-swap fixture must actually differ"
        try:
            first_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            assert capture.process_pending_captures(pg_conn) == 1
            second_id = _insert_pending(pg_conn, _FIXTURE_URL, second_html)
            assert capture.process_pending_captures(pg_conn) == 1

            # Exactly one property + one listing for this (source, external_id).
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT id, property_id, current_price FROM listing "
                    "WHERE source = 'idealista' AND external_id = '106387165'",
                )
                listing_rows = cur.fetchall()
            assert len(listing_rows) == 1, "re-capture must not duplicate the listing"
            listing_id, property_id, current_price = listing_rows[0]

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM property WHERE id = %s", (property_id,)
                )
                assert cur.fetchone()[0] == 1

            # The second capture's changed price won via COALESCE(new, old).
            assert int(current_price) == 3_750_000

            # Both captures processed 'done' and correlate to the SAME listing.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT id, status, listing_id FROM extension_capture "
                    "WHERE id = ANY(%s) ORDER BY id",
                    ([first_id, second_id],),
                )
                caps = cur.fetchall()
            assert len(caps) == 2
            for _cid, status, cap_listing_id in caps:
                assert status == "done"
                assert cap_listing_id == listing_id
        finally:
            _cleanup(pg_conn)

    def test_empty_queue_processes_nothing(self, pg_conn):
        _apply_schema(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (_FIXTURE_URL,))
        pg_conn.commit()
        processed = capture.process_pending_captures(pg_conn)
        assert processed == 0

    def test_capture_processes_when_crawl_disabled_but_capture_enabled(self, pg_conn):
        """Issue #263 (the core fix): a capture-only portal keeps the crawl
        `enabled = false` on purpose so its doomed, WAF-blocked automated
        crawl never runs (D-019) — but capture is its ONLY ingestion path, so
        that flag must NOT block capture processing. With `enabled = false`
        and `capture_enabled = true`, the capture must flow through to a real
        listing.

        This is the revert-and-confirm-it-fails guard for the decoupling: if
        the poller is reverted to gate on `enabled` (the pre-#263 behaviour),
        `processed` is 0, the capture stays `pending`, and no listing is
        ingested — every assertion below fails.
        """
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
        with pg_conn.cursor() as cur:
            # Crawl OFF, capture ON — exactly Idealista's intended state.
            cur.execute(
                "INSERT INTO connector_config (connector_name, enabled, capture_enabled) "
                "VALUES ('idealista', false, true) "
                "ON CONFLICT (connector_name) DO UPDATE SET "
                "enabled = false, capture_enabled = true"
            )
        pg_conn.commit()
        try:
            assert capture.process_pending_captures(pg_conn) == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM extension_capture WHERE id = %s", (capture_id,)
                )
                assert cur.fetchone()[0] == "done", (
                    "crawl-disabled but capture-enabled must process the "
                    "capture (issue #263) — the crawl flag must not gate it"
                )
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = 'idealista' "
                    "AND external_id = '106387165'"
                )
                assert cur.fetchone()[0] == 1, (
                    "the capture must reach a real listing even with the crawl disabled"
                )
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_config WHERE connector_name = 'idealista'"
                )
            pg_conn.commit()
            _cleanup(pg_conn)

    def test_capture_enabled_false_pauses_processing(self, pg_conn):
        """Issue #263: `capture_enabled = false` is the independent pause knob
        for a misbehaving capture connector (Fable's planning note). The crawl
        `enabled` flag is irrelevant to this — here it is even left `true` to
        prove `capture_enabled` alone gates processing. The capture must stay
        `pending` (not consumed or failed), and re-enabling capture must drain
        the same backlog.
        """
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
        with pg_conn.cursor() as cur:
            # Crawl ON, capture OFF — capture_enabled alone must gate.
            cur.execute(
                "INSERT INTO connector_config (connector_name, enabled, capture_enabled) "
                "VALUES ('idealista', true, false) "
                "ON CONFLICT (connector_name) DO UPDATE SET "
                "enabled = true, capture_enabled = false"
            )
        pg_conn.commit()
        try:
            assert capture.process_pending_captures(pg_conn) == 0

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM extension_capture WHERE id = %s", (capture_id,)
                )
                assert cur.fetchone()[0] == "pending", (
                    "a capture-paused connector's capture must stay queued, "
                    "not be consumed or failed — re-enabling processes it"
                )
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = 'idealista' "
                    "AND external_id = '106387165'"
                )
                assert cur.fetchone()[0] == 0, (
                    "nothing may be ingested while capture is paused"
                )

            # Re-enabling capture drains the same still-pending row.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE connector_config SET capture_enabled = true "
                    "WHERE connector_name = 'idealista'"
                )
            pg_conn.commit()

            assert capture.process_pending_captures(pg_conn) == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM extension_capture WHERE id = %s", (capture_id,)
                )
                assert cur.fetchone()[0] == "done"
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = 'idealista' "
                    "AND external_id = '106387165'"
                )
                assert cur.fetchone()[0] == 1
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_config WHERE connector_name = 'idealista'"
                )
            pg_conn.commit()
            _cleanup(pg_conn)

    def test_capture_enabled_default_true_and_operator_pause_survives_schema_reapply(
        self, pg_conn
    ):
        """Issue #263 (review of PR #278): init.sql is re-applied on EVERY ETL
        container startup (etl/main.py's _init_schema), so it must NOT contain a
        one-time `UPDATE ... SET capture_enabled = true` for the capture-capable
        portals — that would silently un-pause a connector an operator paused via
        the UI on the next redeploy (the exact footgun this PR removes).

        Two guarantees:
        1. Fresh row with no capture value => TRUE (the column's NOT NULL DEFAULT
           backfills every row when the column is added; a newly-seeded row
           inherits the same default). This is all the idealista/aliseda/cimenta2
           capture-enable intent needs — no migration UPDATE required.
        2. An operator's capture_enabled = false SURVIVES a re-apply of
           init.sql. If a re-asserting UPDATE were reintroduced, this fails.
        """
        _apply_schema(pg_conn)
        try:
            with pg_conn.cursor() as cur:
                # A row seeded like sync_connector_registry does (enabled only,
                # no capture_enabled) inherits the column default TRUE.
                cur.execute(
                    "INSERT INTO connector_config (connector_name, enabled) "
                    "VALUES ('idealista', false) "
                    "ON CONFLICT (connector_name) DO UPDATE SET enabled = false"
                )
            pg_conn.commit()
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT capture_enabled FROM connector_config "
                    "WHERE connector_name = 'idealista'"
                )
                assert cur.fetchone()[0] is True, (
                    "a freshly-seeded connector must default to capture_enabled=true "
                    "via the column default — no migration UPDATE needed"
                )

            # Operator pauses capture, then the container restarts (init.sql
            # re-applied). The pause must persist.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE connector_config SET capture_enabled = false "
                    "WHERE connector_name = 'idealista'"
                )
            pg_conn.commit()

            _apply_schema(pg_conn)  # simulate the next ETL boot re-applying schema

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT capture_enabled FROM connector_config "
                    "WHERE connector_name = 'idealista'"
                )
                assert cur.fetchone()[0] is False, (
                    "an operator's capture_enabled=false must survive a re-apply "
                    "of init.sql — init.sql must not re-assert it to true on boot"
                )
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_config WHERE connector_name = 'idealista'"
                )
            pg_conn.commit()


class TestUncalibratedConnectorRetainsHtml:
    """Opus review (PR #548, C3): a connector whose raw_extra reports
    selectors_calibrated=False must NOT have its html nulled on a 'done'
    row. normalize() never raises for an uncalibrated connector — every
    capture reaches 'done' — so without this, a future calibration task
    (#547's own plan: preserve the real captured HTML as a fixture, once
    the owner captures a real page) would be impossible: the HTML that
    landed in the DB would already be gone by the time anyone went looking
    for it.

    Hipoges itself is CALIBRATED now (#547/PR #657 — `_SELECTORS_CALIBRATED
    = True`), so it is no longer a live example of an uncalibrated
    connector and no other registered connector is either. This test
    monkeypatches Hipoges' own `_SELECTORS_CALIBRATED` flag back to False
    for its duration — reusing the real connector/capture path end to end
    (real host resolution, real `normalize()`) rather than standing up a
    separate stub connector class, while still proving the retention
    mechanism itself (keyed purely on `raw_extra["selectors_calibrated"]`,
    read fresh by `etl/capture.py` on every call) still works for whichever
    connector next ships in the uncalibrated state."""

    _URL = "https://realestate.hipoges.com/es/detail/99001"
    _HTML = (
        "<html><head><title>x</title>"
        '<meta property="og:title" content="Piso en venta"></head>'
        "<body><app-root></app-root></body></html>"
    )

    def _cleanup(self, conn):
        with conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (self._URL,))
            cur.execute(
                "SELECT property_id FROM listing WHERE source = 'hipoges' "
                "AND external_id = %s",
                ("99001",),
            )
            row = cur.fetchone()
            cur.execute(
                "DELETE FROM listing WHERE source = 'hipoges' AND external_id = %s",
                ("99001",),
            )
            if row is not None:
                cur.execute("DELETE FROM property WHERE id = %s", (row[0],))
        conn.commit()

    def test_uncalibrated_hipoges_capture_retains_html(self, pg_conn, monkeypatch):
        monkeypatch.setattr(hipoges_module, "_SELECTORS_CALIBRATED", False)
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, self._URL, self._HTML)

            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, html FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, stored_html = cur.fetchone()
            assert status == "done"
            assert stored_html == self._HTML, (
                "an uncalibrated connector's captured HTML must survive "
                "processing — a future calibration task needs it to build "
                "real fixtures"
            )
        finally:
            self._cleanup(pg_conn)

    def test_calibrated_hipoges_capture_now_nulls_html(self, pg_conn):
        """Control, the flip side of the test above: Hipoges is calibrated
        in this codebase TODAY (no monkeypatch), so its retained-HTML
        mechanism must now be OFF — proving #547 actually turned off
        retention for the connector it calibrated, not just that the
        mechanism works when forced on."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, self._URL, self._HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT html FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                (stored_html,) = cur.fetchone()
            assert stored_html is None
        finally:
            self._cleanup(pg_conn)

    def test_calibrated_idealista_capture_still_nulls_html(self, pg_conn):
        """Control: a CALIBRATED connector (Idealista — raw_extra carries no
        selectors_calibrated key at all) keeps the pre-existing behaviour of
        dropping html once processed — this PR must not weaken retention
        for connectors that were never uncalibrated in the first place."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT html FROM extension_capture WHERE id = %s", (capture_id,)
                )
                (stored_html,) = cur.fetchone()
            assert stored_html is None
        finally:
            _cleanup(pg_conn)


class TestRetainCaptureHtmlForParsing:
    """DB-free: `etl.config.retain_capture_html_for` (issue #654, D-150) parses
    the CSV connector-name list correctly, independent of any DB/capture
    plumbing. Reverting the parsing to a naive `value.split(",")` with no
    normalization would fail the whitespace/case/empty-entry cases below."""

    def test_default_is_empty(self, monkeypatch):
        monkeypatch.delenv("ETL_RETAIN_CAPTURE_HTML_FOR", raising=False)
        from etl.config import retain_capture_html_for

        assert retain_capture_html_for() == frozenset()

    def test_parses_and_normalizes_csv_list(self, monkeypatch):
        monkeypatch.setenv(
            "ETL_RETAIN_CAPTURE_HTML_FOR", " Idealista, hipoges ,, aliseda "
        )
        from etl.config import retain_capture_html_for

        assert retain_capture_html_for() == frozenset(
            {"idealista", "hipoges", "aliseda"}
        )

    def test_empty_string_is_no_retention(self, monkeypatch):
        monkeypatch.setenv("ETL_RETAIN_CAPTURE_HTML_FOR", "")
        from etl.config import retain_capture_html_for

        assert retain_capture_html_for() == frozenset()


class TestConfigDrivenHtmlRetention:
    """Issue #654 / D-150: `etl.retain_capture_html_for` lets an operator
    retain a CALIBRATED connector's captured HTML (Idealista is calibrated —
    see D-145) for diagnosis, independent of D-146's existing
    calibration-based retention (`TestUncalibratedConnectorRetainsHtml`
    above). Real Postgres + the real Idealista connector/fixture, same
    pattern as that suite's control test — only the config knob differs.
    """

    def test_idealista_html_retained_when_connector_is_listed(
        self, pg_conn, monkeypatch
    ):
        """The core fix: naming 'idealista' in the config keeps its HTML
        even though the connector is fully calibrated. Reverting the OR
        clause in etl/capture.py's `retain_html` computation to D-146's
        calibration check alone makes this fail."""
        monkeypatch.setenv("ETL_RETAIN_CAPTURE_HTML_FOR", "idealista")
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, html FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, stored_html = cur.fetchone()
            assert status == "done"
            assert stored_html == _FIXTURE_HTML, (
                "etl.retain_capture_html_for=idealista must retain the "
                "captured HTML for issue #654's diagnosis, even though "
                "Idealista is a calibrated connector"
            )
        finally:
            _cleanup(pg_conn)

    def test_idealista_html_still_nulled_when_retention_off(self, pg_conn, monkeypatch):
        """Off case (explicit, regardless of ambient environment): with the
        config knob unset, Idealista's HTML must still be nulled after
        processing — the default must be 'no extra retention', not
        accidentally-on."""
        monkeypatch.delenv("ETL_RETAIN_CAPTURE_HTML_FOR", raising=False)
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT html FROM extension_capture WHERE id = %s", (capture_id,)
                )
                (stored_html,) = cur.fetchone()
            assert stored_html is None, (
                "etl.retain_capture_html_for defaults to empty — Idealista's "
                "HTML must still be nulled after processing when it isn't "
                "explicitly named"
            )
        finally:
            _cleanup(pg_conn)

    def test_listing_a_different_connector_does_not_retain_idealista_html(
        self, pg_conn, monkeypatch
    ):
        """The list is per-connector, not a global switch: naming some other
        connector must not retain Idealista's HTML too."""
        monkeypatch.setenv("ETL_RETAIN_CAPTURE_HTML_FOR", "hipoges")
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT html FROM extension_capture WHERE id = %s", (capture_id,)
                )
                (stored_html,) = cur.fetchone()
            assert stored_html is None
        finally:
            _cleanup(pg_conn)


class TestCaptureTriggersMaterialize:
    """Issue #269: a browser-extension capture that lands a real listing must
    trigger the same dashboard re-materialize + scoring the connector
    orchestrator fires after a sweep (issue #94).

    Before this, captures were the one ingestion path that wrote new listings
    without ever notifying the dashboard — so an active profile silently went
    stale and under-reported (the live Estepona 0-matches incident) until a
    human hit `POST /api/profiles/materialize-all` by hand. Capture is the ONLY
    ingestion path for capture-only portals (Idealista, Aliseda), and a bulk
    one since the batch-capture-a-search-page feature (#262), which makes this
    gap load-bearing.

    `notify_materialize_all` itself (the cross-container HTTP round trip) is
    covered by TestMaterializeAllNotification in test_orchestrator.py; these
    tests prove the capture path *invokes* it — real Postgres for the ingest,
    the notifier stubbed to record calls.
    """

    def test_successful_capture_notifies_materialize_all(self, pg_conn, monkeypatch):
        """The core #269 fix: a capture that ingests a listing fires the
        dashboard re-materialize. Reverting the notify call in
        etl/capture.py makes this fail — proving the hook, not incidental
        behaviour, is what drives it."""
        from etl import orchestrator

        _apply_schema(pg_conn)
        _cleanup(pg_conn)

        calls: list[str] = []
        monkeypatch.setattr(
            orchestrator,
            "notify_materialize_all",
            lambda trigger="scheduler": calls.append(trigger) or True,
        )
        try:
            _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            assert calls == ["capture"], (
                "a capture that landed a listing must trigger exactly one "
                "materialize-all notification, tagged trigger='capture'"
            )
        finally:
            _cleanup(pg_conn)

    def test_notification_fires_once_per_batch_not_per_listing(
        self, pg_conn, monkeypatch
    ):
        """A batch that ingests several listings (the #262 batch-capture
        shape) must re-materialize ONCE, not once per listing —
        materialization is a full recompute of every profile, so per-listing
        calls would be pure waste."""
        from etl import orchestrator

        _apply_schema(pg_conn)
        _cleanup(pg_conn, external_id="106387165")
        second_url = "https://www.idealista.com/inmueble/106387165/?utm=x"

        calls: list[str] = []
        monkeypatch.setattr(
            orchestrator,
            "notify_materialize_all",
            lambda trigger="scheduler": calls.append(trigger) or True,
        )
        try:
            # Two captures of the same listing (idempotent upsert) is enough to
            # prove batch-level firing: both go through the ingest path, and the
            # notification must still fire exactly once for the batch.
            _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            _insert_pending(pg_conn, second_url, _FIXTURE_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 2
            assert len(calls) == 1, (
                "the materialize-all notification must fire once per batch that "
                "ingested something, never once per captured listing"
            )
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM extension_capture WHERE url = ANY(%s)",
                    ([_FIXTURE_URL, second_url],),
                )
            pg_conn.commit()
            _cleanup(pg_conn)

    def test_batch_that_ingests_nothing_does_not_notify(self, pg_conn, monkeypatch):
        """A batch of only failed/unrecognized captures must NOT re-materialize
        — nothing was ingested, so there is nothing new to fold into any
        profile, and a pointless full recompute of every profile should not
        fire."""
        from etl import orchestrator

        _apply_schema(pg_conn)
        url = "https://www.some-unsupported-portal.example/listing/1"
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
        pg_conn.commit()

        calls: list[str] = []
        monkeypatch.setattr(
            orchestrator,
            "notify_materialize_all",
            lambda trigger="scheduler": calls.append(trigger) or True,
        )
        try:
            _insert_pending(pg_conn, url, "<html></html>")
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            assert calls == [], (
                "an all-failures batch ingested no listing — it must not fire a "
                "materialize-all notification"
            )
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
            pg_conn.commit()

    def test_notification_failure_does_not_break_capture_processing(
        self, pg_conn, monkeypatch
    ):
        """The notify is best-effort: an exception from it must not turn an
        already-committed, successful capture batch into a failure."""
        from etl import orchestrator

        _apply_schema(pg_conn)
        _cleanup(pg_conn)

        def boom(trigger: str = "scheduler") -> bool:
            raise RuntimeError("dashboard notifier exploded")

        monkeypatch.setattr(orchestrator, "notify_materialize_all", boom)
        try:
            capture_id = _insert_pending(pg_conn, _FIXTURE_URL, _FIXTURE_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                (status,) = cur.fetchone()
            assert status == "done", (
                "a notifier failure must not roll back or fail the capture that "
                "already succeeded"
            )
        finally:
            _cleanup(pg_conn)


class TestListingPageCaptureReclassification:
    """Issue #292: capturing a SEARCH/results listing page is a clean outcome,
    NOT a failure. The poller recognises the listing-page URL, harvests its
    detail links into the batch-capture worklist (added_via='derived'), and
    marks the extension_capture row 'listing' — reserving 'failed' for
    genuinely broken DETAIL captures."""

    _LISTING_URL = "https://www.idealista.com/venta-viviendas/madrid-madrid/"
    _LISTING_HTML = (
        "<html><body>"
        "<a href='/inmueble/11111/'>Piso 1</a>"
        "<a href='/inmueble/22222/'>Piso 2</a>"
        # Duplicate of #11111 (title + photo anchor) — must de-dupe to one row.
        "<a href='https://www.idealista.com/inmueble/11111/'>Piso 1 foto</a>"
        # A non-detail link on the page — must be ignored.
        "<a href='/venta-viviendas/madrid-madrid/pagina-2'>Siguiente</a>"
        "</body></html>"
    )

    def _cleanup_listing(self, conn) -> None:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM extension_capture WHERE url = %s", (self._LISTING_URL,)
            )
            cur.execute(
                "DELETE FROM capture_worklist WHERE source_portal = 'idealista' "
                "AND added_via = 'derived'"
            )
        conn.commit()

    def test_listing_page_marked_listing_and_seeds_worklist(self, pg_conn):
        _apply_schema(pg_conn)
        self._cleanup_listing(pg_conn)
        try:
            capture_id = _insert_pending(pg_conn, self._LISTING_URL, self._LISTING_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, connector_name, error_msg, fields_extracted, "
                    "html, title FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, connector_name, error_msg, fields_extracted, html, title = (
                    cur.fetchone()
                )
            # A clean, informational outcome — never 'failed'.
            assert status == "listing"
            assert connector_name == "idealista"
            assert error_msg is None
            # Two unique detail links harvested (the duplicate + the non-detail
            # link are dropped).
            assert fields_extracted == 2
            assert "2" in (title or "")
            # HTML is dropped like a 'done' row — we've harvested what we need.
            assert html is None

            # The two detail links were seeded into the batch worklist as
            # 'derived' pending rows — routing toward the #262/#290 path.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT url, status, added_via FROM capture_worklist "
                    "WHERE source_portal = 'idealista' AND added_via = 'derived' "
                    "ORDER BY url"
                )
                rows = cur.fetchall()
            assert len(rows) == 2
            assert all(r[1] == "pending" and r[2] == "derived" for r in rows)
            assert any("11111" in r[0] for r in rows)
            assert any("22222" in r[0] for r in rows)
        finally:
            self._cleanup_listing(pg_conn)

    def test_listing_page_with_no_detail_links_is_still_clean(self, pg_conn):
        """A listing page the harvester finds no detail links on is STILL a
        clean 'listing' outcome (N=0), not a failure — the classification is by
        URL shape, independent of what the HTML happened to contain."""
        _apply_schema(pg_conn)
        self._cleanup_listing(pg_conn)
        try:
            capture_id = _insert_pending(
                pg_conn, self._LISTING_URL, "<html><body>sin enlaces</body></html>"
            )
            capture.process_pending_captures(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, fields_extracted, error_msg "
                    "FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, fields_extracted, error_msg = cur.fetchone()
            assert status == "listing"
            assert fields_extracted == 0
            assert error_msg is None
        finally:
            self._cleanup_listing(pg_conn)

    def test_listing_capture_does_not_notify_materialize(self, pg_conn, monkeypatch):
        """A listing-page capture ingests no listing itself (its links are
        merely queued), so it must NOT fire a materialize-all — same rule as an
        all-failures batch."""
        from etl import orchestrator

        _apply_schema(pg_conn)
        self._cleanup_listing(pg_conn)
        calls: list[str] = []
        monkeypatch.setattr(
            orchestrator,
            "notify_materialize_all",
            lambda trigger="scheduler": calls.append(trigger) or True,
        )
        try:
            _insert_pending(pg_conn, self._LISTING_URL, self._LISTING_HTML)
            capture.process_pending_captures(pg_conn)
            assert calls == []
        finally:
            self._cleanup_listing(pg_conn)


class TestListingPageSightingsBumpLastSeen:
    """Issue #639: a captured results page enumerates known adverts without
    re-reading any of them. Before this, that enumeration updated nothing on
    `listing` — only a real detail fetch ever bumped `last_seen_at`. That made
    a captured portal's staleness numbers partly an artifact of the ledger,
    not of the listings actually being gone (measured against production:
    idealista showed 1,098 listings 'unseen >7d' while the owner was
    routinely capturing its search pages).

    Reuses TestListingPageCaptureReclassification's own fixture (detail links
    to #11111 and #22222) so this suite exercises the exact same harvest path
    issue #292 already covers — it only adds assertions about `listing`.
    """

    _LISTING_URL = TestListingPageCaptureReclassification._LISTING_URL
    _LISTING_HTML = TestListingPageCaptureReclassification._LISTING_HTML
    _STALE_INTERVAL = "10 days"

    def _seed_listing(
        self, conn, external_id: str, *, stale: bool = True
    ) -> tuple[int, int]:
        """Insert a minimal idealista property/listing row, `last_seen_at`
        and `last_fetched_at` both `_STALE_INTERVAL` in the past (or NOW() if
        `stale=False`), `status='active'` (the column default). Returns
        (property_id, listing_id)."""
        with conn.cursor() as cur:
            cur.execute("INSERT INTO property DEFAULT VALUES RETURNING id")
            (property_id,) = cur.fetchone()
            age = f"NOW() - INTERVAL '{self._STALE_INTERVAL}'" if stale else "NOW()"
            cur.execute(
                f"""
                INSERT INTO listing
                    (property_id, source, external_id, last_seen_at, last_fetched_at)
                VALUES (%s, 'idealista', %s, {age}, {age})
                RETURNING id
                """,
                (property_id, external_id),
            )
            (listing_id,) = cur.fetchone()
        conn.commit()
        return property_id, listing_id

    def _fetch_listing(self, conn, external_id: str):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status, last_seen_at, last_fetched_at FROM listing "
                "WHERE source = 'idealista' AND external_id = %s",
                (external_id,),
            )
            return cur.fetchone()

    def _cleanup(self, conn) -> None:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM extension_capture WHERE url = %s", (self._LISTING_URL,)
            )
            cur.execute(
                "DELETE FROM capture_worklist WHERE source_portal = 'idealista' "
                "AND added_via = 'derived'"
            )
            cur.execute(
                "SELECT property_id FROM listing WHERE source = 'idealista' "
                "AND external_id = ANY(%s)",
                (["11111", "22222", "99999"],),
            )
            property_ids = [row[0] for row in cur.fetchall()]
            cur.execute(
                "DELETE FROM listing WHERE source = 'idealista' "
                "AND external_id = ANY(%s)",
                (["11111", "22222", "99999"],),
            )
            if property_ids:
                cur.execute("DELETE FROM property WHERE id = ANY(%s)", (property_ids,))
        conn.commit()

    def test_listing_page_sighting_bumps_last_seen_at(self, pg_conn):
        """EC-1: capturing a results page that enumerates a known listing
        (external_id 11111, on the fixture page) leaves that listing's
        `last_seen_at` at ~now — the honest, revertible half of the check:
        reverting `_record_sightings`'s call site makes this fail red, since
        the row would stay `_STALE_INTERVAL` old."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            self._seed_listing(pg_conn, "11111")
            _insert_pending(pg_conn, self._LISTING_URL, self._LISTING_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1

            _, last_seen_at, _ = self._fetch_listing(pg_conn, "11111")
            with pg_conn.cursor() as cur:
                cur.execute("SELECT NOW()")
                (now,) = cur.fetchone()
            assert (now - last_seen_at).total_seconds() < 30
        finally:
            self._cleanup(pg_conn)

    def test_unenumerated_listing_last_seen_at_untouched(self, pg_conn):
        """The other half: a listing NOT on the captured page (external_id
        99999, never harvested from `_LISTING_HTML`) must keep its stale
        `last_seen_at` — proving the update is scoped to what was actually
        enumerated, not every active idealista row. A bug that bumped every
        row for the source (rather than only the harvested ids) would pass
        the first test and fail this one."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            self._seed_listing(pg_conn, "99999")
            _insert_pending(pg_conn, self._LISTING_URL, self._LISTING_HTML)
            capture.process_pending_captures(pg_conn)

            _, last_seen_at, _ = self._fetch_listing(pg_conn, "99999")
            with pg_conn.cursor() as cur:
                cur.execute("SELECT NOW()")
                (now,) = cur.fetchone()
            # Still ~_STALE_INTERVAL old — nowhere near "just bumped".
            assert (now - last_seen_at).total_seconds() > 9 * 24 * 3600
        finally:
            self._cleanup(pg_conn)

    def test_sighting_is_not_a_verification(self, pg_conn):
        """EC-2: a sighting bumps `last_seen_at` only. `status` and
        `last_fetched_at` — the field a real detail fetch owns, and the exact
        signal skip-if-seen gates on — must stay exactly as seeded."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            self._seed_listing(pg_conn, "11111")
            status_before, _, last_fetched_before = self._fetch_listing(
                pg_conn, "11111"
            )
            _insert_pending(pg_conn, self._LISTING_URL, self._LISTING_HTML)
            capture.process_pending_captures(pg_conn)

            status_after, _, last_fetched_after = self._fetch_listing(pg_conn, "11111")
            assert status_after == status_before == "active"
            assert last_fetched_after == last_fetched_before
        finally:
            self._cleanup(pg_conn)

    def test_capture_with_no_known_listings_is_a_clean_no_op(self, pg_conn):
        """Sighting matching is best-effort bookkeeping layered on an
        already-clean 'listing page' outcome (D-069): when nothing on the
        page matches an ingested listing (nothing seeded here at all), the
        capture must still process cleanly, not error or fail."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            _insert_pending(pg_conn, self._LISTING_URL, self._LISTING_HTML)
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, error_msg FROM extension_capture WHERE url = %s",
                    (self._LISTING_URL,),
                )
                status, error_msg = cur.fetchone()
            assert status == "listing"
            assert error_msg is None
        finally:
            self._cleanup(pg_conn)

    def _insert_pending_backdated(self, conn, url: str, html: str, age_sql: str) -> int:
        """Like `_insert_pending`, but with `created_at` set to `age_sql`
        (e.g. "NOW() - INTERVAL '3 days'") instead of the column's own
        NOW() default -- simulates a capture that sat `pending` for a while
        before being processed (issue #639 review, C2)."""
        with conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO extension_capture (url, html, created_at) "
                f"VALUES (%s, %s, {age_sql}) RETURNING id",
                (url, html),
            )
            capture_id = cur.fetchone()[0]
        conn.commit()
        return capture_id

    def test_delayed_processing_stamps_the_observation_instant_not_now(self, pg_conn):
        """Issue #639 review, C2: a capture that sat `pending` for 3 days
        (a paused connector, an outage) before being processed must record
        the sighting at ITS OWN `created_at` -- the moment the page was
        actually captured -- not at NOW() (processing time), which would
        claim a sighting that never happened at that moment."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            self._seed_listing(pg_conn, "11111")
            self._insert_pending_backdated(
                pg_conn,
                self._LISTING_URL,
                self._LISTING_HTML,
                "NOW() - INTERVAL '3 days'",
            )
            processed = capture.process_pending_captures(pg_conn)
            assert processed == 1

            _, last_seen_at, _ = self._fetch_listing(pg_conn, "11111")
            with pg_conn.cursor() as cur:
                cur.execute("SELECT NOW()")
                (now,) = cur.fetchone()
            age_seconds = (now - last_seen_at).total_seconds()
            # ~3 days old, not ~0 -- ruling out a NOW()-at-processing-time bug.
            assert 3 * 24 * 3600 - 60 < age_seconds < 3 * 24 * 3600 + 60
        finally:
            self._cleanup(pg_conn)

    def test_a_delayed_sighting_cannot_move_last_seen_at_backwards(self, pg_conn):
        """Issue #639 review, C2: GREATEST-based write. A listing already
        seen 1 hour ago (by some other, more recent path) must NOT be
        dragged back to a stale 3-day-old sighting a delayed capture
        happens to carry -- the write can only move `last_seen_at`
        forward."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            with pg_conn.cursor() as cur:
                cur.execute("INSERT INTO property DEFAULT VALUES RETURNING id")
                (property_id,) = cur.fetchone()
                cur.execute(
                    "INSERT INTO listing "
                    "(property_id, source, external_id, last_seen_at, last_fetched_at) "
                    "VALUES (%s, 'idealista', '11111', "
                    "NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')",
                    (property_id,),
                )
            pg_conn.commit()

            self._insert_pending_backdated(
                pg_conn,
                self._LISTING_URL,
                self._LISTING_HTML,
                "NOW() - INTERVAL '3 days'",
            )
            capture.process_pending_captures(pg_conn)

            _, last_seen_at, _ = self._fetch_listing(pg_conn, "11111")
            with pg_conn.cursor() as cur:
                cur.execute("SELECT NOW()")
                (now,) = cur.fetchone()
            # Still ~1 hour old -- the 3-day-old delayed sighting never
            # dragged it backwards.
            assert (now - last_seen_at).total_seconds() < 2 * 3600
        finally:
            self._cleanup(pg_conn)

    def test_record_sightings_returns_rows_actually_matched_not_urls_targeted(
        self, pg_conn
    ):
        """Issue #639 review, M1: `_record_sightings` must report the
        UPDATE's real `rowcount`, not `len(external_ids)`. Two ids are
        targeted (11111 and 22222) but only 11111 is a known listing -- the
        honest return value is 1, not 2. Before the fix this returned 2
        regardless of how many rows actually matched, which is exactly the
        false "N sighted" the review's example (30 links, 0 matches -> '30
        sighted') described."""
        _apply_schema(pg_conn)
        self._cleanup(pg_conn)
        try:
            self._seed_listing(pg_conn, "11111")
            sighted = capture._record_sightings(
                pg_conn,
                "idealista",
                [
                    "https://www.idealista.com/inmueble/11111/",
                    "https://www.idealista.com/inmueble/22222/",
                ],
            )
            assert sighted == 1
        finally:
            self._cleanup(pg_conn)


class TestNulByteRejectedByPostgres:
    """The half of PR #563 that the dashboard's mocked unit tests cannot prove.

    Those tests mock `@/lib/db-write`, so they show the sanitiser RUNS — they
    would pass just as green if U+FFFD were itself something Postgres rejects.
    The owner's actual failure was a Postgres constraint
    (`invalid byte sequence for encoding "UTF8": 0x00` on his first real
    Hipoges capture), so the claim worth pinning in the repo is that a raw NUL
    is rejected and the substituted string is accepted and round-trips exactly.
    """

    def test_raw_nul_is_rejected_and_the_substitution_is_accepted(self, pg_conn):
        raw = "<html><body><h1>Piso\x00 en Dos Hermanas</h1></body></html>"
        sanitised = raw.replace("\x00", "\ufffd")
        url = "https://realestate.hipoges.com/es/detail/nul-regression"

        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (url,))
            pg_conn.commit()

            # 1. A raw NUL cannot be stored. NOTE the two drivers reject it at
            #    different layers, and the owner hit the second: psycopg2
            #    refuses client-side with ValueError, while node-postgres (the
            #    dashboard's driver, which is what actually wrote this row on
            #    his Hipoges capture) sends it and Postgres answers
            #    `invalid byte sequence for encoding "UTF8": 0x00`. Either way
            #    the row does not land — that is the invariant worth pinning
            #    here; the exact wording belongs to the driver, not to us.
            with pytest.raises((psycopg2.Error, ValueError)) as excinfo:
                cur.execute(
                    "INSERT INTO extension_capture (url, html) VALUES (%s, %s)",
                    (url, raw),
                )
            pg_conn.rollback()
            assert "NUL" in str(excinfo.value) or "0x00" in str(excinfo.value)

            # 2. The substituted string IS accepted and round-trips exactly.
            #    This is the half the dashboard's mocked unit tests cannot
            #    prove: they would pass just as green if U+FFFD were itself
            #    something Postgres rejects.
            cur.execute(
                "INSERT INTO extension_capture (url, html) VALUES (%s, %s) RETURNING id",
                (url, sanitised),
            )
            capture_id = cur.fetchone()[0]
            pg_conn.commit()

            cur.execute(
                "SELECT html FROM extension_capture WHERE id = %s", (capture_id,)
            )
            stored = cur.fetchone()[0]

            cur.execute("DELETE FROM extension_capture WHERE id = %s", (capture_id,))
            pg_conn.commit()

        assert stored == sanitised
        assert "\ufffd" in stored
        assert "\x00" not in stored
        # Offsets unchanged — this is precisely why U+FFFD beats deletion.
        assert len(stored) == len(raw)


_RETIRED_HTML = (
    Path(__file__).parent / "fixtures" / "idealista_retired_notice.html"
).read_text(encoding="utf-8")
# The obviously-fake reference and delisting date the synthetic fixture
# prints, and the figures its summary line states. Issue #691 requires the
# printed reference to equal the captured external_id before anything is
# withdrawn, so every test builds its page through `_retired_html()`.
_NOTICE_REFERENCE = "900000001"
_NOTICE_DELISTED = "03/08/2026"
_NOTICE_M2 = 80
_NOTICE_ROOMS = 3
# Substituted in by default so no test depends on wall-clock drift: the
# fixture's hardcoded date would eventually age past the connector's
# plausibility window and be (correctly) disbelieved.
_RECENT_DELISTED_DATE = datetime.now(timezone.utc).date() - timedelta(days=12)
_RECENT_DELISTED = _RECENT_DELISTED_DATE.strftime("%d/%m/%Y")


def _retired_html(
    external_id: str = _NOTICE_REFERENCE,
    delisted: str | None = _RECENT_DELISTED,
    figures: str | None = None,
) -> str:
    """The synthetic retired-notice page, rewritten so its printed
    «Referencia del anuncio» is `external_id` (issue #691)."""
    html = _RETIRED_HTML.replace(_NOTICE_REFERENCE, external_id)
    if delisted is not None:
        html = html.replace(_NOTICE_DELISTED, delisted)
    if figures is not None:
        html = html.replace(f"123.000 € {_NOTICE_M2} m² {_NOTICE_ROOMS} hab.", figures)
    return html


def _seed_live_listing(
    conn,
    external_id: str,
    url: str,
    m2_built: int = _NOTICE_M2,
    rooms: int = _NOTICE_ROOMS,
) -> int:
    """A healthy already-captured listing, shaped like the production
    rows D-159 measured: real price, real description, a real gallery."""
    with conn.cursor() as cur:
        cur.execute(
            # m2_built/rooms match what the notice fixture states, so the
            # issue #691 size/rooms corroboration has something real to
            # agree with; the tests that need a disagreement override it.
            "INSERT INTO property (address, city, property_type, m2_built, "
            "rooms) VALUES ('Calle Sintetica 1', 'Madrid', 'piso', %s, %s) "
            "RETURNING id",
            (m2_built, rooms),
        )
        property_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO listing
                (property_id, source, external_id, url, status, first_seen_at,
                 last_seen_at, last_fetched_at, current_price, description,
                 photo_urls, operation)
            VALUES (%s, 'idealista', %s, %s, 'active',
                    NOW() - INTERVAL '30 days', NOW() - INTERVAL '9 days',
                    NOW() - INTERVAL '9 days', 165000,
                    %s, %s, 'sale')
            RETURNING id
            """,
            (
                property_id,
                external_id,
                url,
                "Descripcion sintetica de prueba, suficientemente larga.",
                ["https://img.example/1.jpg", "https://img.example/2.jpg"],
            ),
        )
        listing_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO listing_price_history (listing_id, observed_at, price) "
            "VALUES (%s, NOW() - INTERVAL '30 days', 175000)",
            (listing_id,),
        )
    conn.commit()
    return listing_id


class TestRetiredAdvertCapture:
    """Issue #690 / D-159 — the capture-only evidence channel.

    Idealista is capture-only behind a WAF (D-081/D-026/D-027), so absence
    can never be inferred and no automated request may be made to check.
    The one evidence channel available is the owner's own browsing: when he
    opens a listing that is gone, the portal itself renders "lo sentimos,
    este anuncio ya no está publicado". These tests pin that this page
    withdraws the listing WITH evidence, that nothing else does, and that
    the pre-fix corruption is gone.
    """

    def test_retired_page_withdraws_the_listing_with_evidence(self, pg_conn):
        """EC: capturing the notice page transitions the listing to
        `withdrawn` and appends a status event that CITES the notice — the
        whole point of D-157's "only evidence changes state"."""
        external_id = "690001"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            capture_id = _insert_pending(pg_conn, url, _retired_html(external_id))

            # 1 row PROCESSED (the return value counts handled rows), but
            # _process_one returns False for it, so it does not count as
            # INGESTED — a withdrawal is not an ingestion and must not
            # trigger the dashboard re-materialize that a real new listing
            # does.
            assert capture.process_pending_captures(pg_conn) == 1
            assert (
                capture._process_one(
                    pg_conn,
                    _insert_pending(pg_conn, url, _retired_html(external_id)),
                    url,
                    _RETIRED_HTML,
                )
                is False
            )

            with pg_conn.cursor() as cur:
                cur.execute("SELECT status FROM listing WHERE id = %s", (listing_id,))
                assert cur.fetchone()[0] == "withdrawn"

                cur.execute(
                    "SELECT status, evidence FROM listing_status_event "
                    "WHERE listing_id = %s ORDER BY id DESC LIMIT 1",
                    (listing_id,),
                )
                status, evidence = cur.fetchone()
                assert status == "withdrawn"
                assert evidence is not None
                assert "ya no esta publicado" in evidence.lower()

                cur.execute(
                    "SELECT status, connector_name, listing_id, error_msg, html "
                    "FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                cap_status, connector_name, cap_listing, err, html = cur.fetchone()
                # Not 'failed': nothing failed. Not 'done': nothing was
                # ingested. See the init.sql migration note for why this
                # needs its own status.
                assert cap_status == "withdrawn"
                assert connector_name == "idealista"
                assert cap_listing == listing_id
                assert "retirado" in err.lower()
                assert html is None
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_withdrawal_marks_and_never_deletes(self, pg_conn):
        """D-157 ("mark, don't delete"): the listing row, its price history and its property all
        survive — a withdrawn advert keeps its history so the property stays
        analysable and a resurrection stays representable."""
        external_id = "690002"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT current_price, description, "
                    "array_length(photo_urls, 1), property_id "
                    "FROM listing WHERE id = %s",
                    (listing_id,),
                )
                price, description, photos, property_id = cur.fetchone()
                assert price is not None
                assert description is not None
                # The photo gallery specifically: the pre-fix path erased it
                # (photo_urls is assigned, not COALESCEd). It must survive.
                assert photos == 2

                cur.execute(
                    "SELECT count(*) FROM listing_price_history WHERE listing_id = %s",
                    (listing_id,),
                )
                assert cur.fetchone()[0] == 1
                cur.execute(
                    "SELECT count(*) FROM property WHERE id = %s", (property_id,)
                )
                assert cur.fetchone()[0] == 1
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_withdrawal_does_not_bump_last_seen_at(self, pg_conn):
        """`last_seen_at` means "last confirmed PRESENT". The pre-fix path
        pushed it to NOW() on exactly the capture that proved the listing was
        GONE, making a dead listing look freshly confirmed alive and
        defeating every staleness nomination downstream (D-157)."""
        external_id = "690003"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT last_seen_at FROM listing WHERE id = %s", (listing_id,)
                )
                before = cur.fetchone()[0]

            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT last_seen_at FROM listing WHERE id = %s", (listing_id,)
                )
                assert cur.fetchone()[0] == before
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_retired_page_for_an_unknown_listing_creates_nothing(self, pg_conn):
        """The phantom-listing path, closed. 18 of the 26 corrupted
        production rows were listings CREATED by a non-advert capture. A
        notice page for a URL we have never successfully captured tells us
        about a listing we hold no data for — inventing a row for it would
        recreate exactly those phantoms."""
        external_id = "690004"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            capture_id = _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM listing WHERE source = 'idealista' "
                    "AND external_id = %s",
                    (external_id,),
                )
                assert cur.fetchone()[0] == 0
                # The evidence is still recorded, just with no listing to
                # attach it to.
                cur.execute(
                    "SELECT status, listing_id FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                assert cur.fetchone() == ("withdrawn", None)
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_recapturing_the_notice_is_idempotent(self, pg_conn):
        """Draining a worklist can re-open the same dead URL. A second
        capture must append no second status event."""
        external_id = "690005"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            for _ in range(2):
                _insert_pending(pg_conn, url, _retired_html(external_id))
                capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM listing_status_event "
                    "WHERE listing_id = %s AND status = 'withdrawn'",
                    (listing_id,),
                )
                assert cur.fetchone()[0] == 1
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_an_unidentifiable_page_changes_nothing_about_the_listing(self, pg_conn):
        """THE safety test. A bot wall / soft block / half-rendered page
        carries no listing data either — and must leave the listing exactly
        as it was: still `active`, gallery intact, no status event. Absence
        of evidence is never evidence of absence (D-157, D-047)."""
        external_id = "690006"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        wall_html = (
            "<html><head><title>idealista</title></head><body>"
            "<h1>Vaya, parece que eres un robot</h1></body></html>"
        )
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            capture_id = _insert_pending(pg_conn, url, wall_html)
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, array_length(photo_urls, 1), current_price "
                    "FROM listing WHERE id = %s",
                    (listing_id,),
                )
                assert cur.fetchone() == ("active", 2, Decimal("165000.00"))
                cur.execute(
                    "SELECT count(*) FROM listing_status_event WHERE listing_id = %s",
                    (listing_id,),
                )
                assert cur.fetchone()[0] == 0
                # Recorded as a genuine failure so the operator can see it —
                # a page we cannot classify IS something to look at.
                cur.execute(
                    "SELECT status FROM extension_capture WHERE id = %s", (capture_id,)
                )
                assert cur.fetchone()[0] == "failed"
        finally:
            _cleanup_url(pg_conn, url, external_id)


class TestRetiredNoticeCorroboration:
    """Issue #691. D-159 shipped on the notice SENTENCE alone. A real notice
    page, read by hand afterwards, turned out to print the advert's own
    reference, the date the advertiser pulled it, and its headline
    price/size/rooms — and the sentence alone is weaker evidence than it
    looked, because the notice page is generic chrome served for every dead
    advert. These tests pin the full chain: the reference must name THIS
    listing, and any size/rooms the notice states must agree with what we
    stored, or nothing is withdrawn.
    """

    def _assert_untouched(self, conn, listing_id: int, capture_id: int) -> None:
        """The safe outcome, in full: the listing is exactly as it was, no
        status event was appended, and the capture is recorded `failed` for
        the operator to look at — identical to what an unreadable bot-wall
        page produces (D-157)."""
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status, array_length(photo_urls, 1), current_price "
                "FROM listing WHERE id = %s",
                (listing_id,),
            )
            assert cur.fetchone() == ("active", 2, Decimal("165000.00"))
            cur.execute(
                "SELECT count(*) FROM listing_status_event WHERE listing_id = %s",
                (listing_id,),
            )
            assert cur.fetchone()[0] == 0
            cur.execute(
                "SELECT status FROM extension_capture WHERE id = %s", (capture_id,)
            )
            assert cur.fetchone()[0] == "failed"

    def test_a_matching_reference_withdraws(self, pg_conn):
        """The happy path, stated as a corroboration rather than as a
        sentence match: the page prints this advert's own id."""
        external_id = "690020"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute("SELECT status FROM listing WHERE id = %s", (listing_id,))
                assert cur.fetchone()[0] == "withdrawn"
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_mismatched_reference_withdraws_nothing(self, pg_conn):
        """THE test this hardening exists for. A notice shell served at the
        wrong URL — a redirect, a stale tab, a mis-typed capture, a portal
        bug — must not withdraw a listing the page was never about."""
        external_id = "690021"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            capture_id = _insert_pending(pg_conn, url, _retired_html("900000777"))
            capture.process_pending_captures(pg_conn)
            self._assert_untouched(pg_conn, listing_id, capture_id)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT error_msg FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                # The refusal has to name the mismatch, or an operator
                # staring at a `failed` row cannot tell this apart from a
                # bot wall — and these two want opposite responses.
                assert "900000777" in cur.fetchone()[0]
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_notice_without_a_reference_withdraws_nothing(self, pg_conn):
        """Required, not preferred (issue #691). Without the reference the
        page only supports "some advert is gone", and D-157 does not let
        that change a row."""
        external_id = "690022"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        html = _retired_html(external_id).replace(
            f"Referencia del anuncio: {external_id}", "&nbsp;"
        )
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            capture_id = _insert_pending(pg_conn, url, html)
            capture.process_pending_captures(pg_conn)
            self._assert_untouched(pg_conn, listing_id, capture_id)
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_notice_describing_a_different_property_withdraws_nothing(self, pg_conn):
        """Reference matched, property did not. Something is wrong on one
        side or the other and we cannot tell which — which under D-157 is
        not evidence, so nothing moves. This is the check that needs the
        DATABASE, which is why it lives in capture.py and not the
        connector."""
        external_id = "690023"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            # Stored: a 120 m², 4-bed. Notice: an 80 m², 3-bed.
            listing_id = _seed_live_listing(
                pg_conn, external_id, url, m2_built=120, rooms=4
            )
            capture_id = _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)
            self._assert_untouched(pg_conn, listing_id, capture_id)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT error_msg FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                assert "m²" in cur.fetchone()[0]
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_rounded_square_metre_is_not_a_mismatch(self, pg_conn):
        """The notice renders a whole number; `property.m2_built` holds
        NUMERIC(8,2) from the structured capture. One metre of rounding must
        not read as "a different flat"."""
        external_id = "690024"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE property SET m2_built = 79.60 WHERE id = "
                    "(SELECT property_id FROM listing WHERE id = %s)",
                    (listing_id,),
                )
            pg_conn.commit()
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute("SELECT status FROM listing WHERE id = %s", (listing_id,))
                assert cur.fetchone()[0] == "withdrawn"
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_notice_stating_no_figures_still_withdraws(self, pg_conn):
        """Absence is not a mismatch. A reworded notice that drops the
        summary line loses corroboration, not the withdrawal — treating a
        missing field as a disagreement would quietly disable the only
        evidence channel this portal has."""
        external_id = "690025"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            _insert_pending(pg_conn, url, _retired_html(external_id, figures="&nbsp;"))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute("SELECT status FROM listing WHERE id = %s", (listing_id,))
                assert cur.fetchone()[0] == "withdrawn"
                cur.execute(
                    "SELECT evidence FROM listing_status_event WHERE listing_id = %s",
                    (listing_id,),
                )
                # ...and the evidence says so, so nobody later mistakes this
                # for a fully corroborated withdrawal.
                assert "sin datos comparables" in cur.fetchone()[0]
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_missing_stored_size_is_not_a_mismatch(self, pg_conn):
        """The other half of "absence is not a mismatch": the NOTICE states
        a size but the stored property has none."""
        external_id = "690026"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "UPDATE property SET m2_built = NULL, rooms = NULL WHERE id = "
                    "(SELECT property_id FROM listing WHERE id = %s)",
                    (listing_id,),
                )
            pg_conn.commit()
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute("SELECT status FROM listing WHERE id = %s", (listing_id,))
                assert cur.fetchone()[0] == "withdrawn"
        finally:
            _cleanup_url(pg_conn, url, external_id)


class TestRetiredNoticeDelistingDate:
    """Issue #691. The notice says when the ADVERTISER pulled the advert,
    which is not when we happened to read the page. In the sample that
    prompted this the advert had already been down for twelve days when the
    page was captured — twelve days that `NOW()` would have invented."""

    def test_the_stated_date_is_what_gets_recorded(self, pg_conn):
        external_id = "690030"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT observed_at FROM listing_status_event "
                    "WHERE listing_id = %s",
                    (listing_id,),
                )
                observed_at = cur.fetchone()[0]
            # The date the notice stated (12 days ago), NOT today.
            assert observed_at.date() == _RECENT_DELISTED_DATE
            assert observed_at.date() != datetime.now(timezone.utc).date()
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_an_absent_date_falls_back_to_the_capture_time(self, pg_conn):
        """Precision, not proof. Losing the date costs the transition its
        true timestamp — never the transition."""
        external_id = "690031"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        html = _retired_html(external_id).replace(
            f"El anunciante lo dio de baja el {_RECENT_DELISTED}", "&nbsp;"
        )
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            _insert_pending(pg_conn, url, html)
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, observed_at FROM listing_status_event "
                    "WHERE listing_id = %s",
                    (listing_id,),
                )
                status, observed_at = cur.fetchone()
            assert status == "withdrawn"
            assert observed_at.date() == datetime.now(timezone.utc).date()
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_an_unbelievable_date_falls_back_to_the_capture_time(self, pg_conn):
        """A wrong date in `observed_at` is worse than no date, because
        afterwards it is indistinguishable from a real one. A date that
        cannot exist is discarded — and the evidence records that it was."""
        external_id = "690032"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            _insert_pending(
                pg_conn, url, _retired_html(external_id, delisted="31/02/2026")
            )
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT observed_at, evidence FROM listing_status_event "
                    "WHERE listing_id = %s",
                    (listing_id,),
                )
                observed_at, evidence = cur.fetchone()
            assert observed_at.date() == datetime.now(timezone.utc).date()
            assert "no es verosímil" in evidence
            assert "31/02/2026" in evidence
        finally:
            _cleanup_url(pg_conn, url, external_id)


class TestRetiredNoticeEvidence:
    """Issue #691. `listing_status_event.evidence` is the only place a
    withdrawal can be reconstructed from a year later, so everything the
    notice stated goes into it — including the final asking price, which
    nothing else in this project has ever recorded."""

    def test_the_evidence_carries_every_parsed_fact(self, pg_conn):
        external_id = "690040"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT evidence FROM listing_status_event WHERE listing_id = %s",
                    (listing_id,),
                )
                evidence = cur.fetchone()[0]
            # What the portal said...
            assert "ya no esta publicado" in evidence.lower()
            # ...which advert it said it about...
            assert external_id in evidence
            # ...when the advertiser pulled it...
            assert _RECENT_DELISTED in evidence
            # ...what it was asking when it died, and its shape...
            assert "123000 €" in evidence
            assert "80 m²" in evidence
            assert "3 hab." in evidence
            # ...and what we were able to check that against.
            assert "superficie y habitaciones coinciden" in evidence
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_the_notice_never_overwrites_the_stored_listing(self, pg_conn):
        """The notice's figures are a plain-text parse of facts the row
        already holds from a proper structured capture. Writing the weaker
        parse onto a row being marked dead is all risk and no gain — so the
        stored price, description, gallery, size and rooms must come out of
        a withdrawal byte-identical."""
        external_id = "690041"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT l.current_price, l.description, l.photo_urls, "
                    "p.m2_built, p.rooms FROM listing l "
                    "JOIN property p ON p.id = l.property_id WHERE l.id = %s",
                    (listing_id,),
                )
                before = cur.fetchone()

            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT l.current_price, l.description, l.photo_urls, "
                    "p.m2_built, p.rooms FROM listing l "
                    "JOIN property p ON p.id = l.property_id WHERE l.id = %s",
                    (listing_id,),
                )
                assert cur.fetchone() == before
        finally:
            _cleanup_url(pg_conn, url, external_id)


class TestRetiredNoticeHtmlRetention:
    """Retain the HTML only of pages the system could NOT account for."""

    def test_a_classified_withdrawal_does_not_retain_its_html(self, pg_conn):
        """A CLASSIFIED outcome is not an anomaly, so its page is dropped.

        Retention exists to hand the operator the one thing that cannot be
        reconstructed later: the bytes of a page nobody could explain. A
        withdrawal is the opposite of that — the full corroboration chain
        passed (notice sentence, «Referencia del anuncio» equal to the
        captured external_id, stated size/rooms agreeing with the stored
        listing), so the system knows exactly what this page was, and
        everything worth keeping from it is already parsed into
        `listing_status_event.evidence` and readable as prose. Keeping ~400 KB
        of generic notice chrome on top of that buys nothing.

        Pinned because the obvious implementation of anomaly-retention gets
        this exactly backwards. "Zero fields extracted → keep the page" is
        the natural rule to reach for, and a retired notice extracts zero
        fields BY CONSTRUCTION — it is a notice, not an advert. Such a rule
        would hoard every withdrawal we ever record, which is both the
        highest-volume and the least interesting case. Retention has to key
        on *unexplained*, never on *empty*.

        (A parallel branch — `capture-idealista-challenge`, PR #692 — adds a
        per-portal anomaly-retention floor on the SUCCESS path only. A
        withdrawal never reaches that path: `_process_one` diverts to
        `_mark_withdrawn` from the `ListingUnavailableError` branch, well
        before any field-completeness is computed. This test is what would
        catch it if those two ever grew into each other.)
        """
        external_id = "690050"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            listing_id = _seed_live_listing(pg_conn, external_id, url)
            capture_id = _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)

            with pg_conn.cursor() as cur:
                # The chain really did pass — otherwise `html IS NULL` below
                # would be pinning the wrong code path entirely.
                cur.execute("SELECT status FROM listing WHERE id = %s", (listing_id,))
                assert cur.fetchone()[0] == "withdrawn"
                cur.execute(
                    "SELECT status, html, error_msg FROM extension_capture "
                    "WHERE id = %s",
                    (capture_id,),
                )
                cap_status, html, evidence = cur.fetchone()
                assert cap_status == "withdrawn"
                assert html is None
                # ...and what the page said survives anyway, in prose.
                assert "ya no esta publicado" in evidence.lower()
        finally:
            _cleanup_url(pg_conn, url, external_id)


class TestRetiredAdvertWorklistRetirement:
    """Issue #690: what a confirmed withdrawal does to the guided worklist."""

    def _seed_worklist(self, conn, url: str, status: str) -> None:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO capture_worklist "
                "(url, match_key, source_portal, status) VALUES (%s, %s, %s, %s)",
                (url, capture.worklist_match_key(url), "idealista", status),
            )
        conn.commit()

    def _worklist_status(self, conn, url: str) -> str:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM capture_worklist WHERE match_key = %s",
                (capture.worklist_match_key(url),),
            )
            return cur.fetchone()[0]

    def test_a_pending_row_is_retired_as_stale(self, pg_conn):
        """'stale' is this table's own word for "vanished from the portal"
        (issue #273) and is excluded from the "Abrir siguiente pendiente"
        pool — so the owner is never handed a URL we have just proven is
        dead. His attention is the scarcest resource in a capture-only
        pipeline; re-serving a dead URL spends it for nothing."""
        external_id = "690010"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            self._seed_worklist(pg_conn, url, "pending")
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)
            assert self._worklist_status(pg_conn, url) == "stale"
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_skipped_row_is_never_resurrected(self, pg_conn):
        """'skipped' is the OWNER'S decision about his own queue. No
        automated inference gets to overrule it — not even a correct one."""
        external_id = "690011"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            self._seed_worklist(pg_conn, url, "skipped")
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)
            assert self._worklist_status(pg_conn, url) == "skipped"
        finally:
            _cleanup_url(pg_conn, url, external_id)

    def test_a_captured_row_is_never_downgraded(self, pg_conn):
        """A 'captured' row records a real successful capture and its
        matched_capture_id; retiring it would lose that."""
        external_id = "690012"
        url = f"https://www.idealista.com/inmueble/{external_id}/"
        _apply_schema(pg_conn)
        _cleanup_url(pg_conn, url, external_id)
        try:
            self._seed_worklist(pg_conn, url, "captured")
            _insert_pending(pg_conn, url, _retired_html(external_id))
            capture.process_pending_captures(pg_conn)
            assert self._worklist_status(pg_conn, url) == "captured"
        finally:
            _cleanup_url(pg_conn, url, external_id)
