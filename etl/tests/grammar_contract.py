"""Shared round-trip contract for connector search-URL grammars (issue #491).

Reused by every per-connector grammar test (#492–#496 will each register their
connector here) and by the fixture generator that feeds the TypeScript parity
test (`dashboard/lib/connector-url/__tests__/parse.test.ts`). The contract binds
three properties every connector grammar must satisfy:

1. **No drift** — `grammar.build(params)` equals the connector's real
   `_search_url()` for the same scope.
2. **Invertible** — `grammar.parse(grammar.build(params)) == params` (for the
   placeholder keys the grammar round-trips).
3. **Scoped** — `grammar.parse(url)` returns None for a URL from another portal.

The parity fixture is *generated* from these same grammars + cases, so Python
and TypeScript agree by DATA, not by hand-kept discipline: regenerate it with
`REGEN_FIXTURES=1 python -m pytest etl/tests/test_url_grammar_fixture.py` (or
call `write_fixture()` directly).
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from etl.connectors import servihabitat, unicaja
from etl.connectors.base import SearchUrlGrammar
from etl.connectors.diglo import DigloConnector
from etl.connectors.fotocasa import FotocasaConnector
from etl.connectors.fotocasa_rental import FotocasaRentalConnector
from etl.connectors.habitaclia import HabitacliaConnector
from etl.connectors.milanuncios import MilanunciosConnector
from etl.connectors.milanuncios_rental import MilanunciosRentalConnector
from etl.connectors.pisos import PisosConnector
from etl.connectors.servihabitat import ServihabitatConnector
from etl.connectors.solvia import SolviaConnector
from etl.connectors.unicaja import UnicajaConnector

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "url-grammar-cases.json"


def assert_grammar_roundtrip(
    grammar: SearchUrlGrammar,
    cases: Sequence[Mapping[str, str]],
    foreign_urls: Sequence[str],
    build_real: Callable[[Mapping[str, str]], str] | None = None,
    rejects: Sequence[tuple[str, str]] = (),
    parse_only: Sequence[Mapping[str, str]] = (),
) -> None:
    """Assert the contract properties for `grammar` over `cases`.

    `cases` are param dicts (only placeholder keys). `build_real`, when given,
    is the connector's actual URL builder for the same params — asserted equal to
    `grammar.build` (the anti-drift check). `foreign_urls` must all fail to parse
    AND not be a reasoned rejection (a different portal/path, kept verbatim).
    `rejects` (issue #493) are `(url, reason)` pairs the grammar must flag as a
    robots-forbidden shape via `rejection()` — the UI blocks saving these,
    distinct from a plain no-match; a valid URL must never be rejected.

    `parse_only` (issue #494) are param dicts that must round-trip
    (`parse(build(x)) == x`) but are NOT checked against `build_real`: they carry
    native URL fields the connector INFERS from an owner-edited URL but does not
    itself build (e.g. Unicaja's `precioMax`/`numDormitorios`), so there is no
    real builder to drift against — only the grammar's own invertibility.
    """
    placeholders = grammar.placeholders()
    for case in cases:
        url = grammar.build(case)
        if build_real is not None:
            assert build_real(case) == url, (
                f"grammar.build drifted from the connector's real URL builder "
                f"for {case!r}: {url!r} != {build_real(case)!r}"
            )
        parsed = grammar.parse(url)
        expected = {k: v for k, v in case.items() if k in placeholders}
        assert parsed == expected, (
            f"parse(build({case!r})) = {parsed!r}, expected {expected!r}"
        )
        assert grammar.rejection(url) is None, (
            f"grammar wrongly rejected a valid URL {url!r}"
        )
    for case in parse_only:
        url = grammar.build(case)
        parsed = grammar.parse(url)
        expected = {k: v for k, v in case.items() if k in placeholders}
        assert parsed == expected, (
            f"parse(build({case!r})) = {parsed!r}, expected {expected!r} "
            "(parse_only case)"
        )
        assert grammar.rejection(url) is None, (
            f"grammar wrongly rejected a valid URL {url!r} (parse_only case)"
        )
    for url in foreign_urls:
        assert grammar.parse(url) is None, f"grammar wrongly parsed foreign URL {url!r}"
        assert grammar.rejection(url) is None, (
            f"grammar wrongly rejected foreign URL {url!r}"
        )
    for url, reason in rejects:
        assert grammar.rejection(url) == reason, (
            f"grammar.rejection({url!r}) = {grammar.rejection(url)!r}, "
            f"expected {reason!r}"
        )


def _pisos_spec() -> tuple[PisosConnector, list[dict[str, str]], list[str]]:
    connector = PisosConnector()
    cases = [
        {"geography": "madrid"},
        {"geography": "barcelona"},
        # A multi-word city whose live slug is underscore-joined (issue #369).
        {"geography": "dos_hermanas"},
        {"geography": "alcala_de_guadaira"},
        # A _SLUG_OVERRIDES target (pisos.com drops the leading article).
        {"geography": "hospitalet_de_llobregat"},
    ]
    foreign = [
        # Another portal entirely.
        "https://www.habitaclia.com/viviendas-madrid.htm",
        "https://www.idealista.com/venta-viviendas/madrid/",
        # Right host, wrong path (a pisos.com DETAIL URL, not a search page).
        "https://www.pisos.com/comprar/piso-madrid-123/",
        # Right host + search path, but an extra native-filter segment the
        # grammar deliberately does not model — must be treated as unparseable
        # (saved verbatim), not silently truncated to the municipality.
        "https://www.pisos.com/venta/pisos-sevilla/1-habitacion/",
    ]
    return connector, cases, foreign


def _habitaclia_spec() -> tuple[HabitacliaConnector, list[dict[str, str]], list[str]]:
    connector = HabitacliaConnector()
    cases = [
        {"geography": "madrid"},
        {"geography": "barcelona"},
        # A multi-word city whose live slug is underscore-joined (issue #369).
        {"geography": "dos_hermanas"},
        {"geography": "alcala_de_guadaira"},
    ]
    foreign = [
        # Other portals entirely.
        "https://www.pisos.com/venta/pisos-madrid/",
        "https://www.idealista.com/venta-viviendas/madrid/",
        "https://www.milanuncios.com/venta-de-pisos-en-madrid-madrid/",
        # habitaclia + a `?pag=2` query — robots.txt disallows pagination, so the
        # grammar must NOT parse it (EC-3): saved verbatim, not silently
        # truncated to the municipality.
        "https://www.habitaclia.com/viviendas-madrid.htm?pag=2",
        # A trailing newline — JS `$` (no /m) does NOT match before it, and the
        # Python side's `$`→`\Z` translation matches that, so BOTH must reject.
        # This is the case that would expose the Python/JS `$` divergence if the
        # translation regressed (issue #492 validate_grammar hardening).
        "https://www.habitaclia.com/viviendas-madrid.htm\n",
    ]
    return connector, cases, foreign


def _milanuncios_spec() -> tuple[MilanunciosConnector, list[dict[str, str]], list[str]]:
    connector = MilanunciosConnector()
    # Single-word slugs only — Milanuncios' verified slugs are identity
    # single-word (see _CITY_SLUGS); the repeated-slug grammar keys off the
    # single hyphen between the two halves.
    cases = [
        {"geography": "madrid"},
        {"geography": "sevilla"},
        {"geography": "barcelona"},
        {"geography": "valencia"},
        {"geography": "malaga"},
    ]
    foreign = [
        # Other portals.
        "https://www.habitaclia.com/viviendas-madrid.htm",
        "https://www.pisos.com/venta/pisos-madrid/",
        # The RENTAL sibling's URL — the sale grammar must reject it (the two
        # operations never cross).
        "https://www.milanuncios.com/alquiler-de-pisos-en-madrid-madrid/",
        # The two halves disagree (owner edited only one) → backreference fails
        # → unparseable, kept verbatim (EC-2).
        "https://www.milanuncios.com/venta-de-pisos-en-madrid-toledo/",
        # Only ONE half present (the owner deleted the repeat) → also rejected.
        "https://www.milanuncios.com/venta-de-pisos-en-madrid/",
    ]
    return connector, cases, foreign


def _milanuncios_rental_spec() -> tuple[
    MilanunciosRentalConnector, list[dict[str, str]], list[str]
]:
    connector = MilanunciosRentalConnector()
    cases = [
        {"geography": "madrid"},
        {"geography": "sevilla"},
        {"geography": "barcelona"},
    ]
    foreign = [
        "https://www.habitaclia.com/viviendas-madrid.htm",
        # The SALE sibling's URL — the rental grammar must reject it.
        "https://www.milanuncios.com/venta-de-pisos-en-madrid-madrid/",
        # Unequal halves → rejected.
        "https://www.milanuncios.com/alquiler-de-pisos-en-madrid-toledo/",
    ]
    return connector, cases, foreign


def _fotocasa_spec() -> tuple[
    FotocasaConnector, list[dict[str, str]], list[str], list[tuple[str, str]]
]:
    connector = FotocasaConnector()
    # Fotocasa's 3-segment path: geography / zone / optional rooms token. The
    # `rooms_segment` placeholder round-trips the WHOLE `<N>-habitaciones/` token
    # (or empty) — see the connector's grammar docstring.
    cases = [
        {"geography": "madrid-capital", "zone": "todas-las-zonas", "rooms_segment": ""},
        {"geography": "madrid-capital", "zone": "chamberi", "rooms_segment": ""},
        # Rooms round-trip (issue #493 EC-2): the -habitaciones/ token survives.
        {
            "geography": "madrid-capital",
            "zone": "chamberi",
            "rooms_segment": "2-habitaciones/",
        },
        {
            "geography": "sevilla-capital",
            "zone": "todas-las-zonas",
            "rooms_segment": "3-habitaciones/",
        },
    ]
    foreign = [
        # Other portals entirely.
        "https://www.habitaclia.com/viviendas-madrid.htm",
        "https://www.pisos.com/venta/pisos-madrid/",
        "https://www.idealista.com/venta-viviendas/madrid/",
        # The RENTAL sibling's URL — the sale grammar must NOT parse it (the two
        # operations never cross). It is a no-match (verbatim), not a robots
        # rejection.
        "https://www.fotocasa.es/es/alquiler/viviendas/madrid-capital/todas-las-zonas/l",
        # A trailing newline — JS `$` (no /m) does NOT match before it and the
        # Python `$`→`\Z` translation matches that, so BOTH must reject.
        "https://www.fotocasa.es/es/comprar/viviendas/madrid-capital/todas-las-zonas/l\n",
    ]
    rejects = [
        # robots.txt bans ALL filter query params — a URL discover() could never
        # open. Rejected with a reason (blocks Guardar), NOT saved verbatim.
        (
            (
                "https://www.fotocasa.es/es/comprar/viviendas/madrid-capital"
                "/todas-las-zonas/l?minPrice=100000"
            ),
            "robots-query-params",
        ),
        # A bare city-name segment (`/madrid/`) is disallowed — use the
        # hyphenated slug. This one DOES parse (geography=madrid) but is still a
        # hard rejection: rejection() takes precedence over parse().
        (
            "https://www.fotocasa.es/es/comprar/viviendas/madrid/todas-las-zonas/l",
            "robots-bare-geography",
        ),
    ]
    return connector, cases, foreign, rejects


def _fotocasa_rental_spec() -> tuple[
    FotocasaRentalConnector, list[dict[str, str]], list[str], list[tuple[str, str]]
]:
    connector = FotocasaRentalConnector()
    cases = [
        {"geography": "madrid-capital"},
        {"geography": "sevilla-capital"},
    ]
    foreign = [
        "https://www.habitaclia.com/viviendas-madrid.htm",
        # The SALE sibling's URL — the rental grammar must reject it (no-match).
        "https://www.fotocasa.es/es/comprar/viviendas/madrid-capital/todas-las-zonas/l",
        "https://www.fotocasa.es/es/alquiler/viviendas/madrid-capital/todas-las-zonas/l\n",
    ]
    rejects = [
        (
            (
                "https://www.fotocasa.es/es/alquiler/viviendas/madrid-capital"
                "/todas-las-zonas/l?maxPrice=1200"
            ),
            "robots-query-params",
        ),
        (
            "https://www.fotocasa.es/es/alquiler/viviendas/barcelona/todas-las-zonas/l",
            "robots-bare-geography",
        ),
    ]
    return connector, cases, foreign, rejects


def _diglo_spec() -> tuple[DigloConnector, list[dict[str, str]], list[str]]:
    connector = DigloConnector()
    cases = [
        {"province": "madrid", "page": "0"},
        {"province": "barcelona", "page": "3"},
        {"province": "sevilla", "page": "0"},
    ]
    foreign = [
        # Other portals.
        "https://www.pisos.com/venta/pisos-madrid/",
        "https://www.idealista.com/venta-viviendas/madrid/",
        # A Diglo DETAIL URL (extra path segments) — not a buscador page.
        "https://digloservicer.com/venta-pisos/madrid/madrid/efe0000200055",
        # The buscador entry type-segment is fixed `venta-pisos`; a different
        # `venta-<type>` is not this grammar's URL.
        "https://digloservicer.com/venta-casas/madrid?page=0",
        # A trailing newline — JS `$` (no /m) does not match before it and the
        # Python `$`→`\Z` translation matches that, so BOTH must reject.
        "https://digloservicer.com/venta-pisos/madrid?page=0\n",
    ]
    return connector, cases, foreign


def _unicaja_spec() -> tuple[
    UnicajaConnector, list[dict[str, str]], list[str], list[dict[str, str]]
]:
    connector = UnicajaConnector()
    # DEFAULT-shaped cases: only `provincia`/`pagina` vary — exactly what the
    # connector's own `_search_url()` builds, so the anti-drift `build_real`
    # check applies.
    default_extras = {
        "municipio": "-1",
        "precioMin": "",
        "precioMax": "",
        "codigoPostal": "",
        "numDormitorios": "-1",
        "superficieMin": "",
    }
    cases = [
        {"provincia": "29", "pagina": "1", **default_extras},
        {"provincia": "41", "pagina": "2", **default_extras},
    ]
    # PARSE-ONLY: native URL fields the owner may edit in and the grammar infers,
    # but the connector does NOT build (consumed=False) — no `build_real` to drift
    # against, only the grammar's own invertibility (issue #494 EC-2).
    parse_only = [
        {
            "provincia": "29",
            "municipio": "29067",
            "precioMin": "50000",
            "precioMax": "200000",
            "codigoPostal": "29001",
            "numDormitorios": "3",
            "superficieMin": "80",
            "pagina": "1",
        },
    ]
    foreign = [
        # Other portals.
        "https://www.pisos.com/venta/pisos-madrid/",
        "https://www.fotocasa.es/es/comprar/viviendas/madrid-capital/todas-las-zonas/l",
        # A Unicaja DETAIL URL — a different `*.do` action, not the search list.
        "https://unicajainmuebles.com/fichainmueble.do?referencia=0001234854",
        # A reordered query (owner moved provincia before the fixed prefix) —
        # the fixed-order grammar can't match it, so it's kept verbatim.
        "https://unicajainmuebles.com/listadoPromocion.do?provincia=29&definitionName=busqueda",
        # Trailing newline of an otherwise-valid URL.
        connector.search_url_grammar.build(
            {"provincia": "29", "pagina": "1", **default_extras}
        )
        + "\n",
    ]
    return connector, cases, foreign, parse_only


def _solvia_spec() -> tuple[SolviaConnector, list[dict[str, str]], list[str]]:
    connector = SolviaConnector()
    cases = [
        {"provincia": "madrid", "municipio_segment": ""},
        {"provincia": "malaga", "municipio_segment": "/mijas"},
        {"provincia": "sevilla", "municipio_segment": ""},
    ]
    foreign = [
        # Other portals.
        "https://www.pisos.com/venta/pisos-madrid/",
        "https://www.idealista.com/venta-viviendas/madrid/",
        # The RENTAL section — the comprar grammar must not parse it (EC-1).
        "https://www.solvia.es/es/alquiler/viviendas/malaga",
        # Too many path segments (province + municipio + extra) → no match.
        "https://www.solvia.es/es/comprar/viviendas/malaga/mijas/extra",
    ]
    return connector, cases, foreign


def _servihabitat_spec() -> tuple[
    ServihabitatConnector, list[dict[str, str]], list[str], list[tuple[str, str]]
]:
    connector = ServihabitatConnector()
    cases = [
        {"province": "madrid"},
        {"province": "sevilla"},
        {"province": "malaga"},
    ]
    foreign = [
        # Other portals.
        "https://www.pisos.com/venta/pisos-madrid/",
        # A servihabitat listing/detail path with NO query — not the sitemap and
        # not the (query-bearing) faceted search, so kept verbatim (not rejected).
        "https://www.servihabitat.com/es/venta/viviendas/madrid/piso-123",
        # Trailing newline of a valid sitemap URL.
        "https://www.servihabitat.com/es/sitemap-es-madrid.xml\n",
    ]
    rejects = [
        # The faceted search (any servihabitat.com URL carrying a query) is
        # robots.txt-disallowed — a hard, reasoned block (issue #495 EC-3).
        (
            "https://www.servihabitat.com/es/venta/viviendas/madrid?provincia=madrid",
            "robots-faceted-search",
        ),
        (
            "https://www.servihabitat.com/es/buscar?operacion=venta&precio=0-200000",
            "robots-faceted-search",
        ),
    ]
    return connector, cases, foreign, rejects


def connector_specs() -> list[
    tuple[str, SearchUrlGrammar, list[dict[str, str]], list[str], Callable, list, list]
]:
    """Every connector with a published grammar, as
    `(name, grammar, cases, foreign_urls, build_real, rejects, parse_only)`.
    `parse_only` (issue #494) are param dicts the grammar must invert but which
    the connector doesn't itself build (native URL fields); `[]` for connectors
    without any.
    """
    pisos, pisos_cases, pisos_foreign = _pisos_spec()
    habi, habi_cases, habi_foreign = _habitaclia_spec()
    mil, mil_cases, mil_foreign = _milanuncios_spec()
    rental, rental_cases, rental_foreign = _milanuncios_rental_spec()
    foto, foto_cases, foto_foreign, foto_rejects = _fotocasa_spec()
    foto_r, foto_r_cases, foto_r_foreign, foto_r_rejects = _fotocasa_rental_spec()
    dg, dg_cases, dg_foreign = _diglo_spec()
    uni, uni_cases, uni_foreign, uni_parse_only = _unicaja_spec()
    sol, sol_cases, sol_foreign = _solvia_spec()
    servi, servi_cases, servi_foreign, servi_rejects = _servihabitat_spec()
    for c in (pisos, habi, mil, rental, foto, foto_r, dg, uni, sol, servi):
        assert c.search_url_grammar is not None
    return [
        (
            "pisos",
            pisos.search_url_grammar,
            pisos_cases,
            pisos_foreign,
            lambda params: pisos._search_url(params["geography"]),
            [],
            [],
        ),
        (
            "habitaclia",
            habi.search_url_grammar,
            habi_cases,
            habi_foreign,
            lambda params: habi._search_url(params["geography"]),
            [],
            [],
        ),
        (
            "milanuncios",
            mil.search_url_grammar,
            mil_cases,
            mil_foreign,
            lambda params: mil._search_url(params["geography"]),
            [],
            [],
        ),
        (
            "milanuncios_rental",
            rental.search_url_grammar,
            rental_cases,
            rental_foreign,
            lambda params: rental._rental_search_url(params["geography"]),
            [],
            [],
        ),
        (
            "fotocasa",
            foto.search_url_grammar,
            foto_cases,
            foto_foreign,
            lambda params: foto._search_url(
                params["geography"], params["zone"], params["rooms_segment"]
            ),
            foto_rejects,
            [],
        ),
        (
            "fotocasa_rental",
            foto_r.search_url_grammar,
            foto_r_cases,
            foto_r_foreign,
            lambda params: foto_r._rental_search_url(params["geography"]),
            foto_r_rejects,
            [],
        ),
        (
            "diglo",
            dg.search_url_grammar,
            dg_cases,
            dg_foreign,
            lambda params: dg._search_url(params["province"], int(params["page"])),
            [],
            [],
        ),
        (
            "unicaja",
            uni.search_url_grammar,
            uni_cases,
            uni_foreign,
            lambda params: unicaja._search_url(
                params["provincia"], int(params["pagina"])
            ),
            [],
            uni_parse_only,
        ),
        (
            "solvia",
            sol.search_url_grammar,
            sol_cases,
            sol_foreign,
            lambda params: sol._search_url(
                params["provincia"], params["municipio_segment"]
            ),
            [],
            [],
        ),
        (
            "servihabitat",
            servi.search_url_grammar,
            servi_cases,
            servi_foreign,
            lambda params: servihabitat._sitemap_url(params["province"]),
            servi_rejects,
            [],
        ),
    ]


def grammar_fixture_payload() -> dict:
    """The shared Python↔TS parity fixture: for every connector, its serialised
    grammar plus a battery of `{url, expected}` cases (expected is the param dict
    for a valid URL, None for one the grammar must reject)."""
    connectors = []
    for name, grammar, cases, foreign, _, rejects, parse_only in connector_specs():
        placeholders = grammar.placeholders()
        entries: list[dict] = []
        for case in (*cases, *parse_only):
            url = grammar.build(case)
            expected = {k: v for k, v in case.items() if k in placeholders}
            entries.append({"url": url, "expected": expected, "reject": None})
        for url in foreign:
            entries.append({"url": url, "expected": None, "reject": None})
        for url, reason in rejects:
            # `expected` is the REAL parse result (a bare-geography URL still
            # parses; a query-string URL does not) — the parity test asserts
            # both parse and rejection. `reject` is the reasoned block key.
            entries.append(
                {"url": url, "expected": grammar.parse(url), "reject": reason}
            )
        connectors.append(
            {
                "connector": name,
                "grammar": dataclasses.asdict(grammar),
                "cases": entries,
            }
        )
    return {
        "_generated_by": (
            "etl/tests/grammar_contract.py::grammar_fixture_payload (issue #491) "
            "— do not edit by hand; regenerate with REGEN_FIXTURES=1 pytest "
            "etl/tests/test_url_grammar_fixture.py"
        ),
        "connectors": connectors,
    }


def _serialise(payload: dict) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def write_fixture() -> None:
    """(Re)write the committed parity fixture from the current grammars."""
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(_serialise(grammar_fixture_payload()), encoding="utf-8")
