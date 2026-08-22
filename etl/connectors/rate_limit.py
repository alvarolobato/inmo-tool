"""Per-connector rate limiting.

A fixed-interval limiter: `rate_limit_per_minute` calls are spread evenly,
one call every `60 / rate_limit_per_minute` seconds. Every connector gets
this for free via the orchestrator wrapping fetch_detail/discover calls —
no connector implements its own throttling (issue #11's Technical
approach item 2).

`now_fn`/`sleep_fn` are injectable so tests can verify the interval math
with a fake clock instead of a real (slow, flaky) `time.sleep`.

Issue #700: the limiter also ACCOUNTS FOR the time it spends sleeping
(`slept_seconds`). Rate-limit sleep happens *inside* `fetch_detail` (the
orchestrator passes `throttle=limiter.acquire` rather than acquiring at the
call site — see the long comment there), so a naive stopwatch around
`fetch_detail` measures mostly deliberate idling: at Fotocasa's 3/min that is
~20s of sleep wrapped around a sub-second HTTP request. Reporting that as
"time per listing" would repeat the exact error that made
`extension_capture.processed_at - created_at` useless — a number dominated by
idle, read for months as if it were work. Exposing the slept total lets the
caller subtract it and report the two separately.
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
        # Cumulative seconds this limiter has spent sleeping, over its whole
        # lifetime (one limiter per connector per run). Monotonically
        # non-decreasing; read via `slept_seconds`.
        self._slept_seconds = 0.0

    @property
    def slept_seconds(self) -> float:
        """Total seconds spent sleeping in acquire() so far (issue #700).

        The orchestrator samples this before and after each listing and
        subtracts the delta from the wall time, so `fetch_ms_total` counts
        real work and never the pacing interval."""
        return self._slept_seconds

    def acquire(self) -> None:
        """Block (via sleep_fn) until enough time has passed since the last acquire()."""
        now = self._now()
        if self._last_call_at is not None:
            elapsed = now - self._last_call_at
            remaining = self._min_interval - elapsed
            if remaining > 0:
                self._sleep(remaining)
                now = self._now()
                # Charge the INTENDED sleep, not `now - pre_sleep_now`. With an
                # injected fake clock (every test in this repo) the two differ,
                # and a fake sleep_fn that doesn't advance now_fn would
                # otherwise book 0 and silently break the accounting the
                # orchestrator relies on.
                self._slept_seconds += remaining
        self._last_call_at = now
