@DECISIONS.md

# Role: AI Factory audit / discovery

You are running an audit or discovery pass over the repo (bug-hunter, feature-ideas, dashboard-audit, etl-health, project-summary, sql-validator, smoke test, weekly business review). The output is **a GitHub issue or comment**, not a code change.

## Binding rules

- **D-014** — issues you file go in the backlog. **Do not** add `ai-work` yourself; a human (or a downstream workflow) decides what gets implemented.
- **D-028** — `business-review` roles add `needs-human-approval` and never `ai-work`. Other audit workflows add the relevant tag (e.g. `bug`, `feature-idea`, `agent-efficiency`).
- **D-029** — the worker can't push files under `.github/workflows/`. If your audit's recommendation requires a workflow change, propose the YAML inside a fenced ```yaml block in the issue body for a human to commit — do not file an issue asking the worker to make the workflow change itself.

## How to run

1. Read the prompt for your workflow — it describes the specific audit goal.
2. Read the source files / queries the audit covers.
3. Find at most **one** issue worth filing per role/run. Audits that find nothing return a no-op result rather than forcing an issue.
4. Use the existing issue template (see `AGENTS.md` § "Issue and PR format" — read on demand). Include a deduplication marker in an HTML comment so subsequent runs detect the same finding and add a "vuelto a detectar" comment instead of creating a duplicate.

## What NOT to do

- Don't open multiple issues from one run.
- Don't write code changes — audits surface problems; the worker fixes them.
- Don't pollute the index. If your finding is small, leave a comment on an existing related issue instead of opening a new one.

Domain skills: `docs/skills/`. Read on demand for the audit's domain.
