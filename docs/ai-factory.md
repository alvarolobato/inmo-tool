# AI Factory — User Guide

> The AI Factory is an autonomous development pipeline for PowerShop Analytics. It uses Claude (via GitHub Actions) to discover work, plan implementations, write code, review PRs, and manage deployments. This guide explains **how humans use it**.

## What the AI Factory Does For You

You describe what you want in an issue; the factory implements it, reviews it, and prepares it for deployment. You stay in control through labels, comments, and merge approvals — but you don't write boilerplate, triage bugs, or chase stale PRs.

```
You:   "Add a health check endpoint to the ETL service"   (open an issue)
You:   label it "ai-work"
AI:    triages, plans, creates a branch, implements, opens a PR, runs tests
AI:    reviews the PR, posts inline comments, fixes any CI failures
You:   approve and merge
AI:    weekly auto-release bundles your change into a new version
AI:    Docker images are pushed, production notification issue created
```

Your total effort: **~15 minutes per day** reviewing the daily project summary, labeling issues, and merging PRs.

## Getting Started

### 1. One-time setup

Add these secrets to the repository (`Settings → Secrets and variables → Actions`):

| Secret | Required | Purpose |
|--------|----------|---------|
| `ANTHROPIC_API_KEY` | **Yes** | Powers all AI workflows (Claude Code Action) |
| `DOCKERHUB_USERNAME` | For releases | Pushes Docker images |
| `DOCKERHUB_TOKEN` | For releases | Pushes Docker images |
| `OPENROUTER_API_KEY` | Optional | Used by WrenAI and Dashboard App (existing secret) |

Once `ANTHROPIC_API_KEY` is set, the factory activates automatically. Scheduled workflows start running on their cron, and event-driven workflows respond to issues/PRs/comments.

### 2. Verify it works

Open the **Actions** tab and manually trigger **AI Factory Test** (`workflow_dispatch`). You should see Claude respond within a minute.

## How You Interact With the Factory

Four mechanisms cover 95% of your day-to-day use.

### a) Open an issue

Write what you want. The more specific the issue, the better the result.

**Good issue:**
> **Title**: Add `/api/health` endpoint to dashboard returning ETL sync status
>
> **Body**: Create `dashboard/app/api/health/route.ts` that queries the `watermark` table and returns `{ status: "ok" | "stale", last_sync: timestamp }`. Stale if last_sync > 48 hours old. Include a Vitest test.

**Bad issue:**
> Make the dashboard better

When a new issue is opened, the **Issue Triage** workflow runs automatically — it labels the issue by component, priority, category, and checks for duplicates.

### b) Use labels to steer the AI

| Label | Meaning |
|-------|---------|
| `ai-work` | Start autonomous implementation. The AI Worker picks this up, implements the change, runs tests, and opens a PR. |
| `ai-plan` | Run planner only — refines the issue body in place, sets `fact-planned`, stops. No implementation. Add `ai-work` when ready to implement. |
| `ai-blocked` | The AI hit a blocker and needs human input. Check the issue comments. |
| `ai-decompose` | Opt-in: use the legacy parent → sub-issues model for this issue. Default is single-track phases-in-body. |
| `no-ai` | Human-only. Factory will not touch this issue. |
| `no-pr-review` | Skip the AI PR review on this PR. |
| `p0-critical` → `p3-low` | Priority — the factory processes higher priorities first. |
| `fact-in-progress` | The worker is currently running (auto-set, grey — internal state). |
| `fact-planned` | Planner finished; issue body has `## Phase` headings (auto-set, grey — internal state). |

### c) Use slash commands in comments

Comment on any issue (not PR) with one of these:

**`/plan`** — Claude analyzes the issue, reads the codebase, and posts a structured implementation plan. Use this **before** labeling `ai-work` if you want to review the approach first.

```
/plan
```

Response includes: analysis, files to modify, implementation steps, testing strategy, risk assessment, complexity estimate.

**`/ai <instruction>`** — Claude executes a direct instruction. Restricted to `OWNER` / `MEMBER` / `COLLABORATOR`.

```
/ai investigate why the ETL fails on Sundays and report back

/ai add retry logic to etl/sync/ventas.py with exponential backoff

/ai research what indexes we're missing on ps_lineas_ventas
```

For code-change instructions, Claude creates a branch and opens a PR. For investigation instructions, Claude posts findings as an issue comment.

### d) Review and merge PRs

When the AI opens a PR:

1. The **Claude PR Review** workflow runs automatically and posts a review (inline comments + approval or changes-requested).
2. CI runs (lint, tests, build) — same as any other PR.
3. If you request changes, the **Address PR Feedback** workflow attempts to auto-fix simple comments (typos, imports, lint, small logic fixes). Complex feedback gets a reply explaining why it's being skipped.
4. When you're happy, you merge. Auto-merge for trusted categories is disabled initially; you always click the button.

## The Daily Project Summary

Every weekday at 09:00 UTC, the factory creates a **Project Summary** issue titled `[project-summary] Project Summary — {date}`. It's your morning dashboard.

It includes:
- **Open PRs** with CI/review status
- **Merged yesterday** — what shipped
- **AI activity** — in-progress and blocked issues
- **Stale items** — PRs and issues needing attention
- **Easy pickings** — well-defined issues ready for `ai-work`
- **Health** — latest release, CI status

The previous day's summary is closed automatically. Read this, label a few issues `ai-work`, close anything resolved, and you're done.

## What Runs and When

### Event-driven (reacts immediately)

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| **Issue Triage** | Issue opened | Labels component/priority/category, checks for duplicates |
| **Plan** | `/plan` comment OR `ai-plan` label | Refines issue body in place, posts plan comment, sets `fact-planned`. No implementation. |
| **AI Command** | `/ai` comment | Executes direct instruction |
| **AI Worker** | `ai-work` label added | Planner (if needed) then implementer: walks phase checklist, ticks checkboxes, opens one PR per phase |
| **PR Review** | PR opened/updated | Posts AI code review |
| **Address Feedback** | Review with changes-requested | Auto-fixes simple comments |
| **PR Labeler** | PR opened/updated | Adds `size-*` and `risk-*` labels |
| **Deploy Notify** | Release published | Creates deployment checklist issue |

### Scheduled (runs on cron)

| Workflow | Schedule | What it does |
|----------|----------|-------------|
| **Project Summary** | Weekdays 09:00 | Daily digest (your morning briefing) |
| **ETL Health Monitor** | Weekdays 08:00 | Checks ETL code/schema/sync for issues |
| **Bug Hunter** | Weekdays 11:00 | Scans recently changed files for bugs |
| **SQL Pair Validator** | Monday 10:00 | Validates WrenAI SQL pairs against schema |
| **Docs Patrol** | Tuesday 14:00 | Checks docs are accurate and current |
| **Dashboard Audit** | Wednesday 14:00 | Builds + tests dashboard, reviews quality |
| **Feature Ideas** | Thursday 14:00 | Brainstorms 3-5 actionable ideas |
| **Security Audit** | Friday 10:00 | Dependency + source security scan |
| **Stale Manager** | Friday 16:00 | Closes stale issues/PRs |
| **Auto Release** | Sunday 20:00 | Creates weekly release with changelog |

All scheduled workflows support manual triggering via `workflow_dispatch`. All follow the **"silence is golden"** principle — they only create issues when they find something genuinely worth reporting.

Two workflows remain disabled (`ai-docs-patrol.yml.disabled`, `ai-security-audit.yml.disabled`). See [disabled-actions-report.md](disabled-actions-report.md) for their cost tier, rationale, and the tier framework to use when evaluating new periodic LLM workflows.

## Lifecycle in detail

> This section traces every state an issue passes through, from creation to merged code. It lists the workflows that drive each transition, the labels that signal state, and — most importantly — every moment a human is expected to step in.
>
> If you only read one thing, read **[Where humans intervene](#where-humans-intervene)** below.

### Mental model — two nested loops (default single-track path)

1. **Issue loop** — a feature request goes from "open" to "all phases merged" via the **planner** (which edits the issue body in place) and the **implementer** (which walks each phase's checklist and opens one PR per phase).
2. **PR loop** — each phase's PR goes from "opened" to "merged" via two automated review passes (Copilot, then Opus, per [D-021](decisions/D-021-two-review-rounds.md)) plus the human merge.

When `ai-decompose` is present, a third loop is active: the **sub-issue loop** — each sub-issue goes from "queued" to "PR opened" via the implementer. The old three-loop model applies.

Failures at any layer route to a recovery path: the failing object gets `ai-blocked` + `fact-auto-retry`, and `ai-watchdog.yml` retries on a schedule (or escalates to the owner if the failure persists).

### Decision tree: which path to use?

```
Add ai-plan first?
├── Yes → owner wants to review the plan before implementation starts.
│          Planner refines body, posts plan comment, sets fact-planned, stops.
│          Owner reviews → if good, add ai-work to implement.
│
└── No → Add ai-work directly.
         ├── Body has ## Phase headings + fact-planned? → Implementer walks Phase 1 tasks.
         └── Body is unstructured / no fact-planned? → Planner runs inline, then continues.

Add ai-decompose?
├── No (default) → single-track: phases in the issue body, one PR per phase.
└── Yes → legacy path: planner creates sub-issues with fact-task + ai-work.
          Reserve for genuinely huge features (> ~5k LOC across non-conflicting files,
          or genuine need for parallel team execution).
```

### State labels at a glance

Only AI-Factory labels are listed. Component / priority / size / risk labels are unrelated to the lifecycle.

Labels split into two groups: **owner-facing** (coloured; human adds/removes) and **`fact-*` internal state** (grey `#ededed`; workflows toggle, owner ignores). See [D-034](decisions/D-034-single-track-issues.md) for the rationale and [docs/issue-format.md § Label conventions](issue-format.md#label-conventions) for the full enumeration.

#### Owner-facing labels

| Label | Set by | On | Means |
|-------|--------|----|-------|
| `ai-work` | 👤 human | issue | "AI: implement this." Trigger for the worker. Removed as soon as a job picks it up. |
| `ai-plan` | 👤 human | issue | "AI: refine the plan only." Planner edits body in place, sets `fact-planned`, stops. |
| `ai-blocked` | worker / address-feedback / watchdog | issue or PR | The agent couldn't proceed. The companion comment explains why. |
| `ai-decompose` | 👤 human | issue | Opt-in: use legacy parent → sub-issues planner. Default single-track path otherwise. |
| `ai-awaiting-owner` | address-feedback | PR | Both reviews complete. Human merge decision pending. |
| `no-ai` | 👤 human | issue or PR | Hands off. The factory will not touch this. |
| `no-pr-review` | 👤 human | PR | Skip the AI PR review on this PR. |

#### `fact-*` internal state labels (grey `#ededed` — workflows toggle, owner ignores)

> *Migration note*: these labels were renamed from `ai-*` in D-034. References to the old names (`ai-task`, `ai-planned`, `ai-in-progress`, etc.) in workflow YAML and docs will be updated as Phase 2 of #631 is committed.

| Label | Set by | On | Means |
|-------|--------|----|-------|
| `fact-task` | planner | sub-issue | This is a sub-issue of the `ai-decompose` legacy path. |
| `fact-planned` | planner (end of plan job) | parent issue | Body refined; `## Phase` headings added. Ready for `ai-work`. |
| `fact-in-progress` | worker | issue | The worker is actively running. |
| `fact-ready-for-review` | address-feedback | PR | PR ready for the next review pass. |
| `fact-phase-copilot` | worker `Handle success` (per #519) | PR | Round 1 (Copilot review) in progress. |
| `fact-cp-after-1` | address-feedback | PR | Copilot feedback addressed. |
| `fact-phase-opus` | address-feedback | PR | Round 2 (Opus review) in progress. |
| `fact-o-after-1` | address-feedback | PR | Opus feedback addressed; cycle done. |
| `fact-auto-retry` | worker / address-feedback | issue or PR | "Watchdog: retry this." Pairs with `ai-blocked`. |
| `fact-ci-failing` | address-feedback / ci-remediation | PR | CI is red; bot may auto-remediate. |
| `fact-needs-rewrite` | planner / verify steps | sub-issue | Sub-issue body was mangled. Don't act on it until repaired. |
| `fact-parent-incomplete` | Factory Manager Pass 5 | parent issue | Parent DoD has gaps. |
| `fact-parent-verified` | Factory Manager Pass 5 | parent issue | Parent DoD verified. |
| `fact-manager-tracking` | Factory Manager | issue | Marks the Manager's session-report issue. |

### Phase 1 — Issue → Plan

```mermaid
flowchart TD
    A([Issue created]) --> B{Source}
    B -->|"👤 Human writes issue"| C[Auto-triage workflow:<br/>component / priority / category labels<br/>+ duplicate check + format check]
    B -->|"Discovery agent<br/>(bug-hunter, feature-ideas,<br/>ETL health, dashboard audit, …)"| C
    C --> D[Issue in backlog<br/>no ai-work yet]

    D -->|"👤 Human adds <code>ai-plan</code>"| EP[ai-plan.yml or ai-worker.yml: plan job]
    D -->|"👤 Human adds <code>ai-work</code>"| E[ai-worker.yml: plan job triggers]

    EP --> F1["Plan-only job<br/>• edit issue body in place<br/>• refine ## Context, add ## Plan<br/>• structure ## Phase N headings + ### Tasks<br/>• post short analysis comment<br/>• set fact-planned<br/>• STOP (no implementation)"]
    F1 --> G1["👤 Human reviews refined body<br/>→ adds ai-work when satisfied"]
    G1 --> E

    E --> F["Plan + implement job<br/>• if fact-planned absent: refine body inline<br/>  (same as ai-plan), set fact-planned<br/>• then: walk Phase 1 ### Tasks checklist<br/>• tick checkboxes as tasks complete<br/>• commit per task, open ONE PR<br/>• OR: if ai-decompose present,<br/>  fall through to legacy sub-issue planner"]

    F --> G{Plan + Phase 1 succeeded?}
    G -->|Yes| H[Issue: fact-in-progress → PR opened<br/>PR enters review cycle]
    G -->|"Too vague / blocked"| I[Issue: ai-blocked + fact-auto-retry<br/>Comment tags @owner]

    I -->|"👤 owner clarifies,<br/>removes ai-blocked, re-adds ai-work"| E
```

**Walkthrough**

1. Issue is created — by a human, or by a discovery agent on a cron. The triage workflow runs first and applies component / priority / category labels.
2. The issue sits in the backlog until a **human** explicitly adds `ai-plan` or `ai-work`. Issues from the **business-review** workflow carry `needs-human-approval` and never get `ai-work` until the owner approves — see [D-028](decisions/D-028-weekly-business-review.md).
3. **`ai-plan` path**: the planner edits the issue body in place — adds `## Plan`, structures `## Phase N — <name>` headings with `### Tasks` checklists, posts a short analysis comment, sets `fact-planned`. It stops without creating sub-issues or implementing anything. The owner reviews the refined body and adds `ai-work` when ready.
4. **`ai-work` path (body already structured)**: if `fact-planned` is set and the body has `## Phase` headings, the implementer skips planning and walks Phase 1's `### Tasks` checklist directly.
5. **`ai-work` path (body unstructured)**: if `fact-planned` is absent, the planner runs inline (same body-edit as the `ai-plan` path, sets `fact-planned`) and then continues immediately to implementation.
6. **`ai-decompose` path**: if the issue carries `ai-decompose`, the planner falls back to the legacy model: creates one GitHub sub-issue per task group, each with `fact-task` + `ai-work`. The sub-issue loop (see below) handles the rest.
7. If the planner can't proceed (issue too vague, missing context), it tags the human owner in a comment and labels the issue `ai-blocked + fact-auto-retry`. The watchdog will retry on a schedule, or the human can intervene.

**Human checkpoints in Phase 1**

| When | What you do | Why |
|------|-------------|-----|
| Issue created by a discovery agent | Skim it; close or label `no-ai` if it's noise | Prevent the factory from chasing low-value work |
| Issue is well-scoped, you trust the planner | Add `ai-work` directly | Greenlight the planner + implementer end-to-end |
| Issue is ambiguous, you want to review the approach first | Add `ai-plan` first; review the refined body; then add `ai-work` | Cheap checkpoint before implementation starts |
| Issue landed on `ai-blocked` | Read the planner's blocking comment, edit the issue with answers, remove `ai-blocked`, re-add `ai-work` | The planner needs human input |

### Phase 2 — Implementation → PR (single-track path)

```mermaid
flowchart TD
    S([Issue: fact-planned<br/>## Phase N headings present]) --> I[ai-worker.yml: implement job]

    I --> P["Implement job<br/>• find next un-merged ## Phase N<br/>• read its ### Tasks checklist<br/>• for each unchecked task:<br/>  implement → tick checkbox → next<br/>• commit all changes<br/>• open ONE PR for this phase"]

    P --> SC{Existing PR<br/>covers this phase?}
    SC -->|"Yes"| CL([Skip — idempotency guard<br/>'♻️ re-ran' comment])
    SC -->|"No"| CO[Branch + code + tests + commit + push]

    CO --> V{Verify PR was created}
    V -->|"PR found"| ID{Idempotency guard #519:<br/>PR already in review cycle?}
    V -->|"Neither"| BL[ai-blocked + fact-auto-retry<br/>Watchdog will retry]

    ID -->|"Yes — review-cycle labels present"| RR([Skip Copilot request<br/>'♻️ re-ran' comment])
    ID -->|"No — fresh PR"| HS["Handle success:<br/>• fact-phase-copilot<br/>• POST requested_reviewers Copilot"]

    HS --> RV([PR enters review cycle — see Phase 3])
    BL -->|"watchdog re-adds ai-work"| I
```

**Walkthrough**

1. The implement agent finds the first `## Phase N` heading whose branch does not have a merged PR (checked via `gh pr list --search "head:<branch>" --state merged`).
2. It walks the `### Tasks` checklist for that phase sequentially. For each unchecked task: implement, tick the checkbox in the issue body via `gh issue edit --body`, move to the next.
3. After all tasks are ticked: commit, push, open **one PR** for the phase. Title: `<feature> (Phase N: <phase name>)`.
4. **Resumability**: if the implementer times out or fails mid-phase, the checkbox state in the issue body records progress. Re-adding `ai-work` resumes at the first unchecked task. The watchdog detects `fact-in-progress` + stalled branch and re-fires `ai-work` automatically.
5. **Idempotency guard** (per #519): before adding `fact-phase-copilot` and POSTing `requested_reviewers`, check the PR's labels for any of `fact-phase-copilot` / `fact-phase-opus` / `fact-cp-after-1` / `fact-o-after-1`, and check the reviews list for an existing Copilot review. If any are present, skip the Copilot request and post a `♻️ re-ran` comment.
6. Fresh PR: add `fact-phase-copilot`, POST `requested_reviewers` for Copilot. PR enters Phase 3.

**Multi-phase progression**: after Phase N's PR is merged, the owner adds `ai-work` again (or the watchdog re-triggers). The implementer finds Phase N+1 and repeats.

**Concurrency safety** (#518): both the plan and implement jobs declare job-level `concurrency: { group: ai-worker-{plan,implement}-<issue>, cancel-in-progress: true }`. A new run on the same issue cancels the previous run.

**Human checkpoints in Phase 2**

| When | What you do | Why |
|------|-------------|-----|
| Phase 1 PR merged; you want Phase 2 to start | Add `ai-work` to the issue | The factory waits for explicit trigger between phases |
| Issue stalled with `ai-blocked` after multiple watchdog retries | Read the comment, decide: provide more context (re-add `ai-work`), or label `no-ai` | The watchdog retries until you intervene |

### Phase 2 (legacy) — Sub-issue → Implementation → PR (ai-decompose path)

When `ai-decompose` is present, the planner creates sub-issues with `fact-task` + `ai-work`. The implement job fires on each sub-issue.

```mermaid
flowchart TD
    S([Sub-issue created<br/>with fact-task + ai-work]) --> I[ai-worker.yml: implement job triggers]

    I --> P["Implement job<br/>• remove ai-work, add fact-in-progress<br/>• read sub-issue body + acceptance criteria<br/>• read parent body + ALL comments (#517)<br/>• run sibling-PR pre-flight check"]

    P --> SC{Existing PR<br/>covers this work?}
    SC -->|"Yes"| CL([Close sub-issue<br/>'covered by PR #X'])
    SC -->|"No"| CO[Branch + code + tests + commit + push]

    CO --> V{Verify PR was created}
    V -->|"PR found"| ID{Idempotency guard #519:<br/>PR already in review cycle?}
    V -->|"Issue closed by worker"| EX([Exit: deliberate no-op])
    V -->|"Neither"| BL[ai-blocked + fact-auto-retry<br/>Watchdog will retry]

    ID -->|"Yes — review-cycle labels present"| RR([Skip Copilot request<br/>'♻️ re-ran' comment])
    ID -->|"No — fresh PR"| HS["Handle success:<br/>• fact-phase-copilot<br/>• POST requested_reviewers Copilot"]

    HS --> RV([PR enters review cycle — see Phase 3])
    BL -->|"watchdog re-adds ai-work"| I
```

**Walkthrough** (legacy path)

1. The sub-issue carries both `fact-task` and `ai-work`. The implement job fires.
2. The implement agent reads the sub-issue, **then the parent** (body + comments — architectural rationale lives there, per #517).
3. **Sibling-PR pre-flight check**: if any sibling sub-issue already has a PR that covers the same work, the agent closes this sub-issue with a "covered by PR #X" comment.
4. Otherwise: branch, code, test, commit, push, open PR with the correct closing-keyword form per [D-037](decisions/D-037-multi-phase-no-auto-close.md) — `Closes #<N>` for single-phase issues; `Part of #<N> (Phase X of Y)` for any non-final phase or a final phase with unverified EC items.
5. Idempotency guard and Copilot request same as single-track path.

**Human checkpoints (legacy path)**

| When | What you do | Why |
|------|-------------|-----|
| Sub-issue body looks mangled (empty backticks, missing JSX) | Add `fact-needs-rewrite`, fix the body, remove the label | The planner sometimes drops JSX/generics; verify steps catch most cases but not all |
| Sub-issue stalled with `ai-blocked` after multiple watchdog retries | Read the comment, decide: provide more context, close, or label `no-ai` | The watchdog retries until you intervene |
| Implementer closes a sub-issue with "covered by PR #X" | Verify the claim (rare false positive), reopen if wrong | False positives can leave work undone |

### Phase 3 — PR → Reviews → Merge

```mermaid
flowchart LR
    PR([PR created<br/>fact-phase-copilot<br/>Copilot requested]) -->|"Copilot reviews"| CR[Copilot review on PR]

    CR -->|"address-feedback fires"| AF1[Address Copilot feedback:<br/>• reply to every thread<br/>• fix code, push<br/>• replies prove every comment was read]

    AF1 --> CP1[fact-cp-after-1<br/>Remove fact-phase-copilot<br/>Add fact-phase-opus<br/>Dispatch ai-pr-review.yml]

    CP1 -->|"Opus reviews — does NOT<br/>request Copilot (#519)"| OR[Opus review on PR]

    OR -->|"address-feedback fires"| AF2[Address Opus feedback]

    AF2 --> OP1[fact-o-after-1<br/>Remove fact-phase-opus<br/>Clear fact-ready-for-review<br/>Add ai-awaiting-owner]

    OP1 -->|"👤 Human reviews + merges"| MR([Merged ✅<br/>Single-phase: closes via 'Closes #N'<br/>Multi-phase: 'Part of #N' per D-037])
```

**Walkthrough**

1. **Round 1 — Copilot.** The worker's `Handle success` step requested Copilot when the PR was created. Copilot reviews and posts inline comments. The `address-feedback` workflow detects the new review, dispatches the agent, who replies to every comment (with a code change or an inline reply explaining why it doesn't apply), pushes, and transitions labels: add `fact-cp-after-1`, remove `fact-phase-copilot`, add `fact-phase-opus`. Dispatch `ai-pr-review.yml` for the Opus pass.
2. **Round 2 — Opus.** `ai-pr-review.yml` runs the Opus review **with no prior conversation context** (a fresh Claude Code session, per D-021), so the review is independent of the implementation history. Opus posts a review with inline comments. **Per #519, the Opus prompt explicitly does NOT request another Copilot review** — `requested_reviewers` is never POSTed from this step. Address-feedback fires again, addresses the Opus comments, lands `fact-o-after-1`.
3. **Convergence.** Both `fact-cp-after-1` and `fact-o-after-1` are on the PR. Address-feedback removes the phase labels, clears `fact-ready-for-review`, adds `ai-awaiting-owner`. The PR is now waiting for a human merge.
4. **Pre-merge digest.** `ai-pre-merge-digest.yml` fires when `ai-awaiting-owner` is applied. Within ~3 minutes it posts one structured comment summarising both review rounds: a recommendation (merge/hold/discuss), a reviewer table with themes and resolved/open thread counts, and bulleted addressed/open lists. Idempotent per head-SHA — a force-push triggers one new digest; a re-fire on the same SHA is a no-op. If the PR carries `no-ai` or `no-pr-review`, the digest is skipped. See [`.github/ai-factory/prompts/pre-merge-digest.md`](.github/ai-factory/prompts/pre-merge-digest.md) for the agent prompt.
5. **Human merge.** The owner reviews the PR (the AI's review history and the digest comment are both inline), checks CI is green, clicks **Merge**. The PR's `Closes #<issue>` body trailer closes the issue (or sub-issue). When all phases of a parent issue are merged, the owner closes the parent.
6. **EC validation (final-phase merges).** When a final-phase PR merges, `ai-post-merge-verify.yml` dispatches `ai-ec-validator.yml` for the linked issue. The validator runs `parse-ec.sh` + `verify-ec.sh` to check each `**EC-N**` item deterministically, posts a single structured comment with `[✅ verified]`, `[⏳ human-only]`, or `[✗ failed]` markers, ticks verified items in the issue body, and either closes the issue (if zero EC items remain unchecked) or labels it `fact-awaiting-human-validation` (if any human-only items remain). The owner manually ticks human-only items and can re-trigger the validator by adding `ai-validate-ec`. See [D-038](decisions/D-038-llm-ec-validation.md) and [`.github/ai-factory/prompts/ec-validator.md`](.github/ai-factory/prompts/ec-validator.md).

**Why exactly two reviews and not more** — per [D-021](decisions/D-021-two-review-rounds.md), iterating "until there are no comments" produced long loops where late nit-pick rounds blocked merges without meaningfully improving the code. Two independent reviews each run once is the cap. Genuinely blocking issues from a later round are escalated to the human owner rather than triggering a third round.

**Human checkpoints in Phase 3**

| When | What you do | Why |
|------|-------------|-----|
| PR landed `ai-awaiting-owner` | Read the **pre-merge digest comment** (posted automatically within ~3 min); the digest summarises both review rounds and gives a merge recommendation | Fastest path to a merge decision — all review context in one place |
| Digest says "⏸ hold" or "💬 discuss" | Check the "Open / unresolved" bullets in the digest; decide whether to address or merge anyway | The digest is advisory; you always have the final call |
| You disagree with Copilot or Opus | Comment on the PR; or merge anyway after reading both reviews | The factory respects human override |
| CI is red on a PR (`fact-ci-failing` label) | Wait for `ai-ci-remediation` to attempt a fix; if it can't, the PR ends up `ai-blocked` and you debug | Most CI failures are auto-fixable; the rest need a human |
| You want to skip automated review on a PR | Add `no-pr-review` before review fires | E.g. WIP PR that shouldn't burn budget |
| You want to stop the cycle on a PR | Close the PR | Always allowed |
| A merge conflict appears | `ai-pr-mergeability.yml` attempts to resolve it; otherwise comment, the agent (or you) rebases | Most conflicts are mechanical |

### Watchdog vs Manager — division of labour

The AI Factory's recovery and oversight layer has two tiers with distinct responsibilities:

**Watchdog** (`ai-watchdog.yml`, cadence: every 30 min + on PR review and PR close events — landed per D-030): fast, stateless, rule-per-object. Each of its 12 steps applies a deterministic if/then rule to a single issue or PR. No LLM involved — just `gh` CLI queries and label/dispatch operations. Designed to recover transient failures within minutes.

> **Schedule queue saturation (D-030):** The watchdog was originally configured `*/15 * * * *` but in practice fired every 3–4 hours — roughly 1/8 of the intended cadence. GitHub silently drops scheduled runs when a repo's cron queue is saturated; with 9+ active cron workflows competing for dispatch slots, the 15-min cadence was being observed as 3–4 hours. The cron was bumped to `*/30` (halving schedule pressure) and two event triggers were added — `pull_request_review: [submitted]` and `pull_request: [closed]` — so the `fact-phase-opus` transition fires within seconds of Opus submitting a review, and label cleanup runs immediately on PR close. The `fact-ci-failing` clearance rule benefits primarily from the shorter cron cadence rather than from these specific event triggers. See [D-030](decisions/D-030-watchdog-cadence.md).

**Factory Manager** (`ai-factory-manager.yml`, every 4 h): slow, stateful (reads full context across all objects), LLM reasoning (Opus) over the aggregate factory state. Handles what the watchdog structurally cannot: cross-PR patterns, strategic triage, stale/superseded issue cleanup, and enhancement proposals.

The two tiers complement, not compete: the watchdog handles per-object stalls fast; the manager handles patterns and strategic reasoning that require cross-system awareness. The manager never duplicates watchdog work — it operates at a different time horizon and a different unit of analysis.

| Watchdog step | Stays in watchdog | Reason |
|---|:---:|---|
| Stuck `ai-work` issues (labeled but no worker run ever fired) | ✅ | Time-sensitive (≤ 30 min via cron) — rule is cheap |
| Stuck `fact-in-progress` issues | ✅ | Same |
| Issues with `fact-in-progress` + stalled branch + unchecked tasks remaining | ✅ | Resumability rule: re-fire `ai-work` |
| Sub-tasks with `fact-task` but no PR, no progress | ✅ | Rule-based threshold (legacy ai-decompose path) |
| Re-enable auto-retry for exhausted `fact-task` issues | ✅ | Rule-based; no judgement needed |
| Stalled `fact-ready-for-review` PRs | ✅ | Rule-based |
| Open PRs with no AI PR Review run (cancelled/dropped) | ✅ | Rule-based |
| Open PRs with unaddressed reviewer feedback | ✅ | Rule-based |
| Stuck `fact-phase-opus` PRs (Opus reviewed but address-feedback didn't transition) | ✅ | Rule-based |
| Auto-retry blocked PRs (address-feedback failures) | ✅ | Rule-based retry |
| Auto-retry transient failures | ✅ | Rule-based retry |
| Clear `fact-ci-failing` when CI is green | ✅ | Rule-based |
| Bot-triggered runs gated as `action_required` | ✅ | Rule-based (needs GH investigation) |

All 12 steps stay in the watchdog. The manager's job is **not** to replace these, but to handle what the watchdog structurally cannot:

- **Cross-PR patterns** — e.g. "3 PRs failed with the same coverage gate" is a meta-pattern, not a per-PR bug; the manager files a spec issue for a new watchdog rule.
- **Strategic triage** — is this issue stale? superseded? does its scope still match the parent intent?
- **Drift detection** — a sub-task's implementation diverging from the parent's architecture decisions mid-flight.
- **Enhancement proposals** — recurring failures → file a spec issue (with `ai-factory + agent-efficiency`, never `ai-work`).
- **Stale/superseded cleanup** — close batches of items that the watchdog doesn't examine.

### Phase 4 — Factory Manager

**Mental model**: The Factory Manager is the strategic layer above worker and watchdog. It runs every 4 hours, reads the full state of the factory (every open issue, every open PR, recent workflow runs, and its own prior session history), and takes bounded autonomous actions — closing stale issues, toggling labels, dispatching stuck workflows, filing enhancement proposals. It emits a session report per run. It never replaces the watchdog (which is faster and rule-based) and never merges PRs (which requires a human).

```mermaid
flowchart LR
    CRON([cron every 4h<br/>or workflow_dispatch]) --> KS{Kill-switch check:<br/>no-ai-manager label?}
    KS -->|Yes| EXIT([Exit cleanly — no actions])
    KS -->|No| CTX[Context-build step:<br/>open issues, open PRs,<br/>workflow runs, tracking history]
    CTX --> MGR[Opus Manager:<br/>Pass 1 — Strategic triage<br/>Pass 2 — Cross-cutting patterns<br/>Pass 3 — Boundary check<br/>Pass 4 — Session report]
    MGR --> RPT([Session report comment<br/>on tracking issue])
    MGR -->|failure| FH([Failure handler:<br/>post brief comment,<br/>exit 0])
```

**Pass-by-pass walkthrough**

**Pass 1 — Strategic triage.** Walk every open issue and open PR. Classify each:
- *PROGRESSING* — work is moving; nothing for the manager to do.
- *STUCK (transient)* — fix is obvious and within the boundary allow-list; the manager acts.
- *STUCK (real)* — flag in the session report with a diagnosis for the owner.
- *SUPERSEDED / STALE* — close it with reason and a reference to the superseding issue/PR.
- *NEEDS DECISION* — owner sign-off required; queue a decision-request.

**Pass 2 — Cross-cutting patterns.** Identify patterns that span multiple objects:
- Repeated failure modes (3 PRs failed with the same coverage error → meta-pattern, not a per-PR bug).
- Drift from parent intent (sub-tasks diverging from the parent DoD before all merge).
- Watchdog gaps (states that need a recovery rule but have none).
- Stalled epics (parent issues that haven't progressed in N days).

For each pattern, file an issue with `ai-factory + agent-efficiency`, **never** `ai-work`. The owner tags `ai-work` if they want the next planner cycle to act.

**Pass 3 — Boundary check + decision queue.** Anything the manager considered doing but felt was outside the boundary matrix goes into the "Decisions awaiting owner" section of the session report, with a 1-line summary, exact proposed action, link to evidence, and expected outcome once approved.

**Pass 4 — Session report.** Post a single comment on the tracking issue:

```markdown
## 🏭 Factory Manager — <ISO date>

### Autonomous actions taken
- <action — link + rationale>

### Patterns observed
- <pattern — link to filed issue + 1-line summary>

### Decisions awaiting owner
- [ ] <proposed action, evidence, expected outcome>

### Factory health snapshot
- Open PRs: N (M ready, K stuck, L blocked)
- Open issues: N (M with ai-work, K business-review pending)
- Last 24 h workflow failure rate: P%
- Notable: <one paragraph if anything is unusual>
```

**Boundary matrix**

The manager's actions are explicitly bounded. Anything not in this table defaults to a decision-request.

| Action | Authorized? | Mechanism |
|---|---|---|
| Read any issue / PR / comment / workflow run / file | ✅ Always | `gh` + `git` CLI (read-only) |
| Post comments on issues / PRs (informational, advisory) | ✅ Always | `gh issue comment` / `gh pr comment` |
| Close issues that are objectively resolved (work merged, superseded, demonstrably stale per quantitative rule) | ✅ Logged prominently | `gh issue close --reason completed/not planned` + reasoning in session report |
| Add/remove cosmetic labels (`comp-*`, `size-*`, `risk-*`, `p[0-3]-*`) | ✅ Logged | `gh issue edit` |
| Add/remove state labels (`ai-blocked`, `fact-needs-rewrite`, `ai-stale-base`) | ✅ Logged | Same |
| Toggle `ai-work` to retrigger a stuck issue | ✅ Logged | Same |
| Dispatch any AI Factory workflow with `workflow_dispatch` | ✅ Logged | `gh workflow run` |
| Resolve obvious supersede / dedupe (close one of two duplicates, point one at the other) | ✅ Logged | Comment + close |
| File a new issue proposing a watchdog rule, prompt change, or factory enhancement | ✅ Logged | `gh issue create` (always with `ai-factory + agent-efficiency`, **never** `ai-work`) |
| File a new issue describing a real product bug it noticed | ✅ Logged | `gh issue create` (with `bug` + best-guess `comp-*`, **never** `ai-work`) |
| Add `ai-work` to an existing issue | 🟡 Decision-request | Comment on the target issue tagging `@<owner>` with proposed dispatch; owner adds the label |
| Lower a CI threshold | 🟡 Decision-request | Same |
| Merge any PR | 🛑 Never | Workflow doesn't have `pull-requests: write` for merge, and the prompt forbids it |
| Modify `.github/workflows/*` in a PR | 🛑 Never | Files a spec issue instead; humans tag `ai-work` if accepted |
| Force-push to any branch | 🛑 Never | Permissions deny |
| Override `no-ai` / `needs-human-approval` / `no-ai-manager` | 🛑 Never | Prompt forbids; workflow checks |
| Touch credentials / secrets | 🛑 Never | Workflow runs with minimal `GITHUB_TOKEN` scopes; no repo secrets are referenced; prompt forbids passing credentials to the LLM |
| Close issues marked `needs-human-approval` (D-028) | 🛑 Never | Skipped in the prompt's "stale items" pass |

**Failure mode**: On any error or rate limit, the manager logs partial state in the session report and exits with code 0. The watchdog continues handling per-PR / per-issue stalls independently. The next scheduled run picks up where it left off — idempotency is achieved through marker comments in the session report and label state.

**Kill switch**: Open an issue and add the `no-ai-manager` label to pause the manager immediately. The next run reads the label and exits cleanly without taking any actions.

**Human checkpoints in Phase 4**

| When | What you do | Why |
|------|-------------|-----|
| Session report comment appears on the tracking issue | Skim the "Decisions awaiting owner" section; act on items that need sign-off | This is the manager's primary output — your morning digest for factory health |
| Manager filed an enhancement proposal (`ai-factory + agent-efficiency` issue) | Review the proposal; add `ai-work` if accepted | The manager proposes, you authorize |
| Manager filed a product bug issue | Review the filed issue; add `ai-work` or close if noise | Same boundary: manager files, human acts |
| Manager is taking unwanted autonomous actions | Open an issue, add `no-ai-manager` to pause immediately | Kill switch — effective on the next scheduled run |

### Failure modes & recovery

```mermaid
flowchart TD
    F([Any agent step fails:<br/>plan, implement, address-feedback,<br/>pr-review, ci-remediation]) --> SH[Failure handler:<br/>• remove fact-in-progress<br/>• add ai-blocked + fact-auto-retry<br/>• comment with workflow run link<br/>• detect rate-limit reset time]

    SH --> WD{Watchdog cron<br/>finds the marker?}
    WD -->|"Yes — within retry budget"| RT[ai-watchdog.yml:<br/>• remove ai-blocked + fact-auto-retry<br/>• re-fire the right workflow<br/>  via re-adding ai-work / dispatch]
    WD -->|"Retry budget exhausted /<br/>same error N times"| HD([Watchdog escalates:<br/>tags @owner in comment<br/>removes fact-auto-retry])

    RT -->|"new run cancels any zombie<br/>via job-level concurrency #518"| F
    HD -->|"👤 human investigates"| OW([Human fixes underlying issue<br/>or labels no-ai])
```

Recovery is always **automatic-then-human**: transient failures (rate limits, network blips, GHA flakes) are absorbed by the watchdog. Repeated failures on the same step escalate. The owner intervenes only when automation has given up — not on every flake.

### Phasing rules

When task groups share files, DB tables, API route families, or producer/consumer contracts, running them concurrently risks divergent rewrites of shared code — exactly the pattern that produced the conversations cascade (#536–#540, root-cause analysis in #570).

**Default path (single-track)**: the planner structures tasks into `## Phase N` headings in the issue body. The implementer opens one PR per phase, sequentially. Split into multiple phases when: >2000 LOC, producer/consumer dependency, or same-file DDL conflict.

**Legacy path (`ai-decompose`)**: the planner creates sub-issues with `fact-task`. Apply the Q1–Q3 phasing rules from `docs/issue-format.md` to batch sub-issues into phases. Phase N+1 sub-issues are created with `fact-task` but NOT `ai-work`; the owner adds `ai-work` after Phase N merges.

**Worked example — feature touching `dashboard/lib/conversations.ts`:**

Without phasing (what went wrong):
- Tasks #536–#540 all touched `dashboard/lib/conversations.ts`.
- Each branch compiled and tested cleanly in isolation.
- After all 5 merged to `main`: duplicate exports, broken API shapes, test-coverage collapse, runtime crashes.

With phasing (the correct approach) — in the issue body:
```markdown
## Phase 1 — Data layer
**Branch**: `conversations-p1`
### Tasks
- [ ] Data layer: `dashboard/lib/conversations.ts`, `etl/schema/init.sql`

## Phase 2 — API routes
**Branch**: `conversations-p2`
**Depends on**: Phase 1 PR merged
### Tasks
- [ ] API routes: `dashboard/app/api/conversations/*.ts`

## Phase 3 — UI components
**Branch**: `conversations-p3`
**Depends on**: Phase 2 PR merged
### Tasks
- [ ] ChatSidebar: `dashboard/components/ChatSidebar.tsx`
- [ ] ConversationViewer: `dashboard/components/ConversationViewer.tsx`
```

**The planner's enforcement step** is defined in `docs/issue-format.md § Planner phasing rules`. It checks size, producer/consumer dependency, and DDL conflict before committing to a single-phase structure.

### Integration smoke gate

The parallel-sub-issue pattern was invisible to per-PR CI because each branch was internally consistent. The missing gate is a build + route smoke on `main` **after** each merge.

**What the smoke gate does:**

1. **Build check** (`npm run build --prefix dashboard`) — catches duplicate exports, TypeScript errors, ESLint violations, broken imports. Runs `next build` end-to-end; `webpack` errors on duplicate identifier declarations that only appear when two branches merge.

2. **Route smoke** — starts the Next.js server in production mode and curls a fixed set of routes, asserting HTTP 200 or 302:
   - `/` (home / dashboard list)
   - `/paneles` (dashboard browser)
   - `/conversations` (conversation history)
   - `/inicio` (status home)
   - `/admin/config` (admin panel)

   Pages that crash on render (e.g. `undefined.messages.length`) return HTTP 500 even without a real DB. Curl catches this without needing a browser.

**What it does NOT catch:**

| Regression class | Caught by build? | Caught by curl? |
|-----------------|:----------------:|:---------------:|
| Duplicate export | ✅ | — |
| Broken import / ESLint violation | ✅ | — |
| Server crash on page render | — | ✅ |
| Wrong API response shape | — | — (unit tests) |
| UI rendering correctness | — | — (unit tests) |

Wrong API response shape is caught by keeping existing unit/integration tests green — not by this smoke gate. Playwright / browser automation is explicitly deferred.

**Trigger _(planned — see issue #585)_:** the smoke will run as a `post-merge-smoke` GitHub Actions workflow on every push to `main`. It runs in < 3 minutes. On failure it comments on the most recently merged PR and applies `fact-ci-failing` so the watchdog picks it up. The `fact-ci-failing` label is created as part of the same issue. Until the workflow is committed, the build check and curl smoke can be run manually. See [post-merge-smoke.md](post-merge-smoke.md) for the full spec and manual steps.

### Test-deletion guardrail

The conversations cascade (#570) was worsened by PR #569 deleting `dashboard/lib/__tests__/conversations-api.test.ts` (1,144 lines) as collateral during a rewrite. The deletion was not highlighted in the PR, and the replacement tests asserted the new (broken) contract rather than the original one.

**The guardrail is visibility, not a merge block.**

The Opus reviewer prompt (`.github/ai-factory/prompts/pr-review.md`) instructs Opus to count deleted vs added test lines and, if `deleted > added`, post a highlighted warning and require a `## Test deletion rationale` section in the PR body. If the section is absent, Opus marks the comment as blocking. See the prompt file for the exact wording and distinction between rename/move vs delete-with-no-replacement.

**This is not an automatic merge block.** Legitimate test deletions (removing tests for a deleted feature, replacing a brittle integration test with a better unit test) are valid. The guardrail ensures the deletion is **explicit and visible** to the reviewer, not silent collateral. The final merge decision remains human.

### Where humans intervene

This is the canonical list of human touchpoints across the entire lifecycle. **Outside of these 18, the factory operates autonomously.**

| # | Touchpoint | Action | Frequency |
|---|------------|--------|-----------|
| 1 | New issue is well-scoped | Add `ai-work` | Per issue you want the factory to work on |
| 2 | New issue is ambiguous, want to review plan first | Add `ai-plan` first; review refined body; then add `ai-work` | Per ambiguous issue |
| 3 | New issue is ambiguous, no checkpoint needed | `/plan` comment to preview, clarify body if needed, then add `ai-work` | Per ambiguous issue |
| 4 | Discovery agent created an issue | Skim, close if noise, or label `ai-work` if real | Daily, in the project summary |
| 5 | Issue / sub-issue / PR landed `ai-blocked` and watchdog escalated | Read the comment, fix the underlying problem, remove `ai-blocked` | Rare — watchdog absorbs most blocks |
| 6 | Phase N PR merged; want Phase N+1 to start | Add `ai-work` to the issue | Per phase transition in multi-phase issues |
| 7 | Sub-issue body is mangled (legacy `ai-decompose` path) | Add `fact-needs-rewrite`, repair the body | Very rare; verify steps catch most cases |
| 8 | PR is `ai-awaiting-owner` | Review the PR + the inline AI review history; merge or request changes | Per PR |
| 9 | You disagree with a Copilot or Opus comment | Reply yourself or override at merge | Per disagreement |
| 10 | A workflow is mis-firing (rare bug in the factory) | Open an issue tagged `ai-factory`; if urgent, add `ai-blocked` + `no-ai` to the affected items | Very rare |
| 11 | OAuth token actually expired and the host can't refresh through Cloudflare | Run `ps prod login` (or `claude /login` on the relevant host) | Per token-expiry incident — see [D-025](decisions/D-025-oauth-single-refresher.md) |
| 12 | A `business-review` issue arrives with `needs-human-approval` | Decide whether to authorize: remove `needs-human-approval`, add `ai-work` (or close) | Weekly per [D-028](decisions/D-028-weekly-business-review.md) |
| 13 | You want to fast-merge without review | Add `no-pr-review` before opening, merge yourself | Per exception |
| 14 | Token refresh required across the launchd-synced container | One-time `claude /login` interactively; agent syncs from the keychain | Per token-expiry incident — see [D-025](decisions/D-025-oauth-single-refresher.md) |
| 15 | Manager session report posted on tracking issue | Skim the "Decisions awaiting owner" section; act on items that need sign-off | Every 4 h (or daily digest) |
| 16 | Manager filed an enhancement proposal (`ai-factory + agent-efficiency` issue) | Review the proposal; add `ai-work` if accepted | Per filed issue |
| 17 | Manager filed a product bug issue | Review the filed issue; add `ai-work` or close if noise | Per filed issue |
| 18 | Manager is taking unwanted autonomous actions | Open an issue, add `no-ai-manager` label to pause immediately | As needed |

### Three lifecycles, end to end

#### Best case — everything green

1. Owner opens issue: "Add a `/api/health` endpoint to the dashboard." Adds `ai-work`.
2. Plan job runs (~3 min). Edits the issue body in place — adds `## Phase 1` heading with a 2-task checklist. Sets `fact-planned`.
3. Implementer walks Phase 1's 2 tasks sequentially (~5 min). Ticks both checkboxes. Opens one PR. Requests Copilot.
4. Copilot reviews the PR (~5 min). Address-feedback dispatches Opus.
5. Opus reviews the PR (~5 min). Address-feedback converges to `ai-awaiting-owner`.
6. Owner reviews and merges the PR. Issue closes via `Closes #N` (single-phase issues only — see [D-037](decisions/D-037-multi-phase-no-auto-close.md) for multi-phase rules).
7. **Total wall time: ~18–25 minutes. Owner effort: ~5 minutes** (reading + clicking merge).

#### Recovered failure — transient flake

1. Implement job hits an OpenRouter rate limit at the test step. Workflow detects the rate-limit reset time, posts the failure comment with `⏳ Rate limit reset at HH:MM`, sets `ai-blocked + ai-auto-retry`.
2. Watchdog cron picks up the marker after the reset window. Re-fires the worker.
3. Job-level `cancel-in-progress` ensures any zombie run is killed before the new attempt starts.
4. Second attempt succeeds. PR opens normally. Continues through Phase 3.
5. **Owner effort: zero**. The flake never reached them.

#### Blocked — human intervention required

1. Owner opens issue: "Make the dashboard better." Adds `ai-work`.
2. Plan job reads the issue, can't extract concrete sub-tasks. Tags `@owner`, asks for specific endpoints / behaviour / acceptance criteria. Sets `ai-blocked + ai-auto-retry`.
3. Watchdog retries. Same outcome — issue is genuinely too vague.
4. Watchdog escalates: comment tags `@owner` saying "tried 3 times, same blocker, your turn."
5. Owner edits the issue with concrete acceptance criteria. Removes `ai-blocked`. Re-adds `ai-work`.
6. Plan job re-runs successfully. Phase 1 → 3 proceeds normally.
7. **Owner effort: 2–5 minutes** to add the missing detail.



## Common Scenarios

### "I want the AI to fix this bug"
1. Open an issue describing the bug with reproduction steps
2. *(Optional)* Comment `/plan` to preview the approach
3. Add label `ai-work`
4. Review the resulting PR, merge when ready

### "I want to investigate something without writing code"
Comment on any issue (or open a new one):
```
/ai check which ps_* tables are missing indexes and report back
```

### "I want to temporarily disable AI on a PR"
Add the `no-pr-review` label.

### "An AI-generated PR has a bug"
Leave a review comment describing the problem. The **Address Feedback** workflow will attempt to fix it. For complex changes, the AI will reply explaining why it can't auto-fix, and you can use `/ai` in the issue to give more specific direction.

### "I want to stop a running AI Worker"
Cancel the workflow run in the Actions tab. The `fact-in-progress` label won't be removed automatically — remove it manually.

### "I don't want the AI touching this issue at all"
Add the `no-ai` label before opening.

### Label migration (one-time)

Renames the 14 internal state labels from `ai-*` to `fact-*`, migrates open issues off obsolete labels, and creates the two new owner-facing labels (`ai-plan`, `ai-decompose`). Run this exactly once, after Phase 2 YAML diffs are committed.

**Required order — the script enforces this and aborts if violated:**

1. **Merge Phase 1 PR** (#663 — docs + agent prompts).
2. **Commit Phase 2 YAML diffs** from Phase 1's PR body into `.github/workflows/`. All 9 workflow files must reference `fact-*` label names before the labels are renamed — if you rename first, live workflows break immediately.
3. **Merge Phase 3 PR** (this PR — migration script).
4. **Dry-run first** — verify the full plan without touching anything:
   ```bash
   bash scripts/migrate-labels.sh --dry-run
   ```
   Review the output: 14 renames, 3 label migrations (with open-issue counts), 4 deletions, 2 creations.
5. **Execute the migration**:
   ```bash
   bash scripts/migrate-labels.sh
   ```
   The script is idempotent — if it fails partway through, re-run and it will skip already-completed steps.
6. **Verify** with `gh label list`:
   ```bash
   gh label list --limit 1000 --json name,color | jq '.[] | select(.name | test("^fact-")) | "\(.name)  #\(.color)"' | sort
   ```
   Expected: 14 `fact-*` labels all with colour `#ededed`. No `ai-task`, `ai-planned`, etc. Labels `dashboard-app`, `deployment`, `documentation`, `phase-2` gone. Labels `ai-plan` and `ai-decompose` present.

To target a different repo:
```bash
bash scripts/migrate-labels.sh --dry-run --repo owner/repo
bash scripts/migrate-labels.sh --repo owner/repo
```

## Troubleshooting

**The AI Worker created a PR but it's wrong.** Close the PR, add more detail to the issue (acceptance criteria, file paths, examples), remove `fact-in-progress`/`ai-blocked`, and re-label `ai-work`.

**A workflow failed with an auth error.** Check that `ANTHROPIC_API_KEY` is set as a repository secret (not environment secret) and hasn't expired.

**The AI keeps making the same mistake.** Update the relevant project documentation (`AGENTS.md`, `docs/skills/*.md`, or `CLAUDE.md`). The Claude Code Action reads these automatically, so fixes there propagate to every workflow.

**Too many AI-generated issues cluttering the backlog.** The **Stale Manager** closes AI issues after 21 days of inactivity. You can also use `gh issue list --label "ai-bug" --search "no:assignee"` to triage in bulk.

**Rate limits or cost concerns.** Disable specific scheduled workflows by setting their cron to a future date, or by adding `if: false` to the job. Re-enable when needed.

## Limits and Safety

- **Read-only SQL policy**: Every AI-generated SQL is validated against the project's read-only rule. `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`TRUNCATE` are never allowed against the source ERP.
- **No credentials in code**: The PR Review workflow explicitly checks for leaked secrets.
- **Human-in-the-loop merges**: Every AI-generated PR requires explicit human approval to merge.
- **Author-association gates**: Sensitive workflows (`/ai` command, worker) only respond to `OWNER` / `MEMBER` / `COLLABORATOR`.
- **Fork safety**: `pull_request_target` workflows guard against running untrusted PR code with access to secrets.

## Knowledge bundle for workflows

Seven data-touching workflows consume the centralized data-platform knowledge via the composite action `.github/actions/load-knowledge/`. Each workflow opts into the slices it needs — the full bundle is ~14K tokens, far too much for every workflow to swallow blindly. The composite action wraps the requested marker sections (`## LLM:tables`, `## LLM:relationships`, `## LLM:rules`, `## LLM:sql-pairs`) from each source MD into a `## Data Platform Knowledge` block that gets prepended to the workflow's Claude prompt.

The MD files are the single source of truth shared with the dashboard runtime LLM (compiled into `dashboard/lib/knowledge.ts` via `dashboard/scripts/build-knowledge.ts`). When MDs change, both consumers — dashboard at runtime, workflows at next dispatch — see the change without a compile/release cycle.

| Workflow | Slices | Rationale |
|----------|--------|-----------|
| `ai-sql-validator` | `data-decisions, etl-sync-strategy` | Validator checks SQL pairs against PostgreSQL. Business rules (`total_si` vs `total`, `entrada=true`, `tienda<>'99'`) and field conventions (NUMERIC PKs, `fecha_creacion`) let Claude flag semantic errors, not just syntax. |
| `ai-dashboard-audit` | `data-decisions` | Code-quality review primary. Knowing the table structure helps Claude flag data-model mistakes in generated SQL. Minimal context. |
| `ai-etl-health` | `etl-sync-strategy, architecture-{sales,wholesale,stock}` | Verifies ETL code implements the documented strategy. `etl-sync-strategy` provides delta fields, PKs, sync methods. Architecture slices provide FK relationships and field notes for the most-synced tables. |
| `ai-bug-hunter` | `data-decisions, etl-sync-strategy` | Data-related bugs (wrong field, incorrect JOIN, missing unsigned-to-signed decode, wrong PK type) require knowing what correct behaviour is. These slices define "correct". |
| `ai-feature-ideas` | `data-decisions, architecture-{sales,wholesale,stock}` | Ideas should be grounded in what data is actually available. Architecture slices describe table relationships and existing columns so Claude proposes ideas that are buildable, not just conceptual. |
| `business-review-weekly` | `data-decisions, architecture-{sales,wholesale,stock,purchasing,products}` | The 7 simulated business roles (CEO, Retail, Mayorista, Compras, CFO, Producto, BI Skeptic) reason about whether dashboards serve business decisions. They need to know what data exists in each domain to evaluate dashboard design quality. |
| `ai-project-summary` | `data-decisions` | Daily summary handles GitHub activity, but when suggesting "easy pickings" issues it benefits from knowing what data-related issues are high-value vs low-value. Minimal context. |

**Pure-plumbing workflows are NOT migrated** — they have no need for data semantics:

- `ai-pr-review` (code review on diffs)
- `ai-pr-mergeability` (merge conflict resolution)
- `ai-stale-manager` (issue/PR aging)
- `ai-issue-triage` (label assignment)
- `ai-test`, `ai-plan`, `ai-worker`, `ai-command`, `ai-address-feedback`, `ai-ci-remediation` (code-related)

Adding a slice or rewiring an existing one is a single-line YAML edit in the workflow + a row update in this table.

---

## Related Documentation

- [AGENTS.md](../AGENTS.md) — Project agent guidelines (read by all AI workflows)
- [ARCHITECTURE.md](../ARCHITECTURE.md) — System architecture
- [DECISIONS.md](../DECISIONS.md) — Decision index (AI Factory decisions D-011 through D-014, D-021, D-028–D-031); full rationale in `docs/decisions/D-NN-<slug>.md`
- [docs/skills/](skills/) — Domain-specific skill docs that workflows consult
