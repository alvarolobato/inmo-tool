"""Fixture-based tests for the Fotocasa connector (issue #12, Phase 1.4).

No live network calls — discover()/fetch_detail() are exercised by
monkeypatching requests.get to return saved fixture HTML, so this suite
doesn't depend on network access and won't break the moment Fotocasa
changes its markup (only the fixtures + the parsing code need updating
together, deliberately, not silently via a flaky live test).
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests
from bs4 import BeautifulSoup

from etl.connectors import fotocasa as fotocasa_module
from etl.connectors.base import ConnectorError, ConnectorScope, RawListing
from etl.connectors.fotocasa import FotocasaConnector
from etl.orchestrator import _upsert_canonical_listing
from etl.tests.robots_matcher import is_allowed, load_star_block_rules

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()


_FIXTURES = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.fotocasa.es/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def test_fotocasa_does_not_claim_full_inventory_coverage():
    """Phase 1 phase-level review finding: discover() only ever sees page 1
    of real search results (robots.txt disallows pagination) against a real
    inventory in the thousands — discovers_full_inventory=False is what
    stops the orchestrator from ever auto-marking a Fotocasa listing
    withdrawn just because one sweep didn't happen to surface it."""
    assert FotocasaConnector.discovers_full_inventory is False


def test_fotocasa_declares_a_24h_fetch_budget_window():
    """Issue #143's documented freshness window for this connector: a
    listing already fetched within the last 24h is a skip-if-seen
    candidate, UNLESS its discovery-time price (see discovered_prices())
    disagrees with what's stored, or it's never been fetched, or its
    stored price is missing — see etl.orchestrator._should_skip_fetch."""
    assert FotocasaConnector.min_refetch_interval_seconds == 24 * 60 * 60


class TestDiscover:
    def test_discover_finds_unique_external_ids_from_search_page(self):
        html = _read_fixture("fotocasa_sample_search.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # Three distinct listings in the fixture; one linked twice (main
        # card + similar-listings widget) and one gallery-thumbnail href
        # with a query string that must NOT match (see fixture comments).
        assert sorted(ids) == ["190011971", "190022222", "190033333"]

    def test_center_based_scope_requests_the_matching_city_slug_not_madrid(self):
        """Issue #71 review finding: nearest_city() itself was tested, but
        never end-to-end through a real connector's discover() — the actual
        request URL a center-based (not geography-string) scope produces
        was unverified. A Sevilla-centered profile must request Fotocasa's
        Sevilla slug, not silently default to Madrid."""
        html = _read_fixture("fotocasa_sample_search.html")
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(center=(37.3891, -5.9845), radius_km=15),
                throttle=lambda: None,
            )
        requested_url = mock_get.call_args.args[0]
        assert "sevilla-capital" in requested_url
        assert "madrid" not in requested_url

    def test_discover_raises_on_soft_block_page_not_empty_list(self):
        """PR #49 review finding: Fotocasa's interruption page returns HTTP
        200 with no __initial_props__ tag — discover() must raise, not
        return []. An empty list would be misread by the orchestrator's
        withdrawal reconciliation as "every listing just disappeared"."""
        html = _read_fixture("fotocasa_sample_block_page.html")
        connector = FotocasaConnector()
        with (
            patch(
                "etl.connectors.fotocasa.requests.get",
                return_value=_mock_response(html),
            ),
            pytest.raises(ConnectorError, match="__initial_props__"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )

    def test_rooms_filter_is_appended_to_the_request_url(self):
        """Issue #99: rooms-count filtering via URL path segment was
        confirmed live to genuinely narrow Fotocasa's results (an EXACT
        match — every result in the live sample had exactly N rooms, none
        more — hence `rooms`, not `min_rooms`), not just an SEO alias — a
        scope carrying `rooms` must produce a request URL with that
        segment, and a scope without it must not."""
        html = _read_fixture("fotocasa_sample_search.html")
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital", rooms=2),
                throttle=lambda: None,
            )
        requested_url = mock_get.call_args.args[0]
        assert "/2-habitaciones/" in requested_url

        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ) as mock_get_no_filter:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        unfiltered_url = mock_get_no_filter.call_args.args[0]
        assert "habitaciones" not in unfiltered_url

    def test_rooms_filter_discovers_a_genuinely_different_listing_set(self):
        """Stronger than the URL-shape assertion above: a real filtered
        response must parse into a different set of listing IDs than the
        unfiltered response, not just hit a URL with the right substring.
        Uses a dedicated fixture with non-overlapping IDs specifically so
        this can't pass by coincidence (e.g. a connector bug that ignores
        `rooms` entirely and always parses the same fixture-shaped page
        would still pass a URL-only assertion, but would fail this one)."""
        unfiltered_html = _read_fixture("fotocasa_sample_search.html")
        filtered_html = _read_fixture("fotocasa_sample_search_2_habitaciones.html")

        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(filtered_html),
        ):
            filtered_ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital", rooms=2),
                throttle=lambda: None,
            )
        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(unfiltered_html),
        ):
            unfiltered_ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )

        assert sorted(filtered_ids) == ["290044444", "290055555"]
        assert sorted(unfiltered_ids) == ["190011971", "190022222", "190033333"]
        assert set(filtered_ids).isdisjoint(unfiltered_ids)

    def test_scope_key_distinguishes_rooms_from_unfiltered(self):
        """Two scopes with the same geography but a different `rooms`
        filter must not be treated as the same crawl target by the
        orchestrator's seen_scope_keys dedup — they hit different URLs."""
        connector = FotocasaConnector()
        unfiltered = connector.scope_key(ConnectorScope(geography="madrid-capital"))
        filtered = connector.scope_key(
            ConnectorScope(geography="madrid-capital", rooms=2)
        )
        assert unfiltered != filtered
        assert unfiltered == connector.scope_key(
            ConnectorScope(geography="madrid-capital")
        )

    def test_discover_rejects_robots_txt_disallowed_bare_geography(self):
        """robots.txt disallows the literal "/madrid/" path segment (not the
        hyphenated "madrid-capital" this connector's default uses) — a
        caller passing the bare city name must be rejected before any
        request is made, not silently sent."""
        connector = FotocasaConnector()
        with (
            patch("etl.connectors.fotocasa.requests.get") as mock_get,
            pytest.raises(ConnectorError, match="robots.txt"),
        ):
            connector.discover(
                ConnectorScope(geography="madrid"), throttle=lambda: None
            )
        mock_get.assert_not_called()


class TestZonePartitioning:
    """Issue #65: lift coverage past the ~30-listing page-1 cap by sweeping
    the neighbourhood ("zone") slices Fotocasa itself links from the city
    page — all robots.txt-allowed, no pagination, no query-string filters."""

    def _responses_by_url(self):
        """Map URL -> fixture, so a patched requests.get can answer each
        zone request with its own page rather than one shared blob (which
        would make a 'did we actually sweep the zones?' assertion vacuous)."""
        base = _read_fixture("fotocasa_sample_search_zones.html")
        chamberi = _read_fixture("fotocasa_sample_search_zone_chamberi.html")

        def fake_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base, url=url)
            if "/chamberi/" in url:
                return _mock_response(chamberi, url=url)
            # Every other zone: a valid page with no listings of its own.
            return _mock_response('<script id="__initial_props__">{}</script>', url=url)

        return fake_get

    def test_discover_sweeps_zones_and_unions_their_listings(self):
        """The headline behaviour: ids from the zone pages must be added to
        the baseline page's ids. The fixtures share no ids, so a connector
        that silently ignored zones would return only the baseline two and
        fail here."""
        with patch(
            "etl.connectors.fotocasa.requests.get",
            side_effect=self._responses_by_url(),
        ):
            ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # 190011971/190022222 from the city page, 190044444/190055555 from Chamberí.
        assert sorted(ids) == ["190011971", "190022222", "190044444", "190055555"]

    def test_zone_slugs_are_scoped_to_the_requested_geography(self):
        """The city page links other cities' zone pages too. Sweeping one of
        those would 200 with real listings from the WRONG city and quietly
        pollute the geography the operator asked for — so the barcelona zone
        link in the fixture must never be requested during a madrid sweep."""
        with patch(
            "etl.connectors.fotocasa.requests.get",
            side_effect=self._responses_by_url(),
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        requested = [call.args[0] for call in mock_get.call_args_list]
        assert not any("barcelona" in url for url in requested)
        assert all("/madrid-capital/" in url for url in requested)

    def test_todas_las_zonas_is_not_swept_as_if_it_were_a_neighbourhood(self):
        """`todas-las-zonas` is the unfiltered page discover() already
        fetched, not a zone — re-fetching it would waste a request against a
        live site for zero new listings."""
        with patch(
            "etl.connectors.fotocasa.requests.get",
            side_effect=self._responses_by_url(),
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        requested = [call.args[0] for call in mock_get.call_args_list]
        assert sum("/todas-las-zonas/" in url for url in requested) == 1

    def test_one_failing_zone_does_not_abort_the_whole_sweep(self):
        """A sweep is ~161 requests against a live site; a single transient
        failure must degrade coverage, not destroy it. The baseline page and
        the surviving zones must still come back."""
        base = _read_fixture("fotocasa_sample_search_zones.html")
        chamberi = _read_fixture("fotocasa_sample_search_zone_chamberi.html")

        def flaky_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base, url=url)
            if "/chamberi/" in url:
                return _mock_response(chamberi, url=url)
            if "/carabanchel/" in url:
                raise requests.Timeout("simulated zone timeout")
            return _mock_response('<script id="__initial_props__">{}</script>', url=url)

        with patch("etl.connectors.fotocasa.requests.get", side_effect=flaky_get):
            ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        assert sorted(ids) == ["190011971", "190022222", "190044444", "190055555"]

    def test_base_page_failure_still_raises(self):
        """The per-zone tolerance must NOT leak into the base page: if that
        fails there are no zone slugs and no baseline, so returning an empty
        list would look to the orchestrator like 'every listing vanished'."""
        with (
            patch(
                "etl.connectors.fotocasa.requests.get",
                side_effect=requests.Timeout("simulated base failure"),
            ),
            pytest.raises(ConnectorError, match="request failed"),
        ):
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )

    def test_throttle_is_called_once_per_request(self):
        """The sweep is ~161 requests where it used to be 1 — the shared
        per-connector limiter is the only thing pacing it, so every request
        must go through the throttle, not just the first."""
        calls = {"n": 0}

        def counting_throttle():
            calls["n"] += 1

        with patch(
            "etl.connectors.fotocasa.requests.get",
            side_effect=self._responses_by_url(),
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"),
                throttle=counting_throttle,
            )
        assert calls["n"] == len(mock_get.call_args_list)
        assert calls["n"] > 1  # guards against a regression to single-request

    def test_rooms_filter_applies_to_every_zone_url(self):
        """A rooms-filtered scope must carry the filter into each zone slice
        too — live-verified that `.../chamberi/2-habitaciones/l` is a real,
        robots-allowed, data-serving URL shape."""
        with patch(
            "etl.connectors.fotocasa.requests.get",
            side_effect=self._responses_by_url(),
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital", rooms=2),
                throttle=lambda: None,
            )
        requested = [call.args[0] for call in mock_get.call_args_list]
        assert len(requested) > 1
        assert all(url.endswith("/2-habitaciones/l") for url in requested)


class TestDiscoveryPrices:
    """Issue #143: Fotocasa's search-results pages embed a real per-listing
    price (`initialSearch.result.realEstates[].rawPrice`) in the same
    `__initial_props__` blob discover() already fetches — live-verified
    2026-08-03 against two real pages (id/rawPrice sets matching discover()'s
    own href-extracted ids exactly, and a sampled rawPrice matching that
    listing's independently-fetched detail-page price exactly). See
    Connector.discovered_prices and fotocasa.py's own docstrings for the
    full verification writeup."""

    def test_discovered_prices_empty_before_any_discover_call(self):
        """A fresh connector has never made a request — there is nothing to
        report a price signal from yet, same as the base class default."""
        assert FotocasaConnector().discovered_prices() == {}

    def test_discover_populates_discovered_prices_from_the_baseline_page(self):
        html = _read_fixture("fotocasa_sample_search_with_prices.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # Same ids the plain (no-price) fixture yields — the price signal is
        # additive, it must not change what discover() itself returns.
        assert sorted(ids) == ["190011971", "190022222", "190033333"]
        assert connector.discovered_prices() == {
            "190011971": Decimal(945000),
            "190022222": Decimal(620000),
            "190033333": Decimal(310000),
        }

    def test_discovered_prices_accumulate_across_baseline_and_zones(self):
        """Prices from a successfully-fetched zone page must merge with the
        baseline page's — not overwrite or get dropped — since a real sweep
        gets its price signal from ~161 pages, not just page 1."""
        base_html = _read_fixture("fotocasa_sample_search_with_prices_base.html")
        zone_html = _read_fixture("fotocasa_sample_search_with_prices_zone.html")

        def fake_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base_html, url=url)
            return _mock_response(zone_html, url=url)

        connector = FotocasaConnector()
        with patch("etl.connectors.fotocasa.requests.get", side_effect=fake_get):
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        assert sorted(ids) == ["190011971", "190044444"]
        assert connector.discovered_prices() == {
            "190011971": Decimal(945000),
            "190044444": Decimal(620000),
        }

    def test_discovered_prices_reset_between_scopes(self):
        """A connector instance is reused across scopes within one run
        (issue #71's shared limiter/breaker pattern applies to state on the
        connector too) — a second discover() call for a DIFFERENT scope
        must not leak the first scope's prices for ids the second scope
        never actually discovered."""
        priced_html = _read_fixture("fotocasa_sample_search_with_prices.html")
        plain_html = _read_fixture("fotocasa_sample_search.html")
        connector = FotocasaConnector()

        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(priced_html),
        ):
            connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        assert connector.discovered_prices() != {}

        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(plain_html),
        ):
            connector.discover(
                ConnectorScope(geography="sevilla-capital"), throttle=lambda: None
            )
        assert connector.discovered_prices() == {}, (
            "the second scope's fixture has no realEstates price data — "
            "the first scope's prices must not still be sitting here"
        )

    def test_low_price_coverage_logs_a_loud_alarm(self):
        """Also-fix (Opus review, PR #175): if Fotocasa ever restructures
        `initialSearch.result.realEstates`, `_extract_search_result_prices`
        correctly degrades to `{}` (never breaks the sweep) — but silently.
        discover() itself must notice when the resulting price coverage is
        far below what a healthy sweep produces (live-verified: 0
        mismatches between the id set and the price set) and log loudly,
        since this is the price-change safety net for skip-if-seen and
        nothing else would ever notice it went missing."""
        base_html = _read_fixture("fotocasa_sample_search_zones.html")

        def no_price_zone_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base_html, url=url)
            # Valid page shape, listings present, but no realEstates price
            # data at all — the exact shape a restructured search page
            # would degrade to via _extract_search_result_prices.
            return _mock_response('<script id="__initial_props__">{}</script>', url=url)

        with (
            patch(
                "etl.connectors.fotocasa.requests.get", side_effect=no_price_zone_get
            ),
            patch.object(fotocasa_module.logger, "error") as mock_error,
        ):
            connector = FotocasaConnector()
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # The baseline fixture itself carries no realEstates price data
        # either (confirmed elsewhere in this file) — 0% coverage overall.
        assert connector.discovered_prices() == {}
        assert ids  # there ARE discovered ids — coverage is 0%, not vacuous
        coverage_call = next(
            call
            for call in mock_error.call_args_list
            if "discovery-time price signal covers only" in str(call.args[0])
        )
        # call.args: (fmt, covered_count, total_count, coverage_pct, geography,
        # threshold_pct, min_refetch_interval_seconds) — see the logger.error
        # call in fotocasa.py's discover().
        assert coverage_call.args[1] == 0  # covered_count
        assert coverage_call.args[2] == len(ids)  # total discovered ids
        assert coverage_call.args[3] == 0.0  # coverage_pct

    def test_full_price_coverage_does_not_log_an_alarm(self):
        """Mirror case: a healthy sweep (every discovered id has a matching
        discovery-time price, the live-verified normal case) must not
        trigger the coverage alarm — reuses the same baseline/zone fixture
        pair as test_discovered_prices_accumulate_across_baseline_and_zones,
        where both ids returned have a price."""
        base_html = _read_fixture("fotocasa_sample_search_with_prices_base.html")
        zone_html = _read_fixture("fotocasa_sample_search_with_prices_zone.html")

        def fake_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base_html, url=url)
            return _mock_response(zone_html, url=url)

        with (
            patch("etl.connectors.fotocasa.requests.get", side_effect=fake_get),
            patch.object(fotocasa_module.logger, "error") as mock_error,
        ):
            connector = FotocasaConnector()
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        assert len(connector.discovered_prices()) == len(ids)  # 100% coverage
        messages = str(mock_error.call_args_list)
        assert "discovery-time price signal covers only" not in messages

    def test_extract_search_result_prices_degrades_to_empty_without_raising(self):
        """The price signal is bonus data, never load-bearing for discover()
        itself — a page with no realEstates structure (the plain fixture,
        which predates issue #143) or outright garbage must both degrade to
        {}, never raise, since that would turn a missing *price* into a
        broken sweep."""
        from etl.connectors.fotocasa import _extract_search_result_prices

        plain_html = _read_fixture("fotocasa_sample_search.html")
        assert _extract_search_result_prices(plain_html) == {}

        garbage_html = (
            '<script type="application/json" id="__initial_props__">'
            "{not valid json</script>"
        )
        assert _extract_search_result_prices(garbage_html) == {}

    def test_extract_search_result_prices_skips_entries_missing_id_or_price(self):
        from etl.connectors.fotocasa import _extract_search_result_prices

        html = (
            '<script type="application/json" id="__initial_props__">'
            '{"initialSearch": {"result": {"realEstates": ['
            '{"id": 1, "rawPrice": 100000}, '
            '{"id": 2}, '
            '{"rawPrice": 200000}, '
            '"not-a-dict"'
            "]}}}</script>"
        )
        assert _extract_search_result_prices(html) == {"1": Decimal(100000)}


class TestSweepPacingAndBounds:
    """Issue #65 live measurement: at 20 req/min Fotocasa starts returning
    HTTP 200 pages with the `__initial_props__` payload missing after ~4
    zone requests, and keeps doing so for minutes. At 3 req/min it serves
    full data consistently. These guard the settings that encode that."""

    def test_rate_limit_is_low_enough_for_a_multi_request_sweep(self):
        """A regression here wouldn't fail loudly — it would silently return
        fewer listings while every request still looked like a 200 success,
        defeating the coverage this change exists to gain."""
        assert FotocasaConnector.rate_limit_per_minute <= 4

    def test_max_zones_per_sweep_bounds_the_request_count(self):
        base = _read_fixture("fotocasa_sample_search_zones.html")
        chamberi = _read_fixture("fotocasa_sample_search_zone_chamberi.html")

        def fake_get(url, **_kwargs):
            body = base if "/todas-las-zonas/" in url else chamberi
            return _mock_response(body, url=url)

        class BoundedConnector(FotocasaConnector):
            max_zones_per_sweep = 2

        with patch(
            "etl.connectors.fotocasa.requests.get", side_effect=fake_get
        ) as mock_get:
            BoundedConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # 1 base page + at most 2 zones.
        assert len(mock_get.call_args_list) == 3

    def test_default_sweeps_every_discovered_zone(self):
        """The bound is opt-in: defaulting it small would disguise an
        operator choice about coverage as a property of the connector."""
        assert FotocasaConnector.max_zones_per_sweep is None

    def test_soft_block_page_counts_as_a_failed_zone_not_an_empty_one(self):
        """The measured soft-block shape is HTTP 200 with no
        __initial_props__. It must be treated as a failure (so it feeds the
        'all zones failed' alarm), never as a legitimately empty zone."""
        base = _read_fixture("fotocasa_sample_search_zones.html")

        def soft_blocking_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base, url=url)
            return _mock_response("<html><body>no payload</body></html>", url=url)

        connector = FotocasaConnector()
        with (
            patch(
                "etl.connectors.fotocasa.requests.get", side_effect=soft_blocking_get
            ),
            patch.object(fotocasa_module.logger, "error") as mock_error,
        ):
            ids = connector.discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        # Baseline survives; zones contribute nothing.
        assert sorted(ids) == ["190011971", "190022222"]
        assert mock_error.called, "a fully-soft-blocked sweep must log an error"

    def test_mostly_empty_sweep_reports_a_parse_regression_not_throttling(self):
        """An *empty* zone is a well-formed page with zero listings — which
        is NOT the throttle signature (a throttled response has no payload
        at all and is counted as failed). Before PR #142's review these were
        folded into one failed-or-empty ratio, so a sweep of well-behaved
        pages produced an error asserting 'likely rate-induced
        soft-blocking' about a site that was serving us perfectly. The two
        signals must stay distinct, and point at different remedies."""
        base = _read_fixture("fotocasa_sample_search_zones.html")

        def empty_zone_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base, url=url)
            # Valid page shape, zero listings.
            return _mock_response('<script id="__initial_props__">{}</script>', url=url)

        with (
            patch("etl.connectors.fotocasa.requests.get", side_effect=empty_zone_get),
            patch.object(fotocasa_module.logger, "error") as mock_error,
        ):
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        assert mock_error.called
        # call_args_list, not call_args (the last call): issue #175 added a
        # separate, independent price-coverage alarm that also fires here
        # (this fixture's baseline page carries no realEstate price data,
        # so coverage is 0% regardless of the zone-empty scenario under
        # test) — it is not what this test is about, but it does mean the
        # "parse regression" message is no longer necessarily the LAST
        # error logged.
        all_messages = str(mock_error.call_args_list)
        assert "parse regression" in all_messages
        # The message may *mention* soft-blocking to rule it out, but it must
        # not send the operator chasing the rate limit — that's the remedy for
        # the failure alarm, and it isn't what's wrong here.
        parse_regression_call = next(
            call
            for call in mock_error.call_args_list
            if "parse regression" in str(call)
        )
        assert "rate_limit_per_minute" not in str(parse_regression_call), (
            "an all-empty sweep is not evidence of soft-blocking — pointing "
            "the operator at the rate limit sends them after the wrong cause"
        )


class TestSilentFailureGuards:
    """PR #142 review: the sweep's most dangerous failure mode is the one
    that looks *identical to success* — a normal 200, a plausible ~30
    listings, no exception, but silently back to pre-#65 coverage."""

    def test_zero_discovered_zones_logs_an_error_instead_of_passing_quietly(self):
        """If Fotocasa changes its zone-link markup the regex matches
        nothing, the sweep quietly reverts to one page, and every signal a
        human would look at (no exception, no failed zones, a normal-looking
        listing count) says the run was fine. That must be loud."""
        # A base page with listings but no zone links at all.
        page = (
            '<script id="__initial_props__">{}</script>'
            '<a href="/es/comprar/vivienda/madrid-capital/x/190011971/d">a</a>'
        )
        with (
            patch(
                "etl.connectors.fotocasa.requests.get",
                side_effect=lambda url, **_k: _mock_response(page, url=url),
            ) as mock_get,
            patch.object(fotocasa_module.logger, "error") as mock_error,
        ):
            ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        assert ids == ["190011971"]  # baseline still returned, not lost
        assert len(mock_get.call_args_list) == 1  # nothing to sweep
        assert mock_error.called, (
            "a zone-markup break silently halves coverage — it must not be "
            "indistinguishable from a healthy sweep"
        )
        assert "no zone slugs" in str(mock_error.call_args)

    def test_rooms_filtered_base_page_still_yields_zone_slugs(self):
        """On a rooms-filtered scope Fotocasa's own zone links carry the
        filter forward (`.../chamberi/2-habitaciones/l`). The original
        pattern required `<geo>/<slug>/l` and so matched *nothing* on those
        pages — every rooms-filtered scope silently collapsed to a single
        request. The pre-existing rooms test missed this because its fixture
        served UNFILTERED hrefs regardless of the scope."""
        base = (
            '<script id="__initial_props__">{}</script>'
            '<a href="/es/comprar/viviendas/madrid-capital/chamberi/2-habitaciones/l">c</a>'
            '<a href="/es/comprar/viviendas/madrid-capital/salamanca/2-habitaciones/l">s</a>'
        )
        zone = (
            '<script id="__initial_props__">{}</script>'
            '<a href="/es/comprar/vivienda/madrid-capital/x/190044444/d">z</a>'
        )

        def fake_get(url, **_kwargs):
            return _mock_response(base if "/todas-las-zonas/" in url else zone, url=url)

        with patch(
            "etl.connectors.fotocasa.requests.get", side_effect=fake_get
        ) as mock_get:
            FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital", rooms=2),
                throttle=lambda: None,
            )
        requested = [call.args[0] for call in mock_get.call_args_list]
        assert len(requested) == 3, (
            f"expected base + 2 zones, got {len(requested)}: "
            "a rooms-filtered sweep discovered no zones"
        )
        assert all(url.endswith("/2-habitaciones/l") for url in requested)

    def test_sweep_aborts_after_consecutive_failures_instead_of_hammering(self):
        """Fotocasa's soft-block persists for minutes once triggered, so
        continuing spends the rest of a ~54min sweep making requests a site
        is actively refusing — no extra listings, plenty of extra load."""
        base = _read_fixture("fotocasa_sample_search_zones.html")

        def blocked_get(url, **_kwargs):
            if "/todas-las-zonas/" in url:
                return _mock_response(base, url=url)
            return _mock_response("<html>no payload</html>", url=url)

        with (
            patch(
                "etl.connectors.fotocasa.requests.get", side_effect=blocked_get
            ) as mock_get,
            patch.object(fotocasa_module.logger, "error") as mock_error,
        ):
            ids = FotocasaConnector().discover(
                ConnectorScope(geography="madrid-capital"), throttle=lambda: None
            )
        zone_requests = len(mock_get.call_args_list) - 1
        assert zone_requests == fotocasa_module._MAX_CONSECUTIVE_ZONE_FAILURES, (
            f"expected to stop after "
            f"{fotocasa_module._MAX_CONSECUTIVE_ZONE_FAILURES} consecutive "
            f"failures, made {zone_requests} zone requests"
        )
        assert sorted(ids) == ["190011971", "190022222"]  # partial result kept
        assert "aborting" in str(mock_error.call_args_list)


class TestRobotsCompliance:
    """Issue #65 made this connector fetch ~161 URLs per sweep instead of 1.
    That is only defensible if every one of them is robots.txt-allowed, so
    assert it against the real robots.txt rather than trusting the URL
    builder by inspection."""

    def _rules(self):
        return load_star_block_rules(_read_fixture("fotocasa_robots.txt"))

    def test_every_constructed_url_is_robots_allowed(self):
        """Drive a real sweep, capture every URL actually requested, and
        check each against the real robots.txt. This is the test that should
        fail if someone later adds a query-string filter (minPrice, filter=,
        propertySubtypeIds…) — all of which Fotocasa disallows — or reaches
        for a pagination path."""
        rules = self._rules()
        base = _read_fixture("fotocasa_sample_search_zones.html")
        chamberi = _read_fixture("fotocasa_sample_search_zone_chamberi.html")

        def fake_get(url, **_kwargs):
            body = base if "/todas-las-zonas/" in url else chamberi
            return _mock_response(body, url=url)

        for scope in (
            ConnectorScope(geography="madrid-capital"),
            ConnectorScope(geography="madrid-capital", rooms=2),
        ):
            with patch(
                "etl.connectors.fotocasa.requests.get", side_effect=fake_get
            ) as mock_get:
                FotocasaConnector().discover(scope, throttle=lambda: None)
            requested = [call.args[0] for call in mock_get.call_args_list]
            assert requested, "sweep made no requests — assertion would be vacuous"
            for url in requested:
                allowed, reason = is_allowed(rules, url)
                assert allowed, f"{url} is robots.txt-disallowed: {reason}"

    def test_the_matcher_actually_rejects_the_disallowed_patterns(self):
        """Guards the guard: if the matcher said yes to everything, the test
        above would pass no matter what the connector did. These are the
        real disallowed shapes from Fotocasa's robots.txt (pagination, the
        query-string filters, and the bare city-name segment)."""
        rules = self._rules()
        base = "https://www.fotocasa.es/es/comprar/viviendas/madrid-capital"
        must_be_disallowed = [
            f"{base}/todas-las-zonas/l/2",
            f"{base}/todas-las-zonas/l?minPrice=100000",
            f"{base}/todas-las-zonas/l?maxPrice=200000",
            f"{base}/todas-las-zonas/l?minRooms=2",
            f"{base}/todas-las-zonas/l?propertySubtypeIds=1",
            "https://www.fotocasa.es/es/comprar/viviendas/madrid/todas-las-zonas/l",
        ]
        for url in must_be_disallowed:
            allowed, _ = is_allowed(rules, url)
            assert not allowed, f"matcher wrongly allowed {url}"

    def test_matcher_honours_consecutive_user_agent_groups(self):
        """RFC 9309 §2.2.1: consecutive user-agent lines form ONE group
        sharing the rules that follow. Tracking only the last-seen agent
        dropped the `*` rules whenever a named agent was declared after it —
        reading a site as MORE permissive than it is, which is the dangerous
        direction for a compliance claim. This matcher is now also the
        reference for PR #141 (Servihabitat), whose robots.txt does declare
        a named Scrapy group."""
        star_then_named = "User-agent: *\nUser-agent: Scrapy\nDisallow: /private"
        named_then_star = "User-agent: Scrapy\nUser-agent: *\nDisallow: /private"
        for label, text in (
            ("star first", star_then_named),
            ("star last", named_then_star),
        ):
            allowed, why = is_allowed(
                load_star_block_rules(text), "https://x.test/private"
            )
            assert not allowed, f"{label}: shared group rule was dropped ({why})"

        # ...but a rule belonging ONLY to a named group must not leak into `*`.
        separate = "User-agent: Scrapy\nDisallow: /\nUser-agent: *\nDisallow: /admin"
        rules = load_star_block_rules(separate)
        assert is_allowed(rules, "https://x.test/anything")[0], (
            "Scrapy's blanket Disallow leaked into the * group"
        )
        assert not is_allowed(rules, "https://x.test/admin")[0]

    def test_matcher_allows_the_zone_shape_the_connector_relies_on(self):
        """The other half of guarding the guard — a matcher that rejected
        everything would also make the sweep test pass vacuously if it were
        ever inverted. These shapes must be allowed."""
        rules = self._rules()
        base = "https://www.fotocasa.es/es/comprar/viviendas/madrid-capital"
        for url in (
            f"{base}/todas-las-zonas/l",
            f"{base}/chamberi/l",
            f"{base}/barrio-de-salamanca/l",
            f"{base}/chamberi/2-habitaciones/l",
        ):
            allowed, reason = is_allowed(rules, url)
            assert allowed, f"matcher wrongly disallowed {url}: {reason}"


class TestNormalize:
    def test_normalize_matches_expected_fixture(self):
        """EC-3: fetch_detail + normalize on a saved fixture produce the exact expected output."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)

        assert canonical.external_id == "190011971"
        assert canonical.source == "fotocasa"
        assert canonical.current_price == Decimal(205000)
        assert canonical.property_type == "piso"
        assert canonical.rooms == 3
        assert canonical.bathrooms == 1
        assert canonical.m2_built == Decimal(74)
        # Human-readable value from featuresList, NOT the coded
        # features.floor=3 integer (that would be fabricated precision —
        # see docs/skills/connectors.md and the fixture's own comment).
        assert canonical.floor == "2ª planta"
        assert canonical.has_elevator is True
        assert canonical.energy_rating == "G"
        assert canonical.raw_extra["floor_code_raw"] == 3
        assert canonical.lat == Decimal("40.382233")
        assert canonical.lon == Decimal("-3.6102757")
        assert canonical.listing_kind == "agency"  # clientUrl contains /inmobiliaria-
        assert canonical.address == "Santa Eugenia, Villa de Vallecas, Madrid Capital"
        assert len(canonical.photo_urls) == 2
        assert canonical.raw_extra["buildingType_raw"] == "Flat"

    def test_normalize_leaves_listing_kind_none_without_a_positive_agency_signal(self):
        """PR #49 review finding: defaulting to 'particular' whenever a name/
        URL exists at all (but neither agency signal matched) was itself an
        unverified guess. Absence of an agency signal must yield None, not
        an inferred 'particular'."""
        raw = RawListing(
            external_id="999",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "clientName": "Juan Perez",
                        "clientUrl": None,
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.listing_kind is None

    def test_normalize_excludes_non_image_multimedia_from_photo_urls(self):
        """Fable phase-2 review finding: a real listing's multimedia array
        mixes real photos with other asset types (observed live:
        {"type": "tour-virtual", "src": "https://floorfy.com/..."}) — only
        type="image" entries belong in photo_urls, otherwise a virtual-tour
        link renders as a broken <img> on the property detail page and gets
        fed (uselessly) to the photo-hash dedup signal."""
        raw = RawListing(
            external_id="997",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [
                            {
                                "type": "tour-virtual",
                                "src": "https://floorfy.com/tour/abc",
                            },
                            {
                                "type": "image",
                                "src": "https://static.fotocasa.es/a.jpg",
                            },
                            {
                                "type": "image",
                                "src": "https://static.fotocasa.es/b.jpg",
                            },
                            {"src": "https://static.fotocasa.es/no-type.jpg"},
                        ],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.photo_urls == (
            "https://static.fotocasa.es/a.jpg",
            "https://static.fotocasa.es/b.jpg",
        )

    def test_normalize_still_infers_agency_from_client_url(self):
        raw = RawListing(
            external_id="998",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "clientName": "Some Agency SL",
                        "clientUrl": "/es/inmobiliaria-some-agency/comprar/l",
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.listing_kind == "agency"

    def test_normalize_has_elevator_none_when_featuresList_lacks_the_label(self):
        raw = RawListing(
            external_id="997",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "featuresList": [{"label": "floor", "value": "Bajo"}],
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.has_elevator is None
        assert canonical.floor == "Bajo"

    def test_normalize_does_not_fabricate_year_built_from_antiquity_bucket(self):
        """antiquity is a coded bucket, not a literal year — must stay None, not guessed."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.year_built is None
        assert canonical.raw_extra["antiquity"] == 7


class TestFallbackChain:
    """Issue #77: property_web_scraper's es_fotocasa.json mapping keeps a
    CSS-selector fallback for exactly these four fields (their embedded-JSON
    path is the fragile part most likely to shift on a redesign). Their own
    selectors no longer match the live site as of this connector's own
    live spot-check (2026-08-02) — Fotocasa migrated to a Tailwind-utility
    design system with no semantic BEM classes. These fallback selectors
    are freshly verified against a real listing instead (icon-anchored via
    `data-title`, not layout classes) — see fotocasa.py's
    `_icon_stat_text`/`_price_fallback_text` docstrings.
    """

    def test_falls_back_to_css_when_json_fields_are_null(self):
        html = _read_fixture("fotocasa_sample_detail_fallback.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190099999", throttle=lambda: None)
        canonical = connector.normalize(raw)

        # Values baked into the fixture's HTML match the real listing this
        # fixture is modeled on (external_id 189316512) — this is also a
        # live-data regression check, not just "some fallback fired".
        assert canonical.rooms == 2
        assert canonical.bathrooms == 2
        assert canonical.m2_built == Decimal(60)
        assert canonical.current_price == Decimal(379000)
        # reference_code (issue #72): absent from this fixture's JSON
        # (no "reference" key in realEstate), recovered from the
        # ".re-FormContactDetail-referenceAlias" CSS fallback.
        assert canonical.reference_code == "XY789"

    def test_json_path_wins_over_css_when_both_are_present(self):
        """The fallback chain must not override a perfectly good JSON
        value just because HTML markup also happens to be present.

        Uses genuinely different, non-empty values on both paths (JSON:
        3/1/74/205000; HTML: 9/9/999/999000) — a version of this test that
        only has real markup on the JSON side can't distinguish "JSON wins
        because it's tried first" from "JSON is the only side with a
        value" (Opus review, PR #84: the prior fixture had no icon markup
        at all).
        """
        raw = RawListing(
            external_id="993",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 205000,
                        "address": {},
                        "coordinates": {},
                        "features": {"rooms": 3, "bathrooms": 1, "surface": 74},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": (
                    '<div aria-label="Precio del inmueble"><span>999.000 €</span></div>'
                    '<ul aria-label="Características principales">'
                    '<li><svg data-title="double_bed"></svg>'
                    '<span class="text-body-1"><span class="font-bold">9</span> habs.</span></li>'
                    '<li><svg data-title="bathroom_tub"></svg>'
                    '<span class="text-body-1"><span class="font-bold">9</span> baños</span></li>'
                    '<li><svg data-title="dimensions_block"></svg>'
                    '<span class="text-body-1"><span class="font-bold">999</span> m²</span></li>'
                    "</ul>"
                ),
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.rooms == 3
        assert canonical.bathrooms == 1
        assert canonical.m2_built == Decimal(74)
        assert canonical.current_price == Decimal(205000)

    def test_css_fallback_also_returns_none_when_html_lacks_the_markup_too(self):
        """Belt-and-braces: a listing where both JSON and HTML are missing
        the field must not crash and must yield None, not a stray 0/False
        from a getter that partially matched."""
        raw = RawListing(
            external_id="996",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": None,
                        "address": {},
                        "coordinates": {},
                        "features": {"rooms": None, "bathrooms": None, "surface": None},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body>no markup here</body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.rooms is None
        assert canonical.bathrooms is None
        assert canonical.m2_built is None
        assert canonical.current_price is None


class TestReferenceCode:
    """Issue #72: seller/agency reference code — e.g. "Referencia: NS603"
    live-verified (2026-08-02) against the real Sevilla listing cited in
    that issue (`realEstate.reference` matches the rendered
    ".re-FormContactDetail-referenceAlias" text exactly on that listing).
    The CSS-fallback path is covered by
    TestFallbackChain.test_falls_back_to_css_when_json_fields_are_null.
    """

    def test_extracts_reference_from_json_primary_path(self):
        raw = RawListing(
            external_id="992",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "reference": "NS603",
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.reference_code == "NS603"

    def test_missing_reference_yields_none_not_empty_string(self):
        raw = RawListing(
            external_id="991",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body>no reference markup here</body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.reference_code is None

    def test_css_fallback_reads_the_reference_from_real_captured_markup(self):
        """The CSS fallback must work against markup a real page actually
        serves — not against markup written to match the selector.

        PR #153 originally proved this fallback with a hand-authored page
        containing a "similar properties" carousel, on the assumption that
        Fotocasa contaminates this field the way it contaminated Vivantial
        (price), Servihabitat (m2) and Solvia (latent). Review caught the
        circularity: the carousel selectors matched nothing except the test's
        own markup, so the test proved "decompose removes nodes matching my
        selectors", not that a real neighbour rail exists.

        This uses `fotocasa_sample_detail_reference.html`, trimmed from a real
        fetch of the issue #149 listing, whose header records the counts
        measured on two real pages of different property types: the reference
        renders exactly once, and the "similares" strings present are i18n
        translation values inside the embedded JSON, not neighbour cards.
        Hence no `drop=` in `_reference_fallback_text`.
        """
        html = _read_fixture("fotocasa_sample_detail_reference.html")
        # The one thing that would invalidate the no-drop decision: if a real
        # page ever grows a second reference, this fails and prompts a rethink.
        # Counted over *rendered* text, not the raw source — the fixture's
        # header comment quotes the label while documenting the measurement,
        # and a raw substring count would score its own provenance note.
        fixture_soup = BeautifulSoup(html, "html.parser")
        assert fixture_soup.get_text(" ", strip=True).count("Referencia:") == 1
        assert len(fixture_soup.select(".re-FormContactDetail-referenceAlias")) == 1
        raw = RawListing(
            external_id="190239270",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/es/comprar/vivienda/sevilla-capital/trastero/190239270/d",
                # JSON path deliberately absent so the CSS fallback is what runs.
                "props": {
                    "realEstate": {
                        "price": 14000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": html,
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.reference_code == "LCSE43927"

    def test_reference_survives_the_round_trip_to_listing_reference_code(self, pg_conn):
        """Issue #149's AC: the code must reach `listing.reference_code`, not
        merely be parsed.

        `normalize()` returns a well-formed dataclass whether or not the value
        actually lands in the column the dedup signal reads. PR #138 shipped a
        mapping where 19 normalize()-only tests passed while 100% of real
        ingests failed on a CHECK constraint, so a parse assertion is not
        evidence of persistence. Uses the exact listing from the bug report
        (190239270 / LCSE43927).
        """
        _apply_schema(pg_conn)
        raw = RawListing(
            external_id="190239270",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/es/comprar/vivienda/sevilla-capital/trastero/190239270/d",
                "props": {
                    "realEstate": {
                        "price": 12000,
                        "reference": "LCSE43927",
                        "buildingType": "Flat",
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
            },
        )
        _upsert_canonical_listing(pg_conn, FotocasaConnector().normalize(raw))
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT reference_code FROM listing "
                "WHERE source = 'fotocasa' AND external_id = '190239270'"
            )
            row = cur.fetchone()
        assert row is not None, "nothing persisted"
        assert row[0] == "LCSE43927"


class TestSchemaSupersetFields:
    """Issue #77's AC: city/province/postal_code/m2_plot populated from data
    this connector already parses but previously flattened into `address`
    or dropped into `raw_extra` only."""

    def test_populates_city_province_postal_code_and_m2_plot(self):
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.city == "Madrid Capital"
        assert canonical.province == "Madrid"
        assert canonical.postal_code == "28031"
        # This fixture's surfaceLand is 0, which means "not a plot-having
        # property type", not "a real zero-m² plot" — treated as absent
        # (Opus review, PR #84; see the dedicated m2_plot test below for a
        # real non-zero value).
        assert canonical.m2_plot is None

    def test_m2_plot_nonzero_surface_land_is_preserved(self):
        raw = RawListing(
            external_id="994",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 500000,
                        "address": {},
                        "coordinates": {},
                        "features": {"surfaceLand": 850},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body></body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.m2_plot == Decimal(850)

    def test_operation_is_always_sale_for_this_connector(self):
        """This connector only ever requests Fotocasa's /comprar/ URLs —
        it has no rental discover()/fetch_detail() path at all, so
        operation='sale' reflects what the connector structurally is, not
        an unverified default masking missing data."""
        html = _read_fixture("fotocasa_sample_detail.html")
        connector = FotocasaConnector()
        with patch(
            "etl.connectors.fotocasa.requests.get", return_value=_mock_response(html)
        ):
            raw = connector.fetch_detail("190011971", throttle=lambda: None)
        canonical = connector.normalize(raw)
        assert canonical.operation == "sale"

    def test_missing_address_fields_yield_none_not_empty_string(self):
        raw = RawListing(
            external_id="995",
            source="fotocasa",
            raw={
                "url": "https://www.fotocasa.es/x",
                "props": {
                    "realEstate": {
                        "price": 100000,
                        "address": {},
                        "coordinates": {},
                        "features": {},
                        "descriptions": {},
                        "multimedia": [],
                    }
                },
                "html": "<html><body></body></html>",
            },
        )
        canonical = FotocasaConnector().normalize(raw)
        assert canonical.city is None
        assert canonical.province is None
        assert canonical.postal_code is None
        assert canonical.m2_plot is None


class TestPriceChangeHistory:
    def test_price_change_between_fetches_produces_different_canonical_prices(self):
        """EC-4 (connector half): two fetches of the same external_id with a
        changed price normalize to two different current_price values — the
        orchestrator (tested separately in test_orchestrator.py against real
        Postgres) is what turns that into an appended listing_price_history
        row rather than an overwrite; this test only proves the connector
        surfaces the real change for the orchestrator to act on.
        """
        connector = FotocasaConnector()
        html_before = _read_fixture("fotocasa_sample_detail.html")
        html_after = _read_fixture("fotocasa_sample_detail_price_changed.html")

        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(html_before),
        ):
            price_before = connector.normalize(
                connector.fetch_detail("190011971", throttle=lambda: None)
            ).current_price
        with patch(
            "etl.connectors.fotocasa.requests.get",
            return_value=_mock_response(html_after),
        ):
            price_after = connector.normalize(
                connector.fetch_detail("190011971", throttle=lambda: None)
            ).current_price

        assert price_before == Decimal(205000)
        assert price_after == Decimal(195000)
        assert price_before != price_after
