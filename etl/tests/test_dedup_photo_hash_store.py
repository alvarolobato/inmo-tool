"""Persistent per-URL photo-hash store — issue #221.

Real-Postgres tests, one per acceptance criterion on the issue. The point of
#221 is that the SECOND run costs nothing, so every test here counts actual
`requests.get` calls rather than asserting on the returned hashes: a version
that quietly re-fetched but returned the right answer would still be the bug.
"""

from __future__ import annotations

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


def _solid(color: int) -> Image.Image:
    # Gradient, not a flat fill: phash is DCT-based and a perfectly uniform
    # image has no frequency content to hash, so two different flat colours
    # can collide. A gradient keeps distinct inputs distinct.
    img = Image.new("L", (64, 64))
    img.putdata([(color + x + y) % 256 for y in range(64) for x in range(64)])
    return img


def _ok_response(*_args, **_kwargs):
    return _FakeImageResponse(_solid(0))


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
        # what the whole dedup comparison rests on.
        assert [str(h) for h in second_hashes] == [str(h) for h in first_hashes]


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
        digest = imagehash.phash(_solid(40))
        photo_hash_store.save(
            store_db, photo_url="https://x/1.jpg", phash=digest, source="s"
        )
        loaded = photo_hash_store.load(store_db, ("https://x/1.jpg",))
        assert loaded["https://x/1.jpg"].phash == digest
        assert digest - loaded["https://x/1.jpg"].phash == 0
