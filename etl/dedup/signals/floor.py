"""Floor-string normalization and cross-listing floor corroboration
(issue #186).

`property.floor` is free text sourced straight from each portal's own
rendering — Fotocasa's featuresList carries a human string like "2ª planta"
distinct from `features.floor`'s unrelated integer code (see
etl/connectors/fotocasa.py); Milanuncios exposes `attribute_value(attributes,
"floor")`; Idealista's is regex-parsed out of a features paragraph; Vivantial
publishes "4 planta"/"Bajo" as-is. Never a structured integer. Two listings
of the very same unit can therefore carry differently-formatted-but-equal
text — issue #185's own reported pair was `floor="3º"` (Milanuncios) vs.
`floor="3ª planta"` (Fotocasa), the *same* floor, formatted differently —
while two listings of genuinely *different* units in the same building
(the same-building-reused-photoset case described in issue #186: "they
often put multiple flats of the same building with the same pictures")
can look unrelated on floor for the mundane reason that they're actually on
different floors, e.g. suggestion 197's `10º` vs. `A partir de la 15ª
planta`, 6m² apart, identical photos and price.

This module answers exactly one question for the dedup signals: do these
two floors, once normalized, actively *disagree*? Absence of usable floor
text on either side is "we don't know", never "they match" and never "they
conflict" — the existing signals (address_coords, phone_extract,
reference_code) already apply this same permissive-on-absence philosophy to
coordinates and cadastral_ref, so floor corroboration follows the same
shape rather than inventing a new one.
"""

from __future__ import annotations

import re
import unicodedata

# Non-numeric floor descriptors, keyed by a substring to look for in the
# accent-stripped, lowercased text, mapped to a canonical comparison token.
# Checked before digit extraction below, since a plain digit search would
# either miss these (no digit present) or, worse, latch onto an unrelated
# number elsewhere in the string.
#
# Order matters: "semisotano" is checked before "sotano" (a substring of
# it) and "entresuelo"/"entreplanta" are two different portals' names for
# the same in-between-floors concept, deliberately mapped to one token so
# they compare equal to each other rather than conflicting.
_WORD_FLOORS: tuple[tuple[str, str], ...] = (
    ("entresuelo", "entresuelo"),
    ("entreplanta", "entresuelo"),
    ("semisotano", "semisotano"),
    ("sotano", "sotano"),
    ("atico", "atico"),
    ("principal", "principal"),
    ("planta baja", "bajo"),
    ("bajo", "bajo"),
)

_DIGIT_RE = re.compile(r"\d+")


def _strip_accents(text: str) -> str:
    """Decompose then drop combining marks — same technique fuzzy.py's
    normalize_address uses, so "ático"/"Ático" and "3ª"/"3º" (whose ordinal
    indicators NFKD-decompose to plain "a"/"o") normalize consistently."""
    return "".join(
        ch
        for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )


def normalize_floor(raw: str | None) -> str | None:
    """Return a comparison key for one listing's floor text, or None.

    None means "no usable floor evidence" — either the field was empty, or
    the text didn't contain anything this function recognizes (a portal
    quirk not yet seen). Callers must treat None as "can't compare", never
    as a value that equals another None (see `floors_conflict`).

    A leading number is read literally, including out of a descriptive
    phrase like "A partir de la 15ª planta" ("from the 15th floor
    upwards") — the *first* number in the text is taken as the floor the
    listing is describing, whatever qualifier surrounds it. This is
    deliberately a plain equality key, not a range: "A partir de la 15ª
    planta" and a plain "16º" normalize to different keys ("15" vs "16")
    even though a multi-floor listing starting at 15 could plausibly
    include floor 16. Collapsing that nuance would need parsing "a partir
    de"/"hasta" as an open-ended range — more machinery than a same-
    building sanity check needs. The cost of the simplification is a small
    false-conflict rate on multi-floor listings, traded for a normalizer
    simple enough to audit against the real formats seen in production
    (see TestNormalizeFloor for the exact corpus this was checked against).
    """
    if not raw or not raw.strip():
        return None
    text = _strip_accents(raw).lower().strip()

    for needle, canonical in _WORD_FLOORS:
        if needle in text:
            return canonical

    match = _DIGIT_RE.search(text)
    if match:
        return str(int(match.group()))

    return None


def floors_agree(a_floor: str | None, b_floor: str | None) -> bool:
    """True only when both sides carry usable floor text AND it matches.

    Absence on either side returns False — an absent floor is never
    counted as agreement, which is the whole point of issue #186's
    corroboration rule. Not used by the merge-gating signals directly
    (they gate on `floors_conflict`, the permissive-on-absence inverse),
    but kept as its own function so that distinction is testable and
    reusable (e.g. a future "floor corroborated" positive flag)."""
    a_norm = normalize_floor(a_floor)
    b_norm = normalize_floor(b_floor)
    if a_norm is None or b_norm is None:
        return False
    return a_norm == b_norm


def floors_conflict(a_floor: str | None, b_floor: str | None) -> bool:
    """True only when both sides carry usable floor text AND it disagrees.

    Absence on either side returns False (not a conflict) — a missing
    floor never blocks a merge/corroboration that other signals already
    support. This is the primitive `address_coords.evaluate`,
    `phone_extract._corroborated`, and
    `reference_code._proximity_corroborated` gate on (issue #186): floor is
    an *additional required* corroborating condition, not a sole signal —
    it can only veto a match already supported by proximity, never manufacture
    one on its own.
    """
    a_norm = normalize_floor(a_floor)
    b_norm = normalize_floor(b_floor)
    if a_norm is None or b_norm is None:
        return False
    return a_norm != b_norm
