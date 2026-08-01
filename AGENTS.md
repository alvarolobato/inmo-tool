# AGENTS.md -- AI development guide

Guidance for AI assistants. Use the **skills** ([docs/skills/skills.md](docs/skills/skills.md)) for domain detail; this file is the skeleton, index, and meta-rules.


## Project Overview

**PowerShop Analytics** is an AI-powered analytics platform for a retail/wholesale business. It extracts data from a vendor-managed PowerShop ERP (4D database), mirrors it into PostgreSQL, and provides two analytics interfaces:

1. **WrenAI** — Ad-hoc single-question text-to-SQL ("¿Cuánto vendimos ayer?")
2. **Dashboard App** — AI-generated multi-widget dashboards from natural language ("Créame un cuadro de mandos para ventas") — **NEW, in development**

**Data source:** PowerShop 4D v18.0.6 at `YOUR_4D_SERVER_IP` (Windows, compiled mode).
**Access paths:** P4D SQL driver (port 19812) for bulk extraction, SOAP web services (port 8080) for business-enriched data.
**Target:** PostgreSQL (mirror) → WrenAI + Dashboard App. LLM via OpenRouter (Claude Sonnet 4).

**Architecture**: See [ARCHITECTURE.md](ARCHITECTURE.md) for system diagrams and component details.
**Decisions**: See [DECISIONS.md](DECISIONS.md) for binding one-line rules; `docs/decisions/D-NN-<slug>.md` for full rationale per decision.

This is a **public repository** -- no credentials, customer data, or business-specific data in committed files.

---

## Repository Structure

| Path | Purpose |
|------|---------|
| `dashboard/` | **Dashboard App** — Next.js + Tremor AI dashboard generator |
| `cli/` | Unified CLI (`ps`) — commands, dispatcher |
| `cli/commands/` | Command implementations (sql.sh, config.sh, stack.sh, etl.sh, wren.sh) |
| `etl/` | Python ETL service — syncs 4D → PostgreSQL (nightly) |
| `scripts/` | Operational scripts (wren-push-metadata.py, migrate-volumes.sh, wren-setup.sh) |
| `wren/mdl/` | WrenAI semantic model reference (MDL JSON) |
| `docs/` | Documentation, schema discovery, architecture |
| `docs/architecture/` | Domain ER diagrams + ETL sync strategy per domain |
| `docs/skills/` | AI agent skills (domain-specific guides) |
| `local/` | Local config/credentials (git-ignored) |
| `data/` | Bind-mounted data (postgres, qdrant, wren) — git-ignored |
| `docker-compose.yml` | Full stack: PostgreSQL + ETL + WrenAI + Dashboard App |
| `.env.example` | Environment variable template (no real secrets) |
| `ARCHITECTURE.md` | System architecture, component diagrams, data flow |
| `DECISIONS.md` | Decision index — one-line binding rules; full rationale in `docs/decisions/D-NN-<slug>.md` |
| `docs/deployment/production.md` | Production install guide — cold-start, prerequisites, backup, disaster recovery |
| `docs/deployment/prod-cli.md` | `ps prod *` CLI reference — all 12 subcommands |

---

## Unified CLI (`ps`)

Single entry point for all operations. **Usage:** `ps <group> [subcommand] [options]`. Full command list in [docs/cli-reference.md](docs/cli-reference.md).

**Groups (skim by these to find the right command):**
- `setup` — first-time setup + prerequisite checks
- `stack` — start/stop/restart/status/logs for the full Docker Compose stack
- `etl` — run nightly sync once, watermark status, table row counts, logs
- `sql` — read-only queries against the 4D source (list/describe/query/sample/count)
- `wren` — push knowledge, validate SQL pairs, show counts
- `dashboard` — open/logs/restart/status for the Dashboard container
- `prod` — operate the production Mac over SSH (deploy, update, restart, health, login, ssh)
- `config` — show loaded configuration

### CLI-first principle

All automation should delegate work to the CLI. This ensures every operation is reproducible locally and in Docker/CI.

### Read-only policy

**CRITICAL:** All SQL operations are read-only. The CLI rejects INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, and TRUNCATE statements. We are extracting data, never modifying the source ERP.

---

## Configuration

### Credential storage (single file, survives worktrees)

**One file**: `~/.config/powershop-analytics/.env` (standard `.env` format). Copy from `.env.example`.

This file is loaded by all three systems:
- **CLI** (`load-env.sh`): loads `~/.config/powershop-analytics/.env`, then `local/.env`
- **ETL** (`config.py` via python-dotenv): loads from `./.env`, then `local/.env`, then `~/.config/powershop-analytics/.env`
- **docker-compose**: symlink `.env` in the worktree → `~/.config/powershop-analytics/.env`

Run `ps setup` to create the file and symlink automatically.

Priority (highest to lowest):
1. **Environment variables** -- Direct override
2. **`.env`** in worktree root -- standard for docker-compose (symlink to centralized)
3. **`local/.env`** -- Worktree-specific override (git-ignored)
4. **`~/.config/powershop-analytics/.env`** -- Centralized (shared across worktrees)

### Key environment variables

| Variable | Purpose |
|----------|---------|
| `P4D_HOST` | 4D SQL server hostname/IP |
| `P4D_PORT` | 4D SQL server port (default: 19812) |
| `P4D_USER` | 4D SQL username |
| `P4D_PASSWORD` | 4D SQL password |
| `SOAP_URL` | SOAP endpoint URL |
| `SOAP_WSDL` | WSDL URL |
| `POSTGRES_DSN` | PostgreSQL connection string (ETL target) |
| `OPENROUTER_API_KEY` | OpenRouter API key for WrenAI LLM + embeddings |
| `ETL_CRON_HOUR` | Hour to run nightly sync (default: 2) |
| `WREN_LLM_MODEL` | LLM model for WrenAI text-to-SQL (default: anthropic/claude-sonnet-4) |

---

## WrenAI Configuration

### LLM and Embeddings (via OpenRouter)

WrenAI uses two AI providers, both routed through OpenRouter with a single API key:
- **LLM**: `openrouter/anthropic/claude-sonnet-4` via litellm. Configured in `wren-config.yaml`.
- **Embeddings**: `openai/text-embedding-3-large` via litellm. Note: litellm does NOT support the `openrouter/` prefix for embeddings — use `openai/` prefix with `OPENAI_API_BASE` set to `https://openrouter.ai/api/v1`.

Model IDs must match OpenRouter's catalog exactly (e.g. `anthropic/claude-sonnet-4` not `anthropic/claude-sonnet-4-20250514`). Check https://openrouter.ai/models for valid IDs.

### Semantic Model

Relationships and models are managed through WrenAI's GraphQL API at `http://localhost:3000/api/graphql`:
- `createRelation(data: { fromModelId, fromColumnId, toModelId, toColumnId, type })` — create relationship
- `mutation { deploy(force: true) }` — deploy/re-index the semantic model

The MDL JSON at `wren/mdl/model.json` is a reference but WrenAI community edition manages its own model internally via the UI/API, not by loading external JSON files.

### Data Persistence

All data lives in bind-mounted directories under `./data/`:
- `./data/postgres/` — PostgreSQL data files
- `./data/qdrant/` — Qdrant vector store
- `./data/wren/` — WrenAI config, SQLite DB, MDL

This survives `docker compose down` and container recreation. Only `docker compose down -v` or deleting `./data/` will destroy it.

### Knowledge Management

WrenAI has two knowledge channels that feed the RAG pipeline for text-to-SQL generation:

#### Instructions (business rules)
- Stored in SQLite `instruction` table + indexed in qdrant `instructions` collection
- Source instructions: managed by `scripts/wren-push-metadata.py`, marked `is_default=1`
- User instructions: created via WrenAI UI, marked `is_default=0` — **never touched by the script**
- Current count: **40 source instructions** covering retail sales, wholesale, stock, customers, payments, margins, products, transfers, pricing, and data quality rules

#### SQL Pairs (example query patterns)
- Stored in SQLite `sql_pair` table + indexed in qdrant `sql_pairs` collection
- Source pairs tracked by question text (deterministic). On update: delete matching, re-insert new.
- User pairs with different question text survive updates.
- Current count: **52 source SQL pairs** across all business domains

#### Merge strategy
Run `ps wren push` to update source knowledge without losing user entries:
```bash
ps wren push                     # update knowledge
ps wren validate                 # test SQL pairs against PostgreSQL
ps wren status                   # show counts
```

The script:
1. Deletes `instruction` rows where `is_default=1`, inserts new source instructions with `is_default=1`
2. Deletes `sql_pair` rows whose question matches any source question, inserts new source pairs
3. Restarts wren-ui, deploys (re-indexes schema embeddings)
4. POSTs instructions and SQL pairs to qdrant AI service

#### Critical: deploy does NOT index instructions/sql_pairs
`mutation { deploy(force: true) }` only re-indexes the schema (table/column embeddings). Instructions and SQL pairs require separate POST calls to the AI service at port 5555.

#### Adding new knowledge
To add new instructions: add a JSON entry to the `## LLM:rules` array in `docs/etl-sync-strategy.md` (or the relevant architecture / skill MD), then run `npm run build:knowledge` (dashboard) and `ps wren push` (WrenAI).
To add new SQL pairs: add a `### question\n```sql\n...\n``` ` block to `docs/dashboard/sql-pairs.md` under `## LLM:sql-pairs`, then run both commands above. All SQL must be valid PostgreSQL against `ps_*` mirror tables; date placeholders (`:curr_from`, `:curr_to`, etc.) are automatically expanded for WrenAI.

---

## Data Architecture

### 4D Database (source)

- **325 tables**, ~8.6 million rows across key tables
- **Key domains:** Products (Articulos), Sales (Ventas/LineasVentas), Customers (Clientes), Wholesale (GC* tables), Purchasing (Compras), Invoicing (Facturas), Stock (Exportaciones/CCStock), Logistics, HR (RRHH*), Finance, Stores (Tiendas)
- **Schema details:** Run `ps sql schema` to generate locally (git-ignored, contains real data)
- **Authoritative field types:** Query **`_USER_COLUMNS`** on the live 4D server (`ps sql query "SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH FROM _USER_COLUMNS WHERE TABLE_NAME = 'Exportaciones' AND COLUMN_NAME LIKE 'Stock%'"`). Type IDs are documented in [docs/skills/4d-sql-dialect.md](docs/skills/4d-sql-dialect.md). A local **PowerShop Server / PSClient** directory tree (install or backup files) is mainly **binaries and resources** — it does **not** replace structure discovery; use SQL system tables or vendor `*_SQL` views.
- Primary keys use Real (float) fields with a `.99` suffix pattern — store as `NUMERIC` in PostgreSQL, never `FLOAT8`
- CCStock has 582 columns (wide-format stock matrix); prefer `Exportaciones` for ETL (has FechaModifica, simpler structure)
- **Type-3/length-2 stock-slot columns:** `_USER_COLUMNS` declares **both** `Exportaciones.Stock1..Stock34` **and** `CCStock.Stock1..Stock34` as **`DATA_TYPE = 3`**, **`DATA_LENGTH = 2`** (16-bit integer). The 4D SQL + p4d path can return **unsigned widened** values for negatives (`65535` = `−1`). The ETL applies **`decode_signed_int16_word()`** (subtract 65536 when `32768 ≤ n ≤ 65535` — exact int16 bit reinterpretation) **on both tables' slot columns** before writing to `ps_stock_tienda.stock` / `ps_stock_central.stock`. The **root-level** `CCStock.Stock` is **Real** (type 6) and is **not** passed through that decoder; `etl/sync/ccstock.py` only decodes the 34 slot columns. See [docs/skills/data-access.md](docs/skills/data-access.md), [`docs/decisions/D-017-signed-int16-stock.md`](docs/decisions/D-017-signed-int16-stock.md).
- Articulos has 379 columns (prices, sizes, multilingual descriptions) — never `SELECT *`, always specify columns
- **ETL sync strategy:** See [docs/etl-sync-strategy.md](docs/etl-sync-strategy.md) for validated delta fields, PKs, and sync method per table

### Access Paths

1. **P4D (SQL on port 19812)** -- Recommended for bulk extraction. Python DB-API 2.0 via `p4d` package. Use for schema discovery, bulk loads, delta queries.
2. **SOAP (HTTP on port 8080)** -- 100+ operations at `/4DSOAP/`. Use for business-enriched data (calculated prices, aggregated stock). WS_JS_* methods return JSON strings.
3. **ODBC** -- Not viable (no Linux driver).
4. **REST API** -- Not enabled (404).

---

## Development Setup

### Prerequisites

- Python 3.11+ with venv
- System packages for CFFI: `build-essential`, `libffi-dev` (Linux/Docker)
- Network access to YOUR_4D_SERVER_IP (ports 19812, 8080)

### Quick start

```bash
# Clone and set up
python3 -m venv .venv
.venv/bin/pip install p4d

# Copy credentials template
cp credentials.conf.template ~/.config/powershop-analytics/credentials.conf
# Edit with your values

# Test connection
cli/ps.sh sql tables
```

### Adding the CLI to PATH

```bash
chmod +x cli/ps
cp cli/ps ~/bin/ps-analytics  # or symlink
```

---

## Dashboard App — LLM call architecture

All LLM calls in the Dashboard App go through a single central module. **Never import `llmComplete` or `runAgenticChat` directly** from outside `dashboard/lib/llm-context/`. CI enforces this via `dashboard/scripts/check-llm-context.sh` (runs in the `dashboard-test` job).

```
dashboard/lib/llm-context/      ← single LLM entry point
  assembleRequest(flow, vars, conversationId, userMessage, opts)
    → buildSystemPrompt(flow, vars)   { stable, volatile? }
    → buildHistory(conversationId)    prior messages
    → toolsForFlow(flow)              per-flow tool catalog
    → llmComplete / runAgenticChat    (only imports here)
    → AssembleResult { text, usage, model }
```

**Named flows**: `generate`, `modify`, `analyze`, `suggest`, `gap`, `weekly`, `chat`, `summary`.
**Side-channel results**: tool handlers mutate `ctx` in place (`ctx.modifyResult`, `ctx.analyzeResult`, `ctx.reviewResult`); the caller reads them after `assembleRequest()` returns.

Full skill reference: [docs/skills/llm-context.md](docs/skills/llm-context.md). Decision record: [D-036](docs/decisions/D-036-llm-context-centralization.md).

---

## Important Rules for AI Assistants

### Claude OAuth token: single-refresher rule (D-025, issue #440)

The Keychain entry `Claude Code-credentials` on the macOS host is the **single source of truth** for the OAuth payload. Only the host `claude` CLI ever refreshes it (during normal interactive use). The launchd agent at `scripts/launchd/com.powershop.claude-token-sync.plist.template` (installed via `scripts/install-claude-token-launchd.sh`) runs every 2 h and **only mirrors** the Keychain into `~/.claude/.credentials.json` so the dashboard container can read it. **Never** add code that POSTs to `claude.ai/api/auth/oauth/token` from a script or from the container — Cloudflare blocks it AND a successful refresh from anywhere other than host claude will rotate the refresh_token and invalidate the Keychain copy, forcing the user to `claude /login` (Apr 2026 incident).

### Read-only data access

**Never** issue SQL statements that modify data. The PowerShop ERP is vendor-managed and production. We only read.

### No credentials in committed files

Store all credentials in `~/.config/powershop-analytics/.env` (see `.env.example` for format). Symlink to the worktree with `ln -sf ~/.config/powershop-analytics/.env .env`.

### No customer/business data in committed files

Schema metadata (table names, column names, types, row counts) is fine. Actual customer records, sales data, or any PII must never be committed.

### Working with worktrees

Credentials live in `~/.config/powershop-analytics/` (centralized) so they work across git worktrees. Use `local/` for worktree-specific overrides only.

### No worker writes to `.github/workflows/` (D-029, issue #558)

The AI worker (and any other claude-code-action job in this repo) must **not** create, modify, or delete files under `.github/workflows/`. Two layered constraints make this fail in subtle ways:

1. GitHub Apps need the App-installation-level "Workflows: Read and write" permission to push workflow files. This is **not** configurable from inside the repo — it lives in the GitHub App's installation settings on github.com. The `permissions:` block in a workflow YAML only controls the `GITHUB_TOKEN` scopes, and `workflows` is **not** in the valid scope list (`actions, attestations, checks, contents, deployments, discussions, id-token, issues, models, packages, pages, pull-requests, repository-projects, security-events, statuses`). Adding `workflows: write` to `permissions:` puts the entire workflow into startup-failure — every event for that workflow is silently dropped (this happened from 2026-05-10 13:55 UTC to 2026-05-11 11:00 UTC; see D-029).
2. Even with a fine-grained PAT carrying `workflow` OAuth scope, granting the worker rights to rewrite the very files that schedule it is a self-modifying-system foot-gun we are choosing not to take.

**What to do instead** when an issue asks for a new or modified workflow file:

- Post the proposed YAML in the PR body (or as a comment on the tracking issue) inside a fenced ```yaml block.
- Land everything else the issue asks for (prompts, configs, helper scripts, docs, labels) in the PR normally.
- Tag the human owner in the PR description with "⚠️ Workflow file pending human commit — see YAML below." The owner copies the YAML into `.github/workflows/<name>.yml` in a follow-up commit.

If you (the worker) detect that a planned sub-task would touch `.github/workflows/`, split it out into a separate `ai-blocked + ai-task` sub-issue with the workflow YAML in the body, and proceed with the rest. Do **not** attempt the push and do **not** try to "fix" it by adding permissions to the YAML.

### No GitHub API bypass for git push (D-029 corollary)

When `git push` is blocked (e.g., because recent main commits changed `.github/workflows/` files and GitHub enforces a workflow-scope check on the push), **do not** work around it by using the GitHub Git Tree API (`POST /repos/:owner/:repo/git/trees`, `POST /git/commits`, `PATCH /git/refs`) to push code directly. This bypasses the same security model that D-029 protects and is explicitly not acceptable.

**The correct response when git push is blocked:**
1. Post a comment on the issue explaining the block and tagging @alvarolobato.
2. Leave the code staged but not pushed (or stash it on the branch if partial work was done before the block was hit).
3. Add `ai-blocked`. The owner resolves by ensuring the worker token has `contents: write` scope or by pushing manually.

The API bypass creates PRs that circumvent security checks and are difficult to audit. It is **never** acceptable regardless of how convenient it seems.

### Backwards compatibility — default is to break it

**This project has a single deployment** (one production instance, no external API consumers, no SDK users). There is no reason to maintain backwards compatibility for its own sake.

When a cleaner design requires breaking a schema, API shape, or internal contract, **break it by default**. Do not add shims, dual-code-paths, deprecated fields, or `|| legacy_fallback` expressions to keep old behaviour alive. That debt accumulates fast and was the root cause of the `chat_messages_*` column debacle: a cache that was kept "for backwards compat" for months after conversations moved to a proper table, bloating the schema and confusing every new reader of the code.

**Default behaviour**: drop the old thing, migrate data if needed (a single SQL migration is fine), ship the new thing.

**When to ask**: if you are unsure whether a specific deployment artifact (a file format someone may have downloaded, a webhook schema external partners call, etc.) is truly internal-only — ask the owner before breaking it. But if it's a DB column, an internal API field, or an in-process cache: just remove it.

Concretely:
- Old DB column replaced by a proper table → `DROP COLUMN`, no `|| old_column` fallback in code.
- Internal API field renamed → remove the old name from the route; don't accept both.
- Legacy in-memory cache replaced by the real data source → delete the cache write, delete the cache read.
- Migration data: write a one-time SQL block in `init.sql` under `-- One-time migration:` and mark it as run-once (idempotent via `IF NOT EXISTS` or `WHERE NOT EXISTS`). Remove the migration block once it has run on production (a follow-up PR).

### E2e tests required for user-facing dashboard changes ([D-041](docs/decisions/D-041-e2e-required-for-features.md))

Every PR that adds or modifies a user-facing dashboard surface (a new page, a new widget type, a new saved-dashboard seeder, or a change to existing widget SQL/rendering) **must ship a Playwright e2e test** that:
1. Loads the seeded Postgres fixture (`dashboard/e2e/fixtures/init-test-db.sh`).
2. Navigates to the affected page under `DASHBOARD_LLM_PROVIDER=e2e-stub`.
3. Asserts no error surface is rendered (`ErrorDisplay`, `Detalles técnicos`, `there is no parameter`, `HTTP 500`, `Error al cargar` all absent).
4. Asserts at least one widget or data region renders real content (not a skeleton or empty state).

**Why**: The weekly-review dashboards shipped `there is no parameter $1` to production because every unit was green in isolation — they mocked Postgres and never ran the SQL. Only a full e2e run against real data catches this class of bug.

The seeded fixture (`dashboard/e2e/fixtures/`) and the pattern are documented in **[docs/skills/e2e-testing.md](docs/skills/e2e-testing.md)**. The CI job does **not** yet wire new specs automatically — propose the YAML diff in the PR body for a human commit per [D-029](docs/decisions/D-029-no-worker-workflows.md).

---

### Python changes and commits

**Before any commit that touches Python** (`.py` under `etl/`, `scripts/`, or elsewhere in the repo), run **Ruff format** on the paths you changed so CI does not fail on style. From the repo root, typical patterns:

```bash
python -m ruff format etl/ scripts/
# or narrow to files you edited:
python -m ruff format path/to/edited_file.py
```

Run this **after** your edits and **before** `git commit`. Formatting is required even for small diffs; skipping it has been causing repeated lint failures in PRs. `ruff check` still applies for non-format rules—fix any issues it reports on the same trees.

---

## Self-learning and documentation

When you fix a non-obvious bug or discover a gotcha, document it. Procedure: [agent-efficiency.md](docs/skills/agent-efficiency.md).

---

## Recording decisions

`DECISIONS.md` is loaded into every Claude session in this repo (CLI + AI Factory). It must stay terse — one line per binding rule. **Never expand entries in the index.** All rationale, context, alternatives rejected, and incident history lives in per-decision files under `docs/decisions/D-NN-<slug>.md`, which are read on demand and not auto-loaded.

When recording a new decision:

1. **Pick the next free ID.** IDs are sequential (`D-001`, `D-002`, ...). Skip IDs are fine when a decision is retired — never reuse them.
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
3. **Add one line to `DECISIONS.md`** in the appropriate group (`AI Factory — policy and lifecycle` / `Runtime / infrastructure` / `Data / ETL` / `WrenAI knowledge` / `Dashboard App`, or create a new group if none fits). The line must:
   - State the **binding rule**, not the title (use imperative: "Do X" / "Don't Y" / "X must Y").
   - Stay ≤ 180 characters.
   - Link to the per-decision file: `[D-NN](docs/decisions/D-NN-<slug>.md)`.
4. **Cross-link only from places that need it.** In other docs and code comments, link directly to the per-decision file (`docs/decisions/D-NN-<slug>.md`), not to the index.
5. **Retire, don't rewrite.** If a decision no longer applies, mark its per-decision file with `## STATUS: retired (<date>) — superseded by D-MM` at the top and remove its line from `DECISIONS.md`. Keep the file in git for archaeology.

Pure plumbing decisions (containers, OAuth, CI, review policy, dashboard chrome, AI Factory rules) go here. Data-semantics decisions (table schemas, field types, join paths) also belong here — additionally, mirror the data-relevant ones into the appropriate `## LLM:rules` source MD so the dashboard knowledge bundle and WrenAI corpus pick them up.

---

## Revisiones semanales de negocio (D-028, issue #467)

Cada lunes 06:00 UTC un workflow simula 7 roles de negocio (CEO, Retail, Mayorista, Compras, CFO, Producto, BI Skeptic) y abre como mucho 1 issue por rol con propuestas de mejora. Las issues van etiquetadas con `business-review`, `role:<slug>`, `review-type:<slug>`, `needs-human-approval` y **NO** llevan `ai-work`.

**Regla**: la AI Factory **no debe implementar** una propuesta `business-review` mientras lleve `needs-human-approval`. Triagear y planificar sí, ejecutar no. Cuando un humano apruebe: retirar `needs-human-approval` y añadir `ai-work` para que arranque el flujo estándar de la factoría.

**Modificar el sistema**:
- Cambiar foco de un rol → editar su MD en `docs/business-review/roles/`.
- Añadir un 8º rol → nuevo MD + dos líneas en la matriz del workflow.
- Añadir un nuevo tipo de revisión → nueva sección en `docs/business-review/review-types.md` y referenciarla desde el rol que lo use.

Ejecución manual: `gh workflow run business-review-weekly.yml -f dry_run=true` (no crea nada, sólo imprime). `-f only_role=cfo` ejecuta sólo ese rol.

Detalles completos: [docs/business-review/README.md](docs/business-review/README.md).

---

## Keeping data architecture docs up to date

The `docs/architecture/` files and `docs/etl-sync-strategy.md` are **living documents**. Whenever you run real queries against the 4D database and learn something new, update them immediately — do not defer.

### What to update and where

| Discovery | Where to document |
|-----------|------------------|
| New delta field / PK found for a table | `docs/etl-sync-strategy.md` + relevant `docs/architecture/*.md` ETL section |
| Table is (or isn't) append-only — confirmed with data | `docs/etl-sync-strategy.md` + domain architecture file |
| Row count significantly different from what's documented | Update the Table Descriptions table in the relevant `docs/architecture/*.md` |
| New field gotcha (NULL column, wrong type, encoding issue) | `docs/skills/data-access.md` Gotchas section |
| New FK relationship or join path discovered | ER diagram in the relevant `docs/architecture/*.md` |
| Table that was empty now has data, or vice versa | Update Empty/Unused Tables section in domain architecture file |
| New SOAP method reverse-engineered | `docs/skills/data-access.md` SOAP section |

### How to update

1. Run the relevant queries to confirm the fact (use `ps sql query "..."` or direct Python).
2. Add a dated note if the finding is time-sensitive (e.g. `> Validated 2026-03-30`).
3. Update the relevant file. Keep descriptions concise — add facts, not prose.
4. If the discovery was non-obvious and cost significant investigation time, also create a GitHub issue with label `agent-efficiency` per [agent-efficiency.md](docs/skills/agent-efficiency.md).

### Do NOT leave knowledge only in conversation context

If you discover something during a session — a null field, an unexpected table name, a sync gotcha — and do not write it to docs, the next agent (or the next session) will have to rediscover it. Write it down.

---

## Knowledge file maintenance — [data-decisions.md](docs/data-decisions.md) and source MDs

**Single source of truth for the knowledge bundle**: [`docs/knowledge-sources.yml`](docs/knowledge-sources.yml). To add a new source MD, add one entry to that file — all three consumers (`extract.py`, `build-knowledge.ts`, `wren-push-metadata.py`) pick it up automatically. Do not edit the consumers directly.

**Both LLM consumers draw from the same source MDs:**
- **Dashboard runtime LLM** (`dashboard/lib/knowledge.ts`) — compiled by `npm run build:knowledge` from the `## LLM:*` marker sections.
- **WrenAI** (instructions + SQL pairs in SQLite + qdrant) — loaded by `scripts/wren-push-metadata.py` from the same `## LLM:rules` / `## LLM:sql-pairs` marker sections.

When you change anything that affects what either LLM consumer should know about the data platform, **both commands are required**:
```bash
npm run build:knowledge   # update dashboard/lib/knowledge.ts — commit the result
ps wren push              # update WrenAI's SQLite + qdrant index
```

**After changing any source MD with `## LLM:*` markers**: run `npm run build:knowledge` and commit the updated `dashboard/lib/knowledge.ts`. CI will fail if `knowledge.ts` is stale (drift guard step in the `dashboard-test` job).

The runtime LLM in the dashboard sees a compiled bundle (`dashboard/lib/knowledge.ts`) generated from a curated set of MDs (`docs/etl-sync-strategy.md`, `docs/architecture/*.md`, `docs/skills/{4d-sql-dialect,data-access}.md`, [`docs/dashboard/sql-pairs.md`](docs/dashboard/sql-pairs.md)). Markers `## LLM:tables`, `## LLM:relationships`, `## LLM:rules`, `## LLM:sql-pairs` carve the LLM-relevant sections from each file.

WrenAI reads `## LLM:rules` (JSON instruction arrays) and `## LLM:sql-pairs` (### heading + ```sql``` blocks) from the same list of source MDs. Date placeholders (`:curr_from`, `:curr_to`, `:comp_from`, `:comp_to`) in SQL pairs are automatically transformed to native PostgreSQL `CURRENT_DATE` / `DATE_TRUNC` expressions before insertion, so both consumers see syntactically valid SQL for their respective execution contexts.

Pure plumbing decisions (containers, OAuth, CI, review policy, dashboard chrome, agent factory rules) **do not** belong in `data-decisions.md` — record them as a one-liner in `DECISIONS.md` + a `docs/decisions/D-NN-<slug>.md` file.

### What goes where

| Type of change | Source MD to update |
|----------------|---------------------|
| New data semantics decision (table, field, type, join) | `docs/etl-sync-strategy.md` under `## LLM:rules` (or the relevant `docs/architecture/<domain>.md`) |
| New table relationship or ER diagram finding | `docs/architecture/<domain>.md` under `## LLM:relationships` |
| New SQL query pattern or validated example | `docs/dashboard/sql-pairs.md` under `## LLM:sql-pairs` |
| Schema / column gotcha | `docs/skills/data-access.md` under `## LLM:rules` |
| New 4D SQL syntax finding | `docs/skills/4d-sql-dialect.md` under `## LLM:rules` |
| ETL delta field, PK, sync method for a table | `docs/etl-sync-strategy.md` — follow the existing format |

### Build and drift guard

```bash
# Regenerate knowledge.ts from source MDs
npm run build:knowledge

# Verify no drift (run before committing)
git diff --exit-code dashboard/lib/knowledge.ts
```

CI runs `npm run build:knowledge` and fails if `dashboard/lib/knowledge.ts` differs from what the sources produce (drift guard in the `dashboard-test` job).
Never hand-edit `dashboard/lib/knowledge.ts` — edit the source MDs and regenerate.

### Prod knowledge sync

`ps prod deploy` / `ps prod update` push WrenAI knowledge automatically after restarting containers — no manual step needed after a deployment. For a knowledge-only refresh (source MDs changed, no deploy), use `ps prod push-knowledge`. Full procedure and options: **[docs/skills/prod-deploy.md](docs/skills/prod-deploy.md)**.

---

## AI Assistant Configuration

This project supports **Claude Code** and other AI assistants. All follow the same guideline:

- **Entry point:** AGENTS.md (this file) for skeleton, index, and meta-rules.
- **Domain detail:** [docs/skills/skills.md](docs/skills/skills.md) to choose the right skill.
- **Self-learning:** [docs/skills/agent-efficiency.md](docs/skills/agent-efficiency.md).

### Configuration files

| File | Editor | Purpose |
|------|--------|---------|
| `CLAUDE.md` | Claude Code | Imports AGENTS.md + skills |

---

## GitHub access

Use the [GitHub CLI](https://cli.github.com/) (`gh`) for all GitHub operations.

---

## AI Factory lifecycle

The full lifecycle of an issue (planner → sub-issues → implementer → PR → Copilot → Opus → human merge), the labels that signal each state, the recovery paths for failures, and **every point where a human is expected to step in** are documented in **[docs/ai-factory.md § Lifecycle in detail](docs/ai-factory.md#lifecycle-in-detail)**.

Read it before:
- modifying any workflow under `.github/workflows/ai-*.yml` — the state machine is enforced across multiple files (`ai-worker.yml`, `ai-pr-review.yml`, `ai-address-feedback.yml`, `ai-watchdog.yml`) and changes in one need to be reasoned about against the others.
- adding a new label that participates in the AI lifecycle.
- changing the review policy (caps, rounds, who-requests-whom). See also [D-021](docs/decisions/D-021-two-review-rounds.md).
- diagnosing a stalled / duplicated / mis-labelled issue or PR.

The diagrams in that section reflect the post-#517/#518/#519 behaviour: implementers read parent comments, planner self-heals missing `ai-work` labels, job-level concurrency cancels duplicates, and the worker's `Handle success` is idempotent against re-fires (no duplicate Copilot reviews).

---

## Issue and PR format

All GitHub issues in this project follow a single standard format. Full template + examples + label conventions + phasing rules: **[docs/issue-format.md](docs/issue-format.md)**.

**Short summary** (the rules that bind everyone):
- Every PR gets **exactly two review rounds**, each once: Copilot first, then Opus from a clean context. No third round; escalate to the human owner if blocked. See [D-021](docs/decisions/D-021-two-review-rounds.md).
- Each issue uses the standard template (Context / Plan / Phase N / Additional Context). Phases live as `## Phase N — <name>` headings in the issue body — not as labels.
- **Default**: one phase = one PR. The planner adds `## Plan` and `## Phase 1` headings when refining the issue body. Split into multiple phases only when: >2000 LOC, producer/consumer dependency, or same-file DDL conflict.
- **`ai-plan` label**: triggers the planner only — refines the issue body in place, sets `fact-planned`, stops. No implementation. Owner reviews the refined body and adds `ai-work` when ready.
- **`ai-work` label**: implementer walks the next un-merged phase's `### Tasks` checklist sequentially, ticks checkboxes, opens one PR per phase. If the body is unstructured and `fact-planned` is absent, the planner runs inline first.
- **`ai-decompose` label**: opt-in escape hatch for the legacy parent → sub-issues model. Reserve for genuinely huge work where parallel execution across multiple people matters.
- **`fact-*` labels** (grey `#ededed`): internal state markers toggled by workflows. The owner does not act on these. See [docs/issue-format.md § Label conventions](docs/issue-format.md#label-conventions) for the full list. See [D-034](docs/decisions/D-034-single-track-issues.md) for the rationale.
