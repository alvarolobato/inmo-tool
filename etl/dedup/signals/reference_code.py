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

**Reach (issues #628/#629, D-140 — supersedes the old "ZERO" note below).**
`contact_raw`/`reference_code` capture was widened (idealista's agency,
solvia/servihabitat's constant selling-entity name) so the veto now has
eligible pairs to run against — see D-140 for the measured before/after
counts. `engine._run` still never calls `evaluate_pair` at all on a
same-source pair (issue #197) or on a pair already sharing a `property_id`,
so the veto only ever fires on a cross-source pair that isn't already
merged.

**The comparison both `evaluate` and `reference_codes_conflict` use is
`codes_equivalent`, not a bare `==` (issue #629, D-140) — one normalizer,
used by both the match path and the veto, never two implementations.**
`_normalize` now also strips a leading "ref"/"ref."/"referencia" label
before the existing case/whitespace/placeholder handling, and
`codes_equivalent` additionally tolerates a trailing unit/variant suffix
(`-1`, `/2`, `_A`) on exactly one side — the owner's own flagged example
(`LCSE42305` vs `LCSE42305-1`) — never an arbitrary edit distance and
never two suffixed codes with DIFFERING suffixes (that is two units, not
one property re-rendered). See `codes_equivalent`'s own docstring for the
exact rule and D-140 for why this specific, narrow relaxation and nothing
wider.

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

# Issue #629/#628 Opus review (B1): a SUFFIX-TOLERANT match (one side
# carries a trailing unit/variant suffix the other lacks -- never an exact
# match) gets its OWN fixed, low confidence and NEVER reaches "merge",
# regardless of proximity corroboration or same-agency -- unlike an exact
# match, whose confidence/decision both scale with corroboration below.
# Measured against the live sale corpus: 56 same-agency, same-source pairs
# where a bare code and its "-N" sibling are held by DIFFERENT
# `property_id`s (i.e. genuinely different real properties, not one
# re-rendered) -- proximity (coords/size/price) does NOT discriminate this
# case, since adjacent units in the same building routinely satisfy it
# too. A suffix relation is real, corroboration-worthy evidence that lifts
# D-116's veto (the actually-reported bug), but it is measurably weaker
# than an exact code match and must never auto-merge on its own strength.
_SUFFIX_TOLERANT_CONFIDENCE = Decimal("0.400")

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

# Issue #629 (D-140), tightened after Opus review (B2): a leading "Ref.",
# "Ref:", or "Referencia:" label some portals bake straight into the
# captured field value (as opposed to rendering it as a separate <label>),
# stripped before the rest of normalization runs. The label must be
# followed by whitespace, ":", "-", or end-of-string — a lookahead, not
# just an optional separator — so it can NEVER eat into a real code that
# merely happens to start with "ref": "REFORMA-12" stays "reforma-12"
# (not corrupted to "orma-12"), "REF1234" stays "ref1234" (not "1234",
# silently dropping a real prefix), and "REF100"/"REF1005" stay usable,
# distinguishable codes (not collapsed to "100"/"1005", which would have
# nullified D-116's own textbook example of the collision this veto
# exists to catch — see reference_codes_conflict's docstring). Measured
# against the live corpus: only 3 of 11,475 usable codes start with
# "ref" at all, and 2 of those already carry a real separator — this
# regex strips exactly those 2, nothing else.
_LEADING_LABEL_RE = re.compile(r"^(referencia|ref\.?)(?=$|[\s:\-])[\s:\-]*")

# Issue #629 (D-140): a trailing unit/variant suffix — a short separator
# (hyphen/underscore/slash) plus 1-3 alphanumeric characters at the very
# end — is the one thing `codes_equivalent` tolerates beyond exact
# equality. `-1`, `/2`, `_A` are the owner's own examples. Deliberately
# narrow: a *space* or *comma* before the trailing token (see
# TestPlainComparisonNoPrefixTolerance's two pinned real pairs, "8385 11"
# vs "8385 11 1" and "09502,1" vs "09502") does NOT match this pattern, so
# those stay plain-inequality conflicts exactly as before.
_SUFFIX_RE = re.compile(r"^(.+)[-_/]([0-9a-z]{1,3})$")


def _normalize(code: str | None) -> str | None:
    """Case/whitespace-insensitive comparison key, rejecting placeholders.

    Reference codes are short human-facing strings (e.g. "NS603"), not a
    structured identifier with its own canonical casing rule — normalizing
    away whitespace/case differences catches the same code rendered
    slightly differently by two portals' own display logic, without
    attempting anything more aggressive (stripping punctuation, say) that
    could start conflating genuinely different codes. Issue #629 (D-140)
    added one more purely-cosmetic step: stripping a leading "ref"/"ref."/
    "referencia" label some connectors capture inline with the code.

    Values that are too short, digit-free, or a known placeholder string
    (default/unset markers a listing tool might leave behind) are rejected
    outright — these are exactly the low-cardinality values multiple
    unrelated listings would coincidentally share, which would otherwise
    manufacture matches out of noise rather than real per-property IDs.
    """
    if not code:
        return None
    normalized = code.strip().casefold()
    normalized = _LEADING_LABEL_RE.sub("", normalized).strip()
    if not normalized:
        return None
    if normalized in _PLACEHOLDER_CODES:
        return None
    if len(normalized) < _MIN_CODE_LENGTH:
        return None
    if not _HAS_DIGIT_RE.search(normalized):
        return None
    return normalized


def _strip_variant_suffix(normalized: str) -> str:
    """Return `normalized` with one trailing unit/variant suffix removed.

    Returns `normalized` unchanged when there is no such suffix, or when
    removing it would leave a base shorter than `_MIN_CODE_LENGTH` (a
    short base is more likely a coincidental separator inside a compact
    code than a real prefix+suffix pair).
    """
    match = _SUFFIX_RE.match(normalized)
    if not match:
        return normalized
    base = match.group(1)
    if len(base) < _MIN_CODE_LENGTH:
        return normalized
    return base


def codes_equivalent(code_a: str | None, code_b: str | None) -> bool:
    """The ONE normalizer + equality check reference-code matching uses —
    both the positive match (`evaluate`, below) and D-116's conflict veto
    (`reference_codes_conflict`) call this, never a second implementation
    (issue #629, D-140: this repo has had parallel definitions of the same
    thing drift apart twice already).

    Two codes are equivalent when, after `_normalize`:
    - they are exactly equal, or
    - exactly ONE of them carries a trailing unit/variant suffix
      (`_strip_variant_suffix`) whose base equals the other side's full
      code — e.g. "lcse42305" vs "lcse42305-1".

    Deliberately NOT equivalent when BOTH sides carry a suffix (even the
    same-shaped one) unless the full normalized strings already match:
    "lcse42305-1" vs "lcse42305-2" is two different units, not one
    property rendered two ways, so it is compared literally (unequal, not
    tolerated) — this only relaxes the presence/absence case the owner
    flagged, never a suffix-vs-different-suffix case. Also never tolerates
    a changed digit/letter in the middle of the code (no edit-distance
    fuzziness) — that is `TestPlainComparisonNoPrefixTolerance`'s territory
    and stays a plain, unrelaxed inequality.
    """
    if code_a is None or code_b is None:
        return False
    if code_a == code_b:
        return True
    base_a = _strip_variant_suffix(code_a)
    base_b = _strip_variant_suffix(code_b)
    a_has_suffix = base_a != code_a
    b_has_suffix = base_b != code_b
    if a_has_suffix and b_has_suffix:
        return False
    if a_has_suffix:
        return base_a == code_b
    if b_has_suffix:
        return base_b == code_a
    return False


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

    Uses `codes_equivalent` (issue #629, D-140) once both codes clear
    `_normalize` — NOT a bare `==`. `codes_equivalent` tolerates only a
    trailing unit/variant suffix on exactly one side (the owner's own
    `LCSE42305` vs `LCSE42305-1` example); it is still a plain inequality
    for everything else — no edit-distance/arbitrary-fuzzy tolerance. A
    *prefix* exemption (matching on a shared leading substring, unbounded)
    was tried and reverted earlier (see D-116's amendment history): the two
    pairs that motivated it turned out to be same-source, hence
    structurally unreachable through `evaluate_pair` in the first place
    (issue #197's same-source skip), and it would also have exempted e.g.
    "REF100" vs "REF1005", exactly the sequential-CRM-id shape this veto
    exists to catch. `codes_equivalent`'s suffix tolerance is narrower and
    evidenced by a real owner-flagged pair — see its own docstring and
    D-140 for the measured blast radius through `run()`'s own pair
    generator (property_id inequality AND source inequality), not a raw
    listing query.

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
    return not codes_equivalent(code_a, code_b)


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
    if code_a is None or code_b is None:
        return None
    exact = code_a == code_b
    if not exact and not codes_equivalent(code_a, code_b):
        return None

    detail = {"shared_reference_code": a.reference_code}

    if not exact:
        # Issue #629/#628 Opus review (B1): a suffix-tolerant (non-exact)
        # match is capped here, before either corroboration check below
        # ever runs -- see _SUFFIX_TOLERANT_CONFIDENCE's own comment for
        # why proximity/agency corroboration must NOT be allowed to
        # promote this to "merge".
        detail["suffix_tolerant"] = True
        return PairEvaluation(
            basis="reference_code",
            confidence=_SUFFIX_TOLERANT_CONFIDENCE,
            decision="suggest",
            detail=detail,
        )

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
