# Skills in this folder

This folder contains **skill documents** for AI agents working on the inmo-tool project. Each skill is a single reference for a specific domain. **Read this file to see what skills exist and when to use them.**

This list shrank sharply in task 1.1 (#9) — most of the source project's skills were 4D/WrenAI/PowerShop-specific and were removed rather than kept unused. It grows again as Phase 1+ tasks land; add a row here whenever a task creates a new skill doc.

## Component Skills

| Skill | Purpose | Use when |
|-------|---------|----------|
| **[llm-context.md](llm-context.md)** | Central LLM assembly module (`dashboard/lib/llm-context/`): `assembleRequest`, `buildSystemPrompt`, `buildHistory`, `toolsForFlow`, per-flow vars. Kept as reusable architecture — see its **Status** note for what's inherited vs. pending (task 4.1, #24). | Adding a new LLM flow, changing how prompts/history/tools are assembled, enforcing the llm-context boundary. |
| **[connectors.md](connectors.md)** | The `Connector` contract in practice: feasibility-spike-first, preferring embedded JSON over HTML scraping, robots.txt-driven scope limits, not fabricating precision, withdrawal detection, registration, testing. Fotocasa (task 1.4, #12) is the worked example. | Building a new site connector (task 2.1 onward), or debugging why an existing one under/over-populates fields. |
| **[search-url-builder.md](search-url-builder.md)** | Per-portal PRE-FILTERED search-URL builder (`dashboard/lib/search-url/`): maps a profile scope → each capture portal's search URL for guided capture, with best-effort loosened-constraint flags. Idealista + aliseda (task #267). | Adding/refreshing a portal's search-URL grammar, wiring "Abrir búsqueda"/"Empezar captura", or debugging a wrong pre-filtered URL. |
| **[captura-execution.md](captura-execution.md)** | Task-driven guided-capture EXECUTION page (`dashboard/app/captura/`): pick a profile → discrete recurring capture TASKS (one per portal×section) each a button with last-done + a staleness window that grays done tasks. Composes `/api/profiles/[id]/search-urls` `tasks[]` (#267/#289) + `/api/etl/worklist` (#260) + the `capture_task_run` ledger via the pure `lib/captura-tasks.ts`. Setup stays in `/etl` (D-045/D-048). Issues #268/#284/#289. | Building on the Captura page, the per-task row, the staleness/gray logic, the `tasks[]` normaliser, or the last-run ledger; deciding execution-vs-setup placement. |
| **[cli.md](cli.md)** | CLI architecture: dispatcher, commands, load-env, adding new commands. | Modifying or extending the `ps` CLI. |
| **[testing-patterns.md](testing-patterns.md)** | TDD workflow, factory patterns, mocking strategies for both Python (pytest) and TypeScript (Vitest). Examples are illustrative/forward-looking pending real modules to copy from (Phase 1). | Writing unit tests, integration tests, creating test factories. |
| **[e2e-testing.md](e2e-testing.md)** | Status: fixtures/specs removed in task 1.1 (tested the old domain). Mechanism worth re-adopting once Phase 2's UI tasks exist. | Planning e2e coverage once Phase 2 lands; see the file's Status section first. |
| **[systematic-debugging.md](systematic-debugging.md)** | Four-phase debugging methodology (generic — kept in full). Project-specific playbooks reset in task 1.1; add real ones as failures are hit and solved. | Investigating bugs, fixing test failures, troubleshooting pipeline issues. |

## Reference Docs (not skills, but always relevant)

| Document | Purpose | Use when |
|----------|---------|----------|
| **[../ai-factory.md](../ai-factory.md)** | AI-factory concept/lifecycle guide (workflows not yet committed — see [D-004](../decisions/D-004-no-worker-workflows.md)). | Understanding the intended label-driven dev process, once wired up. |
| **[../dashboard-agentic-tools.md](../dashboard-agentic-tools.md)** | Agentic tool-calling runner/provider mechanism (kept). Tool catalog is the old PowerShop-mirror inspection tools — see its Status note. | Adding/understanding the dashboard's tool-calling loop. |
| **[../testing-strategy.md](../testing-strategy.md)** | Test tiers, commands, coverage-threshold policy. Baselines reset pending real code (Phase 1). | Deciding what tier a new test belongs in, or what must be covered before a risky change. |
| **[../issue-format.md](../issue-format.md)** | Standard issue/PR template, Exit Criteria conventions, single-track vs. decompose-into-sub-issues escape hatch. | Writing or refining a GitHub issue. |
| **[../roadmap/connector-etl-ops.md](../roadmap/connector-etl-ops.md)** | Forward roadmap for hardening connectors + ETL ops: management, ad-hoc execution, error tracking/monitoring, aging/withdrawal, dedup. Proposed issue sequence + broken-telemetry findings. | Planning connector/ETL reliability + data-quality work. |
| **[../roadmap/dedup-optimization.md](../roadmap/dedup-optimization.md)** | Dedup performance/approach analysis: where the runtime goes, blocking/bucketing (deferred), incremental dedup, and profile-scoped review-queue prioritization. | Planning dedup speed or duplicate-review improvements. |

## Meta Skills

| Skill | Purpose | Use when |
|-------|---------|----------|
| **[agent-efficiency.md](agent-efficiency.md)** | Self-learning and documentation (where to document gotchas, update cross-refs). | After fixing non-obvious bugs or discovering gotchas; when a clear doc/skill gap appears. |

## Agent specializations for parallel work

Once Phase 2+ UI work starts, work can be split across specialized agents the same way the source project did for its dashboard build:

| Agent | Scope | Key files |
|-------|-------|-----------|
| **Frontend** | Tremor components, candidate feed/map/detail page, chat sidebar | `dashboard/components/`, `dashboard/app/` |
| **LLM/Backend** | Prompt engineering, tool catalog, flow definitions | `dashboard/lib/llm-context/`, `dashboard/lib/llm-tools/`, `dashboard/app/api/` |
| **Data** | Connector sync, dedup engine, Postgres schema | `etl/`, `etl/schema/init.sql` |
| **Integration** | Dockerfile, docker-compose service, CLI commands | `dashboard/Dockerfile`, `docker-compose.yml`, `cli/` |
