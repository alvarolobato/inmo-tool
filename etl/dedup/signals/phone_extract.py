"""Signal 3: phone number shared in free-text description (issue #16 item 3).

Phone-number match alone is never sufficient for auto-merge — the same
number (an agency's front-desk line especially) commonly appears across many
unrelated, similarly-sized listings. This module never returns a 'merge'
decision on its own; the confidence/decision split (uncorroborated
suggestion vs. corroborated auto-merge vs. corroborated-but-not-confirmed-
particular suggestion) all lives in `evaluate()` below, driven by the rules
in issue #16.

Corroboration and the listing_kind gate
----------------------------------------
Issue #16 defines "corroborated" as "essentially signal 2's thresholds"
(coordinates within ~15m + size within ~5%). Coordinates are only sometimes
available in practice (see address_coords.py's module docstring) — a
literal coordinates-only reading of "corroborated" would make phone-
corroboration unreachable for the (likely common) case where a listing
doesn't happen to publish precise lat/lon, which can't be the intent given
phone-in-description is called out elsewhere as the actual workhorse
signal. This module's `_corroborated` therefore falls back to price + size
proximity (looser tolerances than signal 2, since it's a weaker stand-in
for a coordinate check, not the coordinate check itself) whenever
coordinates aren't available on both sides.

Issue #16 also only gives two `listing_kind` outcomes explicitly: both
`'particular'` -> auto-merge; either `'agency'` -> always suggestion. It
doesn't say what to do when a side's kind is unconfirmed (`None`) — Fotocasa's
`infer_listing_kind` (etl/connectors/fotocasa_mapping.py) deliberately never
guesses `'particular'`, only ever returns a confirmed `'agency'` or `None`.
Treating `None` as satisfying the "both particular" gate would mean trusting
an *absence* of information as if it were a positive confirmation — exactly
the guessing problem that mapping module's own docstring says to avoid. This
module therefore requires a literal `'particular'` on *both* sides for
auto-merge; `None` on either side falls through to a corroborated-but-
unconfirmed suggestion tier (confidence 0.75, between the 0.5 uncorroborated
tier and the 0.9 auto-merge tier) rather than either auto-merging or being
silently treated the same as an uncorroborated match.
"""

from __future__ import annotations

import re
from decimal import Decimal

from etl.dedup.signals.address_coords import (
    coords_close,
    floors_conflict,
    prices_close,
    sizes_close,
)
from etl.dedup.types import ListingRecord, PairEvaluation

# Spanish mobile/landline: 9 digits starting 6/7/8/9, optional +34 prefix,
# optional spaces/dots/hyphens as separators. Matches the pattern already
# noted (but not wired up, per PR #54's review) in etl/connectors/milanuncios.py.
# Digit-boundary guards ((?<!\d)/(?!\d), added after Opus review of PR #55)
# stop this from matching *inside* a longer digit run — without them,
# "Ref. 600123456789" would extract a phantom "600123456".
_PHONE_RE = re.compile(
    r"(?<!\d)(?:\+34[\s.-]?)?[6789]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}(?!\d)"
)

_UNCORROBORATED_CONFIDENCE = Decimal("0.500")
_CORROBORATED_UNCONFIRMED_KIND_CONFIDENCE = Decimal("0.750")
_CORROBORATED_PARTICULAR_CONFIDENCE = Decimal("0.900")

# Looser than signal 2's 5% size / strict-coords bar — this is a fallback
# stand-in for a coordinate check the connectors can't actually supply, not
# the coordinate check itself, so it's deliberately more forgiving.
_CORROBORATION_SIZE_RATIO = Decimal("0.05")
_CORROBORATION_PRICE_RATIO = Decimal("0.10")


def extract_phones(text: str | None) -> set[str]:
    """Return the set of normalized (digits-only) phone numbers found in text."""
    if not text:
        return set()
    found = set()
    for match in _PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group())
        # Strip a leading country code (34) once, if present, so "+34 622..."
        # and "622..." normalize to the same key.
        if digits.startswith("34") and len(digits) == 11:
            digits = digits[2:]
        if len(digits) == 9:
            found.add(digits)
    return found


def _corroborated(a: ListingRecord, b: ListingRecord) -> bool:
    # Issue #186: floor as an additional required corroborating condition,
    # checked before either proximity path below rather than folded into
    # each — a floor present on both sides that disagrees is direct
    # evidence of "different unit, same building" and must veto
    # corroboration regardless of which proximity path would otherwise
    # succeed. Floor missing on either side is permissive (see
    # etl.dedup.signals.floor's module docstring): falls through to the
    # existing coords/price/size checks unaffected.
    if floors_conflict(a.floor, b.floor):
        return False
    if coords_close(a.lat, a.lon, b.lat, b.lon) and sizes_close(
        a.m2_built, b.m2_built, Decimal("0.05")
    ):
        return True
    # Fallback: price + size proximity when coordinates aren't available on
    # both sides (see module docstring) — the realistic path for this
    # project's actual connectors.
    return sizes_close(
        a.m2_built, b.m2_built, _CORROBORATION_SIZE_RATIO
    ) and prices_close(a.current_price, b.current_price, _CORROBORATION_PRICE_RATIO)


def evaluate(a: ListingRecord, b: ListingRecord) -> PairEvaluation | None:
    shared = extract_phones(a.description) & extract_phones(b.description)
    if not shared:
        return None

    detail = {"shared_phone_digits": sorted(shared)}

    if not _corroborated(a, b):
        return PairEvaluation(
            basis="phone",
            confidence=_UNCORROBORATED_CONFIDENCE,
            decision="suggest",
            detail=detail,
        )

    if a.listing_kind == "particular" and b.listing_kind == "particular":
        return PairEvaluation(
            basis="phone",
            confidence=_CORROBORATED_PARTICULAR_CONFIDENCE,
            decision="merge",
            detail=detail,
        )

    if a.listing_kind == "agency" or b.listing_kind == "agency":
        # Explicit agency signal on either side: never auto-merge on phone,
        # regardless of corroboration (an agency number is reused across
        # unrelated listings by construction).
        return PairEvaluation(
            basis="phone",
            confidence=_UNCORROBORATED_CONFIDENCE,
            decision="suggest",
            detail=detail,
        )

    # Corroborated, but at least one side's listing_kind is unconfirmed
    # (None) rather than a positively-identified 'agency' — see module
    # docstring for why this doesn't get treated as 'particular'.
    return PairEvaluation(
        basis="phone",
        confidence=_CORROBORATED_UNCONFIRMED_KIND_CONFIDENCE,
        decision="suggest",
        detail=detail,
    )
