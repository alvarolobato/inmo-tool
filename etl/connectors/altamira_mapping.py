"""Altamira-specific field mapping: raw captured values -> canonical vocabulary.

═══════════════════════════════════════════════════════════════════════════
  CALIBRATED AGAINST REAL ALTAMIRA CAPTURES (issue #271).
═══════════════════════════════════════════════════════════════════════════

Like Idealista and Aliseda (etl/connectors/idealista.py, aliseda.py), Altamira
is capture-only: it is NOT buildable as an automated connector. Per D-027
(docs/decisions/D-027-altamira-not-viable-akamai-block.md), every direct HTTP
request to `altamirainmuebles.com` returns an Akamai WAF 403, including
`robots.txt`. The 2026-08-05 live human test (issue #271) confirmed the page
renders normally for a human in an ordinary browser, so the answer is the same
as Idealista/Aliseda: the browser extension (browser-extension/, issue #75)
captures the *rendered* DOM a human's own browser produced, and this connector
parses it.

The vocabulary tables below map the free-text `property_type` and `operation`
that altamira.py lifts from the listing URL slug / title (e.g.
"venta-de-atico" / "Ático en venta en …") onto the canonical CHECK
vocabularies. See altamira.py's module docstring for the DOM/meta/URL
extraction the connector actually performs.
"""

from __future__ import annotations

# Altamira's URL type slug (`/venta-de-<tipo>/…`, e.g. "atico", "casa") and any
# type word in the listing title are coarse free text — map them onto
# property.property_type's CHECK vocabulary
# ('piso','chalet','atico','local','nave','garaje','terreno','edificio').
# Keyword-based, longest/most-specific first, same discipline as
# aliseda_mapping.map_property_type / idealista_mapping.map_property_type: a
# best-effort classification, never a guess dressed up as structured data (the
# raw title is preserved in raw_extra regardless).
_TYPE_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("atico", "atico"),
    ("ático", "atico"),
    ("duplex", "piso"),
    ("dúplex", "piso"),
    ("apartamento", "piso"),
    ("estudio", "piso"),
    ("piso", "piso"),
    ("vivienda", "piso"),
    ("adosado", "chalet"),
    ("pareado", "chalet"),
    ("unifamiliar", "chalet"),
    ("chalet", "chalet"),
    ("casa", "chalet"),
    ("local", "local"),
    ("oficina", "local"),
    ("nave", "nave"),
    ("industrial", "nave"),
    ("plaza-de-garaje", "garaje"),
    ("plaza de garaje", "garaje"),
    ("garaje", "garaje"),
    ("trastero", "garaje"),
    ("terreno", "terreno"),
    ("suelo", "terreno"),
    ("parcela", "terreno"),
    ("solar", "terreno"),
    ("finca", "terreno"),
    ("edificio", "edificio"),
)


def map_property_type(raw_type: str | None) -> str | None:
    """Map Altamira's property-type text onto the canonical CHECK vocabulary.

    `raw_type` is whatever the capture yielded — the URL type slug
    (e.g. "venta-de-atico") if present, else the page title. None if neither
    carried a recognisable type word (honest: better a None than a wrong
    bucket). Hyphens in URL slugs are treated as word separators.
    """
    if not raw_type:
        return None
    lowered = raw_type.lower()
    for keyword, mapped in _TYPE_KEYWORDS:
        if keyword in lowered:
            return mapped
    return None


def map_operation(raw_operation: str | None) -> str | None:
    """Altamira's operation text -> canonical 'sale' | 'rent'.

    Read from the URL slug (`/venta-de-…` vs `/alquiler-de-…`) or the title
    ("… en venta" / "… en alquiler"). Altamira is a bank-owned-asset (REO)
    portal, so 'venta' (sale) is the overwhelming default; 'alquiler' (rent)
    exists for some assets. Returns None when unrecognised so the
    orchestrator's UPDATE-path COALESCE can tell "capture didn't say" apart
    from a real value (see CanonicalListingVersion.operation's comment).
    """
    if not raw_operation:
        return None
    lowered = raw_operation.lower()
    if "alquil" in lowered or "rent" in lowered:
        return "rent"
    if "venta" in lowered or "sale" in lowered or "compra" in lowered:
        return "sale"
    return None
