"""Fixture-based tests for MilanunciosRentalConnector (issue #31).

No live network calls — discover()/fetch_detail() are exercised by
monkeypatching requests.get to return saved fixture HTML, mirroring
test_connector_milanuncios.py's pattern exactly (this connector reuses
that one's fetch_detail()/normalize() unchanged, so its own tests focus on
what's actually different: discover()'s URL, the connector's identity/
rate-limit attributes, and an end-to-end proof that a real rental page
normalizes to operation="rent" via the INHERITED normalize()).
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.milanuncios import MilanunciosConnector
from etl.connectors.milanuncios_rental import MilanunciosRentalConnector

_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.milanuncios.com/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def test_milanuncios_rental_has_its_own_source_name():
    """Distinct from the sale connector's "milanuncios" — see module
    docstring's identity reasoning (own connector_runs/connector_config
    rows, own rate limiter/circuit breaker instance)."""
    assert MilanunciosRentalConnector.name == "milanuncios_rental"
    assert MilanunciosRentalConnector.name != MilanunciosConnector.name


def test_milanuncios_rental_rate_limit_stays_below_the_sale_connectors():
    """Mutation check for the module docstring's stated rate-limit
    reasoning — both connectors share Milanuncios' cumulative anti-bot
    budget with INDEPENDENT limiters, so the rental connector's own limit
    must stay strictly below the sale connector's, not accidentally equal
    or higher.

    Opus review (PR #199): this used to assert `== 10` ("half of the sale
    connector's 20"), written before #179/#205 measured the sale
    connector down to `rate_limit_per_minute = 2` (D-017) — at which point
    `10` silently became FIVE TIMES the only Milanuncios rate D-017's live
    measurement ever found non-catastrophic, not half of anything real.
    The relative assertion (`<` the sale connector, whatever that
    currently is) is what actually encodes the intended invariant; the
    absolute `== 1` pins today's smallest-integer-below-2 value so a
    future accidental bump is still caught even if MilanunciosConnector's
    own rate ever changes again.
    """
    assert (
        MilanunciosRentalConnector.rate_limit_per_minute
        < MilanunciosConnector.rate_limit_per_minute
    )
    assert MilanunciosRentalConnector.rate_limit_per_minute == 1


def test_milanuncios_rental_does_not_claim_full_inventory_coverage():
    assert MilanunciosRentalConnector.discovers_full_inventory is False


def test_milanuncios_rental_does_not_inherit_the_sale_connectors_skip_window():
    """Opus review, PR #225. This class subclasses `MilanunciosConnector`,
    so issue #179 turning skip-if-seen ON there (24h) would have silently
    turned it on for the rental source too — a live behaviour change to a
    connector for which not one row of supporting evidence exists (every
    fact in D-028 is `source='milanuncios'`).

    The invariant this pins is deliberately expressed BOTH ways, for the
    same reason `test_milanuncios_rental_rate_limit_stays_below_the_sale_
    connectors` above does:

    - `== 0` pins today's deliberate value (skip-if-seen off, matching the
      base `Connector` default) so silently removing the explicit
      declaration and falling back to inheritance is caught.
    - the `vars()` check on the *class dictionary* is the part that
      survives the parent changing its own number again: it asserts this
      class declares the attribute in its own right, rather than reading
      through to whatever `MilanunciosConnector` happens to hold. A future
      edit that deletes the line here would still satisfy `== 0` for
      exactly as long as the parent also happened to be 0 — which is the
      silent-inheritance failure mode this whole test exists to catch.

    Deliberately NOT asserted: `!= MilanunciosConnector.min_refetch_
    interval_seconds`. That reads well but fails for the wrong reason — if
    the sale connector ever legitimately returns to 0 the two become equal
    with no inheritance risk whatsoever, and the assertion would fire on a
    change to a file this test isn't about.
    """
    assert MilanunciosRentalConnector.min_refetch_interval_seconds == 0
    assert "min_refetch_interval_seconds" in vars(MilanunciosRentalConnector), (
        "min_refetch_interval_seconds must be declared explicitly on "
        "MilanunciosRentalConnector, not inherited from MilanunciosConnector "
        "— same per-connector-safety-property rule as discovers_full_inventory"
    )


def test_milanuncios_rental_does_not_inherit_search_override_consumption():
    """Issue #478 P5 (D-101): the sale connector turned
    supports_search_override ON and wired its discover() to consume
    scope.override_url. The rental subclass's discover() was NOT wired for
    it, so it must declare supports_search_override = False in its own right —
    otherwise it would silently inherit True and the orchestrator would hand
    it override scopes its discover() ignores. Same per-connector-behaviour
    rule (declare, never inherit) as discovers_full_inventory above."""
    assert MilanunciosRentalConnector.supports_search_override is False
    assert "supports_search_override" in vars(MilanunciosRentalConnector), (
        "supports_search_override must be declared explicitly on "
        "MilanunciosRentalConnector, not inherited from MilanunciosConnector"
    )


class TestDiscover:
    def test_discover_requests_the_rental_category_url_not_sale(self):
        """The one real behavioural difference from MilanunciosConnector:
        discover() must hit alquiler-de-pisos-en-..., never
        venta-de-pisos-en-... — a copy-paste regression here would
        silently make this connector re-ingest sale listings as rentals."""
        html = _read_fixture("milanuncios_rental_sample_search.html")
        with patch(
            "etl.connectors.milanuncios_rental.requests.get",
            return_value=_mock_response(html),
        ) as mock_get:
            MilanunciosRentalConnector().discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        requested_url = mock_get.call_args.args[0]
        assert "alquiler-de-pisos-en-madrid-madrid" in requested_url
        assert "venta-de-pisos" not in requested_url

    def test_discover_finds_external_ids_from_rental_search_page(self):
        html = _read_fixture("milanuncios_rental_sample_search.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios_rental.requests.get",
            return_value=_mock_response(html),
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert sorted(ids) == ["511445103", "549058037", "560555908"]

    def test_center_based_scope_requests_the_matching_city_not_madrid(self):
        """Same live-URL-construction check as the sale connector's own
        test (issue #71 review finding) — must hold for this connector's
        discover() too, not just be inherited-and-assumed."""
        html = _read_fixture("milanuncios_rental_sample_search.html")
        with patch(
            "etl.connectors.milanuncios_rental.requests.get",
            return_value=_mock_response(html),
        ) as mock_get:
            MilanunciosRentalConnector().discover(
                ConnectorScope(center=(37.3891, -5.9845), radius_km=15),
                throttle=lambda: None,
            )
        requested_url = mock_get.call_args.args[0]
        assert "sevilla" in requested_url
        assert "madrid" not in requested_url

    def test_discover_raises_on_soft_block_page_not_empty_list(self):
        """Reuses the SAME site-wide block-page fixture the sale
        connector's test uses — it's not category-specific, it's what
        Milanuncios returns for any blocked request."""
        html = _read_fixture("milanuncios_sample_block_page.html")
        connector = MilanunciosRentalConnector()
        with (
            patch(
                "etl.connectors.milanuncios_rental.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__INITIAL_PROPS__"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )

    def test_discover_raises_without_defaulting_to_a_hardcoded_city(self):
        connector = MilanunciosRentalConnector()
        with pytest.raises(ConnectorError, match="nothing to discover"):
            connector.discover(ConnectorScope(), throttle=lambda: None)


class TestFetchDetailAndNormalizeInherited:
    """These exercise the INHERITED fetch_detail()/normalize() against a
    real rental page — the actual end-to-end proof that this connector
    produces operation="rent" listings without any rental-specific
    normalize() code existing anywhere (see module docstring)."""

    def test_fetch_detail_uses_the_same_generic_detail_url_as_sale(self):
        html = _read_fixture("milanuncios_rental_sample_detail.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html),
        ) as mock_get:
            raw = connector.fetch_detail("549058037", throttle=lambda: None)
        requested_url = mock_get.call_args.args[0]
        assert requested_url == "https://www.milanuncios.com/x/x-549058037.htm"
        assert raw.source == "milanuncios_rental"

    def test_normalize_derives_operation_rent_from_the_ad_s_own_category(self):
        html = _read_fixture("milanuncios_rental_sample_detail.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html),
        ):
            raw = connector.fetch_detail("549058037", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.operation == "rent"
        # price.cashPrice.value (900) lands in current_price -- the SAME
        # generic column the sale connector's price lands in, confirming
        # the schema decision documented in rent-estimate.ts's module
        # docstring: no separate monthly_rent column needed.
        assert canonical.current_price == Decimal(900)
        assert canonical.m2_built == Decimal(65)
        assert canonical.rooms == 2
        assert canonical.bathrooms == 1
        assert canonical.property_type is not None
        assert canonical.source == "milanuncios_rental"
        assert canonical.external_id == "549058037"

    def test_normalize_never_hardcodes_sale_for_a_rental_ad(self):
        """Mutation-style guard: if MilanunciosRentalConnector ever grew
        its own normalize() override that (by copy-paste mistake) hardcoded
        operation="sale" the way the original sale-only connectors do, this
        test catches it immediately."""
        html = _read_fixture("milanuncios_rental_sample_detail.html")
        connector = MilanunciosRentalConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html),
        ):
            raw = connector.fetch_detail("549058037", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.operation != "sale"


class TestDisabledByDefault:
    """Opus review must-fix (PR #199): this connector shares its domain/IP
    anti-bot budget with `MilanunciosConnector` — the core product's sale
    connector — via independent, uncoordinated rate limiters (see module
    docstring's "Disabled by default" section). It relies on the SAME
    generic born-disabled mechanism every connector gets
    (`sync_connector_registry`, issue #100,
    `test_connector_registry_sync.py::test_new_connector_is_seeded_disabled_and_ingests_nothing`)
    rather than inventing a connector-specific one — this test proves that
    generic protection genuinely covers THIS connector by exercising the
    real class end to end, rather than trusting a DummyConnector stand-in
    generalizes to it.
    """

    def test_milanuncios_rental_is_seeded_disabled_by_default(self, pg_conn):
        from etl import orchestrator

        schema_sql = (Path(__file__).parent.parent / "schema" / "init.sql").read_text(
            encoding="utf-8"
        )
        with pg_conn.cursor() as cur:
            cur.execute(schema_sql)
        pg_conn.commit()

        connector = MilanunciosRentalConnector()
        original = list(orchestrator.CONNECTORS)
        try:
            orchestrator.CONNECTORS[:] = [connector]
            orchestrator.sync_connector_registry(pg_conn)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT enabled FROM connector_config WHERE connector_name = %s",
                    (connector.name,),
                )
                row = cur.fetchone()
            assert row is not None, "sync must seed an explicit config row"
            assert row[0] is False, (
                "milanuncios_rental must start disabled — it competes with "
                "the sale connector's anti-bot budget and must be an "
                "explicit operator opt-in, not an accidental default-on"
            )

            scopes, enabled, _ = orchestrator._scopes_for_connector(
                pg_conn,
                connector.name,
                [ConnectorScope(center=(40.4168, -3.7038), radius_km=10)],
            )
            assert enabled is False
            assert scopes == []
        finally:
            orchestrator.CONNECTORS[:] = original
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM connector_registry WHERE connector_name = %s",
                    (connector.name,),
                )
                cur.execute(
                    "DELETE FROM connector_config WHERE connector_name = %s",
                    (connector.name,),
                )
            pg_conn.commit()


# ── search URL grammar (issue #492) ───────────────────────────────────


def test_rental_search_url_delegates_to_the_grammar():
    """_rental_search_url() IS the rental grammar's build() (issue #492)."""
    c = MilanunciosRentalConnector()
    assert c.search_url_grammar is not None
    for geo in ("madrid", "sevilla", "barcelona"):
        assert c._rental_search_url(geo) == c.search_url_grammar.build(
            {"geography": geo}
        )


def test_rental_grammar_is_distinct_from_the_sale_grammar():
    """The rental connector publishes its OWN grammar (alquiler-…), not the
    inherited sale one — the two operations never cross (issue #492)."""
    rental = MilanunciosRentalConnector()
    sale = MilanunciosConnector()
    assert rental.search_url_grammar is not sale.search_url_grammar
    assert "alquiler-de-pisos" in rental.search_url_grammar.build_template
    # The rental grammar rejects a sale URL and the sale grammar rejects a
    # rental URL — the two sources never cross.
    assert (
        rental.search_url_grammar.parse(
            "https://www.milanuncios.com/venta-de-pisos-en-madrid-madrid/"
        )
        is None
    )
    assert (
        sale.search_url_grammar.parse(
            "https://www.milanuncios.com/alquiler-de-pisos-en-madrid-madrid/"
        )
        is None
    )


def test_rental_grammar_round_trip_and_rejects_unequal_halves():
    from etl.tests.grammar_contract import assert_grammar_roundtrip

    c = MilanunciosRentalConnector()
    cases = [{"geography": "madrid"}, {"geography": "sevilla"}]
    foreign = [
        "https://www.habitaclia.com/viviendas-madrid.htm",
        "https://www.milanuncios.com/venta-de-pisos-en-madrid-madrid/",
        "https://www.milanuncios.com/alquiler-de-pisos-en-madrid-toledo/",
    ]
    assert_grammar_roundtrip(
        c.search_url_grammar,
        cases,
        foreign,
        build_real=lambda p: c._rental_search_url(p["geography"]),
    )


def test_rental_grammar_validates():
    from etl.connectors.base import validate_grammar

    validate_grammar(MilanunciosRentalConnector())  # no raise


def test_rental_search_previews_expose_alquiler_operation():
    c = MilanunciosRentalConnector()
    previews = c.search_previews(ConnectorScope(geography="madrid"))
    assert len(previews) == 1
    params = {p.key: p for p in previews[0].params}
    assert params["geography"].value == "madrid"
    assert params["operation"].value == "alquiler"
    assert params["operation"].source == "constant"
    assert set(params) == {"geography", "operation"}
