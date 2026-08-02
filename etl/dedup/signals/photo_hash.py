"""Signal 4: perceptual photo hash overlap (issue #16 item 4).

Split into a pure comparison function (`match_ratio`, testable with
synthetic hashes, no network) and a fetch-and-hash helper
(`fetch_hashes`, real network I/O) — `etl.dedup.engine` calls the latter
only when actually running for real, so unit tests never need network
access to exercise the matching logic.
"""

from __future__ import annotations

import logging
from decimal import Decimal

import imagehash
import requests
from PIL import Image

logger = logging.getLogger(__name__)

_REQUEST_TIMEOUT_SECONDS = 10
_HASH_HAMMING_THRESHOLD = 8  # imagehash default hash_size=8 -> 64-bit hash
_MIN_MATCH_RATIO = Decimal("0.60")
_MAX_SUGGESTION_CONFIDENCE = Decimal("0.800")


def fetch_hashes(photo_urls: tuple[str, ...]) -> list[imagehash.ImageHash]:
    """Fetch and hash each URL; skip (don't raise on) any that fail.

    A single broken/expired photo URL shouldn't sink the whole comparison —
    this is a best-effort signal, not a required one.
    """
    hashes: list[imagehash.ImageHash] = []
    for url in photo_urls:
        try:
            response = requests.get(url, timeout=_REQUEST_TIMEOUT_SECONDS, stream=True)
            response.raw.decode_content = True
            image = Image.open(response.raw)
            hashes.append(imagehash.average_hash(image))
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
    """Scale a match ratio in [_MIN_MATCH_RATIO, 1.0] to a confidence in
    [_MIN_MATCH_RATIO, _MAX_SUGGESTION_CONFIDENCE] per issue #16's 0.6-0.8 range.
    """
    ratio_d = Decimal(str(round(ratio, 3)))
    span = _MAX_SUGGESTION_CONFIDENCE - _MIN_MATCH_RATIO
    scaled = _MIN_MATCH_RATIO + (ratio_d - _MIN_MATCH_RATIO) * span / (
        Decimal("1.0") - _MIN_MATCH_RATIO
    )
    return min(scaled, _MAX_SUGGESTION_CONFIDENCE)
