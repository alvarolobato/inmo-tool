"""Hipoges-specific field mapping: raw captured values -> canonical vocabulary.

═══════════════════════════════════════════════════════════════════════════
  DRAFT — UNVALIDATED. No real Hipoges capture exists yet (see hipoges.py's
  module docstring and D-111). This table is a best-effort transcription of
  the CHECK-vocabulary Spanish real-estate words the other REO-servicer
  mapping modules (aliseda_mapping.py, altamira_mapping.py) already use,
  cross-checked against the typology display strings genuinely present in
  Hipoges' own public `assets/i18n/es.json` translation bundle ("Piso",
  "Casa", "Garaje", "Trastero", "Terreno", "Oficina", "Edificio",
  "Apartamento" all appear there as translations of the `flat`/`house`/
  `garage`/`storage`/`land`/`office`/`building`/`apartment` typology keys).
  What is NOT confirmed: whether these exact words appear on a rendered
  Hipoges detail-page TITLE the way they do on Altamira/Aliseda titles —
  that depends on DOM structure this project has not observed. Keyword
  matching degrades to None on a miss, never a wrong bucket.
═══════════════════════════════════════════════════════════════════════════

Like Idealista/Aliseda/Altamira, Hipoges is capture-only (D-075: every
sanctioned enumeration channel on `realestate.hipoges.com` returns an
app-level 403; D-111 records the capture-only path). The vocabulary tables
below map the free-text `property_type` and `operation` that hipoges.py
lifts from the listing title/meta (once a real capture exists to read one
from) onto the canonical CHECK vocabularies. See hipoges.py's module
docstring for the extraction this connector actually performs today.
"""

from __future__ import annotations

# Hipoges' own `assets/i18n/es.json` (public, unauthenticated static asset —
# not the walled asset API) confirms these Spanish typology words are part of
# the site's vocabulary. Mapped onto property.property_type's CHECK vocabulary
# ('piso','chalet','atico','local','nave','garaje','terreno','edificio'),
# longest/most-specific first, same discipline as
# aliseda_mapping.map_property_type / altamira_mapping.map_property_type: a
# best-effort classification, never a guess dressed up as structured data
# (the raw title/text is preserved in raw_extra regardless).
_TYPE_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("atico", "atico"),
    ("ático", "atico"),
    ("duplex", "piso"),
    ("dúplex", "piso"),
    ("apartamento", "piso"),
    ("apartment", "piso"),
    ("estudio", "piso"),
    ("flat", "piso"),
    ("piso", "piso"),
    ("vivienda", "piso"),
    ("adosado", "chalet"),
    ("pareado", "chalet"),
    ("unifamiliar", "chalet"),
    ("chalet", "chalet"),
    ("house", "chalet"),
    ("casa", "chalet"),
    ("local", "local"),
    ("oficina", "local"),
    ("office", "local"),
    ("nave", "nave"),
    ("industrial", "nave"),
    ("plaza de garaje", "garaje"),
    ("garaje", "garaje"),
    ("garage", "garaje"),
    ("trastero", "garaje"),
    ("storage", "garaje"),
    ("terreno", "terreno"),
    ("land", "terreno"),
    ("suelo", "terreno"),
    ("parcela", "terreno"),
    ("solar", "terreno"),
    ("finca", "terreno"),
    ("edificio", "edificio"),
    ("building", "edificio"),
)


def map_property_type(raw_type: str | None) -> str | None:
    """Map Hipoges' property-type text onto the canonical CHECK vocabulary.

    `raw_type` is whatever the capture yielded — a title/meta string. None if
    neither carried a recognisable type word (honest: better a None than a
    wrong bucket). DRAFT: the keyword list is grounded in the site's own
    public i18n strings, but never verified against a real rendered title.
    """
    if not raw_type:
        return None
    lowered = raw_type.lower()
    for keyword, mapped in _TYPE_KEYWORDS:
        if keyword in lowered:
            return mapped
    return None


def map_operation(raw_operation: str | None) -> str | None:
    """Hipoges' operation text -> canonical 'sale' | 'rent'.

    Hipoges' public `assets/i18n/es.json` maps the English route-grammar
    tokens `sale`/`rent` (observed in the site's Angular route table, see
    hipoges.py's module docstring) to "venta"/"alquiler" respectively — both
    forms are recognised here since it is unconfirmed whether a captured
    title renders the Spanish word or the English URL token verbatim.
    Hipoges is a multi-fund servicer (REO) portal, so 'venta'/'sale' is the
    overwhelming default; 'alquiler'/'rent' exists for some assets. Returns
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
