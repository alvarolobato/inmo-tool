"""Municipality-conflict predicate (issue #568, D-119).

Two listings whose `property.city` genuinely names two different
municipalities are not the same property — but the naive `!=` comparison
is wrong for the same reason it was wrong for reference codes (D-116) and
`property_type`/`rooms` (D-117): portals format the *same* municipality
name differently. Sampling every currently-pending `fuzzy` suggestion
(issue #568's blast-radius requirement) found **8,072** pairs with a raw
`city` mismatch, of which **5,919 (73%)** are one municipality written two
ways:

    sevilla capital <-> sevilla        4,462
    malaga <-> malaga capital          1,117
    malaga <-> malaga (accent)            50

`normalize_city` below fixes that: strip a trailing "capital" token, fold
accents, casefold, collapse whitespace — exactly the checklist the issue
specifies. After normalizing, 2,153 pairs genuinely differ (different
provinces — Málaga/Sevilla, Madrid/Sevilla — or adjacent-but-distinct
municipalities — Camas, Dos Hermanas, Almensilla, all near Sevilla).

**A second, distinct trap, found by the issue's own instruction to check
for it**: a `city` value that is actually a *district* of a larger
municipality, not an independent one. Two real cases live in this DB,
both discovered by inspecting `property.city`'s full distinct-value list
(654 values) for anything that reads as a neighbourhood/district rather
than a town:

- `Montequinto` (idealista, 92 properties) — a district of Dos Hermanas
  (Sevilla), the exact case the issue calls out by name.
- `Churriana` (idealista + unicaja) — a district of Málaga city (annexed
  1924), confirmed by real evidence, not just gazetteer lookup: property
  6953 in this DB was correctly merged by `photo_hash` (0.900 confidence,
  three separate merge_log rows) between a `Churriana` listing and a
  `Málaga` listing. A hypothetical naive veto would never have blocked
  that merge (photo_hash never reaches this fuzzy-scoped check — see
  below), but it is exactly the kind of pair a district-blind rule would
  misclassify if it ever *did* run ahead of a stronger signal.

A THIRD, related class turned up in the same inspection, not a
district/municipality confusion but the same "same place, different
spelling" shape #568 itself is about: the `servihabitat` connector's
`city` value is one segment of a `province-comarca-municipality` URL
slug, lowercased with every space/accent/punctuation stripped (see
`etl.connectors.servihabitat_mapping.parse_location_slug`'s own
docstring — "deliberately returned as-is rather than guessed at"). That
produces values like `sanjuandeaznalfarache` and `doshermanas` for
municipalities every OTHER connector spells `"San Juan de Aznalfarache"` /
`"Dos Hermanas"`. Live evidence this matters: two currently-merged
properties (`property_merge_log` ids 388, 513, 514, 515 — all
`photo_hash`, real corroborated merges) pair a servihabitat slug city
against a spaced/accented city for the SAME municipality; a hard,
engine-wide veto using only whitespace-collapse (no de-spacing) would
have broken them. Scoping to `fuzzy` (below) already makes that moot for
existing merges, exactly like D-116/D-117 — but leaving the comparison
key un-despaced would still needlessly kill legitimate `fuzzy`
suggestions between a servihabitat listing and any other portal's
listing of the very same municipality. `normalize_city` therefore also
strips every remaining space/hyphen/underscore/apostrophe after folding
accents and stripping a trailing "capital" token, and `_DISTRICT_ALIASES`
below is keyed on that fully-collapsed form.

Scoped to `fuzzy` only, exactly as D-116/D-117 — never wired into
`etl.dedup.engine.evaluate_pair`. Measured (read-only, live DB, issue
#568): of 892 non-reverted `property_merge_log` rows with a recorded
losing property, comparing the *surviving* property's `city` against the
`losing` property's `city` (both still live rows, never deleted) finds 9
where the raw `!=` disagrees; after `normalize_city`, only 5 genuinely
differ — Málaga/Estepona (property 71029, twice) and Málaga/Churriana
(property 6953, x3, the exact photo_hash case documented above). An
engine-wide veto would have broken the Churriana merges outright, the
same shape of mistake #565/#567 already measured and rejected for their
own rules — so this rule lives only in `fuzzy.evaluate`, same as
`structured_fields_conflict` (D-117).
"""

from __future__ import annotations

import re
import unicodedata

from etl.dedup.types import ListingRecord

# Known city values that are a DISTRICT of a larger municipality, not an
# independent one — see this module's docstring for how each was found and
# corroborated. Keyed and valued on the fully-collapsed comparison form
# `normalize_city` produces (no spaces/accents/case/punctuation), so an
# entry here must already be de-spaced.
#
# Deliberately an explicit, closed list (mirrors D-020's pinned CDN-rule
# parameter, D-022's pinned backfill migration): a heuristic "does this
# look like a district" rule risks the opposite failure — silently
# swallowing a genuinely different, smaller municipality whose name
# happens to be a substring of a bigger one's. New cases found by the same
# inspection this module's docstring describes should be added here, not
# guessed at generically.
_DISTRICT_ALIASES: dict[str, str] = {
    # Dos Hermanas (Sevilla) — issue #568's own named example.
    "montequinto": "doshermanas",
    # Málaga city, annexed 1924 — corroborated by a real photo_hash merge
    # (property 6953, see docstring).
    "churriana": "malaga",
    # Servihabitat's `madrid-areametropolitanamadrid-<district>` slug
    # (etl.connectors.servihabitat_mapping.parse_location_slug) puts a
    # Madrid CITY DISTRICT in the municipality slot for every one of these
    # — every other servihabitat municipality slug (sevilla, malaga,
    # doshermanas, camas, ...) is a real municipality, not a district;
    # Madrid is the only city this connector's own geography taxonomy
    # splits below the municipality level. Full list found by inspecting
    # servihabitat's distinct `city` values (issue #568).
    "madcanillejas": "madrid",
    "madcarabanchel": "madrid",
    "madciudadlineal": "madrid",
    "madhortaleza": "madrid",
    "madlalatina": "madrid",
    "madmoncloaaravaca": "madrid",
    "madpuentedevallecas": "madrid",
    "madtetuancuatrocaminos": "madrid",
    "madusera": "madrid",
    "madvicalvaro": "madrid",
    "madvilladevallecas": "madrid",
    "madvillaverde": "madrid",
}


def _strip_accents(text: str) -> str:
    """Decompose then drop combining marks — same technique
    `fuzzy.normalize_address`/`floor._strip_accents` use."""
    return "".join(
        ch
        for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )


_WHITESPACE_RE = re.compile(r"\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]")


def normalize_city(raw: str | None) -> str | None:
    """Return a comparison key for one listing's `property.city`, or None.

    None means "no usable municipality evidence" — callers must treat it
    as "we don't know", never as a value that equals another None (same
    discipline as `floor.normalize_floor`).

    Steps, in order:
    1. Fold accents, casefold, collapse internal whitespace, trim
       (`málaga capital` / `Málaga Capital` -> `malaga capital`).
    2. Strip a single trailing " capital" token
       (`malaga capital` -> `malaga`; the issue's own worked examples).
    3. Drop every remaining space/hyphen/underscore/apostrophe, folding
       e.g. `"san juan de aznalfarache"` and servihabitat's
       `"sanjuandeaznalfarache"` onto the same key (see docstring).
    4. Resolve a known district alias (`_DISTRICT_ALIASES`) onto its
       parent municipality.
    """
    if not raw or not raw.strip():
        return None
    text = _strip_accents(raw).strip().casefold()
    text = _WHITESPACE_RE.sub(" ", text)
    if text.endswith(" capital"):
        text = text[: -len(" capital")].strip()
    text = _NON_ALNUM_RE.sub("", text)
    if not text:
        return None
    return _DISTRICT_ALIASES.get(text, text)


def municipality_conflict(a: ListingRecord, b: ListingRecord) -> bool:
    """True only when both sides carry a usable `city` AND, once
    normalized (including the district-alias resolution above), they
    disagree.

    Absence or an unusable value on either side returns False — a missing
    city never blocks a merge/suggestion another signal already supports,
    mirroring `floor.floors_conflict`/`structured_fields.property_type_conflict`'s
    permissive-on-absence shape.
    """
    city_a = normalize_city(a.city)
    city_b = normalize_city(b.city)
    if city_a is None or city_b is None:
        return False
    return city_a != city_b
