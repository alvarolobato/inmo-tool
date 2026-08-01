---
id: D-029
title: Worker must not write to `.github/workflows/`
date: 2026-05-11
---

# D-029: Worker must not write to `.github/workflows/`

*Decided: 2026-05-11*

**Context**: Issue #558 asked the worker to land `.github/workflows/ai-factory-manager.yml`. PR #564 was rejected by GitHub: *"refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission"*. PR #568 (merged `7fba1c3`, 2026-05-10 13:55 UTC) tried to fix this by adding `workflows: write` to `ai-worker.yml`'s `permissions:` block. The fix was based on a misreading of GitHub's permission model and silently broke the entire factory for ~21 hours.
**Root cause** (two confused identity systems):
1. The `permissions:` block controls **`GITHUB_TOKEN`** scopes only. GitHub's allow-list is fixed: `actions, attestations, checks, contents, deployments, discussions, id-token, issues, models, packages, pages, pull-requests, repository-projects, security-events, statuses`. **`workflows` is not on this list.** An unrecognised key puts the workflow into **startup-failure**: every event creates a zero-job run record (name shows as the file path because the YAML `name:` field is unreadable), and `issues: labeled` events are dropped on the floor.
2. The push that #564 actually failed on was from the **claude-code-action GitHub App's installation token**, not `GITHUB_TOKEN`. The App's "Workflows: Read and write" permission is configured in the App's installation settings on github.com — completely orthogonal to anything in the workflow YAML.
**Effect of #568**: from 2026-05-10 13:55 UTC to 2026-05-11 11:00 UTC, no `ai-work` label event fired the worker. Issue #580 was just the most visible casualty; every issue routed through the factory in that window was silently stuck.
**Decision**:
- **The worker (and any claude-code-action job in this repo) must not push files under `.github/workflows/`.** Encoded in [AGENTS.md "No worker writes to `.github/workflows/`"](../../AGENTS.md#no-worker-writes-to-githubworkflows-d-029-issue-558). When an issue asks for a new or modified workflow file, the worker posts the proposed YAML in the PR body / tracking-issue comment inside a fenced ```yaml block, lands everything else the issue asks for (prompts, configs, helper scripts, docs, labels) normally, and tags the human owner to copy the YAML into place in a follow-up commit.
- Removed `workflows: write` from `ai-worker.yml`'s `permissions:` block (the only place it appeared in the repo).
- Replaced the prior multi-line comment that recommended the workaround with a tombstone comment pointing to this decision so the next agent doesn't re-add the line.
**Alternatives rejected**:
- **Grant the claude-code-action App "Workflows: Read and write" on its installation**: technically the right knob to make the original push succeed, but giving the worker rights to rewrite the very files that schedule it is a self-modifying-system foot-gun. Not worth the operational surface for ~one workflow file per quarter.
- **Use a fine-grained PAT with `workflow` OAuth scope** stored as a secret: same risk profile (delegated trust to the worker for self-modifying writes), plus a secret to rotate and lose.
- **Leave the line in and ship a follow-up fix later**: not viable — the factory is unusable while the line is present.
**Rationale**: The factory needs to be live more than it needs to auto-ship new workflow files. Workflow YAML changes are infrequent (#558 is the first in months) and the human-copy step is a 30-second cost. The original error in #564 was a real problem but PR #568 fixed it with the wrong knob and a worse problem.
**See**: `.github/workflows/ai-worker.yml` (permissions block), `AGENTS.md` "No worker writes to `.github/workflows/`", issues #558 / #564 / #568 / #580 / #729 (same class of bug — CI-remediation commits masking Copilot review in the watchdog's `LATEST_BOT_ACTIVITY` signal).
