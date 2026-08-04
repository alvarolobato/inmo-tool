"""Pure field-mapping helpers for the BuildingCenter connector (issue #118).

BuildingCenter's public-facing site (`www.buildingcenter.es`) is a
client-rendered Angular "Public Store" SPA — every route (home, a search
results page, `/sitemap.xml`) serves the exact same byte-identical
18,517-byte shell (verified 2026-08-04: MD5
`7e70eab507c3b6f8ed70f77f767c2f7a` for `/`, `/sitemap.xml`,
`/es/compra/viviendas/sevilla` and `/es/compra/viviendas/malaga` alike) —
the same failure shape D-019 found for Aliseda. Unlike Aliseda, the real
data API (`apifrontend.buildingcenter.es`, an SAP Commerce Cloud / OCC
backend named in the shell's `<meta name="occ-backend-base-url">` tag)
publishes **no `robots.txt` at all** (plain HTTP 404, a genuine Tomcat
"Not Found" — not a WAF interstitial dressed up as one) rather than
Aliseda's explicit blanket `Disallow: /`. Absence of a robots.txt is
treated the same way the rest of the web treats it: nothing declared to
comply with, so the standard connector feasibility spike (real, slow,
honestly-identified requests; no CAPTCHA/WAF evasion) is what governs
here, and it passed clean — every request in the spike got a normal,
fast (~0.2-0.4s) response, no CAPTCHA, no soft-block, no rate-limit
response, across ~40 requests spread over the spike session.

So this connector talks to `apifrontend.buildingcenter.es` directly as a
plain JSON REST API, never to the `www` Angular shell. Reverse-engineered
(read-only reconnaissance of the shell's own already-fetched, `Allow: /.js`
static bundle `main-*.js` — not runtime JS execution, no headless browser)
from the bundle's own Spartacus/SAP-Commerce endpoint config:

  - `GET /rest/v2/publicPortal/products/search?fields=...&currentPage=N&pageSize=M`
    returns the site's full published catalogue, paginated. **No query
    filter parameter this connector tried had any effect** — `query`,
    `q` (with the site's own observed facet-string encoding), `channel`,
    `provinceCode` all left `pagination.totalResults` and the returned
    products completely unchanged. Only `currentPage`/`pageSize` work.
    So `discover()` pages through the *entire* national catalogue itself
    (2,108 products total at spike time, confirmed: 22 pages of 100 plus
    an 8-item last page summed to exactly 2,108 unique `code`s, matching
    the server's own `pagination.totalResults` with zero duplicates and
    zero gaps) and filters to category + geography client-side.
  - `GET /rest/v2/publicPortal/public/products/{code}?fields=FULL` — the
    detail fetch. `FULL` is a real SAP Commerce Cloud field-set keyword
    (alongside `BASIC`/`DEFAULT`), not a guess; confirmed live to return
    every field this module reads.
  - `GET /rest/v2/publicPortal/public/categories/rootCategories` — decodes
    category codes. Category `101` = "Viviendas" (residential; the only
    category this connector ingests). Others seen in the catalogue: 102
    Locales, 103 Naves, 104 Oficinas, 105 Suelos, 106 Garajes, 107
    Trasteros, 108 Edificios, 109 Varios.

Coordinate format gotcha, worth flagging because a plausible-looking fix
is actually wrong: latitude/longitude arrive in **two different string
formats** — plain sign-prefixed, zero-padded decimal (`"+040.2296000"`)
and Spanish-locale comma-decimal (`"37,423859"`). The tempting hypothesis
("list scope uses one format, detail scope uses the other") is false: a
full national sweep's own **search** (list-scope) response has both at
once — 1,335 of 2,108 products plain-decimal, 767 comma-decimal, e.g.
product `60540896`'s own list-scope record reads `"latitude":
"37,160099"` (comma) while product `00295250`'s list-scope record reads
`"latitude": "+040.2296000"` (plain) in the very same paginated sweep.
The detail endpoint was comma-decimal on every one of 3 independently
sampled products, but that is not a rule the list scope obeys — trusting
"detail=comma, list=plain" would still misparse over a third of listings'
list-scope coordinates. `parse_coordinate` is deliberately ONE tolerant
function used for both scopes (detect a comma, treat it as the decimal
point; otherwise parse as-is) rather than two endpoint-keyed parsers that
would each be quietly wrong some of the time. No sampled value has both a
comma and a period (coordinates have no thousands separator to worry
about), so "does it contain a comma" is an unambiguous, sufficient test —
verified against the full 2,108-product sweep, not just the samples in
this module's test fixtures.

`isCoordinateAproximated: true` was observed on every sampled detail
record — like Vivantial's own coordinates, these are not precise enough
to drive `address_coords` dedup (issue #1 §6 signal 2's ~15m threshold)
and are stored for map display (#43) and this connector's own scope-radius
filtering only.

No `referenciaCatastral` (cadastral reference) field is exposed on the
public detail endpoint — that field exists in the site's bundle only as a
*search filter* on the authenticated internal cooperator/agent search
(`/users/current/realstateproducts/restricted-cop-search`, gated behind
login), not as a field on the public product representation. So
`cadastral_ref` is honestly left `None` here (see `CanonicalListingVersion`
docstring: "a `None` is honest; a wrong guess ... is worse"). What IS
published on every public detail record is a full Registro de la Propiedad
citation — `idufir` (Identificador Único de Finca Registral, the property
registry's own unique id), plus `tomeNumber`/`bookNumber`/`pageNumber`/
`registerNumber`/`registerPopulation` (the classic tomo/libro/folio/finca
citation). `idufir` is captured in `raw_extra` as a real, if different,
registry-based dedup hint — not wired into `cadastral_ref` because it is
genuinely a different Spanish identifier (finca registral, not referencia
catastral) and conflating the two would be exactly the "wrong guess
presented as data" the docstring warns against.

Overlap with Solvia (issue #132's standing question for every #118-batch
connector): live-verified 2026-08-04, one exact match found in a 5-listing
Solvia-Sevilla sample cross-checked against the BuildingCenter Sevilla-
province catalogue — `DOCTOR BARRAQUER, 41720, PALACIOS Y VILLAFRANCA
(LOS)` (BuildingCenter code `60540896`) vs. Solvia's `C/ Dr. Barraquer`
listing (id `182624-221244`), identical price to the euro (90.815 €),
identical bedroom count (3) and identical municipality. So BuildingCenter
is **not** 100% redundant with Solvia the way Haya turned out to be
(D-021) — but it is not zero-overlap either. Treat any BuildingCenter x
Solvia match the dedup engine finds as expected, not a bug.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from etl.connectors.extraction import first_present, strip_price_punctuation

# Category code for residential listings ("Viviendas") — the only category
# this connector ingests. See module docstring for the full code table.
CATEGORY_VIVIENDAS = "101"

_POSTAL_CODE_RE = re.compile(r"\b(\d{5})\b")

# Standard Spanish postal-code province prefix (== INE province code), a
# publicly documented, static mapping — not site-specific guesswork, the
# same kind of fixed reference table Vivantial's `_CITY_SLUGS` is. Used
# because BuildingCenter's product representation carries a postal code
# embedded in `address` but no separate structured province field (checked
# live: an explicit `province`/`provinceCode` fields request is silently
# ignored by the detail endpoint and rejected outright by the search
# endpoint).
_PROVINCE_BY_POSTAL_PREFIX: dict[str, str] = {
    "01": "Álava",
    "02": "Albacete",
    "03": "Alicante",
    "04": "Almería",
    "05": "Ávila",
    "06": "Badajoz",
    "07": "Balears (Illes)",
    "08": "Barcelona",
    "09": "Burgos",
    "10": "Cáceres",
    "11": "Cádiz",
    "12": "Castellón",
    "13": "Ciudad Real",
    "14": "Córdoba",
    "15": "Coruña (A)",
    "16": "Cuenca",
    "17": "Girona",
    "18": "Granada",
    "19": "Guadalajara",
    "20": "Guipúzcoa",
    "21": "Huelva",
    "22": "Huesca",
    "23": "Jaén",
    "24": "León",
    "25": "Lleida",
    "26": "Rioja (La)",
    "27": "Lugo",
    "28": "Madrid",
    "29": "Málaga",
    "30": "Murcia",
    "31": "Navarra",
    "32": "Ourense",
    "33": "Asturias",
    "34": "Palencia",
    "35": "Palmas (Las)",
    "36": "Pontevedra",
    "37": "Salamanca",
    "38": "Santa Cruz de Tenerife",
    "39": "Cantabria",
    "40": "Segovia",
    "41": "Sevilla",
    "42": "Soria",
    "43": "Tarragona",
    "44": "Teruel",
    "45": "Toledo",
    "46": "Valencia",
    "47": "Valladolid",
    "48": "Vizcaya",
    "49": "Zamora",
    "50": "Zaragoza",
    "51": "Ceuta",
    "52": "Melilla",
}

# BuildingCenter's `realStateType` field is coarse ("Vivienda" on every
# category-101 sample seen — no finer piso/atico/chalet breakdown observed
# live). Mirrors the "vivienda" -> "piso" convention already established
# in vivantial_mapping.py's `_PROPERTY_TYPE_MAP` (same reasoning: "piso" is
# the closest honest canonical bucket for an undifferentiated "Vivienda",
# not a guess at a specific sub-type this API doesn't actually tell us).
_PROPERTY_TYPE_MAP: dict[str, str] = {
    "vivienda": "piso",
}

# featureList `id` values (issue #1 §4's structured-features field) that
# are actually set `"active": true` on real sampled listings map 1:1 to
# their own id string — no translation table needed, BuildingCenter's ids
# are already lowerCamelCase English tokens (airConditioning, heating,
# lift, pool, garden, terrace, parking, storageRoom, yard, balcony,
# smokeOutlet).


def extract_postal_code(address: str | None) -> str | None:
    """5-digit Spanish postal code embedded in the `address` field.

    BuildingCenter's `address` is a street/postal fragment like
    "ESTURION, 41015" or "DOCTOR BARRAQUER, 41720" — city name lives in
    the separate `population` field, not here. No fallback path exists
    (checked live: no separate `postalCode` field on the detail
    representation), so this is a single-path extraction, not a
    first_present chain.
    """
    if not address:
        return None
    match = _POSTAL_CODE_RE.search(address)
    return match.group(1) if match else None


def extract_province(postal_code: str | None) -> str | None:
    """Province name from a postal code's 2-digit prefix, or None."""
    if not postal_code or len(postal_code) < 2:
        return None
    return _PROVINCE_BY_POSTAL_PREFIX.get(postal_code[:2])


def extract_full_address(detail: dict[str, Any]) -> str | None:
    """`address` plus `population` (city), deduplicated.

    Raw `address` never carries the city name itself, so a bare `address`
    value ("ESTURION, 41015") is missing exactly the piece a human reading
    it later would want. Appends `population` only when it is not already
    a substring of `address` (defensive — no sampled listing needed this,
    but cheap to guard).
    """
    address = detail.get("address")
    if not address:
        return None
    address = str(address).strip()
    population = detail.get("population")
    if population and str(population).strip().lower() not in address.lower():
        return f"{address}, {str(population).strip()}"
    return address


def parse_coordinate(value: str | None) -> Decimal | None:
    """Parse a BuildingCenter coordinate string, in either format it uses.

    See module docstring's coordinate-format gotcha: this single function
    is used for BOTH list-scope and detail-scope values on purpose — the
    format is not determined by which endpoint you called (verified
    against a full 2,108-product national sweep, not assumed). A comma
    present anywhere in the string is treated as the decimal point
    (`"37,423859"` -> `37.423859`); otherwise the value is parsed as a
    plain, possibly sign-prefixed and zero-padded decimal
    (`"+040.2296000"` -> `40.2296000`). No sampled value ever carries both
    a comma and a period, so this dispatch is unambiguous.
    """
    if not value:
        return None
    text = str(value).strip()
    if "," in text:
        text = text.replace(",", ".")
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def _price_from_value(detail: dict[str, Any]) -> Decimal | None:
    price = detail.get("price")
    if not isinstance(price, dict):
        return None
    value = price.get("value")
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def _price_from_formatted(detail: dict[str, Any]) -> Decimal | None:
    price = detail.get("price")
    if not isinstance(price, dict):
        return None
    digits = strip_price_punctuation(price.get("formattedValue"))
    if not digits:
        return None
    try:
        return Decimal(digits)
    except InvalidOperation:
        return None


def extract_price(detail: dict[str, Any]) -> Decimal | None:
    """`price.value` primary, `price.formattedValue` (e.g. "81.750\xa0€") as
    a fallback chain (issue #118 acceptance criteria's required working
    fallback — proven absent-primary in
    test_connector_buildingcenter.py). Live-verified 2026-08-04: a
    search-list `price.value` (119200.0 for product 00295250) matched
    that same product's independently-fetched detail `price.value`
    exactly — the discovery-time price this connector's
    `discovered_prices()` relies on is a real, confirmed signal, not an
    assumed one (docs/skills/connectors.md's Fotocasa-vs-Milanuncios
    verification discipline).
    """
    return first_present(
        lambda: _price_from_value(detail),
        lambda: _price_from_formatted(detail),
        field="price",
    )


def extract_property_type(detail: dict[str, Any]) -> str | None:
    real_state_type = detail.get("realStateType")
    if not real_state_type:
        return None
    return _PROPERTY_TYPE_MAP.get(str(real_state_type).strip().lower())


def extract_operation(detail: dict[str, Any]) -> Literal["sale", "rent"] | None:
    """'sale' takes priority over 'rent' for a dual-commercialized listing.

    A handful of sampled products (e.g. a Murcia listing, code 60439422)
    have both `commercializedForSale` and `commercializedForRent` true at
    once. `CanonicalListingVersion.operation` is a single value, and this
    site's dominant channel is sale (`price.priceType` is `"BUY"` on every
    sampled record) — 'sale' is the honest majority-channel default for a
    dual-listed property, not a guess with no basis.
    """
    if detail.get("commercializedForSale"):
        return "sale"
    if detail.get("commercializedForRent"):
        return "rent"
    return None


def extract_status(detail: dict[str, Any]) -> str:
    """'active' unless the listing is explicitly not being commercialized
    at all.

    BuildingCenter's public API does not expose a documented status
    enum beyond `marketingStatus` (only `IMMEDIATE_MARKETING` observed
    live, on every sampled active listing) — rather than guess at
    unobserved values (e.g. a hypothetical "RESERVED"/"SOLD"), this reads
    the two boolean commercialization flags that are actually confirmed:
    neither set means the site itself is not currently offering the
    property for sale or rent, which is what `listing.status` means.
    """
    if detail.get("commercializedForSale") or detail.get("commercializedForRent"):
        return "active"
    return "withdrawn"


def extract_features(detail: dict[str, Any]) -> tuple[str, ...]:
    feature_list = detail.get("featureList")
    if not isinstance(feature_list, list):
        return ()
    return tuple(
        sorted(
            str(f["id"])
            for f in feature_list
            if isinstance(f, dict) and f.get("active") and f.get("id")
        )
    )


_ENERGY_RATING_RE = re.compile(r"^[A-G]$")


def extract_energy_rating(detail: dict[str, Any]) -> str | None:
    rating = detail.get("energyRating")
    if not rating:
        return None
    rating = str(rating).strip().upper()
    return rating if _ENERGY_RATING_RE.match(rating) else None


def extract_photo_urls(detail: dict[str, Any], *, base_url: str) -> tuple[str, ...]:
    images = detail.get("images")
    if not isinstance(images, list):
        return ()
    urls: list[str] = []
    for image in images:
        if not isinstance(image, dict):
            continue
        path = image.get("url")
        if not path:
            continue
        urls.append(f"{base_url}{path}" if path.startswith("/") else str(path))
    return tuple(urls)


def extract_description(detail: dict[str, Any]) -> str | None:
    description = detail.get("description")
    if not description:
        return None
    text = str(description).strip()
    return text or None


def extract_bedrooms(detail: dict[str, Any]) -> int | None:
    value = detail.get("numberOfBedRooms")
    return int(value) if isinstance(value, (int, float)) else None


def extract_bathrooms(detail: dict[str, Any]) -> int | None:
    value = detail.get("numberOfBathRooms")
    return int(value) if isinstance(value, (int, float)) else None


def extract_m2_built(detail: dict[str, Any]) -> Decimal | None:
    value = detail.get("metersBuildable")
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def extract_reference_code(detail: dict[str, Any]) -> str | None:
    code = detail.get("commercialID") or detail.get("code")
    return str(code) if code else None


def extract_public_url(detail: dict[str, Any], *, base_url: str) -> str | None:
    """The Angular shell's own display URL for this listing.

    Not fetched by this connector (the shell is a client-rendered SPA —
    see module docstring), but useful for a human clicking through from
    the UI, exactly like Vivantial's/Solvia's stored detail URLs.
    """
    path = detail.get("url")
    if not path:
        return None
    return f"{base_url}{path}" if str(path).startswith("/") else str(path)


def raw_extra(detail: dict[str, Any]) -> dict[str, Any]:
    """Registry citation + possession/legal status fields with no canonical
    column (issue #1 §4: capture rather than drop).

    `idufir` is a real Registro de la Propiedad identifier — see module
    docstring for why it is captured here rather than mapped onto
    `cadastral_ref` (a different Spanish identifier; conflating them would
    misrepresent a genuine registry id as a cadastral reference).
    `superStatusPossesoryType` ("Con posesión" / presumably "Sin
    posesión") is the structured occupancy-adjacent flag the project's
    standing per-connector spike checklist (#132) asks every servicer
    connector to look for.
    """
    extra: dict[str, Any] = {}
    for key in (
        "idufir",
        "tomeNumber",
        "bookNumber",
        "pageNumber",
        "registerNumber",
        "registerPopulation",
        "superStatusLegalType",
        "superStatusPossesoryType",
        "marketingStatus",
        "isCoordinateAproximated",
        "vpoFlag",
    ):
        if key in detail and detail[key] is not None:
            extra[key] = detail[key]
    return extra
