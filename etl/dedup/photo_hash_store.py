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


def load(conn, photo_urls: tuple[str, ...]) -> dict[str, StoredHash]:
    """Return stored outcomes for whichever of *photo_urls* are known.

    A URL is "known" (and so will not be re-fetched) when it either hashed
    successfully at any point, or failed within the last
    `FAILED_RETRY_INTERVAL_SECONDS`. URLs absent from the result are the ones
    the caller still needs to fetch.
    """
    if not photo_urls:
        return {}
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
    out: dict[str, StoredHash] = {}
    for photo_url, phash_text, ok in rows:
        out[photo_url] = StoredHash(
            photo_url=photo_url,
            # imagehash round-trips through its own hex representation:
            # hex_to_hash(str(h)) == h. Stored as text so the table stays
            # readable and portable rather than an opaque blob.
            phash=imagehash.hex_to_hash(phash_text) if ok and phash_text else None,
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
) -> None:
    """Record the outcome of hashing *photo_url*.

    Upsert rather than insert: a retried failure must overwrite its previous
    attempt (bumping `last_attempt_at` so the backoff restarts) and a URL
    that finally succeeds must flip `ok` to true and stop being retried at
    all. `attempts` accumulates so an operator can tell a URL that failed
    once from one that has failed every week for a year.
    """
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
