"""Unit tests for etl/listing_detect.py — the server-side mirror of the
browser extension's listing-vs-detail URL detection (issue #292).

These cases are the SAME ones asserted by the JS suite in
dashboard/__tests__/extension-detect.test.ts (detailPortalForUrl /
listingPortalForUrl). Keeping the two tables in lockstep is how we prove the
server mirror never drifts from detect.js's classification.
"""

from __future__ import annotations

import pytest

from etl.listing_detect import (
    detail_portal_for_url,
    is_detail_url,
    is_listing_url,
    listing_portal_for_url,
)

_DETAIL_CASES: list[tuple[str, str | None]] = [
    # Idealista: /inmueble/<numeric-id>[/] only.
    ("https://www.idealista.com/inmueble/106387165/", "idealista"),
    ("https://www.idealista.com/inmueble/106387165", "idealista"),
    ("https://idealista.com/inmueble/1/", "idealista"),
    # Idealista non-detail pages → None.
    ("https://www.idealista.com/", None),
    ("https://www.idealista.com/venta-viviendas/madrid-madrid/", None),
    ("https://www.idealista.com/areas/venta-viviendas/", None),
    ("https://www.idealista.com/inmueble/", None),
    ("https://www.idealista.com/inmueble/not-numeric/", None),
    # Aliseda: /inmueble/<id> where id may be an alphanumeric slug.
    ("https://www.alisedainmobiliaria.com/inmueble/ANT1", "aliseda"),
    ("https://www.alisedainmobiliaria.com/inmueble/ANT1/", "aliseda"),
    (
        "https://www.alisedainmobiliaria.com/inmueble/ANT1?utm_source=x#gallery",
        "aliseda",
    ),
    ("https://alisedainmobiliaria.com/inmueble/piso-antequera-123", "aliseda"),
    # Aliseda non-detail pages → None.
    ("https://www.alisedainmobiliaria.com/", None),
    ("https://www.alisedainmobiliaria.com/comprar/vivienda/malaga", None),
    ("https://www.alisedainmobiliaria.com/inmueble", None),
    # Altamira: /venta-de-<tipo>/…/<numeric-id>[/<photo-index>]. Long URLs on
    # one line each — implicit concatenation inside a list literal is an easy
    # forgotten-comma trap (ruff ISC004), and default ruff enforces no line cap.
    (
        "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1",
        "altamira",
    ),
    (
        "https://www.altamirainmuebles.com/venta-de-casa/murcia/alhama-de-murcia/segunda-mano/9186-1004-pe0001/375864/1",
        "altamira",
    ),
    (
        "https://www.altamirainmuebles.com/alquiler-de-piso/madrid/madrid/segunda-mano/9186_2002_PE0001/400111?utm=x#foto",
        "altamira",
    ),
    # Altamira non-detail pages → None.
    ("https://www.altamirainmuebles.com/", None),
    ("https://www.altamirainmuebles.com/venta-viviendas/cualquier-provincia", None),
    ("https://www.altamirainmuebles.com/venta-viviendas/pontevedra", None),
    ("https://www.altamirainmuebles.com/inmueble/ABC123", None),
    # Hipoges: /<lang>/detail/<id> or /<lang>/<investment>/detail/<id>,
    # optionally suffixed /contact-received or /unavailable on the SAME id —
    # grounded in the site's own public Angular route table (D-111).
    ("https://realestate.hipoges.com/es/detail/12345", "hipoges"),
    ("https://realestate.hipoges.com/es/detail/12345/contact-received", "hipoges"),
    ("https://realestate.hipoges.com/es/detail/12345/unavailable", "hipoges"),
    ("https://realestate.hipoges.com/es/npl/detail/ABC-123", "hipoges"),
    ("https://realestate.hipoges.com/pt/detail/12345?utm=x#foto", "hipoges"),
    # Hipoges non-detail pages → None.
    ("https://realestate.hipoges.com/", None),
    ("https://realestate.hipoges.com/es", None),
    ("https://realestate.hipoges.com/es/sale/flat/spain/madrid", None),
    ("https://realestate.hipoges.com/es/detail", None),
    # Issue #701: Hipoges' own home page links six blog articles through the
    # `:investment` slot as `es/blog/detail/<slug>` (production capture id
    # 3577). The wildcard used to classify every one of them as an advert.
    (
        "https://realestate.hipoges.com/es/blog/detail/pisos-en-alcala-de-henares-oportunidades",
        None,
    ),
    ("https://realestate.hipoges.com/pt/blog/detail/algum-artigo", None),
    # Unsupported host → None even on a detail-shaped path.
    ("https://www.fotocasa.es/inmueble/123/", None),
    ("https://example.com/inmueble/123/", None),
    (
        "https://hipoges.com/es/detail/12345",
        None,
    ),  # corporate domain, not the real-estate host
    # Non-http(s) / garbage → None.
    ("javascript://idealista.com/inmueble/1/%0aalert(1)", None),
    ("not a url", None),
    ("", None),
]

_LISTING_CASES: list[tuple[str, str | None]] = [
    # Idealista search/results pages → listing.
    ("https://www.idealista.com/venta-viviendas/madrid-madrid/", "idealista"),
    ("https://www.idealista.com/alquiler-viviendas/barcelona-barcelona/", "idealista"),
    ("https://www.idealista.com/venta-locales/valencia/", "idealista"),
    (
        "https://www.idealista.com/areas/venta-viviendas/con-precio-hasta_200000/",
        "idealista",
    ),
    # Idealista detail / home / bare → not a listing.
    ("https://www.idealista.com/inmueble/106387165/", None),
    ("https://www.idealista.com/", None),
    # Aliseda results routes → listing (both the old `/comprar/…` and the real
    # `/comprar-viviendas/…` roots, per #296/#318).
    ("https://www.alisedainmobiliaria.com/comprar/vivienda/malaga", "aliseda"),
    ("https://www.alisedainmobiliaria.com/alquilar/vivienda/madrid", "aliseda"),
    (
        "https://www.alisedainmobiliaria.com/comprar-viviendas/pisos/andalucia/malaga?hab=2",
        "aliseda",
    ),
    ("https://www.alisedainmobiliaria.com/alquiler-viviendas/pisos/madrid", "aliseda"),
    ("https://www.alisedainmobiliaria.com/comprar", "aliseda"),
    # Aliseda detail / home → not a listing.
    ("https://www.alisedainmobiliaria.com/inmueble/ANT1", None),
    ("https://www.alisedainmobiliaria.com/", None),
    # Altamira search/results routes → listing.
    (
        "https://www.altamirainmuebles.com/venta-viviendas/cualquier-provincia",
        "altamira",
    ),
    ("https://www.altamirainmuebles.com/venta-viviendas/pontevedra", "altamira"),
    ("https://www.altamirainmuebles.com/alquiler-viviendas/madrid", "altamira"),
    # Altamira detail / home → not a listing.
    (
        "https://www.altamirainmuebles.com/venta-de-atico/pontevedra/sanxenxo/segunda-mano/9186_1001_PE0001/375859/1",
        None,
    ),
    ("https://www.altamirainmuebles.com/", None),
    # Hipoges search/results routes → listing. Shape-based (issue #561 review
    # round 2), not a token allow-list — an arbitrary non-"detail" operation
    # token still matches, on purpose (a future vocabulary surprise must not
    # make the portal unreachable again).
    ("https://realestate.hipoges.com/es/sale/flat/spain/madrid", "hipoges"),
    (
        "https://realestate.hipoges.com/es/rent/house/spain/malaga/features",
        "hipoges",
    ),
    ("https://realestate.hipoges.com/es/area/sale/flat/spain", "hipoges"),
    ("https://realestate.hipoges.com/es/countries/sale/flat/spain", "hipoges"),
    ("https://realestate.hipoges.com/es/map/sale/flat/spain/madrid", "hipoges"),
    ("https://realestate.hipoges.com/es/point/sale/flat/spain/10", "hipoges"),
    # The owner's OWN real navigated URL (issue #561 review round 2) — went
    # unrecognised under the old `(sale|rent)` allow-list because the real
    # operation code is `venta`, not `sale`. Ground truth from the live site;
    # worth more than any synthetic case above.
    (
        "https://realestate.hipoges.com/es/venta/pisos-y-casas/espana/dos-hermanas_sevilla",
        "hipoges",
    ),
    # Hipoges detail / home → not a listing.
    ("https://realestate.hipoges.com/es/detail/12345", None),
    ("https://realestate.hipoges.com/", None),
    # Unsupported host / non-http / junk → None.
    ("https://www.fotocasa.es/es/comprar/viviendas/madrid/", None),
    ("ftp://www.idealista.com/venta-viviendas/x/", None),
    ("not a url", None),
]


@pytest.mark.parametrize("url,expected", _DETAIL_CASES)
def test_detail_portal_for_url(url: str, expected: str | None) -> None:
    assert detail_portal_for_url(url) == expected
    assert is_detail_url(url) == (expected is not None)


@pytest.mark.parametrize("url,expected", _LISTING_CASES)
def test_listing_portal_for_url(url: str, expected: str | None) -> None:
    assert listing_portal_for_url(url) == expected
    assert is_listing_url(url) == (expected is not None)


def test_detail_and_listing_are_mutually_exclusive() -> None:
    """A URL is never simultaneously a detail and a listing page — the same
    invariant the JS suite asserts, and the property #292 relies on (a captured
    page is routed to exactly one of the two paths)."""
    for url, _ in _DETAIL_CASES + _LISTING_CASES:
        if is_detail_url(url) or is_listing_url(url):
            assert not (is_detail_url(url) and is_listing_url(url)), url
