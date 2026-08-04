"""Aliseda-specific field mapping: raw captured values -> canonical vocabulary.

═══════════════════════════════════════════════════════════════════════════
  DRAFT SELECTORS — NOT YET VALIDATED AGAINST A REAL ALISEDA CAPTURE.
═══════════════════════════════════════════════════════════════════════════

Like Idealista (etl/connectors/idealista.py), Aliseda is capture-only: it is
NOT buildable as an automated connector. Per D-019
(docs/decisions/D-019-aliseda-not-viable-disallowed-api.md), the one host
that serves Aliseda listing data (`laravel.alisedainmobiliaria.com`) is
robots.txt `Disallow: /`, and the public `www.alisedainmobiliaria.com`
detail page is a bare Angular shell with zero server-rendered content — a
plain HTTP fetch has nothing to parse. Real DOM only exists once the owner's
own browser hydrates the Angular app, which the browser extension
(browser-extension/, issue #75) then captures.

Because this project has (correctly) never fetched the disallowed API and
never scraped a live rendered page, the field locations below are a
BEST-EFFORT GUESS at the shape a hydrated Aliseda page plausibly takes, built
against a fabricated fixture (etl/tests/fixtures/aliseda_sample_detail.html),
NOT a real capture. The one thing that is grounded rather than guessed is the
set of analytics keys D-019 observed the real page fire
(`ciudad`/`provincia`/`metros_cuadrados`/`habitaciones`/`precio`) — hence the
mapping prefers the analytics `dataLayer` blob and treats labelled DOM
elements as a fallback.

Refining against a real capture is meant to be a SMALL EDIT, not a rewrite:
change the selector/key constants in aliseda.py and the vocabulary tables
here; the normalize()/persistence shape does not move. See aliseda.py's
module docstring for the validation checklist.
"""

from __future__ import annotations

# Aliseda's `tipo` analytics field (and any type word in the title) is coarse
# free text — map it onto property.property_type's CHECK vocabulary
# ('piso','chalet','atico','local','nave','garaje','terreno','edificio').
# Keyword-based, longest/most-specific first, same discipline as
# idealista_mapping.map_property_type: a best-effort classification, never a
# guess dressed up as structured data (the raw value stays in raw_extra).
_TYPE_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("atico", "atico"),
    ("ático", "atico"),
    ("duplex", "piso"),
    ("dúplex", "piso"),
    ("apartamento", "piso"),
    ("estudio", "piso"),
    ("piso", "piso"),
    ("vivienda", "piso"),
    ("chalet", "chalet"),
    ("adosado", "chalet"),
    ("pareado", "chalet"),
    ("casa", "chalet"),
    ("unifamiliar", "chalet"),
    ("local", "local"),
    ("nave", "nave"),
    ("industrial", "nave"),
    ("garaje", "garaje"),
    ("plaza de garaje", "garaje"),
    ("trastero", "garaje"),
    ("terreno", "terreno"),
    ("suelo", "terreno"),
    ("parcela", "terreno"),
    ("solar", "terreno"),
    ("edificio", "edificio"),
)


def map_property_type(raw_type: str | None) -> str | None:
    """Map Aliseda's property-type text onto the canonical CHECK vocabulary.

    `raw_type` is whatever the capture yielded — the analytics `tipo` value
    (e.g. "piso") if present, else the page title. None if neither carried a
    recognisable type word (honest: better a None than a wrong bucket).
    """
    if not raw_type:
        return None
    lowered = raw_type.lower()
    for keyword, mapped in _TYPE_KEYWORDS:
        if keyword in lowered:
            return mapped
    return None


def map_operation(raw_operation: str | None) -> str | None:
    """Aliseda's `operacion` analytics value -> canonical 'sale' | 'rent'.

    Aliseda is a bank-owned-asset (REO) portal, so 'venta' (sale) is the
    overwhelming default; 'alquiler' (rent) exists for some assets. Returns
    None when unrecognised so the orchestrator's UPDATE-path COALESCE can
    tell "capture didn't say" apart from a real value (see
    CanonicalListingVersion.operation's comment).
    """
    if not raw_operation:
        return None
    lowered = raw_operation.lower()
    if "alquil" in lowered or "rent" in lowered:
        return "rent"
    if "venta" in lowered or "sale" in lowered or "compra" in lowered:
        return "sale"
    return None


def split_location(location_text: str | None) -> tuple[str | None, str | None]:
    """Split a compound "Ciudad, Provincia" location string into
    (city, province), best-effort.

    Used only when the structured analytics `ciudad`/`provincia` fields are
    absent and the mapping falls back to the DOM's location line (e.g.
    "Estepona, Málaga"). The last comma-separated segment is treated as the
    province, the first as the city — Spanish address convention. Returns
    (None, None) on empty input; a single segment is taken as the city with
    no province (better None than mislabelling a city as a province).
    """
    if not location_text:
        return None, None
    parts = [p.strip() for p in location_text.split(",") if p.strip()]
    if not parts:
        return None, None
    if len(parts) == 1:
        return parts[0], None
    return parts[0], parts[-1]
