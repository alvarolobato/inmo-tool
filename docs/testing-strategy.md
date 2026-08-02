# Testing Strategy

One-page reference for contributors and agents. Read this before changing any area listed in **Must cover**.

---

## Test Tiers

### Tier A — Pure unit (mocked DB / external sources)
Fast, no external dependencies. All connector/dedup/scoring logic, all Dashboard lib functions, API route handlers with mocked `query` / `validateReadOnly`.

- **When to run**: every commit, in CI
- **Requirements**: no live DB, no network

### Tier B — Contract tests (schema/SQL shape)
Validate that SQL and fixtures conform to expected schema shapes. No live DB required.

- **When to run**: every PR, in CI
- **Requirements**: no live DB

### Tier C — Integration (optional, local only)
Dashboard/connector code against a real local Postgres. Documents real behaviour that Tier A/B cannot catch.

- **When to run**: locally before merging risky changes
- **Requirements**: `POSTGRES_DSN` set, local stack running (`ps stack up`)
- **Never run in CI** — requires secrets/live network for connectors

---

## Commands

### ETL / connectors (Python / pytest)

```bash
# Run all tests (fast, Tier A + B)
docker compose run --rm etl python -m pytest etl/tests/ -x -q

# With coverage report
docker compose run --rm etl python -m pytest etl/tests/ --cov=etl --cov-report=term-missing
```

### Dashboard (TypeScript / Vitest)

```bash
# Run all dashboard tests
cd dashboard && npm test

# With coverage report (also checks thresholds)
cd dashboard && npm run test:coverage
```

### Local integration (Tier C)

```bash
# Requires local stack running and POSTGRES_DSN set
cd dashboard && POSTGRES_DSN=postgresql://... npm test
```

---

## Coverage thresholds — reset, not yet re-established

This repo was bootstrapped from powershop-analytics, whose coverage baselines/floors were tied to modules deleted in task 1.1 (issue #9) — carrying those numbers forward would be meaningless. `dashboard/vitest.config.ts`'s `coverage.thresholds` and any ETL `--cov-fail-under` value should be re-baselined once there's real connector/schema code to measure (Phase 1 tasks 1.2–1.6), not before. Policy once re-established: after 2–3 CI cycles consistently exceeding the floor, raise it 5%; never lower a threshold without adding replacement coverage first.

---

## Must Cover Before Risky Change

Reset for the same reason as the coverage thresholds above — the old list named files that no longer exist. Re-populate this table as Phase 1+ tasks land real code; the rule of thumb stays the same:

**Rule of thumb**: if a bug here would break a scheduled connector run, corrupt the dedup/scoring pipeline, or silently break the dashboard, it belongs on this list. Candidates to add as they're built: the connector orchestrator (task 1.3, #11), the dedup engine (task 2.2, #16 — a bad merge or a bad auto-merge threshold has real data-quality consequences), and `profile_listing_state` read/write paths (keyed on `property_id`, not `listing_id` — see issue #1's "Review addressed" notes for why this matters).

---

## See also

- [skills/testing-patterns.md](skills/testing-patterns.md) — TDD workflow, factory patterns, mocking strategies (Python + TypeScript)
