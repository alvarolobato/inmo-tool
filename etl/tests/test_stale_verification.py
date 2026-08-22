"""Stale-listing verification: time nominates, only evidence decides (issue #643).

The mechanism under test exists because the two biggest sources in
production can never prove absence by sweeping — fotocasa reads page 1 only
and idealista has no `discover()` at all, so between them ~7.600 listings sit
`active` with 0 ever withdrawn, and 2.194 listings across all sources have
gone unseen for more than a week. The tempting fix (expire what is old) is
the one the owner explicitly ruled out: on an operator-paced ingest, elapsed
time measures OUR calendar, not the portal's inventory.

So every test here is ultimately about one invariant, stated four ways:
**a listing's status changes only on evidence of absence obtained from the
source, and never on elapsed time.** `TestTimeOnlyNominates` (EC-4) is the
one that would fail loudly if someone later added a time-based shortcut, and
it is deliberately written to be hard to satisfy accidentally.

Real PostgreSQL via the `pg_conn` fixture, for the same reason
test_orchestrator.py uses it: what is under test is what ends up persisted.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from etl import orchestrator
from etl.connectors import register_all
from etl.connectors.base import (
    CanonicalListingVersion,
    Connector,
    ConnectorError,
    ConnectorScope,
    ListingUnavailableError,
    RawListing,
    SoftBlockError,
    Throttle,
    VerificationOutcome,
)
from etl.connectors.circuit_breaker import CircuitBreaker
from etl.connectors.fotocasa import FotocasaConnector
from etl.connectors.fotocasa_rental import FotocasaRentalConnector
from etl.connectors.milanuncios import MilanunciosConnector
from etl.connectors.pisos import PisosConnector
from etl.connectors.rate_limit import RateLimiter

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"
_FIXTURES = Path(__file__).parent / "fixtures"

_SOURCE = "stale-verify-test"


# --------------------------------------------------------------------------
# Test doubles
# --------------------------------------------------------------------------


class _VerifyingConnector(Connector):
    """A connector that opts into verification and answers from a script.

    `answers` maps external_id -> either a `VerificationOutcome` to return or
    an exception instance to raise, so a single test can mix every branch of
    the outcome mapping in one pass. `verify_calls` records the order calls
    were made in, which is what the nomination-ordering and budget tests
    assert on.
    """

    supports_stale_verification = True
    discovers_full_inventory = False
    rate_limit_per_minute = 6000  # pacing is asserted via the limiter, not by waiting

    def __init__(self, name: str = _SOURCE, answers: dict | None = None) -> None:
        self.name = name
        self._answers = answers or {}
        self.verify_calls: list[str] = []
        self.throttle_calls = 0

    # discover/fetch_detail/normalize are never reached by the verification
    # pass — it calls verify_listing directly — but Connector is abstract.
    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        return []

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        raise NotImplementedError

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        raise NotImplementedError

    def verify_listing(
        self, external_id: str, url: str | None, throttle: Throttle
    ) -> VerificationOutcome:
        self.verify_calls.append(external_id)
        throttle()
        self.throttle_calls += 1
        answer = self._answers.get(external_id)
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            return VerificationOutcome("alive", f"HTTP 200 for {external_id}")
        return answer


def _canonical(external_id: str, source: str = _SOURCE) -> CanonicalListingVersion:
    return CanonicalListingVersion(
        external_id=external_id,
        source=source,
        url=f"https://example.test/{external_id}",
        listing_kind="particular",
        status="active",
        current_price=Decimal(123000),
        description="Refreshed by a verification pass.",
        photo_urls=(),
        contact_raw=None,
        address=f"Test address {external_id}",
        lat=None,
        lon=None,
        property_type="piso",
        m2_built=None,
        m2_useful=None,
        rooms=None,
        bathrooms=None,
        floor=None,
        has_elevator=None,
        year_built=None,
        energy_rating=None,
    )


# --------------------------------------------------------------------------
# DB helpers
# --------------------------------------------------------------------------


_TEST_PROFILE_NAME = "stale-verification-test-fixture-profile"


def _apply_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(_SCHEMA_SQL.read_text(encoding="utf-8"))
    # `run_all_connectors` derives a connector's scopes from active
    # search_profile rows; the verification-pass tests below drive
    # `verify_stale_listings` directly and don't care, but the end-to-end
    # Estado test does. Idempotent by name, same shape as test_orchestrator.py.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM search_profile WHERE name = %s AND archived_at IS NULL",
            (_TEST_PROFILE_NAME,),
        )
        if cur.fetchone() is None:
            cur.execute(
                "INSERT INTO search_profile (name, scope) VALUES (%s, %s)",
                (
                    _TEST_PROFILE_NAME,
                    (
                        '{"geography": {"type": "radius", '
                        '"center": [40.4168, -3.7038], "radius_km": 10}}'
                    ),
                ),
            )
    conn.commit()


def _cleanup(conn, source: str = _SOURCE) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM listing_status_event WHERE listing_id IN "
            "(SELECT id FROM listing WHERE source = %s)",
            (source,),
        )
        cur.execute(
            "DELETE FROM listing_price_history WHERE listing_id IN "
            "(SELECT id FROM listing WHERE source = %s)",
            (source,),
        )
        cur.execute("SELECT property_id FROM listing WHERE source = %s", (source,))
        property_ids = [row[0] for row in cur.fetchall()]
        cur.execute("DELETE FROM listing WHERE source = %s", (source,))
        if property_ids:
            cur.execute(
                "DELETE FROM profile_listing_state WHERE property_id = ANY(%s)",
                (property_ids,),
            )
            cur.execute(
                "DELETE FROM feedback_event WHERE property_id = ANY(%s)",
                (property_ids,),
            )
            cur.execute("DELETE FROM property WHERE id = ANY(%s)", (property_ids,))
    conn.commit()


def _insert_listing(
    conn,
    external_id: str,
    *,
    source: str = _SOURCE,
    unseen_days: float = 30,
    status: str = "active",
    url: str | None = None,
    last_verification_attempt_at: datetime | None = None,
) -> int:
    """One active listing whose presence clock is `unseen_days` in the past."""
    seen_at = datetime.now(timezone.utc) - timedelta(days=unseen_days)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO property (address, property_type) VALUES (%s, 'piso') "
            "RETURNING id",
            (f"Test address {external_id}",),
        )
        property_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO listing (property_id, source, external_id, url, status,
                                 first_seen_at, last_seen_at, last_fetched_at,
                                 current_price, last_verification_attempt_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                property_id,
                source,
                external_id,
                url or f"https://example.test/{external_id}",
                status,
                seen_at,
                seen_at,
                seen_at,
                Decimal(100000),
                last_verification_attempt_at,
            ),
        )
        return cur.fetchone()[0]


def _listing_row(conn, listing_id: int) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, last_seen_at, last_fetched_at, "
            "       last_verification_attempt_at, current_price "
            "  FROM listing WHERE id = %s",
            (listing_id,),
        )
        row = cur.fetchone()
    return {
        "status": row[0],
        "last_seen_at": row[1],
        "last_fetched_at": row[2],
        "last_verification_attempt_at": row[3],
        "current_price": row[4],
    }


def _status_events(conn, listing_id: int) -> list[tuple[str, str | None]]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, evidence FROM listing_status_event "
            " WHERE listing_id = %s ORDER BY id",
            (listing_id,),
        )
        return [(row[0], row[1]) for row in cur.fetchall()]


def _run_verification(conn, connector, **kwargs) -> dict:
    limiter = RateLimiter(connector.rate_limit_per_minute)
    breaker = kwargs.pop("breaker", None) or CircuitBreaker(0.5, 100, window=100)
    return orchestrator.verify_stale_listings(
        conn, connector, limiter, breaker, **kwargs
    )


# --------------------------------------------------------------------------
# EC-1 — outcome mapping
# --------------------------------------------------------------------------


class TestOutcomeMapping:
    """EC-1: outcome mapping.

    A stale listing whose re-fetch returns 404 becomes `withdrawn` with an
    event naming the evidence; one that returns an alive page stays `active`
    with refreshed timestamps.
    """

    def test_http_gone_withdraws_the_listing_and_cites_the_evidence(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "gone-1")
            connector = _VerifyingConnector(
                answers={
                    "gone-1": ListingUnavailableError(
                        "HTTP 404 at https://example.test/gone-1 — removed at source"
                    )
                }
            )

            result = _run_verification(pg_conn, connector)

            assert result["gone"] == 1
            assert result["verified"] == 1
            assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
            events = _status_events(pg_conn, listing_id)
            assert len(events) == 1
            status, evidence = events[0]
            assert status == "withdrawn"
            # The whole point of the column: the row can answer "evidence of
            # what?" on its own, without a log line that has since rotated.
            assert evidence is not None
            assert "404" in evidence
        finally:
            _cleanup(pg_conn)

    def test_a_positive_retired_page_signature_also_withdraws(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "retired-1")
            connector = _VerifyingConnector(
                answers={
                    "retired-1": VerificationOutcome(
                        "gone", "el portal sirvió su página de 'anuncio retirado'"
                    )
                }
            )

            result = _run_verification(pg_conn, connector)

            assert result["gone"] == 1
            assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
            assert _status_events(pg_conn, listing_id) == [
                ("withdrawn", "el portal sirvió su página de 'anuncio retirado'")
            ]
        finally:
            _cleanup(pg_conn)

    def test_alive_refreshes_the_presence_clocks_and_keeps_the_status(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "alive-1", unseen_days=45)
            before = _listing_row(pg_conn, listing_id)
            connector = _VerifyingConnector(
                answers={"alive-1": VerificationOutcome("alive", "HTTP 200, parseable")}
            )

            result = _run_verification(pg_conn, connector)

            assert result == {
                "nominated": 1,
                "verified": 1,
                "gone": 0,
                "alive": 1,
                "soft_blocked": 0,
                "errors": 0,
            }
            after = _listing_row(pg_conn, listing_id)
            assert after["status"] == "active"
            # The self-healing half of the feature: the backlog shrinks
            # because the listing is genuinely re-observed, not re-clocked.
            assert after["last_seen_at"] > before["last_seen_at"]
            assert after["last_fetched_at"] > before["last_fetched_at"]
            assert _status_events(pg_conn, listing_id) == []
        finally:
            _cleanup(pg_conn)

    def test_alive_with_a_canonical_listing_persists_the_refreshed_data(self, pg_conn):
        """A connector that re-ran its own detail path hands back a normalized
        listing; verification then doubles as a real refresh rather than only
        moving a timestamp."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "alive-2")
            connector = _VerifyingConnector(
                answers={
                    "alive-2": VerificationOutcome(
                        "alive", "HTTP 200, parseable", _canonical("alive-2")
                    )
                }
            )

            result = _run_verification(pg_conn, connector)

            assert result["alive"] == 1
            row = _listing_row(pg_conn, listing_id)
            assert row["status"] == "active"
            assert row["current_price"] == Decimal("123000.00")
        finally:
            _cleanup(pg_conn)

    def test_a_mixed_pass_maps_every_branch_independently(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            gone_id = _insert_listing(pg_conn, "mix-gone", unseen_days=50)
            alive_id = _insert_listing(pg_conn, "mix-alive", unseen_days=40)
            blocked_id = _insert_listing(pg_conn, "mix-block", unseen_days=30)
            error_id = _insert_listing(pg_conn, "mix-error", unseen_days=20)
            connector = _VerifyingConnector(
                answers={
                    "mix-gone": ListingUnavailableError("HTTP 410"),
                    "mix-alive": VerificationOutcome("alive", "HTTP 200"),
                    "mix-block": SoftBlockError("captcha wall"),
                    "mix-error": ConnectorError("connection reset"),
                }
            )

            result = _run_verification(pg_conn, connector)

            assert result == {
                "nominated": 4,
                "verified": 2,
                "gone": 1,
                "alive": 1,
                "soft_blocked": 1,
                "errors": 1,
            }
            assert _listing_row(pg_conn, gone_id)["status"] == "withdrawn"
            assert _listing_row(pg_conn, alive_id)["status"] == "active"
            assert _listing_row(pg_conn, blocked_id)["status"] == "active"
            assert _listing_row(pg_conn, error_id)["status"] == "active"
        finally:
            _cleanup(pg_conn)


# --------------------------------------------------------------------------
# EC-2 — no evidence, no change
# --------------------------------------------------------------------------


class TestNoEvidenceNoChange:
    """EC-2: a soft-blocked verification changes nothing.

    Live-confirmed motivation (2026-08-22 spike): of two of production's
    oldest-`last_seen_at` milanuncios ads, one served the real page and the
    other served the site's "Pardon Our Interruption" bot wall with HTTP 200.
    A design that read "we couldn't parse it" as "it's gone" would have
    withdrawn a live ad on the strength of our own rate-throttling.
    """

    @pytest.mark.parametrize(
        "failure",
        [
            SoftBlockError("Pardon Our Interruption"),
            ConnectorError("HTTP 200 with no listing payload — indeterminate"),
            ConnectorError("read timeout"),
        ],
        ids=["soft-block", "unparseable-200", "timeout"],
    )
    def test_an_answerless_verification_leaves_the_listing_untouched(
        self, pg_conn, failure
    ):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "no-evidence-1", unseen_days=90)
            before = _listing_row(pg_conn, listing_id)
            connector = _VerifyingConnector(answers={"no-evidence-1": failure})

            result = _run_verification(pg_conn, connector)

            assert result["gone"] == 0
            assert result["alive"] == 0
            assert result["verified"] == 0
            after = _listing_row(pg_conn, listing_id)
            assert after["status"] == before["status"] == "active"
            assert after["last_seen_at"] == before["last_seen_at"]
            assert after["last_fetched_at"] == before["last_fetched_at"]
            assert _status_events(pg_conn, listing_id) == []
            # The ONE thing that does move: we asked. That is a fact about us,
            # not about the listing, and it only rotates the queue.
            assert after["last_verification_attempt_at"] is not None
        finally:
            _cleanup(pg_conn)

    def test_an_empty_200_is_never_treated_as_gone_even_repeatedly(self, pg_conn):
        """Three consecutive answerless verifications still withdraw nothing.

        There is no "N strikes and it's out" accumulator on this path, on
        purpose: repeating an observation that proves nothing does not add up
        to proof. (`missed_discovery_count` is a different mechanism, gated on
        full-inventory sweeps — issue #641's territory, not this one.)
        """
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "no-evidence-2", unseen_days=120)
            connector = _VerifyingConnector(
                answers={"no-evidence-2": SoftBlockError("captcha")}
            )

            for _ in range(3):
                _run_verification(pg_conn, connector)

            assert _listing_row(pg_conn, listing_id)["status"] == "active"
            assert _status_events(pg_conn, listing_id) == []
        finally:
            _cleanup(pg_conn)

    def test_a_wholesale_gone_wave_withdraws_nothing(self, pg_conn):
        """The mass-withdrawal guard: "every listing we asked about is 404" is
        the signature of our own detail-URL construction breaking, not of a
        real removal wave. Cost asymmetry decides it — a missed withdrawal is
        invisible, a false one silently deletes a live candidate from every
        profile feed."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_ids = [
                _insert_listing(pg_conn, f"wave-{i}", unseen_days=30 + i)
                for i in range(8)
            ]
            connector = _VerifyingConnector(
                answers={
                    f"wave-{i}": ListingUnavailableError("HTTP 404") for i in range(8)
                }
            )

            result = _run_verification(pg_conn, connector)

            assert result["verified"] == 8
            assert result["gone"] == 0
            for listing_id in listing_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "active"
                assert _status_events(pg_conn, listing_id) == []
        finally:
            _cleanup(pg_conn)

    def test_a_plausible_gone_fraction_is_still_applied(self, pg_conn):
        """The guard must not swallow ordinary churn: a minority of 404s among
        verified listings is exactly what the mechanism exists to catch."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            gone_ids = [
                _insert_listing(pg_conn, f"churn-gone-{i}", unseen_days=60 - i)
                for i in range(2)
            ]
            answers = {
                f"churn-gone-{i}": ListingUnavailableError("HTTP 404") for i in range(2)
            }
            for i in range(6):
                _insert_listing(pg_conn, f"churn-alive-{i}", unseen_days=30 - i)
                answers[f"churn-alive-{i}"] = VerificationOutcome("alive", "HTTP 200")
            connector = _VerifyingConnector(answers=answers)

            result = _run_verification(pg_conn, connector)

            assert result["verified"] == 8
            assert result["gone"] == 2
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
        finally:
            _cleanup(pg_conn)


# --------------------------------------------------------------------------
# EC-3 — budget and rate compliance
# --------------------------------------------------------------------------


class TestBudgetAndRateCompliance:
    """EC-3: verification never exceeds the per-run budget nor the
    connector's rate limit."""

    def test_never_verifies_more_than_the_budget(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            for i in range(25):
                _insert_listing(pg_conn, f"budget-{i:02d}", unseen_days=100 - i)
            connector = _VerifyingConnector()

            result = _run_verification(pg_conn, connector, budget=4)

            assert result["nominated"] == 4
            assert len(connector.verify_calls) == 4
        finally:
            _cleanup(pg_conn)

    def test_a_zero_budget_disables_the_pass_entirely(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "budget-off")
            connector = _VerifyingConnector()

            result = _run_verification(pg_conn, connector, budget=0)

            assert result["nominated"] == 0
            assert connector.verify_calls == []
            assert _listing_row(pg_conn, listing_id)["status"] == "active"
        finally:
            _cleanup(pg_conn)

    def test_every_verification_goes_through_the_connectors_rate_limiter(self, pg_conn):
        """The pass passes `limiter.acquire` as the connector's `throttle`, so
        verification traffic is paced by the same measured, per-connector rate
        as everything else (D-017's 2/min for milanuncios, and so on) rather
        than by a second, unpaced path to the same site."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            for i in range(3):
                _insert_listing(pg_conn, f"rate-{i}", unseen_days=40 - i)
            connector = _VerifyingConnector()
            limiter = RateLimiter(connector.rate_limit_per_minute)
            acquires: list[int] = []
            original = limiter.acquire

            def counting_acquire() -> None:
                acquires.append(1)
                original()

            limiter.acquire = counting_acquire  # type: ignore[method-assign]

            orchestrator.verify_stale_listings(
                pg_conn,
                connector,
                limiter,
                CircuitBreaker(0.5, 100, window=100),
                budget=10,
            )

            assert connector.throttle_calls == 3
            assert len(acquires) == 3
        finally:
            _cleanup(pg_conn)

    def test_an_already_open_breaker_stops_the_pass_before_it_starts(self, pg_conn):
        """Verification is the lowest-priority consumer of a connector's
        budget (D-070's posture): if the real discovery/fetch work already
        spent the error allowance, there is nothing left for it."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            _insert_listing(pg_conn, "breaker-1")
            connector = _VerifyingConnector()
            breaker = CircuitBreaker(0.5, 1, window=10)
            breaker.record_error(soft_block=False)
            breaker.record_error(soft_block=False)
            assert breaker.tripped

            result = _run_verification(pg_conn, connector, breaker=breaker)

            assert result["nominated"] == 0
            assert connector.verify_calls == []
        finally:
            _cleanup(pg_conn)

    def test_a_breaker_that_opens_mid_pass_stops_the_remaining_listings(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            for i in range(6):
                _insert_listing(pg_conn, f"trip-{i}", unseen_days=60 - i)
            connector = _VerifyingConnector(
                answers={f"trip-{i}": ConnectorError("boom") for i in range(6)}
            )
            breaker = CircuitBreaker(0.5, 2, window=10)

            result = _run_verification(pg_conn, connector, breaker=breaker)

            assert result["errors"] < 6
            assert len(connector.verify_calls) < 6
        finally:
            _cleanup(pg_conn)

    def test_accepted_properties_are_exempt_from_nomination(self, pg_conn):
        """D-099 (issue #436): accepted / 'en seguimiento' properties are
        already force-fetched in FULL on every pass, so nominating them would
        spend the budget re-asking a question the fetch loop just answered."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            accepted_listing = _insert_listing(pg_conn, "accepted-1", unseen_days=200)
            _insert_listing(pg_conn, "ordinary-1", unseen_days=30)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT property_id FROM listing WHERE id = %s", (accepted_listing,)
                )
                accepted_property_id = cur.fetchone()[0]
            connector = _VerifyingConnector()

            _run_verification(
                pg_conn,
                connector,
                accepted_property_ids={accepted_property_id},
            )

            assert connector.verify_calls == ["ordinary-1"]
        finally:
            _cleanup(pg_conn)


# --------------------------------------------------------------------------
# EC-4 — time only nominates
# --------------------------------------------------------------------------


class TestTimeOnlyNominates:
    """EC-4: no listing anywhere changes status from elapsed time alone.

    This is the invariant the whole issue was rewritten around, after the
    owner pointed out that idealista had not been fully captured in about a
    week and that a time-triggered expiry would therefore delete on the
    operator's calendar rather than on the portal's inventory.

    These tests are written to be hostile to a future shortcut. If someone
    adds "…and if it's been N days, just mark it withdrawn", at least one of
    them fails — including the source-level guard at the end, which catches
    the shortcut even if it is added somewhere no behavioural test happens to
    exercise.
    """

    def test_arbitrarily_old_listings_are_untouched_when_nothing_verifies_them(
        self, pg_conn
    ):
        """Ten years unobserved, verification unavailable for the source:
        still `active`, still no status event. Age is not evidence."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_ids = [
                _insert_listing(pg_conn, f"ancient-{i}", unseen_days=3650)
                for i in range(5)
            ]

            class _OptedOut(_VerifyingConnector):
                supports_stale_verification = False

            result = _run_verification(pg_conn, _OptedOut())

            assert result["nominated"] == 0
            for listing_id in listing_ids:
                row = _listing_row(pg_conn, listing_id)
                assert row["status"] == "active"
                assert _status_events(pg_conn, listing_id) == []
        finally:
            _cleanup(pg_conn)

    def test_nomination_by_itself_changes_nothing_about_a_listing(self, pg_conn):
        """`_nominate_stale_listings` is a question, not a verdict: calling it
        must leave the database byte-for-byte as it found it."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            listing_id = _insert_listing(pg_conn, "nominate-only", unseen_days=400)
            before = _listing_row(pg_conn, listing_id)

            nominated = orchestrator._nominate_stale_listings(
                pg_conn, _SOURCE, min_age_hours=168, budget=10
            )

            assert [external_id for _, external_id, _ in nominated] == ["nominate-only"]
            assert _listing_row(pg_conn, listing_id) == before
            assert _status_events(pg_conn, listing_id) == []
        finally:
            _cleanup(pg_conn)

    def test_the_age_threshold_only_gates_who_is_asked_not_what_happens(self, pg_conn):
        """A listing below the nomination threshold is never asked about; one
        above it is asked and then treated exactly the same as any other —
        the threshold has no say in the outcome."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            fresh_id = _insert_listing(pg_conn, "fresh-1", unseen_days=1)
            stale_id = _insert_listing(pg_conn, "stale-1", unseen_days=30)
            # Both answer "no evidence". The stale one is asked, the fresh one
            # is not, and NEITHER changes.
            connector = _VerifyingConnector(
                answers={
                    "fresh-1": SoftBlockError("captcha"),
                    "stale-1": SoftBlockError("captcha"),
                }
            )

            _run_verification(pg_conn, connector, min_age_hours=168)

            assert connector.verify_calls == ["stale-1"]
            assert _listing_row(pg_conn, fresh_id)["status"] == "active"
            assert _listing_row(pg_conn, stale_id)["status"] == "active"
        finally:
            _cleanup(pg_conn)

    def test_the_oldest_unobserved_listings_are_asked_about_first(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            _insert_listing(pg_conn, "order-newest", unseen_days=10)
            _insert_listing(pg_conn, "order-oldest", unseen_days=300)
            _insert_listing(pg_conn, "order-middle", unseen_days=100)
            connector = _VerifyingConnector()

            _run_verification(pg_conn, connector, budget=3)

            assert connector.verify_calls == [
                "order-oldest",
                "order-middle",
                "order-newest",
            ]
        finally:
            _cleanup(pg_conn)

    def test_an_asked_listing_rotates_to_the_back_of_the_queue(self, pg_conn):
        """Fairness (the D-030 argument, applied to this queue): without
        rotation, a handful of permanently-unverifiable listings would occupy
        the whole budget forever and the backlog behind them would never
        drain."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            _insert_listing(pg_conn, "rot-a", unseen_days=300)
            _insert_listing(pg_conn, "rot-b", unseen_days=200)
            connector = _VerifyingConnector(
                answers={
                    "rot-a": SoftBlockError("captcha"),
                    "rot-b": SoftBlockError("captcha"),
                }
            )

            _run_verification(pg_conn, connector, budget=1)
            _run_verification(pg_conn, connector, budget=1)
            _run_verification(pg_conn, connector, budget=1)

            # a, then b, then a again — never a, a, a.
            assert connector.verify_calls == ["rot-a", "rot-b", "rot-a"]
        finally:
            _cleanup(pg_conn)

    def test_a_withdrawn_listing_is_never_re_nominated(self, pg_conn):
        """Resurrection is #641's mechanism, not this one's — verification only
        ever looks at listings that are still `active`."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            _insert_listing(
                pg_conn, "already-gone", unseen_days=500, status="withdrawn"
            )
            connector = _VerifyingConnector()

            result = _run_verification(pg_conn, connector)

            assert result["nominated"] == 0
            assert connector.verify_calls == []
        finally:
            _cleanup(pg_conn)

    def test_no_sql_in_etl_derives_a_listing_status_from_elapsed_time(self):
        """Source-level guard, the one that catches a shortcut added anywhere.

        Behavioural tests can only cover the paths they happen to exercise. A
        future "expire anything older than N days" would most plausibly arrive
        as one new UPDATE somewhere in `etl/`, and might well not go through
        `verify_stale_listings` at all. So this scans every statement in the
        package that writes a non-active `listing.status` and fails if the
        same statement also carries an age predicate.

        If this test fails, the fix is NOT to relax the pattern: it is that a
        status is being derived from a clock, which the whole of issue #643
        exists to forbid. Evidence comes from the source, never from the
        calendar.
        """
        age_predicate = re.compile(
            r"NOW\(\)\s*-|CURRENT_TIMESTAMP\s*-|make_interval|INTERVAL\s*'",
            re.IGNORECASE,
        )
        status_write = re.compile(
            r"SET[^;]*\bstatus\s*=\s*'(withdrawn|expired|sold|reserved)'",
            re.IGNORECASE | re.DOTALL,
        )
        offenders: list[str] = []
        for path in sorted(Path(__file__).parent.parent.rglob("*.py")):
            if "tests" in path.parts:
                continue
            text = path.read_text(encoding="utf-8")
            for match in status_write.finditer(text):
                # The statement this write belongs to: from the preceding
                # UPDATE keyword to the end of the SET clause's line group.
                start = text.rfind("UPDATE", 0, match.start())
                statement = text[start if start != -1 else match.start() : match.end()]
                if age_predicate.search(statement):
                    offenders.append(f"{path.name}: {' '.join(statement.split())}")
        assert offenders == [], (
            "A listing status is being written by a statement that also filters "
            "on elapsed time. Time may only NOMINATE a listing for verification "
            "(issue #643) — a status change requires evidence from the source:\n"
            + "\n".join(offenders)
        )


# --------------------------------------------------------------------------
# Connector opt-in registry and retired-page signatures
# --------------------------------------------------------------------------


class TestConnectorOptIn:
    """Which connectors may be verified at all — a deliberate, enumerated
    list, because verification is the only mechanism allowed to withdraw a
    listing on a single observation."""

    def test_the_opted_in_set_is_exactly_what_this_phase_shipped(self):
        register_all()
        from etl.orchestrator import CONNECTORS

        opted_in = sorted(c.name for c in CONNECTORS if c.supports_stale_verification)
        assert opted_in == [
            "fotocasa",
            "milanuncios",
            "milanuncios_rental",
            "pisos",
        ]

    def test_no_capture_only_portal_is_verified_in_the_background(self):
        """OUT of scope entirely (D-081/D-026/D-027): idealista, aliseda,
        altamira and hipoges are captured through the browser extension
        precisely because background fetching them hits a WAF. Their evidence
        path is issue #645, not this one."""
        register_all()
        from etl.orchestrator import CONNECTORS

        for connector in CONNECTORS:
            if not connector.supports_discovery:
                assert not connector.supports_stale_verification, connector.name

    def test_no_full_inventory_connector_is_verified_here(self):
        """Full-inventory connectors already reconcile withdrawal at cycle
        close — that is issue #641's mechanism, and duplicating it here would
        give the same listing two independent withdrawal paths."""
        register_all()
        from etl.orchestrator import CONNECTORS

        for connector in CONNECTORS:
            if connector.discovers_full_inventory:
                assert not connector.supports_stale_verification, connector.name

    def test_a_stash_dependent_fetch_detail_stays_opted_out(self):
        """`FotocasaRentalConnector.fetch_detail` re-reads the record
        `discover()` stashed this run and raises `ListingUnavailableError`
        when the id is absent. During a verification pass that stash is
        empty, so inheriting its parent's opt-in would report EVERY nominated
        listing as gone and withdraw the source's whole inventory on evidence
        we never gathered."""
        assert FotocasaConnector.supports_stale_verification is True
        assert FotocasaRentalConnector.supports_stale_verification is False

    def test_the_default_is_opted_out_and_unimplemented(self):
        """A connector that flips the flag without implementing
        `verify_listing` must fail loudly on the first attempt rather than
        silently verify nothing."""
        assert Connector.supports_stale_verification is False
        with pytest.raises(NotImplementedError):
            _BareConnector().verify_listing("x", None, throttle=lambda: None)


class _BareConnector(Connector):
    name = "bare"

    def discover(self, scope: ConnectorScope, throttle: Throttle) -> list[str]:
        return []

    def fetch_detail(self, external_id: str, throttle: Throttle) -> RawListing:
        raise NotImplementedError

    def normalize(self, raw: RawListing) -> CanonicalListingVersion:
        raise NotImplementedError


class TestRetiredPageSignatures:
    """Per-portal signature spike, 2026-08-22 (live).

    Every one of the three portals answers a request for a detail page that
    no longer resolves with a real **HTTP 404**, which D-049 already turns
    into `ListingUnavailableError`. So 404/410 carries the whole signal today
    and a `retired_page_signature` is a second line of defence, not the
    primary one — which is exactly why two of the three deliberately do not
    have one. A wrong signature marks live listings withdrawn; an absent one
    costs nothing.
    """

    def test_fotocasa_recognises_its_own_not_found_redirect(self):
        """Observed live: a removed fotocasa listing answers 404 AND redirects
        to the generic search page carrying `?propertyNotFound`. The signature
        is keyed on the marker the site itself puts in the URL, so that if
        fotocasa ever serves that landing page with a 200, its search-page
        JSON is not parsed and stored as though it were the listing."""
        connector = FotocasaConnector()
        signature = connector.retired_page_signature(
            "<html>...</html>",
            "https://www.fotocasa.es/es/comprar/viviendas/x/todas-las-zonas/l?propertyNotFound",
        )
        assert signature is not None
        assert "propertyNotFound" in signature

    def test_fotocasa_does_not_fire_on_a_real_listing_page(self):
        connector = FotocasaConnector()
        html = (_FIXTURES / "fotocasa_sample_detail.html").read_text(encoding="utf-8")
        assert (
            connector.retired_page_signature(
                html, "https://www.fotocasa.es/es/comprar/vivienda/madrid-capital/x/1/d"
            )
            is None
        )

    def test_fotocasa_does_not_fire_on_a_soft_block_page(self):
        """The failure mode that would matter most: a bot wall must never be
        read as a retired page. It has no `propertyNotFound` marker, and the
        signature must not fall back to "the page looks empty"."""
        connector = FotocasaConnector()
        html = (_FIXTURES / "fotocasa_sample_block_page.html").read_text(
            encoding="utf-8"
        )
        assert connector.retired_page_signature(html, None) is None
        assert (
            connector.retired_page_signature(
                html, "https://www.fotocasa.es/es/comprar/vivienda/x/x/1/d"
            )
            is None
        )

    def test_milanuncios_deliberately_has_no_retired_page_signature(self):
        """Omitted, not forgotten. Milanuncios' only captured
        200-without-`__INITIAL_PROPS__` page is the GeeTest bot wall
        (docs/skills/connectors.md has tracked the missing retired-ad sample
        since #66/#179), so any signature built on "the props are missing"
        would map a rate-throttle straight to `withdrawn`."""
        connector = MilanunciosConnector()
        block = (_FIXTURES / "milanuncios_sample_soft_block_page.html").read_text(
            encoding="utf-8"
        )
        detail = (_FIXTURES / "milanuncios_sample_detail.html").read_text(
            encoding="utf-8"
        )
        assert connector.retired_page_signature(block, None) is None
        assert connector.retired_page_signature(detail, None) is None

    def test_pisos_recognises_a_real_listing_page_by_its_features_block(self):
        """pisos needs a POSITIVE alive marker that fotocasa/milanuncios do
        not, because its verification never reaches `normalize()` (there is no
        search record to normalize from). Live spike: a served listing carries
        7 `features__feature` blocks, the site's own 404 page carries none."""
        html = (_FIXTURES / "pisos_sample_detail.html").read_text(encoding="utf-8")
        assert PisosConnector._ALIVE_MARKER in html

    def test_pisos_not_found_page_carries_no_alive_marker(self):
        html = (_FIXTURES / "pisos_sample_not_found.html").read_text(encoding="utf-8")
        assert PisosConnector._ALIVE_MARKER not in html
        # And it is NOT claimed as a retired-page signature either: the HTTP
        # 404 status is what proves removal, so a 200 serving this shape would
        # be indeterminate rather than "gone".
        assert PisosConnector().retired_page_signature(html, None) is None


class TestPisosVerifyListing:
    """`PisosConnector.verify_listing` re-requests the listing's own stored
    URL rather than reusing the stash-dependent `fetch_detail`."""

    def _connector(self):
        return PisosConnector()

    def test_a_missing_stored_url_proves_nothing(self):
        with pytest.raises(ConnectorError):
            self._connector().verify_listing("x", None, throttle=lambda: None)

    def test_http_404_is_reported_as_gone(self, monkeypatch):
        import requests

        class _Resp:
            status_code = 404
            url = "https://www.pisos.com/comprar/x/"

            def raise_for_status(self):
                raise requests.HTTPError("404", response=self)

        monkeypatch.setattr(requests, "get", lambda *a, **k: _Resp())
        with pytest.raises(ListingUnavailableError):
            self._connector().verify_listing(
                "x", "https://www.pisos.com/comprar/x/", throttle=lambda: None
            )

    def test_a_served_listing_page_is_alive(self, monkeypatch):
        import requests

        html = (_FIXTURES / "pisos_sample_detail.html").read_text(encoding="utf-8")

        class _Resp:
            status_code = 200
            url = "https://www.pisos.com/comprar/x/"
            text = html

            def raise_for_status(self):
                return None

        monkeypatch.setattr(requests, "get", lambda *a, **k: _Resp())
        outcome = self._connector().verify_listing(
            "x", "https://www.pisos.com/comprar/x/", throttle=lambda: None
        )
        assert outcome.state == "alive"

    def test_a_200_without_the_marker_is_indeterminate_not_gone(self, monkeypatch):
        import requests

        class _Resp:
            status_code = 200
            url = "https://www.pisos.com/"
            text = "<html><body>Redirected somewhere else</body></html>"

            def raise_for_status(self):
                return None

        monkeypatch.setattr(requests, "get", lambda *a, **k: _Resp())
        with pytest.raises(ConnectorError) as excinfo:
            self._connector().verify_listing(
                "x", "https://www.pisos.com/comprar/x/", throttle=lambda: None
            )
        assert not isinstance(excinfo.value, ListingUnavailableError)


class TestVerifyViaFetchDetail:
    """The shared `verify_via_fetch_detail` helper: the retired-page check has
    to run BEFORE `normalize()`, or a not-found landing page parses into a
    plausible-looking but wrong canonical listing."""

    def test_the_retired_signature_short_circuits_normalize(self):
        normalize_calls: list[str] = []

        class _C(Connector):
            name = "sig"

            def discover(self, scope, throttle):
                return []

            def fetch_detail(self, external_id, throttle):
                return RawListing(
                    external_id=external_id,
                    source=self.name,
                    raw={"html": "<html/>", "url": "https://x.test/?gone=1"},
                )

            def normalize(self, raw):  # pragma: no cover — must not be reached
                normalize_calls.append(raw.external_id)
                raise AssertionError("normalize must not run for a retired page")

            def retired_page_signature(self, html, final_url=None):
                return (
                    "portal declared it retired"
                    if "gone=1" in (final_url or "")
                    else None
                )

        outcome = _C().verify_via_fetch_detail("1", throttle=lambda: None)
        assert outcome.state == "gone"
        assert outcome.canonical is None
        assert normalize_calls == []


# --------------------------------------------------------------------------
# Per-source counters for Estado
# --------------------------------------------------------------------------


class TestEstadoCounters:
    """Task 4 of issue #643: the verification outcome has to be visible per
    source, not just in a log line — Estado (#638) asks "¿cuántos anuncios
    desfasados hemos comprobado y cuántos resultaron retirados?" and must be
    able to answer it from the database.

    End-to-end through `run_all_connectors`, deliberately: the counters are
    only useful if the real run path threads them all the way into
    `connector_run_results`, which a direct call to `verify_stale_listings`
    would not prove.
    """

    def test_run_all_connectors_persists_verified_and_gone_counts(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_id = None
        try:
            _insert_listing(pg_conn, "estado-gone", unseen_days=60)
            _insert_listing(pg_conn, "estado-alive", unseen_days=50)
            _insert_listing(pg_conn, "estado-blocked", unseen_days=40)
            connector = _VerifyingConnector(
                answers={
                    "estado-gone": ListingUnavailableError("HTTP 404"),
                    "estado-alive": VerificationOutcome("alive", "HTTP 200"),
                    "estado-blocked": SoftBlockError("captcha"),
                }
            )
            orchestrator.CONNECTORS[:] = [connector]

            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT verified_count, verified_gone_count "
                    "  FROM connector_run_results "
                    " WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                verified, gone = cur.fetchone()
            # 2 verdicts (gone + alive); the soft block is in NEITHER counter —
            # it changed nothing, so reporting it as a verification would
            # overstate what the run established.
            assert (verified, gone) == (2, 1)
        finally:
            orchestrator.CONNECTORS.clear()
            if run_id is not None:
                with pg_conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM connector_run_results WHERE run_id = %s", (run_id,)
                    )
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                pg_conn.commit()
            _cleanup(pg_conn)

    def test_a_connector_without_verification_reports_zeroes_not_nulls(self, pg_conn):
        """`WHERE verified_gone_count > 0` has to be a usable filter, so the
        columns are NOT NULL DEFAULT 0 rather than nullable."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_id = None
        try:
            _insert_listing(pg_conn, "no-verify-1", unseen_days=400)

            class _OptedOut(_VerifyingConnector):
                supports_stale_verification = False

            connector = _OptedOut()
            orchestrator.CONNECTORS[:] = [connector]

            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT verified_count, verified_gone_count "
                    "  FROM connector_run_results "
                    " WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                assert cur.fetchone() == (0, 0)
        finally:
            orchestrator.CONNECTORS.clear()
            if run_id is not None:
                with pg_conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM connector_run_results WHERE run_id = %s", (run_id,)
                    )
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                pg_conn.commit()
            _cleanup(pg_conn)

    def test_a_verification_bug_never_fails_the_run(self, pg_conn):
        """The pass runs after real data has already been committed, so it must
        not be able to turn a good ingest into a failed one."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_id = None
        try:
            _insert_listing(pg_conn, "boom-1", unseen_days=60)

            class _Exploding(_VerifyingConnector):
                def verify_listing(self, external_id, url, throttle):
                    raise RuntimeError("verification is broken")

            connector = _Exploding()
            orchestrator.CONNECTORS[:] = [connector]

            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status, verified_count, verified_gone_count "
                    "  FROM connector_run_results "
                    " WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                status, verified, gone = cur.fetchone()
            assert status == "ok"
            assert (verified, gone) == (0, 0)
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM listing WHERE source = %s AND external_id = %s",
                    (_SOURCE, "boom-1"),
                )
                assert cur.fetchone()[0] == "active"
        finally:
            orchestrator.CONNECTORS.clear()
            if run_id is not None:
                with pg_conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM connector_run_results WHERE run_id = %s", (run_id,)
                    )
                    cur.execute("DELETE FROM connector_runs WHERE id = %s", (run_id,))
                pg_conn.commit()
            _cleanup(pg_conn)
