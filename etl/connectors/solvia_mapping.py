"""Pure field-mapping helpers for the Solvia connector (issue #116).

Kept separate from `solvia.py` for the same reason as the Fotocasa/
Milanuncios split: everything here is a pure function over an already-
fetched payload, so it is unit-testable with a fixture and zero network.

Solvia is Angular Universal (SSR). Every field this connector needs is in
a single `<script id="ng-state" type="application/json">` blob under
`propertyBasicDetail` — a stable, well-typed structure rather than markup
scraped out of rendered HTML. That makes the *primary* extraction path
unusually reliable here compared to Fotocasa/Milanuncios, but the same
fallback-chain discipline still applies (issue #77/#78's lesson): a
renamed key silently yields None with no recovery unless a fallback
exists, so the fields most likely to move carry CSS/`<title>` fallbacks.
"""

from __future__ import annotations

import unicodedata
from decimal import Decimal, InvalidOperation
from typing import Any

from etl.connectors.extraction import first_present

# `tipoVivienda.name` -> property.property_type, whose CHECK constraint
# (etl/schema/init.sql) allows only:
#   'piso','chalet','atico','local','nave','garaje','terreno','edificio'
#
# Without this translation every Solvia INSERT raises CheckViolation: the
# site's vocabulary ("Piso", "Locales", "Nave Industrial", ...) overlaps
# ours only by accident. Both existing connectors carry the equivalent map
# (fotocasa_mapping.BUILDING_TYPE_MAP, milanuncios_mapping's own) for the
# same reason.
#
# Keys are accent-folded lowercase (see `_fold`) so "Dúplex"/"Duplex"/
# "DÚPLEX" all resolve — Solvia's casing is inconsistent across trees and
# an exact-match dict would silently drop the accented variants.
#
# Every value below marked (v) was read from a live `tipoVivienda.name` on
# a real listing during the #138 review, one per slug family across the
# viviendas/locales/garajes/naves/suelos/oficinas/trasteros search trees.
# The unmarked ones are plausible siblings kept because an unmapped value
# costs a NULL rather than a wrong answer.
_PROPERTY_TYPE_MAP: dict[str, str] = {
    # Flats and flat-likes
    "piso": "piso",  # (v)
    "bajo": "piso",  # (v) ground-floor flat, not a distinct schema type
    "estudio": "piso",  # (v)
    "duplex": "piso",  # (v) "Dúplex"
    "apartamento": "piso",
    "atico": "atico",
    # Houses
    "casa": "chalet",  # (v)
    "chalet": "chalet",
    "chalet adosado": "chalet",  # (v)
    "chalet pareado": "chalet",
    "chalet independiente": "chalet",
    "casa adosada": "chalet",
    "adosado": "chalet",
    "pareado": "chalet",
    # Commercial / industrial
    "local": "local",
    "locales": "local",  # (v) Solvia pluralises this one
    "oficina": "local",  # schema has no 'oficina'; 'local' is the closest
    "oficinas": "local",  # (v)
    "nave": "nave",
    "nave industrial": "nave",  # (v)
    # Parking
    "garaje": "garaje",  # (v)
    "plaza de garaje": "garaje",
    "parking": "garaje",
    # Land
    "terreno": "terreno",
    "solar": "terreno",
    "solares": "terreno",  # (v)
    "suelo": "terreno",
    "finca": "terreno",
    # Whole buildings
    "edificio": "edificio",
    # Deliberately unmapped, though real and observed:
    #   "Trastero" (v) — a storage room. The schema has no equivalent and
    #   'local'/'garaje' would both be wrong, so it resolves to NULL. The
    #   raw value survives in raw_extra either way.
}


def _fold(value: str) -> str:
    """Lowercase and strip accents, so 'Dúplex' and 'Duplex' collapse."""
    decomposed = unicodedata.normalize("NFKD", value.strip().lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def map_property_type(raw_type: str | None) -> str | None:
    """Translate Solvia's type name to the schema vocabulary; None if unknown.

    None rather than a guess: `property_type` is nullable, so an unmapped
    value costs a missing field, whereas a wrong guess silently mis-files a
    property in every downstream filter and score.
    """
    if not raw_type or not raw_type.strip():
        return None
    return _PROPERTY_TYPE_MAP.get(_fold(raw_type))


# `caracteristicas` booleans worth surfacing as `features` slug tokens.
# Deliberately a curated allowlist, not "every true boolean": the raw
# object carries ~55 keys, most of them commercial/land-only nulls
# (`supEdificableResidencial`, `cuotaParticipaticonAmbito`, ...) that
# would be noise in a residential candidate's feature list. Slug tokens,
# not human strings, to match `data-model.md`'s documented `features`
# convention and stay usable by a GIN containment query.
_FEATURE_FLAGS: dict[str, str] = {
    "piscina": "piscina",
    "garaje": "garaje",
    "trastero": "trastero",
    "urbanizacion": "urbanizacion",
    "playa": "playa",
    "golf": "golf",
    "padel": "padel",
    "amueblado": "amueblado",
    "vpo": "vpo",
}

# Solvia's `tipoTransaccion`. The connector only ever discovers from the
# /comprar/ (buy) tree, but normalize() reads the real field rather than
# hardcoding 'sale' — a hardcoded value would silently mislabel anything
# reached by another path, and #77's review flagged exactly that pattern
# on Fotocasa as an assumption presented as a guarantee.
_TRANSACTION_TO_OPERATION: dict[str, str] = {
    "COMPRA": "sale",
    "ALQUILER": "rent",
}


def _to_decimal(value: Any) -> Decimal | None:
    """Coerce a JSON number/string to Decimal; None on anything unusable."""
    if value is None or isinstance(value, bool):
        return None
    try:
        text = str(value).strip()
        if not text:
            return None
        return Decimal(text)
    except (InvalidOperation, ValueError, ArithmeticError):
        return None


def _to_int(value: Any) -> int | None:
    """Coerce a JSON number/string to int; None on anything unusable."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def _named(value: Any) -> str | None:
    """Solvia nests several fields as {"id":..,"name":..,"amigable":..}."""
    if isinstance(value, dict):
        name = value.get("name") or value.get("amigable")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return None


def _yes_no(value: Any) -> bool | None:
    """Solvia encodes several booleans as the strings 'S'/'N'."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        upper = value.strip().upper()
        if upper == "S":
            return True
        if upper == "N":
            return False
    return None


def _photo_urls_from_key(detail: dict[str, Any], key: str) -> tuple[str, ...] | None:
    """De-duplicated image URLs from one `listaImagenes*` key, or None."""
    images = detail.get(key)
    if not isinstance(images, list):
        return None
    urls: list[str] = []
    for entry in images:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if isinstance(url, str) and url.strip():
            cleaned = url.strip().replace("\\", "/")
            if cleaned not in urls:
                urls.append(cleaned)
    return tuple(urls) or None


def extract_photo_urls(detail: dict[str, Any]) -> tuple[str, ...]:
    """Highest-resolution image list, de-duplicated, order preserved.

    Solvia publishes the same photo set at five resolutions
    (`listaImagenesInmueble{,Pc,Mov,Otros,Original}`). Prefer ORIGINAL for
    the perceptual-hash dedup signal (#16 signal 4) — downscaled variants
    lose exactly the detail that signal discriminates on. Backslashes in
    the CDN paths are real in Solvia's payload (Windows-style separators
    leaking through), normalised here rather than at every call site.

    Routed through `first_present` rather than a hand-rolled loop so a
    getter that *raises* (rather than returning None) is logged with its
    field name instead of vanishing — the observability #77 added
    deliberately, which a bespoke `for` loop silently forfeits.
    """
    return (
        first_present(
            lambda: _photo_urls_from_key(detail, "listaImagenesInmuebleOriginal"),
            lambda: _photo_urls_from_key(detail, "listaImagenesInmueble"),
            field="photo_urls",
        )
        or ()
    )


def extract_features(detail: dict[str, Any]) -> tuple[str, ...]:
    """Slug tokens for the curated `caracteristicas` booleans that are true.

    Also folds in `climatizacion` (a free-text string, not a boolean) as a
    slugified token when present, since air-conditioning/heating is a real
    filterable amenity rather than metadata.
    """
    caracteristicas = detail.get("caracteristicas")
    if not isinstance(caracteristicas, dict):
        return ()

    tokens: list[str] = []
    for source_key, token in _FEATURE_FLAGS.items():
        if caracteristicas.get(source_key) is True and token not in tokens:
            tokens.append(token)

    climate = caracteristicas.get("climatizacion")
    if isinstance(climate, str) and climate.strip():
        slug = climate.strip().lower().replace(" ", "_")
        # Keep the token machine-shaped and ASCII-safe for containment queries.
        slug = (
            slug.replace("á", "a")
            .replace("é", "e")
            .replace("í", "i")
            .replace("ó", "o")
            .replace("ú", "u")
        )
        if slug and slug not in tokens:
            tokens.append(slug)

    return tuple(tokens)


def extract_cadastral_ref(detail: dict[str, Any]) -> str | None:
    """`caracteristicas.refCatastral` — the Spanish cadastral reference.

    Worth calling out: issue #42 (a dedicated Catastro lookup connector)
    was cancelled on the correct reasoning that resolving a cadastral
    reference needs street-number-precise addresses most portals withhold.
    Solvia simply *publishes* it per listing. That makes this connector the
    first real source for the dedup engine's highest-confidence signal
    (`etl/dedup/signals/cadastral.py`, issue #1 §6 signal 1), which until
    now has had no data to fire on. Stored in `raw_extra` because the
    canonical dataclass has no dedicated column; the dedup signal reads
    `property.cadastral_ref`, so wiring that column through is a follow-up,
    not something this connector can do alone.
    """
    caracteristicas = detail.get("caracteristicas")
    if isinstance(caracteristicas, dict):
        ref = caracteristicas.get("refCatastral")
        if isinstance(ref, str) and ref.strip():
            return ref.strip()
    return None


def extract_operation(detail: dict[str, Any]) -> str | None:
    """Map `tipoTransaccion` to the canonical 'sale'/'rent' vocabulary."""
    raw = detail.get("tipoTransaccion")
    if isinstance(raw, str):
        return _TRANSACTION_TO_OPERATION.get(raw.strip().upper())
    return None


def extract_address(detail: dict[str, Any]) -> str | None:
    """`direccion` is street-level; fall back to the promotion name.

    Solvia's `promocion.name` is frequently the same street string, so it
    is a genuine fallback rather than a different field wearing a
    different name.
    """

    def _from_direccion() -> str | None:
        direccion = detail.get("direccion")
        if isinstance(direccion, str) and direccion.strip():
            return direccion.strip()
        return None

    return first_present(
        _from_direccion,
        lambda: _named(detail.get("promocion")),
        field="address",
    )


def extract_m2_built(detail: dict[str, Any]) -> Decimal | None:
    """Top-level `m2`, falling back to `caracteristicas.supConstruida`.

    These genuinely differ (a live sample had m2=50 vs supConstruida=43),
    so this is a real fallback, not a duplicate of the same number: `m2` is
    the figure Solvia advertises in search results, `supConstruida` the
    built-surface detail. Prefer the advertised one for comparability with
    other portals, which also advertise built surface.
    """

    def _from_caracteristicas() -> Decimal | None:
        caracteristicas = detail.get("caracteristicas")
        if isinstance(caracteristicas, dict):
            return _to_decimal(caracteristicas.get("supConstruida"))
        return None

    return first_present(
        lambda: _to_decimal(detail.get("m2")),
        _from_caracteristicas,
        field="m2_built",
    )


def extract_m2_plot(detail: dict[str, Any]) -> Decimal | None:
    """`caracteristicas.m2Parcela`; 0 treated as absent, not a real 0m² plot.

    Mirrors the Fotocasa retrofit's handling (#77 review): a 0 here means
    "not a plot-bearing property type", and letting it through as a real
    zero would make the orchestrator's COALESCE overwrite a better value
    on a later re-visit.
    """
    caracteristicas = detail.get("caracteristicas")
    if not isinstance(caracteristicas, dict):
        return None
    value = _to_decimal(caracteristicas.get("m2Parcela"))
    if value is None or value == 0:
        return None
    return value


def extract_investment_extras(detail: dict[str, Any]) -> dict[str, Any]:
    """Carrying costs and condition flags Solvia publishes and most portals don't.

    None of these have canonical columns yet, so they ride in `raw_extra`
    rather than being dropped (issue #1 §4). They are genuinely
    investment-relevant: `importeIbi` (annual property tax) and
    `importeGastosComunidad` (monthly community fee) are exactly the
    inputs Phase 5's net-yield maths (#33) otherwise has to guess at, and
    `reformar`/`estado` are a structured signal for the condition
    assessment flow (#26) that would otherwise be inferred from prose.
    Not every listing carries them — two of five live spot-checks had IBI
    and community fees, all five had the condition fields.
    """
    caracteristicas = detail.get("caracteristicas")
    extras: dict[str, Any] = {}
    if isinstance(caracteristicas, dict):
        for source_key, out_key in (
            ("importeIbi", "ibi_anual_eur"),
            ("importeGastosComunidad", "gastos_comunidad_eur"),
            ("estado", "estado"),
            ("superficieCatastral", "superficie_catastral"),
        ):
            value = caracteristicas.get(source_key)
            if value not in (None, ""):
                extras[out_key] = value
        needs_reform = caracteristicas.get("reformar")
        if isinstance(needs_reform, bool):
            extras["reformar"] = needs_reform

    reserved = _yes_no(detail.get("reservado"))
    if reserved is not None:
        extras["reservado"] = reserved

    first_published = detail.get("fichaFechaPrimeraPub")
    if isinstance(first_published, str) and first_published.strip():
        extras["fecha_primera_publicacion"] = first_published.strip()

    return extras
