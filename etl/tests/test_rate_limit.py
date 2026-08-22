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


# ── slept_seconds accounting (issue #700) ────────────────────────────────────
#
# The orchestrator subtracts this from its per-listing stopwatch so that
# `fetch_ms_total` measures work and not the pacing interval. If this ledger
# under-counts, every rate-limited connector's "time per listing" silently
# inflates to roughly its rate-limit interval — which is precisely the
# idle-mistaken-for-work failure that made the pre-existing capture latency
# metric useless. These tests pin the ledger, not the sleeping.


def test_slept_seconds_starts_at_zero_and_ignores_the_first_call() -> None:
    clock = FakeClock()
    limiter = RateLimiter(30, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn)
    assert limiter.slept_seconds == 0.0

    limiter.acquire()  # first acquire never waits
    assert limiter.slept_seconds == 0.0


def test_slept_seconds_accumulates_exactly_what_was_slept() -> None:
    clock = FakeClock()
    limiter = RateLimiter(30, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn)

    limiter.acquire()
    limiter.acquire()  # sleeps the full 2.0s
    assert limiter.slept_seconds == pytest.approx(2.0)

    clock.now += 1.5
    limiter.acquire()  # sleeps only the remaining 0.5s
    assert limiter.slept_seconds == pytest.approx(2.5)

    # It must equal the sum of what sleep_fn was actually asked to sleep —
    # the orchestrator's subtraction is only correct if these never diverge.
    assert limiter.slept_seconds == pytest.approx(sum(clock.sleeps))


def test_slept_seconds_does_not_grow_when_no_sleep_was_needed() -> None:
    """A connector slower than its own rate limit never waits, so 100% of its
    wall time is real work and the subtraction must remove nothing."""
    clock = FakeClock()
    limiter = RateLimiter(30, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn)

    limiter.acquire()
    clock.now += 10.0  # a slow fetch, far longer than the 2s interval
    limiter.acquire()

    assert clock.sleeps == []
    assert limiter.slept_seconds == 0.0


def test_slept_seconds_is_charged_even_when_sleep_fn_does_not_advance_the_clock() -> (
    None
):
    """Guards the specific bug the implementation comment calls out: charging
    `now_after - now_before` instead of the intended interval books 0 under a
    fake sleep that doesn't move the clock — every test here, and any injected
    no-op sleep in production, would then silently zero the ledger."""
    now = [0.0]
    limiter = RateLimiter(
        30,
        now_fn=lambda: now[0],
        sleep_fn=lambda _s: None,  # deliberately does NOT advance the clock
    )

    limiter.acquire()
    limiter.acquire()

    assert limiter.slept_seconds == pytest.approx(2.0)
