"""Fixture-based tests for the Milanuncios connector (issue #15, Phase 2.1).

No live network calls — discover()/fetch_detail() are exercised by
monkeypatching requests.get to return saved fixture HTML, mirroring
test_connector_fotocasa.py's pattern.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.geography import UnresolvableGeographyError
from etl.connectors.milanuncios import (
    MilanunciosConnector,
    MilanunciosSoftBlockError,
    _has_soft_block_signature,
    _has_usable_jsonld_property_schema,
)
from etl.connectors.milanuncios_mapping import (
    energy_rating_value,
    extra_features,
    infer_operation,
)

_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.milanuncios.com/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def test_milanuncios_does_not_claim_full_inventory_coverage():
    """Same reasoning as Fotocasa (see docs/architecture/connectors.md):
    discover() only reads page 1 of one sale category (robots.txt disallows
    pagination here too), against inventory in the thousands."""
    assert MilanunciosConnector.discovers_full_inventory is False


class TestRateLimitMeasurement:
    """Issue #179 live measurement, 2026-08-03: production was tripping the
    circuit breaker every run at rate_limit_per_minute=20 (5 successes then
    a permanent soft-block). Measured 6/min directly: identical failure
    signature, ruling out the entire 6-20/min range. See the module
    docstring and rate_limit_per_minute's own comment for the full
    write-up, including what remains unvalidated (the exact safe floor —
    only bounded from above by two real, live-measured failures)."""

    def test_rate_limit_is_well_below_both_measured_failure_points(self):
        """A regression here wouldn't fail loudly — it would silently trip
        the circuit breaker every run again, exactly the production
        symptom this issue exists to fix."""
        assert MilanunciosConnector.rate_limit_per_minute <= 2

    def test_rate_limit_is_stricter_than_fotocasa(self):
        """Deliberately not raised to match Fotocasa's 3/min: Milanuncios
        showed an equal-or-worse block at a pace (10s) Fotocasa's own
        measurement proved safe (20s) — see the module docstring."""
        from etl.connectors.fotocasa import FotocasaConnector

        assert (
            MilanunciosConnector.rate_limit_per_minute
            < FotocasaConnector.rate_limit_per_minute
        )


class TestDiscover:
    def test_discover_finds_external_ids_from_search_page(self):
        html = _read_fixture("milanuncios_sample_search.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert sorted(ids) == ["700000001", "700000002", "700000003"]

    def test_center_based_scope_requests_the_matching_city_not_madrid(self):
        """Issue #71 review finding: the actual request URL a center-based
        (not geography-string) scope produces was never verified end-to-end
        through a real connector — only nearest_city() itself was tested.
        A Sevilla-centered profile must request Sevilla, not Madrid."""
        html = _read_fixture("milanuncios_sample_search.html")
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ) as mock_get:
            MilanunciosConnector().discover(
                ConnectorScope(center=(37.3891, -5.9845), radius_km=15),
                throttle=lambda: None,
            )
        requested_url = mock_get.call_args.args[0]
        assert "sevilla" in requested_url
        assert "madrid" not in requested_url

    def test_unresolvable_center_raises_rather_than_silently_resolving(self):
        """Issue #169: a real center point that matches no known place in
        the shared gazetteer at all must raise — never silently return an
        empty discover() result."""
        connector = MilanunciosConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5)  # Lisbon
        with (
            patch("etl.connectors.milanuncios.requests.get") as mock_get,
            pytest.raises(UnresolvableGeographyError),
        ):
            connector.discover(far, throttle=lambda: None)
        mock_get.assert_not_called()

    def test_scope_key_never_raises_and_uses_a_sentinel_for_unresolvable(self):
        """scope_key() must never raise itself (the orchestrator calls it
        with no try/except) — the unresolvable case above must still
        surface as a distinct, non-None key."""
        connector = MilanunciosConnector()
        far = ConnectorScope(center=(38.7223, -9.1393), radius_km=5)  # Lisbon
        key = connector.scope_key(far)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_discover_raises_on_soft_block_page_not_empty_list(self):
        html = _read_fixture("milanuncios_sample_block_page.html")
        connector = MilanunciosConnector()
        with (
            patch(
                "etl.connectors.milanuncios.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__INITIAL_PROPS__"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )

    def test_discover_raises_soft_block_error_on_real_captured_challenge_page(self):
        """Issue #179: a REAL captured soft-block page (GeeTest CAPTCHA
        challenge, live 2026-08-03 during rate measurement) must raise the
        narrower MilanunciosSoftBlockError, not just the generic
        ConnectorError a structure change would also raise — the two call
        for opposite responses (module docstring)."""
        html = _read_fixture("milanuncios_sample_soft_block_page.html")
        connector = MilanunciosConnector()
        with (
            patch(
                "etl.connectors.milanuncios.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(MilanunciosSoftBlockError),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )

    def test_soft_block_error_is_still_a_connector_error(self):
        """The orchestrator's circuit breaker counts ConnectorError (and any
        exception) toward its error rate without knowing this subclass
        exists — it must keep working exactly as before."""
        assert issubclass(MilanunciosSoftBlockError, ConnectorError)

    def test_discover_handles_present_but_null_adlist_without_crashing(self):
        """Regression: `.get("adList", {})` only supplies the default when the
        key is absent, not when it's present with a null value — a real,
        reproduced AttributeError (Opus review of PR #54), not theoretical."""
        html = _read_fixture("milanuncios_sample_search_null_adlist.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        assert ids == []


class TestFetchDetail:
    def test_fetch_detail_raises_on_removed_ad_page(self):
        """A removed/expired ad page is, today, indistinguishable from a
        soft-block on the marker check alone — both raise ConnectorError
        rather than silently producing an empty/wrong listing. Whether a
        detected removal should instead map to listing_status_event
        'withdrawn' is left as a documented follow-up (see
        docs/architecture/connectors.md) rather than guessed here: nothing
        in the current page content actually distinguishes "blocked" from
        "genuinely gone" without a live sample of each to compare."""
        html = _read_fixture("milanuncios_sample_block_page.html")
        connector = MilanunciosConnector()
        with (
            patch(
                "etl.connectors.milanuncios.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__INITIAL_PROPS__"),
        ):
            connector.fetch_detail("700000001", throttle=lambda: None)

    def test_fetch_detail_raises_soft_block_error_on_real_captured_challenge_page(self):
        """Same distinction as TestDiscover's equivalent — fetch_detail() is
        where issue #179's production failure actually happens (discover()
        itself never showed the block during measurement; only the detail-
        page endpoint did — see rate_limit_per_minute's comment)."""
        html = _read_fixture("milanuncios_sample_soft_block_page.html")
        connector = MilanunciosConnector()
        with (
            patch(
                "etl.connectors.milanuncios.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(MilanunciosSoftBlockError),
        ):
            connector.fetch_detail("700000001", throttle=lambda: None)


class TestSoftBlockSignature:
    """Unit coverage for the marker-matching helper itself, independent of
    discover()/fetch_detail() — issue #179."""

    def test_real_captured_page_matches(self):
        html = _read_fixture("milanuncios_sample_soft_block_page.html")
        assert _has_soft_block_signature(html) is True

    def test_synthetic_removed_ad_page_does_not_match(self):
        """milanuncios_sample_block_page.html is a synthetic stand-in for
        'any page missing the marker' (its own header comment), not a real
        block page — it must NOT trip the soft-block signature, or every
        existing test using it as a generic missing-marker fixture would
        silently start asserting the wrong exception type."""
        html = _read_fixture("milanuncios_sample_block_page.html")
        assert _has_soft_block_signature(html) is False

    def test_a_real_listing_page_does_not_match(self):
        html = _read_fixture("milanuncios_sample_detail.html")
        assert _has_soft_block_signature(html) is False


class TestNormalize:
    def test_normalize_handles_present_but_null_location_without_crashing(self):
        """Regression: `.get("city", {}).get("name")` only supplies the
        default when the key is absent, not when it's present with a null
        value — a real, reproduced AttributeError (Opus review of PR #54),
        not theoretical. Listings pending geocoding legitimately have
        location.city/province/geolocation as null, not missing."""
        html = _read_fixture("milanuncios_sample_detail_null_location.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000004", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.address is None
        assert canonical.lat is None
        assert canonical.lon is None
        assert canonical.listing_kind == "particular"

    def test_normalize_matches_expected_fixture(self):
        """EC-1: fetch_detail + normalize on a saved fixture produce the exact expected output."""
        html = _read_fixture("milanuncios_sample_detail.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000001", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.external_id == "700000001"
        assert canonical.source == "milanuncios"
        assert canonical.current_price == Decimal(1683000)
        assert canonical.property_type == "piso"
        assert canonical.rooms == 4
        assert canonical.bathrooms == 3
        assert canonical.m2_built == Decimal(353)
        assert canonical.floor == "bajo"
        assert canonical.listing_kind == "agency"  # sellerType.isPrivate is False
        assert canonical.lat == Decimal("40.45765381")
        assert canonical.lon == Decimal("-3.65063234")
        assert canonical.address == "Madrid, Madrid"
        assert len(canonical.photo_urls) == 2
        assert canonical.photo_urls[0].startswith("https://")
        assert canonical.raw_extra["origin"]["provider"] == "fotocasa_pro"
        # issue #78 retrofit: city/province promoted to real columns
        # (previously only flattened into `address`); energyCertificate
        # surfaced (a real attribute the original Phase 2.1 spike's
        # smaller sample missed); heating/hotWater surfaced into
        # `features` since they aren't first-class columns; operation
        # derived from category.slug, not hardcoded.
        assert canonical.city == "Madrid"
        assert canonical.province == "Madrid"
        assert canonical.postal_code is None
        assert canonical.energy_rating == "E"
        assert canonical.has_elevator is None
        assert canonical.year_built is None
        assert canonical.m2_plot is None
        assert canonical.operation == "sale"
        # features are short slug tokens ("<type>_<value>"), not
        # "<label>: <value>" strings — data-model.md documents `features`
        # for containment queries (`features @> ARRAY[...]`), which a
        # sentence-like string can't satisfy (Opus review, PR #85).
        assert "heating_natural_gas" in canonical.features
        assert "hot_water_natural_gas" in canonical.features
        # squareMeterPrice is real data that was wrongly excluded from both
        # a column and `features` (Opus review, PR #85) — now flows through.
        assert "square_meter_price_4768" in canonical.features
        # attributes already mapped to first-class columns must not also
        # appear in `features` (would duplicate bedrooms/bathrooms/etc.)
        assert not any(f.startswith("bedrooms_") for f in canonical.features)

    def test_normalize_infers_particular_from_explicit_boolean(self):
        """Unlike Fotocasa, Milanuncios publishes sellerType.isPrivate directly
        — no URL/name heuristic needed (see milanuncios_mapping.py)."""
        html = _read_fixture("milanuncios_sample_detail_private_with_phone.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000099", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.listing_kind == "particular"

    def test_normalize_captures_full_description_including_embedded_phone(self):
        """Private-seller listings often embed a real phone number in free
        text (confirmed live: 4/17 sampled listings during the feasibility
        spike) — normalize() must not truncate description, since task 2.2's
        dedup phone-extraction signal depends on the full text being there."""
        html = _read_fixture("milanuncios_sample_detail_private_with_phone.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000099", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert "685451010" in (canonical.description or "")

    def test_normalize_uses_raw_numeric_value_not_formatted_string_for_m2(self):
        """Regression test for a real bug found during implementation:
        attribute_value() prefers valueFormatted ("353 m2"), which Decimal()
        can't parse — m2_built silently came back None. Fixed by adding
        attribute_numeric_value() for numeric fields. See
        etl/connectors/milanuncios_mapping.py."""
        html = _read_fixture("milanuncios_sample_detail.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000001", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.m2_built is not None
        assert canonical.m2_built == Decimal(353)


class TestPriceChangeHistory:
    def test_price_change_between_fetches_produces_different_canonical_prices(self):
        """EC (connector half, mirroring task 1.4's equivalent test): two
        fetches of the same external_id with a changed price normalize to
        two different current_price values — the orchestrator (already
        tested against real Postgres in test_orchestrator.py using
        DummyConnector) is what turns that into an appended
        listing_price_history row."""
        connector = MilanunciosConnector()
        html_before = _read_fixture("milanuncios_sample_detail.html")
        html_after = _read_fixture("milanuncios_sample_detail_price_changed.html")

        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html_before),
        ):
            price_before = connector.normalize(
                connector.fetch_detail("700000001", throttle=lambda: None)
            ).current_price
        with patch(
            "etl.connectors.milanuncios.requests.get",
            return_value=_mock_response(html_after),
        ):
            price_after = connector.normalize(
                connector.fetch_detail("700000001", throttle=lambda: None)
            ).current_price

        assert price_before == Decimal(1683000)
        assert price_after == Decimal(1650000)
        assert price_before != price_after


class TestInferOperation:
    """Issue #78: derive sale-vs-rent from each listing's own category.slug,
    not a blanket hardcode from the discovery URL alone (Milanuncios is a
    general classifieds site, not a dedicated real-estate portal — a stray
    miscategorized listing is a real, if rare, possibility)."""

    def test_venta_prefix_is_sale(self):
        assert infer_operation("venta-de-pisos") == "sale"
        assert infer_operation("venta-de-terrenos") == "sale"

    def test_alquiler_prefix_is_rent(self):
        assert infer_operation("alquiler-de-pisos") == "rent"

    def test_unrecognized_or_missing_slug_is_none(self):
        assert infer_operation("garajes") is None
        assert infer_operation(None) is None
        assert infer_operation("") is None

    def test_unrecognized_nonempty_slug_logs_a_warning(self, caplog):
        """Opus review, PR #85, must-fix: the orchestrator's INSERT path
        COALESCEs a None operation to 'sale' with zero indication anything
        was uncertain — so a genuinely unrecognized (non-empty) category
        must at least be visible in logs, distinguishing "we don't
        understand this category" from every other unhandled case that
        also ends up as the same default."""
        with caplog.at_level("WARNING", logger="etl.connectors.milanuncios_mapping"):
            result = infer_operation("traspasos-de-negocios")
        assert result is None
        assert any(
            "traspasos-de-negocios" in record.message for record in caplog.records
        )

    def test_missing_or_empty_slug_does_not_warn(self, caplog):
        """A missing/empty slug is a normal, expected case (e.g. a
        malformed listing) — only a genuinely unrecognized *non-empty*
        slug is the miscategorization signal worth a warning."""
        with caplog.at_level("WARNING", logger="etl.connectors.milanuncios_mapping"):
            infer_operation(None)
            infer_operation("")
        assert caplog.records == []

    def test_end_to_end_unrecognized_category_yields_none_not_silent_sale(self):
        """End-to-end at the connector boundary (not just the mapping
        function in isolation): a listing whose category can't be mapped
        to sale/rent produces `canonical.operation is None`, not a
        silently-defaulted 'sale' — the orchestrator's own COALESCE-to-
        'sale' default is a separate, shared, schema-level concern (issue
        #76) this connector doesn't need to (and shouldn't) pre-empt."""
        html = _read_fixture("milanuncios_sample_detail_unrecognized_category.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000003", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.operation is None


class TestExtraFeatures:
    """Issue #78 / #76: surface attributes not already mapped to a
    first-class column into `property.features` as short slug tokens
    (`"<type>_<value>"`), mirroring property_web_scraper's features-array
    concept — not their code, and not the original "<label>: <value>"
    human-readable strings (Opus review, PR #85: `data-model.md` documents
    `features` for containment queries `features @> ARRAY[...]`, which a
    sentence-like string can't satisfy)."""

    def test_maps_unmapped_attributes_to_slug_tokens(self):
        attributes = [
            {
                "type": "heating",
                "fieldFormatted": "calefaccion",
                "value": "natural_gas",
                "valueFormatted": "gas natural",
            },
            {
                "type": "hotWater",
                "fieldFormatted": "agua caliente",
                "value": "natural_gas",
                "valueFormatted": "gas natural",
            },
        ]
        assert extra_features(attributes) == (
            "heating_natural_gas",
            "hot_water_natural_gas",
        )

    def test_excludes_attributes_already_mapped_to_columns(self):
        attributes = [
            {
                "type": "bedrooms",
                "fieldFormatted": "dormitorios",
                "value": "2",
                "valueFormatted": "2",
            },
            {
                "type": "energyCertificate",
                "fieldFormatted": "certificado",
                "value": "e",
                "valueFormatted": "E",
            },
            {
                "type": "heating",
                "fieldFormatted": "calefaccion",
                "value": "gas",
                "valueFormatted": "gas",
            },
        ]
        assert extra_features(attributes) == ("heating_gas",)

    def test_square_meter_price_is_no_longer_excluded(self):
        """Opus review, PR #85, must-fix: squareMeterPrice was wrongly
        listed as "already surfaced as a first-class column" — no such
        column exists anywhere in base.py/init.sql, so real data was being
        silently dropped from both a column and `features` for no reason."""
        attributes = [
            {
                "type": "squareMeterPrice",
                "fieldFormatted": "precio por metro cuadrado",
                "value": "4768",
                "valueFormatted": "4.768 €/m2",
            }
        ]
        assert extra_features(attributes) == ("square_meter_price_4768",)

    def test_empty_or_malformed_attributes_yield_empty_tuple(self):
        assert extra_features([]) == ()
        assert extra_features([{"type": "heating"}]) == ()  # no raw value
        assert extra_features([{"not_a_type_key": "x"}]) == ()


class TestEnergyRatingValue:
    """Opus review, PR #85, nice-to-have: prefer a bare A-G letter (for
    consistency with Fotocasa's energy_rating format) over Milanuncios'
    own non-letter formatted states ("En trámite"/"Exento")."""

    def test_bare_letter_value_is_uppercased(self):
        attributes = [
            {"type": "energyCertificate", "value": "e", "valueFormatted": "E"}
        ]
        assert energy_rating_value(attributes) == "E"

    def test_non_letter_state_falls_back_to_formatted_text(self):
        attributes = [
            {
                "type": "energyCertificate",
                "value": "pending",
                "valueFormatted": "En trámite",
            }
        ]
        assert energy_rating_value(attributes) == "En trámite"

    def test_absent_attribute_is_none(self):
        assert energy_rating_value([]) is None


class TestDescriptionStatFallback:
    """Issue #78 must-fix (Opus review, PR #85): rooms/bathrooms/m2_built
    must recover from the free-text description when `ad.attributes`
    doesn't carry them — proven end-to-end, not just that the fallback
    getters exist as dead code."""

    def test_fallback_recovers_stats_when_attributes_are_missing(self):
        html = _read_fixture("milanuncios_sample_detail_stats_from_description.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000002", throttle=lambda: None)
        canonical = connector.normalize(raw)
        # None of these are in this fixture's `ad.attributes` — every one
        # must come from regex-parsing "92,5 m2 construidos ... 3
        # habitaciones y 2 banios" in the description.
        assert canonical.rooms == 3
        assert canonical.bathrooms == 2
        assert canonical.m2_built == Decimal(92)


class TestJsonLdIsNotAUsableSource:
    """Codifies issue #78's live finding (JSON-LD on real Milanuncios pages
    is BreadcrumbList-only) as an executable check, not a comment-only
    claim (Opus review, PR #85)."""

    def test_breadcrumb_only_jsonld_is_not_usable(self):
        html = _read_fixture("milanuncios_sample_detail.html")
        assert _has_usable_jsonld_property_schema(html) is False

    def test_a_real_property_schema_would_be_recognized(self):
        html = (
            '<html><head><script type="application/ld+json">'
            '{"@context":"https://schema.org","@type":"Apartment","name":"x"}'
            "</script></head><body></body></html>"
        )
        assert _has_usable_jsonld_property_schema(html) is True

    def test_no_jsonld_at_all_is_not_usable(self):
        assert _has_usable_jsonld_property_schema("<html><body></body></html>") is False


class TestNormalizeWithoutEnergyCertificate:
    def test_energy_rating_is_none_when_attribute_absent(self):
        """Not every real listing carries energyCertificate (1 of 3 sampled
        during the issue #78 spike didn't) — must degrade to None cleanly,
        not raise."""
        html = _read_fixture("milanuncios_sample_detail_private_with_phone.html")
        connector = MilanunciosConnector()
        with patch(
            "etl.connectors.milanuncios.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("700000099", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.energy_rating is None
        assert canonical.features == ()
