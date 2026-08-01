# Issue and PR format

All GitHub issues in this project follow a single standard format. When creating issues, always use this template exactly.

> **Why this lives here, not in AGENTS.md:** the template + phasing rules are ~200 lines of reference that the planner reads once when decomposing work, but every Claude session in the repo doesn't need them in the always-loaded context chain. AGENTS.md keeps a short summary and links here.

## Issue template

```markdown
# <Feature name>

## Context
- **Problem**: <what's wrong / missing; why it matters>
- **Worktree**: <required: git worktree name for isolated execution, e.g. `wren-p1-compose`>
- **Scope**: <what is in / out of scope>
- **Constraints**: <perf, compatibility, no-breaking-changes, deps, etc.>
- **Repo touchpoints**: <files/dirs likely involved, commands, datasets impacted>
- **Definition of done**: <e.g., builds + tests pass; feature-specific checks>
- **How is it going to be tested**: <testing strategy and specific test cases>

## Plan
<optional: narrative describing the overall approach, dependency graph, risks.
The planner fills this in when it refines the issue body via `ai-plan` or `ai-work`.>

## Phase 1 — <name>

**Goal**: <what this phase achieves>
**Branch**: `<worktree-name>-p1`
**Depends on**: <nothing / Phase N PR merged>

### Tasks

- [ ] 1) <task title>
  - **Change**: <precise behavior or code change>
  - **Files**: <exact file paths>
  - **Acceptance**: <how to verify; exact commands and expected output>

- [ ] 2) ... 

- [ ] N-2) Run all checks and fix issues
  - **Change**: Run all tests, linting, type-checking, and formatting; fix any failures
  - **Files**: any files with issues
  - **Acceptance**: `docker compose run --rm etl python -m pytest && python -m ruff check etl/ && python -m mypy etl/`

- [ ] N-1) Copilot review (one round only) per [D-021](docs/decisions/D-021-two-review-rounds.md)

- [ ] N) Opus review (one round only, clean context) per [D-021](docs/decisions/D-021-two-review-rounds.md)

## Exit criteria / Validation

Each item below must be ticked with **concrete evidence** before the issue is
considered done. Evidence means test output, a CI run link, a screenshot, or a
short screen recording — not "manually verified". The implementer must provide
this evidence in the PR description or a comment on the issue.

**Every EC item must be verifiable by CI or explicitly marked human-only.**
Prefer the form that names a specific test:

- [ ] **EC-1**: <user-observable requirement> — *Verified by*: `path/to/test.spec.ts` → `"test name"` (CI run: link)
- [ ] **EC-2**: <requirement that cannot be automated> — *Human-only*: <reason automation is not possible> — *Evidence*: <screenshot/recording>

If an EC item has no test and is not marked `Human-only`, it is incomplete. The Opus reviewer will block the PR.

<format rules for the planner when writing exit criteria>
- Write from the owner's point of view, not the implementer's ("I can see X" not "the function returns Y")
- Each criterion must be independently verifiable without reading source code
- Forbidden phrases: "tests pass", "component renders", "function returns" — these are not user-observable
- Required: state the exact user action and the expected observable result
- **Preferred**: link to the specific test case that covers it. "Verified by `dashboard/e2e/foo.spec.ts` → `AC-4`" is better than "Evidence: CI run link"
- Mark items `Human-only` only when a running container with real data is strictly required (e.g. visual layout, hardware peripherals). Everything else should have a test.
- Include at least one Playwright or integration test criterion per feature that touches the UI or API
</format rules>

### Writing EC items the EC validator can verify (D-038)

The EC validator (`ai-ec-validator.yml`) runs automatically on final-phase merges. It parses each `**EC-N**` item and dispatches verification based on the `*Verified by*` annotation. Write items so the validator can act on them:

| Pattern | What the validator does |
|---------|------------------------|
| `*Verified by*: path/file.test.ts → "test name"` | Checks file exists at merge SHA + CI run passed |
| `*Verified by*: some-job CI job` | Checks a CI run on the merge SHA succeeded |
| `*Verified by*: file diff in this PR` | Runs `git show <merge-sha> --stat -- <path>` |
| `*Verified by*: wc -l path/to/file.md` | Same as file diff — checks file changed in merge commit |
| `*Human-only*` | Never auto-verified; listed for owner action |
| No annotation | Treated as `Human-only` with a warning |
| Shell metacharacters in `*Verified by*` (pipes, `$(...)`, builtins like `bash`/`curl`) | Refused for security; treated as `Human-only` |

**Key rules:**
- Prefer `*Verified by*: path/test.ts → "test name"` — the validator checks the file at the merge SHA and confirms a CI run passed.
- Use `*Human-only*` for anything requiring real hardware, a production environment, or human judgment (screenshots, screen recordings, UX quality assessment).
- Patterns like `wc -l path/to/file.md` work: the validator strips Markdown backticks, then dispatches to the file-diff strategy (`git show`) — it never executes the command. Actual shell metacharacters (pipes `|`, `$(...)`, builtins such as `bash` or `curl`) are refused for security.
- Every item without `*Verified by*` or `*Human-only*` generates a warning in the validator comment and is treated as human-only.

The validator adds `fact-awaiting-human-validation` to the issue when any human-only items remain, and closes the issue automatically when all items are verified or ticked by the owner. The owner can re-trigger the validator by adding the `ai-validate-ec` label.

## Additional Context
<append-only notes: discoveries, links, decisions, gotchas found during execution>
```

**Single-phase issues** (the default) have exactly one `## Phase 1` block. **Multi-phase issues** add `## Phase 2`, `## Phase N`, each depending on the previous phase's PR being merged.

### Single-phase example

```markdown
# Add /api/health endpoint

## Context
- **Problem**: No endpoint to check ETL sync freshness
- **Worktree**: `health-endpoint`
- **Scope**: One route, one test
- **Definition of done**: `GET /api/health` returns `{ status, last_sync }`. Tests pass.

## Phase 1 — Health endpoint

**Goal**: Implement and test the endpoint
**Branch**: `health-endpoint-p1`
**Depends on**: nothing

### Tasks

- [ ] 1) Create `dashboard/app/api/health/route.ts`
  - **Change**: Query `watermark` table; return `{ status: "ok"|"stale", last_sync }`. Stale if last_sync > 48 h.
  - **Files**: `dashboard/app/api/health/route.ts`
  - **Acceptance**: `curl localhost:3000/api/health` returns JSON with `status` key

- [ ] 2) Add Vitest test
  - **Files**: `dashboard/app/api/health/route.test.ts`
  - **Acceptance**: `npm test` green

- [ ] 3) Run all checks and fix issues

- [ ] 4) Copilot review (one round only)

- [ ] 5) Opus review (one round only, clean context)
```

### Multi-phase example

```markdown
# Conversations feature

## Context
- **Problem**: No way to browse past AI conversations
- **Worktree**: `conversations`
- **Definition of done**: UI shows list + detail; API persists to DB.

## Plan
Three phases: data layer (Phase 1) → API routes (Phase 2) → UI components (Phase 3).
Phase 2 cannot start until Phase 1 merges (consumes data-layer types).
Phase 3 cannot start until Phase 2 merges (consumes API shape).

| Phase | Tasks | Files | Reason for split |
|-------|-------|-------|-----------------|
| 1 | DB schema + lib types | `etl/schema/init.sql`, `dashboard/lib/conversations.ts` | Sets contract others read |
| 2 | API routes | `dashboard/app/api/conversations/*.ts` | Needs Phase 1 types |
| 3 | UI components | `dashboard/components/ChatSidebar.tsx` | Needs Phase 2 shapes |

## Phase 1 — Data layer

**Goal**: DB schema + TypeScript types
**Branch**: `conversations-p1`
**Depends on**: nothing

### Tasks
- [ ] 1) Add `conversations` table to `etl/schema/init.sql`
- [ ] 2) Add TypeScript types in `dashboard/lib/conversations.ts`
- [ ] 3) Run all checks
- [ ] 4) Copilot review
- [ ] 5) Opus review

## Phase 2 — API routes

**Goal**: REST endpoints for listing and fetching conversations
**Branch**: `conversations-p2`
**Depends on**: Phase 1 PR merged

### Tasks
- [ ] 1) `GET /api/conversations` route
- [ ] 2) `GET /api/conversations/:id` route
- [ ] 3) Run all checks
- [ ] 4) Copilot review
- [ ] 5) Opus review

## Phase 3 — UI components

**Goal**: ChatSidebar browsing conversations
**Branch**: `conversations-p3`
**Depends on**: Phase 2 PR merged

### Tasks
- [ ] 1) ChatSidebar with conversation list
- [ ] 2) ConversationViewer detail pane
- [ ] 3) Run all checks
- [ ] 4) Copilot review
- [ ] 5) Opus review
```

## PR body: closing keywords (single-phase vs multi-phase)

GitHub auto-closes a linked issue when a merged PR's body contains a [closing
keyword](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword)
followed by `#<issue>` — `Closes #N`, `Fixes #N`, `Resolves #N`, and their
variants (`Closed`, `Closing`, `Fixed`, `Fixing`, `Resolved`, `Resolving`).
This is the right default for **single-phase** issues, but a foot-gun for
**multi-phase** issues: Phase 1's PR would prematurely close the parent even
though Phases 2…N are still pending.

Per [D-037](decisions/D-037-multi-phase-no-auto-close.md), the rule is:

| PR for… | Use in body | Use NOT |
|---------|-------------|---------|
| Single-phase issue (default) | `Closes #N` | `Part of #N` (wastes the auto-close) |
| Multi-phase issue, Phase N < TOTAL_PHASES | `Part of #N (Phase X of Y)` | **NEVER** `Closes #N` / `Fixes #N` / `Resolves #N` |
| Multi-phase issue, final phase, **all `**EC-` items ticked with evidence** | `Closes #N` | — |
| Multi-phase issue, final phase, **any `**EC-` item unticked** | `Part of #N (Final phase — EC pending)` | **NEVER** `Closes #N` |

**Examples**

✅ Correct — Phase 2 of a 4-phase issue:

```markdown
## Summary
- Adds the structured conversation-history reader.
- ...

Part of #720 (Phase 2 of 4)
```

✅ Correct — final phase, all EC verified:

```markdown
## Summary
- Adds the 8 memory tools and tag-wraps results.
- All 12 EC items ticked in the issue body with linked test runs.

Closes #720
```

❌ Wrong — Phase 1 of a 4-phase issue (this is the #720 → PR #730 failure mode):

```markdown
## Summary
- Phase 1 ships the llm-context module.

Closes #720
```

This is enforced by three layers ([D-037](decisions/D-037-multi-phase-no-auto-close.md)):

1. **Worker self-check** — the AI worker's pre-`gh pr create` shell guard
   refuses to create a PR whose body contains a forbidden closing keyword.
2. **Pre-merge CI gate** — `ai-multi-phase-guard.yml` fails the build on
   any PR that violates the table above. Required check — blocks merge.
3. **Post-merge reopen** — `ai-post-merge-verify.yml` reopens the issue
   with `fact-parent-incomplete` if a PR slipped through and the parent has
   unverified EC items.

Human contributors who create PRs against multi-phase issues should follow the
same rule; the CI gate applies uniformly to AI and human PRs.

## Branch naming — REQUIRED for the AI factory

The AI worker enforces branch names via `branch_prefix: "ai/issue-NNN-"` in the workflow. **All implementation branches must follow this pattern:**

```
ai/issue-<NUMBER>-<short-slug>
```

Examples:
- `ai/issue-702-thinking-scroll`
- `ai/issue-702-p1` (for phase 1 of a multi-phase issue)

**Why this matters**: The "Verify PR was created" step searches for `head:ai/issue-NNN-*`. A branch with any other prefix (e.g. `conv-ui-tweaks-p1`, `claude/`, `fix/`) causes the verify step to report "no PR created" even when the branch and PR exist, which falsely marks the issue `ai-blocked`.

The `branch_prefix` is set at the workflow level in `ai-worker.yml` — the agent cannot override it. Human contributors should also follow this pattern when creating branches for factory-tracked issues.

## Worktree workflow

Each issue specifies a **worktree name**. Before starting work:
```bash
git worktree add ../<repo>-<worktree-name> -b ai/issue-<NUMBER>-<worktree-name>
cd ../<repo>-<worktree-name>
```
Work in the worktree. When done, PR is merged and worktree is removed:
```bash
git worktree remove ../<repo>-<worktree-name>
```

## PR and review policy

Every PR gets **exactly two review rounds, in order, each run only once**:

1. **One Copilot review** (bot).
2. **One Opus review**, started from a **clean context** (fresh Claude Code session with no prior history about this PR or its implementation).

After each round: address every comment with either a code change or an inline reply, then move on. **Do not re-request the same reviewer.** Iterating "until there are no comments" is no longer the policy — it was too much. If a later round surfaces a genuinely blocking issue, use judgement and escalate to the human owner rather than looping. See [D-021](decisions/D-021-two-review-rounds.md).

Once both rounds are complete and `ai-awaiting-owner` is applied, the **pre-merge digest** agent fires automatically (`ai-pre-merge-digest.yml`). It posts one comment summarising both review rounds — a recommendation (merge / hold / discuss), a reviewer table with themes, and bulleted addressed/open lists — so the owner can make a merge decision without reading each thread individually. Skipped if the PR carries `no-ai` or `no-pr-review`.

Rules:
- Every piece of work goes through a PR, even solo work.
- **Round 1 — Copilot.** Request via the REST API:
  ```bash
  gh api repos/{owner}/{repo}/pulls/{PR#}/requested_reviewers \
    --method POST -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
  ```
  Do NOT use `gh pr review --request copilot` (doesn't work) or `gh pr edit --add-reviewer copilot` (can't resolve bot users). The REST API with `copilot-pull-request-reviewer[bot]` is the only working CLI method.
  - **From GitHub Actions**, the default `GITHUB_TOKEN` **cannot** assign `copilot-pull-request-reviewer[bot]` — the API returns 200 but with an empty `requested_reviewers` array. Workflows must use a PAT stored in the repo secret `COPILOT_PAT` (fine-grained PAT, scope `Pull requests: Read and write`). Pattern:
    ```bash
    GH_TOKEN="$COPILOT_PAT" gh api repos/{owner}/{repo}/pulls/{PR#}/requested_reviewers \
      --method POST -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
    ```
    Always verify the response contains `Copilot` in `requested_reviewers` before claiming the review was requested.
  - Poll for the review: `gh api repos/{owner}/{repo}/pulls/{PR#}/reviews --jq '[.[] | {state, user: .user.login, body}]'`.
  - Address every comment with a code change or inline reply. **One round only — do not re-request Copilot.**
- **Round 2 — Opus, clean context.** Start a new Claude Code session (no prior conversation about this PR or the branch) and run the PR review flow on this PR number. Reply inline to every comment; apply the correct fixes. **One round only — do not re-request Opus.**
- **Merge** after both rounds are done and every comment has a change or a reply. Unresolved disagreement → flag to the human owner; don't start a third round to paper over it.

## Phase execution order

Phases live as `## Phase N — <name>` headings **inside the issue body**. They are not labels.

**Execution rules:**
- Phase 1 starts when `ai-work` is added to the issue.
- The implementer finds the next un-merged phase (checks whether each phase's branch has a merged PR via `gh pr list --search "head:<branch>" --state merged`).
- Phase N+1 starts only after Phase N's PR is **merged and `main` is green**.
- **Auto-kickoff**: when a phase PR (branch `ai/issue-<N>-p<K>`) merges and the issue still has unmerged phases, `ai-post-merge-verify.yml` auto-adds `ai-work` to the issue, triggering Phase K+1. The owner does not need to re-label per phase. The auto-kick is skipped if the issue has `no-ai`, `needs-human-approval`, `fact-parent-incomplete`, `ai-blocked`, `ai-work`, or `fact-in-progress`. Final-phase PRs (`Closes #N`) never kick.
- To pause between phases, add `ai-blocked` after merging Phase K — auto-kickoff respects it.

**Single phase** (default): issue has one `## Phase 1` block. The implementer walks its `### Tasks` checklist, commits per task, ticks checkboxes via `gh issue edit --body`, opens one PR.

**Multiple phases**: each phase is a separate PR. The implementer opens the phase's PR, sets `fact-ready-for-review`, and stops. The next phase begins only after the owner merges the previous PR.

**Resumability**: if the implementer times out or fails mid-phase, the checkboxes in the issue body record progress. Re-adding `ai-work` resumes at the first unchecked task.

**`ai-decompose` escape hatch**: if the issue carries the `ai-decompose` label, the planner falls back to the legacy parent → sub-issues model (creates one sub-issue per task, each with `fact-task` + `ai-work`). Reserve this for genuinely huge work where parallel execution across multiple people matters.

## Planner phasing rules (mandatory for all decompositions)

These rules apply to **every** planning session — whether the planner produces phases-in-body (default) or sub-issues (when `ai-decompose` is present).

### Default path: phases-in-body

The planner edits the issue body in place to add or refine `## Phase N` headings and `### Tasks` checklists. Default = **one phase**. Split into multiple phases only when:

1. **Size**: the estimated single PR would exceed ~2000 LOC, OR
2. **Producer/consumer dependency**: task group A defines a shape or contract that group B reads (classic chain: DB schema → API routes → UI components). B cannot correctly implement against an unmerged A, OR
3. **DDL conflict**: two task groups touch DDL on the same table or write heavily to the same critical shared file (`etl/main.py`, `dashboard/lib/knowledge.ts`).

When **none** of the above apply, keep everything in a single phase.

Include a dependency table in the `## Plan` section when splitting:

| Phase | Task groups | Files | Reason for split |
|-------|-------------|-------|-----------------|
| 1 | Data layer | `etl/schema/init.sql`, `lib/types.ts` | Sets contract all others read |
| 2 | API routes | `app/api/**/*.ts` | Needs Phase 1 types; can't merge concurrently |
| 3 | UI | `components/**/*.tsx` | Needs Phase 2 shapes |

### Legacy path: sub-issues (only when `ai-decompose` is present)

When `ai-decompose` is on the issue, the planner creates one GitHub sub-issue per task group. Sub-issues carry `fact-task` + `ai-work`. Apply the original Q1–Q3 phasing rules below to batch them into phases.

#### Q1 — When to produce phases (trigger conditions)

Phases are **mandatory** when any two sub-issues share any of the following:

1. **Shared source file** — the same path appears in the `Files:` section of two sub-issues.
2. **Shared DB table** — any two sub-issues `CREATE`, `ALTER`, or heavily write to the same table.
3. **Shared HTTP route family** — any two sub-issues add or modify routes under the same prefix.
4. **Producer/consumer dependency** — one sub-issue defines a shape that another reads.

When **none** of the above apply, sub-issues may run in parallel.

#### Q2 — Serialisation unit

**Phase = a batch of sub-issues that share no files, tables, or contracts.** Within a phase, sub-issues run concurrently. Between phases: all PRs from phase N must be **merged and `main` must be green** before any phase N+1 sub-issue receives `ai-work`.

Phase N+1 sub-issues are created with `fact-task` but **without** `ai-work`. The owner adds `ai-work` once all phase N PRs are merged.

#### Q3 — Enforcement rule for the planner

After listing sub-issues, the planner must:

1. For each pair (A, B) assigned to the same phase: check all four Q1 conditions.
2. If **any** is true: move B to the next phase; document the reason in the plan comment.
3. Include a **dependency table** in the plan comment showing which sub-issues are in each phase and the reason for any serialisation.

## Label conventions

Labels split into two groups with different visual treatment and different owners.

### Owner-facing labels (the only ones the owner adds or removes)

The owner acts on these. They are coloured and visible.

| Label | Purpose |
|-------|---------|
| `ai-work` | Trigger: start autonomous implementation |
| `ai-plan` | Trigger: run planner only — refines issue body, no implementation |
| `ai-decompose` | Opt-in: use legacy parent → sub-issues model for this issue |
| `ai-blocked` | The agent couldn't proceed — read the comment, then intervene |
| `ai-awaiting-owner` | Both review rounds done; PR awaits human merge |
| `ai-bug` | AI-discovered bug; owner triages |
| `ai-idea` | AI feature idea; owner triages |
| `ai-factory` | Marks factory-infrastructure issues |
| `agent-efficiency` | Improvement requests for the agent system |
| `no-ai` | Hands off — factory will not touch this issue |
| `no-ai-manager` | Pause the Factory Manager |
| `no-pr-review` | Skip AI PR review on this PR |
| `needs-human-approval` | D-028 gate — business-review issues; factory may not implement until removed |
| `comp-*` | Component classification (`comp-dashboard`, `comp-etl`, etc.) |
| `p0-critical` → `p3-low` | Priority |
| Standard GitHub meta | `bug`, `enhancement`, `question`, etc. |

### Internal `fact-*` state labels (workflows toggle; owner ignores)

These are light grey (`#ededed`). The owner does not add or remove them. They exist so workflow conditionals can track state without cluttering the owner's view.

| Label | Set by | Means |
|-------|--------|-------|
| `fact-task` | planner | This is a sub-issue (legacy `ai-decompose` path) |
| `fact-planned` | planner | Body refined; phases structured; ready for `ai-work` |
| `fact-in-progress` | worker | Implementer is actively running |
| `fact-ready-for-review` | address-feedback | PR ready for the next review pass |
| `fact-phase-copilot` | worker `Handle success` (per #519) | Round 1 (Copilot review) in progress |
| `fact-cp-after-1` | address-feedback | Copilot feedback addressed |
| `fact-phase-opus` | address-feedback | Round 2 (Opus review) in progress |
| `fact-o-after-1` | address-feedback | Opus feedback addressed; cycle done |
| `fact-auto-retry` | worker / address-feedback | Watchdog: retry this (pairs with `ai-blocked`) |
| `fact-ci-failing` | address-feedback / ci-remediation | CI is red; bot may auto-remediate |
| `fact-needs-rewrite` | planner / verify steps | Sub-issue body was mangled; do not act until repaired |
| `fact-parent-incomplete` | Factory Manager Pass 5 | Parent DoD has gaps |
| `fact-parent-verified` | Factory Manager Pass 5 | Parent DoD verified |
| `fact-manager-tracking` | Factory Manager | Marks the Manager's session-report issue |

**Naming rule**: if a workflow toggles a label automatically and the owner never has to act on it, name it `fact-*` and colour it grey `#ededed`.

### Auto-applied per PR (informational; owner reads, never adds)

| Label | Applied by | Meaning |
|-------|-----------|---------|
| `risk-low/medium/high` | `ai-pr-labeler.yml` | Change risk estimate |
| `size-xs/s/m/l/xl` | `ai-pr-labeler.yml` | PR size |
