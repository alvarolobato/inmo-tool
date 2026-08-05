"""Aliseda-specific field mapping: raw captured values -> canonical vocabulary.

═══════════════════════════════════════════════════════════════════════════
  CALIBRATED AGAINST REAL ALISEDA CAPTURES (issue #266).
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

The vocabulary tables below map the free-text `property_type` and `operation`
that aliseda.py lifts from the listing title (e.g. "Piso en venta en …") onto
the canonical CHECK vocabularies. See aliseda.py's module docstring for the
JSON-LD / DOM extraction the connector actually performs.
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
