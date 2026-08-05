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

Two error CATEGORIES, one window (issue #270, D-047). A **fatal** error is a
genuine failure worth alarming on — a network error, invalid JSON, an HTML
structure that genuinely changed. A **soft-block** error is the site
rate-throttling us (an HTTP 200 with the listing payload withheld, a CAPTCHA
interstitial): expected, transient, and NOT a sign the connector is broken —
it just means we've spent this run's budget on that site. Both still count as
errors for reporting (`error_rate`, `windowed_error_rate`), but the breaker
trips them against SEPARATE thresholds: fatal errors trip at the tight
`error_rate_threshold` (protect against garbage/dead site), soft-blocks only
at the looser `soft_block_error_rate_threshold` (so a transient throttle burst
on the main source doesn't abandon it). `tripped_by` then reports WHICH
category crossed its line, so the orchestrator can record a soft-block stop as
a clean "waited for budget" outcome rather than an error state — see
etl.orchestrator and D-047.
"""

from __future__ import annotations

from collections import deque

# Window-entry sentinels. Ints (not an Enum) keep the hot per-attempt path and
# the sum()-based rate math cheap and obvious.
_SUCCESS = 0
_FATAL = 1
_SOFT = 2


class CircuitBreaker:
    def __init__(
        self,
        error_rate_threshold: float,
        min_attempts: int,
        window: int = 20,
        soft_block_error_rate_threshold: float | None = None,
    ) -> None:
        if not 0.0 < error_rate_threshold <= 1.0:
            raise ValueError(
                f"error_rate_threshold must be in (0, 1], got {error_rate_threshold}"
            )
        if min_attempts < 1:
            raise ValueError(f"min_attempts must be >= 1, got {min_attempts}")
        if window < 1:
            raise ValueError(f"window must be >= 1, got {window}")
        # Default: soft-blocks trip exactly like fatal errors — a conservative
        # no-op for any connector that doesn't opt into a looser tolerance, so
        # trip TIMING is unchanged by this change unless a connector overrides
        # it. A connector whose soft-block is transient (Fotocasa) raises this
        # so a throttle burst doesn't abandon the main source; one whose block
        # is a long hard lockout (Milanuncios) keeps the default and trips
        # promptly — the trip is still recorded as a clean soft-block stop.
        if soft_block_error_rate_threshold is None:
            soft_block_error_rate_threshold = error_rate_threshold
        if not 0.0 < soft_block_error_rate_threshold <= 1.0:
            raise ValueError(
                "soft_block_error_rate_threshold must be in (0, 1], got "
                f"{soft_block_error_rate_threshold}"
            )
        if soft_block_error_rate_threshold < error_rate_threshold:
            # A soft-block tolerance TIGHTER than the fatal one would trip a
            # transient throttle sooner than a genuine failure — backwards, and
            # never what a caller means. Equal (the default) is fine.
            raise ValueError(
                "soft_block_error_rate_threshold must be >= error_rate_threshold "
                f"(got soft={soft_block_error_rate_threshold}, "
                f"fatal={error_rate_threshold})"
            )
        self._threshold = error_rate_threshold
        self._soft_threshold = soft_block_error_rate_threshold
        self._min_attempts = min_attempts
        self._window: deque[int] = deque(maxlen=window)
        self.attempts = 0
        self.errors = 0
        self.soft_block_errors = 0

    def record_success(self) -> None:
        self.attempts += 1
        self._window.append(_SUCCESS)

    def record_error(self, soft_block: bool = False) -> None:
        """Record one failed attempt.

        `soft_block=True` marks it as site-side rate-throttling (a "budget"
        stop) rather than a genuine fatal failure — see the module docstring.
        It still counts toward `errors`/`error_rate` (it WAS a failed fetch,
        which #291 tracks), but trips the breaker only at the looser
        soft-block threshold and is reported by `tripped_by` as 'soft'.
        """
        self.attempts += 1
        self.errors += 1
        if soft_block:
            self.soft_block_errors += 1
            self._window.append(_SOFT)
        else:
            self._window.append(_FATAL)

    @property
    def error_rate(self) -> float:
        """Cumulative error rate across the whole run — reporting/observability only.

        `tripped` does NOT use this; it uses the rolling window below.
        """
        return self.errors / self.attempts if self.attempts else 0.0

    @property
    def windowed_error_rate(self) -> float:
        """Fraction of the recent window that failed, fatal OR soft-block."""
        if not self._window:
            return 0.0
        return sum(1 for e in self._window if e != _SUCCESS) / len(self._window)

    @property
    def windowed_fatal_error_rate(self) -> float:
        """Fraction of the recent window that failed with a FATAL (non-soft-block)
        error — the rate the tight threshold gates on."""
        if not self._window:
            return 0.0
        return sum(1 for e in self._window if e == _FATAL) / len(self._window)

    @property
    def tripped(self) -> bool:
        """True once enough attempts have happened and EITHER the recent fatal
        error rate exceeds `error_rate_threshold`, OR the recent total (fatal +
        soft-block) error rate exceeds the looser `soft_block_error_rate_threshold`.

        Gated on min_attempts so e.g. 1 failure out of 2 early attempts
        (50% error rate) doesn't abort a run that would otherwise recover —
        the breaker needs a meaningful sample before it trusts the rate.
        """
        if self.attempts < self._min_attempts:
            return False
        return (
            self.windowed_fatal_error_rate > self._threshold
            or self.windowed_error_rate > self._soft_threshold
        )

    @property
    def tripped_by(self) -> str | None:
        """Which category crossed its threshold: 'fatal', 'soft', or None if the
        breaker is not tripped.

        'fatal' takes precedence when the fatal rate alone would trip it — a
        genuine-failure trip is the alarming one and must not be masked as a
        clean soft-block stop just because soft-blocks are also present in the
        window. Otherwise a tripped breaker was pushed over by the total
        (soft-block-dominated) rate and is reported 'soft' — a clean
        "waited for budget" stop (D-047).
        """
        if not self.tripped:
            return None
        if self.windowed_fatal_error_rate > self._threshold:
            return "fatal"
        return "soft"
