# Testing Strategy

One-page reference for contributors and agents. Read this before changing any area listed in **Must cover**.

---

## Test Tiers

### Tier A — Pure unit (mocked DB / 4D)
Fast, no external dependencies. All ETL sync logic, all Dashboard lib functions, API route handlers with mocked `query` / `validateReadOnly`.

- **When to run**: every commit, in CI
- **Requirements**: no live DB, no network

### Tier B — Contract tests (SQL shape)
Validate that SQL in SQL pairs and fixtures conforms to expected schema shapes. No live DB required.

- **When to run**: every PR, in CI
- **Requirements**: no live DB

### Tier C — Integration (optional, local only)
Dashboard API routes against a real local Postgres. Documents real behaviour that Tier A/B cannot catch.

- **When to run**: locally before merging risky changes
- **Requirements**: `POSTGRES_DSN` set, local stack running (`ps stack up`)
- **Never run in CI** — requires secrets

---

## Commands

### ETL (Python / pytest)

```bash
# Run all ETL tests (fast, Tier A + B)
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
# Runs the full test suite — integration tests activate when POSTGRES_DSN is set; unit tests still pass with mocks
cd dashboard && POSTGRES_DSN=postgresql://... npm test
```

---

## Coverage Thresholds

Thresholds are enforced locally by vitest (`npm run test:coverage` fails if below floor). In CI they will be **non-blocking** (`continue-on-error: true`) once the workflow patch is applied (pending permissions approval). The goal is to establish a ratchet: raise thresholds as coverage improves, never lower them.

### Dashboard (Vitest / v8)

Configured in `dashboard/vitest.config.ts` under `coverage.thresholds`.

| Metric | Baseline (2026-04-18) | Floor (−5%) |
|--------|----------------------|-------------|
| Statements | 78% | **73%** |
| Branches | 67% | **62%** |
| Functions | 79% | **74%** |
| Lines | 80% | **75%** |

### ETL (pytest-cov)

**Planned**: will be configured via `--cov-fail-under=43` in CI once the workflow patch is applied (see PR body for the pending diff).

| Metric | Baseline (2026-04-18) | Floor (−5%) |
|--------|----------------------|-------------|
| Total lines | 48% | **43%** |

> **Note**: ETL baseline is low because integration tests skip when `P4D_HOST` and `POSTGRES_DSN` are not set. The 43% floor reflects unit-only coverage. Raise after adding Tier A tests for low-coverage modules (`compras`, `maestros`, `mayorista`).

### Policy for raising thresholds

1. After 2–3 CI cycles where measured coverage consistently exceeds the floor, raise the floor by 5%.
2. Update both the config file and the table above in the same PR.
3. Never lower a threshold; if tests delete coverage, add replacements first.

---

## Must Cover Before Risky Change

If you are changing any of the following, write or update tests **first** (TDD):

| File | Why it matters |
|------|---------------|
| `etl/main.py` | Pipeline orchestration, sync dispatch, error handling — a bug here breaks all nightly loads |
| `etl/sync/ventas.py` | Delta upsert for both `ps_ventas` (911K rows) and `ps_lineas_ventas` (1.7M rows, via `sync_lineas_ventas()`) — wrong watermark = data loss or duplicates |
| `dashboard/lib/date-params.ts` | Date substitution for every widget SQL — already covered, keep it that way |
| `dashboard/lib/db.ts` | `validateReadOnly` blocks writes; `query` is the single DB gateway — both must stay tested |
| `dashboard/app/api/anomaly-check/route.ts` | Anomaly detection — already covered, do not regress |
| `dashboard/app/api/etl/runs/route.ts` | ETL monitoring handler — surfaced in the dashboard; failure silences alerts |
| `dashboard/app/api/etl/stats/route.ts` | ETL stats handler — same as above |

**Rule of thumb**: if a bug here would break a nightly load or silently corrupt the dashboard, it belongs on this list.

---

## See also

- [skills/testing-patterns.md](skills/testing-patterns.md) — TDD workflow, factory patterns, mocking strategies (Python + TypeScript)
