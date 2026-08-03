# AGENTS.md -- AI development guide

Guidance for AI assistants. Use the **skills** ([docs/skills/skills.md](docs/skills/skills.md)) for domain detail; this file is the skeleton, index, and meta-rules.

## Project Overview

**inmo-tool** is an AI-powered real-estate deal-sourcing and scoring platform for a personal/family-office investor. It crawls real-estate listing sites, deduplicates properties across sources, and lets the investor run several independent **search profiles** (investment theses — e.g. "high-yield low-cost rental" vs. "commercial units") over the same underlying listing pool. Each profile has its own hard filters, learned scoring model, and feedback history. AI is used for things structured fields can't tell you: occupancy likelihood, condition assessment, red-flag extraction from descriptions, and conversational search refinement.

**The full functional spec is [issue #1](https://github.com/alvarolobato/inmo-tool/issues/1)** — read it before making product-shape decisions. The 7-phase implementation roadmap and its task-level issues live under that issue's `## Implementation` section.

**Bootstrap note**: this repo started as a full copy of [powershop-analytics](https://github.com/alvarolobato/powershop-analytics), a data-pipeline + AI-dashboard project (4D ERP → Postgres mirror → WrenAI + a Next.js/Tremor dashboard) with no business relevance to real estate — chosen as a base purely because the *architecture* (external source → sync → Postgres → AI-driven UI) matches. Phase 1 (issue #2, task 1.1 = issue #9) strips the PowerShop-specific content; what's kept and reused is listed in issue #1 §14. `docs/decisions/archive/` holds the source project's full decision history for context — none of it is active for this project; decisions that still apply were re-recorded fresh (see [Recording decisions](#recording-decisions) below).

This is a **public repository** — no credentials, scraped personal data (owner names/phone numbers from listings), or real financial figures in committed files.

---

## Repository Structure

| Path | Purpose |
|------|---------|
| `dashboard/` | Dashboard App — Next.js + Tremor. LLM plumbing (`lib/llm-context/`, `lib/llm-tools/`) and shell are reused from the source project; UI content is being replaced phase by phase (Phase 2+). |
| `cli/` | Unified CLI (`ps`) — dispatcher pattern (`cli/ps` stub → `cli/ps.sh` → `cli/commands/<group>.sh`), reused as-is. |
| `cli/commands/` | Command implementations. `sql.sh`/`wren.sh`/`prod.sh` (4D/WrenAI/old-prod-specific) were removed in task 1.1. `connector.sh`/`db.sh`/`dedup.sh` (task 1.5, #13) replaced the placeholder `etl.sh` — see `docs/skills/cli.md`. |
| `etl/` | Connector/sync service — the `Connector` contract (`connectors/base.py`), orchestrator (`orchestrator.py`: rate limiting, circuit breaker, withdrawal detection), and the first real connector (`connectors/fotocasa.py`). Domain-specific PowerShop sync modules were removed in task 1.1. `db/postgres.py`'s generic DML/watermark/manual-trigger helpers are inherited but mostly unused by the new pipeline — not yet a deliberate keep-or-delete call. |
| `scripts/` | Operational scripts. Claude OAuth token launchd sync (macOS) is kept as-is — generic mechanism, not PowerShop-specific. |
| `docs/` | Documentation. |
| `docs/skills/` | AI agent skills (domain-specific guides) — see [docs/skills/skills.md](docs/skills/skills.md) for what's kept vs. pending. |
| `docs/decisions/` | Active decision index (`DECISIONS.md`) + per-decision files, fresh for this project. |
| `docs/decisions/archive/` | Source project's full decision history — inactive, kept for context. |
| `config/schema.yaml`, `dashboard/config/schema.yaml` | Central config schema (env var ↔ admin-UI key mapping). 4D/WrenAI-specific keys removed in task 1.1; a dead ETL-cron pair (`etl.cron_hour`/`etl.delta_cron_minute`, never read by the new orchestrator) removed in task 1.6. |
| `local/` | Local config/credentials (git-ignored) |
| `data/` | Bind-mounted data (postgres, ...) — git-ignored |
| `docker-compose.yml` | Local stack: `postgres` + `otel-collector` + `etl` + `dashboard` — verified live to all start healthy (task 1.6, #14), which also found and fixed a real bug (the pinned OTel image didn't support the config's `tail_sampling`/`zpages`, which silently blocked every service from starting — see `otel/otelcol-config.yaml`). |
| `.env.example` | Environment variable template (no real secrets) — grows as connector/LLM tasks land. |

---

## Unified CLI (`ps`)

Single entry point for all operations. **Usage:** `ps <group> [subcommand] [options]`.

**Groups today:**
- `setup` — first-time setup + prerequisite checks
- `stack` — start/stop/restart/status/logs for the local Docker Compose stack
- `connector` — list/run/status/logs for registered site connectors (`ps connector run [name]`)
- `db` — inspect the Postgres mirror (`tables`/`describe`/`query`)
- `dedup` — deduplication engine (`run` — stub until task 2.2, #16, lands the real matching logic)
- `dashboard` — open/logs/restart/status for the Dashboard container
- `config` — show loaded configuration

No `sql`/`wren`/`prod` groups — those were the source project's 4D-query, WrenAI-knowledge, and old-prod-deployment commands, all removed as dead weight in task 1.1. New groups get added as the tasks that need them land.

### CLI-first principle

All automation should delegate work to the CLI. This ensures every operation is reproducible locally and in Docker/CI.

### Read-only-to-sources policy

Connectors read from external listing sites and never write back (no automated form submission, no contacting sellers) — see issue #1 §15 for the full crawling-ethics constraints (ToS respect, rate limits, no anti-bot bypass). This mirrors the source project's "never modify the source ERP" rule, adapted to a web-crawling context instead of a live database.

---

## Configuration

### Credential storage (single file, survives worktrees)

**One file**: `~/.config/inmo-tool/.env` (standard `.env` format). Copy from `.env.example`, or run `ps setup`.

Priority (highest to lowest):
1. **Environment variables** — direct override
2. **`.env`** in worktree root — standard for docker-compose (symlink to centralized)
3. **`local/.env`** — worktree-specific override (git-ignored)
4. **`~/.config/inmo-tool/.env`** — centralized (shared across worktrees)

### Key environment variables (current — grows with each Phase 1 task)

| Variable | Purpose |
|----------|---------|
| `POSTGRES_DSN` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | PostgreSQL connection (connector sync target) |
| `OPENROUTER_API_KEY` | OpenRouter API key for the Dashboard App's LLM |
| `DASHBOARD_LLM_PROVIDER` / `DASHBOARD_LLM_MODEL_*` | Dashboard LLM backend selection (kept from source project, see [D-019 archive](docs/decisions/archive/D-019-pluggable-llm-providers.md)) |

Note: no `ETL_CRON_HOUR`-style variable — the connector orchestrator (`etl/orchestrator.py run_scheduler_loop`, task 1.3) runs every registered connector immediately on startup, then on a flat hourly interval. `ETL_CRON_HOUR` existed in `docker-compose.yml`/`.env.example` through task 1.5 but was never read by any code (dead since task 1.1); removed in task 1.6 (#14).

Full reference: `.env.example` (kept up to date as tasks land — no separate `docs/cli-reference.md`-style env doc yet).

---

## Dashboard App — LLM call architecture

Reused as-is from the source project — see [docs/skills/llm-context.md](docs/skills/llm-context.md) for the full reference and its "Status" note on what's inherited vs. pending rewrite.

```
dashboard/lib/llm-context/      ← single LLM entry point
  assembleRequest(flow, vars, conversationId, userMessage, opts)
    → buildSystemPrompt(flow, vars)   { stable, volatile? }
    → buildHistory(conversationId)    prior messages
    → toolsForFlow(flow)              per-flow tool catalog
    → llmComplete / runAgenticChat    (only imports here)
    → AssembleResult { text, usage, model }
```

**Never import `llmComplete` or `runAgenticChat` directly** from outside `dashboard/lib/llm-context/`. CI enforces this via `dashboard/scripts/check-llm-context.sh` once CI is wired up for this repo (see [D-004](docs/decisions/D-004-no-worker-workflows.md) for why `.github/workflows/` isn't committed yet) — treat the rule as binding regardless.

The **named flows** (`generate`/`modify`/`analyze`/`suggest`/`gap`/`weekly`/`chat`/`summary`) are the source project's old BI-dashboard flow catalog; task 4.1 (#24) replaces them with inmo-tool's own (`occupancy`/`condition`/`redflags`/`extract`/`chat`/`compare`).

---

## Important Rules for AI Assistants

### No credentials in committed files

Store all credentials in `~/.config/inmo-tool/.env` (see `.env.example` for format). Symlink to the worktree with `ln -sf ~/.config/inmo-tool/.env .env`.

### No scraped personal data in committed files

Schema metadata (table names, column names, types) is fine. Actual scraped listing content — owner names, phone numbers extracted from descriptions, real prices/addresses — must never be committed. See issue #1 §15 for the GDPR-minimization stance on `owner_identity` data once that table exists (task 1.2, #10).

### Working with worktrees

Credentials live in `~/.config/inmo-tool/` (centralized) so they work across git worktrees. Use `local/` for worktree-specific overrides only.

### AI-factory workflow file constraint

See [D-004](docs/decisions/D-004-no-worker-workflows.md) — don't push to `.github/workflows/` without a credential carrying `workflow` OAuth scope, and never bypass a blocked push via the GitHub API. The source project's `.github/workflows/*.yml` files (AI factory automation) were copied into this repo but sit **untracked on disk**, not committed, for exactly this reason — propose corrected YAML in a PR body for a human to commit, per D-004.

When a task's changes require workflow-file edits that can't be pushed, file the proposed YAML under `docs/pending-workflow-changes/<task-slug>.md` (fenced `yaml` block per affected file) and link it here as it accumulates:
- [docs/pending-workflow-changes/phase-1-1.md](docs/pending-workflow-changes/phase-1-1.md) — the first example, covering the workflows broken by task 1.1's content removal.
- [docs/pending-workflow-changes/phase-2-5.md](docs/pending-workflow-changes/phase-2-5.md) — supersedes phase-1-1.md's `dashboard-e2e` section: wires a real Postgres service into `dashboard-test` (task 2.5's integration tests were silently skipping in CI) and re-enables `dashboard-e2e` pointed at the new `candidates.spec.ts`.
- [docs/pending-workflow-changes/task-4.2-occupancy.md](docs/pending-workflow-changes/task-4.2-occupancy.md) — adds a Postgres service to `jobs.test` (pytest; net new, no prior proposal covered it) so `TestAiAssessmentRekeyMigration` and every other DB-backed pytest test stop silently skipping, and adds a `REQUIRE_DB=1` addendum to both `jobs.test` and `phase-2-5.md`'s still-unapplied `jobs.dashboard-test` proposal so a future regression in either job's Postgres wiring fails CI instead of reverting to silent skip-and-pass. Tracked repo-wide as issue #160.
- [docs/pending-workflow-changes/issue-159-test-isolation.md](docs/pending-workflow-changes/issue-159-test-isolation.md) — issue #159's per-run isolated test database (`pytest`'s `conftest.py` fixture, `npm test`'s `test-with-isolated-db.ts` wrapper); simplifies `phase-1-1.md`/`phase-2-5.md` by dropping their now-redundant "Apply schema" step from `jobs.test`/`jobs.dashboard-test` (kept for `jobs.dashboard-e2e`, which talks to the shared service DB directly).

### Backwards compatibility — default is to break it

**This project has a single deployment target** (local dev today; no production instance yet, no external API consumers). There is no reason to maintain backwards compatibility for its own sake.

When a cleaner design requires breaking a schema, API shape, or internal contract, **break it by default**. Do not add shims, dual-code-paths, deprecated fields, or `|| legacy_fallback` expressions to keep old behaviour alive.

**Default behaviour**: drop the old thing, migrate data if needed (a single SQL migration is fine), ship the new thing.

**When to ask**: if unsure whether a specific artifact is truly internal-only, ask the owner before breaking it. But if it's a DB column, an internal API field, or an in-process cache: just remove it.

### E2e tests for user-facing dashboard changes — pending re-establishment

The source project bound this with [D-041 (archived)](docs/decisions/archive/D-041-e2e-required-for-features.md): every PR touching a user-facing dashboard surface ships a Playwright e2e test against seeded Postgres. The *fixture and specs* were removed in task 1.1 (they tested the old BI-dashboard business flows against the old schema) — see [docs/skills/e2e-testing.md](docs/skills/e2e-testing.md) for what's pending. Re-establish this as a fresh decision once Phase 2's UI tasks (#19/#43/#44) give it something real to test against; until then, treat it as a strong recommendation, not yet a hard gate.

### Python changes and commits

**Before any commit that touches Python** (`.py` under `etl/`, `scripts/`, or elsewhere), run **Ruff format** on the paths you changed so CI does not fail on style:

```bash
python -m ruff format etl/ scripts/
# or narrow to files you edited:
python -m ruff format path/to/edited_file.py
```

Run this **after** your edits and **before** `git commit`. `ruff check` still applies for non-format rules — fix any issues it reports on the same trees.

---

## Self-learning and documentation

When you fix a non-obvious bug or discover a gotcha, document it. Procedure: [agent-efficiency.md](docs/skills/agent-efficiency.md).

---

## Recording decisions

`DECISIONS.md` is loaded into every Claude session in this repo. It must stay terse — one line per binding rule. **Never expand entries in the index.** All rationale, context, alternatives rejected, and incident history lives in per-decision files under `docs/decisions/D-NN-<slug>.md`, which are read on demand and not auto-loaded.

When recording a new decision:

1. **Pick the next free ID.** IDs are sequential (`D-001`, `D-002`, ...) for *this* project — separate from the archived source-project IDs under `docs/decisions/archive/`. Skip IDs are fine when a decision is retired — never reuse them.
2. **Write the full file** at `docs/decisions/D-NN-<short-slug>.md`. Use this template:
   ```markdown
   ---
   id: D-NN
   title: <one-line title>
   date: YYYY-MM-DD
   ---

   # D-NN: <one-line title>

   *Decided: YYYY-MM-DD*

   **Context**: <what triggered this, what was happening, what evidence you had>
   **Decision**: <the binding rule, in detail>
   **Alternatives rejected**: <if any, with why>
   **Rationale**: <why this is the right call>
   **See**: <files, PRs, issues, related decisions>
   ```
3. **Add one line to `DECISIONS.md`** in the appropriate group, or create a new group if none fits. The line must state the **binding rule** (imperative: "Do X" / "Don't Y"), stay ≤180 characters, and link to the per-decision file.
4. **Cross-link only from places that need it.** Link directly to the per-decision file, not to the index.
5. **Retire, don't rewrite.** If a decision no longer applies, mark its file with `## STATUS: retired (<date>) — superseded by D-MM` and remove its line from `DECISIONS.md`. Keep the file in git for archaeology.

Data-semantics decisions (schema, connectors, dedup thresholds, scoring model choices) belong here too, same as plumbing decisions — there's no separate `data-decisions.md` for this project (the source project's knowledge-bundle-compilation mechanism it fed is currently empty, see below).

---

## Knowledge file maintenance — status

The source project compiled curated docs into `dashboard/lib/knowledge.ts` (consumed by the Dashboard LLM) via `docs/knowledge-sources.yml` + `npm run build:knowledge`. All of that PowerShop-specific source content was removed in task 1.1; `docs/knowledge-sources.yml` now lists no sources and `dashboard/lib/knowledge.ts` is a stub with empty arrays. The mechanism itself (source MDs with `## LLM:*` markers → compiled TS module, CI drift guard) is worth re-adopting once Phase 4 (task 4.1+, #24) defines real domain knowledge for inmo-tool — don't hand-edit `dashboard/lib/knowledge.ts` when that happens; add source MDs and regenerate.

---

## AI Assistant Configuration

This project supports **Claude Code** and other AI assistants. All follow the same guideline:

- **Entry point:** AGENTS.md (this file) for skeleton, index, and meta-rules.
- **Domain detail:** [docs/skills/skills.md](docs/skills/skills.md) to choose the right skill.
- **Self-learning:** [docs/skills/agent-efficiency.md](docs/skills/agent-efficiency.md).

| File | Editor | Purpose |
|------|--------|---------|
| `CLAUDE.md` | Claude Code | Imports AGENTS.md + skills |

---

## GitHub access

Use the [GitHub CLI](https://cli.github.com/) (`gh`) for all GitHub operations.

---

## AI Factory lifecycle — not yet wired up

The source project's full AI-factory lifecycle (planner → implementer → PR → review → merge, label-driven) is documented conceptually in [docs/ai-factory.md](docs/ai-factory.md) and the prompts under `.github/ai-factory/prompts/`, but the workflow files that actually run it (`.github/workflows/ai-*.yml`) are **not committed** to this repo — see [D-004](docs/decisions/D-004-no-worker-workflows.md). Until a human commits them (or the pushing credential gets `workflow` scope), issue/PR work in this repo happens under direct human/agent collaboration, following the review discipline in [D-003](docs/decisions/D-003-review-policy.md) instead of the bot-driven one.

---

## Issue and PR format

This repo inherited the source project's issue template conventions: **[docs/issue-format.md](docs/issue-format.md)**. Short summary:

- Standard issue template (Context / Plan / Phase N / Additional Context), Exit Criteria with `*Verified by*`/`*Human-only*` annotations.
- **Default**: one phase = one PR, phases as headings in a single issue body.
- **Escape hatch**: for large, genuinely parallelizable work (e.g. bootstrapping this project's whole Phase 1–7 roadmap from issue #1), decompose into a parent issue per phase with a native GitHub sub-issue per task — see issues #2–#41 for the worked example and [D-003](docs/decisions/D-003-review-policy.md) for the review cadence applied to that structure.
