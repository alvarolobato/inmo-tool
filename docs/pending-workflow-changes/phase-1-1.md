# Pending workflow-file changes — task 1.1 (issue #9)

`.github/workflows/*.yml` isn't committed to this repo yet (the initial import push was rejected — the pushing token lacks GitHub's `workflow` OAuth scope; see [D-004](../decisions/D-004-no-worker-workflows.md)). The 31 files sit untracked on disk. This doc lists what needs to change in the affected ones once a human commits them (or the push-token scope is granted), per D-004's "propose in PR body" pattern.

## Needs no change

`ci.yml`'s "knowledge.ts drift guard" step (`npm run build:knowledge && git diff --exit-code lib/knowledge.ts`) should pass as committed — `docs/knowledge-sources.yml` and `dashboard/lib/knowledge.ts` were updated together to a consistent empty state in this task. Verify once CI actually runs; if `npm run build:knowledge` doesn't handle an empty `sources:` list gracefully, that's a real bug in `dashboard/scripts/build-knowledge.ts` worth its own follow-up issue, not a workflow-YAML problem.

## Remove entirely

- **`ai-sql-validator.yml`** — validates WrenAI SQL pairs via `scripts/wren-push-metadata.py`, both gone. No inmo-tool equivalent exists yet (no LLM knowledge-pair concept until Phase 4). Delete the file; re-add a fresh one if/when Phase 4 needs an equivalent validator for its own knowledge sources.

## Small targeted edits

- **`ai-bug-hunter.yml`** (line ~54): remove the bullet `- Data type mismatches between 4D and PostgreSQL` from its lookout list — no 4D source exists. Add a connector/dedup-relevant bullet instead once Phase 1/2 code exists to have real failure patterns for (e.g. "dedup false-positive merges", once task 2.2 lands).
- **`ai-ci-remediation.yml`** (line ~172): change `pytest etl/tests/` (with empty P4D/Postgres env — tests self-skip when needed)` → `pytest etl/tests/` (with empty Postgres env — tests self-skip when needed)`.
- **`ai-command.yml`** (line ~87): change `Read-only SQL policy: NEVER modify the source 4D database` → `Connectors are read-only against source sites: never submit forms or contact sellers (issue #1 §15)`.
- **`ai-deploy-notify.yml`** (lines ~33, ~43): `cd /path/to/powershop-analytics` → `cd /path/to/inmo-tool`; drop the `curl .../healthz # WrenAI` health-check line entirely (no WrenAI service) — replace with a dashboard health check (`curl http://localhost:${DASHBOARD_PORT:-4000}/api/health`) once there's a real deploy target to check (none exists yet, see ARCHITECTURE.md § Production).
- **`ai-feature-ideas.yml`** (lines ~53, ~68): drop "Look at WrenAI config for knowledge gaps" and the "WrenAI knowledge" item from the brainstorm-areas list; add "connector coverage/reliability" and "dedup accuracy" instead.
- **`ai-issue-triage.yml`** (lines ~46, ~48): `comp-etl` description → "ETL service, connector sync, PostgreSQL schema"; delete the `comp-wren` component label entirely (no WrenAI). Add a `comp-connectors` and/or `comp-dedup` label once those areas have enough issue volume to warrant a dedicated triage bucket.
- **`ai-pr-mergeability.yml`** (line ~289): remove `- 4D PKs are NUMERIC, never FLOAT8.` from the review checklist — not applicable, no 4D PKs in this project. (The general lesson — numeric-precision-sensitive PKs need care — may resurface if a connector's source IDs need similar treatment; add a fresh bullet then, don't keep this one as a vague analogy.)
- **`release.yml`** (line ~23) and **`release-beta.yml`** (lines ~144, ~154): remove `wren-config.yaml` from the list of files bundled into a release artifact — the file doesn't exist. No replacement needed unless a future release needs to bundle a different config file (e.g. once `config/schema.yaml`-adjacent deploy config exists for a real prod target).

## Not reviewed in this pass

The remaining ~20 workflow files (`ai-worker.yml`, `ai-pr-review.yml`, `ai-watchdog.yml`, `ai-factory-manager.yml`, etc.) had zero hits for `4D|PowerShop|WrenAI|p4d` and are presumed clean, but weren't individually read end-to-end for this task — a human committing the workflow batch should do a final skim before enabling them, same as any other inherited-but-unreviewed code.
