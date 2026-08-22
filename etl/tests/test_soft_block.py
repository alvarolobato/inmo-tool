"""Issue #692 — anti-bot CHALLENGE pages are a soft block, never a withdrawal.

The DB-backed tests here prove the property that matters operationally: a
challenge capture leaves the `capture_worklist` row exactly as it found it,
still `pending`, with its `requeue_rank` intact, so the page stays in the
drain queue instead of being silently consumed.

Every fixture is SYNTHETIC. The real page renders the visitor's IP address
and a per-visit challenge UUID; both are per-visit personal data and this is
a public repo, so the fixtures use RFC-5737 documentation addresses and an
all-zero UUID, and neither is a signature (pinned by a test below).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from etl import capture
from etl.soft_block import (
    CHALLENGE_PHRASES,
    MIN_PHRASE_HITS,
    challenge_page_signature,
    challenge_phrase_hits,
)

_SCHEMA_SQL = Path(__file__).parents[1] / "schema" / "init.sql"
_CHALLENGE_URL = "https://www.idealista.com/inmueble/999000111/"

CHALLENGE_HTML = """<!doctype html>
<html lang="es"><head><title>Viviendas venta. Viviendas alquiler. Pisos. Chalets</title></head>
<body><main>
  <h1>&iexcl;Vaya! parece que estamos recibiendo muchas peticiones tuyas en poco tiempo</h1>
  <p>Desliza hacia la derecha para asegurar tu acceso</p>
  <h2>&iquest;Por qu&eacute; esta verificaci&oacute;n?</h2>
  <p>Algo sobre el comportamiento del navegador nos ha intrigado.</p>
  <p>Varias posibilidades:</p>
  <ul>
    <li>usted navega y hace clic a una velocidad sobrehumana</li>
    <li>algo bloquea el funcionamiento de JavaScript en su navegador</li>
    <li>un robot se encuentra en la misma red (IP 203.0.113.7) que usted</li>
  </ul>
  <p>Un saludo, El equipo de idealista</p>
  <p>ID: 00000000-0000-4000-8000-000000000000</p>
</main></body></html>"""

# A retired-advert notice. Field-less to a parser, exactly like the challenge
# above — which is the whole reason the two must be told apart positively.
# Address/price/size invented (public repo).
RETIRED_NOTICE_HTML = """<!doctype html>
<html lang="es"><head><title>Viviendas venta. Viviendas alquiler. Pisos. Chalets</title></head>
<body><main>
  <h2>Lo sentimos, este anuncio ya no est&aacute; publicado</h2>
  <p>Piso en venta en Calle Inventada 1, Barrio Ficticio, Ciudad Ejemplo</p>
  <p>123.400 &euro; 77 m&sup2; 2 hab.</p>
  <p>Referencia del anuncio: 999000222</p>
  <p>El anunciante lo dio de baja el 01/01/2026</p>
</main></body></html>"""


class TestChallengeSignature:
    """DB-free detection behaviour."""

    def test_detects_the_challenge_page(self):
        assert challenge_page_signature(CHALLENGE_HTML) is not None

    def test_a_retired_notice_is_not_a_challenge(self):
        """THE test this module exists for. A withdrawal notice and a
        challenge are both field-less; only one of them may ever reach the
        `withdrawn` path, and only the other may reach `blocked`."""
        assert challenge_page_signature(RETIRED_NOTICE_HTML) is None

    def test_one_phrase_alone_is_not_a_challenge(self):
        html = "<html><body><p>Se vende en poco tiempo, no lo dejes pasar.</p></body></html>"
        assert len(challenge_phrase_hits(html)) == 1
        assert challenge_page_signature(html) is None

    def test_two_phrases_are(self):
        html = (
            "<html><body><p>muchas peticiones</p>"
            "<p>Desliza hacia la derecha</p></body></html>"
        )
        assert len(challenge_phrase_hits(html)) == MIN_PHRASE_HITS
        assert challenge_page_signature(html) is not None

    def test_folds_accents_and_case(self):
        html = (
            "<html><body><p>MUCHAS PETICIONES</p>"
            "<p>¿POR QUÉ ESTA VERIFICACIÓN?</p></body></html>"
        )
        assert challenge_page_signature(html) is not None

    def test_script_text_does_not_count(self):
        html = (
            "<html><body><script>var a='muchas peticiones';"
            "var b='desliza hacia la derecha';</script>"
            "<p>Piso en venta</p></body></html>"
        )
        assert challenge_phrase_hits(html) == []
        assert challenge_page_signature(html) is None

    def test_empty_and_garbage_input(self):
        assert challenge_page_signature("") is None
        assert challenge_page_signature("<html></html>") is None

    def test_no_phrase_is_per_visit_data(self):
        """The IP and the challenge UUID must never become signatures — they
        change every visit and they are personal data in a public repo."""
        for phrase in CHALLENGE_PHRASES:
            assert not re.search(r"\d+\.\d+\.\d+\.\d+", phrase)
            assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}", phrase, re.IGNORECASE)

    def test_verdict_is_identical_for_a_different_visitor(self):
        other = CHALLENGE_HTML.replace("203.0.113.7", "198.51.100.42").replace(
            "00000000-0000-4000-8000-000000000000",
            "11111111-2222-4333-8444-555555555555",
        )
        assert challenge_page_signature(other) == challenge_page_signature(
            CHALLENGE_HTML
        )

    def test_signature_text_leaks_nothing_per_visit(self):
        sig = challenge_page_signature(CHALLENGE_HTML)
        assert "203.0.113.7" not in sig
        assert "00000000-0000-4000-8000-000000000000" not in sig


class TestPhraseTableIsSharedWithTheExtension:
    """The browser halts the batch, the ETL halts the ingest. They must agree
    about what a challenge looks like, so the two phrase tables are pinned
    identical — edit one, edit both."""

    def test_python_and_javascript_phrase_tables_match(self):
        js = (Path(__file__).parents[2] / "browser-extension" / "detect.js").read_text(
            encoding="utf-8"
        )
        block = re.search(r"var CHALLENGE_PHRASES = \[(.*?)\];", js, re.DOTALL)
        assert block is not None, "CHALLENGE_PHRASES not found in detect.js"
        # Strip // comments first — the table is heavily commented and those
        # comments quote the portal's wording, which would otherwise be
        # scraped as if it were a table entry.
        body = re.sub(r"//[^\n]*", "", block.group(1))
        js_phrases = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
        assert tuple(js_phrases) == CHALLENGE_PHRASES

    def test_thresholds_match(self):
        js = (Path(__file__).parents[2] / "browser-extension" / "detect.js").read_text(
            encoding="utf-8"
        )
        found = re.search(r"var CHALLENGE_MIN_PHRASE_HITS = (\d+);", js)
        assert found is not None
        assert int(found.group(1)) == MIN_PHRASE_HITS


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _cleanup(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM extension_capture WHERE url = %s", (_CHALLENGE_URL,))
        cur.execute("DELETE FROM capture_worklist WHERE url = %s", (_CHALLENGE_URL,))
        cur.execute(
            "SELECT property_id FROM listing "
            "WHERE source = 'idealista' AND external_id = '999000111'"
        )
        row = cur.fetchone()
        cur.execute(
            "DELETE FROM listing "
            "WHERE source = 'idealista' AND external_id = '999000111'"
        )
        if row is not None:
            cur.execute("DELETE FROM property WHERE id = %s", (row[0],))
    conn.commit()


class TestChallengeCaptureChangesNothing:
    """End to end against real PostgreSQL."""

    @pytest.fixture(autouse=True)
    def _schema(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        yield
        _cleanup(pg_conn)

    def _insert_pending(self, conn, html: str) -> int:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO extension_capture (url, html) VALUES (%s, %s) "
                "RETURNING id",
                (_CHALLENGE_URL, html),
            )
            capture_id = cur.fetchone()[0]
        conn.commit()
        return capture_id

    def _seed_worklist(self, conn, *, rank: int = 7) -> None:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO capture_worklist "
                "(url, match_key, source_portal, added_via, status, "
                " requeued_at, requeue_reason, requeue_rank) "
                "VALUES (%s, %s, 'idealista', 'derived', 'pending', "
                "        NOW(), 'photo-gallery backfill', %s)",
                (_CHALLENGE_URL, capture.worklist_match_key(_CHALLENGE_URL), rank),
            )
        conn.commit()

    def test_capture_is_marked_blocked_not_failed_and_not_done(self, pg_conn):
        capture_id = self._insert_pending(pg_conn, CHALLENGE_HTML)
        capture.process_pending_captures(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status, connector_name, error_msg, listing_id, "
                "       property_id, fields_extracted "
                "FROM extension_capture WHERE id = %s",
                (capture_id,),
            )
            status, connector, error_msg, listing_id, property_id, fields = (
                cur.fetchone()
            )
        assert status == "blocked"
        assert connector == "idealista"
        assert "reto anti-bot" in error_msg
        assert listing_id is None
        assert property_id is None
        assert fields == 0

    def test_the_worklist_row_survives_untouched(self, pg_conn):
        """The requirement, stated as a test: a page that served a challenge
        was never seen, so it keeps its place in the queue."""
        self._seed_worklist(pg_conn, rank=7)
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status, requeue_rank, requeue_reason, matched_capture_id "
                "FROM capture_worklist WHERE url = %s",
                (_CHALLENGE_URL,),
            )
            before = cur.fetchone()

        self._insert_pending(pg_conn, CHALLENGE_HTML)
        capture.process_pending_captures(pg_conn)

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status, requeue_rank, requeue_reason, matched_capture_id "
                "FROM capture_worklist WHERE url = %s",
                (_CHALLENGE_URL,),
            )
            after = cur.fetchone()

        assert after == before
        assert after[0] == "pending"
        assert after[1] == 7

    def test_a_non_advert_page_that_is_NOT_a_challenge_still_consumes_the_row(
        self, pg_conn
    ):
        """The contrast that makes the previous test meaningful.

        Any OTHER field-less page consumes the worklist row — today by being
        ingested as an empty listing (the live corruption PR #691 fixes), and
        once #691 lands by being marked `failed`, whose `_correlate_worklist`
        call flips the row out of `pending`. Either way the page leaves the
        drain pool. Only the challenge outcome keeps its place, and that is
        the whole point of ranking it first.
        """
        self._seed_worklist(pg_conn)
        self._insert_pending(
            pg_conn,
            "<html><body><main><p>algo salio mal</p></main></body></html>",
        )
        capture.process_pending_captures(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM capture_worklist WHERE url = %s",
                (_CHALLENGE_URL,),
            )
            assert cur.fetchone()[0] != "pending"

    def test_nothing_is_written_to_an_existing_listing(self, pg_conn):
        """A challenge must not touch photo_urls, last_seen_at, status, or
        anything else — the portal never showed us the advert, so we learned
        nothing about it (D-157)."""
        with pg_conn.cursor() as cur:
            cur.execute("INSERT INTO property DEFAULT VALUES RETURNING id")
            property_id = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO listing (property_id, source, external_id, url, "
                "  operation, status, photo_urls, current_price, last_seen_at) "
                "VALUES (%s, 'idealista', '999000111', %s, 'sale', 'active', "
                "        %s, 250000, NOW() - INTERVAL '5 days') RETURNING id",
                (property_id, _CHALLENGE_URL, ["https://example.invalid/a.jpg"]),
            )
            listing_id = cur.fetchone()[0]
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status, photo_urls, current_price, last_seen_at "
                "FROM listing WHERE id = %s",
                (listing_id,),
            )
            before = cur.fetchone()

        self._insert_pending(pg_conn, CHALLENGE_HTML)
        capture.process_pending_captures(pg_conn)

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status, photo_urls, current_price, last_seen_at "
                "FROM listing WHERE id = %s",
                (listing_id,),
            )
            after = cur.fetchone()
            cur.execute(
                "SELECT count(*) FROM listing_status_event WHERE listing_id = %s",
                (listing_id,),
            )
            events = cur.fetchone()[0]

        assert after == before, "a challenge capture modified the listing row"
        assert after[0] == "active", "a challenge must never withdraw a listing"
        assert events == 0

    def test_a_classified_challenge_does_NOT_retain_its_html(self, pg_conn):
        """Retention is for pages the system could not account for, and this
        one is accounted for: `error_msg` records which phrases matched.

        The obvious implementation — "no fields, so keep the page" — gets
        this backwards and would hoard every wall we already understand. It
        is self-correcting in the right direction: if the portal rewords the
        wall, the phrase table stops matching, the page stops being
        classified, and it lands in the unexplained bucket that IS retained
        — so the sample needed to repair the table appears exactly when the
        table is broken, and never while it works.
        """
        capture_id = self._insert_pending(pg_conn, CHALLENGE_HTML)
        capture.process_pending_captures(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status, html, error_msg FROM extension_capture WHERE id = %s",
                (capture_id,),
            )
            status, html, error_msg = cur.fetchone()
        assert status == "blocked"
        assert html is None, "a CLASSIFIED page is not an anomaly — do not hoard it"
        assert "reto anti-bot" in error_msg, (
            "dropping the page is only defensible because the classification "
            "itself is recorded"
        )

    def test_an_UNEXPLAINED_capture_retains_its_html(self, pg_conn):
        """Issue #692: retain the pages the system could not ACCOUNT FOR.

        The contrast with the test above is the whole rule: a challenge is
        classified and dropped; this page is not classified by anything, so
        it is kept.

        Without this, a field-less page of an unrecognised shape is
        unclassifiable forever after — which is exactly how the 33 idealista
        rows that started this work became undiagnosable. Note this fires on
        the CURRENT main behaviour, where a field-less idealista page is
        (wrongly) ingested as an empty listing rather than raising: retention
        is keyed on the measured field-count floor, so it does not depend on
        PR #691 landing first. Once #691 does land, the same page raises
        instead and takes the retain-on-failure branch — both are covered.
        """
        capture_id = self._insert_pending(
            pg_conn,
            "<html><body><main><p>pagina desconocida</p></main></body></html>",
        )
        capture.process_pending_captures(pg_conn)
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT status, fields_extracted, html FROM extension_capture "
                "WHERE id = %s",
                (capture_id,),
            )
            status, fields, html = cur.fetchone()
        assert status in ("done", "failed")
        assert fields is None or fields <= 3
        assert html is not None, "an anomalous capture must keep its evidence"

    def test_a_healthy_capture_still_discards_its_html(self, pg_conn):
        """The other half of "retain the failures": a successful capture must
        not start hoarding pages, or the cost problem D-150 documents comes
        straight back."""
        good_url = "https://www.idealista.com/inmueble/106387165/"
        good_html = (
            Path(__file__).parent / "fixtures" / "idealista_sample_detail.html"
        ).read_text(encoding="utf-8")
        with pg_conn.cursor() as cur:
            cur.execute("DELETE FROM extension_capture WHERE url = %s", (good_url,))
            cur.execute(
                "INSERT INTO extension_capture (url, html) VALUES (%s, %s) "
                "RETURNING id",
                (good_url, good_html),
            )
            capture_id = cur.fetchone()[0]
        pg_conn.commit()
        try:
            capture.process_pending_captures(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, html FROM extension_capture WHERE id = %s",
                    (capture_id,),
                )
                status, html = cur.fetchone()
            assert status == "done"
            assert html is None
        finally:
            with pg_conn.cursor() as cur:
                cur.execute("DELETE FROM extension_capture WHERE url = %s", (good_url,))
                cur.execute(
                    "SELECT property_id FROM listing WHERE source = 'idealista' "
                    "AND external_id = '106387165'"
                )
                row = cur.fetchone()
                cur.execute(
                    "DELETE FROM listing WHERE source = 'idealista' "
                    "AND external_id = '106387165'"
                )
                if row is not None:
                    cur.execute("DELETE FROM property WHERE id = %s", (row[0],))
            pg_conn.commit()

    def test_a_blocked_capture_is_not_reprocessed_forever(self, pg_conn):
        """`blocked` is terminal for the capture row (the poll query only
        picks up `pending`), so the page comes back via its still-pending
        worklist row, not via an endless reprocessing loop."""
        self._insert_pending(pg_conn, CHALLENGE_HTML)
        capture.process_pending_captures(pg_conn)
        # A second pass finds nothing left to do — `blocked` is terminal.
        assert capture.process_pending_captures(pg_conn) == 0
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM extension_capture "
                "WHERE url = %s AND status = 'pending'",
                (_CHALLENGE_URL,),
            )
            assert cur.fetchone()[0] == 0
