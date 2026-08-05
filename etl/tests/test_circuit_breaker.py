from __future__ import annotations

import pytest

from etl.connectors.circuit_breaker import CircuitBreaker


def test_not_tripped_below_min_attempts_even_at_100pct_errors() -> None:
    breaker = CircuitBreaker(error_rate_threshold=0.3, min_attempts=10)
    for _ in range(5):
        breaker.record_error()
    assert breaker.attempts == 5
    assert breaker.error_rate == 1.0
    assert breaker.tripped is False


def test_trips_once_min_attempts_reached_and_rate_exceeded() -> None:
    breaker = CircuitBreaker(error_rate_threshold=0.3, min_attempts=10)
    for _ in range(7):
        breaker.record_success()
    for _ in range(4):
        breaker.record_error()
    assert breaker.attempts == 11
    assert breaker.tripped is True


def test_stays_closed_when_error_rate_at_or_below_threshold() -> None:
    breaker = CircuitBreaker(error_rate_threshold=0.3, min_attempts=10)
    for _ in range(7):
        breaker.record_success()
    for _ in range(3):
        breaker.record_error()  # exactly 30% — threshold is exclusive (> not >=)
    assert breaker.attempts == 10
    assert breaker.tripped is False


@pytest.mark.parametrize("bad_rate", [0.0, -0.1, 1.1])
def test_rejects_invalid_threshold(bad_rate: float) -> None:
    with pytest.raises(ValueError):
        CircuitBreaker(error_rate_threshold=bad_rate, min_attempts=10)


def test_rejects_invalid_min_attempts() -> None:
    with pytest.raises(ValueError):
        CircuitBreaker(error_rate_threshold=0.3, min_attempts=0)


def test_rejects_invalid_window() -> None:
    with pytest.raises(ValueError):
        CircuitBreaker(error_rate_threshold=0.3, min_attempts=10, window=0)


def test_rolling_window_trips_quickly_after_long_clean_run() -> None:
    """A site that goes bad after a long clean streak must trip on the
    *recent* failure rate, not get diluted by an all-time cumulative average.

    1000 clean requests, then the site starts failing every request. A
    cumulative error_rate would need ~430 more failures to cross 30% — this
    proves the breaker trips almost immediately instead, using only the
    last `window` attempts.
    """
    breaker = CircuitBreaker(error_rate_threshold=0.3, min_attempts=10, window=20)
    for _ in range(1000):
        breaker.record_success()
    assert breaker.tripped is False

    for _ in range(7):
        breaker.record_error()

    # Cumulative rate alone would not trip — proves this isn't accidentally
    # still passing because of the old cumulative behavior.
    assert breaker.error_rate == pytest.approx(7 / 1007)
    assert breaker.error_rate < 0.3
    # But the windowed rate (13 trailing successes + 7 errors = 7/20 = 0.35)
    # crosses the threshold, so it trips.
    assert breaker.windowed_error_rate == pytest.approx(7 / 20)
    assert breaker.tripped is True


# Issue #270 (D-047): soft-block (rate-throttle) errors trip against a
# separate, looser threshold than genuine fatal errors, and `tripped_by`
# reports which category crossed its line so the orchestrator can record a
# soft-block stop as a clean 'waited for budget' outcome rather than an error.


def test_soft_block_burst_does_not_trip_at_the_looser_threshold() -> None:
    """A burst of soft-blocks that WOULD trip the fatal threshold (35% > 30%)
    must NOT trip when the connector tolerates soft-blocks up to 75%.

    Revert-and-confirm-fail: if `record_error(soft_block=True)` were treated
    identically to a fatal error (the pre-#270 behaviour), this window (13
    successes + 7 soft-blocks = 0.35) WOULD trip at the 0.30 fatal threshold and
    the assertion below would fail. This is the exact Fotocasa case from issue
    #270 (errors=7 tripping the breaker mid-sweep and abandoning the
    connector's other scopes).
    """
    breaker = CircuitBreaker(
        error_rate_threshold=0.3,
        min_attempts=10,
        window=20,
        soft_block_error_rate_threshold=0.75,
    )
    for _ in range(13):
        breaker.record_success()
    for _ in range(7):
        breaker.record_error(soft_block=True)
    assert breaker.windowed_error_rate == pytest.approx(7 / 20)
    assert breaker.windowed_fatal_error_rate == 0.0
    assert breaker.tripped is False
    assert breaker.tripped_by is None


def test_soft_block_still_trips_once_it_dominates_the_window() -> None:
    """A site that has gone FULLY into block mode still stops the run — the
    looser threshold tolerates a burst, not a permanent block."""
    breaker = CircuitBreaker(
        error_rate_threshold=0.3,
        min_attempts=10,
        window=20,
        soft_block_error_rate_threshold=0.75,
    )
    for _ in range(4):
        breaker.record_success()
    for _ in range(16):  # 16/20 = 0.80 > 0.75
        breaker.record_error(soft_block=True)
    assert breaker.tripped is True
    assert breaker.tripped_by == "soft"


def test_fatal_errors_trip_at_the_tight_threshold_even_with_loose_soft() -> None:
    """Raising the soft-block tolerance must NOT weaken protection against
    genuine failures: a 35% FATAL rate still trips at 30%."""
    breaker = CircuitBreaker(
        error_rate_threshold=0.3,
        min_attempts=10,
        window=20,
        soft_block_error_rate_threshold=0.75,
    )
    for _ in range(13):
        breaker.record_success()
    for _ in range(7):
        breaker.record_error()  # fatal
    assert breaker.windowed_fatal_error_rate == pytest.approx(7 / 20)
    assert breaker.tripped is True
    assert breaker.tripped_by == "fatal"


def test_fatal_takes_precedence_over_soft_in_tripped_by() -> None:
    """When the fatal rate alone crosses its threshold, the trip is reported
    'fatal' even if soft-blocks are also present — a genuine failure must never
    be masked as a clean budget stop."""
    breaker = CircuitBreaker(
        error_rate_threshold=0.3,
        min_attempts=10,
        window=20,
        soft_block_error_rate_threshold=0.5,
    )
    for _ in range(3):
        breaker.record_success()
    for _ in range(7):
        breaker.record_error()  # fatal: 7/20 = 0.35 > 0.30
    for _ in range(10):
        breaker.record_error(soft_block=True)  # combined climbs too
    assert breaker.windowed_fatal_error_rate > 0.3
    assert breaker.tripped_by == "fatal"


def test_default_soft_threshold_equals_fatal_no_behaviour_change() -> None:
    """A connector that does NOT opt into a looser tolerance
    (soft_block_error_rate_threshold=None) trips soft-blocks exactly like fatal
    errors — the conservative default for Milanuncios' hard lockout, and
    byte-identical trip timing to the pre-#270 breaker."""
    breaker = CircuitBreaker(error_rate_threshold=0.3, min_attempts=10, window=20)
    for _ in range(13):
        breaker.record_success()
    for _ in range(7):
        breaker.record_error(soft_block=True)  # 7/20 = 0.35 > 0.30
    assert breaker.tripped is True
    # Reported 'soft' so the caller still records it as a clean budget stop,
    # even though it tripped at the tight threshold.
    assert breaker.tripped_by == "soft"


def test_soft_block_errors_still_count_toward_error_rate() -> None:
    """Soft-blocks are still FAILED fetches (counted for #291) even though they
    don't trip like fatal errors — error_count must include them."""
    breaker = CircuitBreaker(
        error_rate_threshold=0.3,
        min_attempts=10,
        soft_block_error_rate_threshold=0.9,
    )
    for _ in range(5):
        breaker.record_success()
    for _ in range(5):
        breaker.record_error(soft_block=True)
    assert breaker.errors == 5
    assert breaker.soft_block_errors == 5
    assert breaker.error_rate == pytest.approx(0.5)


@pytest.mark.parametrize("bad", [0.0, -0.1, 1.1])
def test_rejects_out_of_range_soft_threshold(bad: float) -> None:
    with pytest.raises(ValueError):
        CircuitBreaker(
            error_rate_threshold=0.3,
            min_attempts=10,
            soft_block_error_rate_threshold=bad,
        )


def test_rejects_soft_threshold_tighter_than_fatal() -> None:
    """A soft tolerance below the fatal threshold would trip a transient
    throttle sooner than a genuine failure — backwards, and rejected."""
    with pytest.raises(ValueError):
        CircuitBreaker(
            error_rate_threshold=0.5,
            min_attempts=10,
            soft_block_error_rate_threshold=0.3,
        )


def test_windowed_rate_recovers_as_failures_age_out_of_the_window() -> None:
    """A breaker that hasn't tripped yet should reflect recovery too, not
    just decay — old failures should stop counting once they scroll out of
    the window, the same way old successes do."""
    breaker = CircuitBreaker(error_rate_threshold=0.3, min_attempts=5, window=5)
    for _ in range(3):
        breaker.record_error()
    for _ in range(2):
        breaker.record_success()
    assert breaker.windowed_error_rate == pytest.approx(3 / 5)
    assert breaker.tripped is True  # would already be open in real use

    # Simulate attempts continuing anyway (e.g. checked before this one) —
    # once 5 more successes have scrolled the 3 old errors out of the
    # window, the rate should reflect only the last 5 attempts.
    for _ in range(5):
        breaker.record_success()
    assert breaker.windowed_error_rate == 0.0
    assert breaker.tripped is False
