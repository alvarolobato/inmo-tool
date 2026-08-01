---
id: D-041
title: User-facing dashboard features require a Playwright e2e test asserting no error surface
date: 2026-06-03
---

# D-041: User-facing dashboard features require a Playwright e2e test asserting no error surface

*Decided: 2026-06-03*

**Context**: The weekly-review dashboards (issue #800 context) shipped `there is no parameter $1` to production. Every unit test was green because the tests mocked the database — the positional-param bug only surfaced when real SQL ran against real Postgres. The seeded-Postgres e2e harness (delivered in #802) closes this gap: it loads production-faithful synthetic data and boots the full Next.js app, so widget SQL is actually executed and any error surface is visible to the test. This incident was the direct motivation for requiring e2e tests for user-facing dashboard changes.

**Decision**: Every PR that adds or modifies a user-facing dashboard surface (a new page, a new widget type, a new saved-dashboard seeder, or a change to existing widget SQL/rendering) **must ship with a Playwright e2e test** that:
1. Loads the seeded Postgres fixture (`dashboard/e2e/fixtures/init-test-db.sh`).
2. Navigates to the affected page under `DASHBOARD_LLM_PROVIDER=e2e-stub`.
3. Asserts that no error surface is rendered (`ErrorDisplay`, `Detalles técnicos`, `there is no parameter`, `HTTP 500`, `Error al cargar` all absent).
4. Asserts that at least one widget or data region renders real content (not a skeleton or empty state).

PRs that touch dashboard rendering without a corresponding e2e test are not mergeable for those areas.

**Alternatives rejected**:
- *Unit tests only*: insufficient — they mock Postgres and cannot catch SQL runtime errors.
- *Manual QA only*: error-prone and does not scale; the `$1` incident happened under manual QA.
- *Integration tests (vitest + real DB)*: viable supplement but does not exercise the full rendering path (React + SSE + widget layout) that the browser does.

**Rationale**: The failure mode this rule prevents is not a logic error but an integration error — SQL that is syntactically valid yet fails at runtime against real data. Only a test that runs real SQL against real Postgres (which e2e does) can catch it. The seeded fixture (`docs/skills/e2e-testing.md`) makes this pattern cheap: one `init-test-db.sh` call before the suite is all the setup required.

**See**: [docs/skills/e2e-testing.md](../skills/e2e-testing.md), [dashboard/e2e/fixtures/README.md](../../dashboard/e2e/fixtures/README.md), issue #800, PR #802.
