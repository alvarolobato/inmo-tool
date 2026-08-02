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
