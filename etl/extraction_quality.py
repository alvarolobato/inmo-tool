"""Per-listing extraction-quality scoring (issue #80).

A deterministic, **connector-agnostic** completeness grade computed at
normalize/persist time from the *canonical* fields (never per-connector,
never from raw HTML). It adopts the *concept* — a **weighted** grade rather
than a flat extracted/total ratio — from ``property_web_scraper``'s
``quality-scorer.ts`` (``getFieldImportance`` / ``assessQualityWeighted``);
none of that TypeScript is ported.

The point: a listing whose connector genuinely under-extracted (``m2_built``,
``rooms``, ``current_price`` all ``None``) is now distinguishable *in the data
model* from a genuinely thin one, so the dashboard can tell "sparse source"
apart from "our parser missed fields" — a difference that is invisible today
because a ``NULL`` column looks identical either way.

Storage: the orchestrator writes the returned dict onto
``listing.raw_extra["extraction_quality"]`` on every insert/update — no
schema change, matching this project's "unmapped data goes in ``raw_extra``"
convention (the score can be promoted to a first-class column later if it
proves worth querying/filtering on directly).
"""

from __future__ import annotations

from typing import Any

# Bump when the field set or weights change so a stored score can be told
# apart from one computed under a different rubric (the dashboard reads the
# stored value verbatim; a re-fetch overwrites it with the current version).
WEIGHTS_VERSION = 1

# Weighted field importance. Core investment fields an owner scans a
# candidate on first (price, size, location) weigh more than secondary
# attributes (energy rating, bathrooms) — the whole reason this is a
# *weighted* grade and not a flat populated/total count. A synthetic pair of
# listings with the same *number* of missing fields but a different *which*
# therefore scores differently (issue #80 acceptance criterion 2).
_FIELD_WEIGHTS: tuple[tuple[str, int], ...] = (
    ("current_price", 3),
    ("location", 3),  # lat+lon, or a textual address
    ("m2_built", 3),
    ("property_type", 2),
    ("rooms", 2),
    ("photos", 2),  # at least one photo url
    ("description", 1),
    ("bathrooms", 1),
    ("energy_rating", 1),
)

_TOTAL_WEIGHT = sum(weight for _, weight in _FIELD_WEIGHTS)
_TOTAL_FIELDS = len(_FIELD_WEIGHTS)

# Grade bands on the weighted fraction [0, 1]. Mirrors the A/B/C/F badge the
# reference extension surfaces; thresholds are ours (their exact cutoffs
# aren't the transferable part — the weighted-not-flat idea is).
_GRADE_BANDS: tuple[tuple[str, float], ...] = (
    ("A", 0.85),
    ("B", 0.65),
    ("C", 0.45),
    ("F", 0.0),
)


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _field_present(canonical: Any, field: str) -> bool:
    """Whether one weighted field was actually populated by this extraction.

    Reads the canonical listing's attributes (duck-typed — any object with
    the ``CanonicalListingVersion`` field names works, which keeps this
    module free of a circular import back into ``connectors.base``).
    """
    if field == "location":
        # A geocoded point OR a human address counts as "we know where it is".
        return (
            getattr(canonical, "lat", None) is not None
            and getattr(canonical, "lon", None) is not None
        ) or _nonempty_str(getattr(canonical, "address", None))
    if field == "photos":
        return bool(getattr(canonical, "photo_urls", None))
    if field == "description":
        return _nonempty_str(getattr(canonical, "description", None))
    return getattr(canonical, field, None) is not None


def _grade_for(fraction: float) -> str:
    for grade, floor in _GRADE_BANDS:
        if fraction >= floor:
            return grade
    return "F"  # unreachable (band F has floor 0.0), kept for total-function safety


def compute_extraction_quality(canonical: Any) -> dict[str, Any]:
    """Return the extraction-quality descriptor for one normalized listing.

    Deterministic and side-effect-free — the same canonical listing always
    yields the same dict. Shape (stored on ``raw_extra.extraction_quality``):

        {"grade": "A"|"B"|"C"|"F",
         "score": <weighted fraction, 0..1, 3 dp>,
         "populated_fields": <int>, "total_fields": <int>,
         "weights_version": <int>}
    """
    weighted_hit = 0
    populated = 0
    for field, weight in _FIELD_WEIGHTS:
        if _field_present(canonical, field):
            weighted_hit += weight
            populated += 1

    fraction = weighted_hit / _TOTAL_WEIGHT if _TOTAL_WEIGHT else 0.0
    return {
        "grade": _grade_for(fraction),
        "score": round(fraction, 3),
        "populated_fields": populated,
        "total_fields": _TOTAL_FIELDS,
        "weights_version": WEIGHTS_VERSION,
    }
