"""Signal 5: fuzzy fallback — address text similarity + price/size proximity
(issue #16 item 5). Always a suggestion, confidence <0.6, never auto-merge.

The weakest, last-resort signal — only fires when a pair shares no phone
number, no cadastral, and no close coordinates, but still looks plausibly
like the same property (similar address text, similar price, similar size).
"""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal

from rapidfuzz import fuzz

from etl.dedup.signals.floor import floors_conflict
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
