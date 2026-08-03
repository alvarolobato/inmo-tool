# Pending workflow-file changes — task 4.2 (issue #25/#145, PR #156 review)

`.github/workflows/*.yml` still isn't committed to this repo (see
[D-004](../decisions/D-004-no-worker-workflows.md)). This doc adds to the
still-unapplied `phase-1-1.md` / `phase-2-5.md` proposals — tracked repo-wide
as **issue #160** ("CI silently skips every DB-backed test").

The Opus review of PR #156 found that the same "CI never actually runs this"
class of bug hits **two** jobs, not just `dashboard-test`:

1. `jobs.test` (pytest, ETL) sets `POSTGRES_DSN: ""` unconditionally — every
   DB-backed pytest test, including this task's own
   `TestAiAssessmentRekeyMigration` (2 tests, now 3 — #156 added a
   `generated_at`-vs-`id` regression test), has been silently skipping and
   reporting green. **This job has no Postgres service at all today and isn't
   covered by any existing pending-workflow-changes doc.**
2. `jobs.dashboard-test` (vitest) has no `postgres` service either, so all 8
   tests in `occupancy.integration.test.ts` (plus every other
   `*.integration.test.ts` file) have been silently skipping too. **This one
   already has a fix proposed in [`phase-2-5.md`](phase-2-5.md) — it just
   hasn't been applied yet.** This doc only adds the `REQUIRE_DB` addendum to
   that existing proposal.

Both source-side changes (the `REQUIRE_DB=1` hard-fail path) are already
committed in this PR — `etl/tests/conftest.py`'s `pg_conn` fixture and
`dashboard/lib/ai-assessment/__tests__/occupancy.integration.test.ts`'s
`dbAvailable` check. They're inert without the workflow change below (nothing
sets `REQUIRE_DB` yet), but once a human applies this file's YAML, a future
regression that drops the `services:` block or clears `POSTGRES_DSN` will trip
CI immediately instead of quietly reverting to skip-and-pass.

## `ci.yml` — `jobs.test` needs a Postgres service (net new, issue #160)

```yaml
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: inmotool
          POSTGRES_PASSWORD: inmotool
          POSTGRES_DB: inmotool
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r etl/requirements-dev.txt
      - name: Apply schema
        run: PGPASSWORD=inmotool psql -h localhost -U inmotool -d inmotool -f etl/schema/init.sql
      - run: pytest etl/tests/ -x --tb=short -q --cov=etl --cov-report=term-missing --cov-report=xml
        env:
          POSTGRES_DSN: postgresql://inmotool:inmotool@localhost:5432/inmotool
          REQUIRE_DB: "1"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: etl-coverage
          path: coverage.xml
```

Changes relative to what's committed on disk today: added the `services.postgres`
block, added the "Apply schema" step, replaced `POSTGRES_DSN: ""` with a real
DSN, added `REQUIRE_DB: "1"`, and dropped the dead `P4D_HOST: ""` var (no 4D
source exists in this repo — `phase-1-1.md` flagged this as dead but it was
never actually removed).

## `ci.yml` — `jobs.dashboard-test`: addendum to `phase-2-5.md`

`phase-2-5.md` already proposes the `services.postgres` block and
`POSTGRES_DSN` for this job (still unapplied as of this task). Once that's
applied, `occupancy.integration.test.ts` needs no further changes — it reads
`POSTGRES_DSN` the same way every other `*.integration.test.ts` file does.
The only addition this task's review asks for: set `REQUIRE_DB: "1"` alongside
the `POSTGRES_DSN` that `phase-2-5.md` already adds to `jobs.dashboard-test.env`:

```yaml
    env:
      POSTGRES_DSN: postgresql://inmotool:inmotool@localhost:5432/inmotool
      REQUIRE_DB: "1"
```

## Verified locally

Both jobs' fixed shape was exercised against a real, disposable Postgres
container (`postgres:15`, unique container/DB name per the isolation rule in
issue #159) with schema applied from `etl/schema/init.sql`:

- `pytest etl/tests/` — 470 passed (469 on `main` + 1 new regression test),
  including `TestAiAssessmentRekeyMigration`'s 3 tests running for real.
- `npx vitest run lib/ai-assessment/__tests__/occupancy.integration.test.ts`
  — 8 passed (previously silently skipped).
- `REQUIRE_DB=1` with no reachable DB: both the pytest fixture and the vitest
  file fail hard with a clear message instead of skipping — confirmed by
  running each without `POSTGRES_DSN` set.
