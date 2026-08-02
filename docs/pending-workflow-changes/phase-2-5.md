# Pending workflow-file changes — task 2.5 (issue #19)

`.github/workflows/*.yml` still isn't committed to this repo (the push-token scope gap from task 1.1 — see [D-004](../decisions/D-004-no-worker-workflows.md) — hasn't been resolved as of this task). This doc supersedes `phase-1-1.md`'s `dashboard-e2e` section and adds a `dashboard-test` fix, both driven by task 2.5 (#19) shipping this project's first real dashboard e2e spec and its first real-Postgres integration tests.

## `ci.yml` — `dashboard-test` job needs a Postgres service

`dashboard/lib/__tests__/candidates.integration.test.ts` and `dashboard/lib/filtering/__tests__/materialize.integration.test.ts` self-skip (not fail) when no database is reachable — which is exactly what happens in CI today, silently. This job's only real-database protection currently provides zero actual coverage. Add a `postgres` service and point `POSTGRES_DSN` at it, alongside the existing steps:

```yaml
  dashboard-test:
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
    defaults:
      run:
        working-directory: dashboard
    env:
      POSTGRES_DSN: postgresql://inmotool:inmotool@localhost:5432/inmotool
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
          cache-dependency-path: dashboard/package-lock.json
      - run: npm ci
      - name: Apply schema
        working-directory: .
        run: PGPASSWORD=inmotool psql -h localhost -U inmotool -d inmotool -f etl/schema/init.sql
      - name: knowledge.ts drift guard
        run: npm run build:knowledge && git diff --exit-code lib/knowledge.ts
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:coverage
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: dashboard-coverage
          path: dashboard/coverage/
```

(Only additions: the `services.postgres` block, the top-level `env.POSTGRES_DSN`, and the "Apply schema" step before the test steps. Everything else in the job is unchanged from what's already committed.)

## `ci.yml` — `dashboard-e2e` job, replaces the `if: false` from `phase-1-1.md`

Task 2.5 shipped a real spec (`dashboard/e2e/candidates.spec.ts`) that seeds its own data directly via `pg` in `beforeAll`/cleans up in `afterAll` — no separate fixture-loading script exists or is needed (unlike the source project's `dashboard/e2e/fixtures/init-test-db.sh` pattern, which was deleted in task 1.1 along with everything else PowerShop-specific). Re-enable the job pointed at the real spec, drop the seed-script step and the mock-LLM-provider step (no LLM features exist yet — that's Phase 4):

```yaml
  dashboard-e2e:
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
    defaults:
      run:
        working-directory: dashboard
    env:
      POSTGRES_HOST: localhost
      POSTGRES_PORT: "5432"
      POSTGRES_USER: inmotool
      POSTGRES_PASSWORD: inmotool
      POSTGRES_DB: inmotool
      POSTGRES_DSN: postgresql://inmotool:inmotool@localhost:5432/inmotool
      DASHBOARD_PORT: "4000"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: dashboard/package-lock.json
      - run: npm ci
      - name: Apply schema
        working-directory: .
        run: PGPASSWORD=inmotool psql -h localhost -U inmotool -d inmotool -f etl/schema/init.sql
      - name: Install Playwright browsers
        run: npx playwright install chromium --with-deps
      - name: Run Playwright e2e tests
        run: npx playwright test e2e/candidates.spec.ts
```

Removed relative to the pre-task-1.1 shape: the "Load e2e seed data into Postgres" step (`dashboard/e2e/fixtures/init-test-db.sh` no longer exists and isn't needed — the spec self-seeds), the "Run LLM-integration e2e (mock provider)" step and its `DASHBOARD_LLM_PROVIDER`/`E2E_DATABASE_URL` env vars (no LLM pipeline exists in this repo yet). Re-add an LLM-mock e2e step once Phase 4 (#24 onward) gives the dashboard real LLM-backed flows to test that way.

As more e2e specs land (map view #43, property detail page #44, and beyond), add them to the `npx playwright test` argument list explicitly (matching this repo's existing convention of naming files rather than a glob) rather than switching to a directory-wide `npx playwright test` — an explicit list makes it obvious in the diff when a new spec is wired in versus silently picked up.
