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

import ast
import re
import textwrap
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
from etl.connectors.milanuncios_rental import MilanunciosRentalConnector
from etl.connectors.pisos import PisosConnector
from etl.connectors.rate_limit import RateLimiter

_SCHEMA_SQL = Path(__file__).parent.parent / "schema" / "init.sql"
_FIXTURES = Path(__file__).parent / "fixtures"

_SOURCE = "stale-verify-test"


# --------------------------------------------------------------------------
# EC-4's source scanner (shared by the guard and by the guard's own self-test)
# --------------------------------------------------------------------------


_AGE_PREDICATE = re.compile(
    r"NOW\(\)\s*-|CURRENT_TIMESTAMP\s*-|make_interval|INTERVAL\s*'",
    re.IGNORECASE,
)

# A WRITE of a terminal status, not a read of one. Anchored on `SET`, and
# forbidden from crossing a `WHERE` or a `;` on its way to the assignment, so
# `UPDATE listing SET last_seen_at = NOW() WHERE status = 'withdrawn'` (a
# clock write on already-withdrawn rows) is correctly not a status write.
_STATUS_WRITE = re.compile(
    r"\bSET\b(?:(?!\bWHERE\b|;)[\s\S])*?\bstatus\s*=\s*"
    r"'(?:withdrawn|expired|sold|reserved)'",
    re.IGNORECASE,
)


def _sql_literals(source: str) -> list[str]:
    """Every string literal in `source`, with adjacent fragments already joined.

    The scanner works off the parsed AST rather than off raw text because SQL
    in this codebase is routinely written as several implicitly-concatenated
    fragments — `"UPDATE ... " " WHERE ..."` — and the whole point of PR
    #685's H1 is that a text scan which stops at the fragment carrying the
    status write never reaches the fragment carrying the WHERE clause.
    Python's own parser concatenates those fragments for us, so the statement
    arrives whole. f-strings (`JoinedStr`) are flattened to their literal
    parts, which is enough: an interpolated value can't hide a `NOW() -`.
    """
    literals: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            literals.append(node.value)
        elif isinstance(node, ast.JoinedStr):
            literals.append(
                "".join(
                    part.value
                    for part in node.values
                    if isinstance(part, ast.Constant) and isinstance(part.value, str)
                )
            )
    return literals


def _statements_deriving_status_from_time(source: str) -> list[str]:
    """SQL statements in `source` that write a terminal listing status AND
    filter on elapsed time — i.e. that derive a status from the clock.

    Split on `;` so two unrelated statements sharing one triple-quoted
    literal (a status write here, an age predicate there) don't read as one
    offender. Returns the offending statements, whitespace-collapsed, for the
    assertion message.
    """
    offenders: list[str] = []
    for literal in _sql_literals(source):
        for statement in literal.split(";"):
            if _STATUS_WRITE.search(statement) and _AGE_PREDICATE.search(statement):
                offenders.append(" ".join(statement.split()))
    return offenders


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
                "alarm": None,
                "suppressed_withdrawals": 0,
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
                # The guard stayed quiet: one withdrawal is never a mass one.
                "alarm": None,
                "suppressed_withdrawals": 0,
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
        `verify_stale_listings` at all. So this scans every SQL statement in
        the package that writes a non-active `listing.status` and fails if the
        same statement also carries an age predicate.

        If this test fails, the fix is NOT to relax the pattern: it is that a
        status is being derived from a clock, which the whole of issue #643
        exists to forbid. Evidence comes from the source, never from the
        calendar.

        The scanner itself is exercised against a deliberate offender by
        `test_the_time_derived_status_guard_actually_fires` below — a guard
        nobody has ever seen fire is a green check, not a guarantee.
        """
        offenders: list[str] = []
        for path in sorted(Path(__file__).parent.parent.rglob("*.py")):
            if "tests" in path.parts:
                continue
            for statement in _statements_deriving_status_from_time(
                path.read_text(encoding="utf-8")
            ):
                offenders.append(f"{path.name}: {statement}")
        assert offenders == [], (
            "A listing status is being written by a statement that also filters "
            "on elapsed time. Time may only NOMINATE a listing for verification "
            "(issue #643) — a status change requires evidence from the source:\n"
            + "\n".join(offenders)
        )

    @pytest.mark.parametrize(
        "label,source",
        [
            (
                "one-line UPDATE",
                """
                cur.execute(
                    "UPDATE listing SET status = 'withdrawn'"
                    " WHERE last_seen_at < NOW() - INTERVAL '45 days'"
                )
                """,
            ),
            (
                "implicitly concatenated fragments, predicate in the WHERE",
                """
                cur.execute(
                    "UPDATE listing SET status = 'withdrawn' "
                    " WHERE status = 'active' "
                    "   AND last_seen_at < NOW() - INTERVAL '45 days'"
                )
                """,
            ),
            (
                "triple-quoted SQL with make_interval",
                '''
                cur.execute(
                    """
                    UPDATE listing SET status = 'expired'
                     WHERE last_seen_at < NOW() - make_interval(days => %s)
                    """,
                    (45,),
                )
                ''',
            ),
            (
                "CTE-scoped, the status write far from the predicate",
                '''
                cur.execute(
                    """
                    WITH overdue AS (
                        SELECT id FROM listing
                         WHERE last_seen_at
                                 < CURRENT_TIMESTAMP - INTERVAL '45 days'
                    )
                    UPDATE listing SET status = 'withdrawn'
                     WHERE id IN (SELECT id FROM overdue)
                    """
                )
                ''',
            ),
            (
                "f-string with an interpolated window",
                """
                cur.execute(
                    f"UPDATE listing SET status = 'sold'"
                    f" WHERE last_seen_at < NOW() - INTERVAL '{days} days'"
                )
                """,
            ),
        ],
    )
    def test_the_time_derived_status_guard_actually_fires(self, label, source):
        """The guard above is only worth having if it FIRES on the exact thing
        D-157 forbids. It previously did not: it sliced the statement off at
        the closing quote of `'withdrawn'`, so the WHERE clause — the only
        place an age predicate ever appears — was never scanned, and every
        offender below sailed straight through it (PR #685 review, H1).

        So the offenders live here, in the one directory the scanner
        deliberately skips, and are fed to it directly.
        """
        found = _statements_deriving_status_from_time(textwrap.dedent(source))
        assert found, f"guard failed to fire on: {label}"

    @pytest.mark.parametrize(
        "label,source",
        [
            (
                "nomination: an age predicate with no status write at all",
                '''
                cur.execute(
                    """
                    SELECT l.id FROM listing l
                     WHERE l.status = 'active'
                       AND l.last_seen_at < NOW() - make_interval(hours => %s)
                    """
                )
                ''',
            ),
            (
                "withdrawal on evidence: a status write with no clock",
                """
                cur.execute(
                    "UPDATE listing SET status = 'withdrawn' WHERE id = %s",
                    (listing_id,),
                )
                """,
            ),
            (
                "reading withdrawn rows by age is not writing a status",
                """
                cur.execute(
                    "SELECT id FROM listing WHERE status = 'withdrawn'"
                    "   AND last_seen_at < NOW() - INTERVAL '30 days'"
                )
                """,
            ),
            (
                "touching a clock column while filtering on one is fine",
                """
                cur.execute(
                    "UPDATE listing SET last_verification_attempt_at = NOW()"
                    " WHERE status = 'withdrawn' AND id = %s",
                    (listing_id,),
                )
                """,
            ),
        ],
    )
    def test_the_guard_does_not_fire_on_legitimate_sql(self, label, source):
        """The other half of proving a guard works: it must stay quiet on the
        patterns this feature is actually built out of. A guard that fired on
        `_nominate_stale_listings` would be switched off within a week."""
        assert _statements_deriving_status_from_time(textwrap.dedent(source)) == [], (
            label
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

    def test_a_single_listings_verification_blowing_up_never_fails_the_run(
        self, pg_conn
    ):
        """The PER-LISTING `except`: one listing's `verify_listing` raising is
        absorbed as "no evidence" and the pass carries on. The pass runs after
        real data has already been committed, so it must not be able to turn a
        good ingest into a failed one.

        The OUTER wrapper — the pass itself blowing up before it ever reaches
        a listing — is a different code path, covered by the next test."""
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

    def test_the_whole_verification_pass_blowing_up_never_fails_the_run(
        self, pg_conn, monkeypatch
    ):
        """The OUTER wrapper in `run_connector`, which the per-listing test
        above does not reach (PR #685 review, L4). If `verify_stale_listings`
        raises before any listing is looked at — a bad query, a schema drift,
        a bug in the nomination SQL — the ingest that already committed real
        data must still be reported as the successful run it was.
        """
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_id = None
        try:
            _insert_listing(pg_conn, "outer-boom-1", unseen_days=60)

            def _explode(*args, **kwargs):
                raise RuntimeError("the verification pass itself is broken")

            monkeypatch.setattr(orchestrator, "_nominate_stale_listings", _explode)

            connector = _VerifyingConnector()
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
            assert connector.verify_calls == []
            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM listing WHERE source = %s AND external_id = %s",
                    (_SOURCE, "outer-boom-1"),
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


# --------------------------------------------------------------------------
# The mass-withdrawal guard's own boundaries (PR #685 review: H2, M1, L4)
# --------------------------------------------------------------------------


def _seed_verification_history(
    conn, source: str, *, runs: int, verified_each: int, gone_each: int
) -> list[int]:
    """Synthetic `connector_run_results` history for `source`, so the guard's
    historical-baseline check has a baseline to compare against.

    Returns the run ids, for cleanup.
    """
    run_ids: list[int] = []
    with conn.cursor() as cur:
        for _ in range(runs):
            cur.execute(
                "INSERT INTO connector_runs (trigger, status) "
                "VALUES ('test-history', 'success') RETURNING id"
            )
            run_id = cur.fetchone()[0]
            run_ids.append(run_id)
            cur.execute(
                "INSERT INTO connector_run_results "
                "(run_id, connector_name, status, verified_count, "
                " verified_gone_count) VALUES (%s, %s, 'ok', %s, %s)",
                (run_id, source, verified_each, gone_each),
            )
    conn.commit()
    return run_ids


def _drop_verification_history(conn, run_ids: list[int]) -> None:
    if not run_ids:
        return
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM connector_run_results WHERE run_id = ANY(%s)", (run_ids,)
        )
        cur.execute("DELETE FROM connector_runs WHERE id = ANY(%s)", (run_ids,))
    conn.commit()


def _gone_and_alive(conn, gone: int, alive: int) -> tuple[list[int], dict]:
    """`gone` listings that 404 plus `alive` listings that answer, wired up."""
    ids: list[int] = []
    answers: dict = {}
    for i in range(gone):
        external_id = f"boundary-gone-{i}"
        ids.append(_insert_listing(conn, external_id, unseen_days=90 - i))
        answers[external_id] = ListingUnavailableError("HTTP 404")
    for i in range(alive):
        external_id = f"boundary-alive-{i}"
        _insert_listing(conn, external_id, unseen_days=60 - i)
        answers[external_id] = VerificationOutcome("alive", "HTTP 200")
    return ids, answers


class TestMassWithdrawalGuardBoundaries:
    """The guard is the last thing standing between a broken detail path and a
    source's whole inventory going `withdrawn`, so its edges are tested
    directly rather than inferred from the middle of the range.

    Every case here was a real defect found by PR #685's review, reproduced
    before it was fixed:

    * exactly 80% sailed through, because the comparison was `>` while both
      the docstring and D-157 promised "fewer than 80%" (H2);
    * a 5-*verdict* floor switched the guard off entirely below five verdicts
      — i.e. precisely when the detail path has broken, half the attempts are
      erroring and the breaker has already cut the pass short (M1).
    """

    def test_exactly_the_alarm_ratio_withdraws_nothing(self, pg_conn):
        """8 of 10 is 80%, and 80% is already the systemic signature. The
        boundary belongs on the blocking side: a clean systemic break that
        happens to spare two listings is still a systemic break."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            gone_ids, answers = _gone_and_alive(pg_conn, gone=8, alive=2)

            result = _run_verification(
                pg_conn, _VerifyingConnector(answers=answers), budget=20
            )

            assert (result["verified"], result["gone"]) == (10, 0)
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "active"
        finally:
            _cleanup(pg_conn)

    def test_just_under_the_alarm_ratio_still_withdraws(self, pg_conn):
        """The other side of the same boundary — 7 of 10 is under it, and the
        guard must not creep into swallowing ordinary churn."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            gone_ids, answers = _gone_and_alive(pg_conn, gone=7, alive=3)

            result = _run_verification(
                pg_conn, _VerifyingConnector(answers=answers), budget=20
            )

            assert (result["verified"], result["gone"]) == (10, 7)
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
        finally:
            _cleanup(pg_conn)

    def test_a_tiny_sample_that_is_entirely_gone_withdraws_nothing(self, pg_conn):
        """The M1 scenario, which the old verdict floor let through ungated:
        the detail path breaks, most attempts error, the breaker opens after
        four verdicts — and all four of them are 404s. Four is a small sample,
        which is an argument for MORE caution, not less."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            gone_ids, answers = _gone_and_alive(pg_conn, gone=4, alive=0)

            result = _run_verification(
                pg_conn, _VerifyingConnector(answers=answers), budget=20
            )

            assert (result["verified"], result["gone"]) == (4, 0)
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "active"
        finally:
            _cleanup(pg_conn)

    def test_one_or_two_withdrawals_are_never_a_mass_withdrawal(self, pg_conn):
        """Why the floor exists at all, and why it belongs on the WITHDRAWALS
        rather than on the verdict count: two listings verified, both 404, is
        a 100% gone rate and is also just two listings. A ratio over two
        verdicts is noise, and blocking here would mean a source that only
        ever has a listing or two overdue could never withdraw anything."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            gone_ids, answers = _gone_and_alive(pg_conn, gone=2, alive=0)

            result = _run_verification(
                pg_conn, _VerifyingConnector(answers=answers), budget=20
            )

            assert (result["verified"], result["gone"]) == (2, 2)
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
        finally:
            _cleanup(pg_conn)

    def test_a_source_that_has_never_withdrawn_anything_does_not_start_in_bulk(
        self, pg_conn
    ):
        """The historical-baseline check (M1-ii). 6 of 10 is 60%: comfortably
        under the single-run ratio, and indistinguishable inside one run from
        genuine churn. What IS distinguishable is that this source has 100
        verdicts of history and has never once withdrawn a listing — so 60%
        today is a break, not a market event, and a stateless ratio can never
        see it."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_ids: list[int] = []
        try:
            run_ids = _seed_verification_history(
                pg_conn, _SOURCE, runs=10, verified_each=10, gone_each=0
            )
            gone_ids, answers = _gone_and_alive(pg_conn, gone=6, alive=4)

            result = _run_verification(
                pg_conn, _VerifyingConnector(answers=answers), budget=20
            )

            assert (result["verified"], result["gone"]) == (10, 0)
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "active"
        finally:
            _drop_verification_history(pg_conn, run_ids)
            _cleanup(pg_conn)

    def test_a_source_whose_history_already_shows_churn_is_left_alone(self, pg_conn):
        """The same 6-of-10 run, against a source that has always withdrawn
        about half of what it verifies. The baseline check must recognise its
        own source's normal and stay out of the way — otherwise it would be a
        second, stricter ratio guard rather than a break detector."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_ids: list[int] = []
        try:
            run_ids = _seed_verification_history(
                pg_conn, _SOURCE, runs=10, verified_each=10, gone_each=5
            )
            gone_ids, answers = _gone_and_alive(pg_conn, gone=6, alive=4)

            result = _run_verification(
                pg_conn, _VerifyingConnector(answers=answers), budget=20
            )

            assert (result["verified"], result["gone"]) == (10, 6)
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
        finally:
            _drop_verification_history(pg_conn, run_ids)
            _cleanup(pg_conn)

    def test_too_little_history_leaves_the_baseline_check_out_of_it(self, pg_conn):
        """A source with almost no verification history has no baseline, and
        an absent baseline must not read as "has never withdrawn anything" —
        that would mean the very first pass could never withdraw a batch, and
        the mechanism would never start."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_ids: list[int] = []
        try:
            run_ids = _seed_verification_history(
                pg_conn, _SOURCE, runs=1, verified_each=5, gone_each=0
            )
            gone_ids, answers = _gone_and_alive(pg_conn, gone=6, alive=4)

            result = _run_verification(
                pg_conn, _VerifyingConnector(answers=answers), budget=20
            )

            assert (result["verified"], result["gone"]) == (10, 6)
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
        finally:
            _drop_verification_history(pg_conn, run_ids)
            _cleanup(pg_conn)

    def test_a_fired_guard_is_visible_on_the_run_row(self, pg_conn):
        """A suppressed action has to leave a trace (PR #685 review, L2).

        `verified_count=10, verified_gone_count=0` is byte-identical whether
        ten listings came back alive or ten came back gone and every one of
        them was withheld — and the second is the single most important thing
        an operator could be told about this pass. So the guard writes which
        check tripped to `connector_run_results.verification_alarm`, and a
        quiet run leaves it NULL.
        """
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_id = None
        try:
            _, answers = _gone_and_alive(pg_conn, gone=8, alive=2)
            connector = _VerifyingConnector(answers=answers)
            orchestrator.CONNECTORS[:] = [connector]

            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT verified_count, verified_gone_count, "
                    "       verification_alarm "
                    "  FROM connector_run_results "
                    " WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                verified, gone, alarm = cur.fetchone()

            assert (verified, gone) == (10, 0)
            assert alarm is not None and alarm.startswith("ratio 8/10"), alarm
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

    def test_a_quiet_guard_leaves_the_alarm_null(self, pg_conn):
        """The other half: `WHERE verification_alarm IS NOT NULL` is only a
        usable "show me the suppressed runs" query if an ordinary run really
        does store NULL rather than an empty string or a cheerful 'ok'."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        run_id = None
        try:
            gone_ids, answers = _gone_and_alive(pg_conn, gone=3, alive=7)
            connector = _VerifyingConnector(answers=answers)
            orchestrator.CONNECTORS[:] = [connector]

            run_id = orchestrator.run_all_connectors(pg_conn, trigger="test")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "SELECT verified_count, verified_gone_count, "
                    "       verification_alarm "
                    "  FROM connector_run_results "
                    " WHERE run_id = %s AND connector_name = %s",
                    (run_id, connector.name),
                )
                verified, gone, alarm = cur.fetchone()

            assert (verified, gone) == (10, 3)
            assert alarm is None
            for listing_id in gone_ids:
                assert _listing_row(pg_conn, listing_id)["status"] == "withdrawn"
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


# --------------------------------------------------------------------------
# Crash survival, per-connector budget, and the helper's HTML contract
# --------------------------------------------------------------------------


class TestVerificationAttemptIsCommittedBeforeTheRequest:
    """The one property that actually matters about
    `last_verification_attempt_at`: it is committed BEFORE the request goes
    out, so a process that dies mid-request still rotates that listing to the
    back of the queue. Recorded after the fact, a crash-looping request would
    re-ask about the same head-of-queue listing forever and the backlog behind
    it would never drain.

    Asserted from a SECOND connection, because that is the only thing that can
    tell "committed" from "written in our own open transaction" — the
    distinction the crash-loop property depends on.
    """

    def test_another_connection_sees_the_attempt_while_the_request_is_in_flight(
        self, pg_conn
    ):
        import os

        import psycopg2

        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        observer = psycopg2.connect(os.environ["POSTGRES_DSN"])
        seen: list[object] = []
        try:
            listing_id = _insert_listing(pg_conn, "crash-1", unseen_days=90)
            # Committed up front and asserted below, so the observer's view of
            # the row is never in question — the ONLY thing this test is
            # allowed to be measuring is whether the attempt timestamp itself
            # was committed before the request went out.
            pg_conn.commit()

            class _ObservingConnector(_VerifyingConnector):
                def verify_listing(self, external_id, url, throttle):
                    # Mid-request: what would a process that died right here
                    # have left behind in the database?
                    observer.rollback()  # fresh snapshot, not a stale one
                    with observer.cursor() as cur:
                        cur.execute(
                            "SELECT last_verification_attempt_at FROM listing "
                            " WHERE id = %s",
                            (listing_id,),
                        )
                        row = cur.fetchone()
                    assert row is not None, "the listing row itself is not visible"
                    seen.append(row[0])
                    raise RuntimeError("process dies here")

            _run_verification(pg_conn, _ObservingConnector())

            assert seen and seen[0] is not None, (
                "last_verification_attempt_at was NOT committed before the "
                "request — a crash mid-request would re-ask about this same "
                "listing forever"
            )
            # And the crash itself changed nothing else about the listing.
            assert _listing_row(pg_conn, listing_id)["status"] == "active"
            assert _status_events(pg_conn, listing_id) == []
        finally:
            observer.close()
            _cleanup(pg_conn)


class TestPerConnectorBudgetCeiling:
    """`Connector.stale_verification_budget_per_run` (PR #685 review, M2).

    Milanuncios is the reason it exists: D-017/#179 measured it serving ~5
    successful detail fetches before a 60+ minute soft block, so appending up
    to 10 verification fetches to every hourly run would wall the connector
    for longer than the interval between runs — degrading real ingestion,
    which is a different and worse failure than a false withdrawal.
    """

    def test_a_connector_can_lower_the_global_budget(self, pg_conn):
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            for i in range(8):
                _insert_listing(pg_conn, f"capped-{i}", unseen_days=90 - i)

            class _Capped(_VerifyingConnector):
                stale_verification_budget_per_run = 2

            connector = _Capped()
            _run_verification(pg_conn, connector, budget=10)

            assert len(connector.verify_calls) == 2
        finally:
            _cleanup(pg_conn)

    def test_a_connector_can_never_raise_the_global_budget(self, pg_conn):
        """The global knob is the operator's kill switch: setting
        `etl.stale_verification_budget_per_run` to 0 must stop every
        connector, and no class attribute may override that."""
        _apply_schema(pg_conn)
        _cleanup(pg_conn)
        try:
            for i in range(8):
                _insert_listing(pg_conn, f"uncapped-{i}", unseen_days=90 - i)

            class _Greedy(_VerifyingConnector):
                stale_verification_budget_per_run = 50

            greedy = _Greedy()
            _run_verification(pg_conn, greedy, budget=3)
            assert len(greedy.verify_calls) == 3

            off = _Greedy()
            result = _run_verification(pg_conn, off, budget=0)
            assert off.verify_calls == []
            assert result["nominated"] == 0
        finally:
            _cleanup(pg_conn)

    def test_milanuncios_caps_itself_below_the_global_budget(self):
        """The measured value, pinned. Not a style preference: this connector
        has the tightest detail budget in the repo (D-017/#179)."""
        assert MilanunciosConnector.stale_verification_budget_per_run == 2
        assert MilanunciosRentalConnector.stale_verification_budget_per_run == 1
        # Stated on the subclass rather than inherited, same as its rate limit.
        assert (
            "stale_verification_budget_per_run" in MilanunciosRentalConnector.__dict__
        )


class TestVerifyViaFetchDetailHtmlContract:
    """`verify_via_fetch_detail` reads `raw.raw["html"]` to run the
    retired-page signature. A connector whose `fetch_detail()` returns a
    parsed payload without that key (milanuncios: `{"url", "props"}`) would
    hand the signature an empty string forever — silently never firing.

    `TestRetiredPageSignatures` cannot catch this: it calls
    `retired_page_signature` directly rather than through the helper, so the
    wiring between the two is exactly the untested gap (PR #685 review, M3).
    """

    def test_a_connector_with_a_signature_but_no_html_fails_loudly(self):
        class _SignatureWithoutHtml(_VerifyingConnector):
            def retired_page_signature(self, html, final_url=None):
                return "retirado" if "retirado" in html else None

            def fetch_detail(self, external_id, throttle):
                return RawListing(
                    external_id=external_id,
                    source=_SOURCE,
                    raw={"url": "https://example.test/x", "props": {}},
                )

        with pytest.raises(ConnectorError) as excinfo:
            _SignatureWithoutHtml().verify_via_fetch_detail(
                "x-1", throttle=lambda: None
            )
        assert "no 'html' key" in str(excinfo.value)

    def test_a_connector_with_no_signature_of_its_own_is_unaffected(self):
        """Milanuncios' actual shape: no signature by design (404/410 carries
        the whole signal), so a payload without `html` is fine and must not
        start raising."""

        class _NoSignature(_VerifyingConnector):
            def fetch_detail(self, external_id, throttle):
                return RawListing(
                    external_id=external_id,
                    source=_SOURCE,
                    raw={"url": "https://example.test/x", "props": {}},
                )

            def normalize(self, raw):
                return _canonical(raw.external_id)

        outcome = _NoSignature().verify_via_fetch_detail("x-1", throttle=lambda: None)
        assert outcome.state == "alive"

    def test_milanuncios_still_has_no_signature_of_its_own(self):
        """If this ever fails, milanuncios has grown a signature — and the
        comment above `verify_listing` in that file says what must land in the
        same change: `fetch_detail()` must also return the page HTML."""
        assert (
            MilanunciosConnector.retired_page_signature
            is Connector.retired_page_signature
        )
