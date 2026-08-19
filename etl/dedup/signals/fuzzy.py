"""Signal 5: fuzzy fallback — address text similarity + price/size proximity
(issue #16 item 5). Always a suggestion, confidence <0.6, never auto-merge.

The weakest, last-resort signal — only fires when a pair shares no phone
number, no cadastral, and no close coordinates, but still looks plausibly
like the same property (similar address text, similar price, similar size).

Issue #566: a `property_type`/`rooms` contradiction (see
`etl.dedup.signals.structured_fields`) vetoes this signal's suggestion
outright — deliberately scoped to fuzzy ONLY, not wired into
`etl.dedup.engine.evaluate_pair` ahead of every signal the way the
reference-code veto (D-116) is. Two reasons, both measured against the
live demo DB:

1. This is where the issue's own case actually holds. Of 27,145 pending
   `suggested_merge` rows, 97.1% are `match_basis='fuzzy'`, and price/size
   are ALREADY gated here (the checks above) — so a pair that reaches this
   point and still contradicts on `property_type`/`rooms` is agreeing on
   price and size while disagreeing on a structured fact, which is real
   discriminating signal, not noise.

2. Placing the veto engine-wide would have been wrong. The blast-radius
   measurement this issue requires found `property_type`/`rooms` are noisy
   per-connector metadata that regularly disagree even on definite,
   strongly-corroborated duplicates: ~80 of 590 currently-merged properties
   (13.6%; independently reproduced in PR #567's review as 104 merge-log
   rows / 80 properties) matched via address_coords/reference_code/
   photo_hash — identical photos, identical price, identical size — carry
   a `property_type` or `rooms` mismatch between their two original source
   rows (e.g. one portal maps the exact same flat as "chalet", another as
   "piso"; one scrape recorded `rooms=0`, a later one `rooms=4`, for the
   SAME listing — see structured_fields.py's B3 for why `rooms=0` is now
   treated as unusable). An engine-wide veto ahead of those signals would
   have broken ~80 already-correct merges. See PR body for the query and
   sampled pairs.

Deliberately NOT extended to `photo_hash`'s own `suggest` path (ratio < 1.0,
never auto-merges) or `phone`'s: ~45 pending `photo_hash` rows and ~33
pending `phone` rows carry the same kind of structured-field contradiction,
untouched on purpose — an exact/partial photo match or a shared phone
number is independent, often stronger, evidence this veto must not
override (D-117 point 5).

Issue #568 (D-118): a normalized-municipality conflict (see
`etl.dedup.signals.municipality`) vetoes this signal's suggestion outright
— scoped to `fuzzy` ONLY, mirroring `structured_fields_conflict` (D-117)
exactly, and for the same reason: `fuzzy` is the one signal where the
issue's own blast-radius measurement holds (a currently-merged property's
`city` genuinely differing between its surviving and losing sides,
measured across every non-reverted `property_merge_log` row, was found on
Málaga/Estepona and Málaga/Churriana — the latter a REAL Málaga-district
case a hard engine-wide veto would have broken; see
`etl.dedup.signals.municipality`'s docstring for the full evidence). Every
stronger signal (`cadastral`, `address_coords`, `phone_extract`,
`reference_code`, `photo_hash`) is untouched, same as D-117. Checked AFTER
`structured_fields_conflict` below — order between the two never matters in
practice (both are simple `if ...: return None` vetoes on independent
fields), but structured_fields (D-117) landed first, so this keeps the
edit diff-minimal and the two vetoes read in landing order.
"""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal

from rapidfuzz import fuzz

from etl.dedup.signals.floor import floors_conflict
from etl.dedup.signals.municipality import municipality_conflict
from etl.dedup.signals.structured_fields import structured_fields_conflict
from etl.dedup.types import ListingRecord, PairEvaluation

_MIN_TEXT_SIMILARITY = 0.55  # rapidfuzz score is 0-100; compared as a 0-1 ratio below
_MAX_SIZE_RATIO = Decimal("0.10")
_MAX_PRICE_RATIO = Decimal("0.20")
_MAX_CONFIDENCE = Decimal("0.590")  # strictly below the 0.6 auto-merge-adjacent bar

_ABBREVIATIONS = {
    # Trailing `(?!\w)` rather than `\b`: a `\b` word-boundary assertion
    # requires an actual word/non-word transition, which "c/ trafalgar" or
    # "cl. mayor" never have at the point right after the `/`/`.` (both
    # that character and the following space are non-word — no transition,
    # so `\b` silently never matches). `(?!\w)` just asserts "not a word
    # character next", which the following space satisfies either way.
    # Found dead in review (PR #55): these three never matched their
    # real-world space-separated form, silently breaking the single most
    # common Spanish address abbreviation pattern.
    r"\bc/(?!\w)": "calle",
    r"\bcl\.?(?!\w)": "calle",
    r"\bavda\.?(?!\w)": "avenida",
    r"\bav\.?(?!\w)": "avenida",
    r"\bpza\.?(?!\w)": "plaza",
    r"\bpº(?!\w)": "paseo",
}


def normalize_address(address: str) -> str:
    """Lowercase, strip accents/punctuation, expand common abbreviations."""
    text = address.lower().strip()
    for pattern, replacement in _ABBREVIATIONS.items():
        text = re.sub(pattern, replacement, text)
    # Strip accents: decompose then drop combining marks.
    text = "".join(
        ch
        for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def evaluate(a: ListingRecord, b: ListingRecord) -> PairEvaluation | None:
    if not a.address or not b.address:
        return None

    similarity = (
        fuzz.token_sort_ratio(
            normalize_address(a.address), normalize_address(b.address)
        )
        / 100
    )
    if similarity < _MIN_TEXT_SIMILARITY:
        return None

    if a.m2_built is None or b.m2_built is None or a.m2_built <= 0 or b.m2_built <= 0:
        return None
    size_ratio = abs(a.m2_built - b.m2_built) / max(a.m2_built, b.m2_built)
    if size_ratio > _MAX_SIZE_RATIO:
        return None

    if (
        a.current_price is None
        or b.current_price is None
        or a.current_price <= 0
        or b.current_price <= 0
    ):
        return None
    price_ratio = abs(a.current_price - b.current_price) / max(
        a.current_price, b.current_price
    )
    if price_ratio > _MAX_PRICE_RATIO:
        return None

    # Issue #566: unlike floor below (annotate, never veto here), a
    # property_type/rooms contradiction kills the suggestion outright — see
    # this module's docstring for why that's safe specifically for fuzzy
    # and not for the signals above/below it in evaluate_pair's priority
    # order.
    if structured_fields_conflict(a, b):
        return None

    # Issue #568 (D-118): a normalized-municipality conflict kills the
    # suggestion outright — same "veto here, not in evaluate_pair" shape
    # as structured_fields_conflict directly above; see this module's
    # docstring for why that's safe specifically for fuzzy.
    if municipality_conflict(a, b):
        return None

    confidence = min(Decimal(str(round(similarity, 3))), _MAX_CONFIDENCE)
    detail: dict = {"address_similarity": round(similarity, 3)}
    # Issue #186: this signal never auto-merges (always 'suggest', capped
    # below 0.6), so a floor mismatch doesn't need to veto anything the way
    # it does for address_coords/phone/reference_code's merge paths — but
    # it's still the cheapest available discriminator for "same building,
    # different unit" (the owner's own framing), so surface it in `detail`
    # for the human reviewing the suggestion rather than leaving the
    # discriminating data unread, same as photo_hash below.
    if floors_conflict(a.floor, b.floor):
        detail["floor_conflict"] = True
    return PairEvaluation(
        basis="fuzzy",
        confidence=confidence,
        decision="suggest",
        detail=detail,
    )
