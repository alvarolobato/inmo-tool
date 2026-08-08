"""Fixture-based tests for the Cimenta2 connector (issue #136, D-035).

Sitemap fixtures are trimmed captures of the **public, robots-allowed
sitemap** at `inmuebles.cimenta2.com`. The detail-fetch fixtures
(`cimenta2_sample_shell.html`, `cimenta2_sample_getrecord.json`) are
**synthetic** — real Salesforce field API names, but entirely invented
values, and NO real endpoint URL (D-035).

No live network in any test: `requests.get`/`requests.post` are patched
everywhere. An autouse fixture forces the public-safe defaults (no endpoint,
no internal fields) so the owner's ambient local config can never turn a
discovery-only test into a live fetch; detail tests opt in explicitly via
patched config accessors and the fake endpoint.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests

from etl.connectors.base import ConnectorError, ConnectorScope, SoftBlockError
from etl.connectors.cimenta2 import (
    _ASSET_SITEMAP_DEFAULT_URL,
    _BASE_URL,
    _SITEMAP_INDEX_URL,
    Cimenta2Connector,
    Cimenta2SoftBlockError,
)
from etl.connectors.cimenta2_mapping import (
    OWNER_CONTACT_KEYS,
    asset_sitemap_url,
    has_soft_block_signature,
    http_status_is_soft_block,
    parse_asset_url,
    post_response_is_soft_block,
    record_id_from_url,
    reference_code_from_url,
    shell_is_soft_block,
)
from etl.connectors.geography import UnresolvableGeographyError

FIXTURES = Path(__file__).parent / "fixtures"

# A fake endpoint — never the real one, which is injected via config and appears
# in ZERO committed files (D-035). Tests set this via patched config accessors.
_FAKE_ENDPOINT = "https://example.test/inmuebles/s/sfsites/aura"

# Invented owner-contact values present in the synthetic getRecord fixture; the
# connector must never surface any of them. Kept here so the negative assertion
# reads explicitly rather than re-deriving them from the fixture.
_OWNER_CONTACT_VALUES = (
    "Fulano De Tal",
    "00000000X",
    "600123456",
    "ES0000000000000000000000",
    "Secretville",
)


@pytest.fixture(autouse=True)
def _cimenta2_config_defaults():
    """Force the public-safe defaults (no endpoint, no internal fields) for
    every test unless it explicitly opts in.

    Without this, the owner's ambient local config (`~/.config/inmo-tool/.env`,
    which may carry the real endpoint) would turn a discovery-only test into a
    live network fetch when the suite runs on the owner's machine.
    """
    with (
        patch("etl.config.cimenta2_detail_endpoint", return_value=""),
        patch("etl.config.cimenta2_include_internal", return_value=False),
    ):
        yield


# Five real sitemap entries, copied verbatim from the live
# `sitemap-ga_activo__c-1.xml` capture, with the record id and reference
# code each URL resolves to. This is the connector's acceptance evidence:
# there is no detail page to spot-check, so "5 real listings parse
# correctly" becomes "5 real sitemap entries resolve to the right
# external_id and reference_code".
REAL_ENTRIES = [
    (
        "https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/a0v3X00000dwiQQQAY/90817",
        "a0v3X00000dwiQQQAY",
        "90817",
    ),
    (
        "https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/a0v3X00000eYvmwQAC/1263",
        "a0v3X00000eYvmwQAC",
        "1263",
    ),
    (
        "https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/a0vP8000007lcfKIAQ/100024",
        "a0vP8000007lcfKIAQ",
        "100024",
    ),
    (
        "https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/a0vP800000RRtyXIAT/td220030",
        "a0vP800000RRtyXIAT",
        "td220030",
    ),
    (
        "https://inmuebles.cimenta2.com/inmuebles/s/ga-activo/a0v3X00000eYxMdQAK/207",
        "a0v3X00000eYxMdQAK",
        "207",
    ),
]

MADRID_SCOPE = ConnectorScope(center=(40.4168, -3.7038), radius_km=25)
MALAGA_SCOPE = ConnectorScope(center=(36.7213, -4.4214), radius_km=25)


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, status: int = 200):
    class _R:
        def __init__(self) -> None:
            self.text = text
            self.status_code = status

        def raise_for_status(self) -> None:
            return None

    return _R()


def _sitemap_side_effect(index_fixture: str, child_fixture: str):
    """Serve the index fixture for the index URL, the child for anything else.

    Deliberately keyed on the URL rather than call order so a test can also
    assert *which* URLs were requested.
    """

    def _get(url, **_kwargs):
        if url == _SITEMAP_INDEX_URL:
            return _mock_response(_fixture(index_fixture))
        return _mock_response(_fixture(child_fixture))

    return _get


def _discovered(connector: Cimenta2Connector, scope=MADRID_SCOPE, **kwargs):
    side_effect = _sitemap_side_effect(
        kwargs.pop("index_fixture", "cimenta2_sample_sitemap_index.xml"),
        kwargs.pop("child_fixture", "cimenta2_sample_sitemap_activo.xml"),
    )
    with patch("etl.connectors.cimenta2.requests.get", side_effect=side_effect) as get:
        ids = connector.discover(scope, throttle=lambda: None)
    return ids, get


def _shell_get(url, **_kwargs):
    return _mock_response(_fixture("cimenta2_sample_shell.html"))


def _getrecord_post(url, **_kwargs):
    return _mock_response(_fixture("cimenta2_sample_getrecord.json"))


def _fetch_detail_with_endpoint(
    connector,
    external_id="a0v3X00000dwiQQQAY",
    *,
    include_internal=False,
    get_side=_shell_get,
    post_side=_getrecord_post,
):
    """Run fetch_detail + normalize with the endpoint configured to the fake URL.

    `connector` must already have been through `_discovered()` so `_assets` is
    populated. Returns (raw, canonical, post_mock).
    """
    with (
        patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
        patch("etl.config.cimenta2_include_internal", return_value=include_internal),
        patch("etl.connectors.cimenta2.requests.get", side_effect=get_side),
        patch("etl.connectors.cimenta2.requests.post", side_effect=post_side) as post,
    ):
        raw = connector.fetch_detail(external_id, throttle=lambda: None)
        canonical = connector.normalize(raw)
    return raw, canonical, post


class TestDiscover:
    def test_enumerates_every_asset_in_the_sitemap(self):
        ids, _ = _discovered(Cimenta2Connector())
        assert len(ids) == 14
        assert ids == sorted(ids), "external_ids must be returned sorted"
        assert len(set(ids)) == len(ids), "external_ids must be unique"

    def test_five_real_entries_resolve_to_the_right_id_and_reference(self):
        connector = Cimenta2Connector()
        ids, _ = _discovered(connector)
        for url, record_id, reference in REAL_ENTRIES:
            assert record_id in ids, f"{record_id} missing from discover()"
            assert connector._assets[record_id] == (url, reference)

    def test_uses_the_record_id_not_the_reference_code_as_external_id(self):
        # The reference code is a Cajamar-side business identifier; the
        # record id is what the URL is addressed by and what `listing`'s
        # UNIQUE (source, external_id) should key on.
        ids, _ = _discovered(Cimenta2Connector())
        assert "a0v3X00000dwiQQQAY" in ids
        assert "90817" not in ids

    def test_fetches_the_index_then_the_child_sitemap_only(self):
        _, get = _discovered(Cimenta2Connector())
        requested = [call.args[0] for call in get.call_args_list]
        assert requested == [
            _SITEMAP_INDEX_URL,
            f"{_BASE_URL}/inmuebles/s/sitemap-ga_activo__c-1.xml",
        ]

    def test_raises_rather_than_reporting_an_empty_inventory_on_an_interstitial(
        self,
    ):
        # discovers_full_inventory is True, so a silent [] would be read as
        # "all 3,917 assets withdrawn" after three sweeps.
        with pytest.raises(ConnectorError, match="no <loc> entries"):
            _discovered(
                Cimenta2Connector(),
                child_fixture="cimenta2_sample_interstitial.html",
            )

    def test_raises_when_no_loc_matches_the_asset_url_shape(self):
        with pytest.raises(ConnectorError, match="URL scheme has likely changed"):
            _discovered(
                Cimenta2Connector(),
                child_fixture="cimenta2_sample_sitemap_activo_unrecognised_shape.xml",
            )

    def test_a_failed_sweep_leaves_the_previous_cache_untouched(self):
        connector = Cimenta2Connector()
        _discovered(connector)
        before = dict(connector._assets)
        with pytest.raises(ConnectorError):
            _discovered(connector, child_fixture="cimenta2_sample_interstitial.html")
        assert connector._assets == before


class TestChildSitemapFallbackChain:
    """`asset_sitemap_url`'s three getters — issue #136's "at least one field
    has a working fallback chain, proven where the primary path is absent"."""

    def test_primary_picks_the_numbered_partition(self):
        url = asset_sitemap_url(
            _fixture("cimenta2_sample_sitemap_index.xml"),
            base_url=_BASE_URL,
            default_url=_ASSET_SITEMAP_DEFAULT_URL,
        )
        assert url.endswith("sitemap-ga_activo__c-1.xml")

    def test_falls_back_to_the_weekly_variant_when_the_partition_is_absent(self):
        # Live-verified as the same complete 3,917-URL set, not a delta —
        # which is what makes this a safe fallback for a full-inventory
        # connector rather than a quietly partial sweep.
        url = asset_sitemap_url(
            _fixture("cimenta2_sample_sitemap_index_weekly_only.xml"),
            base_url=_BASE_URL,
            default_url=_ASSET_SITEMAP_DEFAULT_URL,
        )
        assert url.endswith("sitemap-ga_activo__c-weekly.xml")

    def test_falls_back_to_the_well_known_url_when_the_index_lists_neither(self):
        url = asset_sitemap_url(
            _fixture("cimenta2_sample_sitemap_index_no_activo.xml"),
            base_url=_BASE_URL,
            default_url=_ASSET_SITEMAP_DEFAULT_URL,
        )
        assert url == _ASSET_SITEMAP_DEFAULT_URL

    def test_discover_still_works_end_to_end_on_the_weekly_fallback(self):
        ids, get = _discovered(
            Cimenta2Connector(),
            index_fixture="cimenta2_sample_sitemap_index_weekly_only.xml",
        )
        assert len(ids) == 14
        requested = [call.args[0] for call in get.call_args_list]
        assert requested[1].endswith("sitemap-ga_activo__c-weekly.xml")

    def test_relative_loc_is_resolved_against_the_base_url(self):
        index = (
            "<sitemapindex><sitemap><loc>"
            "/inmuebles/s/sitemap-ga_activo__c-1.xml"
            "</loc></sitemap></sitemapindex>"
        )
        assert (
            asset_sitemap_url(
                index, base_url=_BASE_URL, default_url=_ASSET_SITEMAP_DEFAULT_URL
            )
            == f"{_BASE_URL}/inmuebles/s/sitemap-ga_activo__c-1.xml"
        )


class TestReferenceCodeFallbackChain:
    """`reference_code_from_url`'s strict-then-tolerant chain.

    The tolerant getter earns its place because this connector sets
    discovers_full_inventory = True: a cosmetic URL change (a trailing
    slash, a tracking query) would make a strict-only parser fail on every
    URL at once, which reads as a total withdrawal rather than a parsing
    regression.
    """

    @pytest.mark.parametrize("url,record_id,reference", REAL_ENTRIES)
    def test_strict_shape_on_real_entries(self, url, record_id, reference):
        assert record_id_from_url(url) == record_id
        assert reference_code_from_url(url) == reference
        assert parse_asset_url(url) == (record_id, reference)

    def test_fallback_recovers_when_a_trailing_slash_breaks_the_strict_shape(self):
        strict_url = REAL_ENTRIES[0][0]
        assert reference_code_from_url(strict_url + "/") == "90817"

    def test_fallback_recovers_from_a_query_string_and_fragment(self):
        strict_url = REAL_ENTRIES[0][0]
        assert reference_code_from_url(f"{strict_url}?utm_source=x#top") == "90817"
        assert record_id_from_url(f"{strict_url}?utm_source=x#top") == (
            "a0v3X00000dwiQQQAY"
        )

    def test_a_slugless_url_yields_no_reference_rather_than_the_record_id(self):
        # Seeding the dedup engine's reference_code signal with a Salesforce
        # record id would be a wrong value presented as data.
        url = f"{_BASE_URL}/inmuebles/s/ga-activo/a0v3X00000dwiQQQAY"
        assert parse_asset_url(url) is None

    def test_non_asset_urls_are_ignored_rather_than_raising(self):
        expediente = (
            f"{_BASE_URL}/inmuebles/s/inv-expediente/a4h3X000000LNJlQAO/"
            "chalet-antas-almeria"
        )
        assert parse_asset_url(expediente) is None
        assert record_id_from_url(expediente) is None

    def test_percent_encoded_reference_is_decoded(self):
        url = f"{_BASE_URL}/inmuebles/s/ga-activo/a0v3X00000dwiQQQAY/90%2D817"
        assert reference_code_from_url(url) == "90-817"


class TestFetchDetailNeverTouchesTheNetwork:
    """The core safety property of this connector (D-033).

    `fetch_detail` returns what `discover()` already parsed out of the
    sitemap URL. If a future change ever makes it issue a request, these
    tests fail loudly.
    """

    def test_makes_no_http_request_at_all(self):
        connector = Cimenta2Connector()
        _discovered(connector)

        def _explode(*_args, **_kwargs):
            raise AssertionError(
                "cimenta2.fetch_detail must never make a network request "
                "(D-033) — the only detail channel is the guest endpoint "
                "this connector exists specifically not to use"
            )

        with patch("etl.connectors.cimenta2.requests.get", side_effect=_explode):
            raw = connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)
        assert raw.raw["reference_code"] == "90817"
        assert raw.source == "cimenta2"

    def test_does_not_consume_the_rate_limiter(self):
        # The orchestrator does not acquire around fetch_detail; the
        # connector's own throttle() call is the pacing mechanism. Calling it
        # for a zero-request method would serialise 3,917 no-ops at 20/min.
        connector = Cimenta2Connector()
        _discovered(connector)
        calls = []
        connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: calls.append(1))
        assert calls == []

    def test_raises_for_an_id_discover_never_saw(self):
        connector = Cimenta2Connector()
        with pytest.raises(ConnectorError, match="no discovered asset"):
            connector.fetch_detail("a0vNOTREAL00000AAA", throttle=lambda: None)


class TestNormalize:
    def _canonical(self, external_id="a0v3X00000dwiQQQAY"):
        connector = Cimenta2Connector()
        _discovered(connector)
        raw = connector.fetch_detail(external_id, throttle=lambda: None)
        return connector.normalize(raw)

    def test_populates_only_what_the_slug_honestly_encodes(self):
        canonical = self._canonical()
        assert canonical.external_id == "a0v3X00000dwiQQQAY"
        assert canonical.source == "cimenta2"
        assert canonical.url == REAL_ENTRIES[0][0]
        assert canonical.reference_code == "90817"
        assert canonical.operation == "sale"
        assert canonical.status == "active"
        assert canonical.listing_kind == "agency"

    def test_every_detail_only_field_is_null(self):
        # These are null because their only source is the D-033 channel.
        # If this test starts failing, someone has added a detail fetch.
        canonical = self._canonical()
        assert canonical.current_price is None
        assert canonical.description is None
        assert canonical.photo_urls == ()
        assert canonical.contact_raw is None
        assert canonical.address is None
        assert canonical.lat is None
        assert canonical.lon is None
        assert canonical.property_type is None
        assert canonical.m2_built is None
        assert canonical.m2_useful is None
        assert canonical.m2_plot is None
        assert canonical.rooms is None
        assert canonical.bathrooms is None
        assert canonical.floor is None
        assert canonical.has_elevator is None
        assert canonical.year_built is None
        assert canonical.energy_rating is None
        assert canonical.features == ()
        assert canonical.cadastral_ref is None

    def test_city_and_province_are_null_not_guessed_from_a_sibling_sitemap(self):
        # The expediente/agrupacion sitemaps carry geography slugs, but they
        # describe multi-asset case files and parse to a municipality only
        # ~44% of the time — see the module docstring's measurements.
        canonical = self._canonical()
        assert canonical.city is None
        assert canonical.province is None
        assert canonical.postal_code is None

    def test_raw_extra_records_that_this_row_is_index_only(self):
        canonical = self._canonical()
        assert canonical.raw_extra["discovery"] == "sitemap-index-only"
        assert canonical.raw_extra["detail_fetched"] is False
        assert (
            canonical.raw_extra["detail_unavailable_reason"]
            == "detail-endpoint-not-configured"
        )
        assert canonical.raw_extra["detail_url"] == REAL_ENTRIES[0][0]

    def test_alphanumeric_reference_codes_survive(self):
        canonical = self._canonical("a0vP800000RRtyXIAT")
        assert canonical.reference_code == "td220030"


class TestReferenceCodeIsTheOnlyPriceRoute:
    """Price does not come from this connector; it comes from a dedup-linked
    twin on a portal that publishes one (D-034).

    These tests pin the *ceiling* of that mechanism against the real signal
    module, so the docstring's claim cannot quietly drift away from the
    code it describes.
    """

    def _record(self, **overrides):
        """A ListingRecord shaped exactly like a persisted Cimenta2 row.

        The defaults are the point: every field this connector cannot
        populate is None, which is what caps the signal at its
        uncorroborated tier.
        """
        from etl.dedup.types import ListingRecord

        base = {
            "listing_id": 1,
            "property_id": 1,
            "source": "cimenta2",
            "external_id": "a0v3X00000dwiQQQAY",
            "listing_kind": "agency",
            "description": None,
            "photo_urls": (),
            "cadastral_ref": None,
            "address": None,
            "lat": None,
            "lon": None,
            "m2_built": None,
            "current_price": None,
            "contact_raw": None,
            "reference_code": "90817",
        }
        base.update(overrides)
        return ListingRecord(**base)

    def test_every_discovered_asset_carries_a_reference_code(self):
        # The dedup key has to be present on every row for the linkage to
        # have any chance of firing.
        connector = Cimenta2Connector()
        _discovered(connector)
        for external_id in connector._assets:
            raw = connector.fetch_detail(external_id, throttle=lambda: None)
            assert connector.normalize(raw).reference_code

    def test_a_shared_code_with_a_priced_twin_suggests_but_never_merges(self):
        # The whole price-inheritance story, pinned: a Cimenta2 row and a
        # priced listing elsewhere sharing a reference code produce a
        # human-confirmable suggestion, not an automatic merge, because this
        # connector publishes no coordinates, size, price or contact to
        # corroborate with.
        from decimal import Decimal

        from etl.dedup.signals import reference_code as signal

        cimenta2 = self._record()
        priced_twin = self._record(
            listing_id=2,
            property_id=2,
            source="fotocasa",
            external_id="99",
            lat=Decimal("36.7213"),
            lon=Decimal("-4.4214"),
            m2_built=Decimal(80),
            current_price=Decimal(120000),
            contact_raw="Some Agency",
        )
        evaluation = signal.evaluate(cimenta2, priced_twin)
        assert evaluation is not None, "reference codes should match"
        assert evaluation.decision == "suggest"
        assert evaluation.confidence == Decimal("0.500")

    def test_the_two_short_codes_are_stored_even_though_dedup_ignores_them(self):
        # 3,915 of the 3,917 live codes clear the signal's _MIN_CODE_LENGTH;
        # the two 3-character ones do not. Storing them is still correct —
        # rejecting a low-cardinality value is the dedup layer's call, not
        # the connector's.
        from etl.dedup.signals import reference_code as signal

        connector = Cimenta2Connector()
        _discovered(connector)
        raw = connector.fetch_detail("a0v3X00000eYxMdQAK", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.reference_code == "207"

        short_a = self._record(reference_code="207")
        short_b = self._record(listing_id=2, property_id=2, reference_code="207")
        assert signal.evaluate(short_a, short_b) is None


class TestScopeKey:
    def test_every_resolvable_scope_collapses_to_one_national_sweep(self):
        # Load-bearing: the orchestrator dedupes scopes by this key, so N
        # active profiles cause one sitemap sweep, not N identical ones.
        connector = Cimenta2Connector()
        assert connector.scope_key(MADRID_SCOPE) == connector.scope_key(MALAGA_SCOPE)
        assert connector.scope_key(MADRID_SCOPE) == "national"

    def test_free_text_geography_also_resolves_nationally(self):
        connector = Cimenta2Connector()
        assert connector.scope_key(ConnectorScope(geography="madrid")) == "national"

    def test_a_scope_naming_nowhere_has_no_coverage(self):
        connector = Cimenta2Connector()
        assert connector.scope_key(ConnectorScope()) is None

    def test_unresolvable_center_becomes_the_sentinel_not_none(self):
        # None would put the scope back on the silent "no coverage" path
        # issue #169 exists to eliminate; the sentinel routes it into
        # discover(), which raises and records a real failure.
        connector = Cimenta2Connector()
        mid_atlantic = ConnectorScope(center=(35.0, -40.0), radius_km=5)
        key = connector.scope_key(mid_atlantic)
        assert key is not None
        assert key.startswith("unresolvable-geography:")

    def test_discover_raises_on_an_unresolvable_center(self):
        connector = Cimenta2Connector()
        mid_atlantic = ConnectorScope(center=(35.0, -40.0), radius_km=5)
        with pytest.raises(UnresolvableGeographyError):
            _discovered(connector, scope=mid_atlantic)


class TestPersistsToRealPostgres:
    """A `normalize()`-only assertion cannot catch a value the schema
    rejects (PR #138's lesson). This connector's specific exposure is the
    opposite of the usual one: it writes a row where nearly every column is
    NULL, so what has to be proven is that the schema genuinely tolerates a
    price-less, coordinate-less listing rather than rejecting it.
    """

    def test_a_price_less_coordinate_less_listing_round_trips(self, pg_conn):
        from etl import orchestrator

        sql = (Path(__file__).parent.parent / "schema" / "init.sql").read_text(
            encoding="utf-8"
        )
        with pg_conn.cursor() as cur:
            cur.execute(sql)
        pg_conn.commit()

        connector = Cimenta2Connector()
        _discovered(connector)
        raw = connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)
        canonical = connector.normalize(raw)

        try:
            orchestrator._upsert_canonical_listing(pg_conn, canonical)

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT l.reference_code, l.current_price, l.operation, "
                    "       l.status, l.listing_kind, l.url, "
                    "       p.lat, p.lon, p.city, p.province, p.property_type "
                    "  FROM listing l JOIN property p ON p.id = l.property_id "
                    " WHERE l.source = %s AND l.external_id = %s",
                    ("cimenta2", "a0v3X00000dwiQQQAY"),
                )
                row = cur.fetchone()

            assert row is not None, "listing did not persist"
            (
                reference_code,
                current_price,
                operation,
                status,
                listing_kind,
                url,
                lat,
                lon,
                city,
                province,
                property_type,
            ) = row
            assert reference_code == "90817"
            assert current_price is None
            assert operation == "sale"
            assert status == "active"
            assert listing_kind == "agency"
            assert url == REAL_ENTRIES[0][0]
            assert lat is None
            assert lon is None
            assert city is None
            assert province is None
            assert property_type is None
        finally:
            with pg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM listing_status_event WHERE listing_id IN "
                    "(SELECT id FROM listing WHERE source = 'cimenta2')"
                )
                cur.execute(
                    "DELETE FROM listing_price_history WHERE listing_id IN "
                    "(SELECT id FROM listing WHERE source = 'cimenta2')"
                )
                cur.execute(
                    "CREATE TEMP TABLE _cim_props ON COMMIT DROP AS "
                    "SELECT property_id FROM listing WHERE source = 'cimenta2'"
                )
                cur.execute("DELETE FROM listing WHERE source = 'cimenta2'")
                cur.execute(
                    "DELETE FROM property WHERE id IN "
                    "(SELECT property_id FROM _cim_props)"
                )
            pg_conn.commit()


class TestRegistration:
    def test_registered_and_born_disabled_capable(self):
        from etl.connectors import register_all
        from etl.orchestrator import CONNECTORS

        register_all()
        by_name = {c.name: c for c in CONNECTORS}
        assert "cimenta2" in by_name
        connector = by_name["cimenta2"]
        # Justified: discover() reads the complete asset sitemap in one
        # request — no pagination, no cap, no relevance sort — so an asset
        # that stops appearing has genuinely been delisted. The guards in
        # discover() (raise on no-<loc>, raise on unrecognised shape) are
        # what keep this claim safe.
        assert connector.discovers_full_inventory is True
        assert connector.supports_discovery is True
        assert connector.supported_filters == ()

    def test_registration_is_idempotent(self):
        from etl.connectors import register_all
        from etl.orchestrator import CONNECTORS

        register_all()
        register_all()
        assert [c.name for c in CONNECTORS].count("cimenta2") == 1


class TestDetailFetchWhenEndpointConfigured:
    """Config-gated detail fetch (D-035): with the endpoint injected, the
    connector fetches and maps the site's public property fields."""

    def test_normalize_maps_every_property_field(self):
        from decimal import Decimal

        connector = Cimenta2Connector()
        _discovered(connector)
        _, canonical, post = _fetch_detail_with_endpoint(connector)

        assert post.call_count == 1
        assert canonical.reference_code == "TESTREF-4242"
        assert canonical.current_price == Decimal("123450.0")
        assert canonical.address == "Calle Falsa 123"
        assert canonical.city == "Villaejemplo"
        assert canonical.province == "PROVINCIA TEST"
        assert canonical.lat == Decimal("40.1234567")
        assert canonical.lon == Decimal("-3.7654321")
        assert canonical.m2_built == Decimal("95.5")
        assert canonical.m2_useful == Decimal("80.25")
        assert canonical.rooms == 3
        assert canonical.bathrooms == 2
        assert canonical.cadastral_ref == "1234567AB1234C0001DE"
        assert canonical.property_type == "piso"
        assert canonical.energy_rating == "D"
        # url prefers the record's own public web link over the sitemap URL.
        assert canonical.url == "https://example.test/inmueble/4242"
        assert canonical.raw_extra["detail_fetched"] is True
        assert canonical.raw_extra["discovery"] == "sitemap+detail"

    def test_scrapes_the_shell_once_then_posts_getrecord_to_the_endpoint(self):
        connector = Cimenta2Connector()
        _discovered(connector)
        _, _, post = _fetch_detail_with_endpoint(connector)
        # POST target is the configured endpoint with the ?r=1 counter appended.
        assert post.call_args.args[0] == f"{_FAKE_ENDPOINT}?r=1"

    def test_owner_contact_fields_are_never_stored(self):
        # Even with the record carrying them and include_internal ON, none of
        # the owner-contact keys or values may appear in the produced row, its
        # raw_extra, or the transient raw payload.
        connector = Cimenta2Connector()
        _discovered(connector)
        raw, canonical, _ = _fetch_detail_with_endpoint(
            connector, include_internal=True
        )
        haystack = repr(canonical) + repr(canonical.raw_extra) + repr(raw.raw)
        for value in _OWNER_CONTACT_VALUES:
            assert value not in haystack, f"owner-contact value {value!r} leaked"
        for key in OWNER_CONTACT_KEYS:
            assert key not in haystack, f"owner-contact key {key!r} leaked"

    def test_include_internal_off_stores_no_acquisition_cost(self):
        connector = Cimenta2Connector()
        _discovered(connector)
        _, canonical, _ = _fetch_detail_with_endpoint(connector, include_internal=False)
        assert "internal_commercial" not in canonical.raw_extra
        assert "111111.11" not in repr(canonical.raw_extra)

    def test_include_internal_on_stores_internal_in_raw_extra(self):
        connector = Cimenta2Connector()
        _discovered(connector)
        _, canonical, _ = _fetch_detail_with_endpoint(connector, include_internal=True)
        internal = canonical.raw_extra["internal_commercial"]
        assert "GA_CosteDeAdquisicion__c" in internal
        assert "GA_ValorDeTasacion__c" in internal
        # No owner-contact key rides along inside the internal block either.
        for key in OWNER_CONTACT_KEYS:
            assert key not in internal


class TestDetailFetchStaysOffWhenEndpointUnset:
    """The public-safe default: no endpoint => discovery-only, no request."""

    def test_endpoint_unset_makes_no_detail_request_and_leaves_fields_null(self):
        connector = Cimenta2Connector()
        _discovered(connector)

        def _explode(*_args, **_kwargs):
            raise AssertionError(
                "no network request may be made when CIMENTA2_DETAIL_ENDPOINT "
                "is unset — the connector must stay discovery-only"
            )

        # The autouse fixture already forces the endpoint empty; patch both
        # verbs to prove neither is used.
        with (
            patch("etl.connectors.cimenta2.requests.get", side_effect=_explode),
            patch(
                "etl.connectors.cimenta2.requests.post", side_effect=_explode
            ) as post,
        ):
            raw = connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)
            canonical = connector.normalize(raw)

        assert post.call_count == 0
        assert "fields" not in raw.raw
        assert canonical.current_price is None
        assert canonical.lat is None
        assert canonical.raw_extra["detail_fetched"] is False


def _http_error_response(status: int, text: str = ""):
    """A mock whose raise_for_status() raises an HTTPError carrying `status`,
    mirroring how `requests` surfaces a 4xx/5xx (see milanuncios tests)."""
    resp = Mock()
    resp.text = text
    resp.status_code = status
    err = requests.HTTPError(f"{status} Error")
    err.response = Mock(status_code=status, text=text)
    resp.raise_for_status = Mock(side_effect=err)
    return resp


class TestSoftBlockHelpers:
    """Pure classifiers (issue #441): the rate-limit / anti-bot signature split
    that keeps a transient throttle from being read as a structure change."""

    @pytest.mark.parametrize("status", [403, 429])
    def test_bot_block_statuses_are_soft(self, status):
        assert http_status_is_soft_block(status) is True

    @pytest.mark.parametrize("status", [200, 404, 410, 500, 503, None])
    def test_other_statuses_are_not_soft_by_status_alone(self, status):
        assert http_status_is_soft_block(status) is False

    def test_challenge_body_carries_a_soft_block_signature(self):
        assert has_soft_block_signature(_fixture("cimenta2_soft_block.html"))

    def test_a_real_shell_carries_no_soft_block_signature(self):
        assert not has_soft_block_signature(_fixture("cimenta2_sample_shell.html"))

    def test_non_json_post_body_is_a_soft_block(self):
        # An HTML challenge served with HTTP 200 where aura JSON is guaranteed.
        assert post_response_is_soft_block(_fixture("cimenta2_soft_block.html"))

    def test_valid_json_with_an_unexpected_shape_is_not_a_soft_block(self):
        # A genuine structure change stays fatal — it is real JSON, just wrong.
        assert not post_response_is_soft_block('{"actions":[{"state":"ERROR"}]}')

    def test_a_healthy_getrecord_body_is_not_a_soft_block(self):
        assert not post_response_is_soft_block(
            _fixture("cimenta2_sample_getrecord.json")
        )

    def test_shell_without_the_aura_framework_is_a_soft_block(self):
        assert shell_is_soft_block(_fixture("cimenta2_soft_block.html"))

    def test_shell_with_the_aura_framework_is_not_a_soft_block(self):
        # auraFW present but ids unparseable == genuine structure change (fatal).
        assert not shell_is_soft_block(
            "<html><head><script src='/auraFW/javascript/x/other.js'>"
            "</script></head><body>renamed markup</body></html>"
        )


class TestDetailFetchSoftBlockClassification:
    """Issue #441 (D-047): the intermittent breakage is the site rate-limiting
    the long detail sweep, NOT a structure change. Those responses must raise
    Cimenta2SoftBlockError (a SoftBlockError) so a transient burst trips only
    the looser soft-block threshold and is recorded as a clean budget stop —
    never a fatal `circuit_open`/`structure_change` flap.
    """

    def test_looser_soft_block_threshold_is_configured(self):
        # A transient throttle burst mid-sweep must ride through rather than trip
        # the tight fatal threshold and abandon the largest connector's assets.
        c = Cimenta2Connector()
        assert c.circuit_breaker_soft_block_error_rate == 0.75
        assert c.circuit_breaker_soft_block_error_rate >= c.circuit_breaker_error_rate

    def test_soft_block_error_is_a_soft_block_error_subclass(self):
        # So the orchestrator's `except SoftBlockError` / isinstance checks treat
        # it as a clean budget backoff, not a fatal ConnectorError.
        assert issubclass(Cimenta2SoftBlockError, SoftBlockError)

    def test_shell_get_429_is_a_soft_block_not_a_fatal_error(self):
        connector = Cimenta2Connector()
        _discovered(connector)
        with (
            patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
            patch(
                "etl.connectors.cimenta2.requests.get",
                return_value=_http_error_response(429),
            ),
            pytest.raises(Cimenta2SoftBlockError),
        ):
            connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)

    def test_post_403_is_a_soft_block_not_a_fatal_error(self):
        connector = Cimenta2Connector()
        _discovered(connector)
        with (
            patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
            patch("etl.connectors.cimenta2.requests.get", side_effect=_shell_get),
            patch(
                "etl.connectors.cimenta2.requests.post",
                return_value=_http_error_response(403),
            ),
            pytest.raises(Cimenta2SoftBlockError),
        ):
            connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)

    def test_post_200_challenge_page_is_a_soft_block_not_structure_change(self):
        # The critical flapping case: HTTP 200 whose body is an anti-bot
        # interstitial instead of the aura getRecord JSON. Before the fix this
        # hit json.loads -> fatal ConnectorError -> structure_change.
        connector = Cimenta2Connector()
        _discovered(connector)

        def _challenge_post(url, **_kwargs):
            return _mock_response(_fixture("cimenta2_soft_block.html"))

        with (
            patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
            patch("etl.connectors.cimenta2.requests.get", side_effect=_shell_get),
            patch("etl.connectors.cimenta2.requests.post", side_effect=_challenge_post),
            pytest.raises(Cimenta2SoftBlockError),
        ):
            connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)

    def test_shell_200_challenge_page_is_a_soft_block_not_structure_change(self):
        connector = Cimenta2Connector()
        _discovered(connector)

        def _challenge_shell(url, **_kwargs):
            return _mock_response(_fixture("cimenta2_soft_block.html"))

        with (
            patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
            patch("etl.connectors.cimenta2.requests.get", side_effect=_challenge_shell),
            pytest.raises(Cimenta2SoftBlockError),
        ):
            connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)

    def test_genuine_structure_change_stays_a_fatal_connector_error(self):
        # auraFW present but ids unparseable: a real redesign, which MUST stay a
        # fatal ConnectorError (and NOT a soft-block) so it is visible, not
        # silently ridden through forever.
        connector = Cimenta2Connector()
        _discovered(connector)

        def _renamed_shell(url, **_kwargs):
            return _mock_response(
                "<html><head><script src='/auraFW/javascript/abc/other.js'>"
                "</script></head><body>redesigned</body></html>"
            )

        with (
            patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
            patch("etl.connectors.cimenta2.requests.get", side_effect=_renamed_shell),
            pytest.raises(ConnectorError) as excinfo,
        ):
            connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)
        assert not isinstance(excinfo.value, SoftBlockError)

    def test_post_valid_json_wrong_shape_stays_fatal_not_soft_block(self):
        # A real aura response whose shape changed (ERROR state) is a genuine
        # break, not a throttle — it must NOT be reclassified as a soft-block.
        connector = Cimenta2Connector()
        _discovered(connector)

        def _error_post(url, **_kwargs):
            return _mock_response('{"actions":[{"id":"1;a","state":"ERROR"}]}')

        with (
            patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
            patch("etl.connectors.cimenta2.requests.get", side_effect=_shell_get),
            patch("etl.connectors.cimenta2.requests.post", side_effect=_error_post),
            pytest.raises(ConnectorError) as excinfo,
        ):
            connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)
        assert not isinstance(excinfo.value, SoftBlockError)


class TestFrameworkIdRefreshOnExpiry:
    """The stale-fwuid self-heal path (issue #441). Live-verified that this
    endpoint's getRecord ignores fwuid today, but the refresh-and-retry is kept
    defensive: an `expiredFrameworkUid` event must re-scrape the shell and retry
    once, succeeding — never raise a fatal error on the first stale response.
    """

    def test_expired_framework_uid_triggers_rescrape_and_retry(self):
        connector = Cimenta2Connector()
        _discovered(connector)

        shell_calls = {"n": 0}

        def _get(url, **_kwargs):
            shell_calls["n"] += 1
            return _mock_response(_fixture("cimenta2_sample_shell.html"))

        posts = {"n": 0}

        def _post(url, **_kwargs):
            posts["n"] += 1
            if posts["n"] == 1:
                # First POST: the stale-fwuid signature.
                return _mock_response(
                    '{"event":{"descriptor":"markup://aura:expiredFrameworkUid"}}'
                )
            # Retry after the re-scrape: the healthy record.
            return _mock_response(_fixture("cimenta2_sample_getrecord.json"))

        with (
            patch("etl.config.cimenta2_detail_endpoint", return_value=_FAKE_ENDPOINT),
            patch("etl.config.cimenta2_include_internal", return_value=False),
            patch("etl.connectors.cimenta2.requests.get", side_effect=_get),
            patch("etl.connectors.cimenta2.requests.post", side_effect=_post),
        ):
            raw = connector.fetch_detail("a0v3X00000dwiQQQAY", throttle=lambda: None)
            canonical = connector.normalize(raw)

        # Re-scraped the shell (2 GETs) and retried the POST (2 POSTs), then
        # produced a real record rather than raising.
        assert shell_calls["n"] == 2
        assert posts["n"] == 2
        assert canonical.reference_code == "TESTREF-4242"
