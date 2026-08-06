---
id: D-004
title: AI agents must not push to `.github/workflows/` without explicit `workflow` OAuth scope
date: 2026-08-02
group: Plumbing / process
rule: Don't push to `.github/workflows/` without a credential that has `workflow` OAuth scope. Never bypass via the GitHub API — leave YAML staged for a human to commit.
order: 4
---

# D-004: AI agents must not push to `.github/workflows/` without explicit `workflow` OAuth scope

*Decided: 2026-08-02*

**Context**: When this repo was bootstrapped (full codebase import from powershop-analytics), the initial push was rejected by GitHub: *"refusing to allow an OAuth App to create or update workflow `.github/workflows/ai-address-feedback.yml` without 'workflow' scope."* This is a GitHub-enforced restriction independent of repo ownership or admin rights — it applies to the OAuth App/token's *granted scopes*, not to what the repo owner is otherwise allowed to do. The 31 workflow files were left untracked on disk rather than committed.
**Root cause**: Two separate permission systems are easy to conflate:
1. A workflow YAML's own `permissions:` block only scopes the ephemeral `GITHUB_TOKEN` used *during a run* of that workflow — it has no effect on whether a human or agent can *push* changes to workflow files in the first place.
2. Pushing to `.github/workflows/` requires the *pushing credential* (a personal OAuth token, a GitHub App installation token, a PAT) to itself carry `workflow` scope (OAuth/PAT) or "Workflows: read and write" (GitHub App installation permission) — configured outside the repo, at the token/App level.
**Decision**: Don't attempt to work around a blocked workflow-file push via the GitHub API (e.g. the Git Trees/Commits/Refs API) to bypass the same check `git push` enforces — that defeats a deliberate security boundary and produces commits that are hard to audit. When a push is blocked on this:
1. Leave the workflow file content staged/documented (as YAML in a PR description or a `docs/pending-workflow-changes/*.md` file) rather than committed.
2. Tag the human owner to either grant the pushing credential `workflow` scope (`gh auth refresh -s workflow` for a personal token) or commit the file themselves.
3. Land everything else in the same unit of work normally — a blocked workflow-file change doesn't block unrelated code/docs changes in the same PR.
**Alternatives rejected**: Bypassing via the GitHub API's tree/commit/ref endpoints — technically possible, explicitly rejected as it circumvents the same protection the scope check exists to enforce.
**Rationale**: This is a real, load-bearing constraint (not a hypothetical) — it blocked this repo's very first commit. Documenting it up front means every subsequent task that touches `.github/workflows/` (this project inherited the source project's AI-factory workflow files, currently uncommitted) has a known, correct response instead of rediscovering the same rejection.
**See**: `docs/decisions/archive/D-029-no-worker-workflows.md` (source project's original incident and rationale — the same class of bug, encountered independently here at bootstrap time).
