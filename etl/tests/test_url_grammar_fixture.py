"""The Python↔TypeScript grammar-parity fixture (issue #491).

`etl/tests/fixtures/url-grammar-cases.json` is GENERATED from the connectors'
own grammars (`grammar_contract.grammar_fixture_payload`) and consumed verbatim
by `dashboard/lib/connector-url/__tests__/parse.test.ts`. Parity between the
Python `SearchUrlGrammar.parse` and the browser `inferParams` is therefore
guaranteed by shared DATA, not by two hand-kept implementations agreeing by
discipline.

This test (a) runs the round-trip contract for every registered connector and
(b) golden-checks the committed fixture against what the grammars produce now —
so a grammar change that isn't reflected in the fixture fails CI. Regenerate
with `REGEN_FIXTURES=1 python -m pytest etl/tests/test_url_grammar_fixture.py`.
"""

from __future__ import annotations

import json
import os

from etl.tests.grammar_contract import (
    FIXTURE_PATH,
    _serialise,
    assert_grammar_roundtrip,
    connector_specs,
    grammar_fixture_payload,
    write_fixture,
)


def test_every_connector_grammar_round_trips():
    for name, grammar, cases, foreign, build_real in connector_specs():
        assert_grammar_roundtrip(grammar, cases, foreign, build_real=build_real)


def test_committed_fixture_matches_the_grammars():
    if os.environ.get("REGEN_FIXTURES"):
        write_fixture()
    assert FIXTURE_PATH.exists(), (
        "url-grammar-cases.json is missing — regenerate with "
        "REGEN_FIXTURES=1 python -m pytest etl/tests/test_url_grammar_fixture.py"
    )
    on_disk = FIXTURE_PATH.read_text(encoding="utf-8")
    expected = _serialise(grammar_fixture_payload())
    assert on_disk == expected, (
        "The committed url-grammar-cases.json is stale. Regenerate with "
        "REGEN_FIXTURES=1 python -m pytest etl/tests/test_url_grammar_fixture.py "
        "and commit the result."
    )


def test_fixture_is_valid_json_with_expected_shape():
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert isinstance(data["connectors"], list) and data["connectors"]
    pisos = next(c for c in data["connectors"] if c["connector"] == "pisos")
    assert pisos["grammar"]["build_template"]
    assert pisos["grammar"]["parse_pattern"]
    # At least one valid case and one rejected case.
    assert any(c["expected"] is not None for c in pisos["cases"])
    assert any(c["expected"] is None for c in pisos["cases"])
