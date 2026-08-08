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

from etl.connectors.base import SearchUrlGrammar
from etl.connectors.habitaclia import HabitacliaConnector
from etl.connectors.milanuncios import MilanunciosConnector
from etl.connectors.milanuncios_rental import MilanunciosRentalConnector
from etl.connectors.pisos import PisosConnector

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "url-grammar-cases.json"


def assert_grammar_roundtrip(
    grammar: SearchUrlGrammar,
    cases: Sequence[Mapping[str, str]],
    foreign_urls: Sequence[str],
    build_real: Callable[[Mapping[str, str]], str] | None = None,
) -> None:
    """Assert the three contract properties for `grammar` over `cases`.

    `cases` are param dicts (only placeholder keys). `build_real`, when given,
    is the connector's actual URL builder for the same params — asserted equal to
    `grammar.build` (the anti-drift check). `foreign_urls` must all fail to
    parse.
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
    for url in foreign_urls:
        assert grammar.parse(url) is None, f"grammar wrongly parsed foreign URL {url!r}"


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


def connector_specs() -> list[
    tuple[str, SearchUrlGrammar, list[dict[str, str]], list[str], Callable]
]:
    """Every connector with a published grammar, as
    `(name, grammar, cases, foreign_urls, build_real)`. #493–#496 append here.
    """
    pisos, pisos_cases, pisos_foreign = _pisos_spec()
    habi, habi_cases, habi_foreign = _habitaclia_spec()
    mil, mil_cases, mil_foreign = _milanuncios_spec()
    rental, rental_cases, rental_foreign = _milanuncios_rental_spec()
    for c in (pisos, habi, mil, rental):
        assert c.search_url_grammar is not None
    return [
        (
            "pisos",
            pisos.search_url_grammar,
            pisos_cases,
            pisos_foreign,
            lambda params: pisos._search_url(params["geography"]),
        ),
        (
            "habitaclia",
            habi.search_url_grammar,
            habi_cases,
            habi_foreign,
            lambda params: habi._search_url(params["geography"]),
        ),
        (
            "milanuncios",
            mil.search_url_grammar,
            mil_cases,
            mil_foreign,
            lambda params: mil._search_url(params["geography"]),
        ),
        (
            "milanuncios_rental",
            rental.search_url_grammar,
            rental_cases,
            rental_foreign,
            lambda params: rental._rental_search_url(params["geography"]),
        ),
    ]


def grammar_fixture_payload() -> dict:
    """The shared Python↔TS parity fixture: for every connector, its serialised
    grammar plus a battery of `{url, expected}` cases (expected is the param dict
    for a valid URL, None for one the grammar must reject)."""
    connectors = []
    for name, grammar, cases, foreign, _ in connector_specs():
        placeholders = grammar.placeholders()
        entries: list[dict] = []
        for case in cases:
            url = grammar.build(case)
            expected = {k: v for k, v in case.items() if k in placeholders}
            entries.append({"url": url, "expected": expected})
        for url in foreign:
            entries.append({"url": url, "expected": None})
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
