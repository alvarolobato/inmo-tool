from __future__ import annotations

import pytest

from etl.connectors.rate_limit import RateLimiter


class FakeClock:
    """A controllable clock for rate-limiter tests — no real time.sleep."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def now_fn(self) -> float:
        return self.now

    def sleep_fn(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_rate_limiter_enforces_interval() -> None:
    """30 calls/minute -> 2s minimum interval; back-to-back acquire() sleeps to catch up."""
    clock = FakeClock()
    limiter = RateLimiter(30, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn)

    limiter.acquire()
    assert clock.sleeps == []  # first call never waits

    limiter.acquire()
    assert clock.sleeps == [2.0]  # no time passed since first call -> full 2s wait

    clock.now += 1.5  # simulate 1.5s of real work between calls
    limiter.acquire()
    assert clock.sleeps == [2.0, 0.5]  # only the remaining 0.5s needed


def test_rate_limiter_does_not_wait_if_interval_already_elapsed() -> None:
    clock = FakeClock()
    limiter = RateLimiter(
        60, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn
    )  # 1s interval

    limiter.acquire()
    clock.now += 5.0  # plenty of time has passed
    limiter.acquire()
    assert clock.sleeps == []


def test_rate_limiter_rejects_non_positive_rate() -> None:
    with pytest.raises(ValueError):
        RateLimiter(0)
