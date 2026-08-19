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
against.

**Same-agency-name is NOT independent corroboration and must never alone
justify an auto-merge.** Two listings from one agency always match on
`contact_raw` by construction — an agency's batch/campaign code, a CRM
template placeholder left unedited, or a copy-paste error across many of
its own unrelated listings would otherwise auto-merge every such pair.
"Same agency, same code" is informative (real coincidences across
*different* agencies are far less likely than a single agency's own
data-entry slip), so it still earns a mid-confidence *suggestion* — never
a merge decision on its own. Corroboration strong enough to merge is
either address/coordinates/size proximity (independent of agency) as
described below, or same-agency PLUS that same proximity check:

**Same-agency-name is a HARD VETO when the codes differ (issue #564,
D-116) — the negative side of the exact insight above.** An agency
assigns one reference per property in its own CRM. Two listings from the
same agency (`_same_agency`, portal-agnostic — the high-value case is one
agency syndicating to Fotocasa *and* Idealista under the same
`contact_raw`) carrying two different, both-real (non-placeholder,
`_normalize`d) codes are, by that agency's own bookkeeping, two different
properties — no matter how well address, coordinates, photos or size
agree. That is exactly the situation every similarity signal is most
easily fooled by: same building, same agency, same photographer, adjacent
units. `reference_codes_conflict` below is that veto; see its use in
`etl.dedup.engine.evaluate_pair`, which applies it ahead of every signal
except `cadastral` (a government registry ID, not agency bookkeeping —
that module's own docstring calls it "conclusive" and "never wrong",
so an agency's internal ref mismatch does not get to override it).
Different agencies with different codes means nothing (codes are
agency-namespaced) — the veto is eligible only for same-agency pairs.
Placeholder/unusable codes never veto — an unusable code is "absent", not
"differing", the same rule `_normalize` already enforces for the positive
path, so a CRM template left unedited across an agency's whole inventory
can't silently block every legitimate merge for that agency.

1. Address/coordinates/size proximity, mirroring phone_extract._corroborated
   exactly (coords+size when both sides publish coordinates, falling back
   to size+price proximity otherwise) — sufficient for merge on its own,
   regardless of agency.
2. Same seller/agency name (`listing.contact_raw`, already captured by
   both Fotocasa and Milanuncios into a plain column) with NO proximity
   corroboration — suggestion only, at a lower confidence than the
   uncorroborated case is wrong; this is more informative than a bare
   coincidence, but still not proof of the same property.

Three confidence tiers: bare match (weakest), same-agency-only (some
signal, still not auto-merge-safe), and proximity-corroborated (merge).
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

_UNCORROBORATED_CONFIDENCE = Decimal("0.500")
_SAME_AGENCY_ONLY_CONFIDENCE = Decimal("0.750")
_CORROBORATED_CONFIDENCE = Decimal("0.900")

# Same tolerances phone_extract._corroborated uses for its price/size
# fallback path — a looser stand-in for a coordinate check when connectors
# don't happen to publish precise lat/lon on both sides.
_CORROBORATION_SIZE_RATIO = Decimal("0.05")
_CORROBORATION_PRICE_RATIO = Decimal("0.10")

# Reference codes short enough or generic enough to be placeholder/default
# values rather than a real per-property identifier — multiple unrelated
# listings coincidentally sharing "0" or "REF" is not a signal, it's noise.
# Require a minimum length and at least one digit; deny known placeholders
# outright regardless of length.
_MIN_CODE_LENGTH = 4
_PLACEHOLDER_CODES = frozenset(
    {
        "0",
        "-",
        "n/a",
        "na",
        "ref",
        "sin referencia",
        "sinreferencia",
        "sin-referencia",
        "pendiente",
        "tbd",
        "todo",
    }
)
_HAS_DIGIT_RE = re.compile(r"\d")


def _normalize(code: str | None) -> str | None:
    """Case/whitespace-insensitive comparison key, rejecting placeholders.

    Reference codes are short human-facing strings (e.g. "NS603"), not a
    structured identifier with its own canonical casing rule — normalizing
    away whitespace/case differences catches the same code rendered
    slightly differently by two portals' own display logic, without
    attempting anything more aggressive (stripping punctuation, say) that
    could start conflating genuinely different codes.

    Values that are too short, digit-free, or a known placeholder string
    (default/unset markers a listing tool might leave behind) are rejected
    outright — these are exactly the low-cardinality values multiple
    unrelated listings would coincidentally share, which would otherwise
    manufacture matches out of noise rather than real per-property IDs.
    """
    if not code:
        return None
    normalized = code.strip().casefold()
    if not normalized:
        return None
    if normalized in _PLACEHOLDER_CODES:
        return None
    if len(normalized) < _MIN_CODE_LENGTH:
        return None
    if not _HAS_DIGIT_RE.search(normalized):
        return None
    return normalized


def _same_agency(a: ListingRecord, b: ListingRecord) -> bool:
    a_name = (a.contact_raw or "").strip().casefold()
    b_name = (b.contact_raw or "").strip().casefold()
    return bool(a_name) and a_name == b_name


def reference_codes_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True only when both sides carry a usable, DIFFERING reference code
    from the SAME agency (issue #564, D-116) — the hard veto.

    Mirrors `floor.floors_conflict`'s permissive-on-absence shape
    deliberately (issue #186): a code missing or rejected by `_normalize`
    (placeholder, too short, digit-free) on either side is "we don't
    know", never "they differ" — the same discipline that keeps a CRM
    template default from vetoing every legitimate merge for an agency
    that never bothered to fill it in.

    Different agencies are never eligible: `_same_agency` gates first,
    since an unrelated agency's differing code means nothing (codes are
    agency-namespaced, see this module's docstring).

    Callers must treat this as an OUTRIGHT veto, not a weaker vote: unlike
    `floors_conflict` (which only downgrades a merge that another signal
    already supports, and still lets a corroborated pair land as a weaker
    suggestion), a same-agency reference-code conflict is direct evidence
    from the agency's own bookkeeping that these are two different
    properties — see `etl.dedup.engine.evaluate_pair`, which short-circuits
    to "no match at all" (no merge, no suggestion) the moment this is
    True, for every signal except `cadastral`.
    """
    if not _same_agency(a, b):
        return False
    code_a = _normalize(a.reference_code)
    code_b = _normalize(b.reference_code)
    if code_a is None or code_b is None:
        return False
    return code_a != code_b


def _proximity_corroborated(a: ListingRecord, b: ListingRecord) -> bool:
    """Address/coordinates/size proximity — independent of agency identity.

    Sufficient for a merge decision on its own; mirrors
    phone_extract._corroborated's coords+size / size+price fallback shape,
    including the issue #186 floor veto below.
    """
    # Issue #186: floor as an additional required corroborating condition —
    # a floor present on both sides that disagrees vetoes proximity
    # corroboration regardless of which path below would otherwise
    # succeed. Missing floor on either side is permissive (see
    # etl.dedup.signals.floor).
    if floors_conflict(a.floor, b.floor):
        return False
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

    if _proximity_corroborated(a, b):
        return PairEvaluation(
            basis="reference_code",
            confidence=_CORROBORATED_CONFIDENCE,
            decision="merge",
            detail=detail,
        )

    if _same_agency(a, b):
        # Same agency, same code, but no independent proximity evidence —
        # more informative than a bare coincidence (issue #86 review: a
        # batch/campaign code or a copy-paste error across an agency's own
        # unrelated listings would otherwise auto-merge on agency identity
        # alone), so this earns a higher suggestion confidence, but never
        # a merge decision.
        return PairEvaluation(
            basis="reference_code",
            confidence=_SAME_AGENCY_ONLY_CONFIDENCE,
            decision="suggest",
            detail=detail,
        )

    return PairEvaluation(
        basis="reference_code",
        confidence=_UNCORROBORATED_CONFIDENCE,
        decision="suggest",
        detail=detail,
    )
