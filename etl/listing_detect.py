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
# `listing`. The two are mutually exclusive by construction (see the per-portal
# notes in detect.js) — a detail URL never matches `listing` and vice versa.
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
        "detail": re.compile(r"^/[a-z]{2}/(?:[^/]+/)?detail/[^/]+", re.IGNORECASE),
        # Search/listing routes are `/<lang>/(sale|rent)/<typology>/<country>/…`
        # or the `/<lang>/(area|countries|map|point)/…` variants — never a
        # `/detail/` segment, so detail and listing stay mutually exclusive.
        # The `sale`/`rent` operation tokens are inferred from the site's own
        # public i18n key names (assets/i18n/es.json), not directly observed
        # on a live URL — unconfirmed, see hipoges.py's module docstring.
        "listing": re.compile(
            r"^/[a-z]{2}/(?:(?:sale|rent)/|area/|countries/|map/|point/)",
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
