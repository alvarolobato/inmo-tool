"""Signal 4: perceptual photo hash overlap (issue #16 item 4).

Split into a pure comparison function (`match_ratio`, testable with
synthetic hashes, no network) and a fetch-and-hash helper
(`fetch_hashes`, real network I/O) — `etl.dedup.engine` calls the latter
only when actually running for real, so unit tests never need network
access to exercise the matching logic.
"""

from __future__ import annotations

import logging
import posixpath
from decimal import Decimal
from urllib.parse import urlparse

import imagehash
import requests
from PIL import Image

logger = logging.getLogger(__name__)

_REQUEST_TIMEOUT_SECONDS = 10

# `listing.photo_urls` is populated by each connector from whatever a
# listing's media gallery links to — not always a static photo. A real
# production run (issue: live corpus, see PR description) logged repeated
# failures like:
#
#   photo_hash: failed to fetch/hash https://www.youtube.com/watch?v=...: cannot identify image file
#   photo_hash: failed to fetch/hash https://vimeo.com/...: cannot identify image file
#   photo_hash: failed to fetch/hash https://floorfy.com/tour/...?play=no: cannot identify image file
#
# Every one of those is a real network round trip that was always going to
# fail (PIL can't decode an HTML page as an image) — wasted cost on every
# dedup run. Worse than wasted: an unfetchable URL that fails silently
# widens both `hashes_a`/`hashes_b` denominators' *intended* photo counts
# without ever contributing a hash, so a listing with 3 real photos + 2
# video/tour links can never reach match_ratio 1.0 even when all 3 real
# photos match perfectly — the video links dilute the ratio purely by
# being present in `photo_urls`, not by being visually dissimilar.
#
# Fixed here (in the hasher), not at connector ingest time: ingest-time
# filtering would need touching etl/connectors/**, which has wider blast
# radius (shared with the connector framework/every site parser) and is
# out of this change's scope; filtering in fetch_hashes is local to the
# one signal that actually cares whether a URL is a decodable image, is
# trivially unit-testable without a connector fixture, and is the only
# place that ever calls PIL.Image.open on these URLs in the first place.
_IMAGE_EXTENSIONS = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".gif",
        ".bmp",
        ".tiff",
        ".tif",
        ".avif",
        ".heic",
    }
)

# Hostnames known to serve video / 360°-tour pages rather than static images.
# Matched host-suffix (e.g. "my.matterport.com" matches "matterport.com")
# so a subdomain doesn't slip past the check.
_NON_IMAGE_HOSTS = frozenset(
    {
        "youtube.com",
        "youtu.be",
        "vimeo.com",
        "vimeocdn.com",
        "floorfy.com",
        "matterport.com",
        "kuula.co",
        "3dvista.com",
        "cupix.com",
        "istaging.com",
    }
)


def _looks_like_photo_url(url: str) -> bool:
    """Best-effort, no-network guess at whether *url* points at a static
    image rather than a video/virtual-tour page.

    1. A recognized image extension (query string ignored) -> always kept,
       regardless of host — some of the hosts above can still legitimately
       serve a thumbnail image at a `.jpg` path, and there's no reason to
       reject that.
    2. No recognized extension, but a known non-image host -> filtered out.
    3. Anything else (no extension, unknown host — e.g. a portal's own CDN
       serving photos from an extensionless path) -> kept. This is a
       strict improvement over fetching everything unconditionally, never
       a stricter filter than the pre-existing per-URL try/except in
       `fetch_hashes` already tolerates.
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return True  # let fetch_hashes' own try/except handle the fallout

    ext = posixpath.splitext(parsed.path)[1].lower()
    if ext in _IMAGE_EXTENSIONS:
        return True

    host = (parsed.hostname or "").removeprefix("www.")
    return not (
        host in _NON_IMAGE_HOSTS
        or any(host.endswith("." + suffix) for suffix in _NON_IMAGE_HOSTS)
    )


# phash (DCT-based), not average_hash — issue #61.
#
# average_hash compares each pixel to the image mean, so a flat, low-detail
# photo (a white wall, an empty room, an over-exposed façade — extremely
# common in property listings) collapses to a near-uniform bit pattern, and
# two *unrelated* flat photos land close together by construction. Measured
# over 60 synthetic flat pairs: average_hash<=8 false-positived on 10% of
# them, at distances of 9-13 — i.e. right on top of the old threshold.
# phash's DCT basis doesn't degenerate that way: the same 60 pairs had a
# minimum distance of 18, with zero pairs under 12.
#
# Threshold 10, not the ~5 issue #61 floated: 5 would reject genuinely
# duplicate photos that have merely been re-encoded or cropped (a 5% crop
# alone measures 8) — precisely the cross-posted-listing case this signal
# exists to catch. Measured over 64 realistic duplicate transforms (resize,
# JPEG re-encode down to q35, crop, blur, brightness), phash<=10 matches 48
# where average_hash<=8 matched 49 — no meaningful loss in real matching,
# all of the false-positive reduction.
#
# Known, accepted miss — watermarks: a portal watermark bar is the one
# common transform phash does *not* absorb. Measured across three source
# images, a bar covering ~2% of the frame already sits at distance 8-10
# (at the threshold), and larger bars run to 12-22 — overlapping the
# distance range of genuinely unrelated flat photos (floor ~18). No single
# cutoff separates those two populations, so this is not tunable away:
# raising the threshold far enough to catch watermarked duplicates
# re-admits exactly the false positives this change was made to remove.
#
# That trade is taken deliberately in the false-negative direction, because
# this signal only ever files a *suggestion* (capped at
# _MAX_SUGGESTION_CONFIDENCE; the engine never treats photo_hash as an
# auto-merge basis). A miss costs one suggestion nobody sees; a false
# positive costs a human reviewing — or confirming — a bogus pair.
# See TestWatermarkLimitation in etl/tests/test_dedup_signals_photo_hash.py,
# which pins this so a future retune has to revisit it consciously.
_HASH_HAMMING_THRESHOLD = 10  # imagehash default hash_size=8 -> 64-bit hash
MIN_MATCH_RATIO = Decimal("0.60")
_MAX_SUGGESTION_CONFIDENCE = Decimal("0.800")


def fetch_hashes(photo_urls: tuple[str, ...]) -> list[imagehash.ImageHash]:
    """Fetch and hash each URL; skip (don't raise on) any that fail.

    A single broken/expired photo URL shouldn't sink the whole comparison —
    this is a best-effort signal, not a required one.

    URLs that don't look like a static image (a YouTube/Vimeo walkthrough, a
    Floorfy/Matterport virtual tour, ...) are skipped before the network
    call — see `_looks_like_photo_url` above for why this matters beyond
    just saving a doomed request.
    """
    hashes: list[imagehash.ImageHash] = []
    for url in photo_urls:
        if not _looks_like_photo_url(url):
            logger.debug("photo_hash: skipping non-image URL %s", url)
            continue
        try:
            with requests.get(
                url, timeout=_REQUEST_TIMEOUT_SECONDS, stream=True
            ) as response:
                response.raise_for_status()
                response.raw.decode_content = True
                image = Image.open(response.raw)
                hashes.append(imagehash.phash(image))
        except Exception as exc:  # noqa: BLE001 - genuinely best-effort per photo
            logger.warning("photo_hash: failed to fetch/hash %s: %s", url, exc)
    return hashes


def match_ratio(
    hashes_a: list[imagehash.ImageHash], hashes_b: list[imagehash.ImageHash]
) -> float | None:
    """Fraction of the smaller hash set with a close match in the other set.

    Returns None when there isn't enough data to compare (either side has
    zero successfully-hashed photos) rather than 0.0, so the engine can
    distinguish "we checked and they don't match" from "we couldn't check".
    """
    if not hashes_a or not hashes_b:
        return None

    smaller, larger = (
        (hashes_a, hashes_b) if len(hashes_a) <= len(hashes_b) else (hashes_b, hashes_a)
    )
    matched = sum(
        1
        for h_small in smaller
        if any((h_small - h_large) <= _HASH_HAMMING_THRESHOLD for h_large in larger)
    )
    return matched / len(smaller)


def confidence_for_ratio(ratio: float) -> Decimal:
    """Scale a match ratio in [MIN_MATCH_RATIO, 1.0] to a confidence in
    [MIN_MATCH_RATIO, _MAX_SUGGESTION_CONFIDENCE] per issue #16's 0.6-0.8 range.
    """
    ratio_d = Decimal(str(round(ratio, 3)))
    span = _MAX_SUGGESTION_CONFIDENCE - MIN_MATCH_RATIO
    scaled = MIN_MATCH_RATIO + (ratio_d - MIN_MATCH_RATIO) * span / (
        Decimal("1.0") - MIN_MATCH_RATIO
    )
    return min(scaled, _MAX_SUGGESTION_CONFIDENCE)
