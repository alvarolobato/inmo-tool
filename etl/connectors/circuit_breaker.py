"""Circuit breaker: stop a connector run early if it's failing too often.

Protects against silently ingesting garbage after a site changes its HTML
structure (every fetch/parse starts raising) and against hammering a site
that's rejecting requests (every fetch starts 4xx/5xx-ing) — issue #11's
Technical approach item 3. The breaker tracks a rolling window of the most
recent attempts for a single connector run; it is not shared across runs or
across connectors.

Rolling, not cumulative: a connector that fetches 1000 listings cleanly and
then hits a site that started rejecting every request must trip quickly, not
after accumulating hundreds more failures to drag down an all-time average.
"""

from __future__ import annotations

from collections import deque


class CircuitBreaker:
    def __init__(
        self, error_rate_threshold: float, min_attempts: int, window: int = 20
    ) -> None:
        if not 0.0 < error_rate_threshold <= 1.0:
            raise ValueError(
                f"error_rate_threshold must be in (0, 1], got {error_rate_threshold}"
            )
        if min_attempts < 1:
            raise ValueError(f"min_attempts must be >= 1, got {min_attempts}")
        if window < 1:
            raise ValueError(f"window must be >= 1, got {window}")
        self._threshold = error_rate_threshold
        self._min_attempts = min_attempts
        self._window: deque[bool] = deque(maxlen=window)
        self.attempts = 0
        self.errors = 0

    def record_success(self) -> None:
        self.attempts += 1
        self._window.append(False)

    def record_error(self) -> None:
        self.attempts += 1
        self.errors += 1
        self._window.append(True)

    @property
    def error_rate(self) -> float:
        """Cumulative error rate across the whole run — reporting/observability only.

        `tripped` does NOT use this; it uses the rolling window below.
        """
        return self.errors / self.attempts if self.attempts else 0.0

    @property
    def windowed_error_rate(self) -> float:
        if not self._window:
            return 0.0
        return sum(self._window) / len(self._window)

    @property
    def tripped(self) -> bool:
        """True once enough attempts have happened and the *recent* error rate
        (over the last `window` attempts) exceeds threshold.

        Gated on min_attempts so e.g. 1 failure out of 2 early attempts
        (50% error rate) doesn't abort a run that would otherwise recover —
        the breaker needs a meaningful sample before it trusts the rate.
        """
        return (
            self.attempts >= self._min_attempts
            and self.windowed_error_rate > self._threshold
        )
