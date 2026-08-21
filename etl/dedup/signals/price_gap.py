"""Signal: reject a pair outright on a price gap too large to plausibly be
the same unit (issue #627, D-138).

The owner's rule, in his words: *"cuando la diferencia en el precio es de
más de un 30% hay que rechazar directamente el duplicado. Y si la
diferencia es del 15% o más y la superficie también es diferente un 10% o
más, o las habitaciones, rechazamos también."* — refined once on the size
threshold: *"los metros pueden ser un 5% de diferencia y habitaciones
diferentes también afectan, para así salvar el problema de las promociones
que son muchos."* Two rules, either one rejects the pair:

1. Price differs by MORE than `PRICE_GAP_HARD_REJECT_RATIO` (30%).
2. Price differs by `PRICE_GAP_SOFT_REJECT_RATIO` (15%) OR MORE, **and**
   either `m2_built` differs by `SIZE_GAP_REJECT_RATIO` (5%, per the
   owner's refinement — not the 10% first stated) or more, OR the two
   sides' `rooms` genuinely differ (see below).

Measured against the owner's own decision history (reconstructed via
`property_merge_log.losing_property_id` — never a `listing -> property`
self-join, which returns one merged pair's survivor property twice and
manufactures agreement; see D-137's own correction for the incident that
methodology mistake caused): the full rule reproduces 3 of 88 (3.4%) of
his merges and 24 of 62 (39%) of his rejections. 5% and 10% on the size
leg catch IDENTICALLY on that same history — the rooms condition and the
price gap are what's doing the work, not the specific size percentage.
**5% is used because it's the owner's stated, later-refined intent, not
because it was measured to outperform 10%** — say so plainly rather than
manufacturing evidence for it the way an earlier analysis in this repo did
(retracted; see D-137). Two of the three contradicted merges are the same
fotocasa-vs-idealista pair (32 vs 37 m², 48%/58% price gaps) the owner
confirmed *before* the photo-match card existed (#615/#621) — i.e.
decided without being able to see the photos side by side. They may be
this rule's successes rather than its failures.

**Rooms threshold — reuses `structured_fields.rooms_conflict`, not a
second implementation.** That predicate already treats `rooms=0` as
unknown (D-117's "B3": a scrape artifact, not a genuine studio count —
`_usable_rooms`) and already requires a difference of at least
`structured_fields._ROOMS_CONFLICT_MIN_DIFF` (2), never exactly 1, on a
real, large-sample measurement (issue #566: 6,728 pending pairs at exactly
a 1-room difference vs. 1,966 at >=2 — portals genuinely disagree on
whether a study/interior room counts, and vetoing on that tolerance would
cost real recall at scale). A supplementary check against this session's
production decision history (59 genuine human confirms, 1 genuine human
reject, reconstructed the same way — see `docs/decisions/D-138-*.md` for
the exact counts) found the sample too small to independently discriminate
between "differs by 1" and "differs by >=2" for *this* rule (zero cases
either threshold would have caught differently) — it neither confirms nor
contradicts D-117's own larger-sample finding, so D-117's threshold is
reused rather than re-decided from a much thinner sample.

**Missing values never reject.** NULL price on either side, NULL/zero
`m2_built`, NULL/zero `rooms` (`rooms=0` treated as unknown, same as
`structured_fields.rooms_conflict`) — a rule that rejects on unknown data
is worse than no rule, per the owner's own framing.

Deliberately NOT wired ahead of `cadastral` or `reference_code` (D-116) in
`etl.dedup.engine.evaluate_pair` — see that function's docstring for exact
placement. This module is a pure predicate, no DB access, no network call,
same shape as every other signal module here.
"""

from __future__ import annotations

from decimal import Decimal

from etl.dedup.signals import structured_fields
from etl.dedup.types import ListingRecord

# Rule 1: a price gap over this ratio rejects on its own, regardless of
# size/rooms. "Más de un 30%" — strictly greater than, not inclusive.
PRICE_GAP_HARD_REJECT_RATIO = Decimal("0.30")

# Rule 2: a price gap at or above this ratio, corroborated by a size or
# rooms mismatch, rejects. "15% o más" — inclusive.
PRICE_GAP_SOFT_REJECT_RATIO = Decimal("0.15")

# The size leg of rule 2. "Los metros pueden ser un 5% de diferencia" (the
# owner's refinement, replacing an initially-stated 10%) — inclusive, same
# "or more" reading as the price legs above.
SIZE_GAP_REJECT_RATIO = Decimal("0.05")


def _diff_ratio(x: Decimal | None, y: Decimal | None) -> Decimal | None:
    """`abs(x - y) / max(x, y)` — the same ratio convention
    `address_coords.prices_close`/`sizes_close` already use elsewhere in
    this pipeline. `None` when either side is missing or non-positive:
    missing/unusable data is "we don't know", never "they differ".
    """
    if x is None or y is None or x <= 0 or y <= 0:
        return None
    return abs(x - y) / max(x, y)


def price_gap_conflict(a: ListingRecord, b: ListingRecord) -> dict | None:
    """Return a detail dict when this pair should be rejected on price-gap
    grounds, else `None`.

    A missing/non-positive price on either side always returns `None` —
    rule 1 and rule 2 both key off the price ratio, so there is nothing to
    evaluate without it. See this module's docstring for the exact rule
    and its measured impact/contradiction rate.
    """
    price_ratio = _diff_ratio(a.current_price, b.current_price)
    if price_ratio is None:
        return None

    if price_ratio > PRICE_GAP_HARD_REJECT_RATIO:
        return {
            "rule": "price_gap_over_30pct",
            "price_diff_pct": float(price_ratio * 100),
        }

    if price_ratio >= PRICE_GAP_SOFT_REJECT_RATIO:
        size_ratio = _diff_ratio(a.m2_built, b.m2_built)
        size_differs = size_ratio is not None and size_ratio >= SIZE_GAP_REJECT_RATIO
        rooms_differ = structured_fields.rooms_conflict(a, b)
        if size_differs or rooms_differ:
            detail: dict = {
                "rule": "price_gap_15pct_with_size_or_rooms",
                "price_diff_pct": float(price_ratio * 100),
            }
            if size_differs:
                detail["size_diff_pct"] = float(size_ratio * 100)
            if rooms_differ:
                detail["rooms_a"] = a.rooms
                detail["rooms_b"] = b.rooms
            return detail

    return None
