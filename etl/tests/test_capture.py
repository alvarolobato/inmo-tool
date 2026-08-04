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

from pathlib import Path

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
