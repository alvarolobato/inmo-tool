---
id: D-009
title: Gate full connector sweeps on a minimum interval since the last completed run
date: 2026-08-03
---

# D-009: Gate full connector sweeps on a minimum interval since the last completed run

*Decided: 2026-08-03*

**Context**: `etl/orchestrator.py run_scheduler_loop` runs every registered connector immediately on startup, before the first scheduled sleep — combined with `restart: unless-stopped` in `docker-compose.yml`, every `docker compose up`, crash-restart, or `docker compose restart etl` sent real requests to every enabled connector's live site right away. `RateLimiter`/`CircuitBreaker` instances are constructed fresh per `run_all_connectors` call, so no pacing memory survives a restart either. `docs/skills/connectors.md` previously documented this as an operator-discipline concern ("be deliberate about it") rather than a guarded behaviour. That framing doesn't scale: a crash-loop (bad deploy, an unhandled exception during startup, anything that restarts the container every few seconds to a few minutes) is not a deliberate action anyone takes — it's precisely the scenario operator discipline can't catch, and it would hammer every connector's site on every attempt, including sites already behind edge-level WAFs (issue #1 §15's good-neighbor crawling principle).

**Decision**: `etl.orchestrator.should_skip_immediate_sweep(conn, min_restart_sweep_interval_seconds)` checks the most recently *completed* `connector_runs` row (`status IN ('success','partial','failed')` — a `'running'` row never counts, even one not yet reconciled by `_reconcile_stale_runs`). If one finished more recently than the threshold, the sweep is skipped entirely (logged at WARNING) and the caller waits for the next scheduled interval. `run_all_connectors_respecting_restart_guard` wraps this around `run_all_connectors`; it replaces `run_all_connectors` only in `run_scheduler_loop` and in `etl/main.py`'s `--once` path when no single connector is named. The threshold is `etl.min_restart_sweep_interval_seconds` (config key / `ETL_MIN_RESTART_SWEEP_INTERVAL_SECONDS`), default 900s (15 min); `0` disables the guard.

**Alternatives rejected**:
- **Applying the guard to a named single-connector run (`ps connector run <name>`).** Rejected: that's a deliberate, targeted operator action, not the unattended-restart scenario this guard exists for — gating it would make routine manual testing unpredictably silent.
- **Persisting rate-limiter/circuit-breaker state across restarts instead of (or in addition to) a run-level guard.** Rejected for this pass as materially more invasive (serializing limiter/breaker state, reconstructing it correctly per connector on startup) for a narrower benefit — the run-level guard directly addresses the actual failure mode (a burst of *full sweeps* in a short window), not the finer-grained pacing within a single sweep, which existing per-run limiter construction already handles adequately once sweeps aren't overlapping.
- **A fixed short cooldown baked into `run_scheduler_loop`'s loop body instead of a DB-backed check.** Rejected: an in-memory cooldown resets on every process restart — exactly the case this guard needs to survive across.

**Rationale**: A DB-backed "was the last sweep suspiciously recent" check is the only signal that survives the process restart it needs to detect, costs one indexed query, and degrades gracefully (a fresh install with no completed runs never skips; a genuine multi-hour-down restart still sweeps immediately in the overwhelming majority of cases).

**See**: `etl/orchestrator.py` (`should_skip_immediate_sweep`, `last_completed_run_finished_at`, `run_all_connectors_respecting_restart_guard`), `etl/main.py`, `etl/config.py` (`min_restart_sweep_interval_seconds`), `config/schema.yaml`, `docs/skills/connectors.md#every-container-startrestart-used-to-be-a-live-scrape--now-gated-issue-172`, issue #172.
