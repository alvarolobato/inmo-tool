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
