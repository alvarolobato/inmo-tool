"""Hipoges connector — capture-only, no live network fetch (issue #75/#207).

═══════════════════════════════════════════════════════════════════════════
  CAPTURE-ONLY. Field selectors CALIBRATED against one real capture (issue
  #547) — see D-111 (docs/decisions/D-111-hipoges-capture-only.md) and its
  amendment for exactly which fields carry real confidence vs. which stay
  deliberately uncalibrated after a SINGLE observed listing.
═══════════════════════════════════════════════════════════════════════════

D-075 (docs/decisions/D-075-hipoges-walled-enumeration-capture-only.md)
established, with live reconnaissance, that Hipoges (`realestate.hipoges.com`)
is NOT respectfully crawlable: every sanctioned enumeration channel (the
sitemaps its own `robots.txt` advertises, the same-host GET asset API) 403s
an honest client with an app-level "No tiene permisos suficientes" message;
the only responsive channel is an internal `POST /api/assets/map` DTO the
site walls, which this project will not fuzz (D-033's Cimenta2 stop
condition). D-075 routed this to the browser-extension capture path (#75)
without writing a connector.

**Re-verified live 2026-08-18** (plain GET, honest identifying User-Agent,
no spoofing, no probing beyond public pages) — unchanged 12 days on:

  - `GET /robots.txt` -> HTTP 200, permissive (`User-agent: * / Allow: /`),
    advertises `Sitemap: /sitemap.xml`.
  - `GET /sitemap.xml` -> HTTP 200, a sitemap INDEX listing
    `page_es_sitemap.xml` / `activo_es_sitemap.xml` (+ pt/gr/it siblings).
  - `GET /page_es_sitemap.xml` -> **HTTP 403** "No tiene permisos
    suficientes para acceder a esta ruta".
  - `GET /activo_es_sitemap.xml` -> **HTTP 403**, identical message.
  - `GET /` -> HTTP 200, but the response is a bare Angular SPA shell (no
    server-rendered listing content — the same shape as Idealista/Aliseda's
    `www` hosts): meta/OpenGraph tags and hreflang alternates only.

This connector therefore mirrors Idealista/Aliseda/Altamira exactly:
  - `scope_key()` always returns None — the orchestrator's profile-driven
    sweep skips it every time; discover()/fetch_detail() are never called.
  - `discover()`/`fetch_detail()` exist only to satisfy the Connector ABC and
    raise immediately as a defensive invariant.
  - The real entry point is `normalize()`, called by etl/capture.py with a
    RawListing built from HTML a human's browser rendered and the extension
    POSTed to /api/extension/capture.

──────────────────────────────────────────────────────────────────────────
  URL SHAPE: grounded in the site's own public Angular route table, now
  PARTIALLY reconfirmed by a real capture (issue #547).
──────────────────────────────────────────────────────────────────────────
`main-*.js` and its lazy `chunk-*.js` siblings are the client-side JS bundle
the Angular app itself ships to every visitor's browser (a public static
asset, not an API call — the same thing "view source" gets you). Its
literal `path:` route table includes, among others:

    :lang/detail/:id
    :lang/detail/:id/contact-received
    :lang/detail/:id/unavailable
    :lang/:investment/detail/:id
    :lang/:investment/detail/:id/contact-received
    :lang/:investment/detail/:id/unavailable
    :lang/:operation/:typology/:country/:town[/:features]   (listing/search)
    :lang/area/...  :lang/countries/...  :lang/map/...  :lang/point/...
                                                          (listing/search)

So a detail page is `/<lang>/detail/<id>` or `/<lang>/<investment>/detail/
<id>` (`:investment` is an unconfirmed category segment — possibly the
`auction`/`cdr`/`npl`/`occupied`/`rented`/`special` navbar categories seen
in the bundle's asset filenames, never confirmed) with an optional
`/contact-received` or `/unavailable` suffix on the SAME id. `<id>` is
whatever segment sits directly after `detail/` — never assumed numeric,
unlike Altamira's numeric-id assumption, because nothing in the route table
constrains it.

**What issue #547's real capture confirmed and what it left unconfirmed**:
the owner's 4 real captures were all `https://realestate.hipoges.com/es/
detail/RARE-04347` — the plain `:lang/detail/:id` base case, matching
`_EXTERNAL_ID_RE` exactly with no `:investment` segment and no `/contact-
received`/`/unavailable` suffix. That's the ONLY URL shape this connector
has ever seen live. The `:investment`-segment variant and both suffixes
remain exactly as unconfirmed as before — still grounded in the route
table's own text, still never observed on a real page.

──────────────────────────────────────────────────────────────────────────
  DOM EXTRACTION: calibrated against ONE real capture (RARE-04347, issue
  #547) — see D-111's amendment for the full field-by-field confidence
  writeup. Everything below is a SINGLE OBSERVATION: one property, one
  servicer template, one listing state (occupied/tenanted, for sale). A
  selector that works here may not generalise to a different property type,
  a rental listing, or a future Hipoges redesign.
──────────────────────────────────────────────────────────────────────────

  GATED, NOT JUST LABELED (Opus review, PR #548, C2 — behaviour preserved
  by #547): `selectors_calibrated` in `raw_extra` is a MODULE CONSTANT
  (`_SELECTORS_CALIBRATED`), not just an observational flag — while it is
  False, `normalize()` forces every DOM-derived field (title, description,
  price, m², rooms, bathrooms, reference code, photos, property_type,
  operation, city, province) to None/()/OpenGraph-only, regardless of what
  the extractors below would have found. #547 flips it to True because
  every one of those fields now has real-page grounding; if a future
  redesign is suspected, flip it back to False rather than trust an
  unvalidated selector — the whole point of the gate is that "no data" is
  always safer than "plausible-looking wrong data" (D-057's below-market
  boost, D-098's price-history adoption, D-059's hard filters all trust
  these fields silently).

  **What #547's real capture (RARE-04347) actually found — the biggest
  surprise was how wrong the pre-#547 draft's assumptions were:**

    - **OpenGraph meta is generic site branding, not per-listing content.**
      `og:title`/`og:description` on the real detail page are literally
      "Venta y alquiler de inmuebles al mejor precio | Hipoges" / "Encuentra
      aquí las mejores oportunidades..." — the SAME text a home page would
      carry, confirmed by the DB's own `extension_capture.title` column
      (populated from this exact OG title) showing that generic string, not
      "Piso en venta en urbanización Maria Teresa Leon". The pre-#547
      "title/description: OpenGraph ONLY" design (Opus review, PR #548, C2)
      was reasonable given no real capture existed, but the real page
      proves OG meta is USELESS for either field — and worse than useless:
      it is KNOWN-HARMFUL, not merely a weaker signal (Opus review, PR
      #657). `map_operation()` checks "alquil" before "venta", so the
      generic OG title's word "alquiler" (from "Venta y alquiler...")
      returned `"rent"` for a real 266.000EUR SALE listing whenever the
      real `<h1>` hadn't rendered yet — a reachable capture state, since
      `browser-extension/detect.js`'s `readySelectors` gate is satisfied by
      `main` alone. Both title and description are therefore DOM-ONLY when
      calibrated, with NO OG-meta fallback at all: a missing `<h1>`/
      description node degrades straight to `None`, exactly like every
      other calibrated field on a miss — never to content proven to
      actively corrupt a downstream derived field (`operation`,
      `property_type`).

    - **No element anywhere on the real page carries a `price`/`precio`
      CSS class.** `soup.select('[class*="price" i], [class*="precio" i]')`
      returns ZERO matches against the real capture — the pre-#547 draft's
      entire price selector would have found nothing, forever. The real
      price lives as a `<span>` with the exact text "Precio" immediately
      followed by a sibling `<span>` holding the value ("266.000&nbsp;€")
      — a label/value-sibling pattern, not a class-based one.

    - **m²/rooms/bathrooms are NOT a contiguous "84 m²" text run anywhere
      on the page** — the pre-#547 draft's `_M2_RE`/`_ROOMS_RE`/`_BATHS_RE`
      regex-over-flattened-body-text approach could never have matched:
      the real markup renders the number and its unit label as SEPARATE
      sibling `<span>` elements inside an `<init-feature-card>` custom
      element (one card each for m², rooms, bathrooms, energy grade, plus
      unlabelled amenity chips like "Trastero"/"Garaje"). Replaced with a
      structural reader (`_feature_card_value`) that finds the card whose
      spans include a recognised label keyword ("Metros"/"Habitac"/"Baño")
      and returns the first NUMERIC span in that card — deliberately not
      "the first span" by position, because the real page renders the
      energy-grade card's value/label spans in the OPPOSITE order between
      its mobile and desktop variants (both are present in the DOM at
      once, CSS-hidden per breakpoint — Angular SSR renders both).

    - **The real "similar properties" contamination is a custom element,
      not a CSS class — the pre-#547 class-based contamination-drop
      (`_CONTAMINATION_SELECTORS`) matched ZERO elements on the real
      page.** The rail sits in `<init-asset-detail-related-assets id=
      "others">`, containing `<init-similar-card>` elements, each carrying
      a DIFFERENT property's own price/m²/rooms/baths/photo — genuinely
      present on the page, genuinely capable of bleeding into an unscoped
      reader, and genuinely invisible to a `[class*="similar" i]` guess.
      Every calibrated extractor below scopes to the real per-section
      component tag (`init-asset-detail-main-info`/`-features`/
      `-description`/`-details`/`-gallery`) FIRST, which structurally
      excludes the related-assets sibling on its own; `_CONTAMINATION_SELECTORS`
      is corrected to the real observed tag (kept only as a second layer of
      defense for the class-based fallback paths, which still trigger if a
      future redesign drops one of those component tags).

    - **The property-type vocabulary now has an explicit structured
      source**, not just a title-keyword guess: the "Detalles del Inmueble"
      panel (`<init-asset-detail-details>`) renders label/value pairs as
      two sibling `<span>`s inside a `div[class*="grid-cols-2"]` row — e.g.
      "Tipo de propiedad" / "Piso". Used as the PRIMARY source for
      `property_type`, with the title-keyword match kept as a fallback for
      when that row is absent (only 2 of the panel's possible rows were
      populated for this one listing — "Tipo de propiedad" and "Planta";
      every other attribute the panel can render, e.g. year built or a
      cadastral reference, is untested and NOT extracted).

    - **City/province ARE extractable** — previously hardcoded `None`
      with the comment "not extractable without a real capture". The
      header renders one combined "<municipio>, <provincia>" string
      ("Estepona, Málaga") in a `<span>` right after a geolocation-pin
      `<img alt="Location icon">`, inside `init-asset-detail-main-info`.
      Split on the first comma. Single observation: the field ordering
      (municipality first) matches every other Spanish REO connector in
      this batch but is not independently reconfirmed for Hipoges. Full
      street-level `address` remains unextractable — the page has no
      address field at all, only the urbanización/development name folded
      into the title text.

    - **Left deliberately uncalibrated** despite being visible on the real
      page: the energy-certificate letter grade (a `[class*="price"]`-style
      trap risk — Spanish portals sometimes show a placeholder instead of a
      real grade when no certificate exists, e.g. altamira.py's "en
      trámite" case, and this project has exactly one sample to tell those
      apart) and the "Planta" (floor) detail row (a free-text ordinal like
      "2da Planta" that would need guessed parsing to become a floor
      number — exactly the "don't fabricate precision" trap). Both are
      real, observed, NOT wired into `normalize()`; a future task can
      revisit either with more samples.

  What grounding existed BEFORE #547 and is now folded into the confirmed
  set above:
    - Hipoges' own public `assets/i18n/es.json` (a static translation
      bundle, not the walled asset API) confirms the Spanish property-type
      vocabulary used elsewhere in this project's mapping tables ("Piso",
      "Casa", "Garaje", "Trastero", "Terreno", "Oficina", "Edificio",
      "Apartamento") is genuinely part of this site's vocabulary — see
      hipoges_mapping.py. The real capture's "Tipo de propiedad: Piso" row
      independently confirms "Piso" specifically.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

from bs4 import BeautifulSoup

from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    RawListing,
    Throttle,
)
from etl.connectors.extraction import (
    first_present,
    scoped_node,
    strip_price_punctuation,
    text_to_int,
)
from etl.connectors.hipoges_mapping import map_operation, map_property_type

# Detail URLs are `/<lang>/detail/<id>` or `/<lang>/<investment>/detail/<id>`,
# with an optional `/contact-received` or `/unavailable` suffix on the SAME
# id (grounded in the site's own Angular route table — see module
# docstring). `<id>` is the segment immediately after `detail/`, stopping at
# the next `/`, `?`, or `#` — never assumed to be numeric, since nothing in
# the route table constrains its shape. Reconfirmed live (issue #547): the
# owner's 4 real captures all matched the plain base case, id "RARE-04347".
_EXTERNAL_ID_RE = re.compile(r"/[a-z]{2}/(?:[^/]+/)?detail/([^/?#]+)", re.IGNORECASE)

# The real "similar properties" rail (RARE-04347 capture, issue #547) is the
# custom element `init-asset-detail-related-assets` (id="others"), NOT
# anything with a similar/related/recommend CLASS name — the class-based
# entries below matched ZERO elements on the real page. Every calibrated
# extractor scopes to the real per-section component tag first (which
# structurally excludes this element on its own); this list is a second,
# redundant layer of defense for the class-based FALLBACK paths only
# (`_price_from_dom`'s and `_photos`'s fallbacks, used when the primary
# component tag is itself missing).
_CONTAMINATION_SELECTORS: tuple[str, ...] = (
    "init-asset-detail-related-assets",
    "#others",
    '[class*="similar" i]',
    '[class*="related" i]',
    '[class*="recommend" i]',
)

# Fallback gallery-container guesses, used ONLY when the real
# `init-asset-detail-gallery` element (see `_photos`) is absent — e.g. a
# future redesign. Unverified against a real page beyond that one element;
# kept as a best-effort second attempt rather than a straight None.
_GALLERY_SELECTORS: tuple[str, ...] = (
    '[class*="gallery" i]',
    '[class*="carousel" i]',
    '[class*="slider" i]',
)

# Label keywords for `_feature_card_value` — matched against ANY span's text
# inside an `<init-feature-card>`, not a fixed position (see module
# docstring: the real page renders the energy-grade card's value/label
# spans in the opposite order between its mobile/desktop variants, so
# position-0 would have been wrong for that card and only accidentally
# right for these three).
_M2_LABEL_RE = re.compile(r"metros", re.IGNORECASE)
_ROOMS_LABEL_RE = re.compile(r"habitaci|dormitor|\bhabs\b", re.IGNORECASE)
_BATHS_LABEL_RE = re.compile(r"ba[ñn]o|aseo", re.IGNORECASE)

# \b after the optional "erencia" group matters: without it, "Ref" alone
# case-insensitively matches the START of common Spanish words like
# "reformado"/"reforma". Reconfirmed against the real page's exact text
# "Referencia: RARE-04347" (issue #547) — unchanged from the pre-#547 draft.
_REFERENCE_TEXT_RE = re.compile(
    r"\bRef(?:erencia)?\b:?\s*([A-Za-z0-9._-]+)", re.IGNORECASE
)

_LOCATION_ICON_ALT = "Location icon"


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _og_meta(soup: BeautifulSoup, property_name: str) -> str | None:
    el = soup.select_one(f'meta[property="{property_name}"]')
    if el is None:
        return None
    content = el.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None


def _title_from_dom(soup: BeautifulSoup) -> str | None:
    """The real `<h1>` inside `init-asset-detail-main-info` (issue #547).

    Replaces the pre-#547 OG-meta-only design: the real page's OG title is
    generic site branding ("Venta y alquiler de inmuebles al mejor precio |
    Hipoges"), not this listing's title — see module docstring."""
    container = soup.select_one("init-asset-detail-main-info") or soup
    h1 = container.select_one("h1")
    text = h1.get_text(strip=True) if h1 else None
    return text or None


def _description_from_dom(soup: BeautifulSoup) -> str | None:
    """The real description paragraph inside `init-asset-detail-description`
    (issue #547) — genuine per-listing marketing/occupancy text (e.g. "Esta
    propiedad se encuentra alquilada"), not the generic OG description."""
    container = soup.select_one("init-asset-detail-description .text-container")
    text = container.get_text(" ", strip=True) if container else None
    return text or None


def _price_from_dom(soup: BeautifulSoup) -> Decimal | None:
    """The real price: a `<span>` with the exact text "Precio", immediately
    followed by a sibling `<span>` holding the value (issue #547). No
    element on the real page carries a `price`/`precio` CSS class — the
    fallback below is an unconfirmed guess for a possible different
    template, kept only in case a future redesign drops the label span."""
    container = soup.select_one("init-asset-detail-main-info") or soup
    label = container.find(
        lambda tag: tag.name == "span" and tag.get_text(strip=True) == "Precio"
    )
    value_el = label.find_next_sibling("span") if label is not None else None
    if value_el is None:
        value_el = container.select_one('[class*="price" i], [class*="precio" i]')
    if value_el is None:
        return None
    text = value_el.get_text(" ", strip=True)
    digits = strip_price_punctuation(text)
    return _to_decimal(digits) if digits else None


def _feature_card_value(
    soup: BeautifulSoup, label_pattern: re.Pattern[str]
) -> int | None:
    """Read a numeric stat off an `<init-feature-card>` inside
    `init-asset-detail-features` (issue #547) — m², rooms, and bathrooms are
    each their own card, value and unit-label in separate sibling `<span>`s
    (never one "84 m2" text run, unlike the pre-#547 regex-over-body-text
    design). Matches the card by scanning ALL its span texts for
    `label_pattern`, then returns the first span that parses as a number —
    not a fixed position, since the real page's energy-grade card renders
    value/label in the opposite order across its mobile/desktop variants."""
    container = soup.select_one("init-asset-detail-features") or soup
    for card in container.select("init-feature-card"):
        texts = [
            s.get_text(strip=True)
            for s in card.find_all("span")
            if s.get_text(strip=True)
        ]
        if not texts or not any(label_pattern.search(t) for t in texts):
            continue
        for t in texts:
            value = text_to_int(t)
            if value is not None:
                return value
    return None


def _detail_row_value(soup: BeautifulSoup, label_text: str) -> str | None:
    """A label/value pair from the "Detalles del Inmueble" panel
    (`init-asset-detail-details`, issue #547) — each populated attribute is
    two sibling `<span>`s (label, value) inside a `div[class*="grid-cols-2"]`
    row. Only "Tipo de propiedad" and "Planta" were populated for the one
    real listing observed; every other row the panel can render (year
    built, cadastral reference, ...) is untested and not read here."""
    container = soup.select_one("init-asset-detail-details")
    if container is None:
        return None
    for row in container.select('div[class*="grid-cols-2"]'):
        spans = row.find_all("span", recursive=False)
        if len(spans) < 2:
            continue
        if spans[0].get_text(strip=True).casefold() == label_text.casefold():
            value = spans[1].get_text(strip=True)
            return value or None
    return None


def _location_from_dom(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    """(city, province) from the header location line (issue #547) — a
    `<span>` right after the geolocation-pin `<img alt="Location icon">`,
    scoped to `init-asset-detail-main-info` specifically because the same
    alt text is reused elsewhere on the page (an "EXPLORAR MAPA" button).
    Renders one combined "<municipio>, <provincia>" string — split on the
    first comma. Single observation: municipality-first ordering matches
    every other Spanish REO connector in this batch, not independently
    reconfirmed for Hipoges."""
    container = soup.select_one("init-asset-detail-main-info")
    if container is None:
        return None, None
    icon = container.select_one(f'img[alt="{_LOCATION_ICON_ALT}"]')
    if icon is None:
        return None, None
    span = icon.find_next_sibling("span")
    text = span.get_text(strip=True) if span else None
    if not text:
        return None, None
    if "," not in text:
        return text, None
    city, _, province = text.partition(",")
    return city.strip() or None, province.strip() or None


def _reference_code(soup: BeautifulSoup) -> str | None:
    container = soup.select_one("init-asset-detail-main-info") or soup
    text = container.get_text(" ", strip=True)
    match = _REFERENCE_TEXT_RE.search(text)
    return match.group(1) if match else None


# Set True only once selectors are validated against a real Hipoges capture.
# Flipped True by issue #547 (RARE-04347, 2026-08-21) — every field gated
# below now has real-page grounding; see module docstring for the full
# field-by-field writeup and D-111's amendment for the confidence summary.
# If a future redesign is suspected, flip this back to False rather than
# trust a selector against markup that may no longer match — "no data" is
# always safer than a plausible-looking wrong value silently reaching
# scoring (D-057), price history (D-098), or a hard filter (D-059).
_SELECTORS_CALIBRATED = True


class HipogesConnector(Connector):
    name = "hipoges"
    # Never crawls — capture-only (see module docstring). The rate limiter /
    # circuit breaker the base class configures are inert here since
    # scope_key() always returns None before either would be exercised. Same
    # posture as Idealista/Aliseda/Altamira.
    supports_discovery = False
    discovers_full_inventory = False

    def scope_key(self, scope: ConnectorScope) -> str | None:
        return None

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        raise ConnectorError(
            "hipoges discover: not supported — capture-only connector (see "
            "module docstring / D-075 / D-111). scope_key() returning None "
            "should have stopped the orchestrator from ever calling this."
        )

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        raise ConnectorError(
            "hipoges fetch_detail: not supported — this connector never "
            "makes a live network request (D-075: every sanctioned "
            "enumeration channel on realestate.hipoges.com returns an "
            "app-level 403). Listings arrive via POST /api/extension/capture, "
            "processed by etl/capture.py, which calls normalize() directly."
        )

    @staticmethod
    def external_id_from_url(url: str) -> str | None:
        match = _EXTERNAL_ID_RE.search(url)
        return match.group(1) if match else None

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        html = raw.raw.get("html", "")
        soup = BeautifulSoup(html, "html.parser")
        # Second-layer defense only — every calibrated extractor below scopes
        # to a specific real component tag first, which already structurally
        # excludes the "similar properties" rail (see module docstring and
        # `_CONTAMINATION_SELECTORS`'s own comment for why the OLD class-based
        # drop matched nothing on the real page).
        scoped_soup = scoped_node(soup, drop=_CONTAMINATION_SELECTORS)

        if _SELECTORS_CALIBRATED:
            # DOM-ONLY, no OG-meta fallback (Opus review, PR #657) — the OG
            # meta is not merely a weaker signal than the real <h1>/
            # description, it is KNOWN-HARMFUL: it is generic site branding
            # ("Venta y alquiler de inmuebles al mejor precio | Hipoges"),
            # and its "alquiler" substring made map_operation() below return
            # "rent" for what was a real 266.000EUR SALE listing whenever
            # the real <h1> hadn't rendered yet (a real, reachable capture
            # state: the extension's readySelectors gate is satisfied by
            # `main` alone, per browser-extension/detect.js, so an
            # unrendered <h1> can still pass capture). Feeding that fallback
            # into map_operation()/map_property_type() below is exactly the
            # "plausible-looking wrong data" the _SELECTORS_CALIBRATED gate
            # exists to prevent (D-057/D-098/D-059) — so unlike every other
            # calibrated field, there is NO fallback here: a missing DOM
            # node degrades straight to None, never to OG content.
            title = _title_from_dom(scoped_soup)
            description = _description_from_dom(scoped_soup)
            raw_type = first_present(
                lambda: _detail_row_value(scoped_soup, "Tipo de propiedad"),
                lambda: title,
                field="hipoges.property_type_source",
            )
            property_type = map_property_type(raw_type)
            operation = map_operation(title)
            current_price = _price_from_dom(scoped_soup)
            m2_built = _to_decimal(_feature_card_value(scoped_soup, _M2_LABEL_RE))
            rooms = _feature_card_value(scoped_soup, _ROOMS_LABEL_RE)
            bathrooms = _feature_card_value(scoped_soup, _BATHS_LABEL_RE)
            reference_code = _reference_code(scoped_soup)
            photo_urls = _photos(scoped_soup, raw.raw.get("url"))
            city, province = _location_from_dom(scoped_soup)
        else:
            title = _og_meta(soup, "og:title")
            description = _og_meta(soup, "og:description")
            property_type = None
            operation = None
            current_price = None
            m2_built = None
            rooms = None
            bathrooms = None
            reference_code = None
            photo_urls = ()
            city = None
            province = None

        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=raw.raw.get("url"),
            listing_kind="agency",  # Hipoges is a multi-fund REO servicer
            # portal — every listing is a serviced/bank-owned asset, never a
            # private seller (same as every other REO servicer connector).
            status="active",  # A captured page is one the owner was just
            # viewing — "active" is the only status this connector can
            # honestly assert (it never revisits to detect a status change).
            # Same rule as idealista.py / aliseda.py / altamira.py.
            current_price=current_price,
            description=description,
            photo_urls=photo_urls,
            contact_raw=None,  # REO portal: no private-seller contact to
            # store, and owner-contact PII must never be persisted. (The
            # real page also has a call-center "O llámenos" tel: link —
            # Hipoges' own number, not a private seller's — deliberately
            # never read either.)
            reference_code=reference_code,
            address=None,  # Still not extractable: the page has no
            # street-level address field at all, only city/province (see
            # `city`/`province` below) plus an urbanización/development
            # name folded into the title text.
            lat=None,
            lon=None,
            property_type=property_type,
            m2_built=m2_built,
            m2_useful=None,
            rooms=rooms,
            bathrooms=bathrooms,
            floor=None,  # Observed on the real page ("Planta: 2da Planta")
            # but NOT extracted: parsing a free-text Spanish ordinal into a
            # floor number is exactly the "don't fabricate precision" trap
            # (docs/skills/connectors.md) on a single sample — left for a
            # future task with more listings to calibrate against.
            has_elevator=None,
            year_built=None,
            energy_rating=None,  # Observed on the real page (a "G" grade in
            # a feature card) but NOT extracted: this project has exactly
            # one sample and no way yet to tell a real grade apart from a
            # "no certificate" placeholder (see altamira.py's "en trámite"
            # precedent) — left for a future task.
            city=city,
            province=province,
            postal_code=None,
            m2_plot=None,
            features=(),
            operation=operation,
            cadastral_ref=None,
            raw_extra={
                "capture_source": "browser-extension",
                # Provenance the whole point of D-111 leans on: this row
                # arrived via guided extension capture, not an automated
                # fetch.
                "capture_portal": "hipoges",
                "title": title,
                "selectors_calibrated": _SELECTORS_CALIBRATED,
            },
        )


def _photos(soup: BeautifulSoup, page_url: str | None) -> tuple[str, ...]:
    """Real gallery photo URLs, absolute, deduped, in the order the `<img>`
    tags appear in whatever HTML is passed in (issue #547).

    That is document order of the INPUT markup, not necessarily the site's
    own canonical photo ordering — the real RARE-04347 capture's gallery
    repeats each image (a desktop/mobile duplicate rendering pattern, same
    shape as the `init-feature-card` duplication documented on
    `_feature_card_value`) in the sequence "second image, third image,
    first image, second image, ..."; only the FIRST occurrence of each
    unique URL survives dedup, so the real output order is 2nd/3rd/1st, not
    1st/2nd/3rd. The committed fixture (`hipoges_detail_RARE-04347.html`)
    simplifies this to a single, numerically-ordered rendering per photo
    for readability — a reconstruction in this one respect, not a literal
    copy of the real tag order (see the fixture's own header comment).

    The real subject-property gallery is the `init-asset-detail-gallery`
    custom element — the "similar properties" rail's photos live in a
    SIBLING element (`init-asset-detail-related-assets`), never inside this
    one, so no contamination guard is needed here beyond selecting the
    right container. Skips any `src` containing "/assets/" — the gallery's
    own photo-count badge icon (`/assets/icons/asset-detail/camera.webp`)
    lives inside the same container as the real photos and is not a
    listing image. Falls back to the pre-#547 class-based container guesses
    only if the real element is ever absent (a possible future redesign) —
    unverified beyond this single capture.
    """
    from urllib.parse import urljoin

    if not page_url:
        return ()
    container = soup.select_one("init-asset-detail-gallery")
    if container is None:
        for selector in _GALLERY_SELECTORS:
            container = soup.select_one(selector)
            if container is not None:
                break
    if container is None:
        return ()
    ordered: list[str] = []
    seen: set[str] = set()
    for img in container.select("img[src]"):
        src = img.get("src")
        if not isinstance(src, str) or not src.strip():
            continue
        src = src.strip()
        if "/assets/" in src:
            continue
        absolute = urljoin(page_url, src)
        if absolute not in seen:
            seen.add(absolute)
            ordered.append(absolute)
    return tuple(ordered)
