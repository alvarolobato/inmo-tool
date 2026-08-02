"""Per-connector rate limiting.

A fixed-interval limiter: `rate_limit_per_minute` calls are spread evenly,
one call every `60 / rate_limit_per_minute` seconds. Every connector gets
this for free via the orchestrator wrapping fetch_detail/discover calls —
no connector implements its own throttling (issue #11's Technical
approach item 2).

`now_fn`/`sleep_fn` are injectable so tests can verify the interval math
with a fake clock instead of a real (slow, flaky) `time.sleep`.
"""

from __future__ import annotations

import time
from collections.abc import Callable


class RateLimiter:
    def __init__(
        self,
        calls_per_minute: int,
        *,
        now_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        if calls_per_minute <= 0:
            raise ValueError(
                f"calls_per_minute must be positive, got {calls_per_minute}"
            )
        self._min_interval = 60.0 / calls_per_minute
        self._now = now_fn
        self._sleep = sleep_fn
        self._last_call_at: float | None = None

    def acquire(self) -> None:
        """Block (via sleep_fn) until enough time has passed since the last acquire()."""
        now = self._now()
        if self._last_call_at is not None:
            elapsed = now - self._last_call_at
            remaining = self._min_interval - elapsed
            if remaining > 0:
                self._sleep(remaining)
                now = self._now()
        self._last_call_at = now
