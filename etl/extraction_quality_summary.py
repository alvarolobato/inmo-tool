"""Run-level extraction-quality aggregate + degradation trend (issue #171).

Issue #80 / D-084 gave every listing a *per-listing* weighted completeness
grade (``etl.extraction_quality.compute_extraction_quality``), stored verbatim
on ``listing.raw_extra.extraction_quality``. That is the right signal for a
human inspecting one property, but it does not answer the question an operator
watching the ETL monitor actually has: **is a connector's extraction quality
degrading in aggregate, run over run, before it becomes a wall of individually
thin listings someone has to notice one by one?**

A connector can partially break — a site renames one JSON key, one CSS selector
goes stale — and, thanks to ``first_present()``'s deliberate fallback-chain
design (issue #77), keep reporting ``status='ok'`` with zero fetch errors while
more and more listings quietly fall through to a weaker fallback or a ``None``
field. Nothing fails, nothing trips the circuit breaker, nothing is queryable.

This module is the aggregation + trend layer, and it is **pure**: it never
recomputes or redefines a per-listing score (that stays #80's job). It takes the
scores already stored on the listings a run produced, folds them into one
run-level summary, and compares that summary against the connector's recent
history to flag a meaningful drop. The orchestrator (``_record_connector_result``)
does the DB I/O — reading the listings this run touched and the connector's prior
summaries — and stores the returned dict on
``connector_run_results.extraction_quality_summary`` (JSONB). The ETL monitor
reads it back and renders the trend indicator.
"""

from __future__ import annotations

from typing import Any

# Grades at or below this band count as "low quality" for `low_quality_count` —
# a C or F listing is one an operator would want to look at. A/B are healthy.
# (The grade bands themselves are owned by etl.extraction_quality; this only
# decides which of them are worth counting as a degradation signal.)
_LOW_QUALITY_GRADES: frozenset[str] = frozenset({"C", "F"})

# The grade buckets a histogram always carries, in display order, so a summary's
# shape is stable even when a run produced zero listings of some grade.
_GRADE_ORDER: tuple[str, ...] = ("A", "B", "C", "F")

# How many of the connector's most-recent prior summaries form the trailing
# baseline the current run is compared against.
TREND_WINDOW = 5

# The baseline is only trustworthy once the connector has a little history — a
# brand-new connector (or one back from a long outage) must not flag "degraded"
# off a single prior data point.
MIN_BASELINE_RUNS = 2

# A drop of this much (in the 0..1 weighted-completeness fraction) versus the
# trailing baseline is what counts as a *meaningful* degradation — i.e. the
# connector's mean listing quality fell by ≥ 10 percentage points. Deliberately
# a plain threshold, not the circuit breaker's rolling-window machinery: this is
# a "glance at it" signal for v1 (issue #171 explicitly leaves an automated
# alert threshold as later work), not a kill switch.
DEGRADATION_DROP_THRESHOLD = 0.10


def _valid_score(entry: Any) -> bool:
    """Whether one stored ``raw_extra.extraction_quality`` entry is usable.

    Defensive: the column is free-form JSONB written by #80's scorer, but a
    row could predate the feature, carry a partial dict, or have been hand-
    edited. Only entries with a numeric ``score`` and a known ``grade`` count
    toward the aggregate; anything else is skipped rather than crashing the
    run-recording path.
    """
    if not isinstance(entry, dict):
        return False
    if not isinstance(entry.get("score"), (int, float)):
        return False
    return entry.get("grade") in _GRADE_ORDER


def summarize_scores(scores: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Fold a run's per-listing extraction-quality scores into one summary.

    ``scores`` are the ``raw_extra.extraction_quality`` dicts of exactly the
    listings this connector run produced (the orchestrator selects them). Pure
    and deterministic. Returns ``None`` when there is nothing to summarise (no
    listings, or none carrying a valid score) — the orchestrator stores that as
    SQL ``NULL`` so ``WHERE extraction_quality_summary IS NOT NULL`` stays a
    usable filter and a fetch-nothing run doesn't fabricate a quality signal.

    Shape (stored on ``connector_run_results.extraction_quality_summary``):

        {"n": <int>,
         "mean_score": <float 0..1, 3 dp>,
         "grade_histogram": {"A": n, "B": n, "C": n, "F": n},
         "low_quality_count": <int, grades C+F>,
         "weights_version": <int | None>}

    The ``trend`` key is added later by ``compute_trend`` (it needs the
    connector's history, which lives in the DB) — this function is history-free
    on purpose so it is trivially unit-testable in isolation.
    """
    valid = [s for s in scores if _valid_score(s)]
    if not valid:
        return None

    histogram = {grade: 0 for grade in _GRADE_ORDER}
    total = 0.0
    for entry in valid:
        histogram[entry["grade"]] += 1
        total += float(entry["score"])

    n = len(valid)
    low_quality = sum(histogram[g] for g in _LOW_QUALITY_GRADES)

    # weights_version is only meaningful if every listing was scored under the
    # same rubric; a mixed run (mid-rollout of a weights bump) reports None so a
    # downstream trend comparison won't silently average across rubrics.
    versions = {
        entry["weights_version"]
        for entry in valid
        if isinstance(entry.get("weights_version"), int)
    }
    weights_version = next(iter(versions)) if len(versions) == 1 else None

    return {
        "n": n,
        "mean_score": round(total / n, 3),
        "grade_histogram": histogram,
        "low_quality_count": low_quality,
        "weights_version": weights_version,
    }


def compute_trend(
    current_mean: float,
    baseline_means: list[float],
    *,
    drop_threshold: float = DEGRADATION_DROP_THRESHOLD,
    min_baseline_runs: int = MIN_BASELINE_RUNS,
) -> dict[str, Any]:
    """Compare this run's mean quality to the connector's trailing baseline.

    ``baseline_means`` are the ``mean_score`` values of the connector's most
    recent prior summaries (most-recent-first or any order — only their average
    matters), already filtered by the caller to healthy runs scored under the
    same rubric. Pure and deterministic.

    Returns::

        {"baseline_mean": <float 3 dp | None>,
         "baseline_n_runs": <int>,
         "delta": <float 3 dp | None>,      # current - baseline
         "degraded": <bool>}

    ``degraded`` is ``True`` only when there is enough baseline history
    (``>= min_baseline_runs``) AND the current mean fell by at least
    ``drop_threshold`` versus it. Too little history, or a stable/improving run,
    is never flagged — the whole point is to catch a *drop*, not to alarm on a
    connector that simply hasn't run enough times yet.
    """
    usable = [m for m in baseline_means if isinstance(m, (int, float))]
    n_baseline = len(usable)
    if n_baseline < min_baseline_runs:
        return {
            "baseline_mean": None,
            "baseline_n_runs": n_baseline,
            "delta": None,
            "degraded": False,
        }

    baseline_mean = sum(usable) / n_baseline
    # Round the delta before both storing and comparing so the flag is
    # deterministic at the threshold boundary — mean_scores are themselves 3-dp
    # rounded, and a raw float subtraction (0.9 - 0.1 = 0.7999…) would otherwise
    # make an exactly-at-threshold drop flip on floating-point noise.
    delta = round(current_mean - baseline_mean, 3)
    return {
        "baseline_mean": round(baseline_mean, 3),
        "baseline_n_runs": n_baseline,
        "delta": delta,
        "degraded": delta <= -round(drop_threshold, 3),
    }
