---
id: D-028
title: Weekly business review by simulated LLM roles
date: 2026-05-07
---

# D-028: Weekly business review by simulated LLM roles

*Decided: 2026-05-07*

**Context**: Issue #467. Dashboards are improved ad-hoc whenever someone notices something. There is no systematic process that **questions** whether each panel actually serves a business decision, whether KPIs have comparative context, whether visible numbers can mislead. We want a recurring critical review that is not technical (the AI Factory already does technical triage) — it must be a **business** review from multiple, non-overlapping vantage points.
**Decision**:
- Prompt framework versioned in `docs/business-review/`: a shared `common.md` (tone, JSON output format, labels, rules, "what is a relevant problem"), an extensible `review-types.md` catalog (`dashboards`, `data-quality`, `llm-telemetry`, `documentation`, `codebase`), and 7 role MDs under `roles/` (CEO, Retail, Mayorista, Compras, CFO, Producto, BI Skeptic). Each role declares which review type(s) it performs.
- Weekly GitHub Action `.github/workflows/business-review-weekly.yml` (cron Mon 06:00 UTC + `workflow_dispatch` with `dry_run` and optional `only_role`). A `setup-labels` job ensures the required labels exist; a `review` matrix job runs the 7 roles **sequentially** (`max-parallel: 1`).
- Each role uses `anthropics/claude-code-action@v1` (matches the existing `ai-feature-ideas.yml` pattern; reuses `CLAUDE_CODE_OAUTH_TOKEN` so no extra secret is needed). The prompt instructs the model to read the MDs, inspect the repo (templates, components, schema, docs) — **not** the production database, since the action has no DB access — and produce a single JSON envelope: `{skip: false, title, body_markdown, fingerprint, evidence[]}` or `{skip: true, reason}`.
- Hard cap of **1 issue per role per week**. Roles that find nothing worth filing return `skip: true` rather than forcing an issue.
- Created issues carry `business-review`, `role:<slug>`, `review-type:<slug>`, `needs-human-approval`. They **never** carry `ai-work`. The AI Factory may triage and plan, but **must not implement** until a human removes `needs-human-approval` and adds `ai-work`. This is the core of "the LLM proposes, the human authorizes".
- Deduplication is in-prompt: before creating, the model lists existing open issues with `business-review` + `role:<slug>` and matches `<!-- fingerprint: ... -->` HTML comments. On match, it adds a "vuelto a detectar" comment and exits without creating a new issue. `dry_run=true` skips the side-effect entirely and prints what it would have done.
- Adding a new role or a new review type is **only** editing/adding a markdown file. The workflow contains the role list once (matrix); adding role 8 is two lines in the matrix and a new MD.
**Alternatives rejected**:
- Direct OpenRouter call from a Python runner: would require adding `OPENROUTER_API_KEY` as a CI secret and re-implementing what `claude-code-action` already gives. The repo already standardised on the action for weekly LLM workflows (`ai-feature-ideas.yml`).
- Single LLM call covering all 7 roles in one prompt: defeats the purpose of independent vantage points and produces shallow, averaged output.
- Auto-approving propositions and letting the AI Factory implement them: too high blast radius. A bad proposal would consume engineering time silently. Human approval is the cost of safety.
- Running the matrix in parallel: not needed (7 calls, low rate-limit risk) and sequential gives clearer logs and predictable cost.
**Rationale**: Roles are designed to **not overlap** — CEO does strategy, Retail does stores, Mayorista does B2B clients, Compras does procurement, CFO does margin, Producto does assortment, and BI Skeptic does data quality and "what could mislead". The framework is **extensible by design**: new roles or review types are markdown only.
**See**: `docs/business-review/{common.md,review-types.md,README.md,roles/01-ceo.md..07-bi-skeptic.md}`, `.github/workflows/business-review-weekly.yml`, issue #467.
