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
import requests

from etl import orchestrator
from etl.connectors.base import (
    CanonicalListingVersion,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
    Throttle,
)
from etl.connectors.geography import UnresolvableGeographyError
from etl.connectors.milanuncios import (
    MilanunciosConnector,
    MilanunciosSoftBlockError,
    _has_soft_block_signature,
    _has_usable_jsonld_property_schema,
    add_photo_rule_if_missing,
)
from etl.connectors.milanuncios_mapping import (
    energy_rating_value,
    extra_features,
    infer_operation,
)

_FIXTURES = Path(__file__).parent / "fixtures"
_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"


def _read_fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


def _mock_response(text: str, url: str = "https://www.milanuncios.com/x") -> Mock:
    resp = Mock()
    resp.text = text
    resp.url = url
    resp.raise_for_status = Mock()
    return resp


def _apply_schema(conn) -> None:
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def _cleanup_listings(conn) -> None:
    """Issue #210's migration tests below are the only DB-backed tests in
    this file — clear out any leftover rows from a previous run in this
    shared, per-session database (same reasoning as test_dedup_engine.py's
    `_cleanup`) before inserting fresh fixture rows."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM listing")
        cur.execute("DELETE FROM property")
    conn.commit()


def _insert_listing(conn, *, source: str, photo_urls: tuple[str, ...]) -> int:
    """Insert a minimal property + listing row for the migration tests
    below. Returns the new listing's id."""
    with conn.cursor() as cur:
        cur.execute("INSERT INTO property DEFAULT VALUES RETURNING id")
        (property_id,) = cur.fetchone()
        cur.execute(
            "INSERT INTO listing (property_id, source, external_id, photo_urls) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (property_id, source, f"ext-{source}-{property_id}", list(photo_urls)),
        )
        (listing_id,) = cur.fetchone()
    conn.commit()
    return listing_id


def _insert_milanuncios_listing(conn, photo_urls: tuple[str, ...]) -> int:
    return _insert_listing(conn, source="milanuncios", photo_urls=photo_urls)


def test_milanuncios_does_not_claim_full_inventory_coverage():
    """Same reasoning as Fotocasa (see docs/architecture/connectors.md):
    discover() only reads page 1 of one sale category (robots.txt disallows
    pagination here too), against inventory in the thousands."""
    assert MilanunciosConnector.discovers_full_inventory is False


class TestSkipIfSeenBudget:
    """Issue #179. The site caps this connector at ~5 detail fetches per run
    (16 of 18 circuit-open runs in a 38h production window were identical at
    `discovered=41 fetched=5 errors=5`). With skip-if-seen off, discover()'s
    stable sorted order meant all 5 went to the same front every run: 24
    distinct ids fetched across ~90 attempts. Turning it on lets the budget
    reach never-fetched listings, which `_should_skip_fetch` rule 1 always
    admits."""

    def test_declares_a_24h_refetch_window(self):
        """Pins the value. What this does NOT do is prove the value has the
        effect D-028 claims — for that see
        TestSkipIfSeenAdvancesTheFetchFrontier below, which is the test
        that actually exercises the skip x circuit-breaker interaction.

        (A companion `test_window_is_enabled_not_merely_defined` asserting
        `> 0` lived here and was removed on Opus review, PR #225: `== 86400`
        already implies `> 0`, so it was a second test pinning a fact the
        first one pins, justified against a hypothetical `>= 0` test that
        does not exist in this file.)"""
        assert MilanunciosConnector.min_refetch_interval_seconds == 24 * 60 * 60

    def test_has_no_discovery_price_escape_hatch(self):
        """The documented COST of the line above, asserted so it cannot be
        forgotten. `_should_skip_fetch` rule 5 re-fetches immediately when a
        discovery-time price disagrees with the stored one — but that rule
        needs a non-empty discovered_prices(), which this connector cannot
        supply (its `ad` entries carry no price field, and every live
        re-check has been bot-blocked). So a price change on an
        already-fetched listing can go unseen for up to the 24h window.
        Accepted deliberately: today most discovered listings are never
        fetched at all. If this assertion ever starts failing because a real
        discovery price landed, revisit the trade-off comment on the
        connector — the asymmetry with Fotocasa would be gone.

        NOT mutation-verified by reverting `min_refetch_interval_seconds` to
        0, and it never could be: this asserts `discovered_prices() == {}`,
        which is independent of that line. PR #225's body originally claimed
        all three tests in this class failed under that mutation; two did.
        Recorded here rather than quietly fixed, because "a check that
        cannot fail" is this repo's named defect class and an unverified
        verification claim is the same thing one level up. This test is a
        legitimate tripwire for a DIFFERENT change (a real discovery price
        appearing) — it just isn't evidence for the window."""
        assert MilanunciosConnector().discovered_prices() == {}


_BUDGET_PROBE_PROFILE = "milanuncios-fetch-budget-probe-profile"

# The site's observed per-run detail-fetch allowance (D-028: 16 of 18
# circuit-open runs were byte-identical at `fetched=5 errors=5`).
_SITE_FETCH_BUDGET = 5


def _apply_schema_with_active_profile(conn) -> None:
    """`run_all_connectors` derives discovery scope from active
    `search_profile` rows and does nothing at all with zero of them
    (issue #71), so the frontier tests below need one to exist. The probe
    connector ignores `scope` entirely, so the geography is irrelevant —
    only that some active profile is present. Idempotent (checks by name)
    so re-running against the session database doesn't accumulate rows."""
    _apply_schema(conn)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM search_profile WHERE name = %s AND archived_at IS NULL",
            (_BUDGET_PROBE_PROFILE,),
        )
        if cur.fetchone() is None:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s)",
                (
                    _BUDGET_PROBE_PROFILE,
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [40.4168, -3.7038], "radius_km": 10}}'
                    ),
                ),
            )
    conn.commit()


def _cleanup_source(conn, source: str, run_ids: list[int]) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM connector_config WHERE connector_name = %s", (source,))
        cur.execute(
            "DELETE FROM connector_run_results WHERE connector_name = %s", (source,)
        )
        cur.execute(
            "DELETE FROM listing_price_history WHERE listing_id IN "
            "(SELECT id FROM listing WHERE source = %s)",
            (source,),
        )
        cur.execute(
            "DELETE FROM listing_status_event WHERE listing_id IN "
            "(SELECT id FROM listing WHERE source = %s)",
            (source,),
        )
        cur.execute("SELECT property_id FROM listing WHERE source = %s", (source,))
        property_ids = [row[0] for row in cur.fetchall()]
        cur.execute("DELETE FROM listing WHERE source = %s", (source,))
        if property_ids:
            cur.execute("DELETE FROM property WHERE id = ANY(%s)", (property_ids,))
        for run_id in run_ids:
            cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
    conn.commit()


class _MilanunciosFetchBudgetProbe(MilanunciosConnector):
    """A no-network stand-in that reproduces the ONE production behaviour
    D-028 turns on: Milanuncios answers roughly `_SITE_FETCH_BUDGET` detail
    fetches per run and bot-blocks every one after that, and the allowance
    resets by the next hourly run.

    It subclasses `MilanunciosConnector` deliberately rather than using
    `DummyConnector`: it must inherit the REAL
    `min_refetch_interval_seconds`, so reverting that line in
    `milanuncios.py` makes the frontier test below genuinely fail. A
    DummyConnector carrying its own copy of `86400` would test the
    orchestrator's generic policy (already covered by
    `test_orchestrator.py::TestSkipIfSeenIntegration`) while being
    completely blind to this connector's own value — the exact "a test
    that passes by not testing the thing" failure mode this repo names.

    Only the three site-touching methods are replaced. The breaker settings
    are inherited too (`circuit_breaker_error_rate=0.30`,
    `min_attempts=10`), which is what makes 5 successes + 5 errors trip it
    at attempt 10 — reproducing production's `fetched=5 errors=5` exactly
    rather than by a tuned test constant.
    """

    name = "milanuncios-fetch-budget-probe"
    # Not what's under test; keeps the run fast rather than pacing at 2/min.
    rate_limit_per_minute = 6000

    def __init__(self, external_ids: tuple[str, ...]) -> None:
        self.external_ids = external_ids
        self.fetch_calls: list[str] = []
        self.calls_per_run: list[list[str]] = []
        self._successes_this_run = 0

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        # One scope per run, so discover() firing IS the start-of-run
        # signal — this is where the site's per-run allowance resets.
        self._successes_this_run = 0
        self.calls_per_run.append([])
        # `sorted` mirrors the real discover()'s stable ordering, which is
        # precisely why the un-skipped budget kept re-walking the same front.
        return sorted(self.external_ids)

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        self.fetch_calls.append(external_id)
        self.calls_per_run[-1].append(external_id)
        if self._successes_this_run >= _SITE_FETCH_BUDGET:
            raise ConnectorError(
                f"simulated Milanuncios bot-interruption for {external_id} "
                f"(per-run allowance of {_SITE_FETCH_BUDGET} already spent)"
            )
        self._successes_this_run += 1
        return RawListing(
            external_id=external_id,
            source=self.name,
            raw={"price": 150000},
        )

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        return CanonicalListingVersion(
            external_id=raw.external_id,
            source=raw.source,
            url=f"https://www.milanuncios.com/x/x-{raw.external_id}.htm",
            listing_kind="particular",
            status="active",
            current_price=Decimal(str(raw.raw["price"])),
            description="Probe listing.",
            photo_urls=(),
            contact_raw=None,
            address="Probe address",
            lat=None,
            lon=None,
            property_type="piso",
            m2_built=None,
            m2_useful=None,
            rooms=None,
            bathrooms=None,
            floor=None,
            year_built=None,
            has_elevator=None,
            energy_rating=None,
        )


class TestSkipIfSeenAdvancesTheFetchFrontier:
    """Issue #179 / D-028's actual thesis, tested as BEHAVIOUR rather than
    as a constant (Opus review, PR #225 — the original three tests all
    asserted `min_refetch_interval_seconds == 86400`, which only detects
    someone editing a line already visible in the diff).

    The claim under test is an INTERACTION between two mechanisms that no
    single-mechanism test reaches: the site caps detail fetches at ~5 per
    run and the circuit breaker trips on the errors that follow, so what
    matters is not "does skipping work" (issue #143 covers that) but
    "does the surviving budget land on listings we have never fetched,
    instead of re-walking the same sorted front forever".

    Both tests below run the identical scenario and differ only in whether
    the window is on, so the pair also documents the pathology D-028
    describes instead of merely asserting the cure.
    """

    # 20 ids, zero-padded so string-sort order == numeric order, making
    # "the first five" and "the next five" unambiguous under discover()'s
    # `sorted()`.
    _IDS = tuple(f"probe-{i:02d}" for i in range(1, 21))

    def _persisted_ids(self, conn, source: str) -> set[str]:
        with conn.cursor() as cur:
            cur.execute("SELECT external_id FROM listing WHERE source = %s", (source,))
            return {row[0] for row in cur.fetchall()}

    def test_second_run_fetches_the_next_listings_not_the_same_front(self, pg_conn):
        """The regression guard D-028 rests on. Run 1 spends its allowance
        on ids 01-05 (then 06-10 error and trip the breaker); run 2 must
        skip 01-05 as fresh and spend the same allowance on 06-10, doubling
        coverage. Fails if `MilanunciosConnector.min_refetch_interval_seconds`
        goes back to 0, if `run_connector`'s skip check moves after the
        breaker check, or if discover()'s ordering stops being stable."""
        _apply_schema_with_active_profile(pg_conn)
        connector = _MilanunciosFetchBudgetProbe(self._IDS)
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            _cleanup_source(pg_conn, connector.name, [])

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            first_run = list(connector.calls_per_run[0])
            # 5 succeed, the next 5 error, the breaker trips at attempt 10.
            assert first_run == list(self._IDS[:10]), (
                "run 1 should walk the sorted front until the breaker trips"
            )
            assert self._persisted_ids(pg_conn, connector.name) == set(self._IDS[:5])

            run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))
            second_run = list(connector.calls_per_run[1])

            # THE point of the whole PR:
            assert set(second_run).isdisjoint(set(self._IDS[:5])), (
                "run 2 re-fetched listings run 1 already got — the 5-fetch "
                "budget is being spent on the same front again, which is "
                "exactly the pathology issue #179 measured in production "
                f"(24 distinct ids across ~90 attempts). Run 2 fetched: {second_run}"
            )
            assert second_run == list(self._IDS[5:15]), (
                "run 2 should resume at the first never-fetched id (rule 1 "
                "always admits those) and run until the breaker trips again"
            )
            assert self._persisted_ids(pg_conn, connector.name) == set(
                self._IDS[:10]
            ), "coverage must have doubled from 5 to 10 distinct listings"

            # The skips are real skips, not silent no-ops, and they cost
            # the breaker nothing (`continue` happens before any breaker
            # interaction) — which is why the budget survives to be spent
            # further down the list.
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT skipped_count, fetched_count, status "
                    "FROM connector_run_results "
                    "WHERE run_id = %s AND connector_name = %s",
                    (run_ids[1], connector.name),
                )
                skipped_count, fetched_count, status = cur.fetchone()
            assert skipped_count == 5
            assert fetched_count == _SITE_FETCH_BUDGET
            assert status == "circuit_open"
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup_source(pg_conn, connector.name, run_ids)

    def test_without_the_window_the_same_front_is_refetched_every_run(self, pg_conn):
        """The counterfactual, so the test above is a comparison and not
        just an assertion. Identical scenario with the window forced OFF
        via `connector_config` (an operator-reachable setting, so this is
        also a real supported configuration and not only a thought
        experiment): every run re-walks ids 01-10 and coverage stays frozen
        at 5 forever, reproducing the production finding that ~90 fetch
        attempts reached only 24 distinct ids."""
        _apply_schema_with_active_profile(pg_conn)
        connector = _MilanunciosFetchBudgetProbe(self._IDS)
        orchestrator.CONNECTORS[:] = [connector]
        run_ids: list[int] = []
        try:
            _cleanup_source(pg_conn, connector.name, [])
            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO connector_config "
                    "(connector_name, min_refetch_interval_seconds) VALUES (%s, %s)",
                    (connector.name, 0),
                )
            pg_conn.commit()

            for _ in range(3):
                run_ids.append(orchestrator.run_all_connectors(pg_conn, trigger="test"))

            assert connector.calls_per_run == [list(self._IDS[:10])] * 3, (
                "with the window off, all three runs spend the identical "
                "budget on the identical front"
            )
            assert self._persisted_ids(pg_conn, connector.name) == set(self._IDS[:5]), (
                "coverage never advances past the first 5 — 30 fetch "
                "attempts, 5 distinct listings"
            )
        finally:
            orchestrator.CONNECTORS.clear()
            _cleanup_source(pg_conn, connector.name, run_ids)


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

    @pytest.mark.parametrize("status", [404, 410])
    def test_fetch_detail_raises_listing_unavailable_on_gone_status(self, status):
        """Issue #291: a 404/410 detail page means the ad was removed at the
        source between discovery and fetch — normal churn, so it raises
        ListingUnavailableError and the orchestrator counts it as a clean
        skip rather than one of the persistent per-scope `errors`. Distinct
        from the 200-no-payload soft-block case above, which the HTTP-status
        branch can never swallow because it isn't a RequestException."""
        resp = Mock()
        err = requests.HTTPError(f"{status} Client Error")
        err.response = Mock(status_code=status)
        resp.raise_for_status = Mock(side_effect=err)
        with (
            patch("etl.connectors.milanuncios.requests.get", return_value=resp),
            pytest.raises(ListingUnavailableError, match=f"HTTP {status}"),
        ):
            MilanunciosConnector().fetch_detail("700000001", throttle=lambda: None)

    def test_fetch_detail_server_error_stays_generic_connector_error(self):
        """A 5xx is a transient site problem, not a removed ad — it must NOT
        be reclassified as gone."""
        resp = Mock()
        err = requests.HTTPError("500 Server Error")
        err.response = Mock(status_code=500)
        resp.raise_for_status = Mock(side_effect=err)
        with (
            patch("etl.connectors.milanuncios.requests.get", return_value=resp),
            pytest.raises(ConnectorError) as excinfo,
        ):
            MilanunciosConnector().fetch_detail("700000001", throttle=lambda: None)
        assert not isinstance(excinfo.value, ListingUnavailableError)
        assert "request failed" in str(excinfo.value)


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


class TestPhotoUrlRuleParameter:
    """Issue #206: every Milanuncios photo URL 404s the dedup photo-hasher
    with "Rule parameter not Found" — confirmed live, 2026-08-04, against a
    real ad: `images.milanuncios.com/api/v1/ma-ad-media-pro/images/<uuid>`
    (a size/crop-transform proxy, not a plain object store) 404s bare and
    200s with `?rule=<preset>` appended (`detail_640x480` and a handful of
    others confirmed valid; `thumb`/`original` are NOT). Neither Referer,
    Origin, nor Accept headers changed the outcome — this is a required
    query parameter, not a header/auth problem. Full write-up:
    docs/architecture/connectors.md's Milanuncios section and D-019.

    `ad.images` entries never carry this parameter themselves (unlike
    Fotocasa's own `multimedia[].src`, which already arrives with
    `?rule=original` baked in server-side — both sites share the same
    Adevinta media backend) — Milanuncios' frontend applies it at render
    time instead, so `normalize()` has to add it.

    Constructs a `RawListing` with a minimal `props` dict directly (rather
    than a full HTML fixture) since only `ad.images` matters here — every
    other field normalize() reads defaults safely via `.get(...) or {}`.
    """

    def _normalize_images(self, images: list[str]):
        raw = RawListing(
            external_id="900000001",
            source="milanuncios",
            raw={
                "url": "https://www.milanuncios.com/x",
                "props": {"ad": {"images": images}},
            },
        )
        return MilanunciosConnector().normalize(raw)

    def test_bare_image_path_gets_a_rule_parameter_appended(self):
        canonical = self._normalize_images(
            ["images-re.milanuncios.com/images/ads/aaa-uuid"]
        )
        assert canonical.photo_urls == (
            "https://images-re.milanuncios.com/images/ads/aaa-uuid?rule=detail_640x480",
        )

    def test_the_reported_ma_ad_media_pro_domain_also_gets_a_rule_parameter(self):
        """The exact host/path shape from the production log line this
        issue reports (`images.milanuncios.com/api/v1/ma-ad-media-pro/
        images/<uuid>`) — live-confirmed to 404 without `?rule=`."""
        canonical = self._normalize_images(
            [
                (
                    "images.milanuncios.com/api/v1/ma-ad-media-pro/images/"
                    "d2b83929-0000-0000-0000-000000000000"
                )
            ]
        )
        assert canonical.photo_urls[0].endswith("?rule=detail_640x480")
        assert canonical.photo_urls[0].startswith(
            "https://images.milanuncios.com/api/v1/ma-ad-media-pro/images/"
        )

    def test_a_url_that_already_carries_a_query_string_is_left_alone(self):
        """Never double up — an entry that (now or in the future) already
        includes its own query string must not get a second `?`/`&rule=`
        glued on."""
        canonical = self._normalize_images(
            ["https://images.example.com/already-has-a-rule?rule=original"]
        )
        assert canonical.photo_urls == (
            "https://images.example.com/already-has-a-rule?rule=original",
        )

    def test_protocol_relative_and_full_https_inputs_both_get_the_rule(self):
        canonical = self._normalize_images(
            [
                "//images.milanuncios.com/protocol-relative",
                "https://images.milanuncios.com/already-https",
            ]
        )
        assert canonical.photo_urls == (
            "https://images.milanuncios.com/protocol-relative?rule=detail_640x480",
            "https://images.milanuncios.com/already-https?rule=detail_640x480",
        )


class TestAddPhotoRuleIfMissing:
    """Direct, no-network unit tests for the hoisted module-level helper
    (issue #210) — `TestPhotoUrlRuleParameter` above already covers it
    indirectly through `normalize()`; these pin the function itself, since
    it's now also the reference implementation
    `TestMilanunciosPhotoUrlBackfillMigration` (below) checks the init.sql
    backfill migration's SQL against."""

    def test_no_query_string_gets_the_rule_appended(self):
        assert (
            add_photo_rule_if_missing("https://images.milanuncios.com/x")
            == "https://images.milanuncios.com/x?rule=detail_640x480"
        )

    def test_existing_non_empty_query_string_is_left_alone(self):
        assert (
            add_photo_rule_if_missing("https://images.example.com/x?rule=original")
            == "https://images.example.com/x?rule=original"
        )
        assert (
            add_photo_rule_if_missing("https://images.example.com/x?w=100")
            == "https://images.example.com/x?w=100"
        )

    def test_trailing_bare_question_mark_counts_as_no_query_and_uses_ampersand(self):
        """`urlsplit(...).query` is empty for a URL ending in a bare `?` (no
        content after it) — the same "no query" bucket as no `?` at all, but
        the separator must be `&` (not a second `?`) so the migration's SQL,
        checked byte-for-byte against this function, doesn't itself need a
        second code path to reach the same string."""
        assert (
            add_photo_rule_if_missing("https://images.milanuncios.com/x?")
            == "https://images.milanuncios.com/x?&rule=detail_640x480"
        )


class TestMilanunciosPhotoUrlBackfillMigration:
    """Issue #210: PR #209 (issue #206) fixed missing `?rule=` query
    parameters at ingest (`normalize()`), but every URL already stored in
    `listing.photo_urls` before that deploy was untouched — live-confirmed
    0 of 795 stored Milanuncios photo URLs carried a query string
    immediately after deploying #209. `etl/schema/init.sql`'s "Backfill:
    Milanuncios photo URLs..." UPDATE is the one-off migration; these tests
    are the DB-backed proof that (a) it produces the exact same output as
    `add_photo_rule_if_missing` (not a hand-reimplemented rule that could
    silently drift from the connector's), and (b) it is safe to re-run
    indefinitely (this file is re-applied on every ETL container start).
    """

    def test_migration_sql_matches_add_photo_rule_if_missing(self, pg_conn):
        """Runs the real init.sql (including the backfill UPDATE) against a
        battery of representative URLs — both real production shapes (the
        two CDN hosts from D-020) and the edge cases
        `TestAddPhotoRuleIfMissing` pins in Python — and asserts the SQL's
        output equals `add_photo_rule_if_missing`'s output for every one of
        them. If the two ever disagree, this test catches it before a
        second, differently-migrated batch of hashes could disagree with
        the first (see the module docstring/init.sql's own comment on why
        that matters more than the migration simply "doing something")."""
        _apply_schema(pg_conn)
        _cleanup_listings(pg_conn)

        input_urls = [
            # Real shapes, both hosts (D-020).
            "https://images-re.milanuncios.com/images/ads/aaa-uuid",
            (
                "https://images.milanuncios.com/api/v1/ma-ad-media-pro/images/"
                "d2b83929-0000-0000-0000-000000000000"
            ),
            # Already migrated / freshly ingested post-#209 — must be a
            # true no-op.
            "https://images.milanuncios.com/already-done?rule=detail_640x480",
            # Some other, non-rule query string — must not be double-mangled.
            "https://images.example.com/x?w=100",
            # Trailing bare "?" edge case (see TestAddPhotoRuleIfMissing).
            "https://images.milanuncios.com/trailing-qm?",
        ]
        expected = [add_photo_rule_if_missing(u) for u in input_urls]

        listing_id = _insert_milanuncios_listing(pg_conn, tuple(input_urls))

        # init.sql already ran (and already applied the migration) via
        # _apply_schema above — re-run schema/init.sql's file text a second
        # time explicitly here so this one test also exercises "the
        # migration runs against rows inserted after the first pass",
        # mirroring a real ETL container restart picking up freshly-synced
        # listings that (for whatever reason) still carry a bare URL.
        with pg_conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute("SELECT photo_urls FROM listing WHERE id = %s", (listing_id,))
            (actual,) = cur.fetchone()

        assert actual == expected

    def test_migration_is_idempotent_on_a_second_application(self, pg_conn):
        """Apply the migration (via init.sql) twice against a database
        populated from `main` and confirm the second run is a no-op — the
        issue's own explicit acceptance criterion, not just "the WHERE
        clause looks idempotent"."""
        _apply_schema(pg_conn)
        _cleanup_listings(pg_conn)

        listing_id = _insert_milanuncios_listing(
            pg_conn,
            (
                "https://images-re.milanuncios.com/images/ads/bbb-uuid",
                "https://images.milanuncios.com/api/v1/ma-ad-media-pro/images/ccc",
            ),
        )

        # First application: schema/init.sql was already applied once by
        # _apply_schema() above (before these rows existed) — apply it
        # again now that the rows are present, which is the actual
        # backfill pass for this data.
        with pg_conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute("SELECT photo_urls FROM listing WHERE id = %s", (listing_id,))
            (after_first,) = cur.fetchone()

        assert all("?rule=detail_640x480" in u for u in after_first)

        # Second application — must be a byte-for-byte no-op.
        with pg_conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute("SELECT photo_urls FROM listing WHERE id = %s", (listing_id,))
            (after_second,) = cur.fetchone()

        assert after_second == after_first

    def test_non_milanuncios_listings_are_never_touched(self, pg_conn):
        """The migration is scoped to `source = 'milanuncios'` — a
        Fotocasa/Solvia/etc. listing's bare photo URL (however it got that
        way) must be left exactly as stored."""
        _apply_schema(pg_conn)
        _cleanup_listings(pg_conn)

        listing_id = _insert_listing(
            pg_conn,
            source="fotocasa",
            photo_urls=("https://images.example.com/no-query-string",),
        )

        with pg_conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
        pg_conn.commit()

        with pg_conn.cursor() as cur:
            cur.execute("SELECT photo_urls FROM listing WHERE id = %s", (listing_id,))
            (photo_urls,) = cur.fetchone()

        assert photo_urls == ["https://images.example.com/no-query-string"]


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
