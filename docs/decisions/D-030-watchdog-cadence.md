---
id: D-030
title: Watchdog cron planned bump to `*/30` + event triggers (YAML pending human commit) to compensate for GitHub schedule queue saturation
date: 2026-05-11
---

# D-030: Watchdog cron planned bump to `*/30` + event triggers (YAML pending human commit) to compensate for GitHub schedule queue saturation

*Decided: 2026-05-11*

**Context**: Issue #598. `ai-watchdog.yml` is configured `*/15 * * * *` but actual run history showed it firing every **3–4 hours** — roughly 1/8 of the intended cadence. Concrete impact: PR #597 had all CI green and both review rounds complete at 12:51 UTC; the watchdog's "Clear `ai-ci-failing` when CI is green" rule could not fire because the next watchdog tick was > 30 min away. The Factory Manager removed the label manually at 13:08 UTC; without intervention the PR would have sat with a misleading red label until ~14:43 UTC at earliest.
**Root cause**: GitHub silently drops scheduled runs when a repo's schedule queue is saturated. This repo has 9+ active cron workflows competing for dispatch slots (watchdog `*/15`, mergeability check `*/30`, factory manager `*/4h`, bug hunter daily, feature ideas weekly, project summary daily, ETL health daily, dashboard audit weekly, SQL validator weekly, business review Monday). GitHub's threshold for queue saturation is undocumented, but the symptom is consistent with the documented behavior: requested cadence vs. observed cadence diverge when the queue cannot keep up, with no visible error or warning.
**Decision**:
- **Bump cron from `*/15` to `*/30`** — `ai-pr-mergeability.yml` already uses `*/30` and gets it honored (set deliberately after a similar observation). Halving the requested frequency reduces schedule queue pressure and brings observed cadence closer to configured cadence.
- **Add `pull_request_review: [submitted]` and `pull_request: [closed]` event triggers** — the most time-sensitive watchdog path is the `ai-phase-opus` transition: `pull_request_review: [submitted]` makes this fire within seconds of Opus submitting a review rather than waiting up to 30 min for the next cron tick. `pull_request: [closed]` allows label cleanup to run immediately on PR close. The `ai-ci-failing` clearance rule benefits primarily from the shorter cron cadence (≤ 30 min) rather than from these specific event triggers — CI becoming green is a `check_run`/`check_suite` event, not a PR review or PR close event. The watchdog is already idempotent (`|| true` on every step, no side effects on no-match), so extra event-triggered runs are cheap (< 2 min each, no LLM).
- **YAML change requires a human commit** (D-029 constraint). The proposed diff was posted in PR #600's body for the owner to apply.

**Status**: Landed. `.github/workflows/ai-watchdog.yml` is on `*/30` and carries both `pull_request_review: [submitted]` and `pull_request: [closed]` event triggers.
**Alternatives rejected**:
- **Keep `*/15`**: will continue to be dropped by the saturated queue; observed cadence remains 3–4 h.
- **Split into hot/cold workflows** (hot: 3–4 time-sensitive rules on `*/15`; cold: everything else on `*/60`): the AI worker cannot create new workflow files (D-029), so a new file would require an additional human commit beyond the one YAML diff this PR already asks for. Two workflow files also adds maintenance overhead for what is fundamentally a one-step frequency change.
- **Fan-out from a separate event-driven workflow that calls the watchdog**: same D-029 constraint; would also add concurrency complexity.
**Files**: `.github/workflows/ai-watchdog.yml` (YAML landed: `*/30` cron + event triggers), `docs/ai-factory.md` (cadence references updated).
**See**: issue #598, issue #599, PR #600, `docs/ai-factory.md` "Watchdog vs Manager" section, D-029.
