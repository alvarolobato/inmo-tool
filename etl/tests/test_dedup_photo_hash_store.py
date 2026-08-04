"""Persistent per-URL photo-hash store — issue #221.

Real-Postgres tests, one per acceptance criterion on the issue. The point of
#221 is that the SECOND run costs nothing, so every test here counts actual
`requests.get` calls rather than asserting on the returned hashes: a version
that quietly re-fetched but returned the right answer would still be the bug.
"""

from __future__ import annotations

import zlib
from pathlib import Path
from unittest.mock import patch

import imagehash
import pytest
from PIL import Image

from etl.dedup import photo_hash_store
from etl.dedup.signals import photo_hash

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text())
    conn.commit()


@pytest.fixture
def store_db(pg_conn):
    _apply_schema(pg_conn)
    with pg_conn.cursor() as cur:
        cur.execute("DELETE FROM photo_hashes")
    pg_conn.commit()
    yield pg_conn
    with pg_conn.cursor() as cur:
        cur.execute("DELETE FROM photo_hashes")
    pg_conn.commit()


class _FakeImageResponse:
    """Minimal stand-in for a streamed requests response carrying a PNG."""

    def __init__(self, image: Image.Image):
        import io

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        buf.seek(0)
        self.raw = buf

    def raise_for_status(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _image_for(url: str) -> Image.Image:
    """A distinct, deterministic image per URL.

    Deterministic so re-fetching a URL yields the same hash, and *distinct*
    because a fixture that served one identical image for every URL made every
    assertion about hash values true by construction: a store that returned
    some other URL's hash, or returned the right hashes in the wrong order,
    passed just as happily. The store's entire job is the URL→hash mapping, so
    the fixture has to be able to tell one URL's image from another's.

    Gradient rather than a flat fill: phash is DCT-based, so a perfectly
    uniform image has no frequency content to hash and any two flat colours
    collide. The x/y coefficients (not just an offset) are what actually
    separate these — a constant offset alone is a mod-256 rotation that phash
    is invariant to, i.e. `phash(offset 0) == phash(offset 40)`.
    """
    seed = zlib.crc32(url.encode())
    fx, fy = 1 + seed % 7, 1 + (seed >> 3) % 11
    img = Image.new("L", (64, 64))
    img.putdata([(x * fx + y * fy) % 256 for y in range(64) for x in range(64)])
    return img


def _ok_response(url, *_args, **_kwargs):
    return _FakeImageResponse(_image_for(url))


class TestSecondRunCostsNothing:
    """AC: a second dedup run over an unchanged corpus performs zero image
    fetches."""

    def test_second_call_over_same_urls_makes_no_requests(self, store_db):
        urls = ("https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg")

        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as first:
            first_hashes = photo_hash.fetch_hashes(
                urls, source="fotocasa", store_conn=store_db
            )
        assert first.call_count == 2
        assert len(first_hashes) == 2

        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as second:
            second_hashes = photo_hash.fetch_hashes(
                urls, source="fotocasa", store_conn=store_db
            )
        assert second.call_count == 0, "a warm store must not touch the network"
        # And the answer must be identical, not merely cheap — the hashes are
        # what the whole dedup comparison rests on. The two URLs carry
        # different images, so this also pins the per-URL mapping and the
        # result order: a store that returned the right hashes for the wrong
        # URLs, or the right set in the wrong order, fails here.
        assert first_hashes[0] != first_hashes[1], "fixture must distinguish URLs"
        assert [str(h) for h in second_hashes] == [str(h) for h in first_hashes]
        assert [str(h) for h in second_hashes] == [
            str(imagehash.phash(_image_for(url))) for url in urls
        ]


class TestIncrementalWork:
    """AC: adding a listing hashes only its photos; a changed photo_urls array
    re-hashes only the new URLs."""

    def test_only_new_urls_are_fetched(self, store_db):
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ):
            photo_hash.fetch_hashes(
                ("https://cdn.example.com/a.jpg",), source="solvia", store_conn=store_db
            )

        # Same listing, one photo added: only the new URL costs a request.
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as get:
            hashes = photo_hash.fetch_hashes(
                ("https://cdn.example.com/a.jpg", "https://cdn.example.com/NEW.jpg"),
                source="solvia",
                store_conn=store_db,
            )
        assert get.call_count == 1
        assert len(hashes) == 2

    def test_a_url_shared_between_listings_is_hashed_once(self, store_db):
        """Why the store is keyed on URL alone, not (listing_id, url):
        syndicated listings point at the same CDN objects across sources
        (Milanuncios carries `origin.provider = "fotocasa_pro"` entries), so
        the corpus should pay for such an image exactly once."""
        shared = ("https://cdn.example.com/shared.jpg",)
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ):
            photo_hash.fetch_hashes(shared, source="fotocasa", store_conn=store_db)
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as get:
            photo_hash.fetch_hashes(shared, source="milanuncios", store_conn=store_db)
        assert get.call_count == 0


class TestFailuresAreRecordedNotRetriedBlindly:
    """AC: failed fetches are recorded and not blindly retried every run.

    This is the criterion with teeth: a dead URL retried every run is exactly
    how the Milanuncios CDN breakage (#209/#213) stayed invisible — the cost
    was spread evenly over every run instead of showing as a spike.
    """

    def test_a_failure_is_not_retried_on_the_next_run(self, store_db):
        url = ("https://cdn.example.com/gone.jpg",)
        with patch(
            "etl.dedup.signals.photo_hash.requests.get",
            side_effect=RuntimeError("404 Rule parameter not Found"),
        ) as first:
            assert photo_hash.fetch_hashes(url, store_conn=store_db) == []
        assert first.call_count == 1

        with patch(
            "etl.dedup.signals.photo_hash.requests.get",
            side_effect=RuntimeError("404 Rule parameter not Found"),
        ) as second:
            assert photo_hash.fetch_hashes(url, store_conn=store_db) == []
        assert second.call_count == 0

    def test_the_failure_reason_is_kept_for_diagnosis(self, store_db):
        with patch(
            "etl.dedup.signals.photo_hash.requests.get",
            side_effect=RuntimeError("Rule parameter not Found"),
        ):
            photo_hash.fetch_hashes(
                ("https://cdn.example.com/x.jpg",),
                source="milanuncios",
                store_conn=store_db,
            )
        with store_db.cursor() as cur:
            cur.execute(
                "SELECT ok, source, failure_reason FROM photo_hashes "
                "WHERE photo_url = %s",
                ("https://cdn.example.com/x.jpg",),
            )
            ok, source, reason = cur.fetchone()
        assert ok is False
        assert source == "milanuncios"
        assert "Rule parameter not Found" in reason

    def test_a_stale_failure_is_retried_once_the_backoff_expires(self, store_db):
        """Not 'never retry': #209 was a whole source failing for a fixable
        reason, and a store that never retried would have made that permanent
        the moment it was fixed."""
        url = ("https://cdn.example.com/flaky.jpg",)
        with patch(
            "etl.dedup.signals.photo_hash.requests.get",
            side_effect=RuntimeError("transient"),
        ):
            photo_hash.fetch_hashes(url, store_conn=store_db)

        # Age the recorded attempt past the backoff window.
        with store_db.cursor() as cur:
            cur.execute(
                "UPDATE photo_hashes SET last_attempt_at = "
                "NOW() - make_interval(secs => %s)",
                (photo_hash_store.FAILED_RETRY_INTERVAL_SECONDS + 60,),
            )
        store_db.commit()

        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as get:
            hashes = photo_hash.fetch_hashes(url, store_conn=store_db)
        assert get.call_count == 1
        assert len(hashes) == 1

        # ...and having succeeded, it is never retried again.
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as get:
            photo_hash.fetch_hashes(url, store_conn=store_db)
        assert get.call_count == 0


class TestStoreIsOptional:
    """Passing no connection keeps the original behaviour — the persistence is
    a cost optimisation over an immutable value, never a change in what gets
    compared. The pure-comparison unit tests depend on this."""

    def test_without_a_connection_every_url_is_fetched_every_time(self):
        urls = ("https://cdn.example.com/a.jpg",)
        for _ in range(2):
            with patch(
                "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
            ) as get:
                photo_hash.fetch_hashes(urls)
            assert get.call_count == 1


class TestRoundTripFidelity:
    """The stored hex must reconstruct the exact same ImageHash — a lossy
    round trip would silently change every downstream Hamming distance."""

    def test_hash_survives_a_store_round_trip_exactly(self, store_db):
        digest = imagehash.phash(_image_for("https://x/1.jpg"))
        photo_hash_store.save(
            store_db, photo_url="https://x/1.jpg", phash=digest, source="s"
        )
        loaded = photo_hash_store.load(store_db, ("https://x/1.jpg",))
        assert loaded["https://x/1.jpg"].phash == digest
        assert digest - loaded["https://x/1.jpg"].phash == 0


class TestTheStoreCommitsIndependently:
    """PR #226 blocker: nothing ever committed the store.

    `save()` rode the dedup run's transaction, and `engine.run()` has no
    commit of its own — the only commits are incidental ones inside
    `perform_merge`/`file_suggestion`, i.e. only when a pair happens to fire.
    So a run with no merges persisted nothing at all, and an interrupted cold
    pass (~46 minutes over 24k URLs, by this PR's own measurement) discarded
    every hash it had paid for. The optimisation could plausibly never warm up
    in the real deployment.
    """

    def test_hashes_survive_an_aborted_run(self, store_db):
        """What SIGINT / a container stop / an OOM kill does to the run's
        transaction must not cost the hashes already paid for."""
        urls = tuple(f"https://cdn.example.com/abort{i}.jpg" for i in range(5))
        store_conn = photo_hash_store.open_connection()
        assert store_conn is not None, "these tests need a reachable database"
        try:
            with patch(
                "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
            ):
                photo_hash.fetch_hashes(urls, source="fotocasa", store_conn=store_conn)
            # The run's own connection rolls back everything it was holding.
            store_db.rollback()
        finally:
            photo_hash_store.close_connection(store_conn)

        with store_db.cursor() as cur:
            cur.execute("SELECT count(*) FROM photo_hashes WHERE ok")
            assert cur.fetchone()[0] == 5

    def test_open_connection_hands_out_a_connection_that_is_not_the_runs(
        self, store_db
    ):
        """The commit above cannot be bought by committing inside `save()`:
        the store would then be committing the dedup run's in-flight work too.
        Its own connection is what makes a per-save commit safe."""
        store_conn = photo_hash_store.open_connection()
        try:
            assert store_conn is not None
            assert store_conn is not store_db
            assert store_conn.autocommit is True
        finally:
            photo_hash_store.close_connection(store_conn)

    def test_a_concurrent_run_is_not_blocked_by_an_in_flight_one(self, store_db):
        """PR #226 major: run-long row locks.

        Run A saves a URL; run B upserts the same URL (syndicated listings
        share CDN objects across sources, so this is the common case, not a
        corner). With A's write uncommitted, B blocked on the row lock for the
        whole of A's run — bounded only by the 46-minute pass. `store_db`
        stands in for run B, with a statement timeout so a lock wait fails the
        test rather than hanging it.
        """
        shared = "https://cdn.example.com/syndicated.jpg"
        digest = imagehash.phash(_image_for(shared))
        run_a = photo_hash_store.open_connection()
        assert run_a is not None
        try:
            assert photo_hash_store.save(
                run_a, photo_url=shared, phash=digest, source="fotocasa"
            )
            with store_db.cursor() as cur:
                cur.execute("SET statement_timeout = '5s'")
            assert photo_hash_store.save(
                store_db, photo_url=shared, phash=digest, source="milanuncios"
            ), "run B blocked on run A's uncommitted row"
        finally:
            store_db.rollback()
            with store_db.cursor() as cur:
                cur.execute("SET statement_timeout = 0")
            store_db.commit()
            photo_hash_store.close_connection(run_a)


class TestTheStoreCannotSinkARun:
    """PR #226 major: `load`/`save` are best-effort by contract — "skip
    (don't raise on) any that fail" — but were unguarded, so a DB hiccup
    escaped into the dedup run and killed it. Pre-#221 a malformed URL cost
    one photo; it must not now cost the run.
    """

    def test_load_degrades_to_empty_on_an_aborted_transaction(self, store_db):
        """`InFailedSqlTransaction`: any earlier failed statement in the run
        poisons the transaction, and every subsequent store read raises."""
        import psycopg2

        with store_db.cursor() as cur, pytest.raises(psycopg2.errors.UndefinedTable):
            cur.execute("SELECT * FROM a_table_that_does_not_exist")
        try:
            assert photo_hash_store.load(store_db, ("https://cdn.example/x.jpg",)) == {}
        finally:
            store_db.rollback()

    def test_save_degrades_to_false_on_a_nul_byte_in_the_url(self, store_db):
        """psycopg2 raises `ValueError: A string literal cannot contain NUL`
        client-side. Scraped URLs are not sanitised, so this is reachable from
        real connector output."""
        assert (
            photo_hash_store.save(
                store_db,
                photo_url="https://cdn.example/\x00bad.jpg",
                phash=None,
                source="milanuncios",
                failure_reason="whatever",
            )
            is False
        )

    def test_a_url_the_store_chokes_on_costs_one_photo_not_the_run(self, store_db):
        """End to end through the caller: the poison URL is just another
        failed photo, and its healthy neighbour still hashes."""
        urls = ("https://cdn.example/\x00bad.jpg", "https://cdn.example/good.jpg")
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ):
            hashes, stats = photo_hash.fetch_hashes_with_stats(
                urls, source="milanuncios", store_conn=store_db
            )
        assert len(hashes) == 2  # both fetched fine; only the *store* choked
        assert stats.store_write_failures == 1

    def test_an_unusable_store_connection_does_not_stop_the_fetching(self, store_db):
        """A store that has gone away entirely mid-run degrades to exactly the
        pre-#221 behaviour: fetch everything, hash everything, log."""
        dead = photo_hash_store.open_connection()
        photo_hash_store.close_connection(dead)
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as get:
            hashes = photo_hash.fetch_hashes(
                ("https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"),
                source="solvia",
                store_conn=dead,
            )
        assert len(hashes) == 2
        assert get.call_count == 2


class TestDegenerateRows:
    def test_an_ok_row_with_no_hash_is_refetched_rather_than_black_holed(
        self, store_db
    ):
        """`ok = true` with `phash IS NULL` satisfies the "never retry a
        success" short-circuit but carries no hash to return — 0 requests and
        0 hashes for that URL, forever. `save()` can't write one, but a
        hand-edit or a partial restore can, so treat it as unknown."""
        url = "https://cdn.example.com/hashless.jpg"
        with store_db.cursor() as cur:
            cur.execute(
                "INSERT INTO photo_hashes (photo_url, phash, ok, source) "
                "VALUES (%s, NULL, true, %s)",
                (url, "milanuncios"),
            )
        store_db.commit()

        assert photo_hash_store.load(store_db, (url,)) == {}
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as get:
            hashes = photo_hash.fetch_hashes((url,), store_conn=store_db)
        assert get.call_count == 1
        assert len(hashes) == 1

    def test_a_url_repeated_within_one_listing_is_fetched_once(self, store_db):
        """`photo_urls` is whatever the connector scraped; a gallery that
        lists the same image twice used to cost two requests, because the
        store snapshot was taken before the loop and never updated as saves
        landed. Both occurrences still contribute a hash — the memo suppresses
        the request, not the result, so `match_ratio`'s denominators are
        unchanged."""
        url = "https://cdn.example.com/twice.jpg"
        with patch(
            "etl.dedup.signals.photo_hash.requests.get", side_effect=_ok_response
        ) as get:
            hashes = photo_hash.fetch_hashes((url, url), store_conn=store_db)
        assert get.call_count == 1
        assert len(hashes) == 2
        assert hashes[0] == hashes[1]
