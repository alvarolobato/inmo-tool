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

import re
from pathlib import Path

import psycopg2
import pytest

from etl import capture

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
    selectors_calibrated=False (Hipoges today) must NOT have its html nulled
    on a 'done' row. normalize() never raises for an uncalibrated connector —
    every capture reaches 'done' — so without this, issue #547's whole plan
    (preserve the real captured HTML as a fixture, once the owner captures a
    real page) would be impossible: the HTML that landed in the DB would
    already be gone by the time anyone went looking for it."""

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

    def test_uncalibrated_hipoges_capture_retains_html(self, pg_conn):
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
                "processing — #547 needs it to build real fixtures"
            )
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
