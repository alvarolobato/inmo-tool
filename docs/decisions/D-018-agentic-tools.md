---
id: D-018
title: Native tool-calling (agentic) for Dashboard LLM flows
date: 2026-04-22
---

# D-018: Native tool-calling (agentic) for Dashboard LLM flows

*Decided: 2026-04-22*

**Context**: Issue #384 — `generate`, `modify`, and `analyze` were single-shot: the model could not iterate with read-only SQL or saved-dashboard context before answering.
**Decision**:
- Use OpenRouter `chat.completions` with `tools` + `tool_choice: auto` and a **backend-controlled loop** (`dashboard/lib/llm-tools/runner.ts`).
- **Mandatory** for the three flows when `DASHBOARD_AGENTIC_TOOLS_ENABLED` is true (default); when `false`, keep the prior single-shot path (operational kill switch).
- **No silent fallback** if the agentic runner throws (limits, empty final message) — APIs return `AGENTIC_RUNNER` with structured details.
- **Catalog (MVP)**: `validate_query`, `execute_query`, `explain_query`, `list_ps_tables`, `describe_ps_table`, `list_dashboards`, `get_dashboard_spec`, `get_dashboard_queries`, `get_dashboard_widget_raw_values`, `get_dashboard_all_widget_status`.
- **Limits** (env-tunable, defaults per issue): 4 tool rounds, 12 tool calls/request, 15s timeout per tool, execute capped at 200×30 cells, 20k chars per tool JSON payload to the model.
- **Telemetry**: every tool invocation inserts into PostgreSQL `llm_tool_calls`; admin GET `/api/admin/tool-calls` returns 30-day aggregates.
**Alternatives rejected**: Single-shot with RAG-only context (cannot validate live SQL); client-side tool execution (security/compliance).
**Rationale**: Read-only policy stays centralized in `db.ts` / `query-validator` / `sql-heuristics`; the model can self-correct before emitting final JSON or markdown.
**See**: [dashboard-agentic-tools.md](../dashboard-agentic-tools.md), `dashboard/lib/llm-tools/*`, `etl/schema/init.sql` (`llm_tool_calls`).
