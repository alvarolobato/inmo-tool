# Dashboard App — Agentic LLM tools

This document describes the **native tool-calling** path for the Dashboard App LLM. Decision record: [decisions/archive/D-018-agentic-tools.md](decisions/archive/D-018-agentic-tools.md) (archived — see [D-004](decisions/D-004-no-worker-workflows.md) and DECISIONS.md for this repo's active decisions).

> **Status (updated by #24)**: the tool-loop runner/provider mechanism
> (`dashboard/lib/llm-tools/runner.ts`, OpenRouter/CLI dual-driver support, the
> feature flag, the failure policy) is real reusable architecture kept as-is per
> issue #1 §14 — that part of this document is current.
>
> The flows it serves are **not** the old `generate`/`modify`/`analyze` set:
> #24 replaced the catalog with `occupancy`/`condition`/`redflags`/`extract`/
> `compare` (single-shot, no tools) plus `chat` (the only flow that takes the
> tool loop). Tool *selection* is `toolsForFlow()` in
> `dashboard/lib/llm-context/tools.ts`; an empty array is what routes a flow to
> the single-shot path.
>
> The inspection tools were renamed off the `ps_*` mirror convention
> (`list_ps_tables` → `list_tables`, `describe_ps_table` → `describe_table`) and
> are now restricted to an explicit domain allowlist — see `LLM_VISIBLE_TABLES`
> in `dashboard/lib/llm-tools/handlers/sql.ts`. The dashboard write-back tools
> (`apply_dashboard_modification`, `submit_dashboard_analysis`) and their
> `ctx.modifyResult`/`ctx.analyzeResult` side-channel were removed with the
> dashboard-builder feature (#101, #24).

## Overview

- **Runtime**: `dashboard/lib/llm-tools/runner.ts` — provider-agnostic loop: appends `tool` messages, repeats until the assistant returns plain text or a limit is hit.
- **OpenRouter (`DASHBOARD_LLM_PROVIDER=openrouter`, default)**: native `chat.completions` with `tools` + `tool_choice: auto` via `dashboard/lib/llm-provider/openrouter.ts`.
- **CLI (`DASHBOARD_LLM_PROVIDER=cli`)**: each round invokes the configured driver (today: **Claude Code** `claude -p`) with the full transcript; the model must answer with **one JSON object** only: `{"kind":"final","content":"..."}` or `{"kind":"tools","calls":[{"name":"...","arguments":"..."}]}`. The server maps that to the same tool dispatch path as OpenRouter.
- **Feature flag**: `DASHBOARD_AGENTIC_TOOLS_ENABLED` — default **true**. Set to `false` to force the legacy **single-shot** completion (no tools).
- **Failure policy**: If the runner throws (limits, empty final content), API routes return HTTP **500** with `code: AGENTIC_RUNNER` — **no silent fallback** to single-shot.

## Tool catalog

Available to the `chat` flow only (`CHAT_TOOLS`); assessment flows get none.

| Tool | Purpose |
|------|---------|
| `validate_query` | Read-only check + optional cost (EXPLAIN) + SQL lint hints |
| `execute_query` | Run SELECT/WITH; rows/columns truncated |
| `explain_query` | `EXPLAIN (FORMAT JSON)` without ANALYZE |
| `list_tables` | List the domain tables in `LLM_VISIBLE_TABLES` |
| `describe_table` | Column metadata for one allowlisted table |

## Limits (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DASHBOARD_AGENTIC_MAX_TOOL_ROUNDS` | 4 | Max assistant turns (each may include tool calls) |
| `DASHBOARD_AGENTIC_MAX_TOOL_CALLS` | 12 | Max tool invocations per HTTP request |
| `DASHBOARD_AGENTIC_TOOL_TIMEOUT_MS` | 15000 | Wall-clock timeout per tool handler |
| `DASHBOARD_AGENTIC_MAX_ROWS` | 200 | Row cap for `execute_query` / widget raw tool |
| `DASHBOARD_AGENTIC_MAX_COLUMNS` | 30 | Column cap |
| `DASHBOARD_AGENTIC_MAX_RESULT_CHARS` | 20000 | Max JSON characters returned to the model per tool |

## Security and SQL policy

- All SQL paths use `validateReadOnly` from `dashboard/lib/db.ts` (same read-only policy as `/api/query`).
- Cost checks use `validateQueryCost` from `dashboard/lib/query-validator.ts`.
- Static lint uses `lintDashboardSpec` / `lintWidgetSql` from `dashboard/lib/sql-heuristics.ts` where applicable.
- Tool error payloads use `{ ok: false, code, message, requestId }` — avoid leaking internal stack traces.

## Telemetry

- Table: `llm_tool_calls` (see `etl/schema/init.sql`).
- Fields include `tool_name`, `endpoint`, `request_id`, `status`, `latency_ms`, payload sizes, optional `error_code`, plus **`llm_provider`** and **`llm_driver`** (e.g. `cli` / `claude_code`).
- **Admin API**: `GET /api/admin/tool-calls` (same auth as other admin routes) returns rolling **30-day** aggregates by endpoint, tool, and status.

## Analyze flow and `dashboardId`

- Analyze turns run through `POST /api/conversations/:id/turns`; the conversation's `context_ref` carries the dashboard id (`ChatSidebar` + `app/dashboard/[id]/page.tsx`).
- The system prompt includes the id so the model can call dashboard-scoped tools consistently.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| 500 `AGENTIC_RUNNER` / `AGENTIC_MAX_ROUNDS` | Model stuck in tool rounds — simplify prompt or raise `DASHBOARD_AGENTIC_MAX_TOOL_ROUNDS` (ops only). |
| 500 `AGENTIC_MAX_TOOL_CALLS` | Too many parallel tools — reduce prompt complexity. |
| Tool JSON truncated in logs | Normal if result hit `DASHBOARD_AGENTIC_MAX_RESULT_CHARS`. |
| `llm_tool_calls` insert errors | Ensure migrations applied (`init.sql` / fresh PG). |

## Code map

```
dashboard/lib/llm-tools/
  runner.ts          # Agentic loop
  catalog.ts         # OpenAI tool definitions
  config.ts          # Env limits + feature flag
  logging.ts         # DB insert + admin aggregates query
  tool-payload.ts    # JSON envelope + truncation
  dashboard-query-extractor.ts
  handlers/sql.ts
  handlers/dashboards.ts
```
