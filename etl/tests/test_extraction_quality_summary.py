"""Unit tests for the run-level extraction-quality aggregate + trend (issue #171).

Pure functions — no DB, no orchestrator. The DB wiring (which listings a run
touched, the connector's trailing baseline) is exercised by the real-Postgres
integration test in test_orchestrator.py; here we pin the aggregation maths and,
crucially, the degradation flag: a silently-degraded run must be flagged and a
stable one must not.
"""

from __future__ import annotations

from etl.extraction_quality_summary import (
    DEGRADATION_DROP_THRESHOLD,
    compute_trend,
    summarize_scores,
)


def _score(grade: str, score: float, weights_version: int = 1) -> dict:
    return {
        "grade": grade,
        "score": score,
        "populated_fields": 5,
        "total_fields": 9,
        "weights_version": weights_version,
    }


class TestSummarizeScores:
    def test_empty_list_is_none(self) -> None:
        assert summarize_scores([]) is None

    def test_all_invalid_entries_is_none(self) -> None:
        # A row predating the feature, a partial dict, a bogus grade — none
        # count, so a run of only-unscorable listings summarises to None rather
        # than crashing or fabricating a zero.
        assert (
            summarize_scores(
                [
                    None,  # type: ignore[list-item]
                    {},
                    {"grade": "Z", "score": 0.5},
                    {"grade": "A"},  # no score
                    {"score": 0.9},  # no grade
                ]
            )
            is None
        )

    def test_aggregates_grades_mean_and_low_quality(self) -> None:
        summary = summarize_scores(
            [
                _score("A", 0.90),
                _score("A", 0.86),
                _score("B", 0.70),
                _score("C", 0.50),
                _score("F", 0.20),
            ]
        )
        assert summary is not None
        assert summary["n"] == 5
        assert summary["grade_histogram"] == {"A": 2, "B": 1, "C": 1, "F": 1}
        # low quality = C + F
        assert summary["low_quality_count"] == 2
        # mean = (0.90+0.86+0.70+0.50+0.20)/5 = 0.632
        assert summary["mean_score"] == 0.632
        assert summary["weights_version"] == 1
        # trend is added later by the orchestrator, not by summarize_scores.
        assert "trend" not in summary

    def test_skips_invalid_entries_but_keeps_valid_ones(self) -> None:
        summary = summarize_scores(
            [_score("A", 0.9), {"garbage": True}, _score("F", 0.1)]
        )
        assert summary is not None
        assert summary["n"] == 2
        assert summary["mean_score"] == 0.5

    def test_mixed_weights_versions_reported_as_none(self) -> None:
        # Mid-rollout of a weights bump: half the run was scored under v1, half
        # under v2. weights_version=None signals "don't trend-compare this" so
        # the baseline query returns nothing and no bogus drop is flagged.
        summary = summarize_scores([_score("A", 0.9, 1), _score("A", 0.9, 2)])
        assert summary is not None
        assert summary["weights_version"] is None


class TestComputeTrend:
    def test_too_little_history_never_degraded(self) -> None:
        # One prior run is not enough baseline — a brand-new connector must not
        # flag "degraded" off a single data point.
        trend = compute_trend(0.4, [0.9])
        assert trend["baseline_mean"] is None
        assert trend["baseline_n_runs"] == 1
        assert trend["delta"] is None
        assert trend["degraded"] is False

    def test_no_history_never_degraded(self) -> None:
        trend = compute_trend(0.4, [])
        assert trend["baseline_n_runs"] == 0
        assert trend["degraded"] is False

    def test_stable_run_not_flagged(self) -> None:
        # A run holding steady vs its baseline is not a degradation.
        trend = compute_trend(0.88, [0.90, 0.89, 0.91])
        assert trend["baseline_mean"] == 0.9
        assert trend["delta"] == -0.02
        assert trend["degraded"] is False

    def test_improving_run_not_flagged(self) -> None:
        trend = compute_trend(0.95, [0.80, 0.82])
        assert trend["delta"] > 0
        assert trend["degraded"] is False

    def test_silent_degradation_is_flagged(self) -> None:
        # status='ok', nothing failed — but mean quality fell far below the
        # trailing baseline. This is exactly the #171 failure mode.
        trend = compute_trend(0.60, [0.90, 0.91, 0.89, 0.90])
        assert trend["baseline_mean"] == 0.9
        assert trend["delta"] == -0.3
        assert trend["baseline_n_runs"] == 4
        assert trend["degraded"] is True

    def test_boundary_exactly_at_threshold_is_degraded(self) -> None:
        # A drop of exactly the threshold counts (>= is intentional).
        baseline = 0.90
        current = baseline - DEGRADATION_DROP_THRESHOLD
        trend = compute_trend(current, [baseline, baseline])
        assert trend["degraded"] is True

    def test_just_under_threshold_is_not_degraded(self) -> None:
        baseline = 0.90
        current = baseline - DEGRADATION_DROP_THRESHOLD + 0.001
        trend = compute_trend(current, [baseline, baseline])
        assert trend["degraded"] is False
