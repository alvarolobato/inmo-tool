"""Tests for the base connector model additions in issue #491:
`SearchParam`, `SearchPreview.params`, `SearchUrlGrammar`, and `validate_grammar`.

Pure/offline — no DB, no network.
"""

from __future__ import annotations

import dataclasses

import pytest

from etl.connectors.base import (
    Connector,
    SearchParam,
    SearchPreview,
    SearchUrlGrammar,
    validate_grammar,
)


class TestSearchParamAndPreview:
    def test_search_preview_params_default_is_empty(self):
        # Additive: an existing connector that builds a preview without params
        # keeps working, and the default is an empty tuple (not None).
        p = SearchPreview(label="x", url="https://x", kind="search_page", tunable=True)
        assert p.params == ()

    def test_asdict_serialises_nested_params(self):
        preview = SearchPreview(
            label="Pisos.com — madrid",
            url="https://www.pisos.com/venta/pisos-madrid/",
            kind="search_page",
            tunable=True,
            params=(
                SearchParam(
                    key="geography",
                    label="Municipio",
                    value="madrid",
                    source="profile",
                    in_url=True,
                ),
                SearchParam(
                    key="operation",
                    label="Operación",
                    value="venta",
                    source="constant",
                    in_url=True,
                ),
            ),
        )
        d = dataclasses.asdict(preview)
        # This is exactly what publish_search_previews serialises into the
        # connector_search_preview.previews JSONB — nested params become a list
        # of dicts the TypeScript reader parses defensively. asdict keeps the
        # tuple; json.dumps (what the publisher runs) turns it into a JSON array.
        assert list(d["params"]) == [
            {
                "key": "geography",
                "label": "Municipio",
                "value": "madrid",
                "source": "profile",
                "in_url": True,
                "notes": None,
            },
            {
                "key": "operation",
                "label": "Operación",
                "value": "venta",
                "source": "constant",
                "in_url": True,
                "notes": None,
            },
        ]


_PISOS_GRAMMAR = SearchUrlGrammar(
    build_template="https://www.pisos.com/venta/pisos-{geography}/",
    parse_pattern=r"^https?://(?:www\.)?pisos\.com/venta/pisos-(?<geography>[^/]+)/?$",
    params={"geography": {"label": "Municipio", "source": "profile"}},
)


class TestSearchUrlGrammar:
    def test_build_fills_the_template(self):
        assert (
            _PISOS_GRAMMAR.build({"geography": "madrid"})
            == "https://www.pisos.com/venta/pisos-madrid/"
        )

    def test_build_ignores_extra_keys(self):
        assert (
            _PISOS_GRAMMAR.build({"geography": "madrid", "operation": "venta"})
            == "https://www.pisos.com/venta/pisos-madrid/"
        )

    def test_parse_extracts_named_groups(self):
        assert _PISOS_GRAMMAR.parse(
            "https://www.pisos.com/venta/pisos-dos_hermanas/"
        ) == {"geography": "dos_hermanas"}

    def test_parse_returns_none_for_a_non_matching_url(self):
        assert _PISOS_GRAMMAR.parse("https://www.habitaclia.com/x.htm") is None

    def test_placeholders_and_group_names_agree(self):
        assert _PISOS_GRAMMAR.placeholders() == {"geography"}
        assert _PISOS_GRAMMAR.group_names() == {"geography"}


class _GrammarConnector(Connector):
    name = "test-grammar"

    def discover(self, scope, throttle):  # pragma: no cover
        return []

    def fetch_detail(self, external_id, throttle):  # pragma: no cover
        raise NotImplementedError

    def normalize(self, raw):  # pragma: no cover
        raise NotImplementedError


class TestValidateGrammar:
    def test_valid_grammar_passes(self):
        c = _GrammarConnector()
        c.search_url_grammar = _PISOS_GRAMMAR
        validate_grammar(c)  # no raise

    def test_no_grammar_is_a_noop(self):
        c = _GrammarConnector()
        c.search_url_grammar = None
        validate_grammar(c)  # no raise

    def test_group_without_a_placeholder_fails(self):
        c = _GrammarConnector()
        c.search_url_grammar = SearchUrlGrammar(
            # template has no {city} placeholder, but the pattern names a `city`
            # group — the two must match exactly.
            build_template="https://x.com/search/",
            parse_pattern=r"^https://x\.com/search/(?<city>[^/]+)/$",
        )
        with pytest.raises(ValueError, match="named groups"):
            validate_grammar(c)

    def test_inline_flag_fails(self):
        c = _GrammarConnector()
        c.search_url_grammar = SearchUrlGrammar(
            build_template="https://x.com/{geography}/",
            parse_pattern=r"^(?i)https://x\.com/(?<geography>[^/]+)/$",
        )
        with pytest.raises(ValueError, match="inline flags"):
            validate_grammar(c)

    def test_lookbehind_fails(self):
        c = _GrammarConnector()
        c.search_url_grammar = SearchUrlGrammar(
            build_template="https://x.com/{geography}/",
            parse_pattern=r"^https://x\.com/(?<=/)(?<geography>[^/]+)/$",
        )
        with pytest.raises(ValueError, match="lookbehind"):
            validate_grammar(c)

    def test_uncompilable_pattern_fails(self):
        c = _GrammarConnector()
        c.search_url_grammar = SearchUrlGrammar(
            build_template="https://x.com/{geography}/",
            parse_pattern=r"^https://x\.com/(?<geography>[/$",  # unbalanced
        )
        with pytest.raises(ValueError, match="does not compile"):
            validate_grammar(c)
