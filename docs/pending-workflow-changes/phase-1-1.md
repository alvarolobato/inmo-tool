# Pending workflow-file changes — task 1.1 (issue #9)

`.github/workflows/*.yml` isn't committed to this repo yet (the initial import push was rejected — the pushing token lacks GitHub's `workflow` OAuth scope; see [D-004](../decisions/D-004-no-worker-workflows.md)). The 31 files sit untracked on disk. This doc lists what needs to change in the affected ones once a human commits them (or the push-token scope is granted), per D-004's "propose in PR body" pattern.

Every workflow below was found by grepping the full file-deletion list from this task's diff against every workflow's content (path references, `paths:` triggers, and prose instructions to an LLM step) — not just a `4D|PowerShop|WrenAI` keyword search, which missed several of these on the first pass.

## `ci.yml` — will fail on first run without these fixes

Three separate problems in one file:

```yaml
# jobs.lint — DELETE this step, scripts/verify_etl_schema.py no longer exists.
# Schema verification returns once task 1.2 lands the new schema + a
# verifier for it; don't recreate a stub in the meantime.
      - name: Verify ETL mappings vs init.sql DDL
        run: python scripts/verify_etl_schema.py
```

```yaml
# jobs.test.steps[1].env — remove the dead P4D_HOST var, no 4D source exists.
      - run: pytest etl/tests/ -x --tb=short -q --cov=etl --cov-report=term-missing --cov-report=xml
        env:
          POSTGRES_DSN: ""
```

**`jobs.dashboard-e2e` — superseded, see [`phase-2-5.md`](phase-2-5.md).** This
section originally said to disable the whole job (`if: false`) since every spec
it ran was deleted along with `dashboard/e2e/fixtures/`. Task 2.5 (#19) has since
written a real spec (`dashboard/e2e/candidates.spec.ts`) — `phase-2-5.md` has the
current proposed YAML for this job. Left the historical reasoning above for
context; don't apply the `if: false` version, apply `phase-2-5.md`'s instead.

The `dashboard-test` job's typecheck/unit-test/knowledge-drift-guard steps need
no changes (verified passing as committed), but **task 2.5 (#19) added
real-Postgres integration tests to this job that currently skip in CI for lack
of a database — see [`phase-2-5.md`](phase-2-5.md)** for the required service
block. `docker-build` needs no changes — it only builds `./etl/Dockerfile`,
unaffected by any of this task's deletions.

## Remove entirely

- **`ai-sql-validator.yml`** — validates WrenAI SQL pairs via `scripts/wren-push-metadata.py`, both gone. No inmo-tool equivalent exists yet (no LLM knowledge-pair concept until Phase 4). Delete the file; re-add a fresh one if/when Phase 4 needs an equivalent validator for its own knowledge sources.
- **`business-review-weekly.yml`** — the entire `docs/business-review/` directory (7 role MDs + common.md + review-types.md) it depends on is deleted; its own `docs/etl-sync-strategy.md` reference is also dead. The feature (simulated-persona weekly review issues) could return in a different shape for inmo-tool later (e.g. simulating investor personas reviewing candidate quality), but that's a fresh design, not a patch to this file. Delete it; note the schedule trigger was already disabled (`# schedule: disabled 2026-07-14`) so removing it has zero operational impact today.

## `ai-etl-health.yml`

```yaml
# Step 3 prompt text — "Review ETL sync strategy" currently points at a
# deleted doc. Point it at the new connector-framework docs instead, once
# task 1.3 (#11) creates them (etl/connectors/ + a docs/skills/connectors.md
# per issue #42's reference to that filename). Until 1.3 lands, drop this
# numbered section from the prompt entirely rather than leave a dangling
# reference.
            3. **Review connector sync strategy**:
               - Read docs/skills/connectors.md
               - Check that documented rate limits match code implementations
               - Verify circuit-breaker logic is correct
```

## `test-load-knowledge.yml`

```yaml
# The paths: trigger lists 4 deleted files/globs (data-decisions.md,
# etl-sync-strategy.md, docs/architecture/**, 4d-sql-dialect.md) alongside
# 2 that still exist. Narrow it to what remains until Phase 4 (#24, the
# llm-context port) defines this project's own knowledge-source MDs.
on:
  pull_request:
    paths:
      - ".github/actions/load-knowledge/**"
      - ".github/workflows/test-load-knowledge.yml"
      - "docs/skills/data-access.md"
```
Note `docs/skills/data-access.md` (4D SQL/SOAP connection patterns) was *not* deleted by this task — it's 4D-specific but wasn't in task 9's deletion list; flagging here as likely stale content worth a follow-up cleanup pass, not a workflow-YAML problem.

## Small targeted edits (prose/list items referencing dead paths, not deleted files)

- **`ai-bug-hunter.yml`**:
  ```yaml
              ### ETL (etl/)
              - Null handling in data transformations
              - Connection error recovery
              - Missing error handling in sync modules
              - Off-by-one errors in pagination/batching
              - Race conditions in concurrent operations
              - Dedup false-positive merges (once task 2.2 / #16 lands)
  ```
- **`ai-ci-remediation.yml`**:
  ```yaml
            Repository CI (`.github/workflows/ci.yml`) runs:
            - `ruff check etl/` and `ruff format --check etl/`
            - `pytest etl/tests/` (with empty Postgres env — tests self-skip when needed)
            - `docker build` for `./etl/Dockerfile`
  ```
- **`ai-command.yml`**:
  ```yaml
            ## Project Rules (from AGENTS.md)
            - Connectors are read-only against source sites: never submit forms or contact sellers (issue #1 §15)
            - No credentials in committed files
            - No scraped personal data in committed files
  ```
- **`ai-deploy-notify.yml`**: the whole "Deployment Steps"/"Rollback"/"Auto-update" block assumes a live `docker-compose.prod.yml` + `deploy/auto-update.sh`, both deleted (there is no production target for inmo-tool yet — see ARCHITECTURE.md § Production, still a placeholder). Don't patch individual lines (the WrenAI healthz line, the path rename) — the whole block is premature until a real prod deploy story exists. Replace with a placeholder:
  ```yaml
          ### Deployment
          No production deployment target exists yet for inmo-tool (see
          ARCHITECTURE.md § Production). This notification currently only
          confirms a release was tagged; update this workflow once a real
          deploy target and compose file exist.

          Close this issue once the release is confirmed built.
  ```
- **`ai-feature-ideas.yml`**:
  ```yaml
            2. Read docs/ai-factory.md for the AI factory vision
            3. Browse recent issues to understand current priorities
            4. Look at the dashboard app (dashboard/) for UI improvement opportunities
            5. Look at connector/dedup coverage for reliability gaps
            6. Check existing [feature-ideas] issues to avoid duplicates
            ...
            ## Guidelines
            - Focus on practical, implementable ideas (not moon shots)
            - Consider: Dashboard improvements, connector reliability, dedup accuracy, AI-assessment quality, CLI usability, data quality, monitoring
            - Each idea should be self-contained enough to become its own issue
            - Prefer ideas that build on existing infrastructure
  ```
- **`ai-issue-triage.yml`**:
  ```yaml
               - `comp-etl` — ETL service, connector sync, PostgreSQL schema
               - `comp-dashboard` — Dashboard App, Next.js, Tremor, widgets, LLM prompts
               - `comp-cli` — CLI commands, ps.sh, shell scripts
               - `comp-infra` — Docker, CI/CD, GitHub Actions, deployment
  ```
  (Drop `comp-wren` entirely — no WrenAI. Add `comp-connectors` / `comp-dedup` once those areas have enough issue volume for a dedicated bucket.)
- **`ai-pr-mergeability.yml`**:
  ```yaml
            Repository conventions to be aware of (see CLAUDE.md / AGENTS.md):
            - Read-only against source listing sites — no form submissions or contact-seller actions.
            - For wide tables, specify columns explicitly — never `SELECT *`.
  ```
- **`release.yml`**:
  ```yaml
      - name: Upload release assets
        uses: softprops/action-gh-release@v2
        with:
          files: |
            docker-compose.yml
  ```
  (Every other listed asset — `docker-compose.prod.yml`, `wren-config.yaml`, all of `deploy/*` — was deleted by this task. Don't reintroduce a prod-specific asset list until a real prod deploy story exists; ship just the base compose file for now, or drop this step entirely if even that's premature.)
- **`release-beta.yml`**:
  ```yaml
          # No prod-specific config files exist yet to attach — see
          # ARCHITECTURE.md § Production. Revisit once inmo-tool has a real
          # deploy target.
          gh release create "$TAG" \
            --title "$TAG (beta)" \
            --notes-file "${{ steps.changelog.outputs.path }}" \
            --target "${{ github.event.repository.default_branch }}" \
            --prerelease
  ```

## Not reviewed in this pass

The remaining workflow files (`ai-worker.yml`, `ai-pr-review.yml`, `ai-watchdog.yml`, `ai-factory-manager.yml`, `ai-ec-validator.yml`, `ai-multi-phase-guard.yml`, `ai-plan.yml`, `ai-post-merge-verify.yml`, `ai-pr-labeler.yml`, `ai-pre-merge-digest.yml`, `ai-project-summary.yml`, `ai-stale-manager.yml`, `ai-test.yml`, `ai-auto-release.yml`, `ai-dashboard-audit.yml`, `release-docker.yml`, `ai-docs-patrol.yml.disabled`, `ai-security-audit.yml.disabled`) were grepped against the full list of files this task deleted and had zero hits, so are presumed clean for *this specific task's* changes — but weren't individually read end-to-end, and several are already disabled (the two `.disabled` files, and `ai-docs-patrol.yml.disabled` specifically still references `docs/etl-sync-strategy.md` in its prompt body, which grepped clean only because the check above matches file *paths*, and this is prose referencing a path — worth a human's attention when re-enabling, not urgent while disabled). A human committing the workflow batch should do a final skim before enabling any of them.
