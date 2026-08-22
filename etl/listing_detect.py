"""Server-side mirror of the browser extension's listing-vs-detail URL
detection (browser-extension/detect.js, issues #254/#262).

The extension classifies a page as a *listing/search* page (many properties,
each linking to its own detail page) or a *detail* page (one property) purely
by URL shape, per portal. Issue #292 needs the SAME classification server-side:
when the owner captures a search/listing page and its HTML lands in
`extension_capture`, the poller must recognise it as a listing page and route
it toward the batch-capture / mine-results path (#262/#290) — a clean outcome —
instead of marking it `failed` with "no capture-capable connector".

This module is the ONE server-side copy of that logic. It is deliberately a
*direct* mirror of detect.js's `PORTALS` table and its `detailPortalForUrl` /
`listingPortalForUrl` helpers — the regexes here MUST stay byte-for-byte
equivalent to the JS ones. When a portal's URL grammar changes, update BOTH
detect.js and this module (the tests in test_listing_detect.py assert the same
cases the JS suite in dashboard/__tests__/extension-detect.test.ts asserts).

Pure: no DB, no network, no HTML parsing. The HTML harvesting that turns a
listing page into a set of detail URLs lives in etl/capture.py (it needs
BeautifulSoup + the worklist match-key), and calls `detail_portal_for_url`
here to filter the anchors it finds.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

# Mirror of detect.js `PORTALS`. Each entry: the host suffix that identifies the
# portal, plus a compiled detail-path regex and listing-path regex. A path is a
# DETAIL page iff it matches `detail`; a SEARCH/RESULTS page iff it matches
# `listing`. For idealista/aliseda/altamira the two are mutually exclusive by
# construction (see the per-portal notes in detect.js) — a detail URL never
# matches `listing` and vice versa. Hipoges is the ONE exception: a
# synthetic path like `/es/map/detail/999` matches both (see its own entry
# below) — every consumer here resolves detail first
# (`detail_portal_for_url`/`listing_portal_for_url` are independent calls,
# and callers that need one classification, e.g. etl/capture.py, check
# detail before listing), and detect.js agrees byte-for-byte, so this is a
# documented, harmless overlap, not an invariant every portal upholds.
_PORTALS: list[dict[str, object]] = [
    {
        "portal": "idealista",
        "host_suffix": "idealista.com",
        # Idealista detail URLs are `/inmueble/<numeric-id>/`.
        "detail": re.compile(r"^/inmueble/\d+/?$"),
        # Search pages are `/(venta|alquiler)-<something>` or the `/areas/…`
        # geo-search variant.
        "listing": re.compile(r"^/(venta|alquiler)-[a-z]|^/areas/(venta|alquiler)-"),
    },
    {
        "portal": "aliseda",
        "host_suffix": "alisedainmobiliaria.com",
        # Aliseda detail URLs are `/inmueble/<id>` (id can be an alnum slug).
        "detail": re.compile(r"^/inmueble/[^/]+"),
        # Search pages live under `/comprar…` / `/alquilar…` / `/alquiler…`.
        "listing": re.compile(r"^/(comprar|alquilar|alquiler)"),
    },
    {
        "portal": "altamira",
        "host_suffix": "altamirainmuebles.com",
        # Detail: `/venta-de-<tipo>/…/<numeric-id>[/<photo-index>]`. The `-de-`
        # type prefix AND a trailing numeric id are the discriminators.
        "detail": re.compile(r"^/(?:venta|alquiler)-de-[^/]+/.+/\d+(?:/\d+)?/?$"),
        # Search: `/venta-viviendas/…` / `/alquiler-locales/…` — a `-<plural>`
        # root WITHOUT the `-de-` type prefix (negative lookahead).
        "listing": re.compile(r"^/(?:venta|alquiler)-(?!de-)[a-z]+(?:/|$)"),
    },
    {
        "portal": "hipoges",
        "host_suffix": "realestate.hipoges.com",
        # Grounded in the site's own public Angular route table (main-*.js /
        # chunk-*.js — a static client bundle every visitor's browser
        # downloads, not an API call). Detail: `/<lang>/detail/<id>` or
        # `/<lang>/<investment>/detail/<id>`, optionally suffixed
        # `/contact-received` or `/unavailable` on the SAME id — see
        # hipoges.py's module docstring. DOM extraction beyond this URL shape
        # is an unvalidated draft (D-111).
        # TWO independent narrowings (issue #701, review L2).
        #
        # 1. The `:investment` slot excludes `blog`. Hipoges' own home page
        #    links six blog articles as `es/blog/detail/<slug>` (VERIFIED in
        #    production `extension_capture` id 3577), and the wildcard was
        #    classifying every one of them as a listing-detail page. Deny-list
        #    rather than allow-list for the same reason the shape-based listing
        #    regex below exists: an allow-list of asset categories we have
        #    never confirmed would make a real URL silently vanish (D-115).
        #
        # 2. A deny-list closes a HOLE, not a CLASS — `/es/news/detail/…` would
        #    still pass — so the `:id` slot must contain at least one DIGIT.
        #    Every non-asset `detail/` link observed on this portal is a prose
        #    slug; every asset reference observed carries digits (RARE-04347,
        #    FRRE-20005, REGA-06247, GTRE-01142, … off the CDN paths of ids
        #    3576/3577/3617). Deliberately NOT the harvest's stricter
        #    `[a-z]{4}-\d{4,6}`: there a too-narrow shape merely yields no URL
        #    and is counted, here it would make a real advert vanish silently.
        #    See detect.js's isDetailPath for the full argument.
        #
        # MUST stay in lockstep with detect.js's isDetailPath (D-069).
        "detail": re.compile(
            r"^/[a-z]{2}/(?:(?!blog/)[^/]+/)?detail/(?=[^/?#]*\d)[^/?#]+",
            re.IGNORECASE,
        ),
        # Search/listing routes are `/<lang>/<operation>/<typology>/<country>/
        # <town>[/<features>]` (5+ path segments after the domain) or the
        # `/<lang>/(area|countries|map|point)/…` variants.
        #
        # issue #561 review round 2 (the owner's real navigated URL,
        # `/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla`, went
        # unrecognised): this used to hard-code `(sale|rent)` as the ONLY
        # accepted operation tokens, guessed from the wrong i18n axis (see
        # dashboard/lib/search-url/portals/hipoges.ts's module docstring for
        # the full trace — the real operation code is `venta`/`alquiler`,
        # confirmed from the public bundle, and even that is not guaranteed
        # exhaustive). Enumerating tokens here made the SAME mistake B2 made
        # in the search-URL parser: a real URL using a token this regex
        # didn't happen to allow-list simply vanished. This now matches the
        # route's SHAPE instead — any two non-"detail" segments (operation,
        # typology) followed by at least two more segments (country, town) —
        # so a future vocabulary surprise can't silently make the portal
        # unreachable again.
        #
        # The negative lookaheads on the first two segments are what keep
        # this from swallowing a detail URL: `/es/detail/999` puts "detail"
        # in the OPERATION position (excluded), `/es/<investment>/detail/
        # <id>[/…]` puts it in the TYPOLOGY position (excluded) — both of
        # `listing_detect.py`'s two detail shapes are covered. This is
        # STRICTER than a plain shape match would be, not looser.
        #
        # NOTE this is still not strictly mutually exclusive with `detail`
        # above for the LITERAL `area|countries|map|point` markers: a path
        # like `/es/map/detail/999` matches both (the `map` marker fires, and
        # `detail` fires too since `:investment` is unconstrained there) —
        # unchanged from the original Opus review (PR #548, N4) finding,
        # harmless in practice since every consumer here resolves detail
        # first. The shape-based branch added here does NOT introduce any
        # new instance of that overlap — it structurally excludes "detail".
        "listing": re.compile(
            r"^/[a-z]{2}/(?:"
            r"(?:area|countries|map|point)(?:/|$)"
            r"|(?!detail(?:/|$))[^/?#]+/(?!detail(?:/|$))[^/?#]+/[^/?#]+/[^/?#]+"
            r")",
            re.IGNORECASE,
        ),
    },
]


def _host_of(url: str) -> str | None:
    """Lowercased hostname with leading `www.` stripped, or None for a
    non-http(s) URL or an unparseable one. Mirrors detect.js's guard that
    rejects `javascript:`/`data:` URLs before any host match."""
    try:
        parsed = urlparse(str(url).strip())
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").lower().removeprefix("www.")
    return host or None


def _portal_config_for_host(host: str) -> dict[str, object] | None:
    """The portal config whose host suffix matches `host` (exact or
    subdomain), or None. Mirrors detect.js `portalConfigForHost`."""
    h = host.lower().removeprefix("www.")
    for cfg in _PORTALS:
        suffix = str(cfg["host_suffix"])
        if h == suffix or h.endswith("." + suffix):
            return cfg
    return None


def _path_of(url: str) -> str | None:
    try:
        return urlparse(str(url).strip()).path
    except ValueError:
        return None


def detail_portal_for_url(url: str) -> str | None:
    """The portal name for which `url` is a listing-DETAIL page, or None.
    None for search/results/home pages, unsupported hosts and non-http(s).
    Mirrors detect.js `detailPortalForUrl`."""
    host = _host_of(url)
    if host is None:
        return None
    cfg = _portal_config_for_host(host)
    if cfg is None:
        return None
    path = _path_of(url)
    if path is None:
        return None
    detail: re.Pattern[str] = cfg["detail"]  # type: ignore[assignment]
    return str(cfg["portal"]) if detail.search(path) else None


def is_detail_url(url: str) -> bool:
    """True iff `url` is a supported listing-detail page."""
    return detail_portal_for_url(url) is not None


def listing_portal_for_url(url: str) -> str | None:
    """The portal name for which `url` is a SEARCH / RESULTS listing page, or
    None. None for detail pages, home pages, unsupported hosts and non-http(s).
    Mirrors detect.js `listingPortalForUrl`."""
    host = _host_of(url)
    if host is None:
        return None
    cfg = _portal_config_for_host(host)
    if cfg is None:
        return None
    path = _path_of(url)
    if path is None:
        return None
    listing: re.Pattern[str] = cfg["listing"]  # type: ignore[assignment]
    return str(cfg["portal"]) if listing.search(path) else None


def is_listing_url(url: str) -> bool:
    """True iff `url` is a supported search/results listing page."""
    return listing_portal_for_url(url) is not None
