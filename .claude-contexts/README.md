# Per-role CLAUDE.md variants

Each `<role>.md` file here is a complete replacement for the root `CLAUDE.md`, used **only by AI Factory workflows** to limit per-boot context. The repo's root `CLAUDE.md` is unchanged and continues to be the source for interactive CLI use (`claude` invoked manually in this repo).

## How it works

Each workflow that invokes `anthropics/claude-code-action@v1` adds a pre-step before the action:

```yaml
- name: Use role-specific CLAUDE.md
  run: cp .claude-contexts/<role>.md CLAUDE.md
```

The GitHub Actions runner is ephemeral, so the swap only affects that run. Local `claude` sessions never see this swap.

## Role → workflow mapping

| Role file | Workflows |
|-----------|-----------|
| `worker-plan.md` | `ai-worker.yml` (plan job), `ai-plan.yml` |
| `worker-impl.md` | `ai-worker.yml` (implement job), `ai-ci-remediation.yml` |
| `review.md` | `ai-pr-review.yml` |
| `feedback.md` | `ai-address-feedback.yml` |
| `mergeability.md` | `ai-pr-mergeability.yml` |
| `command.md` | `ai-command.yml`, `ai-factory-manager.yml` |
| `audit.md` | `ai-bug-hunter.yml`, `ai-feature-ideas.yml`, `business-review-weekly.yml`, `ai-dashboard-audit.yml`, `ai-etl-health.yml`, `ai-project-summary.yml`, `ai-sql-validator.yml`, `ai-test.yml` |
| `triage.md` | `ai-issue-triage.yml`, `ai-stale-manager.yml` |

## Design

- Each role imports `DECISIONS.md` (the always-relevant binding rules — ~1.8k tokens).
- Heavy imports (full `AGENTS.md`, `ARCHITECTURE.md`) are reserved for roles that genuinely need them (planning, interactive command).
- Lightweight roles (mergeability, triage, audit) inline only the policy they need; they read other files on demand.
- Skills (`docs/skills/`) are always available via the Read tool — agents fetch them when they hit a domain.

## When to update

- **New workflow that runs `claude-code-action`** — pick the closest role; add a pre-step in the workflow YAML.
- **Need to change context for one role** — edit the role file. Don't touch other roles.
- **Need a new role entirely** — add a new file here, list it in the table above, add the pre-step to the relevant workflow(s).

The root `CLAUDE.md` is for **CLI use only** and must stay complete; never trim it to save tokens — trim role files instead.
