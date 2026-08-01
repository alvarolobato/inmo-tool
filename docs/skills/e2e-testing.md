# Skill: Writing e2e tests (Playwright)

**Use when**: Adding or changing browser-level end-to-end tests for the Dashboard
App — the tests that drive a real Next.js server + real Postgres and assert what
the user actually sees. For unit/integration tests (vitest/pytest) use
[testing-patterns.md](testing-patterns.md) instead.

## Why e2e exists here

Unit tests mock the database, so they cannot catch "renders an error against real
data" bugs. The review-semanal dashboards shipped `there is no parameter $1` to
production precisely because every unit was green in isolation (issue #800). e2e
closes that gap: it loads real data into Postgres, boots the app, and asserts the
home and dashboards render **without an error surface**.

**[D-041](../decisions/D-041-e2e-required-for-features.md) is the binding rule**: every PR
that adds or modifies a user-facing dashboard surface must ship a Playwright e2e test
asserting no error surface. PRs without one are not mergeable for those areas.

Reach for e2e when the risk is in the *integration* — rendering a saved/seeded
spec, a multi-widget page, a navigation/handoff flow — not for pure logic (that's
a vitest unit).

## The setup in this repo

- **Runner**: Playwright. Config: `dashboard/playwright.config.ts`
  (`testDir: ./e2e`, `webServer: npm run dev`, `baseURL` from `DASHBOARD_PORT` (default 4000)).
- **Specs**: `dashboard/e2e/*.spec.ts`.
- **CI**: the `dashboard-e2e` job (`.github/workflows/ci.yml`) starts a
  `postgres:15` service, applies the schema on dashboard startup (`init.sql`),
  sets `DASHBOARD_LLM_PROVIDER=e2e-stub`, and runs `npx playwright test`.
- **No real LLM / no network**: `DASHBOARD_LLM_PROVIDER=e2e-stub` returns
  deterministic canned responses, so e2e never calls OpenRouter or the CLI. Any
  flow that hits the LLM must work under the stub.

## Deterministic test data — the seeded-Postgres pattern

e2e needs rows in the `ps_*` mirror tables or every widget is empty. Use the
committed fixture (do **not** invent ad-hoc data, and never copy production rows
— this is a public repo):

- **Fixture**: [`dashboard/e2e/fixtures/`](../../dashboard/e2e/fixtures/) —
  `seed.sql` (synthetic, production-faithful, deterministic) + `init-test-db.sh`
  (schema + seed) + `generate_seed.py` (regenerator). See its `README.md`.
- **Dates are `CURRENT_DATE`-relative**, so `last_7_days` and "today" always
  match — no clock mocking, no staleness.

Setup order for a data-backed e2e:
1. Ensure schema + seed are loaded: `dashboard/e2e/fixtures/init-test-db.sh "$E2E_DATABASE_URL"`
   (in CI the dashboard auto-applies `init.sql`, so loading `seed.sql` is enough).
2. Seed the dashboards under test by reusing the app's seeders
   (`getOrCreateReviewDashboardId`, the Cuadro-de-Mandos seeder) — never paste spec JSON.
3. Drive the page and assert.

## What to assert

- **No error surface.** The dashboard renders failures through `ErrorDisplay`
  (widget errors) and the home's error block. Assert these are absent:
  `await expect(page.getByText("Detalles técnicos")).toHaveCount(0)` and no
  `there is no parameter`, no `HTTP 500`, no `Error al cargar`.
- **Real content present.** Prefer stable `data-testid`s (e.g. `hero-today`,
  `period-grid`, `metric-cell-*`) over brittle text. Assert the widget rendered a
  value, not a skeleton/empty state.
- **Determinism over exact numbers.** Assert shape ("≥1 store row", "a numeric
  total") rather than a specific euro figure — the synthetic data may evolve.

## Adding a new spec

1. Add `dashboard/e2e/<feature>.spec.ts` (Playwright `test()` blocks).
2. Keep each spec independent: seed what it needs in `test.beforeAll`, assert,
   and don't depend on another spec's state.
3. **Wire it into CI.** The job currently runs a named subset
   (`npx playwright test conversation-engine`). A new spec only runs once added
   to that invocation — but the worker **must not edit `.github/workflows/`**
   ([D-029](../decisions/D-029-no-worker-workflows.md)): propose the YAML change
   in the PR body for a human to commit. Until then, note in the PR that the spec
   passes locally and is pending the CI wiring.

## Gotchas

- **`webServer` boots `npm run dev`** against `$E2E_DATABASE_URL` — make sure the
  DSN points at the throwaway test DB, never prod (`init-test-db.sh` refuses
  prod-looking DSNs).
- **Seed is idempotent** (`TRUNCATE` first) — safe to load before every run.
- **Timeouts**: the suite timeout is 60s; data-backed pages that run many widget
  queries can be slow on a cold dev server — prefer `expect.poll`/auto-retrying
  assertions over fixed `waitForTimeout`.
