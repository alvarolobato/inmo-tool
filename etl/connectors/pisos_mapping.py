"""pisos.com-specific field mapping: raw card/URL values -> canonical vocabulary.

pisos.com (Vocento) server-renders its search results as a list of
`<div class="ad-preview" id="{external_id}">` cards, each carrying price,
room/bath/surface/floor "characteristics", title and subtitle, plus one
`<script type="application/ld+json">` block per card with the property's
geo-coordinates and locality/region. This module isolates the
"their vocabulary -> our vocabulary" translation so pisos.py stays about
fetching/parsing structure, not field semantics — mirroring
fotocasa_mapping.py's split for the same reason.

The property TYPE is not published as a structured field anywhere in the
search payload (the per-card JSON-LD `@type` is always the generic
`SingleFamilyResidence`, useless for distinguishing a piso from a garaje).
It IS encoded as the first path token of every listing URL
(`/comprar/<type-token>-<slug>-<id>/`), e.g. `piso`, `duplex`,
`casa_adosada` — live-observed 2026-08 on a real madrid search page across
7 distinct tokens. That URL token is the signal used here.

`extract_reference_and_agency` (issue #628) is the one exception to
"everything comes from the search card" (D-071's original framing): the
seller's reference code and agency name are NOT in the search card or its
JSON-LD (confirmed live 2026-08 — 0/30 cards on a real madrid search page
carry either), only on the DETAIL page, inside a `features__feature` block
labelled "Referencia:" and an `owner-info__name` block respectively — see
D-141 for why `fetch_detail` now makes one real request per listing for
these two fields where it previously made none.
"""

from __future__ import annotations

from bs4 import BeautifulSoup

# The first path token of a pisos.com listing URL
# (`/comprar/<type-token>-...`) -> property.property_type (schema CHECK
# constraint: 'piso','chalet','atico','local','nave','garaje','terreno',
# 'edificio'). Unmapped tokens fall through to None (CHECK allows NULL)
# rather than guessing — the raw token is preserved in raw_extra either way.
# Tokens observed live 2026-08 on a real madrid-province search:
# piso, duplex, casa_adosada, atico, chalet, apartamento, casa_pareada.
# The rest are mechanical extensions of the same vocabulary (pisos.com's
# own property-type filter labels), added so a token that does appear maps
# rather than silently dropping to None; none imply precision beyond the
# token pisos.com itself put in the URL.
URL_TYPE_TOKEN_MAP: dict[str, str] = {
    "piso": "piso",
    "apartamento": "piso",
    "duplex": "piso",
    "estudio": "piso",
    "loft": "piso",
    "atico": "atico",
    "casa": "chalet",
    "casa_adosada": "chalet",
    "casa_pareada": "chalet",
    "casa_rural": "chalet",
    "chalet": "chalet",
    "local": "local",
    "oficina": "local",
    "nave": "nave",
    "garaje": "garaje",
    "trastero": "garaje",
    "terreno": "terreno",
    "solar": "terreno",
    "finca_rustica": "terreno",
    "edificio": "edificio",
}


def type_token_from_url(url: str | None) -> str | None:
    """Extract the property-type token from a pisos.com listing URL.

    `/comprar/piso-gaztambide-65098413759_100500/` -> `piso`. Returns None
    for a URL that doesn't match the expected `/comprar/<token>-...` shape,
    so an unexpected URL shape maps to no type rather than a wrong one.
    """
    if not url:
        return None
    # Strip a leading domain if present, then find the /comprar/ segment.
    marker = "/comprar/"
    idx = url.find(marker)
    if idx == -1:
        return None
    tail = url[idx + len(marker) :]
    first_segment = tail.split("/", 1)[0]
    if not first_segment:
        return None
    return first_segment.split("-", 1)[0] or None


def map_property_type(url: str | None) -> str | None:
    token = type_token_from_url(url)
    if not token:
        return None
    return URL_TYPE_TOKEN_MAP.get(token)


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    cleaned = " ".join(text.split())
    return cleaned or None


def extract_reference_code(html: str) -> str | None:
    """The seller's reference code from a pisos.com DETAIL page (issue #628).

    Real markup (2026-08 live capture, transcribed structure — see
    `etl/tests/fixtures/pisos_sample_detail.html` for the synthetic test
    fixture built from this shape):

        <div class="features__feature">
          <span class="features__icon icon-reference"></span>
          <div>
            <span class="features__label">Referencia: </span>
            <span class="features__value">PH-0010116/14101</span>
          </div>
        </div>

    Scoped to the `features__feature` block whose label text starts with
    "referencia" (case-insensitive) — pisos.com's features list carries many
    other label/value pairs (conservation state, heating, ...) using the
    identical markup shape, so matching on the label text (not just the
    class) is what picks out the right one.
    """
    soup = BeautifulSoup(html, "html.parser")
    for feature in soup.select("div.features__feature"):
        label = feature.select_one(".features__label")
        if label is None:
            continue
        label_text = (label.get_text(strip=True) or "").rstrip(":").strip().lower()
        if label_text != "referencia":
            continue
        value = feature.select_one(".features__value")
        return _clean(value.get_text(" ", strip=True)) if value is not None else None
    return None


def extract_agency_name(html: str) -> str | None:
    """The advertiser/agency name from a pisos.com DETAIL page (issue #628).

    Real markup (2026-08 live capture):

        <div class="owner-info">
          <div class="owner-info__header">
            <div>
              <p class="owner-info__name">
                <a href="/inmobiliaria-<slug>/" rel="nofollow">Princess Homes</a>
              </p>

    `.owner-info__name` is unique on the page (one contact box per
    listing) — no need to disambiguate against other blocks the way
    `extract_reference_code` does.
    """
    soup = BeautifulSoup(html, "html.parser")
    el = soup.select_one(".owner-info__name")
    return _clean(el.get_text(" ", strip=True)) if el is not None else None
