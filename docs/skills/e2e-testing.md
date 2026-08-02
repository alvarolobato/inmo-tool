# Skill: Writing e2e tests (Playwright)

**Use when**: Adding or changing browser-level end-to-end tests for the Dashboard
App — the tests that drive a real Next.js server + real Postgres and assert what
the user actually sees. For unit/integration tests (vitest/pytest) use
[testing-patterns.md](testing-patterns.md) instead.

## Status: fixtures removed, infra pending the new schema

This skill (and the Playwright setup it describes) was inherited from the source
project this repo was bootstrapped from (powershop-analytics). Its actual specs and
seeded-Postgres fixture tested that project's BI-dashboard business flows against
its `ps_*` mirror schema — none of that applies to inmo-tool, so `dashboard/e2e/`
(specs, fixtures, seed data) was removed in task 1.1 rather than kept in a broken
state.

**What's still true and worth keeping**: the *mechanism* — Playwright driving a
real Next.js server against a real (seeded, synthetic, deterministic) Postgres
database, asserting no error surface renders and real content is present — is a
sound pattern this project should re-adopt once there's a real schema and UI to
test against (Phase 2's candidate-list/map/detail-page tasks, #19/#43/#44). The
source project's own experience (issue #800 in that repo: a dashboard shipped
`there is no parameter $1` to production because unit tests mocked Postgres and
never ran the real SQL) is exactly the failure mode e2e exists to catch — that
rationale carries over even though the fixture/specs don't. See
`docs/decisions/archive/D-041-e2e-required-for-features.md` for the original
binding-rule writeup; re-establish it as a fresh decision once this repo has e2e
infra to point it at.

## Setup that remains (config only, no specs yet)

- **Runner**: Playwright. Config: `dashboard/playwright.config.ts`
  (`testDir: ./e2e`, `webServer: npm run dev`, `baseURL` from `DASHBOARD_PORT` (default 4000)).
- **CI wiring**: not applicable yet — `.github/workflows/` isn't committed to this
  repo (see [D-004](../decisions/D-004-no-worker-workflows.md)), and there are no
  specs to run regardless.

## When Phase 2 rebuilds this

1. Write a fresh seeded-Postgres fixture against the schema task 1.2 defines
   (`property`, `listing`, `search_profile`, etc.) — synthetic, deterministic,
   never real scraped listing data (this is a public repo).
2. Assert the same two things the source project's pattern asserted: no error
   surface (`ErrorDisplay`, generic 500/parameter-error text absent), and real
   content present (a rendered candidate card, map marker, etc. — not a
   skeleton/empty state).
3. Wire specs into CI once `.github/workflows/ci.yml` is committed (see D-004
   for why that's not done yet, and the propose-YAML-in-PR-body workaround).
