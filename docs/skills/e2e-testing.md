# Skill: Writing e2e tests (Playwright)

**Use when**: Adding or changing browser-level end-to-end tests for the Dashboard
App — the tests that drive a real Next.js server + real Postgres and assert what
the user actually sees. For unit/integration tests (vitest/pytest) use
[testing-patterns.md](testing-patterns.md) instead.

## Status: re-established at task 2.5 (#19)

This skill (and the Playwright setup it describes) was inherited from the source
project this repo was bootstrapped from (powershop-analytics). Its original specs and
seeded-Postgres fixture tested that project's BI-dashboard business flows against
its `ps_*` mirror schema — none of that applied to inmo-tool, so `dashboard/e2e/`
was removed in task 1.1 rather than kept in a broken state.

Task 2.5 (the candidate list UI, the first real user-facing surface built on the
new schema) re-established it: `dashboard/e2e/candidates.spec.ts` drives a real
Next.js server against a real Postgres, seeding synthetic data directly via `pg`
in a `beforeAll`/`afterAll` (no separate fixture-loading script — the seed is
small enough to inline, unlike the source project's SQL-file fixture) and
cleaning up afterward regardless of pass/fail. It asserts the same two things the
source project's pattern asserted: no error surface (`ErrorDisplay`, generic
500/parameter-error text absent) and real content present (candidate cards, a
multi-listing property rendered as one card with both source badges, pagination
advancing to a genuine next page and stopping once exhausted) — not a
skeleton/empty state. The source project's own experience (issue #800 in that
repo: a dashboard shipped `there is no parameter $1` to production because unit
tests mocked Postgres and never ran the real SQL) is exactly the failure mode
this catches, and this project has already independently reproduced that failure
mode three times in tasks 2.3/2.4 with mocked-only tests — see
`docs/decisions/archive/D-041-e2e-required-for-features.md` for the original
binding-rule writeup this re-establishes in practice.

## Setup

- **Runner**: Playwright. Config: `dashboard/playwright.config.ts`
  (`testDir: ./e2e`, `webServer: npm run dev`, `baseURL` from `DASHBOARD_PORT` (default 4000)).
- **Run locally**: `npm run test:e2e` from `dashboard/` — needs a reachable Postgres
  with task 1.2's schema applied (`POSTGRES_DSN`, or the individual
  `POSTGRES_HOST`/`PORT`/`USER`/`PASSWORD`/`DB` vars) and a running dev server
  (Playwright starts one via `webServer` if none is already up). Specs skip
  themselves cleanly (not a failure) when no DB is reachable — same pattern as
  this project's `*.integration.test.ts` vitest files.
- **CI wiring**: not yet done — `.github/workflows/` isn't committed to this repo
  (blocked on the `workflow` OAuth scope; see `docs/pending-workflow-changes/` for
  the proposed YAML pending a human commit). Once workflows land, add a
  Postgres service + `npm run test:e2e` step to the `dashboard-test` job.

## Adding a new spec

1. Seed synthetic, deterministic data directly via `pg` (see `candidates.spec.ts`
   for the pattern) — never real scraped listing data (this is a public repo).
2. Assert no error surface + real content present, as above.
3. Clean up seeded rows in `afterAll` unconditionally (even on failure).
