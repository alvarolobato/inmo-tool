"""Signal: shared seller/agency reference code (issue #72).

Raised by the owner citing a real Fotocasa listing showing "Referencia:
NS603". Agencies that syndicate the same listing to multiple portals very
often keep the same internal reference code across all of them — the same
practice that makes phone-in-description (phone_extract.py) a useful
signal. This module mirrors that module's corroboration discipline
deliberately: **a reference-code match alone is never sufficient for
auto-merge**. Reference codes are agency-internal, not globally
namespaced — two different, unrelated agencies can coincidentally use the
same short code (issue #72's own example: "NS603" is exactly the kind of
compact alphanumeric ID two different CRMs could generate independently).

Unlike phone_extract, this module does *not* gate on `listing_kind`
(particular vs. agency). Reference codes are overwhelmingly an *agency*
practice (a formal per-property record ID), not something that becomes
less trustworthy specifically because a listing is agency-run — the
opposite of phone numbers, where an agency's front-desk line being shared
across many unrelated listings is exactly the failure mode to guard
against. The real risk here is symmetric regardless of listing_kind: two
listings share a code by coincidence, not because one side is an agency.
So corroboration here checks two independent things instead of a
particular/agency split:

1. Same seller/agency name (`listing.contact_raw`, already captured by
   both Fotocasa and Milanuncios into a plain column — no new pipeline
   needed) — the strongest available corroboration, since a genuine
   internal-reference-code collision between the *same* agency's own two
   listings would be a data-entry error on their end, not the
   coincidence this signal exists to guard against.
2. Address/coordinates/size proximity, mirroring phone_extract._corroborated
   exactly (coords+size when both sides publish coordinates, falling back
   to size+price proximity otherwise).

Confidence scale kept to two tiers (uncorroborated-suggest /
corroborated-merge), not phone_extract's three — there's no
listing_kind-ambiguity middle tier here since this signal isn't gated on
listing_kind at all.
"""

from __future__ import annotations

from decimal import Decimal

from etl.dedup.signals.address_coords import coords_close, prices_close, sizes_close
from etl.dedup.types import ListingRecord, PairEvaluation

_UNCORROBORATED_CONFIDENCE = Decimal("0.500")
_CORROBORATED_CONFIDENCE = Decimal("0.900")

# Same tolerances phone_extract._corroborated uses for its price/size
# fallback path — a looser stand-in for a coordinate check when connectors
# don't happen to publish precise lat/lon on both sides.
_CORROBORATION_SIZE_RATIO = Decimal("0.05")
_CORROBORATION_PRICE_RATIO = Decimal("0.10")


def _normalize(code: str | None) -> str | None:
    """Case/whitespace-insensitive comparison key.

    Reference codes are short human-facing strings (e.g. "NS603"), not a
    structured identifier with its own canonical casing rule — normalizing
    away whitespace/case differences catches the same code rendered
    slightly differently by two portals' own display logic, without
    attempting anything more aggressive (stripping punctuation, say) that
    could start conflating genuinely different codes.
    """
    if not code:
        return None
    normalized = code.strip().casefold()
    return normalized or None


def _same_agency(a: ListingRecord, b: ListingRecord) -> bool:
    a_name = (a.contact_raw or "").strip().casefold()
    b_name = (b.contact_raw or "").strip().casefold()
    return bool(a_name) and a_name == b_name


def _corroborated(a: ListingRecord, b: ListingRecord) -> bool:
    if _same_agency(a, b):
        return True
    if coords_close(a.lat, a.lon, b.lat, b.lon) and sizes_close(
        a.m2_built, b.m2_built, Decimal("0.05")
    ):
        return True
    return sizes_close(
        a.m2_built, b.m2_built, _CORROBORATION_SIZE_RATIO
    ) and prices_close(a.current_price, b.current_price, _CORROBORATION_PRICE_RATIO)


def evaluate(a: ListingRecord, b: ListingRecord) -> PairEvaluation | None:
    code_a = _normalize(a.reference_code)
    code_b = _normalize(b.reference_code)
    if code_a is None or code_a != code_b:
        return None

    detail = {"shared_reference_code": a.reference_code}

    if not _corroborated(a, b):
        return PairEvaluation(
            basis="reference_code",
            confidence=_UNCORROBORATED_CONFIDENCE,
            decision="suggest",
            detail=detail,
        )

    return PairEvaluation(
        basis="reference_code",
        confidence=_CORROBORATED_CONFIDENCE,
        decision="merge",
        detail=detail,
    )
