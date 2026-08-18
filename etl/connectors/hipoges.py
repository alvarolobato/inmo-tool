"""Hipoges connector — capture-only, no live network fetch (issue #75/#207).

═══════════════════════════════════════════════════════════════════════════
  CAPTURE-ONLY. SELECTORS ARE UNVALIDATED DRAFTS — NO REAL CAPTURE EXISTS.
  See D-111 (docs/decisions/D-111-hipoges-capture-only.md) for the
  calibration gate this connector is under, and the follow-up issue it
  links for the owner's first real capture.
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
  URL SHAPE: grounded in the site's own public Angular route table.
──────────────────────────────────────────────────────────────────────────
Unlike Aliseda/Altamira (whose detail-URL shape was originally a pure
guess), Hipoges' detail-URL shape is NOT a guess: `main-*.js` and its lazy
`chunk-*.js` siblings are the client-side JS bundle the Angular app itself
ships to every visitor's browser (a public static asset, not an API call —
the same thing "view source" gets you). Its literal `path:` route table
includes, among others:

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
constrains it. This is the one part of this connector grounded in the
site's actual code rather than a guess.

──────────────────────────────────────────────────────────────────────────
  DOM EXTRACTION: genuinely a draft. No real capture exists (chicken-and-egg
  problem, see D-111) — the detail page is Angular-rendered, so a plain GET
  returns the empty shell above, and the browser extension can't capture a
  host it doesn't support until THIS PR ships. Every DOM/CSS selector below
  is therefore a best-effort guess, explicitly marked DRAFT, and MUST be
  revalidated against the owner's first real capture (see the calibration
  issue linked from D-111). A selector that misses degrades to None — never
  a fabricated value (docs/skills/connectors.md "don't fabricate precision").

  GATED, NOT JUST LABELED (Opus review, PR #548, C2): `selectors_calibrated`
  in `raw_extra` is a MODULE CONSTANT (`_SELECTORS_CALIBRATED`), not just an
  observational flag — while it is False, `normalize()` forces every
  draft-derived field (price, m², rooms, bathrooms, reference code, photos,
  property_type, operation) to None/(), full stop, regardless of what the
  draft extractors below would have found. Only `external_id`/`url`/
  `status`/`listing_kind` and the OpenGraph `title`/`description` are ever
  populated today. This is deliberate: an uncalibrated guess that never
  writes a number is recoverable; one that writes a plausible-looking wrong
  price is not (it can drive D-057's below-market boost, get adopted into
  D-098's price history, or wrongly exclude/include a listing from a D-059
  hard filter — all silently, with no SQL query making it visible). The
  draft extractor functions stay fully implemented and unit-tested
  (`TestDraftExtractors` in test_connector_hipoges.py) so flipping
  `_SELECTORS_CALIBRATED` to True — once #547 lands real selectors — is a
  one-line change, not a rewrite.

  What grounding exists beyond the URL shape:
    - The home page carries rich OpenGraph/`<meta>` tags (title, description,
      canonical, hreflang) — plausible (not confirmed) that a detail page
      does too, so meta tags are tried as a first-choice source, same as
      Altamira's `_og_meta` fallback.
    - Hipoges' own public `assets/i18n/es.json` (a static translation
      bundle, not the walled asset API) confirms the Spanish property-type
      vocabulary used elsewhere in this project's mapping tables ("Piso",
      "Casa", "Garaje", "Trastero", "Terreno", "Oficina", "Edificio",
      "Apartamento") is genuinely part of this site's vocabulary — see
      hipoges_mapping.py.
    - Price/surface/room/bath extraction has NO grounding at all: no known
      CSS class, no known JSON-LD block (none was observed on the public
      shell, but the shell never renders listing content to check). A
      best-effort text-mining fallback (regex over the rendered body text
      for "<n> m²" / "<n> hab" / "<n> baño" patterns) is used instead of a
      selector guess, with the SAME "similar properties" neighbour-bleed
      risk documented in etl/connectors/extraction.py's `scoped_text`
      docstring (Vivantial/Solvia/Servihabitat all hit this bug for real) —
      mitigated only by dropping elements whose class/id name plausibly
      marks them as a carousel/related-listings block, which is itself an
      unverified guess. Photo extraction is similarly best-effort (any
      `<img>` inside a plausibly-named gallery/carousel/slider container).
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
from etl.connectors.extraction import scoped_node, strip_price_punctuation, text_to_int
from etl.connectors.hipoges_mapping import map_operation, map_property_type

# Detail URLs are `/<lang>/detail/<id>` or `/<lang>/<investment>/detail/<id>`,
# with an optional `/contact-received` or `/unavailable` suffix on the SAME
# id (grounded in the site's own Angular route table — see module
# docstring). `<id>` is the segment immediately after `detail/`, stopping at
# the next `/`, `?`, or `#` — never assumed to be numeric, since nothing in
# the route table constrains its shape.
_EXTERNAL_ID_RE = re.compile(r"/[a-z]{2}/(?:[^/]+/)?detail/([^/?#]+)", re.IGNORECASE)

# Best-effort "this element is plausibly not the subject property" guess,
# used to scope out contaminating subtrees before text-mining for
# surface/room/bath figures. Unverified against a real page — see module
# docstring's "no grounding at all" note.
#
# Deliberately does NOT include "carousel": the site's own MAIN photo
# gallery is very plausibly implemented as a carousel too (Angular apps
# routinely name their primary image slider `*-carousel`), and on a real
# page that is the single most likely piece of markup this connector would
# see. Treating "carousel" as contamination silently zeroed the whole
# gallery via `_GALLERY_SELECTORS` below (empty result on any carousel-named
# gallery — the synthetic fixture didn't catch it because its gallery is
# conveniently named "asset-gallery", not "*-carousel") — Opus review, PR
# #548 (C1). "similar"/"related"/"recommend" are unambiguous enough to keep.
_CONTAMINATION_SELECTORS: tuple[str, ...] = (
    '[class*="similar" i]',
    '[class*="related" i]',
    '[class*="recommend" i]',
)

# Best-effort gallery/carousel container guesses for photo harvesting. Runs
# against the contamination-SCOPED tree (`scoped_node(soup, drop=
# _CONTAMINATION_SELECTORS)` in normalize()), so a "similar properties" rail
# is already gone by the time this looks for "carousel" — it is safe for
# this list to include "carousel" even though `_CONTAMINATION_SELECTORS`
# above deliberately does not.
_GALLERY_SELECTORS: tuple[str, ...] = (
    '[class*="gallery" i]',
    '[class*="carousel" i]',
    '[class*="slider" i]',
)

_M2_RE = re.compile(r"(\d[\d.,]*)\s*m\s*2|(\d[\d.,]*)\s*m²", re.IGNORECASE)
_ROOMS_RE = re.compile(
    r"(\d+)\s*(?:hab\.?|habitaci[oó]n(?:es)?|dormitor)", re.IGNORECASE
)
_BATHS_RE = re.compile(r"(\d+)\s*(?:ba[ñn]o(?:s)?|aseo(?:s)?)", re.IGNORECASE)
# \b after the optional "erencia" group matters: without it, "Ref" alone
# case-insensitively matches the START of common Spanish words like
# "reformado"/"reforma" (a real bug caught by the synthetic fixture's
# description text, which happens to contain "reformado" right before the
# real "Referencia:" label — see test_connector_hipoges.py).
_REFERENCE_TEXT_RE = re.compile(
    r"\bRef(?:erencia)?\b:?\s*([A-Za-z0-9._-]+)", re.IGNORECASE
)


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


def _first_match_decimal(pattern: re.Pattern[str], text: str) -> Decimal | None:
    m = pattern.search(text)
    if not m:
        return None
    group = next((g for g in m.groups() if g), None)
    return _to_decimal(text_to_int(group)) if group else None


def _first_match_int(pattern: re.Pattern[str], text: str) -> int | None:
    m = pattern.search(text)
    return int(m.group(1)) if m else None


def _price_from_dom(soup: BeautifulSoup) -> Decimal | None:
    """Best-effort price: a generic `[class*="price"]`/`[class*="precio"]`
    element, in document order. DRAFT — unverified selector guess (module
    docstring's "no grounding at all" note)."""
    el = soup.select_one('[class*="price" i], [class*="precio" i]')
    if el is None:
        return None
    text = el.get_text(" ", strip=True)
    digits = strip_price_punctuation(text)
    return _to_decimal(digits) if digits else None


# Set True only once selectors are validated against a real Hipoges capture
# (issue #547). While False — today, and for every row this connector has
# ever emitted — every draft-derived field below is forced to None/() rather
# than writing an unvalidated guess into scoring (D-057's below-market
# boost), price history (D-098's price-move adoption), or a hard filter
# (D-059). A first-match `[class*="price"]` guess landing "top of the feed"
# as a fabricated bargain is exactly the failure this gate exists to prevent
# (Opus review, PR #548, C2). The draft extractor functions below
# (`_price_from_dom`, `_photos`, the regex helpers, `hipoges_mapping.
# map_property_type`/`map_operation`) stay fully implemented and unit-tested
# (see `TestDraftExtractors` in test_connector_hipoges.py) so flipping this
# one constant is the entire #547 follow-up, not a rewrite.
_SELECTORS_CALIBRATED = False


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
        # Every DOM read below (except the head-level OpenGraph fallbacks,
        # which live outside <body> and can't carry a neighbour's figures)
        # goes through the SAME contamination-scoped copy, so a "similar
        # properties" carousel can never leak its price/surface/photos into
        # the subject property — see extraction.py's scoped_text docstring
        # for why this exact bug class (Vivantial/Solvia/Servihabitat) is
        # worth guarding against even on a first draft.
        # extraction.py's scoped_node — not a hand-rolled copy.copy — is
        # the SAME shared helper the neighbour-bleed docstring above
        # points at; reuse it rather than reimplement it (Opus review, PR
        # #548, N1).
        scoped_soup = scoped_node(soup, drop=_CONTAMINATION_SELECTORS)
        body_text = scoped_soup.get_text(" ", strip=True)

        # ── title / description: OpenGraph meta ONLY. ──────────────────────
        # The one DOM source actually grounded (the home page carries rich OG
        # tags; a detail page plausibly does too — see module docstring). No
        # h1/class-based DOM guess here (Opus review, PR #548, C2) — those
        # stay exactly as uncertain as the gated fields below, so they don't
        # get a pass just because they're text rather than a number.
        title = _og_meta(soup, "og:title")
        description = _og_meta(soup, "og:description")

        # ── everything else is a DRAFT selector — gated on calibration. ────
        # See `_SELECTORS_CALIBRATED`'s module-level docstring: until a real
        # capture confirms these, every one of these fields is None/() so an
        # unvalidated guess never reaches scoring/price-history/filters.
        if _SELECTORS_CALIBRATED:
            property_type = map_property_type(title)
            operation = map_operation(title)
            current_price = _price_from_dom(scoped_soup)
            m2_built = _first_match_decimal(_M2_RE, body_text)
            rooms = _first_match_int(_ROOMS_RE, body_text)
            bathrooms = _first_match_int(_BATHS_RE, body_text)
            ref_match = _REFERENCE_TEXT_RE.search(body_text)
            reference_code = ref_match.group(1) if ref_match else None
            photo_urls = _photos(scoped_soup, raw.raw.get("url"))
        else:
            property_type = None
            operation = None
            current_price = None
            m2_built = None
            rooms = None
            bathrooms = None
            reference_code = None
            photo_urls = ()

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
            # store, and owner-contact PII must never be persisted.
            reference_code=reference_code,
            address=None,  # Not extractable without a real capture — the
            # detail URL carries no location segments (see module docstring's
            # route-table note), and no address selector is grounded.
            lat=None,
            lon=None,
            property_type=property_type,
            m2_built=m2_built,
            m2_useful=None,
            rooms=rooms,
            bathrooms=bathrooms,
            floor=None,
            has_elevator=None,
            year_built=None,
            energy_rating=None,
            city=None,
            province=None,
            postal_code=None,
            m2_plot=None,
            features=(),
            operation=operation,
            cadastral_ref=None,
            raw_extra={
                "capture_source": "browser-extension",
                # Provenance the whole point of D-111 leans on: this row
                # arrived via guided extension capture, not an automated
                # fetch, and every extracted field above is an UNVALIDATED
                # draft pending the owner's first real capture.
                "capture_portal": "hipoges",
                "title": title,
                "selectors_calibrated": _SELECTORS_CALIBRATED,
            },
        )


def _photos(soup: BeautifulSoup, page_url: str | None) -> tuple[str, ...]:
    """Best-effort gallery photo URLs, absolute, deduped, in document order.

    DRAFT: no known CDN/gallery markup for Hipoges. Scans plausibly-named
    gallery/carousel/slider containers for `<img>` tags and resolves their
    `src` against the page URL. Empty tuple (never a guessed/fabricated URL)
    if no such container is found or the page URL is missing to resolve
    against.
    """
    from urllib.parse import urljoin

    if not page_url:
        return ()
    ordered: list[str] = []
    seen: set[str] = set()
    for selector in _GALLERY_SELECTORS:
        for container in soup.select(selector):
            for img in container.select("img[src]"):
                src = img.get("src")
                if not isinstance(src, str) or not src.strip():
                    continue
                absolute = urljoin(page_url, src.strip())
                if absolute not in seen:
                    seen.add(absolute)
                    ordered.append(absolute)
    return tuple(ordered)
