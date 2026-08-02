# ARCHITECTURE.md — inmo-tool

> This document describes the system architecture, component relationships, and data flow. It is the single source of truth for architectural decisions. **Keep this file up to date** — agents and developers should read this before starting any work.
>
> **Status**: Phase 1 ("Foundation," [issue #2](https://github.com/alvarolobato/inmo-tool/issues/2)) is complete and verified end-to-end against a live stack: schema, connector framework, a real connector (Fotocasa), ops CLI, and a working Docker Compose stack. Phase 2 onward (dedup, scoring, AI assessment, the dashboard UI rewrite) is not yet built — see [issue #1](https://github.com/alvarolobato/inmo-tool/issues/1)'s `## Implementation` section for the full phase/task issue tree and current status of each.

## System Overview

inmo-tool crawls real-estate listing sites, mirrors normalized/deduplicated listings into PostgreSQL, and provides one AI-driven interface for an investor to review ranked candidates across several independent search profiles.

**Flow at a glance:** Listing sites (per-site connectors, scheduled hourly + on every startup) → Postgres mirror (`property`/`listing`/... — [docs/architecture/data-model.md](docs/architecture/data-model.md)) → Dedup engine (not yet built — Phase 2, #16) → per-profile scoring (not yet built — Phase 3) → Dashboard App (Next.js + Tremor, reused shell from the source project, UI content not yet rewritten for this domain) with an LLM chat layer (not yet built — Phase 4) for conversational search/analysis.

Full data model and ER diagram: see [docs/architecture/data-model.md](docs/architecture/data-model.md) — every table's purpose, the entity-relationship overview, and the `property_id`-vs-`listing_id` keying rationale that makes deduplication actually work once Phase 2 builds it.

## Components

### 1. Connector/sync service (`etl/`)

- **Language**: Python 3.12 (inherited toolchain)
- **Status**: built and verified live. `etl/connectors/base.py` defines the `Connector` contract (`discover`/`fetch_detail`/`normalize`); `etl/orchestrator.py` runs registered connectors (rate limiting, a rolling-window circuit breaker, withdrawal detection gated by `Connector.discovers_full_inventory`) and records observability (`connector_runs`/`connector_run_results`). Fotocasa (`etl/connectors/fotocasa.py`) is the first real connector — see [docs/skills/connectors.md](docs/skills/connectors.md) for the feasibility-spike/JSON-scraping/field-mapping findings from building it, and [docs/architecture/connectors.md](docs/architecture/connectors.md) for the framework's own design rationale.
- **Ops**: `ps connector list|run [name]|status|logs`, `ps db tables|describe|query` (allowlist-validated, not just a transaction-level restriction — see `cli/lib/sql_guard.py`), `ps dedup run` (stub pending Phase 2, #16). See [docs/skills/cli.md](docs/skills/cli.md).
- **Target**: PostgreSQL, schema in `etl/schema/init.sql`

### 2. PostgreSQL

- **Bind mount**: `./data/postgres/` (see [D-001](docs/decisions/D-001-bind-mounts.md))
- **Schema**: `property`, `listing`, `listing_price_history`, `listing_status_event`, `owner_identity` (+ join table, with a working retention/purge function), `search_profile`, `profile_listing_state`, `feedback_event`, `ai_assessment`, `property_merge_log` — see [docs/architecture/data-model.md](docs/architecture/data-model.md) and [D-005](docs/decisions/D-005-numeric-vs-uuid-keys.md). `property_id`-keyed (not `listing_id`) throughout, so a future dedup merge doesn't fragment a property's score/feedback across its duplicate listings. Pre-existing dashboard/LLM/ETL-observability infrastructure tables (`dashboards`, `conversations`, `llm_*`, `etl_sync_runs`, etc.) are inherited as-is; most of `etl/db/postgres.py`'s generic DML helpers (`bulk_upsert`, `truncate_and_insert`, watermark/manual-trigger helpers) that operated on that old shape are currently unused by the new connector pipeline — kept for now, not yet a deliberate keep-or-delete call.

### 3. Dashboard App (`dashboard/`)

- **Language**: TypeScript (Next.js App Router)
- **UI Framework**: Tremor + Tailwind CSS (reused shell)
- **Port**: 4000 (configurable via `DASHBOARD_PORT`)
- **LLM**: OpenRouter (default) or local Claude Code CLI, selectable via `DASHBOARD_LLM_PROVIDER` — mechanism kept from the source project (see [D-019 archive](docs/decisions/archive/D-019-pluggable-llm-providers.md))
- **Current content**: still the old BI-dashboard-generation UI/flows and branding (page title, nav links) from the source project, deliberately untouched by Phase 1 (out of scope — see AGENTS.md). This means the dashboard as it stands today is not yet a usable inmo-tool UI — it's inherited scaffolding waiting on Phase 2 (candidate list #19, map #43, property detail page #44) to replace the UI content and Phase 4 (#24) to replace the LLM flow catalog. Its "force ETL resync" button (`/api/etl/run` → `etl_manual_trigger` table) is currently a dead end — nothing in the new connector orchestrator polls that table — do not rely on it; use `ps connector run` instead.

#### LLM call architecture — llm-context module

Reused as-is — see [docs/skills/llm-context.md](docs/skills/llm-context.md) for the full reference (module layout, `assembleRequest` boundary, CI enforcement, testing pattern) and its status note on what's inherited vs. pending rewrite.

## Data Flow

### Connector sync — built, verified live (Phase 1)
```
Listing sites → per-site connector (discover → fetch_detail → normalize) → Postgres
```
Runs on `etl/orchestrator.py run_scheduler_loop`: every registered connector, immediately on container startup, then hourly. Verified live: Fotocasa discovers listings and persists real Madrid properties end-to-end. Only Fotocasa is registered today (`etl/connectors/__init__.py`); it does not claim full-inventory coverage (`discovers_full_inventory = False`, page 1 of search results only — see [docs/architecture/connectors.md](docs/architecture/connectors.md)), so its listings never auto-transition to `withdrawn` from absence alone yet. Task 2.1 (#15) adds a second connector.

### Dedup — not yet built (Phase 2, #16)
```
New/changed listings → dedup engine (address+coords+size → phone → photo hash → fuzzy) → property_merge_log
```
Cadastral-reference matching was considered and dropped before implementation — see #42 (closed) for why.

### Scoring & candidate feed — not yet built (Phase 2 filters #17/#18, Phase 3 scoring/feedback #4)
```
Property × Search Profile → hard filters → learned scoring model → profile_listing_state → Dashboard candidate feed
```

### AI-assisted assessment — not yet built (Phase 4, #24–#30)
```
Listing description/photos → occupancy/condition/red-flag flows → ai_assessment (cached, versioned)
```

## Configuration

### Single credential file
`~/.config/inmo-tool/.env` — see AGENTS.md § Configuration for precedence and current variable list.

## Data Persistence

| Data | Location | Survives restart | Survives `down -v` |
|------|----------|:----------------:|:-------------------:|
| PostgreSQL data | `./data/postgres/` | Yes | Yes (bind mount) |

The full local stack is `postgres` + `otel-collector` + `etl` + `dashboard` (`docker-compose.yml`) — verified live to all come up healthy together. Grows as later phases add services (e.g. a notification worker in Phase 5).

## Production

No production deployment exists for this project yet. The source project's prod tooling (`cli/commands/prod.sh`, `docs/deployment/`, `deploy/`) was removed in task 1.1 rather than kept unused — a fresh deployment setup gets written when there's an actual target, following the source project's pattern (flat Docker Hub deployment, `ps prod *` CLI) only if that pattern still makes sense at the time.

## Technology Decisions

See [DECISIONS.md](DECISIONS.md) for the binding rules; full rationale for each decision lives in `docs/decisions/D-NN-<slug>.md`. `docs/decisions/archive/` holds the source project's history for context.
