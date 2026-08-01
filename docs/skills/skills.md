# Skills in this folder

This folder contains **skill documents** for AI agents working on the powershop-analytics project. Each skill is a single reference for a specific domain. **Read this file to see what skills exist and when to use them.**

## Component Skills

| Skill | Purpose | Use when |
|-------|---------|----------|
| **[dashboard-redesign.md](dashboard-redesign.md)** | Token system, component map, and guidelines for the redesigned Dashboard App (Phase A+). | Modifying or building on top of the redesigned dashboard shell — TopBar, TweaksPanel, AnalyzeLauncher, LogBlock, ChatSidebar. |
| **[dashboard-app.md](dashboard-app.md)** | Dashboard App architecture: Next.js + Tremor, dashboard spec format, LLM orchestration, widget types, API routes. | Building, modifying, or debugging the AI dashboard generator. |
| **[llm-context.md](llm-context.md)** | Central LLM assembly module (`dashboard/lib/llm-context/`): `assembleRequest`, `buildSystemPrompt`, `buildHistory`, `toolsForFlow`, per-flow vars. | Adding a new LLM flow, changing how prompts/history/tools are assembled, enforcing the llm-context boundary. |
| **[data-access.md](data-access.md)** | How to connect to 4D via SQL (P4D) and SOAP (zeep). Connection patterns, query examples, gotchas. | Running SQL queries, exploring the schema, testing SOAP calls. |
| **[4d-sql-dialect.md](4d-sql-dialect.md)** | Comprehensive 4D SQL dialect reference: data types, SELECT/JOIN/WHERE syntax, all functions, system tables, gotchas vs PostgreSQL/MySQL. | Writing SQL queries, looking up function syntax, understanding type mappings, troubleshooting 4D SQL behavior. |
| **[cli.md](cli.md)** | CLI architecture: dispatcher, commands, load-env, adding new commands. | Modifying or extending the `ps` CLI. |
| **[report-generation.md](report-generation.md)** | Full cookbook for generating the BI HTML report: all 60+ SQL queries, SOAP calls, HTML structure, design specs, action item guidelines, data quality gotchas. | Regenerating `informe-coleccion.html`, creating a new snapshot, or answering "how was the report built". |
| **[testing-patterns.md](testing-patterns.md)** | TDD workflow, factory patterns, mocking strategies for both Python (pytest) and TypeScript (Vitest). | Writing unit tests, integration tests, creating test factories. |
| **[e2e-testing.md](e2e-testing.md)** | Playwright e2e for the Dashboard App: repo setup, the `e2e-stub` LLM provider, the seeded-Postgres fixture (`dashboard/e2e/fixtures/`), what to assert, CI wiring. | Writing browser-level e2e tests that drive a real server + Postgres (e.g. issue #800). |
| **[systematic-debugging.md](systematic-debugging.md)** | Four-phase debugging methodology with project-specific playbooks for ETL, WrenAI, and Dashboard App. | Investigating bugs, fixing test failures, troubleshooting pipeline issues. |

## Release & Deployment Skills

| Skill | Purpose | Use when |
|-------|---------|----------|
| **[release.md](release.md)** | Cutting a release (major/minor/patch + beta), the release workflows, the `GITHUB_TOKEN` recursion-guard gotcha, and how Docker images get built and tagged. | Creating a new version and building the ETL + Dashboard images. |
| **[prod-deploy.md](prod-deploy.md)** | Deploying a released version to the production Mac: `ps prod update` vs `deploy`, prerequisites, knowledge push, verification. Points to the full `prod-cli.md` / `production.md` references. | Pushing a release (or new images) onto production. |

## Reference Docs (not skills, but always relevant)

| Document | Purpose | Use when |
|----------|---------|----------|
| **[../etl-sync-strategy.md](../etl-sync-strategy.md)** | Validated sync strategy for every table: delta field, PK, method, gotchas. Confirmed against production data. | Implementing or debugging ETL sync, deciding whether a table is append-only or needs upsert. |
| **[../architecture/](../architecture/)** | Per-domain ER diagrams, row counts, field notes, and ETL sync sections. | Understanding table relationships, planning queries, checking field names. |
| **[../deployment/production.md](../deployment/production.md)** | Production install guide: cold-start, prerequisites, backup/restore, disaster recovery, upgrades, monitoring. | Setting up or operating the production Mac; answering "how do I stand up a second prod instance". |
| **[../deployment/prod-cli.md](../deployment/prod-cli.md)** | `ps prod *` CLI reference: all 12 subcommands with synopsis, side effects, examples. | Looking up what a `ps prod` command does or when to use deploy vs update. |
| **[../sample-queries.md](../sample-queries.md)** | 10-domain ready-to-use SQL cookbook: schema discovery, retail sales, wholesale, stock, customers, payments, margins, transfers, M-prefix filtering, stock movement formula. | Starting a query for any business domain — don't write from scratch, grab a template here first. |
| **[../sql-views.md](../sql-views.md)** | Catalog of 100 4D SQL views (`*_SQL` + `*_BI`) with column counts and detailed structure for key views (Ventas_SQL 150 cols, Exportaciones_SQL 161 cols). | Knowing which views exist, what columns they expose, and which view to query for a given domain. |
| **[../schema-discovery.md](../schema-discovery.md)** | Full table inventory by domain (Products, Retail Sales, Customers, Wholesale, Purchasing, Stock, Finance, HR) plus D-011 extraction session notes. | Getting a bird's-eye view of the 4D schema or locating a table by business domain. |
| **[../data-dictionary.md](../data-dictionary.md)** | Spanish/English glossary, module prefixes, `.99` PK pattern, `Total` vs `TotalSI` semantics, Libre custom-field convention. | Decoding field names, understanding naming conventions, or checking what a prefix like `GC` or `JO` means. |
| **[../schema-raw/README.md](../schema-raw/README.md)** | Queryable JSON dumps of `_USER_COLUMNS`, FK/PK constraints, indexed columns, view schemas, and WSDL methods from the live 4D server. | Raw structural lookups: column types, indexes, FK relationships, available SOAP methods. |
| **[../deployment/getting-started.md](../deployment/getting-started.md)** | Local dev environment setup: prerequisites, stack startup, first query, WrenAI data source config, access URLs. | Getting a local dev environment running for the first time. |

## Meta Skills

| Skill | Purpose | Use when |
|-------|---------|----------|
| **[agent-efficiency.md](agent-efficiency.md)** | Self-learning and documentation (where to document gotchas, update cross-refs). | After fixing non-obvious bugs or discovering gotchas; when a clear doc/skill gap appears. |

## Summary

- **Dashboard redesign**: Use **dashboard-redesign** for the token system, new components (TopBar, TweaksPanel, AnalyzeLauncher, LogBlock), and redesign-specific patterns.
- **Dashboard App**: Use **dashboard-app** for building the AI dashboard generator (Next.js + Tremor).
- **LLM context module**: Use **llm-context** when adding a new LLM flow, changing prompt/history/tools assembly, or enforcing the llm-context boundary.
- **Data access**: Use **data-access** for connecting to 4D SQL or SOAP.
- **SQL dialect**: Use **4d-sql-dialect** for 4D SQL syntax, functions, types, and differences from standard SQL.
- **CLI**: Use **cli** for extending the command-line tool.
- **Report generation**: Use **report-generation** to reproduce the BI report or create a new snapshot.
- **ETL sync decisions**: Read **etl-sync-strategy.md** before implementing any sync — it has validated delta fields and PKs per table.
- **Releases**: Use **release** to cut a version (major/minor/patch) and build the Docker images.
- **Production deploy**: Use **prod-deploy** to push a release onto the production Mac.
- **Self-improvement**: Use **agent-efficiency** when guidance was missing.

## Agent specializations for parallel work

When implementing the Dashboard App, work can be split across specialized agents:

| Agent | Scope | Key files |
|-------|-------|-----------|
| **Frontend** | Tremor widgets, dashboard renderer, chat sidebar, dashboard list UI | `dashboard/components/`, `dashboard/app/` |
| **LLM/Backend** | Prompt engineering, OpenRouter client, spec generation/modification, knowledge context | `dashboard/lib/`, `dashboard/app/api/` |
| **Data** | SQL execution, PostgreSQL queries, caching, dashboard persistence schema | `dashboard/lib/db.ts`, `etl/schema/init.sql` |
| **Integration** | Dockerfile, docker-compose service, CLI commands, deployment | `dashboard/Dockerfile`, `docker-compose.yml`, `cli/` |
