# Pending workflow-file changes — issue #203 (decision-record ID collision check)

`.github/workflows/*.yml` still isn't committed to this repo (see
[D-004](../decisions/D-004-no-worker-workflows.md)). This doc supersedes one
line of `task-4.2-occupancy.md`'s `jobs.test` proposal.

## Finding: `scripts/tests/` has never been wired into any proposed CI job

Every existing pending-workflow-changes proposal for `jobs.test` (`phase-1-1.md`,
`task-4.2-occupancy.md`) runs `pytest etl/tests/` only. `scripts/tests/` — which
already contained `test_doc_graph.py` (the doc-graph orphan check) and
`test_build_es_gazetteer.py` before this issue, and now also contains
`test_decision_ids.py` (the decision-ID collision/frontmatter/cross-reference
check this issue asks for) — has been running locally only. None of these
tests need a database (`test_decision_ids.py` is pure file-reads against the
repo tree, same as `test_doc_graph.py`), so this is a one-line addition to the
`pytest` invocation already proposed, not a new service or job.

This is the same "the check that can't fail because it never runs" shape the
rest of this issue is about — a detector that only exists in a working
directory nobody's CI executes is exactly as silent as no detector at all.

## `ci.yml` — `jobs.test`: addendum to `task-4.2-occupancy.md`

`task-4.2-occupancy.md` already proposes the `services.postgres` block, the
"Apply schema" step, and the `pytest etl/tests/ ...` invocation for this job.
The only change this issue's fix asks for: broaden that one `run:` line to
also collect `scripts/tests/`:

```yaml
      - run: pytest etl/tests/ scripts/tests/ -x --tb=short -q --cov=etl --cov-report=term-missing --cov-report=xml
        env:
          POSTGRES_DSN: postgresql://inmotool:inmotool@localhost:5432/inmotool
          REQUIRE_DB: "1"
```

(Only the `scripts/tests/` path segment is new relative to
`task-4.2-occupancy.md`'s line 59 — everything else, including the env block,
is unchanged and shown here only for the human applying this to have one
complete line to paste.)

## Verified locally

Full repo pytest suite (`etl/tests/` + `scripts/tests/`, 777 tests as of this
issue) run against a real, disposable Postgres container
(`postgres:16-alpine`, unique container/DB name per the isolation rule in
issue #159) with schema applied from `etl/schema/init.sql`, both with and
without this issue's changes:

- `main` @ `a0329e0`, `REQUIRE_DB=1`: 773 passed.
- This branch, `REQUIRE_DB=1`: 777 passed — the same 773 test node IDs
  (diffed by name, not just count) plus exactly the 4 new
  `test_decision_ids.py` tests. Nothing else changed shape.
- Each of the 4 new tests independently confirmed to fail on the violation it
  targets (duplicate ID, frontmatter/filename mismatch, dangling
  `DECISIONS.md` link, stale cross-reference) and pass once the violation is
  reverted.
