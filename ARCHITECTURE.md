# ARCHITECTURE.md — inmo-tool

> This document describes the system architecture, component relationships, and data flow. It is the single source of truth for architectural decisions. **Keep this file up to date** — agents and developers should read this before starting any work.
>
> **Status**: skeleton only. This repo is mid-Phase-1 (see [issue #1](https://github.com/alvarolobato/inmo-tool/issues/1)'s `## Implementation` section for the phase/task issue tree) — sections marked **TODO** get filled in as the task that owns them lands, not speculatively ahead of time.

## System Overview

inmo-tool crawls real-estate listing sites, mirrors normalized/deduplicated listings into PostgreSQL, and provides one AI-driven interface for an investor to review ranked candidates across several independent search profiles.

**Flow at a glance:** Listing sites (per-site connectors, scheduled) → Postgres mirror (`property`/`listing`/... — schema defined in task 1.2, #10) → Dedup engine (task 2.2, #16) → per-profile scoring (Phase 3) → Dashboard App (Next.js + Tremor, reused shell from the source project) with an LLM chat layer (Phase 4) for conversational search/analysis.

Full data model and ER diagram: see [docs/architecture/data-model.md](docs/architecture/data-model.md) (task 1.2, #10) — every table's purpose, the entity-relationship overview, and the `property_id`-vs-`listing_id` keying rationale that makes deduplication actually work.

## Components

### 1. Connector/sync service (`etl/`)

- **Language**: Python 3.12 (inherited toolchain)
- **Status**: domain-specific PowerShop sync modules removed (task 1.1, #9); connector framework is task 1.3 (#11); first real connector is task 1.4 (#12)
- **Target**: PostgreSQL, schema per task 1.2 (#10)

### 2. PostgreSQL

- **Bind mount**: `./data/postgres/` (see [D-001](docs/decisions/D-001-bind-mounts.md))
- **Schema**: `property`, `listing`, `listing_price_history`, `listing_status_event`, `owner_identity` (+ join table), `search_profile`, `profile_listing_state`, `feedback_event`, `ai_assessment`, `property_merge_log` — see [docs/architecture/data-model.md](docs/architecture/data-model.md) and [D-005](docs/decisions/D-005-numeric-vs-uuid-keys.md) (task 1.2, #10). Pre-existing dashboard/LLM/ETL-observability infrastructure tables (`dashboards`, `conversations`, `llm_*`, `etl_sync_runs`, etc.) are inherited as-is — later phases reuse them.

### 3. Dashboard App (`dashboard/`)

- **Language**: TypeScript (Next.js App Router)
- **UI Framework**: Tremor + Tailwind CSS (reused shell)
- **Port**: 4000 (configurable via `DASHBOARD_PORT`)
- **LLM**: OpenRouter (default) or local Claude Code CLI, selectable via `DASHBOARD_LLM_PROVIDER` — mechanism kept from the source project (see [D-019 archive](docs/decisions/archive/D-019-pluggable-llm-providers.md))
- **Current content**: the old BI-dashboard-generation UI/flows, untouched by task 1.1 by design (out of scope — see AGENTS.md). Phase 2 tasks (candidate list #19, map #43, property detail page #44) replace the UI content; Phase 4 (#24) replaces the LLM flow catalog.

#### LLM call architecture — llm-context module

Reused as-is — see [docs/skills/llm-context.md](docs/skills/llm-context.md) for the full reference (module layout, `assembleRequest` boundary, CI enforcement, testing pattern) and its status note on what's inherited vs. pending rewrite.

## Data Flow

### Connector sync (scheduled)
```
Listing sites → per-site connector (discover → fetch_detail → normalize) → Postgres
```
Details: task 1.3 (#11, framework), task 1.4/2.1 (#12/#15, connectors).

### Dedup
```
New/changed listings → dedup engine (address+coords+size → phone → photo hash → fuzzy) → property_merge_log
```
Details: task 2.2 (#16). Cadastral-reference matching was considered and dropped — see #42 (closed) for why.

### Scoring & candidate feed
```
Property × Search Profile → hard filters → learned scoring model → profile_listing_state → Dashboard candidate feed
```
Details: Phase 2 (filters, #17/#18), Phase 3 (scoring/feedback, #4).

### AI-assisted assessment (Phase 4)
```
Listing description/photos → occupancy/condition/red-flag flows → ai_assessment (cached, versioned)
```
Details: task 4.1–4.7 (#24–#30).

## Configuration

### Single credential file
`~/.config/inmo-tool/.env` — see AGENTS.md § Configuration for precedence and current variable list.

## Data Persistence

| Data | Location | Survives restart | Survives `down -v` |
|------|----------|:----------------:|:-------------------:|
| PostgreSQL data | `./data/postgres/` | Yes | Yes (bind mount) |

Grows as Phase 1.6 (#14) finalizes the compose file and later phases add services.

## Production

No production deployment exists for this project yet. The source project's prod tooling (`cli/commands/prod.sh`, `docs/deployment/`, `deploy/`) was removed in task 1.1 rather than kept unused — a fresh deployment setup gets written when there's an actual target, following the source project's pattern (flat Docker Hub deployment, `ps prod *` CLI) only if that pattern still makes sense at the time.

## Technology Decisions

See [DECISIONS.md](DECISIONS.md) for the binding rules; full rationale for each decision lives in `docs/decisions/D-NN-<slug>.md`. `docs/decisions/archive/` holds the source project's history for context.
