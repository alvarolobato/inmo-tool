"""Persistent per-URL store for perceptual photo hashes (issue #221).

`_PhotoHashCache` in `etl.dedup.engine` memoises hashes for the duration of
one run. That was correct but expensive: nothing survived the run, so every
pass re-downloaded and re-hashed every photo of every listing — ~8,800 HTTP
fetches per run at ~880 listings x ~10 photos, against third-party CDNs, from
a residential connection, outside any connector's rate limiter.

The fix rests on one fact: **a perceptual hash of a given image never
changes**, so a URL only ever needs hashing once. This module persists that
result keyed on the URL itself.

Keyed on `photo_url`, deliberately NOT on `(listing_id, photo_url)`:

  * A listing whose `photo_urls` array changes re-hashes only the URLs that
    are actually new — the unchanged ones are already keyed and hit.
  * Syndicated listings share image URLs across sources (Milanuncios carries
    `origin.provider = "fotocasa_pro"` entries pointing at the same CDN
    objects), so a URL-keyed store hashes those once for the whole corpus
    rather than once per listing that references them.
  * No invalidation logic is needed anywhere. There is no cache-coherence
    question to get wrong, because the thing being cached is immutable.

Failures are recorded too, and that is not incidental. A URL that 404s used
to be retried on every single run forever — which is precisely how the
Milanuncios "Rule parameter not Found" breakage (#209/#213) stayed invisible
for so long: the cost was spread evenly over every run and never showed up as
a spike. Failures are stored with a timestamp and retried only after
`FAILED_RETRY_INTERVAL_SECONDS`, so a transient outage still heals itself
while a permanently dead URL stops costing anything.

Two properties this module is responsible for, both learned the hard way in
review of PR #226:

**Its own connection, committed per save.** The store must NOT ride the dedup
run's transaction. Doing so meant (a) nothing was ever committed unless a
merge happened to fire, so an interrupted cold pass — ~46 minutes over 24k
URLs — discarded every hash it had paid for and the next run started cold
again, and (b) every saved row stayed write-locked for the rest of the run, so
a second concurrent dedup run blocked on the first for its full duration the
moment they touched a shared (syndicated) URL. `open_connection()` hands out a
separate autocommit connection: each upsert commits on its own, so the lock
lasts one statement and an interrupted run keeps everything it hashed. The
per-save commit costs nothing relative to what it follows — every save is
preceded by an image fetch measured at ~115 ms, against which a single-row
commit does not register.

**It can never take down a run.** `load()` and `save()` swallow every
exception and degrade to "no stored knowledge about this URL" (so the caller
just fetches it, as it did before this table existed). A store that raises
would turn a best-effort cache into a new failure mode for the whole dedup
run: real, reproduced examples are a URL containing a NUL byte (psycopg2
raises `ValueError` client-side, and scraped URLs are not sanitised) and any
connection-level hiccup mid-run.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import imagehash

logger = logging.getLogger(__name__)

# How long a failed URL is left alone before it is worth one more attempt.
# 7 days: long enough that a permanently-dead URL costs ~nothing (one request
# a week, versus one per run), short enough that a CDN outage or an expiring
# signed URL heals without anyone intervening. Deliberately not "never":
# #209 was a whole source's photos failing for a fixable reason, and a store
# that never retried would have made that permanent the moment it was fixed.
FAILED_RETRY_INTERVAL_SECONDS = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class StoredHash:
    """One row's worth of outcome for a single URL."""

    photo_url: str
    phash: imagehash.ImageHash | None
    ok: bool


def open_connection():
    """Open the store's own connection, or return None if that's not possible.

    Deliberately separate from the dedup run's connection — see the module
    docstring for the two bugs sharing it caused. `autocommit=True` is the
    whole point: it makes every `save()` its own transaction, so nothing is
    ever lost to an interrupted run and no row stays locked past the statement
    that wrote it.

    Returns None (rather than raising) when there's no reachable database
    configured, so a caller that can't get a store just runs without one —
    exactly the pre-#221 behaviour of fetching every URL every time. The
    caller owns the returned connection and must `close_connection()` it.
    """
    try:
        from etl.config import Config
        from etl.db.postgres import get_connection

        conn = get_connection(Config())
        conn.autocommit = True
        return conn
    except Exception as exc:  # noqa: BLE001 - the store is an optimisation
        logger.warning(
            "photo_hash_store: no persistent hash store this run (%s) — "
            "every photo URL will be fetched as it was before issue #221",
            exc,
        )
        return None


def close_connection(conn) -> None:
    """Close a connection handed out by `open_connection()`; never raise."""
    if conn is None:
        return
    try:
        conn.close()
    except Exception as exc:  # noqa: BLE001 - best-effort teardown
        logger.debug("photo_hash_store: closing the store connection failed: %s", exc)


def load(conn, photo_urls: tuple[str, ...]) -> dict[str, StoredHash]:
    """Return stored outcomes for whichever of *photo_urls* are known.

    A URL is "known" (and so will not be re-fetched) when it either hashed
    successfully at any point, or failed within the last
    `FAILED_RETRY_INTERVAL_SECONDS`. URLs absent from the result are the ones
    the caller still needs to fetch.

    Never raises: any failure degrades to an empty result, i.e. "nothing is
    known about these URLs", which makes the caller fetch them. See the module
    docstring.
    """
    if not photo_urls:
        return {}
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT photo_url, phash, ok
                  FROM photo_hashes
                 WHERE photo_url = ANY(%s)
                   AND (
                         ok
                         OR last_attempt_at > NOW() - make_interval(secs => %s)
                       )
                """,
                (list(photo_urls), FAILED_RETRY_INTERVAL_SECONDS),
            )
            rows = cur.fetchall()
    except Exception as exc:  # noqa: BLE001 - the store must never sink a run
        # WARNING, not DEBUG: a load happens once per listing, so this is
        # bounded by the corpus rather than by the URL count, and a store that
        # can't be read at all is a real incident an operator should see.
        # The run itself carries on and fetches everything, as it did pre-#221.
        logger.warning(
            "photo_hash_store: load failed for %d URL(s), falling back to "
            "fetching them: %s",
            len(photo_urls),
            exc,
        )
        return {}
    out: dict[str, StoredHash] = {}
    for photo_url, phash_text, ok in rows:
        if ok and not phash_text:
            # `ok = true` with no hash is a row `save()` cannot produce, but if
            # one ever exists (hand-written, a partial restore) it would
            # otherwise be a permanent black hole: it satisfies the `ok`
            # short-circuit above so it's never retried, yet carries no hash to
            # return — 0 requests and 0 hashes for that URL, forever. Treating
            # it as unknown re-fetches it and the next `save()` repairs it.
            logger.debug(
                "photo_hash_store: ignoring ok-but-hashless row for %s", photo_url
            )
            continue
        out[photo_url] = StoredHash(
            photo_url=photo_url,
            # imagehash round-trips through its own hex representation:
            # hex_to_hash(str(h)) == h. Stored as text so the table stays
            # readable and portable rather than an opaque blob.
            phash=imagehash.hex_to_hash(phash_text) if ok else None,
            ok=ok,
        )
    return out


def save(
    conn,
    *,
    photo_url: str,
    phash: imagehash.ImageHash | None,
    source: str,
    failure_reason: str | None = None,
) -> bool:
    """Record the outcome of hashing *photo_url*. Returns True if it landed.

    Upsert rather than insert: a retried failure must overwrite its previous
    attempt (bumping `last_attempt_at` so the backoff restarts) and a URL
    that finally succeeds must flip `ok` to true and stop being retried at
    all. `attempts` accumulates so an operator can tell a URL that failed
    once from one that has failed every week for a year.

    Never raises. A failed save costs one re-fetch on a later run — the
    caller's photo is already hashed and returned by then — whereas letting it
    propagate would abort the whole dedup run over a cache write. Returns
    False so the caller can roll the failures up into one log line instead of
    emitting one per URL. On a connection from `open_connection()` this commits
    immediately (autocommit); see the module docstring for why that matters.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
            INSERT INTO photo_hashes
                    (photo_url, phash, ok, source, failure_reason,
                     attempts, first_seen_at, last_attempt_at)
                 VALUES (%s, %s, %s, %s, %s, 1, NOW(), NOW())
            ON CONFLICT (photo_url) DO UPDATE
                    SET phash          = EXCLUDED.phash,
                        ok             = EXCLUDED.ok,
                        source         = EXCLUDED.source,
                        failure_reason = EXCLUDED.failure_reason,
                        attempts       = photo_hashes.attempts + 1,
                        last_attempt_at = NOW()
                """,
                (
                    photo_url,
                    str(phash) if phash is not None else None,
                    phash is not None,
                    source,
                    failure_reason,
                ),
            )
    except Exception as exc:  # noqa: BLE001 - the store must never sink a run
        logger.debug("photo_hash_store: save failed for %s: %s", photo_url, exc)
        return False
    return True
