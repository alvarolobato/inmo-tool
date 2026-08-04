"""Fixture-based tests for the Cimenta2 sitemap-index connector (issue #136).

Fixtures are real captures of the **public, robots-allowed sitemap** at
`inmuebles.cimenta2.com`, trimmed and annotated in-file. Nothing here came
from — and nothing here exercises — the guest endpoint D-033 rules out;
this connector has no detail-fetch path to test at all, which is itself the
subject of `TestFetchDetailNeverTouchesTheNetwork` below.

No live network in any test: `requests.get` is patched everywhere, and the
fetch_detail tests patch it with an exploding stub precisely to prove the
method makes no request.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from etl.connectors.base import ConnectorError, ConnectorScope
from etl.connectors.cimenta2 import (
    _ASSET_SITEMAP_DEFAULT_URL,
    _BASE_URL,
    _SITEMAP_INDEX_URL,
    Cimenta2Connector,
)
from etl.connectors.cimenta2_mapping import (
    asset_sitemap_url,
    parse_asset_url,
    record_id_from_url,
    reference_code_from_url,
)
from etl.connectors.geography import UnresolvableGeographyError

FIXTURES = Path(__file__).parent / "fixtures"

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
        assert canonical.raw_extra["detail_unavailable_reason"] == "D-033"
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
