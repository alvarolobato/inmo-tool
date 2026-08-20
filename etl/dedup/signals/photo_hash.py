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
from dataclasses import dataclass
from decimal import Decimal
from urllib.parse import urlparse

import imagehash
import requests
from PIL import Image

from etl.dedup import photo_hash_store

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
# That trade was originally taken entirely in the false-negative direction,
# because this signal used to only ever file a *suggestion* (capped at
# _MAX_SUGGESTION_CONFIDENCE) — a miss cost one suggestion nobody saw; a
# false positive cost a human reviewing/confirming a bogus pair. Issue #188
# (approved once #197 removed same-source pairing — see D-137 below) now
# lets a *full* match_ratio == 1.0, below this threshold, auto-merge when
# corroborated by an exact m2_built match and price proximity, so get the
# threshold right: raising the Hamming cutoff too far would start admitting
# genuinely different photos into that ratio == 1.0 bucket, which is no
# longer purely a "human reviews a suggestion" safety net for the
# exact-match case.
# See TestWatermarkLimitation in etl/tests/test_dedup_signals_photo_hash.py,
# which pins this so a future retune has to revisit it consciously.
_HASH_HAMMING_THRESHOLD = 10  # imagehash default hash_size=8 -> 64-bit hash
MIN_MATCH_RATIO = Decimal("0.60")
_MAX_SUGGESTION_CONFIDENCE = Decimal("0.800")

# Issue #188/#602, D-137 — approved once issue #197 removed same-source
# pairing. Before #197, a bank/developer listing several units of one block
# on *one* portal with one shared photoset could hit match_ratio == 1.0
# against a genuinely different flat, which is why photo_hash previously
# never auto-merged at all. That same-building-different-unit case is a
# same-source pattern by construction (one portal, one agency's photoset) —
# #197 stops same-source pairs from ever reaching this signal, so what's
# left at match_ratio == 1.0 between two *different* sources is
# corroborated by an EXACT m2_built match and price proximity below,
# rather than by photos alone.
#
# The merge decision is keyed on match_ratio itself (== 1.0 exactly), not
# the scaled `confidence_for_ratio` value: the live suggestion queue's
# match_ratio distribution had nothing between 0.80 and 0.93, so ratio ==
# 1.0 is a clean, non-borderline cut — no calibration needed between
# "clearly a suggestion" and "clearly a merge".
#
# Issue #602/D-137 (2026-08-20, REVISED same day after a review caught the
# original evidence was a tautology — see below) — supersedes #602's own
# original proposal (partial ratio >= 0.6, m2 within 5%, price within 5%,
# a floor-from-text veto, a photo-promiscuity guard) after replaying
# candidate rules against 68 photo_hash pairs the owner reviewed by hand
# (49 merged, 19 rejected):
#
#   - **match_ratio does not discriminate at all.** The 49 merges averaged
#     ratio 1.000; the 19 rejections averaged 0.996 (range 0.929-1.000) —
#     the owner rejected pairs whose photos matched 100%. A rule that leans
#     on photo ratio alone (the #602 >= 0.6 proposal) merges things the
#     owner says are different: the promotion/same-development pattern he
#     predicted from the start. So this signal keeps requiring the FULL
#     ratio == 1.0 that issue #188 already required — never lowered to 0.6.
#     NOTE: `match_ratio` is the fraction of the SMALLER photo set with a
#     match in the larger one (see `match_ratio` below) — "== 1.0" means
#     every photo on the smaller side matched, i.e. the smaller set is a
#     SUBSET of the larger, not that the two sets are identical in size. A
#     3-photo listing fully contained in a 30-photo listing's gallery
#     clears this exactly as a 10-vs-10 exact match does.
#   - **m2_built is a real but narrower discriminator than first measured.**
#     The FIRST version of this decision claimed "ALL 49 merges had
#     identical m2_built; NONE of the 19 rejections did" — that claim was
#     WRONG, a measurement artifact caught in review: `m2_built` lives only
#     on `property`, and after a merge both listings in a pair point at the
#     SAME property row, so naively joining `listing -> property` for an
#     already-confirmed pair returns one m2_built value twice by
#     construction, not two independent measurements. Recovered correctly
#     via `property_merge_log.losing_property_id` (that property row is
#     never touched again once its listings are repointed, so its
#     m2_built is the genuine PRE-merge value; the survivor side is
#     approximated from its CURRENT m2_built, which `perform_merge` never
#     rewrites but could in principle have drifted since — an upper-bound
#     caveat, not a exact one): roughly half of confirmed pairs actually
#     had identical m2_built, not all of them (see D-137 for the
#     reconstructed counts, which vary by sample). What DOES survive
#     cleanly: **zero of the owner's rejections had identical m2_built**
#     (rejected pairs were never merged, so this side of the comparison
#     has no tautology — it's a direct, uncorrupted listing->property
#     join). So the rule is narrower than first claimed — specific
#     (no rejection would slip through), not maximally sensitive (not
#     every real merge has identical m2_built) — which is exactly the
#     conservative trade an irreversible auto-merge should take: `m2_built`
#     exact-equality (`address_coords.sizes_equal`, no tolerance, replacing
#     the old `sizes_close(..., 5%)`) is kept as a required gate because it
#     never contradicted a rejection, not because it captures every merge.
#   - **The issue #186 floor-conflict veto is dropped from this gate on a
#     NARROWER argument than first stated** (the first version claimed
#     m2_built-exact "already separates every merge from every rejection"
#     — also downstream of the same tautology bug above and not the actual
#     basis for this call). The real basis: floor_conflict is present on a
#     meaningful fraction of legitimate human-confirmed merges too (not
#     just rejections) — i.e. it is not a clean discriminator on its own —
#     while m2_built exact-equality ALREADY accounts for every rejection in
#     the sample without it. Keeping floor_conflict as an additional
#     required gate would cost real recall (blocking genuine merges) without
#     preventing any false merge this sample demonstrates, since nothing
#     m2_built-exact already lets through needed floor_conflict to catch
#     it. `floor_conflict` is still computed and written into
#     `PairEvaluation.detail` on every photo_hash verdict so a human
#     reviewing a `suggest` row still sees it — it simply isn't a required
#     gate. #602's own proposed enhancement (reading floor from *both* the
#     structured field and the description text) was never built, since
#     #602's whole rule is superseded by the simpler one here.
#     `structured_fields_conflict` (D-117, property_type/rooms) and the
#     D-116 reference-code veto are unaffected — see evaluate_pair's own
#     docstring and D-117/D-116.
#   - **Price band: 5%, revised from an initial 2% same-day (owner
#     decision, 2026-08-20).** Conditioned on ratio == 1.0 + m2_built
#     identical, EVERY price band tested against the owner's rejections
#     produced zero contradictions in every replay of this sample (see
#     D-137 for the exact reconstructed counts — subject to the same
#     survivor-side-is-current-not-historical caveat as m2_built above,
#     though price band matters less here: these are FIRST-shipped merges
#     evaluated against fresh data, not the historical-auto-merge
#     reconstruction problem described in D-137's "would still fire"
#     analysis). A 2% band was shipped first (thinking 19 rejections was
#     too thin a sample to spend past the owner's own named 1-2% figure),
#     but measured against the LIVE pending queue (not just the 68-pair
#     hand-labeled sample) it was effectively inert: of the pairs already
#     clearing ratio==1.0 + m2_built identical, only a small fraction also
#     cleared 2% price — most of the qualifying candidates sit precisely in
#     the 2-5% band the 2% cut excluded. An inert irreversible-in-practice
#     automation is worse than none: it creates false confidence in
#     coverage the feature doesn't actually provide. 5% was then adopted
#     instead, since it also measured zero contradictions on the same
#     sample — this is not a loosening on a hunch, it is the smallest band
#     that gives the rule actual reach.
#
#     **Why a 2-5% price gap with identical photos and identical
#     m2_built is corroborating evidence, not counter-evidence**: it is
#     the signature of one property with a stale price on one portal (a
#     price change hasn't propagated to every listing yet), not two
#     different units of a development — distinct units in a development
#     differ in m2_built (already excluded by the exact-equality gate
#     above) or otherwise share the developer's list price exactly.
#
#     The now-not-taken option is anything WIDER than 5% — not because a
#     wider band measured unsafe (it wasn't tested past 5%), but because
#     19 hand-labeled rejections is still a thin sample to spend further
#     past what's been measured; 5% is the widest band this specific
#     replay actually covers. `PHOTO_MERGE_PRICE_RATIO` stays a single
#     named constant (this project's convention for every dedup threshold
#     — none of MIN_MATCH_RATIO/address_coords._MAX_SIZE_RATIO/etc. are
#     wired to config/schema.yaml) so widening it further later, on more
#     labeled evidence, is a one-line change to a documented constant — a
#     data decision, not a rediscovery of this reasoning.
#
#   - **This is not a net-new merge path — it TIGHTENS an existing,
#     high-volume, already-irreversible one.** `property_merge_log` shows
#     several hundred photo_hash auto-merges already performed under the
#     pre-existing issue #188 rule (exact ratio + 5% size + 2% price)
#     before this decision. Since the old rule's price band (2%) is a
#     SUBSET of the new one (5%), and `m2_built` is far more stable
#     post-merge than price (a surviving listing's price keeps getting
#     re-fetched; m2_built does not), the overwhelming majority of those
#     historical auto-merges have identical m2_built and would fire again
#     unchanged under the new rule — the reduction is concentrated in the
#     minority that differ on m2_built alone. See D-137 for the exact
#     reconstructed count. Framing this as "how many pairs does this add"
#     understates what actually matters: how much of an already-running,
#     irreversible automation this tightens versus leaves as-is.
#
# See D-137 for the full replay methodology, the corrected evidence table,
# the property-pair-level live-queue reach measurement, and the
# would-this-historical-merge-still-fire breakdown.
PHOTO_MERGE_PRICE_RATIO = Decimal("0.05")
PHOTO_MERGE_CONFIDENCE = Decimal("0.900")


@dataclass
class PhotoFetchStats:
    """What one `fetch_hashes_with_stats` call actually did.

    The split that matters is **live vs. cached**, and it exists because of
    issue #206's `zero_success_sources` health rollup. That rollup asks "did
    this source hash zero photos?" as a proxy for "is this source's CDN dead?"
    — a question only *live* traffic can answer. Counting store hits towards
    it (as the first cut of #221 did) permanently silences the detector: hashes
    cached while the CDN was healthy keep the success count non-zero forever,
    so the exact incident it was built for (#209/#213, every Milanuncios photo
    404ing) reports a healthy source. See `zero_success_sources` in
    `etl.dedup.engine`.

    `live_attempted` counts URLs this call issued a network request for: not
    the video/tour links `_looks_like_photo_url` filters out, not store hits,
    and not a repeat of a URL already fetched in this same call.
    """

    live_attempted: int = 0
    live_hashed: int = 0
    cached_hashed: int = 0
    cached_failed: int = 0
    store_write_failures: int = 0

    @property
    def failed(self) -> int:
        """Photos that produced no hash, live failures and cached ones alike."""
        return (self.live_attempted - self.live_hashed) + self.cached_failed


def fetch_hashes(
    photo_urls: tuple[str, ...], *, source: str = "unknown", store_conn=None
) -> list[imagehash.ImageHash]:
    """Fetch and hash each URL; skip (don't raise on) any that fail.

    Thin wrapper over `fetch_hashes_with_stats` for callers that only want the
    hashes. Anything reporting on *fetch health* must use that function
    instead — the hash list alone cannot distinguish a photo hashed over the
    network this run from one read out of the store, and conflating the two is
    what broke the #206 rollup (see `PhotoFetchStats`).
    """
    return fetch_hashes_with_stats(photo_urls, source=source, store_conn=store_conn)[0]


def fetch_hashes_with_stats(
    photo_urls: tuple[str, ...], *, source: str = "unknown", store_conn=None
) -> tuple[list[imagehash.ImageHash], PhotoFetchStats]:
    """Fetch and hash each URL; skip (don't raise on) any that fail.

    Thin wrapper over `fetch_hash_pairs_with_stats` (issue #615) that drops
    the URL each hash came from — every existing caller/test here only ever
    wanted the hash values, so this function's own return shape and every
    log line/side effect it produces are UNCHANGED by that split. Use
    `fetch_hash_pairs_with_stats` instead when the caller needs to know
    which specific photo a hash belongs to (e.g. to report which images a
    photo_hash match actually matched, not just the aggregate ratio).
    """
    pairs, stats = fetch_hash_pairs_with_stats(
        photo_urls, source=source, store_conn=store_conn
    )
    return [h for _url, h in pairs], stats


def fetch_hash_pairs_with_stats(
    photo_urls: tuple[str, ...], *, source: str = "unknown", store_conn=None
) -> tuple[list[tuple[str, imagehash.ImageHash]], PhotoFetchStats]:
    """Fetch and hash each URL; skip (don't raise on) any that fail.

    Same fetch loop as `fetch_hashes_with_stats` (that function is now a
    thin wrapper over this one — issue #615), but returns each hash PAIRED
    with the URL it came from, so a caller can report which specific photo
    matched another listing's specific photo, not just an aggregate ratio.
    Never re-derive this pairing elsewhere (e.g. by re-hashing in the
    dashboard) — this is the one place a photo URL and its hash are
    produced together.

    Returns the pairs plus a `PhotoFetchStats` describing how they were
    obtained — see that class for why the live/cached split is load-bearing.

    Issue #221: when *store_conn* is given, per-URL results are read from and
    written to the `photo_hashes` table, so a URL is fetched at most once ever
    rather than once per run. Passing None keeps the original fetch-everything
    behaviour, which is what the pure-comparison unit tests rely on — the
    persistence is a cost optimisation over an immutable value, never a change
    in what gets compared.

    A single broken/expired photo URL shouldn't sink the whole comparison —
    this is a best-effort signal, not a required one. That extends to the store
    itself: `photo_hash_store.load`/`save` never raise, so a database problem
    degrades to fetching the photo, never to a failed dedup run.

    URLs that don't look like a static image (a YouTube/Vimeo walkthrough, a
    Floorfy/Matterport virtual tour, ...) are skipped before the network
    call — see `_looks_like_photo_url` above for why this matters beyond
    just saving a doomed request.

    Issue #206: per-photo fetch/hash failures used to each log their own
    WARNING — dozens of near-identical lines per run when a whole source's
    CDN is unfetchable for one systemic reason (a live example: every
    Milanuncios photo 404ing "Rule parameter not Found"). Failures are now
    logged individually at DEBUG (still in the logs if someone's looking at
    that level) and rolled up into a single WARNING per listing here.
    `source` (the connector name, e.g. "milanuncios") is just for that one
    line's context — it does not change fetch/hash behaviour.
    """
    pairs: list[tuple[str, imagehash.ImageHash]] = []
    stats = PhotoFetchStats()
    # Seeded from the store, then kept current as this call's own fetches land
    # so a URL repeated inside one `photo_urls` tuple is fetched once rather
    # than once per occurrence. Every occurrence still contributes its hash —
    # the memo suppresses the request, not the result, so `match_ratio`'s
    # denominators are exactly what they were before.
    known: dict[str, photo_hash_store.StoredHash] = (
        photo_hash_store.load(store_conn, photo_urls) if store_conn else {}
    )
    for url in photo_urls:
        if not _looks_like_photo_url(url):
            logger.debug("photo_hash: skipping non-image URL %s", url)
            continue
        # A hit here is the whole point of #221: no request at all. A cached
        # failure still counts as a failure for this listing's rollup, but
        # neither a cached success nor a cached failure is evidence about the
        # CDN's state *now* — that's what the live_* counters are for.
        if url in known:
            entry = known[url]
            if entry.ok and entry.phash is not None:
                pairs.append((url, entry.phash))
                stats.cached_hashed += 1
            else:
                stats.cached_failed += 1
            continue
        stats.live_attempted += 1
        try:
            with requests.get(
                url, timeout=_REQUEST_TIMEOUT_SECONDS, stream=True
            ) as response:
                response.raise_for_status()
                response.raw.decode_content = True
                image = Image.open(response.raw)
                digest = imagehash.phash(image)
        except Exception as exc:  # noqa: BLE001 - genuinely best-effort per photo
            logger.debug("photo_hash: failed to fetch/hash %s: %s", url, exc)
            known[url] = photo_hash_store.StoredHash(
                photo_url=url, phash=None, ok=False
            )
            if store_conn and not photo_hash_store.save(
                store_conn,
                photo_url=url,
                phash=None,
                source=source,
                failure_reason=str(exc)[:500],
            ):
                stats.store_write_failures += 1
            continue
        # Success bookkeeping deliberately sits outside the try: a failure
        # while *recording* a hash must not also count it as a failed fetch.
        pairs.append((url, digest))
        stats.live_hashed += 1
        known[url] = photo_hash_store.StoredHash(photo_url=url, phash=digest, ok=True)
        if store_conn and not photo_hash_store.save(
            store_conn, photo_url=url, phash=digest, source=source
        ):
            stats.store_write_failures += 1
    if stats.failed:
        logger.warning(
            "photo_hash: %d/%d photo(s) failed to fetch/hash (source=%s) — "
            "see DEBUG logs for the individual URLs/errors",
            stats.failed,
            stats.failed + len(pairs),
            source,
        )
    if stats.store_write_failures:
        logger.warning(
            "photo_hash: %d photo hash(es) could not be written to the store "
            "(source=%s) — they will be re-fetched on a later run; see DEBUG "
            "logs for the individual URLs/errors",
            stats.store_write_failures,
            source,
        )
    return pairs, stats


def pack_hash(h: imagehash.ImageHash) -> int:
    """Pack a 64-bit `ImageHash` into a plain Python int for cheap
    XOR+popcount comparison (issue #618) instead of `ImageHash.__sub__`'s
    per-comparison numpy `flatten()` + `count_nonzero` — measured ~0.9us
    vs ~0.02us as a Python int op, and the O(|A|x|B|) `match_ratio` call is
    71% of the whole dedup pass at production scale (#617's profile).

    `int(str(h), 16)` rather than reaching into `h.hash` and re-deriving a
    bit order by hand: `ImageHash.__str__` (`_binary_array_to_hex`) is the
    one place this codebase — and `photo_hash_store`'s persisted hex
    column — already trusts to turn the flattened bit array into a number.
    Reusing it means this function is *provably* the same bit pattern
    `ImageHash.__sub__` compares (same flatten order feeding both the hex
    string and the subtraction), not a second, possibly-diverging
    reimplementation of the packing. XOR-popcount of two such ints is then
    exactly `count_nonzero(a.flatten() != b.flatten())`: same bit-index
    correspondence on both operands, so it's just a reordering that cancels
    out in the comparison.

    Every phash in this codebase is `imagehash.phash(image)` at imagehash's
    default `hash_size=8` (see `_HASH_HAMMING_THRESHOLD`'s comment below) —
    always a 64-bit (8x8) hash; no call site anywhere overrides
    `hash_size`/`highfreq_factor`. Raises `ValueError` instead of silently
    packing a different bit width: an unnoticed size mismatch would XOR
    bits that don't correspond to the same DCT coefficient on each side,
    corrupting every ratio it touches without ever raising.
    """
    if h.hash.size != 64:
        raise ValueError(
            f"pack_hash: expected a 64-bit (hash_size=8) ImageHash, got "
            f"{h.hash.size} bits — packed-int comparison assumes 64-bit "
            f"throughout this codebase (see this function's docstring)"
        )
    return int(str(h), 16)


def match_ratio(hashes_a: list[int], hashes_b: list[int]) -> float | None:
    """Fraction of the smaller hash set with a close match in the other set.

    Returns None when there isn't enough data to compare (either side has
    zero successfully-hashed photos) rather than 0.0, so the engine can
    distinguish "we checked and they don't match" from "we couldn't check".

    *hashes_a*/*hashes_b* are packed 64-bit ints (`pack_hash`), not
    `imagehash.ImageHash` objects — see that function's docstring for why
    `(h_small ^ h_large).bit_count()` is exactly the Hamming distance
    `ImageHash.__sub__` would have computed for the same pair.
    """
    if not hashes_a or not hashes_b:
        return None

    smaller, larger = (
        (hashes_a, hashes_b) if len(hashes_a) <= len(hashes_b) else (hashes_b, hashes_a)
    )
    matched = sum(
        1
        for h_small in smaller
        if any(
            (h_small ^ h_large).bit_count() <= _HASH_HAMMING_THRESHOLD
            for h_large in larger
        )
    )
    return matched / len(smaller)


@dataclass(frozen=True)
class MatchedPhotoPair:
    """One photo on each side that `matched_pairs` judged a match, plus how
    strong that match was. `distance` is the raw Hamming distance (lower =
    stronger; 0 = pixel-identical hash) — the same metric `match_ratio`
    thresholds against, exposed here per-pair instead of collapsed into one
    aggregate ratio."""

    url_a: str
    url_b: str
    distance: int


def matched_pairs(
    pairs_a: list[tuple[str, imagehash.ImageHash]],
    pairs_b: list[tuple[str, imagehash.ImageHash]],
) -> list[MatchedPhotoPair]:
    """Which specific photo on side A matched which specific photo on side
    B, strongest match first (issue #615).

    Before this, `match_ratio` only ever reported an aggregate fraction —
    "92% of the smaller set matched" — with no record of WHICH photos
    produced that number. That made a photo_hash suggestion's evidence
    fundamentally unviewable: a card could only show "photo #1 of listing A
    next to photo #1 of listing B", which is frequently two unrelated rooms
    when the actual match was, say, photo #5 against photo #9. This
    function is the one place that pairing is computed — callers (the
    dashboard included) must consume its output, never re-derive matches
    themselves from raw hashes (that would be a second, driftable
    implementation of the exact same threshold logic `match_ratio` already
    owns).

    Mirrors `match_ratio`'s own matching rule exactly (iterate the SMALLER
    side, each hash's best candidate in the LARGER side within
    `_HASH_HAMMING_THRESHOLD`) so a card's "N photos matched" count is
    never inconsistent with `match_ratio`'s own denominator — but reports
    each pairing's actual URLs and distance instead of collapsing to one
    fraction. "Best candidate" is the closest (lowest-distance) match, not
    just the first one found within threshold, so a listing with several
    near-duplicate photos pairs each small-side photo with its truest
    match rather than an arbitrary "good enough" one. A larger-side photo
    CAN be the best match for more than one smaller-side photo (e.g. two
    near-identical shots of the same room) — not deduplicated, since that
    is itself useful signal for a human judging "is this really the same
    unit", not a bug to hide.

    NOTE (issue #624 review): `match_ratio` is the fraction of the
    SMALLER set, so a ratio of 1.0 means the smaller set is a SUBSET of
    the larger one, not that the two sets are equal — a 3-photo listing
    fully contained inside a 30-photo one is a real, currently-live shape.
    `matched_pairs` mirrors that asymmetry deliberately: it never assumes
    `len(pairs_a) == len(pairs_b)`, iterates only the smaller side, and
    the larger side's un-matched photos simply never appear in the
    output — there is no requirement that every larger-side photo find a
    partner. See `TestMatchedPairs::test_asymmetric_subset_shape` for the
    exact 3-vs-30 case pinned as a fixture.

    Always returns url_a from *pairs_a* and url_b from *pairs_b*,
    regardless of which side happens to be smaller internally — the
    caller never has to know or care.
    """
    if not pairs_a or not pairs_b:
        return []

    a_is_smaller = len(pairs_a) <= len(pairs_b)
    smaller, larger = (pairs_a, pairs_b) if a_is_smaller else (pairs_b, pairs_a)

    # PR #621 review perf note: this is an O(|smaller| x |larger|) scan on
    # raw ImageHash.__sub__ (numpy subtraction under the hood) — after
    # issue #623's packed-hash rewrite of the rest of the photo_hash path
    # (get_packed / match_ratio), this loop is the only remaining
    # numpy-subtraction hot path in the signal. Left as-is deliberately:
    # matched_pairs only ever runs on pairs that ALREADY cleared
    # MIN_MATCH_RATIO (evaluate_pair calls it after match_ratio, not
    # instead of it) — a few hundred pairs per dedup pass, not the full
    # O(n^2) corpus — so the cost is negligible in practice. Worth a
    # packed-array rewrite if that ever stops being true, not before.
    found: list[MatchedPhotoPair] = []
    for url_small, h_small in smaller:
        best: tuple[str, int] | None = None
        for url_large, h_large in larger:
            # int(): imagehash's `-` returns numpy.int64, not a plain
            # Python int. match_ratio (elsewhere in this module) only ever
            # divides that value into a plain float, so this never
            # mattered before — but matched_pairs stores the raw distance
            # itself, and an un-cast numpy.int64 inside `detail` crashes
            # `json.dumps` at `file_suggestion`'s write (caught by
            # TestDedupRunResultPhotoHealth's real-Postgres test, the one
            # test in this suite that hashes real in-memory images rather
            # than building an ImageHash straight from a hex string).
            distance = int(h_small - h_large)
            if distance <= _HASH_HAMMING_THRESHOLD and (
                best is None or distance < best[1]
            ):
                best = (url_large, distance)
        if best is not None:
            url_large, distance = best
            if a_is_smaller:
                found.append(
                    MatchedPhotoPair(
                        url_a=url_small, url_b=url_large, distance=distance
                    )
                )
            else:
                found.append(
                    MatchedPhotoPair(
                        url_a=url_large, url_b=url_small, distance=distance
                    )
                )

    found.sort(key=lambda p: p.distance)
    return found


def hashes_share_any_match(hashes_a: list[int], hashes_b: list[int]) -> bool:
    """True when at least one hash in *hashes_a* is within the same
    matching Hamming distance `match_ratio` uses of at least one hash in
    *hashes_b*.

    A looser bar than `match_ratio`'s MIN_MATCH_RATIO fraction-of-the-
    smaller-set threshold — "at least one shared photo", not "most of
    them match". Used by issue #601's fuzzy-purge rescue set: a pending
    `fuzzy` pair whose two listings have exactly equal m2_built and
    current_price, corroborated by even partial photo overlap, is worth
    keeping even though its overall `match_ratio` never cleared
    `MIN_MATCH_RATIO` (that's WHY it only ever reached `fuzzy` in the
    first place — see `etl.dedup.engine.evaluate_pair`'s priority order).

    *hashes_a*/*hashes_b* are packed 64-bit ints (`pack_hash`) — see
    `match_ratio`'s docstring.
    """
    return any(
        (h_a ^ h_b).bit_count() <= _HASH_HAMMING_THRESHOLD
        for h_a in hashes_a
        for h_b in hashes_b
    )


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
