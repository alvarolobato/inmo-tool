# Pending workflow-file changes — issue #159 (per-run test database isolation)

`.github/workflows/*.yml` still isn't committed to this repo (see
[D-004](../decisions/D-004-no-worker-workflows.md)). This doc is an addendum
to [`phase-1-1.md`](phase-1-1.md) (`jobs.test`) and [`phase-2-5.md`](phase-2-5.md)
(`jobs.dashboard-test`) — it does not replace either, it simplifies one step
each proposes.

## What changed

Issue #159 gave both `pytest etl/tests/` and `npm test` their own throwaway,
uniquely-named PostgreSQL database per invocation, created and dropped around
the run:

- **Python**: `etl/tests/conftest.py`'s new session-scoped, autouse
  `_isolated_test_database` fixture connects with whatever `POSTGRES_*` config
  is present, `CREATE DATABASE`s a fresh one, applies `etl/schema/init.sql` to
  it, points `POSTGRES_DSN` at it for the rest of the session, and drops it at
  teardown.
- **TypeScript**: `npm test` / `npm run test:coverage` / `npm run test:watch`
  now run through `dashboard/scripts/test-with-isolated-db.ts`, which does the
  same thing around a `vitest` invocation instead of wrapping it in a fixture
  (vitest's worker pool makes a `globalSetup`-mutates-`process.env` approach
  unreliable — see the script's own header comment for why).

Both mechanisms only need an **admin-reachable** Postgres server to bootstrap
from (they connect to whatever `POSTGRES_DB` is already configured — e.g. the
CI service's default `inmotool` — purely to issue `CREATE DATABASE`); they no
longer read or write anything in that bootstrap database itself.

## `ci.yml` — the "Apply schema" step becomes unnecessary

Both [`phase-1-1.md`](phase-1-1.md)'s `jobs.test` proposal and
[`phase-2-5.md`](phase-2-5.md)'s `jobs.dashboard-test`/`jobs.dashboard-e2e`
proposals include a step like:

```yaml
      - name: Apply schema
        run: PGPASSWORD=inmotool psql -h localhost -U inmotool -d inmotool -f etl/schema/init.sql
```

This applied `init.sql` to the CI service's single shared `inmotool` database
so the test run had a schema to work against. Now that both `pytest` and
`npm test` provision and schema-apply their *own* database automatically, this
step is redundant for `jobs.test` and `jobs.dashboard-test` — **drop it** from
those two jobs when applying the proposed YAML. Everything else in both
proposals (the `services.postgres` block, `POSTGRES_DSN` pointed at the
service's default database, `REQUIRE_DB: "1"`) stays as proposed: it's still
what the isolation fixture/script needs to reach *a* database to bootstrap
from.

`jobs.dashboard-e2e` is a partial exception: Playwright's own browser process
talks to the running Next.js server, which reads `POSTGRES_DSN` directly (no
`vitest`/wrapper-script isolation in that path) — keep the "Apply schema" step
there, since e2e specs still need the shared service database to have a
schema.

## Verified locally

Exercised against a disposable Postgres container (`postgres:16-alpine`,
unique container/DB name per the isolation rule this issue introduces):

- Two full `pytest etl/tests/` runs launched concurrently against the same
  base connection: both passed 493/493, repeatably (three concurrent runs in
  one trial). Zero leftover `inmotool_test_*` databases afterward.
- The same base conftest (pre-#159, single shared database) run the same way
  reproduced the bug this issue describes directly: concurrent run A got 13
  failures, concurrent run B got 1 failure + 7 errors — different tests each
  time, i.e. contention, not real defects.
- Two full `npm test` runs launched concurrently: both passed 1840/1840,
  repeatably. Zero leftover `inmotool_test_*` databases afterward.
- Mutation check: commenting out the drop-database call in both the pytest
  fixture and the vitest wrapper script left an orphaned `inmotool_test_*`
  database behind after a run, confirming the cleanup step is load-bearing
  rather than vacuous.
