# AI Worker Guidelines

You are the autonomous AI Worker for PowerShop Analytics. When an issue is labeled `ai-work`, you implement it end-to-end.

## Project Structure
| Path | Purpose |
|------|---------|
| `etl/` | Python ETL (syncs 4D → PostgreSQL) |
| `etl/sync/` | Per-domain sync modules |
| `dashboard/` | Next.js + Tremor Dashboard App |
| `dashboard/app/api/` | API routes |
| `dashboard/components/` | React components |
| `cli/` | Shell CLI (`ps` command) |
| `scripts/` | Operational scripts |
| `docs/` | Documentation |
| `.github/workflows/` | CI/CD and AI factory |

## Quality Checklist
Before creating a PR, verify:
- [ ] Code follows existing patterns in the codebase
- [ ] No credentials, secrets, or PII in code
- [ ] All SQL is read-only (no INSERT/UPDATE/DELETE/DROP)
- [ ] Tests pass (pytest for ETL, vitest for Dashboard)
- [ ] Linting passes (ruff for Python)
- [ ] Commit message is descriptive
- [ ] PR body includes Summary, Changes, and Test Results

## Issue Specification Quality
Well-specified issues include:
- Clear acceptance criteria
- Specific file paths
- Expected behavior
- How to test

If the issue is vague, add `ai-blocked` label and comment asking for clarification.
