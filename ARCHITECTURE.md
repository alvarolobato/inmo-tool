# ARCHITECTURE.md — PowerShop Analytics Platform

> This document describes the system architecture, component relationships, and data flow. It is the single source of truth for architectural decisions. **Keep this file up to date** — agents and developers should read this before starting any work.

## System Overview

PowerShop Analytics is a platform that extracts data from a vendor-managed PowerShop ERP (4D database), mirrors it into PostgreSQL, and provides two analytics interfaces:

1. **WrenAI** — Ad-hoc single-question text-to-SQL (e.g., "¿Cuánto vendimos ayer?")
2. **Dashboard App** — AI-generated multi-widget dashboards from natural language (e.g., "Créame un cuadro de mandos para el responsable de ventas")

**Flow at a glance:** 4D Server (SQL `:19812` / SOAP `:8080`) → ETL (Python, nightly) → PostgreSQL mirror (`ps_*` tables, 18M+ rows) → consumed by both the WrenAI stack (wren-ui `:3000`, wren-ai-service `:5555`, wren-engine, ibis-server, qdrant) and the Dashboard App (Next.js + Tremor on `:4000`). WrenAI always calls OpenRouter (Claude Sonnet 4 + text-embedding-3-large via litellm). The Dashboard App is configurable via `DASHBOARD_LLM_PROVIDER` between OpenRouter (default) and a local Claude Code CLI — see [D-019](docs/decisions/D-019-pluggable-llm-providers.md).

Full ASCII diagram in [docs/architecture/overview.md](docs/architecture/overview.md).

## Components

### 1. ETL Service (`etl/`)
- **Language**: Python 3.12
- **Schedule**: Nightly at 02:00 (configurable via `ETL_CRON_HOUR`)
- **Source**: 4D database via p4d driver (SQL port 19812)
- **Target**: PostgreSQL `ps_*` tables
- **Strategy**: Upsert delta for large tables (Ventas, LineasVentas), full refresh for small tables (Articulos, Clientes)
- **Key file**: `etl/main.py` (orchestrator), `etl/sync/*.py` (per-domain modules)

### 2. PostgreSQL (`postgres` container)
- **Data volume**: 18M+ rows across 26 `ps_*` tables
- **Key tables**: `ps_ventas` (911K), `ps_lineas_ventas` (1.7M), `ps_stock_tienda` (12.3M), `ps_gc_lin_albarane` (1M)
- **Indexes**: FK indexes, date indexes, store indexes (see `etl/schema/init.sql`)
- **Dashboard tables**: `dashboards`, `dashboard_versions` (for the Dashboard App)
- **Bind mount**: `./data/postgres/`

### 3. WrenAI Stack (5 containers)
- **Purpose**: Ad-hoc single-question text-to-SQL
- **UI**: http://localhost:3000
- **Semantic layer**: 26 models, 19 relationships, 107 column descriptions
- **Knowledge**: 40+ instructions, 52+ SQL pairs (managed via `scripts/wren-push-metadata.py`)
- **LLM**: Claude Sonnet 4 via OpenRouter
- **Embeddings**: text-embedding-3-large via OpenRouter

### 4. Dashboard App (`dashboard/`) — NEW
- **Purpose**: AI-generated multi-widget dashboards from natural language
- **Language**: TypeScript (Next.js 14+ App Router)
- **UI Framework**: Tremor (React dashboard components) + Tailwind CSS
- **Port**: 4000 (configurable)
- **LLM**: OpenRouter API (default) **or** local Claude Code CLI — selectable via `DASHBOARD_LLM_PROVIDER` (D-019); OpenRouter reuses `OPENROUTER_API_KEY` like WrenAI

#### Dashboard App Architecture

**Flow:** Browser (Dashboard view + Chat sidebar) → Next.js API routes → `dashboard/lib/llm-context/` (central LLM assembly + execution module) → `llmComplete` / `runAgenticChat` → OpenRouter or Claude Code CLI.

The agentic flows (`generate`, `modify`, `analyze`) call the LLM with read-only SQL tools and return a JSON spec; the frontend renders it via Tremor. Saved specs persist in `dashboards` / `dashboard_versions` tables. Full route map + ASCII diagram in [docs/architecture/overview.md](docs/architecture/overview.md).

#### LLM call architecture — llm-context module

All LLM calls in the dashboard go through a single entry point (see [D-036](docs/decisions/D-036-llm-context-centralization.md)):

```
┌─────────────────────────────────────────────────────────────────┐
│         dashboard/lib/llm-context/  (central LLM module)         │
│                                                                   │
│  assembleRequest(flow, vars, conversationId, userMessage, opts)  │
│    → buildSystemPrompt(flow, vars)   { stable, volatile? }       │
│    → buildHistory(conversationId)    prior messages              │
│    → toolsForFlow(flow)              per-flow tool catalog       │
│    → llmComplete / runAgenticChat    (only imports here)         │
│    → AssembleResult { text, usage, model }                       │
└─────────────────────────────────────────────────────────────────┘
```

CI enforces the boundary via `dashboard/scripts/check-llm-context.sh` — no file outside `llm-context/` may import `llmComplete` or `runAgenticChat` directly. The skill reference is at [docs/skills/llm-context.md](docs/skills/llm-context.md).

#### Dashboard JSON spec

The LLM emits a JSON spec with `title`, `description`, and a `widgets` array. Each widget has a `type` (see catalog below), per-widget SQL, and rendering hints (format, prefix, axes, etc.). Full example in [docs/architecture/overview.md](docs/architecture/overview.md).

#### Widget catalog

`kpi_row`, `bar_chart`, `line_chart`, `area_chart`, `donut_chart`, `table`, `number`, `insights_strip`, `ranked_bars`. Tremor-component mapping and shell components (`TopBar`, `TweaksPanel`, `AnalyzeLauncher`, `LogBlock`, `Panel`, `InsightsStrip`, `RankedBarsWidget`, `Sparkline`) documented in [docs/architecture/overview.md](docs/architecture/overview.md). Token-driven theming per [D-022](docs/decisions/D-022-dashboard-redesign.md).

## Data Flow

### ETL Flow (nightly)
```
4D Server → p4d driver → Python ETL → PostgreSQL ps_* tables
```

### WrenAI Flow (ad-hoc questions)
```
User question → WrenAI UI → AI Service (RAG + LLM) → SQL → ibis-server → PostgreSQL → result
```

### Dashboard App Flow (dashboard generation)
```
User prompt (Spanish)
  → Next.js API route
  → Dashboard LLM backend (OpenRouter chat.completions, or CLI driver with JSON tool-step protocol)
  → Same knowledge context + optional agentic tools: validate/explain/execute SQL, list/describe ps_* tables, inspect saved dashboards
  → Dashboard JSON spec (widgets + SQL queries)
  → Frontend renders spec with Tremor components
  → Each widget's SQL executed against PostgreSQL
  → Data rendered in charts/tables
```

When `DASHBOARD_AGENTIC_TOOLS_ENABLED=true` (default), `generate`, `modify`, and `analyze` use a bounded tool loop (`dashboard/lib/llm-tools/runner.ts`) instead of a single completion. Tool calls are logged to PostgreSQL `llm_tool_calls` (with `llm_provider` / `llm_driver`). See [docs/dashboard-agentic-tools.md](docs/dashboard-agentic-tools.md).

**Tool catalogs** (`dashboard/lib/llm-tools/catalog.ts`):

| Export | Tools | Used by |
|--------|-------|---------|
| `FREE_CHAT_TOOLS` | 10 inspection tools + `start_dashboard_generation` (11 total) | Free conversations (`mode='chat'`) — planned (issue #616) |
| `FULL_DASHBOARD_TOOLS` | All registered tools including write tools | Future expansion |

The runner (`dashboard/lib/llm-tools/runner.ts`) accepts a `tools?: ChatCompletionTool[]` param. When omitted, it defaults to `DASHBOARD_AGENTIC_TOOLS` (the full catalog). Free-chat will pass `FREE_CHAT_TOOLS` explicitly to restrict write tool access (planned — issue #616). There are no separate `GENERATE_TOOLS`/`MODIFY_TOOLS`/`ANALYZE_TOOLS` named exports; those flows use the runner default.

**Conversations DB table** (`conversations`): stores `context_kind` (`'global'` / `'dashboard'` / `'home'` / `'admin'`) and `context_ref` (dashboard numeric ID when applicable). Planned (issue #616): `listConversations()` will LEFT JOIN `dashboards` to resolve `context_dashboard_name` for the UI; the handoff endpoint (`POST /api/conversations/:id/handoff-to-dashboard`) will mutate `mode`, `context_kind`, `context_ref`, and `context_url` — messages and `initial_context` remain immutable as an audit trail. See [D-032](docs/decisions/D-032-free-chat-tools.md).

### Dashboard Modification Flow
```
User: "Añade el margen por familia"
  → Current dashboard spec + user prompt → LLM
  → Updated spec (original widgets + new margin widget)
  → Frontend re-renders
```

## Configuration

### Single credential file
`~/.config/powershop-analytics/.env` — loaded by all components:
- ETL: via python-dotenv
- docker-compose: via `.env` symlink
- CLI: via `load-env.sh`
- Dashboard App: via Next.js env loading

### Key environment variables

| Variable | Component | Purpose |
|----------|-----------|---------|
| `P4D_HOST/PORT/USER/PASSWORD` | ETL | 4D SQL connection |
| `POSTGRES_USER/PASSWORD/DB` | All | PostgreSQL connection |
| `OPENROUTER_API_KEY` | WrenAI + Dashboard (openrouter) | LLM + Embeddings |
| `WREN_LLM_MODEL` | WrenAI | LLM model for WrenAI |
| `DASHBOARD_LLM_PROVIDER` | Dashboard App | `openrouter` (default) or `cli` |
| `DASHBOARD_LLM_MODEL_OPENROUTER` / `DASHBOARD_LLM_MODEL_CLI` | Dashboard App | Per-backend model; legacy `DASHBOARD_LLM_MODEL` fills both when set |
| `DASHBOARD_LLM_CLI_*` | Dashboard App | CLI binary, driver, timeout, capture cap — see `.env.example` |
| `DASHBOARD_AGENTIC_*` | Dashboard App | Tool-calling limits and kill switch — see [docs/dashboard-agentic-tools.md](docs/dashboard-agentic-tools.md) |
| `DASHBOARD_PORT` | Dashboard App | HTTP port (default: 4000) |
| `DASHBOARD_CONTEXT_DIR` | Dashboard App | Dir for per-turn context-log files (default `/app/data/conversations`; bind-mounted) — see [D-039](docs/decisions/D-039-context-log-files.md) |

## Data Persistence

| Data | Location | Survives restart | Survives `down -v` |
|------|----------|:----------------:|:-------------------:|
| PostgreSQL data | `./data/postgres/` | Yes | Yes (bind mount) |
| Qdrant vectors | `./data/qdrant/` | Yes | Yes (bind mount) |
| WrenAI config/SQLite | `./data/wren/` | Yes | Yes (bind mount) |
| Dashboard data | PostgreSQL tables | Yes | Yes (in PG bind mount) |
| Conversation context logs | `./data/dashboard/conversations/` | Yes | Yes (bind mount) |

Per-turn context logs (the exact payload sent to the LLM) live in files on the
dashboard's data volume — one folder per conversation, one file per turn. Postgres
stores only the pointer (`conversation_turns.context_file`); the UI lazy-loads the
file when "Contexto original" is expanded. See [D-039](docs/decisions/D-039-context-log-files.md).

## Production

Production runs the same Docker Compose stack on a dedicated Mac. It is a **flat Docker Hub deployment** — no git checkout on the prod machine. The directory (`~/powershop/` by default) contains only `docker-compose.yml`, `.env`, `wren-config.yaml`, `.version`, and `./data/` bind mounts. ETL and Dashboard images are pulled pre-built from Docker Hub (`alobato/powershop-etl`, `alobato/powershop-dashboard`). WrenAI images come from `ghcr.io/canner/*`.

`PROD_HOST` and `PROD_PATH` in `~/.config/powershop-analytics/.env` are **local-operator** config — they tell the `ps prod *` CLI on your local Mac where to SSH. The prod Mac itself doesn't need these variables.

The launchd agent (`scripts/launchd/com.powershop.claude-token-sync.plist.template`) mirrors the macOS Keychain entry `Claude Code-credentials` into `~/.claude/.credentials.json` every 5 minutes so the dashboard container can read it without any manual intervention. See [D-025](docs/decisions/D-025-oauth-single-refresher.md) for the single-refresher constraint.

**Agent workflow skills:**
- [docs/skills/release.md](docs/skills/release.md) — cut a release (major/minor/patch) and build the Docker images
- [docs/skills/prod-deploy.md](docs/skills/prod-deploy.md) — push a release onto the production Mac

**Full install + operations documentation:**
- [docs/deployment/production.md](docs/deployment/production.md) — cold-start install, prerequisites, backup, disaster recovery, upgrades, monitoring
- [docs/deployment/prod-cli.md](docs/deployment/prod-cli.md) — `ps prod *` CLI reference (all 12 subcommands)

## Technology Decisions

See [DECISIONS.md](DECISIONS.md) for the binding rules; full rationale for each decision lives in `docs/decisions/D-NN-<slug>.md`.
